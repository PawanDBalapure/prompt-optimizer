import { SemanticCacheManager, CacheQueryResult } from './SemanticCacheManager.js';
import type {
  PromptCacheCandidate,
  ProcessPromptResponse,
  ProcessingMode,
  PromptIDEContext,
  PromptOptimizationRequest,
  PromptOptimizationResponse,
  PromptProxyEngineOptions,
  ReusedCacheSegment,
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
import { SegmentReuseStore } from './engine/segmentCache.js';
import type { ResolvedPromptPricingConfig } from './engine/types.js';
import { hashPromptKey, withTimeout } from './engine/utils.js';
import { reportEngineError } from './engine/logger.js';
import { newRequestId, isRequestId } from './engine/requestId.js';
import { AugmentBreaker } from './engine/circuitBreaker.js';
import {
  loadEngineConfig,
  pickAugmentRps,
  pickBreakerThreshold,
  pickBreakerCooldown,
  type ResolvedEngineConfig,
} from './engine/config.js';
import { KnowledgeGraph } from './engine/knowledgeGraph.js';
import { FileDigestStore } from './engine/fileDigest.js';
import {
  formatMemorySections,
  readWorkspaceMemory,
  persistMemorySnapshot,
} from './engine/workspaceMemory.js';
import { CrossWorkspaceFederation } from './engine/crossWorkspace.js';
import { ensureGlobalPeer } from './engine/globalMemory.js';
import { MaintenanceService } from './engine/maintenance.js';
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
  private maintenanceService: MaintenanceService | null = null;
  private readonly engineConfig: ResolvedEngineConfig;
  private readonly augmentBreaker: AugmentBreaker;

  constructor(options?: string | PromptProxyEngineOptions) {
    const dbPath = typeof options === 'string' ? options : options?.db_path;
    this.cacheManager = new SemanticCacheManager(dbPath);
    this.defaultPricing = resolvePricing(typeof options === 'string' ? undefined : options?.pricing);
    // Config is loaded once at construction; ops can hot-restart the host
    // process to pick up new values — cheap given how short engine startup is.
    this.engineConfig = loadEngineConfig(
      typeof options === 'string' ? undefined : options?.db_path ? undefined : undefined,
    );
    this.augmentBreaker = new AugmentBreaker({
      ratePerSec: pickAugmentRps(this.engineConfig),
      failureThreshold: pickBreakerThreshold(this.engineConfig),
      cooldownMs: pickBreakerCooldown(this.engineConfig),
    });
  }

  public async initialize(): Promise<void> {
    await this.cacheManager.initialize();
    const db = this.cacheManager.rawDatabase();
    if (db) {
      this.knowledgeGraph = new KnowledgeGraph(db);
      this.federation = new CrossWorkspaceFederation(db);
      this.fileDigests = new FileDigestStore(db);
      this.maintenanceService = new MaintenanceService(db);
      // Auto-register the user-global memory DB so workspace recall is
      // automatically federated against the user's L1 memory tier.
      try { ensureGlobalPeer(this.federation, this.cacheManager.databasePath()); }
      catch (err) {
        reportEngineError('augment_global_peer', err, {
          metrics: this.cacheManager.metrics(),
          level: 'warn',
        });
      }
    }
  }

  /** Public accessor for the per-file digest store (used by CLI / extension). */
  public getFileDigestStore(): FileDigestStore | null {
    return this.fileDigests;
  }

  /** Public accessor for the maintenance service (used by CLI --db-prune). */
  public getMaintenanceService(): MaintenanceService | null {
    return this.maintenanceService;
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
    const requestId = isRequestId(request.correlation_id) ? request.correlation_id : newRequestId();
    const originalRaw = request.raw_prompt?.trim() ?? '';
    const pricing = resolvePricing(request.pricing, this.defaultPricing);
    if (originalRaw === '') {
      return { ...createEmptyResponse(pricing), request_id: requestId };
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
      requestId,
    );

    const cacheStatus = cacheResult?.matchType ?? 'miss';
    const shouldReuseCached =
      cacheStatus === 'exact'
      && cacheResult !== null
      && !containsLegacyExampleSection(cacheResult.optimizedPrompt);

    // Per-request observability counters.
    const metrics = this.cacheManager.metrics();
    if (metrics) {
      metrics.increment('requests.total');
      if (cacheStatus === 'exact')   { metrics.increment('requests.cache_exact'); }
      if (cacheStatus === 'semantic'){ metrics.increment('requests.cache_semantic'); }
      if (cacheStatus === 'miss')    { metrics.increment('requests.cache_miss'); }
    }

    // Save prompt version regardless of cache hit so rollback always has data.
    const hashedKey = hashPromptKey(rawPrompt);
    this.cacheManager.recordVersion(hashedKey, rawPrompt, compiledRequest, targetModel, 'main', 0.0);

    // Partial (segment-level) cache reuse: collapse recurring context blocks
    // that were already sent for this workspace into compact cache references
    // instead of resending them.  Only applies on the build path — an exact
    // whole-prompt hit already returns the cached optimized prompt verbatim.
    const reuseEnabled =
      request.reuse_cached_segments !== false && process.env.PROMPT_OPT_SEGMENT_REUSE !== 'off';
    let reusedSegments: ReusedCacheSegment[] = [];
    let builtPrompt: string;
    if (shouldReuseCached) {
      builtPrompt = (cacheResult as CacheQueryResult).optimizedPrompt;
    } else {
      const segmentStore = new SegmentReuseStore(this.cacheManager.rawDatabase(), reuseEnabled);
      const reuse = segmentStore.applyReuse(workspaceId, [
        ...contextPack.sections,
        ...augmentedSections,
      ]);
      reusedSegments = reuse.reused;
      builtPrompt = buildOptimizedPrompt(compiledRequest, reuse.sections);
    }

    const optimizedPrompt = applySdlcMode(sanitizeOptimizedPrompt(builtPrompt), sdlcMode);

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
        ...(reusedSegments.length > 0
          ? [
              `Reused ${reusedSegments.length} context block${reusedSegments.length === 1 ? '' : 's'} ` +
                `from cache (~${reusedSegments.reduce((sum, seg) => sum + seg.tokens_saved, 0)} tokens saved); ` +
                'these are referenced in the optimized prompt instead of resent.',
            ]
          : []),
        ...diagnostics.map((d) => `[${d.code}]: ${d.message} (Suggestion: ${d.fix_suggestion})`),
        ...selectImprovementSuggestions(optimizedPrompt, request.ide_context),
      ].slice(0, MAX_IMPROVEMENTS),
      analysis: {
        cache: buildCacheInsight(cacheStatus, cacheResult, cacheCandidates, reusedSegments),
        context: contextPack.insight,
        cost: costInsight,
      },
      diagnostics,
      structured_ir: structuredIr,
      explanation,
      sdlc_mode: sdlcMode
        ? { id: sdlcMode.id, label: sdlcMode.label, trigger: sdlcMode.trigger, read_only: sdlcMode.readOnly }
        : undefined,
      request_id: requestId,
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
    requestId: string,
  ): string[] {
    const sections: string[] = [];
    const db = this.cacheManager.rawDatabase();
    const breaker = this.augmentBreaker;

    if (!breaker.shouldSkip('memory')) {
      try {
        const memory = readWorkspaceMemory(ide?.workspace_root, workspaceId);
        if (memory.entries.length > 0) {
          sections.push(...formatMemorySections(memory));
          if (db) { persistMemorySnapshot(db, memory); }
        }
        breaker.recordSuccess('memory');
      } catch (err) {
        breaker.recordFailure('memory');
        reportEngineError('augment_memory', err, {
          metrics: this.cacheManager.metrics(),
          level: 'warn',
          meta: { request_id: requestId },
        });
      }
    }

    if (!breaker.shouldSkip('kg')) {
      try {
        if (this.knowledgeGraph) {
          this.knowledgeGraph.recordWorkspaceGraph(workspaceId, rawPrompt, ide, stackInfo);
          const suggestions = this.knowledgeGraph.collectGraphContext(workspaceId, rawPrompt);
          for (const suggestion of suggestions) { sections.push(suggestion.text); }
        }
        breaker.recordSuccess('kg');
      } catch (err) {
        breaker.recordFailure('kg');
        reportEngineError('augment_kg', err, {
          metrics: this.cacheManager.metrics(),
          level: 'warn',
          meta: { request_id: requestId },
        });
      }
    }

    // Per-file digest: record what we have studied this turn, then surface
    // recall hints for files we have seen before but are NOT re-injecting in
    // full content this turn.  This is the cross-session "I remember this
    // file" signal that survives a new chat.
    if (!breaker.shouldSkip('digest')) {
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
        breaker.recordSuccess('digest');
      } catch (err) {
        breaker.recordFailure('digest');
        reportEngineError('augment_digest', err, {
          metrics: this.cacheManager.metrics(),
          level: 'warn',
          meta: { request_id: requestId },
        });
      }
    }

    if (!breaker.shouldSkip('peers')) {
      try {
        if (this.federation) {
          const peerMatches = this.federation.searchPeers(rawPrompt);
          sections.push(...CrossWorkspaceFederation.formatPeerSections(peerMatches));
        }
        breaker.recordSuccess('peers');
      } catch (err) {
        breaker.recordFailure('peers');
        reportEngineError('augment_peers', err, {
          metrics: this.cacheManager.metrics(),
          level: 'warn',
          meta: { request_id: requestId },
        });
      }
    }

    // Relevance gate: drop empty boilerplate outright and score discretionary
    // augmentations against the current prompt so only on-topic context is
    // appended.  Without this, memory/graph/digest/peer blocks leak in on
    // every turn purely by byte budget, causing context rot.
    const queryTerms = this.contextPacker.buildQueryTerms(rawPrompt);
    const relevant = selectRelevantAugmentedSections(sections, queryTerms, this.contextPacker);
    return enforceAugmentedBudget(relevant);
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
      reportEngineError('cache_lookup', error, { metrics: this.cacheManager.metrics() });
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
      reportEngineError('cache_search', error, { metrics: this.cacheManager.metrics() });
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
      reportEngineError('cache_write', error, { metrics: this.cacheManager.metrics() });
    });
  }
}

