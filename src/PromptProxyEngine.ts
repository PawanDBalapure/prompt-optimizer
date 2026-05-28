import { encode } from 'gpt-tokenizer';
import { SemanticCacheManager, CacheQueryResult } from './SemanticCacheManager.js';
import {
  IdeContextFile,
  IdeContextLog,
  ProcessPromptResponse,
  PromptCacheCandidate,
  PromptOptimizationAnalysis,
  ProcessingMode,
  PromptIDEContext,
  PromptOptimizationRequest,
  PromptOptimizationResponse,
  PromptPricingConfig,
  PromptProxyEngineOptions,
} from './contracts.js';
import { LocalSemanticVectorizer } from './localSemanticVectorizer.js';
import { parseToPromptIR, lintPrompt, compilePromptIR, explainRewrite } from './PromptIRHelper.js';
import { inferRepoStack } from './RepoAwareness.js';

const DEFAULT_INPUT_COST_PER_1K = 0.0015;
const DEFAULT_OUTPUT_COST_PER_1K = 0.002;
const CACHE_TIMEOUT_MS = 150;
const MAX_CONTEXT_FILES = 3;
const MAX_CONTEXT_LOGS = 2;
const MAX_FILE_LINES = 80;
const MAX_LOG_LINES = 24;
const MAX_IMPROVEMENTS = 2;
const MAX_CACHE_CANDIDATES = 3;

interface ResolvedPromptPricingConfig {
  input_cost_per_1k_tokens: number;
  output_cost_per_1k_tokens: number;
}

interface TextSegment {
  content: string;
  is_code: boolean;
}

interface RelevantContextPack {
  files: IdeContextFile[];
  logs: IdeContextLog[];
  sections: string[];
  insight: PromptOptimizationAnalysis['context'];
}

export class PromptProxyEngine {
  private readonly cacheManager: SemanticCacheManager;
  private readonly vectorizer = new LocalSemanticVectorizer();
  private readonly defaultPricing: ResolvedPromptPricingConfig;

  constructor(options?: string | PromptProxyEngineOptions) {
    const dbPath = typeof options === 'string' ? options : options?.db_path;
    this.cacheManager = new SemanticCacheManager(dbPath);
    this.defaultPricing = this.resolvePricing(typeof options === 'string' ? undefined : options?.pricing);
  }

  public async initialize(): Promise<void> {
    await this.cacheManager.initialize();
  }

  public async processPrompt(
    rawPrompt: string,
    mode: ProcessingMode = 'blocking',
    ideContext?: PromptIDEContext
  ): Promise<ProcessPromptResponse> {
    return this.processRequest({
      raw_prompt: rawPrompt,
      mode,
      ide_context: ideContext,
    });
  }

