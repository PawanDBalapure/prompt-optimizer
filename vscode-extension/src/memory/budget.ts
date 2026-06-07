import * as path from 'path';
import * as vscode from 'vscode';
import { encodingForModel, type Tiktoken } from 'js-tiktoken';

/**
 * Shared byte-budget helpers for all memory-file guardrails (diagnostics,
 * hover, CodeLens).  Single source of truth so the displayed numbers can
 * never drift between surfaces.
 *
 * Caps mirror src/engine/workspaceMemory.ts.
 */

function readCap(key: string, fallback: number): number {
  const v = vscode.workspace.getConfiguration('promptProxy').get<number>(key);
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

export function getMaxBytesPerFile(): number {
  return readCap('tokenBudget.perFileBytes', 12_000);
}
export function getMaxTotalBytes(): number {
  return readCap('tokenBudget.totalBytes', 24_000);
}

/** Back-compat numeric exports — keep defaults for callers that don't query live. */
export const MAX_BYTES_PER_FILE = 12_000;
export const MAX_TOTAL_BYTES    = 24_000;
export const WARN_RATIO         = 0.8;

/**
 * Fallback chars/token used only when the tokenizer fails to load.  Most
 * GPT/Claude tokenizers average ~3.5 chars/token for prose and lower for
 * code, so 4 is a conservative upper bound on chars/token => lower bound
 * on token count.
 */
export const BYTES_PER_TOKEN_APPROX = 4;

/**
 * Accurate token estimator via js-tiktoken (cl100k_base encoder used by
 * GPT-4, GPT-3.5-turbo, and a close approximation for Claude).  Cached
 * across calls because constructing the encoder allocates ~1 MB.
 */
let cachedEncoder: Tiktoken | null = null;
let encoderFailed = false;
function getEncoder(): Tiktoken | null {
  if (cachedEncoder || encoderFailed) { return cachedEncoder; }
  try {
    cachedEncoder = encodingForModel('gpt-4');
  } catch {
    encoderFailed = true;
    cachedEncoder = null;
  }
  return cachedEncoder;
}
export function estimateTokens(text: string): number {
  const enc = getEncoder();
  if (enc) {
    try { return enc.encode(text).length; }
    catch { /* fall through to byte heuristic */ }
  }
  return Math.round(Buffer.byteLength(text, 'utf8') / BYTES_PER_TOKEN_APPROX);
}

export const GUARDED_FILE_NAMES = new Set([
  'memory.md', 'knowledge.md', 'AGENTS.md', 'CLAUDE.md', 'CLAUDE.local.md',
  'copilot-instructions.md', '.cursorrules', '.clinerules', 'README.md',
]);

const GUARDED_MD_DIRS = [
  `${path.sep}.promptoptimizer${path.sep}`,
  `${path.sep}.instruction_studio${path.sep}`,
  `${path.sep}vscode-extension${path.sep}media${path.sep}skill-library${path.sep}`,
];

export function isGuardedFile(filePath: string): boolean {
  const normalized = path.normalize(filePath).toLowerCase();
  const isMarkdown = path.extname(normalized) === '.md';
  if (isMarkdown && GUARDED_MD_DIRS.some((dir) => normalized.includes(dir.toLowerCase()))) {
    return true;
  }
  return GUARDED_FILE_NAMES.has(path.basename(filePath));
}

export type BudgetStatus = 'ok' | 'warn' | 'over';

export interface MemoryBudget {
  totalBytes: number;
  capBytes: number;
  overBytes: number;
  usedRatio: number;
  usedPct: number;
  status: BudgetStatus;
  /** First line whose cumulative bytes cross the cap (only meaningful when over). */
  truncLine: number;
  estimatedTokens: number;
}

export function computeBudget(doc: vscode.TextDocument): MemoryBudget {
  const totalBytes = Buffer.byteLength(doc.getText(), 'utf8');
  const capBytes = getMaxBytesPerFile();
  const overBytes = Math.max(0, totalBytes - capBytes);
  const usedRatio = totalBytes / capBytes;
  const usedPct = Math.round(usedRatio * 100);
  const status: BudgetStatus =
      totalBytes > capBytes ? 'over'
    : usedRatio >= WARN_RATIO ? 'warn'
    : 'ok';
  return {
    totalBytes,
    capBytes,
    overBytes,
    usedRatio,
    usedPct,
    status,
    truncLine: status === 'over' ? findTruncationLine(doc, capBytes) : -1,
    estimatedTokens: estimateTokens(doc.getText()),
  };
}

/** Returns the first line index whose cumulative byte total crosses `cap`. */
export function findTruncationLine(doc: vscode.TextDocument, cap: number): number {
  let accumulated = 0;
  for (let i = 0; i < doc.lineCount; i++) {
    accumulated += Buffer.byteLength(doc.lineAt(i).text, 'utf8') + 1;
    if (accumulated > cap) { return Math.max(0, i); }
  }
  return Math.max(0, doc.lineCount - 1);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) { return `${bytes} B`; }
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/** Render a 10-segment text progress bar — used in hover + CodeLens titles. */
export function progressBar(ratio: number, width = 10): string {
  const clamped = Math.max(0, Math.min(1.5, ratio));
  const filled = Math.min(width, Math.round(clamped * width));
  const over = clamped > 1;
  const bar = '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled));
  return over ? `${bar}⚠` : bar;
}

export function statusIcon(status: BudgetStatus): string {
  switch (status) {
    case 'over': return '$(error)';
    case 'warn': return '$(warning)';
    default:     return '$(check)';
  }
}
