import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { IdeContextFile, PromptIDEContext } from '../contracts.js';

/**
 * Per-file "studied" digest.  Closes the cross-session memory gap: the
 * knowledge graph stores file *paths* but not what we knew about each file.
 * This store remembers content hash + a short summary so a new chat session
 * can recognise "you have already studied this file" and surface it as
 * long-lived workspace memory without re-reading the bytes.
 *
 * Failure-tolerant: every public method swallows DB / IO errors so an
 * optimization request never breaks because the digest layer hiccupped.
 */

export interface FileDigestRecord {
  workspaceId: string;
  path: string;
  contentHash: string;
  mtime: number;
  size: number;
  language: string;
  summary: string;
  visitCount: number;
  firstSeenAt: number;
  updatedAt: number;
}

export interface FileDigestStats {
  files: number;
  total_visits: number;
  last_updated: number | null;
}

const MAX_SUMMARY_CHARS  = 320;
const MAX_RECORDED_FILES = 12;   // per single optimization call
const MAX_PRIOR_SECTIONS = 4;    // sections injected per request

export class FileDigestStore {
  constructor(private readonly db: Database.Database) {}

  /**
   * Persist (or refresh) digests for files referenced in the IDE context.
   * Returns the set of paths that were *already* present before this call
   * (i.e. files the model had "studied" in a previous session) so the
   * orchestrator can decide whether to surface a recall hint.
   */
  recordFromIde(workspaceId: string, ide: PromptIDEContext | undefined): string[] {
    if (!ide) { return []; }
    const files = collectCandidates(ide).slice(0, MAX_RECORDED_FILES);
    if (files.length === 0) { return []; }

    const previouslyStudied: string[] = [];
    const now = Date.now();

    const selectStmt = this.db.prepare(
      'SELECT content_hash AS contentHash FROM file_digest WHERE workspace_id = ? AND path = ?',
    );
    const upsertStmt = this.db.prepare(`
      INSERT INTO file_digest
        (workspace_id, path, content_hash, mtime, size, language, summary, visit_count, first_seen_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(workspace_id, path) DO UPDATE SET
        content_hash = excluded.content_hash,
        mtime = excluded.mtime,
        size = excluded.size,
        language = excluded.language,
        summary = excluded.summary,
        visit_count = file_digest.visit_count + 1,
        updated_at = excluded.updated_at
    `);

    const txn = this.db.transaction((items: IdeContextFile[]) => {
      for (const file of items) {
        if (!file.path || typeof file.content !== 'string') { continue; }
        const hash = sha256(file.content);
        const summary = summarize(file.content);
        let priorHash: string | undefined;
        try {
          priorHash = (selectStmt.get(workspaceId, file.path) as { contentHash?: string } | undefined)?.contentHash;
        } catch { priorHash = undefined; }
        if (priorHash) { previouslyStudied.push(file.path); }
        try {
          upsertStmt.run(
            workspaceId,
            file.path,
            hash,
            now,                       // mtime from IDE wall clock; good enough for ranking
            Buffer.byteLength(file.content, 'utf8'),
            file.language ?? '',
            summary,
            now,
            now,
          );
        } catch { /* skip individual row failures */ }
      }
    });

    try { txn(files); } catch { /* full transaction failure — never break optimization */ }
    return previouslyStudied;
  }