  public async processRequest(request: PromptOptimizationRequest): Promise<PromptOptimizationResponse> {
    const rawPrompt = request.raw_prompt?.trim() ?? '';
    const pricing = this.resolvePricing(request.pricing);
    if (rawPrompt === '') {
      return this.createEmptyResponse(pricing);
    }

    const mode = request.mode ?? 'blocking';
    const workspaceId = request.workspace_id ?? request.ide_context?.workspace_root ?? 'global';
    const rawSnapshot = this.buildRawInputSnapshot(rawPrompt, request.ide_context);
    const rawInputTokens = this.countTokens(rawSnapshot);
    const contextPack = this.collectRelevantContext(rawPrompt, request.ide_context);

    let cacheResult: CacheQueryResult | null = null;
    try {
      if (mode === 'blocking') {
        cacheResult = await this.cacheManager.checkCache(rawSnapshot, workspaceId);
      } else {
        cacheResult = await this.withTimeout(this.cacheManager.checkCache(rawSnapshot, workspaceId), CACHE_TIMEOUT_MS, null);
      }
    } catch (error) {
      console.error('[PromptProxyEngine] Cache lookup error:', error);
    }

    let cacheCandidates: PromptCacheCandidate[] = [];
    try {
      const matches = mode === 'blocking'
        ? await this.cacheManager.searchSimilarPrompts(rawSnapshot, MAX_CACHE_CANDIDATES, workspaceId)
        : await this.withTimeout(this.cacheManager.searchSimilarPrompts(rawSnapshot, MAX_CACHE_CANDIDATES, workspaceId), CACHE_TIMEOUT_MS, []);

      cacheCandidates = matches.map((match) => ({
        raw_prompt: match.rawPrompt,
        confidence: match.confidence,
        timestamp: match.timestamp,
      }));
    } catch (error) {
      console.error('[PromptProxyEngine] Cache search error:', error);
    }

    const targetModel = request.target_model ?? 'local';
    const structuredIr = parseToPromptIR(rawPrompt);
    const diagnostics = lintPrompt(rawPrompt, structuredIr, rawInputTokens);
    const stackInfo = inferRepoStack(request.ide_context?.workspace_root);
    const compiledRequest = compilePromptIR(structuredIr, targetModel, stackInfo.summary);
    const cacheStatus = cacheResult?.matchType ?? 'miss';
    const shouldReuseCachedPrompt = cacheStatus === 'exact' && !this.containsLegacyExampleSection(cacheResult!.optimizedPrompt);

    // Save prompt versioning info inside the database
    const hashedKey = rawPrompt.slice(0, 120);
    this.cacheManager.recordVersion(hashedKey, rawPrompt, compiledRequest, targetModel, 'main', 0.0);

    const optimizedPrompt = this.sanitizeOptimizedPrompt(
      shouldReuseCachedPrompt
        ? cacheResult!.optimizedPrompt
        : this.buildOptimizedPrompt(compiledRequest, contextPack.sections)
    );

    if (!shouldReuseCachedPrompt) {
      if (mode === 'blocking') {
        await this.cacheManager.writeToCache(rawSnapshot, optimizedPrompt, workspaceId);
      } else {
        this.cacheManager.writeToCache(rawSnapshot, optimizedPrompt, workspaceId).catch((error) => {
          console.error('[PromptProxyEngine] Async background write error:', error);
        });
      }
    }

    const optimizedInputTokens = this.countTokens(optimizedPrompt);
    const estimatedOutputTokens = this.predictOutputTokens(optimizedPrompt, contextPack.files.length, contextPack.logs.length);
    const costInsight = this.calculateCostBreakdown(optimizedInputTokens, estimatedOutputTokens, pricing);
    const estimatedCostUSD = costInsight.total_cost_usd;
    const explanation = explainRewrite(structuredIr, diagnostics, targetModel);

    return {
      metrics: {
        raw_input_tokens: rawInputTokens,
        optimized_input_tokens: optimizedInputTokens,
        tokens_saved: Math.max(0, rawInputTokens - optimizedInputTokens),
        estimated_output_tokens: estimatedOutputTokens,
        estimated_cost_usd: estimatedCostUSD,
      },
      optimized_prompt: optimizedPrompt,
      improvements: [
        ...diagnostics.map((d) => `[${d.code}]: ${d.message} (Suggestion: ${d.fix_suggestion})`),
        ...this.selectImprovementSuggestions(optimizedPrompt, request.ide_context),
      ].slice(0, MAX_IMPROVEMENTS),
      analysis: {
        cache: this.buildCacheInsight(cacheStatus, cacheResult, cacheCandidates),
        context: contextPack.insight,
        cost: costInsight,
      },
      diagnostics,
      structured_ir: structuredIr,
      explanation,
    };
  }

  public close(): void {
    this.cacheManager.close();
  }

  private resolvePricing(pricing?: PromptPricingConfig): ResolvedPromptPricingConfig {
    return {
      input_cost_per_1k_tokens: pricing?.input_cost_per_1k_tokens ?? this.defaultPricing?.input_cost_per_1k_tokens ?? DEFAULT_INPUT_COST_PER_1K,
      output_cost_per_1k_tokens: pricing?.output_cost_per_1k_tokens ?? this.defaultPricing?.output_cost_per_1k_tokens ?? DEFAULT_OUTPUT_COST_PER_1K,
    };
  }

