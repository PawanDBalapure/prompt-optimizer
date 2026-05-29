import * as fs from 'node:fs';
import * as path from 'node:path';
import type Database from 'better-sqlite3';
import { redactForPersistence } from './redactor.js';

/**
 * Workspace knowledge base: harvests durable instruction files that the user
 * (or upstream tools like Cursor / Cline / VS Code Copilot / Claude Code)
 * may already maintain in the repo, then makes them available to the
 * optimization pipeline as long-lived context.
 *
 * Files scanned (first match wins per kind, capped per file):
 *   - .promptoptimizer/memory.md   (this tool's own canonical store)
 *   - .promptoptimizer/knowledge.md
 *   - AGENTS.md                    (OpenAI's "agents.md" convention)
 *   - CLAUDE.md / CLAUDE.local.md  (Anthropic's Claude Code convention)
 *   - .github/copilot-instructions.md
 *   - .cursorrules / .cursor/rules
 *   - .clinerules
 *   - README.md                    (fallback summary only)
 */

// NOTE: `.github/copilot-instructions.md` is intentionally NOT listed here.
// Copilot reads that file natively on every chat turn, and our
// `syncCopilotInstructions` writer derives it from these sources. Including
// it would double-feed the same bytes into every prompt.
const MEMORY_SOURCES: { source: string; relative: string; isFallback?: boolean }[] = [
  { source: 'project memory',         relative: '.promptoptimizer/memory.md' },
  { source: 'project knowledge',      relative: '.promptoptimizer/knowledge.md' },
  { source: 'AGENTS.md',              relative: 'AGENTS.md' },
  { source: 'CLAUDE.md',              relative: 'CLAUDE.md' },
  { source: 'CLAUDE.local.md',        relative: 'CLAUDE.local.md' },
  { source: 'Cursor rules',           relative: '.cursorrules' },
  { source: 'Cline rules',            relative: '.clinerules' },
  { source: 'README (excerpt)',       relative: 'README.md', isFallback: true },
];

/**
 * Hard cap to keep token usage predictable.  Both can be overridden via
 * env vars so the VS Code extension (and CLI users) can tune the budget
 * without rebuilding the engine.
 */
function envInt(name: string, fallback: number, min = 256): number {
  const raw = process.env[name];
  if (!raw) { return fallback; }
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
}
const MAX_BYTES_PER_FILE = envInt('POMEMORY_MAX_BYTES_PER_FILE', 12_000);
const MAX_TOTAL_BYTES    = envInt('POMEMORY_MAX_TOTAL_BYTES',    24_000);

export interface WorkspaceMemoryEntry {
  source: string;
  content: string;
  mtime: number;
}

export interface WorkspaceMemorySnapshot {
  workspaceId: string;
  entries: WorkspaceMemoryEntry[];
}

/** Read all known memory files for a workspace from disk, with size caps. */
export function readWorkspaceMemory(workspaceRoot?: string, workspaceId = 'global'): WorkspaceMemorySnapshot {
  if (!workspaceRoot || !fs.existsSync(workspaceRoot)) {
    return { workspaceId, entries: [] };
  }

  const collected: WorkspaceMemoryEntry[] = [];
  let totalBytes = 0;
  let haveAuthoritative = false;

  for (const candidate of MEMORY_SOURCES) {
    if (candidate.isFallback && haveAuthoritative) { continue; }
    const fullPath = safeJoin(workspaceRoot, candidate.relative);
    if (!fullPath || !fs.existsSync(fullPath)) { continue; }

    try {
      const stat = fs.statSync(fullPath);
      if (!stat.isFile()) { continue; }
      const raw = fs.readFileSync(fullPath, 'utf8');
      const content = clampContent(raw, candidate.isFallback ? Math.floor(MAX_BYTES_PER_FILE / 3) : MAX_BYTES_PER_FILE);
      const entryBytes = Buffer.byteLength(content, 'utf8');
      if (totalBytes + entryBytes > MAX_TOTAL_BYTES) { continue; }
      collected.push({ source: candidate.source, content, mtime: stat.mtimeMs });
      totalBytes += entryBytes;
      if (!candidate.isFallback) { haveAuthoritative = true; }
    } catch { /* unreadable — skip */ }
  }

  return { workspaceId, entries: collected };
}

/** Format memory entries as standalone context sections for the optimized prompt. */
export function formatMemorySections(snapshot: WorkspaceMemorySnapshot): string[] {
  return snapshot.entries.map((entry) => `# Workspace memory — ${entry.source}\n${entry.content.trim()}`);
}

/** Persist (or refresh) the snapshot into the cache DB. Optional — used for cross-workspace queries. */
export function persistMemorySnapshot(db: Database.Database, snapshot: WorkspaceMemorySnapshot): void {
  if (snapshot.entries.length === 0) { return; }
  const stmt = db.prepare(`
    INSERT INTO workspace_memory (workspace_id, source, content, mtime)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(workspace_id, source) DO UPDATE SET
      content = excluded.content,
      mtime = excluded.mtime
  `);
  const txn = db.transaction((entries: WorkspaceMemoryEntry[]) => {
    for (const entry of entries) {
      // Persist a redacted copy so secrets in AGENTS.md / README excerpts /
      // .cursorrules never get cached on disk.  In-memory entries returned
      // to the optimizer remain unchanged.
      const safe = redactForPersistence(entry.content).redacted;
      stmt.run(snapshot.workspaceId, entry.source, safe, Math.floor(entry.mtime));
    }
  });
  try { txn(snapshot.entries); } catch { /* DB write failure must never break optimization */ }
}

/** Load any persisted memory entries for a peer/foreign workspace (read-only). */
export function loadPersistedMemory(db: Database.Database, workspaceId: string): WorkspaceMemoryEntry[] {
  try {
    const rows = db.prepare(
      'SELECT source, content, mtime FROM workspace_memory WHERE workspace_id = ? ORDER BY mtime DESC',
    ).all(workspaceId) as Array<{ source: string; content: string; mtime: number }>;
    return rows.map((row) => ({ source: row.source, content: row.content, mtime: row.mtime }));
  } catch {
    return [];
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

/** Path-traversal-safe join: returns null if the resolved path escapes the root. */
function safeJoin(root: string, relative: string): string | null {
  const resolved = path.resolve(root, relative);
  const normalizedRoot = path.resolve(root) + path.sep;
  if (!resolved.startsWith(normalizedRoot) && resolved !== path.resolve(root)) {
    return null;
  }
  return resolved;
}

function clampContent(text: string, maxBytes: number): string {
  // Byte-accurate truncation: walk the string until we cross `maxBytes` in
  // UTF-8, so multibyte content (emoji, accented chars) cannot sneak past
  // the cap and balloon the per-turn token cost.
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
