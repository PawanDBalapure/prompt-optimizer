import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Local on-device prompt compressor.
 *
 * Loads the INT4-quantized LLMLingua-2 BERT-Base model from
 * <extensionPath>/models via @xenova/transformers (ONNX Runtime Web).
 * Prefers the Phase 2 distilled model when present, falls back to the
 * Phase 1 LLMLingua-2 bundle. Runs fully offline.
 *
 * LLMLingua-2 performs prompt compression through BERT-based token
 * classification: each token is scored for relevance and tokens below
 * the keep threshold are dropped, reducing size while preserving context.
 */

const DISTILLED_DIR = 'distilled-rewriter';
const FALLBACK_DIR = 'llmlingua-2-bert-q4';

/** Fraction of tokens to retain during compression (0 < ratio ≤ 1). */
const COMPRESSION_RATIO = 0.5;

const MAX_INPUT_CHARS = 8000;

interface TokenResult {
  entity: string;  // 'LABEL_0' = discard, 'LABEL_1' = keep
  score: number;
  index: number;
  word: string;
  start: number;
  end: number;
}
type TokenClassifier = (input: string, options?: Record<string, unknown>) => Promise<TokenResult[]>;

let cached: TokenClassifier | null = null;

function pickModelDir(extensionPath: string): { id: string; absolute: string } {
  const distilled = path.join(extensionPath, 'models', DISTILLED_DIR);
  if (fs.existsSync(path.join(distilled, 'config.json'))) {
    return { id: DISTILLED_DIR, absolute: distilled };
  }
  return {
    id: FALLBACK_DIR,
    absolute: path.join(extensionPath, 'models', FALLBACK_DIR),
  };
}

/** Returns the active local model id (distilled or fallback). */
export function getActiveModelId(ctx: vscode.ExtensionContext): string {
  return pickModelDir(ctx.extensionPath).id;
}

/** True iff a usable bundled model is present on disk. */
export function isLocalModelAvailable(ctx: vscode.ExtensionContext): boolean {
  const picked = pickModelDir(ctx.extensionPath);
  return fs.existsSync(path.join(picked.absolute, 'config.json'));
}

async function loadTransformers(): Promise<{
  pipeline: (task: string, model: string, opts?: Record<string, unknown>) => Promise<TokenClassifier>;
  env: Record<string, unknown>;
}> {
  // Dynamic require so the extension still compiles / loads when the
  // optional ML dependency is not installed (e.g. fast dev iterations).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require('@xenova/transformers') as {
    pipeline: (task: string, model: string, opts?: Record<string, unknown>) => Promise<TokenClassifier>;
    env: Record<string, unknown>;
  };
  return mod;
}

async function getOptimizer(ctx: vscode.ExtensionContext): Promise<TokenClassifier> {
  if (cached) { return cached; }

  const { pipeline, env } = await loadTransformers();
  const picked = pickModelDir(ctx.extensionPath);

  // Lock the runtime to bundled artifacts: no network, no cache writes.
  env.localModelPath = path.join(ctx.extensionPath, 'models');
  env.allowRemoteModels = false;
  env.allowLocalModels = true;

  const wasmDir = path.join(
    ctx.extensionPath,
    'node_modules',
    'onnxruntime-web',
    'dist',
  );
  if (fs.existsSync(wasmDir)) {
    const backends = (env.backends ?? {}) as Record<string, Record<string, Record<string, unknown>>>;
    const onnx = backends.onnx ?? (backends.onnx = {});
    const wasm = onnx.wasm ?? (onnx.wasm = {});
    wasm.wasmPaths = wasmDir + path.sep;
    wasm.numThreads = 1;
    env.backends = backends;
  }

  // LLMLingua-2 is a token-classification model (BERT-Base INT4).
  cached = await pipeline('token-classification', picked.id, { quantized: true });
  return cached;
}

/**
 * Reconstruct a compressed string from a filtered list of BERT tokens.
 * Handles BERT wordpiece subword tokens (those prefixed with '##').
 */
function reconstructFromTokens(tokens: TokenResult[]): string {
  let result = '';
  for (const t of tokens) {
    const word = t.word ?? '';
    if (word.startsWith('##')) {
      result += word.slice(2);
    } else {
      result += (result ? ' ' : '') + word;
    }
  }
  return result.trim();
}

/** Run LLMLingua-2 on a prompt and return the compressed version. */
export async function optimizeLocally(
  ctx: vscode.ExtensionContext,
  prompt: string,
): Promise<string> {
  const trimmed = (prompt ?? '').trim();
  if (trimmed === '') { throw new Error('Prompt is empty.'); }
  if (trimmed.length > MAX_INPUT_CHARS) {
    throw new Error(`Prompt too long for local model (max ${MAX_INPUT_CHARS} chars).`);
  }
  if (!isLocalModelAvailable(ctx)) {
    throw new Error(
      'No local model is bundled. Run `npm run fetch-model` to download the ' +
      'LLMLingua-2 BERT-Base INT4 fallback under models/llmlingua-2-bert-q4, ' +
      'or run `npm run distill` to build a custom distilled model.',
    );
  }

  const model = await getOptimizer(ctx);
  // aggregation_strategy: 'none' keeps per-subword-token scores for accurate reconstruction.
  const tokens = await model(trimmed, { aggregation_strategy: 'none' });

  // LABEL_1 = keep, LABEL_0 = discard.
  // Sort by score descending and retain the top COMPRESSION_RATIO fraction.
  const keepCount = Math.max(1, Math.ceil(tokens.length * COMPRESSION_RATIO));
  const byScore = [...tokens].sort((a, b) => b.score - a.score).slice(0, keepCount);
  // Re-order by original index to preserve sentence structure.
  byScore.sort((a, b) => a.index - b.index);

  const compressed = reconstructFromTokens(byScore);
  return compressed === '' ? trimmed : compressed;
}

/** Drop the cached pipeline so the next call reloads weights. */
export function resetLocalOptimizer(): void {
  cached = null;
}

