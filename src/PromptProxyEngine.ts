import { SemanticCacheManager, CacheQueryResult } from './SemanticCacheManager.js';
import type {
  PromptCacheCandidate,
  ProcessPromptResponse,
  ProcessingMode,
  PromptIDEContext,
  PromptOptimizationRequest,
  PromptOptimizationResponse,
  PromptProxyEngineOptions,
} from './contracts.js';
import {
  parseToPromptIR,
  lintPrompt,
  compilePromptIR,
  explainRewrite,
} from './PromptIRHelper.js';
import { inferRepoStack } from './RepoAwareness.js';

import { CACHE_TIMEOUT_MS, MAX_CACHE_CANDIDATES, MAX_IMPROVEMENTS } from './engine/constants.js';
import { ContextPacker } from './engine/contextPacker.js';
import { buildCacheInsight, createEmptyResponse } from './engine/insights.js';
import {
  calculateCostBreakdown,
  countTokens,
  predictOutputTokens,
  resolvePricing,
} from './engine/pricing.js';
import {
  buildOptimizedPrompt,
  buildRawInputSnapshot,
  selectImprovementSuggestions,
} from './engine/promptBuilder.js';
import { containsLegacyExampleSection, sanitizeOptimizedPrompt } from './engine/sanitizer.js';
import type { ResolvedPromptPricingConfig } from './engine/types.js';
import { hashPromptKey, withTimeout } from './engine/utils.js';
import { KnowledgeGraph } from './engine/knowledgeGraph.js';
import { FileDigestStore } from './engine/fileDigest.js';
import {
  formatMemorySections,
  readWorkspaceMemory,
  persistMemorySnapshot,
} from './engine/workspaceMemory.js';
import { CrossWorkspaceFederation } from './engine/crossWorkspace.js';
import {
  describeMode,
  detectMode,
  renderChecklistSection,
  renderRoleSection,
  type SdlcModeDescriptor,
} from './engine/promptModes.js';

/**
 * High-level orchestrator: takes a raw prompt, consults the local semantic
 * cache, packs relevant workspace context, runs the prompt-IR pipeline, and
 * emits a structured optimization response.  Pure helpers live in
 * `./engine/*` modules to keep this file focused on flow control.
 */
export class PromptProxyEngine {
  private readonly cacheManager: SemanticCacheManager;
  private readonly contextPacker = new ContextPacker();
  private readonly defaultPricing: ResolvedPromptPricingConfig;
  private knowledgeGraph: KnowledgeGraph | null = null;
  private federation: CrossWorkspaceFederation | null = null;
  private fileDigests: FileDigestStore | null = null;

  constructor(options?: string | PromptProxyEngineOptions) {
    const dbPath = typeof options === 'string' ? options : options?.db_path;
    this.cacheManager = new SemanticCacheManager(dbPath);
    this.defaultPricing = resolvePricing(typeof options === 'string' ? undefined : options?.pricing);
  }

  public async initialize(): Promise<void> {
    await this.cacheManager.initialize();
    const db = this.cacheManager.rawDatabase();
    if (db) {
      this.knowledgeGraph = new KnowledgeGraph(db);
      this.federation = new CrossWorkspaceFederation(db);
      this.fileDigests = new FileDigestStore(db);
    }
  }

  /** Public accessor for the per-file digest store (used by CLI / extension). */
  public getFileDigestStore(): FileDigestStore | null {
    return this.fileDigests;
  }

  /** Public accessor for VS Code commands that manage peer workspaces. */
  public getFederation(): CrossWorkspaceFederation | null {
    return this.federation;
  }

  /** Public accessor for VS Code commands that inspect the KG. */
  public getKnowledgeGraph(): KnowledgeGraph | null {
    return this.knowledgeGraph;
  }

  /** Public accessor for the underlying cache manager — used by CLI status commands. */
  public getCacheManager(): SemanticCacheManager {
    return this.cacheManager;
  }

  public processPrompt(
    rawPrompt: string,
    mode: ProcessingMode = 'blocking',
    ideContext?: PromptIDEContext,
  ): Promise<ProcessPromptResponse> {
    return this.processRequest({ raw_prompt: rawPrompt, mode, ide_context: ideContext });
  }

