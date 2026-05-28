import { encode } from 'gpt-tokenizer';

import type {
  PromptOptimizationAnalysis,
  PromptPricingConfig,
} from '../contracts.js';
import {
  DEFAULT_INPUT_COST_PER_1K,
  DEFAULT_OUTPUT_COST_PER_1K,
} from './constants.js';
import type { ResolvedPromptPricingConfig } from './types.js';

export function resolvePricing(
  pricing?: PromptPricingConfig,
  fallback?: ResolvedPromptPricingConfig,
): ResolvedPromptPricingConfig {
  return {
    input_cost_per_1k_tokens:
      pricing?.input_cost_per_1k_tokens
      ?? fallback?.input_cost_per_1k_tokens
      ?? DEFAULT_INPUT_COST_PER_1K,
    output_cost_per_1k_tokens:
      pricing?.output_cost_per_1k_tokens
      ?? fallback?.output_cost_per_1k_tokens
      ?? DEFAULT_OUTPUT_COST_PER_1K,
  };
}

export function calculateCostBreakdown(
  optimizedInputTokens: number,
  estimatedOutputTokens: number,
  pricing: ResolvedPromptPricingConfig,
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

export function countTokens(text: string): number {
  try {
    return encode(text).length;
  } catch {
    return Math.ceil(text.length / 4);
  }
}

export function predictOutputTokens(
  prompt: string,
  selectedFileCount: number,
  selectedLogCount: number,
): number {
  const normalizedPrompt = prompt.toLowerCase();
  let estimate = 110 + Math.round(Math.min(260, countTokens(prompt) * 0.34));

  if (/(fix|bug|repair|issue|resolve|crash)/.test(normalizedPrompt)) { estimate += 80; }
  if (/(refactor|optimize|rewrite|restructure|feature|implement|build)/.test(normalizedPrompt)) { estimate += 170; }
  if (/(test|unit test|pytest|mocha|jest)/.test(normalizedPrompt)) { estimate += 110; }
  if (/(explain|documentation|docstring|describe|readme)/.test(normalizedPrompt)) { estimate += 50; }
  if (/```/.test(prompt)) { estimate += 35; }
  if (/#\s+[^\n]+\.(ts|tsx|js|jsx|py|java|kt|json|xml|md)/i.test(prompt)) { estimate += 25; }

  estimate += Math.min(180, selectedFileCount * 45);
  estimate += Math.min(120, selectedLogCount * 30);

  if (/(json|yaml|markdown|bullet|table)/.test(normalizedPrompt)) { estimate -= 20; }

  return Math.max(120, Math.min(1400, estimate));
}
