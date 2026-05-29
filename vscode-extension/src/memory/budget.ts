import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Shared byte-budget helpers for all memory-file guardrails (diagnostics,
 * hover, CodeLens).  Single source of truth so the displayed numbers can
 * never drift between surfaces.
 *
 * Caps mirror src/engine/workspaceMemory.ts.
 */

export const MAX_BYTES_PER_FILE = 12_000;
export const MAX_TOTAL_BYTES    = 24_000;
export const WARN_RATIO         = 0.8;

/** Rough token estimate — most tokenizers average ~4 chars/token for English. */
export const BYTES_PER_TOKEN_APPROX = 4;

export const GUARDED_FILE_NAMES = new Set([
  'memory.md', 'knowledge.md', 'AGENTS.md', 'CLAUDE.md', 'CLAUDE.local.md',
  'copilot-instructions.md', '.cursorrules', '.clinerules', 'README.md',
]);

export function isGuardedFile(fileName: string): boolean {
  return GUARDED_FILE_NAMES.has(path.basename(fileName));
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
  const capBytes = MAX_BYTES_PER_FILE;
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
    estimatedTokens: Math.round(totalBytes / BYTES_PER_TOKEN_APPROX),
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