  public async processRequest(
    request: PromptOptimizationRequest,
  ): Promise<PromptOptimizationResponse> {
    const originalRaw = request.raw_prompt?.trim() ?? '';
    const pricing = resolvePricing(request.pricing, this.defaultPricing);
    if (originalRaw === '') {
      return createEmptyResponse(pricing);
    }

    // SDLC mode detection (slash command or intent words).  We strip the
    // slash trigger from the prompt that gets optimised so it never leaks
    // into the output verbatim; the mode descriptor is reapplied below as a
    // dedicated role-preface + quality-checklist section.
    const { mode: sdlcMode, cleanedPrompt } = detectMode(originalRaw, {
      workspaceRoot: request.ide_context?.workspace_root,
      activeFilePath: request.ide_context?.active_file?.path,
      openFilePaths: (request.ide_context?.open_files ?? [])
        .map((f) => f.path)
        .filter((p): p is string => typeof p === 'string' && p !== ''),
    });
    const rawPrompt = cleanedPrompt.trim() === '' ? originalRaw : cleanedPrompt;

    const mode = request.mode ?? 'blocking';
    const workspaceId = request.workspace_id ?? request.ide_context?.workspace_root ?? 'global';
    const rawSnapshot = buildRawInputSnapshot(rawPrompt, request.ide_context);
    const rawInputTokens = countTokens(rawSnapshot);
    const contextPack = this.contextPacker.collectRelevantContext(rawPrompt, request.ide_context);

    const cacheResult = await this.lookupCache(rawSnapshot, workspaceId, mode);
    const cacheCandidates = await this.searchCacheCandidates(rawSnapshot, workspaceId, mode);

    const targetModel = request.target_model ?? 'local';
    const structuredIr = parseToPromptIR(rawPrompt);
    const diagnostics = lintPrompt(rawPrompt, structuredIr, rawInputTokens, targetModel);
    const stackInfo = inferRepoStack(request.ide_context?.workspace_root);
    const compiledRequest = compilePromptIR(structuredIr, targetModel, stackInfo.summary);

    // Workspace memory + knowledge graph + peer-workspace augmentations.
    const augmentedSections = this.collectAugmentedSections(
      rawPrompt,
      workspaceId,
      request.ide_context,
      stackInfo,
    );

    const cacheStatus = cacheResult?.matchType ?? 'miss';
    const shouldReuseCached =
      cacheStatus === 'exact'
      && cacheResult !== null
      && !containsLegacyExampleSection(cacheResult.optimizedPrompt);

    // Save prompt version regardless of cache hit so rollback always has data.
    const hashedKey = hashPromptKey(rawPrompt);
    this.cacheManager.recordVersion(hashedKey, rawPrompt, compiledRequest, targetModel, 'main', 0.0);

    const optimizedPrompt = applySdlcMode(
      sanitizeOptimizedPrompt(
        shouldReuseCached
          ? (cacheResult as CacheQueryResult).optimizedPrompt
          : buildOptimizedPrompt(compiledRequest, [...contextPack.sections, ...augmentedSections]),
      ),
      sdlcMode,
    );

    if (!shouldReuseCached) {
      this.persistCacheEntry(rawSnapshot, optimizedPrompt, workspaceId, mode);
    }

    const optimizedInputTokens = countTokens(optimizedPrompt);
    const estimatedOutputTokens = predictOutputTokens(
      optimizedPrompt,
      contextPack.files.length,
      contextPack.logs.length,
    );
    const costInsight = calculateCostBreakdown(optimizedInputTokens, estimatedOutputTokens, pricing);
    const explanation = explainRewrite(structuredIr, diagnostics, targetModel);

    return {
      metrics: {
        raw_input_tokens: rawInputTokens,
        optimized_input_tokens: optimizedInputTokens,
        tokens_saved: Math.max(0, rawInputTokens - optimizedInputTokens),
        estimated_output_tokens: estimatedOutputTokens,
        estimated_cost_usd: costInsight.total_cost_usd,
      },
      optimized_prompt: optimizedPrompt,
      improvements: [
        ...(sdlcMode ? [describeMode(sdlcMode)] : []),
        ...diagnostics.map((d) => `[${d.code}]: ${d.message} (Suggestion: ${d.fix_suggestion})`),
        ...selectImprovementSuggestions(optimizedPrompt, request.ide_context),
      ].slice(0, MAX_IMPROVEMENTS),
      analysis: {
        cache: buildCacheInsight(cacheStatus, cacheResult, cacheCandidates),
        context: contextPack.insight,
        cost: costInsight,
      },
      diagnostics,
      structured_ir: structuredIr,
      explanation,
      sdlc_mode: sdlcMode
        ? { id: sdlcMode.id, label: sdlcMode.label, trigger: sdlcMode.trigger, read_only: sdlcMode.readOnly }
        : undefined,
    };
  }

  public close(): void {
    this.federation?.dispose();
    this.cacheManager.close();
  }

