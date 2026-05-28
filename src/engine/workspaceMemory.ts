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

const MEMORY_SOURCES: { source: string; relative: string; isFallback?: boolean }[] = [
  { source: 'project memory',         relative: '.promptoptimizer/memory.md' },
  { source: 'project knowledge',      relative: '.promptoptimizer/knowledge.md' },
  { source: 'AGENTS.md',              relative: 'AGENTS.md' },
  { source: 'CLAUDE.md',              relative: 'CLAUDE.md' },
  { source: 'CLAUDE.local.md',        relative: 'CLAUDE.local.md' },
  { source: 'Copilot instructions',   relative: '.github/copilot-instructions.md' },
  { source: 'Cursor rules',           relative: '.cursorrules' },
  { source: 'Cline rules',            relative: '.clinerules' },
  { source: 'README (excerpt)',       relative: 'README.md', isFallback: true },
];

/** Hard cap to keep token usage predictable. */
const MAX_BYTES_PER_FILE = 12_000;
const MAX_TOTAL_BYTES = 24_000;

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
      const content = clampContent(raw, candidate.isFallback ? MAX_BYTES_PER_FILE / 3 : MAX_BYTES_PER_FILE);
      if (totalBytes + content.length > MAX_TOTAL_BYTES) { continue; }
      collected.push({ source: candidate.source, content, mtime: stat.mtimeMs });
      totalBytes += content.length;
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
  if (text.length <= maxBytes) { return text; }
  return text.slice(0, maxBytes) + '\n... (truncated)';
}
