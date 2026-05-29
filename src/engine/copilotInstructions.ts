import * as fs from 'node:fs';
import * as path from 'node:path';

import { readWorkspaceMemory, type WorkspaceMemorySnapshot } from './workspaceMemory.js';

/**
 * Auto-maintainer for `.github/copilot-instructions.md`.  Writes Prompt
 * Optimizer's harvested workspace memory between idempotent marker comments
 * so it surfaces to GitHub Copilot (which reads that file automatically).
 *
 * Guarantees:
 *   - Content *outside* the marker block is preserved verbatim.
 *   - Re-running is a no-op when the managed section is already current.
 *   - Skips writing when the only memory source is the Copilot file itself
 *     (otherwise we'd echo our own output back).
 */

export const MANAGED_BEGIN = '<!-- prompt-optimizer:memory:begin -->';
export const MANAGED_END   = '<!-- prompt-optimizer:memory:end -->';

const HEADER_PREFIX = '# Project notes (managed by Prompt Optimizer)\n';

export interface CopilotInstructionsReport {
  ok: boolean;
  path: string;
  created: boolean;
  changed: boolean;
  bytes_total: number;
  bytes_managed: number;
  bytes_preserved: number;
  entries_written: number;
}

export interface SyncOptions {
  workspaceRoot: string;
  workspaceId?: string;
  /** Inject a snapshot instead of re-reading from disk (used in tests). */
  snapshotOverride?: WorkspaceMemorySnapshot;
}

export function syncCopilotInstructions(options: SyncOptions): CopilotInstructionsReport {
  const workspaceId = options.workspaceId ?? 'global';
  const snapshot = options.snapshotOverride
    ?? readWorkspaceMemory(options.workspaceRoot, workspaceId);
  const usableEntries = snapshot.entries.filter((e) => e.source !== 'Copilot instructions');

  const targetDir  = path.join(options.workspaceRoot, '.github');
  const targetPath = path.join(targetDir, 'copilot-instructions.md');

  const created = !fs.existsSync(targetPath);
  const existing = created ? '' : safeRead(targetPath);
  const preserved = stripManagedBlock(existing);
  const managedSection = buildManagedSection(usableEntries);
  const finalContent = composeFinal(preserved, managedSection);

  const changed = finalContent !== existing;
  if (changed) {
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(targetPath, finalContent, { encoding: 'utf8' });
  }

  return {
    ok: true,
    path: targetPath,
    created,
    changed,
    bytes_total: Buffer.byteLength(finalContent, 'utf8'),
    bytes_managed: Buffer.byteLength(managedSection, 'utf8'),
    bytes_preserved: Buffer.byteLength(preserved, 'utf8'),
    entries_written: usableEntries.length,
  };
}

function buildManagedSection(entries: Array<{ source: string; content: string }>): string {
  const lines: string[] = [
    MANAGED_BEGIN,
    '',
    '> Auto-generated from Prompt Optimizer workspace memory.',
    '> Do not edit between markers — edits will be overwritten on the next sync.',
    '',
  ];
  if (entries.length === 0) {
    lines.push(
      '_No project memory found yet. Create `AGENTS.md` or `.promptoptimizer/memory.md` ' +
      'to populate this section._',
    );
  } else {
    for (const entry of entries) {
      lines.push(`### ${entry.source}`);
      lines.push('');
      lines.push(entry.content.trim());
      lines.push('');
    }
  }
  lines.push(MANAGED_END);
  return lines.join('\n');
}

function composeFinal(preserved: string, managedSection: string): string {
  const preservedTrim = preserved.replace(/\s+$/g, '');
  if (preservedTrim.length === 0) {
    return `${HEADER_PREFIX}\n${managedSection}\n`;
  }
  return `${preservedTrim}\n\n${managedSection}\n`;
}

function stripManagedBlock(content: string): string {
  if (!content) { return ''; }
  const begin = content.indexOf(MANAGED_BEGIN);
  if (begin === -1) { return content; }
  const end = content.indexOf(MANAGED_END, begin);
  if (end === -1) {
    return content.slice(0, begin).replace(/\s+$/g, '');
  }
  const before = content.slice(0, begin);
  const after  = content.slice(end + MANAGED_END.length);
  return `${before}${after}`.replace(/\n{3,}/g, '\n\n');
}

function safeRead(filePath: string): string {
  try { return fs.readFileSync(filePath, 'utf8'); }
  catch { return ''; }
}
