import type Database from 'better-sqlite3';
import { createLogger } from './logger.js';

/**
 * Retention & eviction policies that keep the local SQLite DB bounded.  Each
 * extension call may bump cache, KG, and digest tables; without maintenance
 * those tables would grow without limit in a long-running workspace.
 *
 * Defaults are deliberately generous so a typical developer's machine never
 * notices; the CLI `--db-prune` flags let ops tune them.
 */

const log = createLogger('MaintenanceService');

export interface RetentionOptions {
  /** Maximum semantic_cache rows.  Oldest (by timestamp) get evicted. */
  maxCacheEntries?: number;
  /** Maximum file_digest rows per workspace.  Least-recently-updated lose. */
  maxDigestsPerWorkspace?: number;
  /** Maximum kg_nodes rows per workspace. Oldest nodes (+ their edges) lose. */
  maxKgNodesPerWorkspace?: number;
  /** Delete cache rows untouched for this many days (and low-confidence). */
  staleCacheAgeDays?: number;
  /** Delete digest rows untouched for this many days. */
  staleDigestAgeDays?: number;
  /** Run `VACUUM` afterwards to reclaim disk. Default: false (slow on big DBs). */
  vacuum?: boolean;
}

export interface RetentionReport {
  ran_at: number;
  evicted: {
    cache_rows: number;
    digest_rows: number;
    kg_nodes: number;
    kg_edges: number;
  };
  vacuumed: boolean;
  options: Required<Omit<RetentionOptions, 'vacuum'>> & { vacuum: boolean };
}

const DEFAULTS: Required<Omit<RetentionOptions, 'vacuum'>> & { vacuum: boolean } = {
  maxCacheEntries: 10_000,
  maxDigestsPerWorkspace: 5_000,
  maxKgNodesPerWorkspace: 20_000,
  staleCacheAgeDays: 90,
  staleDigestAgeDays: 180,
  vacuum: false,
};

export class MaintenanceService {
  constructor(private readonly db: Database.Database) {}

  /** Run all retention rules.  Returns a structured report (safe to JSON-emit). */
  run(options: RetentionOptions = {}): RetentionReport {
    const opts = { ...DEFAULTS, ...options };
    const now = Date.now();
    const report: RetentionReport = {
      ran_at: now,
      evicted: { cache_rows: 0, digest_rows: 0, kg_nodes: 0, kg_edges: 0 },
      vacuumed: false,
      options: opts,
    };

    // 1. Cache: drop stale + low-confidence rows, then cap to maxCacheEntries.
    report.evicted.cache_rows += this.pruneStaleCache(opts.staleCacheAgeDays);
    report.evicted.cache_rows += this.capCacheRows(opts.maxCacheEntries);

    // 2. File digests: drop stale, then cap per workspace.
    report.evicted.digest_rows += this.pruneStaleDigests(opts.staleDigestAgeDays);
    report.evicted.digest_rows += this.capDigestsPerWorkspace(opts.maxDigestsPerWorkspace);

    // 3. KG: cap nodes per workspace; cascade-delete their edges.
    const kgEviction = this.capKgPerWorkspace(opts.maxKgNodesPerWorkspace);
    report.evicted.kg_nodes += kgEviction.nodes;
    report.evicted.kg_edges += kgEviction.edges;

    // 4. Optional VACUUM (cannot run inside a transaction).
    if (opts.vacuum) {
      try { this.db.exec('VACUUM'); report.vacuumed = true; }
      catch (err) { log.warn('VACUUM failed', { error: String(err) }); }
    }

    log.info('Maintenance complete', { evicted: report.evicted, vacuumed: report.vacuumed });
    return report;
  }

  // ── individual policies ────────────────────────────────────────────────

