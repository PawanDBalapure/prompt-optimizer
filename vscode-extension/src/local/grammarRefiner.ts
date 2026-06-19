import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { pathToFileURL } from 'url';

/**
 * On-device grammar/spelling refiner.
 *
 * Loads a small seq2seq text-to-text model (e.g. FLAN-T5-small or a grammar-
 * tuned T5, INT8-quantized ONNX) via @xenova/transformers and uses it to
 * polish the grammar of already-optimized prompt text. Runs fully offline.
 *
 * This is a STRICTLY OPTIONAL enhancement layered on top of the deterministic
 * spelling/grammar corrector in the shared engine:
 *
 *   • The deterministic `SPELLING_CORRECTIONS` map remains the primary, always-
 *     on corrector and the guaranteed fallback.
 *   • The model is only consulted when its weights are bundled AND the
 *     `promptProxy.enableGrammarModel` setting is on.
 *   • Every line the model rewrites is validated by the shared engine's
 *     `preservesMeaning` guard, so a hallucinated or meaning-changing rewrite
 *     is discarded and the deterministic text is kept.
 */

const GRAMMAR_DIR = 'grammar-correction';
const MAX_INPUT_CHARS = 600;

/** Mirrors the engine's `SentenceRefiner` type without importing the ESM module. */
type SentenceRefiner = (sentence: string) => Promise<string>;

interface Generated {
  generated_text: string;
}
type Text2Text = (input: string, options?: Record<string, unknown>) => Promise<Generated[] | Generated>;

let cachedModel: Text2Text | null = null;
let cachedGuard: { refineTextPreservingMeaning: (text: string, refiner: SentenceRefiner) => Promise<string> } | null = null;

function grammarModelDir(extensionPath: string): string {
  return path.join(extensionPath, 'models', GRAMMAR_DIR);
}

/** True iff a usable grammar model is present on disk. */
export function isGrammarModelAvailable(ctx: vscode.ExtensionContext): boolean {
  return fs.existsSync(path.join(grammarModelDir(ctx.extensionPath), 'config.json'));
}

/** True iff the user has opted into model-based grammar refinement. */
export function isGrammarModelEnabled(): boolean {
  return vscode.workspace.getConfiguration('promptProxy').get<boolean>('enableGrammarModel') === true;
}

async function loadTransformers(): Promise<{
  pipeline: (task: string, model: string, opts?: Record<string, unknown>) => Promise<Text2Text>;
  env: Record<string, unknown>;
}> {
  // Dynamic require so the extension still loads when the optional ML
  // dependency is absent (e.g. fast dev iterations / minimal installs).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('@xenova/transformers') as {
    pipeline: (task: string, model: string, opts?: Record<string, unknown>) => Promise<Text2Text>;
    env: Record<string, unknown>;
  };
}

async function getModel(ctx: vscode.ExtensionContext): Promise<Text2Text> {
  if (cachedModel) { return cachedModel; }

  const { pipeline, env } = await loadTransformers();

  // Lock the runtime to bundled artifacts: no network, no cache writes.
  env.localModelPath = path.join(ctx.extensionPath, 'models');
  env.allowRemoteModels = false;
  env.allowLocalModels = true;

  const wasmDir = path.join(ctx.extensionPath, 'node_modules', 'onnxruntime-web', 'dist');
  if (fs.existsSync(wasmDir)) {
    const backends = (env.backends ?? {}) as Record<string, Record<string, Record<string, unknown>>>;
    const onnx = backends.onnx ?? (backends.onnx = {});
    const wasm = onnx.wasm ?? (onnx.wasm = {});
    wasm.wasmPaths = wasmDir + path.sep;
    wasm.numThreads = 1;
    env.backends = backends;
  }

  cachedModel = await pipeline('text2text-generation', GRAMMAR_DIR, { quantized: true });
  return cachedModel;
}

/**
 * Build a per-line refiner backed by the bundled model, or `null` when no model
 * is available / enabled. The refiner asks the model to fix grammar while
 * keeping meaning — but correctness is still enforced downstream by the
 * meaning-preservation guard, so a disobedient model cannot change semantics.
 */
export async function createGrammarRefiner(
  ctx: vscode.ExtensionContext,
): Promise<SentenceRefiner | null> {
  if (!isGrammarModelEnabled() || !isGrammarModelAvailable(ctx)) { return null; }

  let model: Text2Text;
  try {
    model = await getModel(ctx);
  } catch {
    return null;
  }

  return async (sentence: string): Promise<string> => {
    const trimmed = sentence.trim();
    if (trimmed === '' || trimmed.length > MAX_INPUT_CHARS) { return sentence; }
    const instruction =
      `Fix the grammar and spelling of the following text. Keep the wording and ` +
      `meaning identical; do not add or remove information:\n${trimmed}`;
    const raw = await model(instruction, {
      max_new_tokens: 160,
      num_beams: 1,
      do_sample: false,
    });
    const first = Array.isArray(raw) ? raw[0] : raw;
    return (first?.generated_text ?? sentence).trim();
  };
}

/**
 * Lazily dynamic-import the shared engine's meaning-preservation guard from the
 * synced ESM bundle. Uses a `Function`-wrapped `import()` so the CommonJS
 * extension build does not down-level it into a `require()` (which cannot load
 * ESM).
 */
async function loadGuard(
  ctx: vscode.ExtensionContext,
): Promise<{ refineTextPreservingMeaning: (text: string, refiner: SentenceRefiner) => Promise<string> } | null> {
  if (cachedGuard) { return cachedGuard; }
  const guardPath = path.join(ctx.extensionPath, 'engine', 'dist', 'engine', 'meaningGuard.js');
  if (!fs.existsSync(guardPath)) { return null; }
  const url = pathToFileURL(guardPath).href;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const dynamicImport = new Function('u', 'return import(u);') as (u: string) => Promise<unknown>;
  const mod = (await dynamicImport(url)) as {
    refineTextPreservingMeaning: (text: string, refiner: SentenceRefiner) => Promise<string>;
  };
  cachedGuard = mod;
  return mod;
}

/**
 * Polish the grammar of `text` with the on-device model, guaranteeing the
 * result means the same as the input. Returns `text` unchanged when the model
 * is unavailable/disabled, the guard cannot be loaded, or any error occurs —
 * the deterministic optimization is always a safe fallback.
 */
export async function refineOptimizedPrompt(
  ctx: vscode.ExtensionContext,
  text: string,
): Promise<string> {
  if (!text || text.trim() === '') { return text; }
  if (!isGrammarModelEnabled() || !isGrammarModelAvailable(ctx)) { return text; }

  try {
    const refiner = await createGrammarRefiner(ctx);
    if (!refiner) { return text; }
    const guard = await loadGuard(ctx);
    if (!guard) { return text; }
    return await guard.refineTextPreservingMeaning(text, refiner);
  } catch {
    return text;
  }
}

/** Drop the cached pipeline so the next call reloads weights. */
export function resetGrammarRefiner(): void {
  cachedModel = null;
}
