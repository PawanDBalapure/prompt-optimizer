export type ProcessingMode = 'blocking' | 'non-blocking';

export interface PromptPricingConfig {
  input_cost_per_1k_tokens?: number;
  output_cost_per_1k_tokens?: number;
}

export interface PromptProxyEngineOptions {
  db_path?: string;
  pricing?: PromptPricingConfig;
}

// IDE context input shapes live in a focused module; imported for local use
// and re-exported so the historical `from './contracts.js'` path keeps working.
import type { IdeContextFile, IdeContextLog, PromptIDEContext } from './contracts.ide.js';
export type { IdeContextFile, IdeContextLog, PromptIDEContext };

export interface PromptDiagnostic {
  severity: 'warning' | 'error' | 'info';
  message: string;
  code: string;
  fix_suggestion?: string;
}

/**
 * Deterministic, compiler-style view of a prompt.  Produced by the prompt
 * compiler pipeline (Intent → Requirements → Rules → Exclusions → Output →
 * Success Criteria) and rendered into the fixed `[CONTEXT]…[SUCCESS CRITERIA]`
 * schema.  Subjective adjectives are converted to measurable requirements and
 * soft preferences are hardened into rules, so the resulting prompt is cheaper
 * and more deterministic to run.
 */
export interface PromptCompilerSpec {
  intent: { task: string; domain: string; output: string };
  /** Noise-stripped, canonical statement of what the user is asking for. */
  input: string;
  /** Measurable, objective requirements (adjectives resolved to metrics). */
  requirements: string[];
  /** Hard constraints (preferences hardened into MUST/ALWAYS directives). */
  rules: string[];
  /** Things that must not happen / must be absent from the output. */
  exclusions: string[];
  /** Exact structure the answer must take. */
  output_format: string;
  /** Measurable conditions that define task completion. */
  success_criteria: string[];
  /** Task family, carried through so the renderer can pick output discipline. */
  task_kind?: 'coding' | 'debugging' | 'research' | 'spec-writing' | 'general';
}

export interface PromptIR {
  role?: string;
  constraints: string[];
  examples: string[];
  output_schema?: string;
  reasoning_policy?: string;
  inferred_task_type?: 'coding' | 'debugging' | 'research' | 'spec-writing' | 'general';
  /** Compiler-style structured spec; populated by parseToPromptIR. */
  compiler_spec?: PromptCompilerSpec;
}

export interface PromptOptimizationRequest {
  raw_prompt: string;
  mode?: ProcessingMode;
  ide_context?: PromptIDEContext;
  pricing?: PromptPricingConfig;
  workspace_id?: string;
  target_model?: 'claude' | 'gpt' | 'gemini' | 'deepseek' | 'grok' | 'local';
  /**
   * Optional caller-supplied correlation ID that the engine will echo back
   * on the response.  Must be 32 hex characters; if omitted (or invalid)
   * the engine assigns its own.
   */
  correlation_id?: string;
  /**
   * Enable partial (segment-level) cache reuse: recurring context blocks that
   * were already sent for this workspace are replaced with a compact cache
   * reference instead of being resent.  Defaults to enabled.
   */
  reuse_cached_segments?: boolean;
  /**
   * Set by bulk workspace-harvest passes (e.g. the panel's Refresh button).
   * When true the knowledge graph records only bounded structural nodes
   * (frameworks/languages/files) under a single stable seed node and skips
   * the per-prompt + per-concept nodes, so repeated refreshes do not grow the
   * graph node count unboundedly.
   */
  seeding?: boolean;
  /**
   * Output density for the structured YAML prompt.
   *   'rich' (default) — context + measurable constraints + output discipline.
   *   'lean'           — task line + a single combined discipline constraint,
   *                      dropping the context line and metric expansions for
   *                      maximum raw-vs-output token savings.
   * Falls back to the PROMPT_OPT_DENSITY env var when omitted.
   */
  density?: 'rich' | 'lean';
}

export interface PromptCacheCandidate {
  raw_prompt: string;
  confidence: number;
  timestamp: number;
}

/**
 * Exact line ranges (0-based, inclusive) the optimizer treated as relevant in
 * a context file. Lets callers re-select the precise text the engine packed,
 * even though that text is not inlined into the optimized prompt.
 */
export interface ContextSnippet {
  path: string;
  ranges: Array<{ start_line: number; end_line: number }>;
}

export interface DeterministicRoutingDecision {
  status: 'resolved' | 'ambiguous' | 'unresolved';
  strategy: 'path-symbol' | 'workspace-scan' | 'semantic-fallback' | 'active-file-fallback' | 'none';
  reason: string;
}

export interface ReusedCacheSegment {
  /** Section header / file path of the block reused from cache. */
  label: string;
  /** Stable reference id embedded in the optimized prompt. */
  ref: string;
  /** Tokens saved by referencing the block instead of resending it. */
  tokens_saved: number;
  /** Number of times this exact block has been reused from cache. */
  hit_count: number;
  /** First time this block was seen (epoch ms). */
  first_seen: number;
}

export interface PromptOptimizationAnalysis {
  cache: {
    status: 'exact' | 'semantic' | 'miss';
    confidence: number;
    candidates: PromptCacheCandidate[];
    /** Context blocks served from cache instead of resent this turn. */
    reused_segments?: ReusedCacheSegment[];
    /** Total tokens saved by partial (segment-level) cache reuse. */
    reused_tokens_saved?: number;
  };
  context: {
    workspace_root?: string;
    active_file?: string;
    selected_files: string[];
    selected_logs: string[];
    log_sources: string[];
    open_file_count: number;
    total_log_count: number;
    /** Exact line ranges per selected file the optimizer found relevant. */
    context_snippets?: ContextSnippet[];
    /** Deterministic routing outcome for file selection. */
    deterministic_routing?: DeterministicRoutingDecision;
  };
  cost: {
    input_cost_usd: number;
    output_cost_usd: number;
    total_cost_usd: number;
    input_cost_per_1k_tokens: number;
    output_cost_per_1k_tokens: number;
  };
}

export interface PromptOptimizationResponse {
  metrics: {
    raw_input_tokens: number;
    optimized_input_tokens: number;
    tokens_saved: number;
    estimated_output_tokens: number;
    estimated_cost_usd: number;
  };
  optimized_prompt: string;
  improvements: string[];
  analysis: PromptOptimizationAnalysis;
  diagnostics?: PromptDiagnostic[];
  structured_ir?: PromptIR;
  explanation?: string;
  /** SDLC mode detected from slash command or intent words, if any. */
  sdlc_mode?: {
    id: string;
    label: string;
    trigger: string | null;
    read_only: boolean;
  };
  /**
   * Per-call correlation ID (32 hex chars).  Echoes back the request's
   * `correlation_id` if it was valid; otherwise this is a freshly-minted
   * ID for log/audit join.
   */
  request_id?: string;
}

export type ProcessPromptResponse = PromptOptimizationResponse;

export interface CacheStatsResponse {
  total_entries: number;
  avg_confidence: number;
  total_hits: number;
  oldest_entry_ms: number;
  newest_entry_ms: number;
  pruned?: number;
}