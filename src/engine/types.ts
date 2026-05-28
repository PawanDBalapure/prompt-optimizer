/** Internal engine interfaces shared across helper modules. */
import type {
  IdeContextFile,
  IdeContextLog,
  PromptOptimizationAnalysis,
} from '../contracts.js';

export interface ResolvedPromptPricingConfig {
  input_cost_per_1k_tokens: number;
  output_cost_per_1k_tokens: number;
}

export interface TextSegment {
  content: string;
  is_code: boolean;
}

export interface RelevantContextPack {
  files: IdeContextFile[];
  logs: IdeContextLog[];
  sections: string[];
  insight: PromptOptimizationAnalysis['context'];
}
