export type ProcessingMode = 'blocking' | 'non-blocking';

export interface PromptPricingConfig {
  input_cost_per_1k_tokens?: number;
  output_cost_per_1k_tokens?: number;
}

export interface PromptProxyEngineOptions {
  db_path?: string;
  pricing?: PromptPricingConfig;
}

export interface IdeContextFile {
  path: string;
  content: string;
  language?: string;
  is_active?: boolean;
  selection?: string;
}

export interface IdeContextLog {
  source: string;
  content: string;
  kind?: 'terminal' | 'debug' | 'problems' | 'general';
}

export interface PromptIDEContext {
  workspace_root?: string;
  active_file?: IdeContextFile;
  open_files?: IdeContextFile[];
  logs?: IdeContextLog[];
}

export interface PromptOptimizationRequest {
  raw_prompt: string;
  mode?: ProcessingMode;
  ide_context?: PromptIDEContext;
  pricing?: PromptPricingConfig;
  workspace_id?: string;
}

export interface PromptCacheCandidate {
  raw_prompt: string;
  confidence: number;
  timestamp: number;
}

export interface PromptOptimizationAnalysis {
  cache: {
    status: 'exact' | 'semantic' | 'miss';
    confidence: number;
    candidates: PromptCacheCandidate[];
  };
  context: {
    workspace_root?: string;
    active_file?: string;
    selected_files: string[];
    selected_logs: string[];
    log_sources: string[];
    open_file_count: number;
    total_log_count: number;
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