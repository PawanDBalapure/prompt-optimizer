/** Core type definitions shared across modules. */

export type ProxyMode = 'agent' | 'optimize' | 'direct';
export type PromptSource = 'panel' | 'chat' | 'clipboard';
export type TargetModel = 'claude' | 'gpt' | 'gemini' | 'deepseek' | 'grok' | 'local';
/** Output density for the structured YAML prompt. */
export type PromptDensity = 'rich' | 'lean';

export type SecretPatternMatchMode =
  | 'regex'
  | 'like'
  | 'contains'
  | 'startsWith'
  | 'endsWith'
  | 'exact';

export interface CustomSecretPatternConfig {
  label?: string;
  pattern: string;
  matchMode?: SecretPatternMatchMode;
}

export interface SecretMatch {
  label: string;
  matched?: string;
}

export interface ConversationTurn {
  id: string;
  timestamp: number;
  user_raw: string;
  user_optimized: string;
  assistant: string;
  workspace_id: string;
}

export interface PromptProxyMetrics {
  raw_input_tokens: number;
  optimized_input_tokens: number;
  tokens_saved: number;
  estimated_output_tokens: number;
  estimated_cost_usd: number;
}

export interface PromptProxyAnalysis {
  cache: {
    status: 'exact' | 'semantic' | 'miss';
    confidence: number;
    candidates: Array<{
      raw_prompt: string;
      confidence: number;
      timestamp: number;
    }>;
    reused_segments?: Array<{
      label: string;
      ref: string;
      tokens_saved: number;
      hit_count: number;
      first_seen: number;
    }>;
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
    context_snippets?: Array<{
      path: string;
      ranges: Array<{ start_line: number; end_line: number }>;
    }>;
  };
  cost: {
    input_cost_usd: number;
    output_cost_usd: number;
    total_cost_usd: number;
    input_cost_per_1k_tokens: number;
    output_cost_per_1k_tokens: number;
  };
}

export interface PromptProxyResponse {
  metrics: PromptProxyMetrics;
  optimized_prompt: string;
  improvements: string[];
  analysis: PromptProxyAnalysis;
  diagnostics?: unknown[];
}

export interface SessionBufferedPrompt {
  prompt: string;
  optimized_prompt: string;
  timestamp: number;
  source: PromptSource;
  estimated_cost_usd: number;
  tokens_saved: number;
  cache_status: PromptProxyAnalysis['cache']['status'];
}

export interface PromptProxyPanelState {
  original: string;
  optimized: string;
  source: PromptSource;
  generated_at: number;
  metrics: PromptProxyMetrics;
  improvements: string[];
  analysis: PromptProxyAnalysis;
  warnings?: string[];
  diagnostics?: unknown[];
  secretDetectionEnabled?: boolean;
  secretMatches?: Array<{ label: string; matched: string }>;
}

export interface RuntimeSnapshot {
  active_file?: string;
  open_file_count: number;
  log_sources: string[];
  chat_history_turns: number;
  session_buffer: SessionBufferedPrompt[];
  last_analysis?: PromptProxyPanelState;
}
