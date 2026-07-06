import type {
  DeterministicRoutingDecision,
  IdeContextFile,
  IdeContextLog,
  PromptIDEContext,
  PromptOptimizationAnalysis,
} from '../contracts.js';
import { LocalSemanticVectorizer } from '../localSemanticVectorizer.js';
import { MAX_CONTEXT_FILES, MAX_CONTEXT_LOGS } from './constants.js';
import {
  extractPromptLiterals,
  extractRelevantFileSnippet,
  extractRelevantLogSnippet,
  extractSalientTerms,
  formatFileSection,
  formatLogSection,
  lineMatchesLiteral,
} from './contextPacker.helpers.js';
import { extractPromptPhraseWords, scoreFilenamePhraseMatch } from './symbolPhraseMatch.js';
import { resolveWorkspaceFiles } from './workspaceFileResolver.js';
import type { RelevantContextPack } from './types.js';

export class ContextPacker {
  private readonly vectorizer = new LocalSemanticVectorizer();

  private static readonly ROUTE_SEMANTIC_MIN = 0.2;

  private static readonly ROUTE_SEMANTIC_MARGIN = 0.08;

  /** An open file at/above this route score makes a workspace scan unnecessary. */
  private static readonly WORKSPACE_SCAN_SKIP_SCORE = 80;

  buildQueryTerms(rawPrompt: string): Set<string> {
    const features = this.vectorizer.analyze(rawPrompt);
    return new Set(features.tokens);
  }

  countDistinctFiles(ideContext?: PromptIDEContext): number {
    const paths = new Set<string>();
    if (ideContext?.active_file?.path) { paths.add(ideContext.active_file.path); }
    for (const file of ideContext?.open_files ?? []) { paths.add(file.path); }
    return paths.size;
  }

  scoreTextRelevance(text: string, queryTerms: Set<string>): number {
    if (queryTerms.size === 0) { return 0; }
    const features = this.vectorizer.analyze(text);
    const candidateTerms = new Set(features.tokens);
    let matches = 0;
    for (const term of queryTerms) {
      if (candidateTerms.has(term)) { matches++; }
    }
    return matches / queryTerms.size;
  }

  private normalizePath(input: string): string {
    return input.replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase();
  }

  private extractPathHints(rawPrompt: string): Set<string> {
    const hints = new Set<string>();
    for (const match of rawPrompt.matchAll(/([A-Za-z0-9_.\-/\\]+\.[A-Za-z0-9]+)/g)) {
      hints.add(this.normalizePath(match[1]));
    }
    return hints;
  }

  private countSymbolEvidence(content: string, salientTerms: Set<string>): number {
    if (salientTerms.size === 0 || content.trim() === '') { return 0; }
    let matches = 0;
    for (const line of content.split(/\r?\n/)) {
      if (lineMatchesLiteral(line.toLowerCase(), salientTerms)) { matches++; }
    }
    return matches;
  }

  private pathEvidence(filePath: string, pathHints: Set<string>): number {
    if (pathHints.size === 0) { return 0; }
    const normalized = this.normalizePath(filePath);
    const base = normalized.slice(normalized.lastIndexOf('/') + 1);
    for (const hint of pathHints) {
      if (normalized === hint || normalized.endsWith(`/${hint}`)) { return 100; }
      const hintBase = hint.slice(hint.lastIndexOf('/') + 1);
      if (base === hintBase) { return 80; }
    }
    return 0;
  }

  /**
   * Match a prompt's salient symbols against a file's *basename* (extension
   * stripped). Catches the common case where a prompt names a file by its
   * class/module symbol — `promptProxyEngine` → `PromptProxyEngine.ts` — with
   * no explicit `.ts` path hint. A whole-basename hit is strong, deterministic
   * routing evidence on par with a path match.
   */
  private filenameSymbolEvidence(filePath: string, salientTerms: Set<string>): number {
    if (salientTerms.size === 0) { return 0; }
    const normalized = this.normalizePath(filePath);
    const base = normalized.slice(normalized.lastIndexOf('/') + 1);
    const stem = base.includes('.') ? base.slice(0, base.indexOf('.')) : base;
    if (stem === '') { return 0; }
    for (const term of salientTerms) {
      if (term === '') { continue; }
      if (stem === term) { return 90; }
    }
    return 0;
  }