  /**
   * Build the extra context sections injected just before compilation:
   *   1. Workspace memory (AGENTS.md / CLAUDE.md / .promptoptimizer/memory.md)
   *   2. Knowledge-graph neighbours of prompt concept terms
   *   3. Cross-workspace prior optimisations from peer caches
   * Each step is fault-tolerant — failures never break optimization.
   */
  private collectAugmentedSections(
    rawPrompt: string,
    workspaceId: string,
    ide: PromptIDEContext | undefined,
    stackInfo: ReturnType<typeof inferRepoStack>,
  ): string[] {
    const sections: string[] = [];
    const db = this.cacheManager.rawDatabase();

    try {
      const memory = readWorkspaceMemory(ide?.workspace_root, workspaceId);
      if (memory.entries.length > 0) {
        sections.push(...formatMemorySections(memory));
        if (db) { persistMemorySnapshot(db, memory); }
      }
    } catch { /* memory ingestion must never break optimization */ }

    try {
      if (this.knowledgeGraph) {
        this.knowledgeGraph.recordWorkspaceGraph(workspaceId, rawPrompt, ide, stackInfo);
        const suggestions = this.knowledgeGraph.collectGraphContext(workspaceId, rawPrompt);
        for (const suggestion of suggestions) { sections.push(suggestion.text); }
      }
    } catch { /* KG must never break optimization */ }

    // Per-file digest: record what we have studied this turn, then surface
    // recall hints for files we have seen before but are NOT re-injecting in
    // full content this turn.  This is the cross-session "I remember this
    // file" signal that survives a new chat.
    try {
      if (this.fileDigests) {
        this.fileDigests.recordFromIde(workspaceId, ide);
        const liveFilePaths = new Set<string>();
        if (ide?.active_file?.path) { liveFilePaths.add(ide.active_file.path); }
        for (const f of ide?.open_files ?? []) {
          if (f?.path) { liveFilePaths.add(f.path); }
        }
        const recall = this.fileDigests.formatRecallSections(workspaceId, liveFilePaths);
        sections.push(...recall);
      }
    } catch { /* digest layer must never break optimization */ }

    try {
      if (this.federation) {
        const peerMatches = this.federation.searchPeers(rawPrompt);
        sections.push(...CrossWorkspaceFederation.formatPeerSections(peerMatches));
      }
    } catch { /* peer search must never break optimization */ }

    return sections;
  }

  private async lookupCache(
    snapshot: string,
    workspaceId: string,
    mode: ProcessingMode,
  ): Promise<CacheQueryResult | null> {
    try {
      const lookup = this.cacheManager.checkCache(snapshot, workspaceId);
      return mode === 'blocking' ? await lookup : await withTimeout(lookup, CACHE_TIMEOUT_MS, null);
    } catch (error) {
      console.error('[PromptProxyEngine] Cache lookup error:', error);
      return null;
    }
  }

  private async searchCacheCandidates(
    snapshot: string,
    workspaceId: string,
    mode: ProcessingMode,
  ): Promise<PromptCacheCandidate[]> {
    try {
      const search = this.cacheManager.searchSimilarPrompts(snapshot, MAX_CACHE_CANDIDATES, workspaceId);
      const matches = mode === 'blocking' ? await search : await withTimeout(search, CACHE_TIMEOUT_MS, []);
      return matches.map((match) => ({
        raw_prompt: match.rawPrompt,
        confidence: match.confidence,
        timestamp: match.timestamp,
      }));
    } catch (error) {
      console.error('[PromptProxyEngine] Cache search error:', error);
      return [];
    }
  }

  private persistCacheEntry(
    snapshot: string,
    optimizedPrompt: string,
    workspaceId: string,
    mode: ProcessingMode,
  ): void {
    if (mode === 'blocking') {
      void this.cacheManager.writeToCache(snapshot, optimizedPrompt, workspaceId);
      return;
    }
    this.cacheManager.writeToCache(snapshot, optimizedPrompt, workspaceId).catch((error) => {
      console.error('[PromptProxyEngine] Async background write error:', error);
    });
  }
}

/**
 * Frame the optimized prompt with the detected SDLC role + quality checklist.
 *
 * The role preface is prepended and the checklist is appended; if the prompt
 * already starts with a `# Role` block (e.g. served from cache) we replace it
 * so the framing always reflects the current mode.  Returns the prompt
 * unchanged when no mode was detected.
 */
function applySdlcMode(
  prompt: string,
  mode: SdlcModeDescriptor | null,
): string {
  if (!mode) { return prompt; }
  const withoutOldRole = prompt.replace(
    /^# Role[^\n]*\n[\s\S]*?(?=\n\n#|\s*$)/,
    '',
  ).trimStart();
  const withoutOldChecklist = withoutOldRole.replace(
    /(?:\n\n)?# Quality checklist\n[\s\S]*?(?=\n\n#|\s*$)/,
    '',
  ).trimEnd();
  return [
    renderRoleSection(mode),
    withoutOldChecklist,
    renderChecklistSection(mode),
  ].filter((s) => s.trim() !== '').join('\n\n');
}