  private calculateCostBreakdown(
    optimizedInputTokens: number,
    estimatedOutputTokens: number,
    pricing: ResolvedPromptPricingConfig
  ): PromptOptimizationAnalysis['cost'] {
    const inputCost = Number(((optimizedInputTokens / 1000) * pricing.input_cost_per_1k_tokens).toFixed(6));
    const outputCost = Number(((estimatedOutputTokens / 1000) * pricing.output_cost_per_1k_tokens).toFixed(6));

    return {
      input_cost_usd: inputCost,
      output_cost_usd: outputCost,
      total_cost_usd: Number((inputCost + outputCost).toFixed(6)),
      input_cost_per_1k_tokens: pricing.input_cost_per_1k_tokens,
      output_cost_per_1k_tokens: pricing.output_cost_per_1k_tokens,
    };
  }

  private buildRawInputSnapshot(rawPrompt: string, ideContext?: PromptIDEContext): string {
    const sections = ['# Request', rawPrompt.trim()];

    if (!ideContext) {
      return sections.join('\n\n');
    }

    if (ideContext.active_file) {
      sections.push(`# ${ideContext.active_file.path}`, ideContext.active_file.content.trim());
    }

    for (const file of ideContext.open_files ?? []) {
      if (ideContext.active_file && file.path === ideContext.active_file.path) {
        continue;
      }

      sections.push(`# ${file.path}`, file.content.trim());
    }

    for (const log of ideContext.logs ?? []) {
      sections.push(`# ${log.source}`, log.content.trim());
    }

    return sections.filter((section) => section.trim() !== '').join('\n\n');
  }

