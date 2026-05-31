import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Local on-device prompt rewriter.
 *
 * Loads a quantized seq2seq model from <extensionPath>/models via
 * @xenova/transformers (ONNX Runtime Web under the hood). Prefers the
 * Phase 2 distilled model when present, falls back to the Phase 1
 * Flan-T5-Small bundle. Runs fully offline.
 */

const DISTILLED_DIR = 'distilled-rewriter';
const FALLBACK_DIR = 'flan-t5-small-q4';

const INSTRUCTION =
  'Rewrite this prompt to be clearer, more specific, and structured ' +
  'with explicit constraints:\n\n';

const MAX_INPUT_CHARS = 8000;

interface GeneratedItem { generated_text: string }
type Generator = (input: string, options?: Record<string, unknown>) => Promise<GeneratedItem[]>;

let cached: Generator | null = null;

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
  pipeline: (task: string, model: string, opts?: Record<string, unknown>) => Promise<Generator>;
  env: Record<string, unknown>;
}> {
  // Dynamic require so the extension still compiles / loads when the
  // optional ML dependency is not installed (e.g. fast dev iterations).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require('@xenova/transformers') as {
    pipeline: (task: string, model: string, opts?: Record<string, unknown>) => Promise<Generator>;
    env: Record<string, unknown>;
  };
  return mod;
}

async function getOptimizer(ctx: vscode.ExtensionContext): Promise<Generator> {
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

  cached = await pipeline('text2text-generation', picked.id, { quantized: true });
  return cached;
}

/** Run the local model on a single prompt and return the rewrite. */
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
      'No local model is bundled. Run `npm run distill` to build the distilled model ' +
      'or ship the Flan-T5-Small fallback under models/flan-t5-small-q4.',
    );
  }

  const model = await getOptimizer(ctx);
  const out = await model(INSTRUCTION + trimmed, {
    max_new_tokens: 256,
    temperature: 0.3,
    repetition_penalty: 1.1,
  });

  const text = out?.[0]?.generated_text?.trim() ?? '';
  return text === '' ? trimmed : text;
}

/** Drop the cached pipeline so the next call reloads weights. */
export function resetLocalOptimizer(): void {
  cached = null;
}
