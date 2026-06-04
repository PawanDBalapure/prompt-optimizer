/** Shared engine constants — single source of truth for tuning knobs. */
export const DEFAULT_INPUT_COST_PER_1K = 0.0015;
export const DEFAULT_OUTPUT_COST_PER_1K = 0.002;
export const CACHE_TIMEOUT_MS = 150;
export const MAX_CONTEXT_FILES = 3;
export const MAX_CONTEXT_LOGS = 2;
export const MAX_FILE_LINES = 80;
/**
 * Files at or below this size carry little noise, so they are embedded whole.
 * Larger files are reduced to query-relevant snippets to keep the optimized
 * prompt slim instead of dumping the full file text.
 */
export const SMALL_FILE_LINES = 12;
export const MAX_LOG_LINES = 24;
export const MAX_IMPROVEMENTS = 2;
export const MAX_CACHE_CANDIDATES = 3;