  private buildOptimizedPrompt(rawPrompt: string, contextSections: string[]): string {
    // Strip any injected context blocks that may have leaked from a prior optimized-prompt
    // being used as new input (e.g. # Problems, # Prompt Optimizer Session Buffer).
    const cleanPrompt = rawPrompt
      .replace(/(?:^|\n\n)# Problems\n[\s\S]*?(?=\n\n#|$)/g, '')
      .replace(/(?:^|\n\n)# Prompt (?:Proxy|Optimizer)[^\n]*\n[\s\S]*?(?=\n\n#|$)/g, '')
      .trim();

    const optimizedRequest = this.optimizePromptText(cleanPrompt);
    const sections = [`# Request\n${optimizedRequest}`];

    for (const section of contextSections) {
      // Never embed diagnostics/problems or internal Prompt Optimizer buffers in the optimized output.
      if (this.isInternalPromptSection(section)) {
        continue;
      }

      sections.push(section);
    }

    return sections.filter((section) => section.trim() !== '').join('\n\n').trim();
  }

  private sanitizeOptimizedPrompt(prompt: string): string {
    return prompt
      .replace(/(?:^|\n\n)# Problems\n[\s\S]*?(?=\n\n# |$)/g, '')
      .replace(/(?:^|\n\n)# Prompt (?:Proxy|Optimizer)[^\n]*\n[\s\S]*?(?=\n\n# |$)/gi, '')
      .replace(/(?:^|\n\n)<examples>[\s\S]*?<\/examples>(?=\n\n# |$)/gi, '')
      .replace(/(?:^|\n\n)### EXAMPLES[\s\S]*?(?=\n\n# |$)/g, '')
      .replace(/(?:^|\n\n)\*\*REFERENCE EXAMPLES\*\*[\s\S]*?(?=\n\n# |$)/g, '')
      .replace(/(?:^|\n\n)\[EXAMPLE\]:[\s\S]*?(?=\n\n# |$)/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  private isInternalPromptSection(section: string): boolean {
    const trimmedSection = section.trimStart();
    return /^# Problems\b/i.test(trimmedSection) || /^# Prompt (?:Proxy|Optimizer)\b/i.test(trimmedSection);
  }

  private containsLegacyExampleSection(prompt: string): boolean {
    return /<examples>|### EXAMPLES|\*\*REFERENCE EXAMPLES\*\*|\[EXAMPLE\]:/i.test(prompt);
  }

  private collectRelevantContext(rawPrompt: string, ideContext?: PromptIDEContext): RelevantContextPack {
    const emptyInsight: PromptOptimizationAnalysis['context'] = {
      workspace_root: ideContext?.workspace_root,
      active_file: ideContext?.active_file?.path,
      selected_files: [],
      selected_logs: [],
      log_sources: (ideContext?.logs ?? []).map((log) => log.source),
      open_file_count: this.countDistinctFiles(ideContext),
      total_log_count: ideContext?.logs?.length ?? 0,
    };

    if (!ideContext) {
      return {
        files: [],
        logs: [],
        sections: [],
        insight: emptyInsight,
      };
    }

    const queryTerms = this.buildQueryTerms(rawPrompt);
    const sections: string[] = [];
    const seenSections = new Set<string>();
    const selectedFiles: IdeContextFile[] = [];
    const selectedLogs: IdeContextLog[] = [];

    for (const file of this.selectRelevantFiles(ideContext, queryTerms)) {
      const snippet = this.extractRelevantFileSnippet(file, queryTerms);
      if (snippet === '') {
        continue;
      }

      const section = this.formatFileSection(file, snippet);
      if (!seenSections.has(section)) {
        seenSections.add(section);
        selectedFiles.push(file);
        sections.push(section);
      }
    }

    for (const log of this.selectRelevantLogs(ideContext.logs ?? [], queryTerms)) {
      const snippet = this.extractRelevantLogSnippet(log, queryTerms);
      if (snippet === '') {
        continue;
      }

      const section = this.formatLogSection(log, snippet);
      if (!seenSections.has(section)) {
        seenSections.add(section);
        selectedLogs.push(log);
        sections.push(section);
      }
    }

    return {
      files: selectedFiles,
      logs: selectedLogs,
      sections,
      insight: {
        workspace_root: ideContext.workspace_root,
        active_file: ideContext.active_file?.path,
        selected_files: selectedFiles.map((file) => file.path),
        selected_logs: selectedLogs.map((log) => log.source),
        log_sources: (ideContext.logs ?? []).map((log) => log.source),
        open_file_count: this.countDistinctFiles(ideContext),
        total_log_count: ideContext.logs?.length ?? 0,
      },
    };
  }

  private optimizePromptText(prompt: string): string {
    const segments = this.splitTextSegments(prompt);
    const optimizedSegments: string[] = [];
    const seenCodeBlocks = new Set<string>();

    for (const segment of segments) {
      if (segment.is_code) {
        const normalizedCode = segment.content.trim();
        if (seenCodeBlocks.has(normalizedCode)) {
          continue;
        }

        seenCodeBlocks.add(normalizedCode);
        optimizedSegments.push(normalizedCode);
        continue;
      }

      const optimizedText = this.optimizePlainTextSegment(segment.content);
      if (optimizedText !== '') {
        optimizedSegments.push(optimizedText);
      }
    }

    return optimizedSegments.join('\n\n').trim();
  }

  private splitTextSegments(text: string): TextSegment[] {
    return text
      .split(/(```[\s\S]*?```)/g)
      .filter((segment) => segment !== '')
      .map((segment) => ({
        content: segment,
        is_code: segment.startsWith('```') && segment.endsWith('```'),
      }));
  }

  private optimizePlainTextSegment(text: string): string {
    const lines = text.split(/\r?\n/);
    const optimizedLines: string[] = [];
    const seenLines = new Set<string>();

    for (const rawLine of lines) {
      const trimmedLine = rawLine.trim();

      if (trimmedLine === '') {
        if (optimizedLines.length > 0 && optimizedLines[optimizedLines.length - 1] !== '') {
          optimizedLines.push('');
        }
        continue;
      }

      if (this.isBlankCommentLine(trimmedLine) || this.isStandaloneImportLine(trimmedLine)) {
        continue;
      }

      if (this.looksLikeCodeLine(trimmedLine)) {
        optimizedLines.push(rawLine);
        continue;
      }

      const compressedLine = this.compressDirectiveLine(trimmedLine);
      if (compressedLine === '') {
        continue;
      }

      const normalizedLine = compressedLine.toLowerCase().replace(/\s+/g, ' ').trim();
      if (seenLines.has(normalizedLine)) {
        continue;
      }

      seenLines.add(normalizedLine);
      optimizedLines.push(compressedLine);
    }

    return optimizedLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  private compressDirectiveLine(line: string): string {
    let normalized = line
      // Politeness words
      .replace(/\b(?:please|kindly)\b/gi, '')
      // Modal "can/could/would you"
      .replace(/\b(?:can|could|would)\s+you\b/gi, '')
      // Filler prefaces — ECC-inspired patterns
      .replace(/\bI (?:need|want) you to\b/gi, '')
      .replace(/\bI would like(?: you)? to\b/gi, '')
      .replace(/\bI'd like(?: you)? to\b/gi, '')
      .replace(/\bhow (?:do|can) I\b/gi, '')
      .replace(/\bhelp me(?: to)?\b/gi, '')
      .replace(/\bassist me(?: with| in)?\b/gi, '')
      .replace(/\btell me(?: how to| about)?\b/gi, '')
      .replace(/\bwalk me through\b/gi, 'explain')
      .replace(/\bgo ahead and\b/gi, '')
      .replace(/\bfeel free to\b/gi, '')
      .replace(/\blet(?:'s| us)\b/gi, '')
      .replace(/\bjust\b/gi, '')
      // Job-role framing
      .replace(/\bYour (?:task|job) is to\b/gi, '')
      .replace(/\bIt is important to\b/gi, '')
      // Replacements for wordy phrases
      .replace(/\bmake sure\b/gi, 'ensure')
      .replace(/\bshow me how to\b/gi, 'describe')
      .replace(/\bsurrounding IDE context\b/gi, 'IDE context')
      // Cleanup
      .replace(/\s+/g, ' ')
      .replace(/\s+([,.;:!?])/g, '$1')
      .trim();

    normalized = normalized.replace(/^[,:;\-\s]+/, '').trim();
    if (normalized === '') {
      return '';
    }

    return normalized.charAt(0).toUpperCase() + normalized.slice(1);
  }

  private buildQueryTerms(rawPrompt: string): Set<string> {
    const features = this.vectorizer.analyze(rawPrompt);
    return new Set(features.tokens);
  }

  private countDistinctFiles(ideContext?: PromptIDEContext): number {
    const paths = new Set<string>();

    if (ideContext?.active_file?.path) {
      paths.add(ideContext.active_file.path);
    }

    for (const file of ideContext?.open_files ?? []) {
      paths.add(file.path);
    }

    return paths.size;
  }

  private selectRelevantFiles(ideContext: PromptIDEContext, queryTerms: Set<string>): IdeContextFile[] {
    const candidates = new Map<string, IdeContextFile>();

    if (ideContext.active_file) {
      candidates.set(ideContext.active_file.path, { ...ideContext.active_file, is_active: true });
    }

    for (const file of ideContext.open_files ?? []) {
      if (!candidates.has(file.path)) {
        candidates.set(file.path, file);
      }
    }

    return Array.from(candidates.values())
      .map((file) => ({
        file,
        score: this.scoreTextRelevance(`${file.path}\n${file.selection ?? ''}\n${file.content}`, queryTerms),
      }))
      .filter(({ file, score }) => Boolean(file.is_active) || score >= 0.08)
      .sort((left, right) => Number(Boolean(right.file.is_active)) - Number(Boolean(left.file.is_active)) || right.score - left.score)
      .slice(0, MAX_CONTEXT_FILES)
      .map((entry) => entry.file);
  }

  private selectRelevantLogs(logs: IdeContextLog[], queryTerms: Set<string>): IdeContextLog[] {
    return logs
      .map((log) => ({
        log,
        score: this.scoreTextRelevance(log.content, queryTerms),
      }))
      .filter(({ log, score }) => log.kind !== 'problems' && (score >= 0.05 || /error|exception|failed|warning|stack/i.test(log.content)))
      .sort((left, right) => right.score - left.score)
      .slice(0, MAX_CONTEXT_LOGS)
      .map((entry) => entry.log);
  }

  private scoreTextRelevance(text: string, queryTerms: Set<string>): number {
    if (queryTerms.size === 0) {
      return 0;
    }

    const features = this.vectorizer.analyze(text);
    const candidateTerms = new Set(features.tokens);
    let matches = 0;

    for (const term of queryTerms) {
      if (candidateTerms.has(term)) {
        matches++;
      }
    }

    return matches / queryTerms.size;
  }

  private extractRelevantFileSnippet(file: IdeContextFile, queryTerms: Set<string>): string {
    if ((file.selection ?? '').trim() !== '') {
      return file.selection!.trim();
    }

    const lines = file.content.split(/\r?\n/);
    if (lines.length <= MAX_FILE_LINES) {
      return file.content.trim();
    }

    const matchingLineIndexes: number[] = [];
    for (let index = 0; index < lines.length; index++) {
      if (this.lineMatchesQuery(lines[index].toLowerCase(), queryTerms)) {
        matchingLineIndexes.push(index);
      }
    }

    if (matchingLineIndexes.length === 0) {
      return file.is_active ? lines.slice(0, Math.min(MAX_FILE_LINES, lines.length)).join('\n').trim() : '';
    }

    return this.buildSnippetFromLineIndexes(lines, matchingLineIndexes, MAX_FILE_LINES).trim();
  }

  private extractRelevantLogSnippet(log: IdeContextLog, queryTerms: Set<string>): string {
    const lines = log.content.split(/\r?\n/);
    const relevantLines: string[] = [];
    const seenLines = new Set<string>();

    for (const line of lines) {
      const trimmedLine = line.trim();
      if (trimmedLine === '') {
        continue;
      }

      const normalizedLine = trimmedLine.toLowerCase();
      if (seenLines.has(normalizedLine)) {
        continue;
      }

      if (this.lineMatchesQuery(normalizedLine, queryTerms) || /error|exception|failed|warning|stack/i.test(trimmedLine)) {
        seenLines.add(normalizedLine);
        relevantLines.push(trimmedLine);
      }

      if (relevantLines.length >= MAX_LOG_LINES) {
        break;
      }
    }

    return relevantLines.join('\n').trim();
  }

  private buildSnippetFromLineIndexes(lines: string[], indexes: number[], maxLines: number): string {
    const includedIndexes = new Set<number>();

    for (const index of indexes) {
      for (let cursor = Math.max(0, index - 2); cursor <= Math.min(lines.length - 1, index + 2); cursor++) {
        includedIndexes.add(cursor);
      }
    }

    const sortedIndexes = Array.from(includedIndexes).sort((left, right) => left - right).slice(0, maxLines);
    const snippetLines: string[] = [];
    let previousIndex = -2;

    for (const index of sortedIndexes) {
      if (previousIndex >= 0 && index > previousIndex + 1) {
        snippetLines.push('...');
      }

      snippetLines.push(lines[index]);
      previousIndex = index;
    }

    return snippetLines.join('\n');
  }

  private formatFileSection(file: IdeContextFile, snippet: string): string {
    const language = file.language ?? this.detectLanguageFromPath(file.path);
    const fenceStart = language === '' ? '```' : '```' + language;
    return [`# ${file.path}`, fenceStart, snippet, '```'].join('\n');
  }

  private formatLogSection(log: IdeContextLog, snippet: string): string {
    return [`# ${log.source}`, '```text', snippet, '```'].join('\n');
  }

  private detectLanguageFromPath(filePath: string): string {
    const extension = filePath.split('.').pop()?.toLowerCase();
    switch (extension) {
      case 'ts':
      case 'tsx':
        return 'ts';
      case 'js':
      case 'jsx':
        return 'js';
      case 'py':
        return 'python';
      case 'java':
        return 'java';
      case 'kt':
        return 'kotlin';
      case 'json':
        return 'json';
      case 'md':
        return 'md';
      case 'xml':
        return 'xml';
      default:
        return '';
    }
  }

  private lineMatchesQuery(line: string, queryTerms: Set<string>): boolean {
    for (const term of queryTerms) {
      if (term !== '' && line.includes(term.toLowerCase())) {
        return true;
      }
    }

    return false;
  }

  private looksLikeCodeLine(line: string): boolean {
    return /^(?:import|export|const|let|var|function|class|interface|type|enum|async|await|return|if|else|switch|case|for|while|try|catch)\b/.test(line)
      || /=>|[{}();]$/.test(line)
      || /^\s*[\w$.]+\(/.test(line);
  }

  private isBlankCommentLine(line: string): boolean {
    return /^\/\/+$/.test(line)
      || /^#+$/.test(line)
      || /^\/\*+$/.test(line)
      || /^\*+$/.test(line)
      || /^\*\/+$/.test(line);
  }

  private isStandaloneImportLine(line: string): boolean {
    return /^(?:import\s+.*\s+from\s+['"].*['"];?|require\s*\(\s*['"].*['"]\s*\);?)$/i.test(line);
  }

  private withTimeout<T>(promise: Promise<T>, ms: number, defaultValue: T): Promise<T> {
    let timer: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(defaultValue), ms);
    });

    return Promise.race([promise, timeoutPromise]).finally(() => {
      if (timer) {
        clearTimeout(timer);
      }
    });
  }

  private countTokens(text: string): number {
    try {
      return encode(text).length;
    } catch {
      return Math.ceil(text.length / 4);
    }
  }

  private predictOutputTokens(prompt: string, selectedFileCount: number, selectedLogCount: number): number {
    const normalizedPrompt = prompt.toLowerCase();
    let estimate = 110 + Math.round(Math.min(260, this.countTokens(prompt) * 0.34));

    if (/(fix|bug|repair|issue|resolve|crash)/.test(normalizedPrompt)) {
      estimate += 80;
    }

    if (/(refactor|optimize|rewrite|restructure|feature|implement|build)/.test(normalizedPrompt)) {
      estimate += 170;
    }

    if (/(test|unit test|pytest|mocha|jest)/.test(normalizedPrompt)) {
      estimate += 110;
    }

    if (/(explain|documentation|docstring|describe|readme)/.test(normalizedPrompt)) {
      estimate += 50;
    }

    if (/```/.test(prompt)) {
      estimate += 35;
    }

    if (/#\s+[^\n]+\.(ts|tsx|js|jsx|py|java|kt|json|xml|md)/i.test(prompt)) {
      estimate += 25;
    }

    estimate += Math.min(180, selectedFileCount * 45);
    estimate += Math.min(120, selectedLogCount * 30);

    if (/(json|yaml|markdown|bullet|table)/.test(normalizedPrompt)) {
      estimate -= 20;
    }

    return Math.max(120, Math.min(1400, estimate));
  }

  private buildCacheInsight(
    cacheStatus: 'exact' | 'semantic' | 'miss',
    cacheResult: CacheQueryResult | null,
    cacheCandidates: PromptCacheCandidate[]
  ): PromptOptimizationAnalysis['cache'] {
    return {
      status: cacheStatus,
      confidence: cacheStatus === 'exact' ? 1 : cacheResult?.confidence ?? 0,
      candidates: cacheCandidates,
    };
  }

  private selectImprovementSuggestions(prompt: string, ideContext?: PromptIDEContext): string[] {
    const suggestions: string[] = [];
    const lowerPrompt = prompt.toLowerCase();

    if (!/\bjson\b|\byaml\b|\bmarkdown\b|\bbullet\b|\btable\b/.test(lowerPrompt)) {
      suggestions.push('Specify the exact output format, for example JSON with required keys or a fixed checklist.');
    }

    if ((ideContext?.active_file || /#\s+[^\n]+\.(ts|tsx|js|jsx|py|java|kt|json|xml)/i.test(prompt)) && !lowerPrompt.includes('selection')) {
      suggestions.push('Limit the request to the active selection or the smallest failing snippet to improve answer precision.');
    }

    if (/\b(function|class|const|let|var|import|export|interface)\b/.test(lowerPrompt) && !/```/.test(prompt)) {
      suggestions.push('Wrap source code in fenced code blocks and keep one file anchor per snippet.');
    }

    if (suggestions.length === 0) {
      suggestions.push('Add explicit acceptance criteria so the response can be validated without extra clarification.');
    }

    return Array.from(new Set(suggestions)).slice(0, MAX_IMPROVEMENTS);
  }

  private createEmptyResponse(pricing: ResolvedPromptPricingConfig): PromptOptimizationResponse {
    return {
      metrics: {
        raw_input_tokens: 0,
        optimized_input_tokens: 0,
        tokens_saved: 0,
        estimated_output_tokens: 0,
        estimated_cost_usd: 0,
      },
      optimized_prompt: '',
      improvements: [],
      analysis: {
        cache: {
          status: 'miss',
          confidence: 0,
          candidates: [],
        },
        context: {
          selected_files: [],
          selected_logs: [],
          log_sources: [],
          open_file_count: 0,
          total_log_count: 0,
        },
        cost: {
          input_cost_usd: 0,
          output_cost_usd: 0,
          total_cost_usd: 0,
          input_cost_per_1k_tokens: pricing.input_cost_per_1k_tokens,
          output_cost_per_1k_tokens: pricing.output_cost_per_1k_tokens,
        },
      },
    };
  }
}