  /**
   * Match a file's *basename* (extension stripped) against the prompt's plain
   * content words — the case a user names a file in English ("prompt ir helper")
   * rather than as a verbatim camelCase token. Decomposes the basename into
   * subwords and scores concatenated-run and fuzzy-coverage matches, so typos
   * and word-spacing don't drop the strongest piece of routing evidence.
   */
  private filenamePhraseEvidence(filePath: string, promptWords: string[]): number {
    if (promptWords.length === 0) { return 0; }
    // Preserve original casing here (do NOT lowercase) — subword decomposition
    // relies on camelCase/acronym boundaries that normalizePath would erase.
    const path = filePath.replace(/\\/g, '/');
    const base = path.slice(path.lastIndexOf('/') + 1);
    const stem = base.includes('.') ? base.slice(0, base.indexOf('.')) : base;
    return scoreFilenamePhraseMatch(stem, promptWords);
  }

  selectRelevantFiles(
    ideContext: PromptIDEContext,
    rawPrompt: string,
    queryTerms: Set<string>,
    salientTerms: Set<string>,
  ): { files: IdeContextFile[]; routing: DeterministicRoutingDecision } {
    const candidates = new Map<string, IdeContextFile>();
    if (ideContext.active_file) {
      candidates.set(ideContext.active_file.path, { ...ideContext.active_file, is_active: true });
    }
    for (const file of ideContext.open_files ?? []) {
      if (!candidates.has(file.path)) { candidates.set(file.path, file); }
    }

    const pathHints = this.extractPathHints(rawPrompt);
    const promptWords = extractPromptPhraseWords(rawPrompt);
    const scoreCandidate = (file: IdeContextFile, discovered: boolean) => {
      const semantic = this.scoreTextRelevance(`${file.path}\n${file.selection ?? ''}\n${file.content}`, queryTerms);
      const pathScore = this.pathEvidence(file.path, pathHints);
      const nameScore = Math.max(
        this.filenameSymbolEvidence(file.path, salientTerms),
        this.filenamePhraseEvidence(file.path, promptWords),
      );
      const routeScore = Math.max(pathScore, nameScore);
      const symbolHits = this.countSymbolEvidence(file.content, salientTerms);
      return {
        file,
        semantic,
        pathScore,
        nameScore,
        routeScore,
        symbolHits,
        discovered,
        hasDeterministicEvidence: routeScore > 0 || symbolHits > 0,
      };
    };
    const scored = Array.from(candidates.values()).map((file) => scoreCandidate(file, false));

    // Workspace exact-match discovery: when no *open* file carries strong
    // route evidence but the prompt names a concrete file/symbol, scan the
    // code base itself so the exact match is found even if it isn't open.
    const bestOpenRoute = scored.reduce((max, entry) => Math.max(max, entry.routeScore), 0);
    if (
      ideContext.workspace_root
      && bestOpenRoute < ContextPacker.WORKSPACE_SCAN_SKIP_SCORE
      && (pathHints.size > 0 || salientTerms.size > 0 || promptWords.length > 0)
    ) {
      const excludePaths = new Set(
        Array.from(candidates.keys()).map((p) => this.normalizePath(p)),
      );
      for (const file of resolveWorkspaceFiles({
        workspaceRoot: ideContext.workspace_root,
        pathHints,
        salientTerms,
        promptWords,
        excludePaths,
      })) {
        if (candidates.has(file.path)) { continue; }
        candidates.set(file.path, file);
        scored.push(scoreCandidate(file, true));
      }
    }

    const deterministic = scored
      .filter((entry) => entry.hasDeterministicEvidence)
      .sort((l, r) =>
        Number(Boolean(r.file.is_active)) - Number(Boolean(l.file.is_active))
        || r.routeScore - l.routeScore
        || r.symbolHits - l.symbolHits
        || r.semantic - l.semantic,
      );

    if (deterministic.length > 0) {
      const selected = deterministic.slice(0, MAX_CONTEXT_FILES).map((entry) => entry.file);
      const top = deterministic[0];
      return {
        files: selected,
        routing: {
          status: 'resolved',
          strategy: top.discovered ? 'workspace-scan' : 'path-symbol',
          reason: top.discovered
            ? 'Exact match found by scanning the workspace code base (file was not open).'
            : top.pathScore > 0
              ? 'Exact file-path evidence found in prompt.'
              : top.nameScore > 0
                ? 'Filename matched the prompt wording (symbol/phrase evidence).'
                : 'Exact symbol evidence found in file content.',
        },
      };
    }

    const semanticRanked = [...scored].sort((l, r) =>
      Number(Boolean(r.file.is_active)) - Number(Boolean(l.file.is_active)) || r.semantic - l.semantic,
    );
    const top = semanticRanked[0];
    const second = semanticRanked[1];
    if (top && top.semantic >= ContextPacker.ROUTE_SEMANTIC_MIN) {
      const margin = top.semantic - (second?.semantic ?? 0);
      if (margin >= ContextPacker.ROUTE_SEMANTIC_MARGIN) {
        return {
          files: semanticRanked.slice(0, MAX_CONTEXT_FILES).map((entry) => entry.file),
          routing: {
            status: 'resolved',
            strategy: 'semantic-fallback',
            reason: `Semantic fallback used (score ${top.semantic.toFixed(3)}, margin ${margin.toFixed(3)}).`,
          },
        };
      }
      return {
        files: top.file.is_active ? [top.file] : [],
        routing: {
          status: 'ambiguous',
          strategy: top.file.is_active ? 'active-file-fallback' : 'none',
          reason: `Semantic tie detected (top margin ${margin.toFixed(3)} below ${ContextPacker.ROUTE_SEMANTIC_MARGIN.toFixed(2)}).`,
        },
      };
    }

    if (ideContext.active_file) {
      return {
        files: [{ ...ideContext.active_file, is_active: true }],
        routing: {
          status: 'unresolved',
          strategy: 'active-file-fallback',
          reason: 'No deterministic prompt-to-file evidence; using active file only.',
        },
      };
    }

    return {
      files: [],
      routing: {
        status: 'unresolved',
        strategy: 'none',
        reason: 'No deterministic prompt-to-file evidence and no active file available.',
      },
    };
  }