  /**
   * Return recall-hint sections for files the workspace has studied before
   * but which are NOT being re-injected as full content this turn.  This is
   * what gives a brand-new chat session the "I remember this file" signal.
   */
  formatRecallSections(
    workspaceId: string,
    excludePaths: Iterable<string>,
    options: { limit?: number; minVisits?: number } = {},
  ): string[] {
    const exclude = new Set(Array.from(excludePaths).map(normalisePath));
    const limit = Math.max(1, options.limit ?? MAX_PRIOR_SECTIONS);
    const minVisits = Math.max(1, options.minVisits ?? 1);
    let rows: Array<Pick<FileDigestRecord, 'path' | 'language' | 'summary' | 'visitCount' | 'updatedAt'>>;
    try {
      rows = this.db.prepare(`
        SELECT path, language, summary, visit_count AS visitCount, updated_at AS updatedAt
        FROM file_digest
        WHERE workspace_id = ? AND visit_count >= ?
        ORDER BY updated_at DESC
        LIMIT ?
      `).all(workspaceId, minVisits, limit * 4) as Array<Pick<FileDigestRecord, 'path' | 'language' | 'summary' | 'visitCount' | 'updatedAt'>>;
    } catch {
      return [];
    }

    const sections: string[] = [];
    for (const row of rows) {
      if (exclude.has(normalisePath(row.path))) { continue; }
      const lang = row.language ? ` (${row.language})` : '';
      const visits = row.visitCount > 1 ? ` — seen ${row.visitCount} times` : '';
      const summary = row.summary?.trim() ? row.summary.trim() : '(no summary captured)';
      sections.push(
        `# Workspace memory — previously analyzed file: ${row.path}${lang}${visits}\n${summary}`,
      );
      if (sections.length >= limit) { break; }
    }
    return sections;
  }

  /** Counts for status / CLI commands. */
  stats(workspaceId?: string): FileDigestStats {
    try {
      const row = workspaceId
        ? this.db.prepare(
            'SELECT COUNT(*) AS files, COALESCE(SUM(visit_count), 0) AS visits, MAX(updated_at) AS last FROM file_digest WHERE workspace_id = ?',
          ).get(workspaceId) as { files: number; visits: number; last: number | null }
        : this.db.prepare(
            'SELECT COUNT(*) AS files, COALESCE(SUM(visit_count), 0) AS visits, MAX(updated_at) AS last FROM file_digest',
          ).get() as { files: number; visits: number; last: number | null };
      return { files: row.files ?? 0, total_visits: row.visits ?? 0, last_updated: row.last ?? null };
    } catch {
      return { files: 0, total_visits: 0, last_updated: null };
    }
  }

  /** Return raw records (used by the VS Code panel). */
  list(workspaceId: string, limit = 50): FileDigestRecord[] {
    try {
      const rows = this.db.prepare(`
        SELECT workspace_id AS workspaceId, path, content_hash AS contentHash, mtime, size,
               language, summary, visit_count AS visitCount,
               first_seen_at AS firstSeenAt, updated_at AS updatedAt
        FROM file_digest
        WHERE workspace_id = ?
        ORDER BY updated_at DESC
        LIMIT ?
      `).all(workspaceId, Math.max(1, Math.min(500, limit)));
      return rows as FileDigestRecord[];
    } catch {
      return [];
    }
  }

  /** Delete all digests for a workspace (used by the "clear" command). */
  clear(workspaceId?: string): number {
    try {
      const stmt = workspaceId
        ? this.db.prepare('DELETE FROM file_digest WHERE workspace_id = ?')
        : this.db.prepare('DELETE FROM file_digest');
      const info = workspaceId ? stmt.run(workspaceId) : stmt.run();
      return info.changes ?? 0;
    } catch {
      return 0;
    }
  }
}

// ── pure helpers ─────────────────────────────────────────────────────────────

function collectCandidates(ide: PromptIDEContext): IdeContextFile[] {
  const out: IdeContextFile[] = [];
  const seen = new Set<string>();
  const push = (f?: IdeContextFile): void => {
    if (!f || !f.path) { return; }
    const key = normalisePath(f.path);
    if (seen.has(key)) { return; }
    seen.add(key);
    out.push(f);
  };
  push(ide.active_file);
  for (const f of ide.open_files ?? []) { push(f); }
  return out;
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function summarize(content: string): string {
  const trimmed = content.replace(/\r\n/g, '\n').trim();
  if (trimmed.length === 0) { return ''; }
  // Prefer a short signature: first non-empty doc/comment + first symbolic line.
  const lines = trimmed.split('\n');
  const head: string[] = [];
  let charBudget = MAX_SUMMARY_CHARS;
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '') { continue; }
    head.push(line);
    charBudget -= line.length + 1;
    if (head.length >= 6 || charBudget <= 0) { break; }
  }
  const joined = head.join(' \u2022 ');
  return joined.length <= MAX_SUMMARY_CHARS ? joined : joined.slice(0, MAX_SUMMARY_CHARS - 1) + '\u2026';
}

function normalisePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}
