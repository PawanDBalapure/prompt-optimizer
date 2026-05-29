import Database from 'better-sqlite3';

import {
  loadPersistedMemory,
  readWorkspaceMemory,
  type WorkspaceMemoryEntry,
} from './workspaceMemory.js';
import type { CrossWorkspaceFederation, PeerWorkspace } from './crossWorkspace.js';
import { USER_GLOBAL_LABEL } from './globalMemory.js';

/**
 * Shared memory recall service.  One responsibility: rank and assemble a
 * cross-tier memory slice (workspace memory + knowledge graph + cache +
 * user-global peer) into a single text payload short enough to be embedded
 * in a model prompt or returned from an LM tool.
 *
 * Used by:
 *   - CLI flags `--recall-memory` and `--export-memory`
 *   - VS Code LM tool `prompt-optimizer_recallMemory`
 *   - VS Code chat variable `#pomemory`
 *
 * All four channels share this function so behavior is identical no matter
 * how recall is triggered.  Add a new channel by calling `recallMemory()` —
 * never by re-implementing the ranking.
 */

export type RecallScope = 'workspace' | 'user' | 'all';
export type RecallTier  = 'workspace' | 'user' | 'kg' | 'cache';

export interface RecallEntry {
  tier: RecallTier;
  source: string;
  content: string;
  score: number;
  updated_at?: number;
}

export interface RecallResult {
  query: string;
  workspaceId: string;
  scope: RecallScope;
  entries: RecallEntry[];
  formatted: string;
  total_bytes: number;
}

export interface RecallOptions {
  query?: string;
  workspaceId?: string;
  scope?: RecallScope;
  limit?: number;
  /** When provided, live-reads memory files from disk instead of the DB. */
  workspaceRoot?: string;
}

const MAX_TOTAL_BYTES = 6_000;
const MAX_ENTRY_BYTES = 1_500;
const MAX_PEER_ROWS   = 25;
const MIN_TERM_LENGTH = 3;

export function recallMemory(
  db: Database.Database,
  federation: CrossWorkspaceFederation | undefined,
  options: RecallOptions = {},
): RecallResult {
  const workspaceId = options.workspaceId ?? 'global';
  const scope: RecallScope = options.scope ?? 'all';
  const query = (options.query ?? '').trim();
  const limit = clampInt(options.limit ?? 8, 1, 50);
  const terms = tokenize(query);

  const candidates: RecallEntry[] = [];

  if (scope === 'workspace' || scope === 'all') {
    for (const entry of collectWorkspaceEntries(db, workspaceId, options.workspaceRoot)) {
      candidates.push(toEntry('workspace', entry, terms));
    }
    candidates.push(...recallFromKg(db, workspaceId, terms));
    candidates.push(...recallFromCache(db, workspaceId, terms));
  }

  if (scope === 'user' || scope === 'all') {
    const peers = federation ? federation.list().filter((p) => p.enabled) : [];
    const userPeer = peers.find((p) => p.label === USER_GLOBAL_LABEL);
    if (userPeer) {
      candidates.push(...recallFromPeer(userPeer, terms));
    }
  }

  const deduped = dedupe(candidates);
  const ranked = deduped.sort((a, b) => b.score - a.score).slice(0, limit);
  const capped = capTotalBytes(ranked);
  const formatted = formatRecall(capped, { query, workspaceId, scope });

  return {
    query,
    workspaceId,
    scope,
    entries: capped,
    formatted,
    total_bytes: capped.reduce((sum, e) => sum + byteLen(e.content), 0),
  };
}

function collectWorkspaceEntries(
  db: Database.Database,
  workspaceId: string,
  workspaceRoot: string | undefined,
): WorkspaceMemoryEntry[] {
  if (workspaceRoot) {
    try {
      return readWorkspaceMemory(workspaceRoot, workspaceId).entries;
    } catch { /* fall through to DB */ }
  }
  try {
    return loadPersistedMemory(db, workspaceId);
  } catch {
    return [];
  }
}

function toEntry(
  tier: RecallTier,
  entry: WorkspaceMemoryEntry,
  terms: string[],
): RecallEntry {
  return {
    tier,
    source: entry.source,
    content: clampText(entry.content, MAX_ENTRY_BYTES),
    score: scoreContent(entry.content, terms) + recencyScore(entry.mtime) + 0.2,
    updated_at: entry.mtime,
  };
}

function recallFromKg(
  db: Database.Database,
  workspaceId: string,
  terms: string[],
): RecallEntry[] {
  if (terms.length === 0) { return []; }
  try {
    const clauses = terms.map(() => '(name LIKE ? OR summary LIKE ?)').join(' OR ');
    const params: unknown[] = [workspaceId];
    for (const term of terms) {
      params.push(`%${term}%`, `%${term}%`);
    }
    params.push(MAX_PEER_ROWS);
    const rows = db.prepare(
      `SELECT name, summary, updated_at FROM kg_nodes
       WHERE workspace_id = ? AND (${clauses})
       ORDER BY updated_at DESC LIMIT ?`,
    ).all(...params) as Array<{ name: string; summary: string; updated_at: number }>;
    return rows
      .filter((r) => r.summary && r.summary.trim().length > 0)
      .map((row) => ({
        tier: 'kg' as const,
        source: `KG: ${row.name}`,
        content: clampText(row.summary, MAX_ENTRY_BYTES),
        score: scoreContent(`${row.name} ${row.summary}`, terms) + recencyScore(row.updated_at) - 0.2,
        updated_at: row.updated_at,
      }));
  } catch {
    return [];
  }
}