  selectRelevantLogs(logs: IdeContextLog[], queryTerms: Set<string>): IdeContextLog[] {
    return logs
      .map((log) => ({ log, score: this.scoreTextRelevance(log.content, queryTerms) }))
      .filter(({ log, score }) =>
        log.kind !== 'problems'
        && (score >= 0.05 || /error|exception|failed|warning|stack/i.test(log.content)))
      .sort((l, r) => r.score - l.score)
      .slice(0, MAX_CONTEXT_LOGS)
      .map((entry) => entry.log);
  }

  private buildInsight(
    ideContext: PromptIDEContext | undefined,
    selectedFiles: IdeContextFile[],
    selectedLogs: IdeContextLog[],
    snippets: PromptOptimizationAnalysis['context']['context_snippets'],
    routing: DeterministicRoutingDecision,
  ): PromptOptimizationAnalysis['context'] {
    return {
      workspace_root: ideContext?.workspace_root,
      active_file: ideContext?.active_file?.path,
      selected_files: selectedFiles.map((file) => file.path),
      selected_logs: selectedLogs.map((log) => log.source),
      log_sources: (ideContext?.logs ?? []).map((log) => log.source),
      open_file_count: this.countDistinctFiles(ideContext),
      total_log_count: ideContext?.logs?.length ?? 0,
      context_snippets: snippets,
      deterministic_routing: routing,
    };
  }

  collectRelevantContext(rawPrompt: string, ideContext?: PromptIDEContext): RelevantContextPack {
    if (!ideContext) {
      return {
        files: [],
        logs: [],
        sections: [],
        insight: this.buildInsight(undefined, [], [], undefined, {
          status: 'unresolved',
          strategy: 'none',
          reason: 'No IDE context provided by caller.',
        }),
      };
    }

    const queryTerms = this.buildQueryTerms(rawPrompt);
    const salientTerms = extractSalientTerms(rawPrompt);
    const promptLiterals = extractPromptLiterals(rawPrompt);
    const sections: string[] = [];
    const seenSections = new Set<string>();
    const selectedFiles: IdeContextFile[] = [];
    const selectedLogs: IdeContextLog[] = [];
    const contextSnippets: NonNullable<PromptOptimizationAnalysis['context']['context_snippets']> = [];

    const fileSelection = this.selectRelevantFiles(ideContext, rawPrompt, queryTerms, salientTerms);
    for (const file of fileSelection.files) {
      const snippet = extractRelevantFileSnippet(file, queryTerms, salientTerms, promptLiterals);
      if (snippet.text === '') { continue; }
      const section = formatFileSection(file, snippet.text);
      if (seenSections.has(section)) { continue; }
      seenSections.add(section);
      selectedFiles.push(file);
      sections.push(section);
      contextSnippets.push({
        path: file.path,
        ranges: snippet.ranges.map((r) => ({ start_line: r.start, end_line: r.end })),
      });
    }

    for (const log of this.selectRelevantLogs(ideContext.logs ?? [], queryTerms)) {
      const snippet = extractRelevantLogSnippet(log, queryTerms);
      if (snippet === '') { continue; }
      const section = formatLogSection(log, snippet);
      if (seenSections.has(section)) { continue; }
      seenSections.add(section);
      selectedLogs.push(log);
      sections.push(section);
    }

    return {
      files: selectedFiles,
      logs: selectedLogs,
      sections,
      insight: this.buildInsight(ideContext, selectedFiles, selectedLogs, contextSnippets, fileSelection.routing),
    };
  }
}