/**
 * Top-level byte ceiling for the combined augmented context (memory + KG +
 * digests + peer matches) that the engine prepends to every optimized
 * prompt.  Without this cap the per-turn cost would scale linearly with
 * the number of memory files, KG nodes, and federated peers.
 *
 * 18 KB \u2248 4.5 K tokens \u2014 generous for serious projects, well below the
 * point where it starts pushing the user's actual prompt out of context.
 * Overridable via `POMEMORY_MAX_AUGMENTED_BYTES` env var.
 */
const MAX_AUGMENTED_BYTES = (() => {
  const raw = process.env.POMEMORY_MAX_AUGMENTED_BYTES;
  if (!raw) { return 18_000; }
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1_024 ? n : 18_000;
})();

function enforceAugmentedBudget(sections: string[]): string[] {
  const out: string[] = [];
  let used = 0;
  for (const section of sections) {
    const cost = Buffer.byteLength(section, 'utf8') + 2;
    if (used + cost > MAX_AUGMENTED_BYTES) { break; }
    out.push(section);
    used += cost;
  }
  return out;
}

/**
 * Minimum relevance score a discretionary augmentation must reach to be kept.
 * Tunable via env so the budget/precision trade-off can be adjusted without a
 * rebuild.  User-curated durable memory (see CURATED_MEMORY_HEADER) bypasses
 * this gate, and empty/boilerplate sections are dropped regardless of score.
 */