function recallFromCache(
  db: Database.Database,
  workspaceId: string,
  terms: string[],
): RecallEntry[] {
  if (terms.length === 0) { return []; }
  try {
    const clauses = terms.map(() => '(raw_prompt LIKE ? OR optimized_prompt LIKE ?)').join(' OR ');
    const params: unknown[] = [workspaceId];
    for (const term of terms) {
      params.push(`%${term}%`, `%${term}%`);
    }
    params.push(MAX_PEER_ROWS);
    const rows = db.prepare(
      `SELECT raw_prompt, optimized_prompt, timestamp FROM semantic_cache
       WHERE workspace_id = ? AND (${clauses})
       ORDER BY timestamp DESC LIMIT ?`,
    ).all(...params) as Array<{ raw_prompt: string; optimized_prompt: string; timestamp: number }>;
    return rows.map((row) => ({
      tier: 'cache' as const,
      source: `Past prompt: ${row.raw_prompt.slice(0, 60).replace(/\s+/g, ' ')}`,
      content: clampText(row.optimized_prompt, MAX_ENTRY_BYTES),
      score: scoreContent(`${row.raw_prompt} ${row.optimized_prompt}`, terms)
           + recencyScore(row.timestamp) - 0.35,
      updated_at: row.timestamp,
    }));
  } catch {
    return [];
  }
}

function recallFromPeer(peer: PeerWorkspace, terms: string[]): RecallEntry[] {
  let db: Database.Database | null = null;
  try {
    db = new Database(peer.dbPath, { readonly: true, fileMustExist: true });
    const rows = db.prepare(
      `SELECT source, content, mtime FROM workspace_memory
       ORDER BY mtime DESC LIMIT ?`,
    ).all(MAX_PEER_ROWS) as Array<{ source: string; content: string; mtime: number }>;
    return rows.map((row) => ({
      tier: 'user' as const,
      source: `[user-global] ${row.source}`,
      content: clampText(row.content, MAX_ENTRY_BYTES),
      score: scoreContent(row.content, terms) + recencyScore(row.mtime),
      updated_at: row.mtime,
    }));
  } catch {
    return [];
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

function dedupe(entries: RecallEntry[]): RecallEntry[] {
  const seen = new Map<string, RecallEntry>();
  for (const entry of entries) {
    const key = `${entry.tier}::${entry.source}`;
    const prior = seen.get(key);
    if (!prior || entry.score > prior.score) {
      seen.set(key, entry);
    }
  }
  return [...seen.values()];
}

function tokenize(query: string): string[] {
  if (!query) { return []; }
  return query
    .toLowerCase()
    .split(/[^a-z0-9_]+/g)
    .filter((token) => token.length >= MIN_TERM_LENGTH)
    .slice(0, 12);
}

function scoreContent(content: string, terms: string[]): number {
  if (terms.length === 0) { return 1.0; }
  const lower = content.toLowerCase();
  let hits = 0;
  for (const term of terms) {
    if (lower.includes(term)) { hits++; }
  }
  return hits / terms.length;
}

function recencyScore(mtime: number | undefined): number {
  if (!mtime || mtime <= 0) { return 0; }
  const ageDays = Math.max(0, (Date.now() - mtime) / 86_400_000);
  return Math.max(0, 0.5 * Math.exp(-ageDays / 30));
}

function clampText(text: string, max: number): string {
  if (text.length <= max) { return text; }
  return `${text.slice(0, max)} …[truncated]`;
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) { return min; }
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function byteLen(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

function capTotalBytes(entries: RecallEntry[]): RecallEntry[] {
  const out: RecallEntry[] = [];
  let total = 0;
  for (const entry of entries) {
    const cost = byteLen(entry.content) + entry.source.length + 32;
    if (total + cost > MAX_TOTAL_BYTES) { break; }
    out.push(entry);
    total += cost;
  }
  return out;
}

function formatRecall(
  entries: RecallEntry[],
  meta: { query: string; workspaceId: string; scope: RecallScope },
): string {
  if (entries.length === 0) {
    return `_No Prompt Optimizer memory matches for query "${meta.query}" (scope=${meta.scope})._`;
  }
  const lines: string[] = [
    `# Prompt Optimizer memory — workspace \`${meta.workspaceId}\` (scope: ${meta.scope})`, '',
  ];
  for (const entry of entries) {
    lines.push(`## [${entry.tier}] ${entry.source}`, '', entry.content.trim(), '');
  }
  return lines.join('\n');
}