  private pruneStaleCache(days: number): number {
    if (days <= 0) { return 0; }
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    try {
      const info = this.db.prepare(
        'DELETE FROM semantic_cache WHERE timestamp < ? AND COALESCE(confidence_score, 0.7) < 0.4',
      ).run(cutoff);
      return info.changes ?? 0;
    } catch (err) {
      log.warn('pruneStaleCache failed', { error: String(err) });
      return 0;
    }
  }

  private capCacheRows(max: number): number {
    if (max <= 0) { return 0; }
    try {
      const row = this.db.prepare('SELECT COUNT(*) AS c FROM semantic_cache').get() as { c: number };
      const over = row.c - max;
      if (over <= 0) { return 0; }
      const info = this.db.prepare(`
        DELETE FROM semantic_cache WHERE id IN (
          SELECT id FROM semantic_cache ORDER BY timestamp ASC LIMIT ?
        )
      `).run(over);
      return info.changes ?? 0;
    } catch (err) {
      log.warn('capCacheRows failed', { error: String(err) });
      return 0;
    }
  }

  private pruneStaleDigests(days: number): number {
    if (days <= 0) { return 0; }
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    try {
      const info = this.db.prepare('DELETE FROM file_digest WHERE updated_at < ?').run(cutoff);
      return info.changes ?? 0;
    } catch (err) {
      log.warn('pruneStaleDigests failed', { error: String(err) });
      return 0;
    }
  }

  private capDigestsPerWorkspace(max: number): number {
    if (max <= 0) { return 0; }
    try {
      const workspaces = this.db.prepare(
        'SELECT workspace_id AS ws, COUNT(*) AS c FROM file_digest GROUP BY workspace_id HAVING c > ?',
      ).all(max) as Array<{ ws: string; c: number }>;
      let removed = 0;
      const evictStmt = this.db.prepare(`
        DELETE FROM file_digest WHERE id IN (
          SELECT id FROM file_digest WHERE workspace_id = ? ORDER BY updated_at ASC LIMIT ?
        )
      `);
      for (const ws of workspaces) {
        const over = ws.c - max;
        if (over > 0) {
          const info = evictStmt.run(ws.ws, over);
          removed += info.changes ?? 0;
        }
      }
      return removed;
    } catch (err) {
      log.warn('capDigestsPerWorkspace failed', { error: String(err) });
      return 0;
    }
  }

  private capKgPerWorkspace(max: number): { nodes: number; edges: number } {
    if (max <= 0) { return { nodes: 0, edges: 0 }; }
    try {
      const workspaces = this.db.prepare(
        'SELECT workspace_id AS ws, COUNT(*) AS c FROM kg_nodes GROUP BY workspace_id HAVING c > ?',
      ).all(max) as Array<{ ws: string; c: number }>;
      let nodes = 0;
      let edges = 0;
      const pickStmt = this.db.prepare(
        'SELECT id FROM kg_nodes WHERE workspace_id = ? ORDER BY updated_at ASC LIMIT ?',
      );
      const delNodes = this.db.prepare(`DELETE FROM kg_nodes WHERE id IN (SELECT value FROM json_each(?))`);
      const delEdges = this.db.prepare(`
        DELETE FROM kg_edges WHERE src_id IN (SELECT value FROM json_each(?))
                                OR dst_id IN (SELECT value FROM json_each(?))
      `);
      for (const ws of workspaces) {
        const over = ws.c - max;
        if (over <= 0) { continue; }
        const ids = (pickStmt.all(ws.ws, over) as Array<{ id: number }>).map((r) => r.id);
        if (ids.length === 0) { continue; }
        const idJson = JSON.stringify(ids);
        const edgeInfo = delEdges.run(idJson, idJson);
        const nodeInfo = delNodes.run(idJson);
        edges += edgeInfo.changes ?? 0;
        nodes += nodeInfo.changes ?? 0;
      }
      return { nodes, edges };
    } catch (err) {
      log.warn('capKgPerWorkspace failed', { error: String(err) });
      return { nodes: 0, edges: 0 };
    }
  }
}
