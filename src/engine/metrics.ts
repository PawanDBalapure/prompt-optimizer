import type Database from 'better-sqlite3';

/**
 * Append-only operation counters.  Each named metric maps to a single row
 * `(metric, count, last_at)` so concurrent extension hosts can `+= 1` without
 * stepping on each other (UPSERT is atomic in SQLite).  Intended for local
 * observability only — no data leaves the box.
 */

export type MetricName =
  | 'requests.total'
  | 'requests.cache_exact'
  | 'requests.cache_semantic'
  | 'requests.cache_miss'
  | 'cache.writes'
  | 'cache.redaction_hits'
  | 'digests.records_upserted'
  | 'digests.recall_emitted'
  | 'memory.snapshots_persisted'
  | 'memory.redaction_hits'
  | 'kg.nodes_upserted'
  | 'kg.edges_upserted'
  | 'maintenance.runs'
  | 'maintenance.entries_evicted';

export class MetricsRegistry {
  private readonly incStmt;

  constructor(private readonly db: Database.Database) {
    this.incStmt = db.prepare(`
      INSERT INTO engine_metrics (metric, count, last_at) VALUES (?, ?, ?)
      ON CONFLICT(metric) DO UPDATE SET
        count   = engine_metrics.count + excluded.count,
        last_at = excluded.last_at
    `);
  }

  increment(name: MetricName | string, by = 1): void {
    if (by === 0) { return; }
    try { this.incStmt.run(name, by, Date.now()); }
    catch { /* metrics must never break the optimizer */ }
  }

  snapshot(): Array<{ metric: string; count: number; last_at: number }> {
    try {
      return this.db.prepare(
        'SELECT metric, count, last_at FROM engine_metrics ORDER BY count DESC, metric ASC',
      ).all() as Array<{ metric: string; count: number; last_at: number }>;
    } catch {
      return [];
    }
  }

  reset(): number {
    try {
      const info = this.db.prepare('DELETE FROM engine_metrics').run();
      return info.changes ?? 0;
    } catch {
      return 0;
    }
  }
}
