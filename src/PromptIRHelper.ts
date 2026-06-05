/**
 * Barrel re-export — preserves the historical import path while the
 * implementation lives in focused modules under ./promptIR/.
 */
export { parseToPromptIR } from './promptIR/parser.js';
export { lintPrompt } from './promptIR/linter.js';
export { compilePromptIR, explainRewrite } from './promptIR/compiler.js';