const AUGMENT_RELEVANCE_THRESHOLD = (() => {
  const raw = process.env.POMEMORY_AUGMENT_RELEVANCE_MIN;
  if (!raw) { return 0.04; }
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0.04;
})();

/**
 * Sections sourced from user-curated durable instruction files are always
 * kept (when non-empty): they encode standing conventions that should apply
 * to every request, not just topically matching ones.
 */
const CURATED_MEMORY_HEADER =
  /^#\s+Workspace memory — (?:project memory|project knowledge|AGENTS\.md|CLAUDE)/i;

function augmentedSectionBody(section: string): string {
  const newlineIndex = section.indexOf('\n');
  return newlineIndex === -1 ? '' : section.slice(newlineIndex + 1);
}

/**
 * True when a section carries no usable signal: an empty body, a placeholder
 * marker such as "(no summary captured)", or a template skeleton whose lines
 * are only unfilled "Label:" headings (e.g. a generated memory.md stub with
 * bare "Stack:" / "Conventions:" lines).  These add tokens but no information.
 */
function isLowValueAugmentedSection(section: string): boolean {
  const meaningful = augmentedSectionBody(section)
    .split(/\r?\n/)
    .map((line) => line.replace(/^[#>\-*\s]+/, '').trim())
    .filter((line) => line !== '')
    .filter((line) => !/^[A-Za-z][\w ./-]{0,40}:\s*$/.test(line)) // unfilled "Label:"
    .filter((line) => !/^\(.*\)$/.test(line))                     // "(no summary captured)"
    .filter((line) => !/^todo\b/i.test(line));
  const compact = meaningful.join(' ').replace(/[^a-z0-9]/gi, '');
  return compact.length < 12;
}

/**
 * Keep only augmentation sections that earn their place in the prompt: drop
 * low-value boilerplate, always retain curated durable memory, and otherwise
 * require a minimum relevance to the current prompt's terms.
 */
function selectRelevantAugmentedSections(
  sections: string[],
  queryTerms: Set<string>,
  packer: ContextPacker,
): string[] {
  return sections.filter((section) => {
    if (isLowValueAugmentedSection(section)) { return false; }
    if (CURATED_MEMORY_HEADER.test(section)) { return true; }
    if (queryTerms.size === 0) { return true; }
    return packer.scoreTextRelevance(section, queryTerms) >= AUGMENT_RELEVANCE_THRESHOLD;
  });
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
