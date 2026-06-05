import * as fs from 'node:fs';
import * as path from 'node:path';

import type Database from 'better-sqlite3';
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

/**
 * Hard cap on the auto-generated managed block. Copilot loads
 * copilot-instructions.md on EVERY chat turn, so an unbounded managed
 * section would silently bloat every request. 8 KB ≈ 2 K tokens; combined
 * with whatever the user authored outside the markers this keeps the
 * always-on context cost predictable.
 */
function envInt(name: string, fallback: number, min = 512): number {
  const raw = process.env[name];
  if (!raw) { return fallback; }
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
}
const MAX_MANAGED_BYTES   = envInt('POMEMORY_MAX_MANAGED_BYTES',   8_000);
const MAX_PER_ENTRY_BYTES = envInt('POMEMORY_MAX_PER_ENTRY_BYTES', 2_500);

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
  /**
   * Optional cache DB.  When supplied, a compact "Project knowledge
   * highlights" block (top knowledge-graph facts + recently studied files)
   * is appended so the always-on Copilot channel sees more than just the
   * raw memory files.  Omitted in tests that only exercise file memory.
   */
  db?: Database.Database;
}

export function syncCopilotInstructions(options: SyncOptions): CopilotInstructionsReport {
  const workspaceId = options.workspaceId ?? 'global';
  const snapshot = options.snapshotOverride
    ?? readWorkspaceMemory(options.workspaceRoot, workspaceId);
  const usableEntries = snapshot.entries.filter((e) => e.source !== 'Copilot instructions');

  // Append DB-derived highlights (best-effort) after the authoritative memory
  // files so the user's own AGENTS.md / memory.md keeps byte priority.
  const entries: Array<{ source: string; content: string }> = [...usableEntries];
  if (options.db) {
    entries.push(...collectKnowledgeHighlights(options.db, workspaceId));
  }

  const targetDir  = path.join(options.workspaceRoot, '.github');
  const targetPath = path.join(targetDir, 'copilot-instructions.md');

  const created = !fs.existsSync(targetPath);
  const existing = created ? '' : safeRead(targetPath);
  const preserved = stripManagedBlock(existing);
  const managedSection = buildManagedSection(entries);
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
    entries_written: entries.length,
  };
}

/**
 * Best-effort compact highlights drawn from the cache DB: the most recent
 * knowledge-graph facts and the most-studied files.  Returns at most two
 * synthetic entries; any DB error degrades to no highlights.
 */
function collectKnowledgeHighlights(
  db: Database.Database,
  workspaceId: string,
): Array<{ source: string; content: string }> {
  const out: Array<{ source: string; content: string }> = [];

  try {
    const kgRows = db.prepare(
      `SELECT name, summary FROM kg_nodes
       WHERE workspace_id = ? AND summary IS NOT NULL AND TRIM(summary) <> ''
       ORDER BY updated_at DESC LIMIT 8`,
    ).all(workspaceId) as Array<{ name: string; summary: string }>;
    if (kgRows.length > 0) {
      const body = kgRows
        .map((r) => `- **${r.name}**: ${oneLine(r.summary, 160)}`)
        .join('\n');
      out.push({ source: 'Project knowledge graph (auto)', content: body });
    }
  } catch { /* no KG highlights */ }

  try {
    const fileRows = db.prepare(
      `SELECT path, summary FROM file_digest
       WHERE workspace_id = ? AND summary IS NOT NULL AND TRIM(summary) <> ''
       ORDER BY visit_count DESC, updated_at DESC LIMIT 8`,
    ).all(workspaceId) as Array<{ path: string; summary: string }>;
    if (fileRows.length > 0) {
      const body = fileRows
        .map((r) => `- \`${r.path}\` — ${oneLine(r.summary, 140)}`)
        .join('\n');
      out.push({ source: 'Recently studied files (auto)', content: body });
    }
  } catch { /* no studied-file highlights */ }

  return out;
}

function oneLine(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max)}…`;
}

function buildManagedSection(entries: Array<{ source: string; content: string }>): string {
  const header: string[] = [
    MANAGED_BEGIN,
    '',
    '> Auto-generated from Prompt Optimizer workspace memory.',
    '> Do not edit between markers — edits will be overwritten on the next sync.',
    '',
  ];
  if (entries.length === 0) {
    header.push(
      '_No project memory found yet. Create `AGENTS.md` or `.promptoptimizer/memory.md` ' +
      'to populate this section._',
    );
    header.push(MANAGED_END);
    return header.join('\n');
  }

  // Allocate a fair byte budget per entry so one large file cannot starve
  // the others. Highest-priority sources are written first so any cap
  // overflow drops the lowest-priority ones — not the user's authoritative
  // AGENTS.md / memory.md content.
  const perEntryCap = Math.min(
    MAX_PER_ENTRY_BYTES,
    Math.floor(MAX_MANAGED_BYTES / Math.max(1, entries.length)),
  );
  const lines = [...header];
  let used = Buffer.byteLength(lines.join('\n'), 'utf8');
  const endMarkerCost = Buffer.byteLength(`\n${MANAGED_END}`, 'utf8');

  for (const entry of entries) {
    const trimmed = entry.content.trim();
    const clipped = clampUtf8(trimmed, perEntryCap);
    const block = `### ${entry.source}\n\n${clipped}\n`;
    const blockBytes = Buffer.byteLength(block, 'utf8');
    if (used + blockBytes + endMarkerCost > MAX_MANAGED_BYTES) {
      lines.push(`_(${entries.length - lines.filter(l => l.startsWith('### ')).length} more source(s) omitted to fit the ${MAX_MANAGED_BYTES} B managed cap.)_`);
      break;
    }
    lines.push(`### ${entry.source}`);
    lines.push('');
    lines.push(clipped);
    lines.push('');
    used += blockBytes;
  }
  lines.push(MANAGED_END);
  return lines.join('\n');
}

/** Byte-accurate UTF-8 truncation — mirrors workspaceMemory.clampContent. */
function clampUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) { return text; }
  let accumulated = 0;
  let cutIndex = text.length;
  for (let i = 0; i < text.length; i++) {
    const charBytes = Buffer.byteLength(text[i], 'utf8');
    if (accumulated + charBytes > maxBytes) { cutIndex = i; break; }
    accumulated += charBytes;
  }
  return text.slice(0, cutIndex) + '\n... (truncated)';
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
    // Safety: never drop existing rules when markers are malformed.
    // In this case we preserve the original file verbatim and append a
    // fresh managed block at the end.
    return content;
  }
  const before = content.slice(0, begin);
  const after  = content.slice(end + MANAGED_END.length);
  return `${before}${after}`.replace(/\n{3,}/g, '\n\n');
}

function safeRead(filePath: string): string {
  try { return fs.readFileSync(filePath, 'utf8'); }
  catch { return ''; }
}
