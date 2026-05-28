import type { CacheQueryResult } from '../SemanticCacheManager.js';
import type {
  PromptCacheCandidate,
  PromptOptimizationAnalysis,
  PromptOptimizationResponse,
} from '../contracts.js';
import type { ResolvedPromptPricingConfig } from './types.js';

export function buildCacheInsight(
  cacheStatus: 'exact' | 'semantic' | 'miss',
  cacheResult: CacheQueryResult | null,
  cacheCandidates: PromptCacheCandidate[],
): PromptOptimizationAnalysis['cache'] {
  return {
    status: cacheStatus,
    confidence: cacheStatus === 'exact' ? 1 : (cacheResult?.confidence ?? 0),
    candidates: cacheCandidates,
  };
}

export function createEmptyResponse(
  pricing: ResolvedPromptPricingConfig,
): PromptOptimizationResponse {
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
      cache: { status: 'miss', confidence: 0, candidates: [] },
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
