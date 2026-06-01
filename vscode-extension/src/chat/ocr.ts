import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Lightweight OCR helper backed by tesseract.js (English, LSTM, fully offline).
 * The trained-data file is bundled with the extension so no network access
 * is required at runtime.
 *
 * Workers are expensive to create; we cache one per extension session and
 * lazy-init on the first request.
 */

interface OcrWorker {
  recognize(image: Buffer | string): Promise<{ data: { text: string } }>;
  terminate(): Promise<void>;
}

let cachedWorker: Promise<OcrWorker | null> | null = null;

function tesseractRoots(context: vscode.ExtensionContext): {
  langPath: string;
  corePath: string;
} {
  const ext = context.extensionPath;
  return {
    langPath: path.join(ext, 'models', 'tesseract'),
    corePath: path.join(ext, 'node_modules', 'tesseract.js-core'),
  };
}

async function getWorker(context: vscode.ExtensionContext): Promise<OcrWorker | null> {
  if (cachedWorker) { return cachedWorker; }
  cachedWorker = (async () => {
    try {
      // Dynamic require so a missing dep / model file degrades gracefully
      // instead of crashing extension activation.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const tess = require('tesseract.js') as {
        createWorker: (
          lang: string,
          oem?: number,
          opts?: Record<string, unknown>,
        ) => Promise<OcrWorker>;
      };
      const { langPath, corePath } = tesseractRoots(context);
      if (!fs.existsSync(path.join(langPath, 'eng.traineddata'))) {
        return null;
      }
      const worker = await tess.createWorker('eng', 1, {
        langPath,
        corePath,
        // Silence chatty logger; the extension runs in the LM host.
        logger: () => undefined,
        gzip: false,
      });
      return worker;
    } catch (err) {
      console.warn('[prompt-optimizer] OCR worker init failed:', err);
      return null;
    }
  })();
  return cachedWorker;
}

/**
 * Run OCR on an image buffer. Returns the extracted text or null on failure.
 */
export async function ocrImage(
  context: vscode.ExtensionContext,
  image: Buffer,
): Promise<string | null> {
  const worker = await getWorker(context);
  if (!worker) { return null; }
  try {
    const result = await worker.recognize(image);
    const text = result?.data?.text?.trim() ?? '';
    return text.length > 0 ? text : null;
  } catch (err) {
    console.warn('[prompt-optimizer] OCR recognize failed:', err);
    return null;
  }
}

/**
 * Best-effort tear-down on extension deactivation.
 */
export async function disposeOcr(): Promise<void> {
  if (!cachedWorker) { return; }
  try {
    const w = await cachedWorker;
    await w?.terminate();
  } catch { /* ignore */ }
  cachedWorker = null;
}

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.bmp', '.webp', '.gif', '.tiff', '.tif']);

function isImageUri(uri: vscode.Uri): boolean {
  return IMAGE_EXTS.has(path.extname(uri.fsPath || uri.path).toLowerCase());
}

/**
 * Walk a chat request's references, OCR every image attachment, and return
 * the combined extracted text. Empty string when there are no images or all
 * recognitions failed.
 */
export async function ocrChatReferences(
  context: vscode.ExtensionContext,
  request: vscode.ChatRequest,
): Promise<string> {
  const refs = request.references || [];
  if (refs.length === 0) { return ''; }

  const blocks: string[] = [];
  for (const ref of refs) {
    const value = (ref as { value?: unknown }).value;
    let buffer: Buffer | null = null;
    let label = (ref as { name?: string }).name || 'image';

    try {
      // Form 1: file URI on disk.
      if (value instanceof vscode.Uri && isImageUri(value)) {
        const data = await vscode.workspace.fs.readFile(value);
        buffer = Buffer.from(data);
        label = path.basename(value.fsPath || value.path);
      }
      // Form 2: ChatReferenceBinaryData (mime starts with image/).
      else if (
        value &&
        typeof value === 'object' &&
        'mimeType' in value &&
        typeof (value as { mimeType: unknown }).mimeType === 'string' &&
        ((value as { mimeType: string }).mimeType).startsWith('image/') &&
        'data' in value &&
        typeof (value as { data: unknown }).data === 'function'
      ) {
        const arr = await (value as { data: () => Thenable<Uint8Array> }).data();
        buffer = Buffer.from(arr);
      }
      // Form 3: { uri, range } shape used for editor selections — skip.
    } catch (err) {
      console.warn('[prompt-optimizer] failed reading image reference:', err);
      continue;
    }

    if (!buffer) { continue; }

    const text = await ocrImage(context, buffer);
    if (text) {
      blocks.push(`--- OCR text from ${label} ---\n${text}`);
    }
  }

  return blocks.join('\n\n');
}
