import type Database from 'better-sqlite3';

/**
 * Migration framework.  Replaces the previous open-coded `initializeSchema`
 * sequence so we can ship schema changes safely to a fleet:
 *
 *   - each migration has a unique increasing `version`;
 *   - the on-disk DB tracks the highest version it has seen in `schema_version`;
 *   - migrations are applied in order, idempotently — a rerun is a no-op;
 *   - migrations are wrapped in a transaction; partial failures roll back.
 *
 * Add new schema changes by appending a new entry below.  Never edit an
 * already-shipped migration in place — write a follow-up that fixes it.
 */

export interface Migration {
  version: number;
  description: string;
  up: (db: Database.Database) => void;
}

/** Idempotent baseline — replicates everything `initializeSchema` shipped before v4. */
const v1_initial: Migration = {
  version: 1,
  description: 'Initial cache + versions + KG + peers + memory + digest tables',
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL,
        applied_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS semantic_cache (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        raw_prompt TEXT UNIQUE,
        optimized_prompt TEXT,
        embedding BLOB,
        timestamp INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_raw_prompt ON semantic_cache(raw_prompt);

      CREATE TABLE IF NOT EXISTS prompt_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        prompt_key TEXT,
        version INTEGER,
        raw_prompt TEXT,
        optimized_prompt TEXT,
        target_model TEXT,
        timestamp INTEGER,
        performance_score REAL DEFAULT 0.0,
        experiment_branch TEXT DEFAULT 'main'
      );
      CREATE INDEX IF NOT EXISTS idx_prompt_versions_key ON prompt_versions(prompt_key);

      CREATE TABLE IF NOT EXISTS kg_nodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id TEXT DEFAULT 'global',
        node_type TEXT NOT NULL,
        name TEXT NOT NULL,
        summary TEXT DEFAULT '',
        updated_at INTEGER NOT NULL,
        UNIQUE(workspace_id, node_type, name)
      );
      CREATE INDEX IF NOT EXISTS idx_kg_nodes_ws ON kg_nodes(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_kg_nodes_name ON kg_nodes(name);

      CREATE TABLE IF NOT EXISTS kg_edges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        src_id INTEGER NOT NULL,
        dst_id INTEGER NOT NULL,
        relation TEXT NOT NULL,
        weight REAL DEFAULT 1.0,
        updated_at INTEGER NOT NULL,
        UNIQUE(src_id, dst_id, relation)
      );
      CREATE INDEX IF NOT EXISTS idx_kg_edges_src ON kg_edges(src_id);
      CREATE INDEX IF NOT EXISTS idx_kg_edges_dst ON kg_edges(dst_id);

      CREATE TABLE IF NOT EXISTS peer_workspaces (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        label TEXT NOT NULL,
        db_path TEXT NOT NULL UNIQUE,
        enabled INTEGER DEFAULT 1,
        added_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS workspace_memory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id TEXT NOT NULL,
        source TEXT NOT NULL,
        content TEXT NOT NULL,
        mtime INTEGER NOT NULL,
        UNIQUE(workspace_id, source)
      );
      CREATE INDEX IF NOT EXISTS idx_ws_memory_ws ON workspace_memory(workspace_id);

      CREATE TABLE IF NOT EXISTS file_digest (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id TEXT NOT NULL,
        path TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        mtime INTEGER NOT NULL,
        size INTEGER NOT NULL,
        language TEXT DEFAULT '',
        summary TEXT DEFAULT '',
        visit_count INTEGER DEFAULT 1,
        first_seen_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(workspace_id, path)
      );
      CREATE INDEX IF NOT EXISTS idx_file_digest_ws ON file_digest(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_file_digest_updated ON file_digest(updated_at);
    `);
  },
};

/** Adds the column upgrades that used to live as ALTER fallbacks in the old initializer. */
const v2_cache_columns: Migration = {
  version: 2,
  description: 'Add usage_count / confidence_score / workspace_id to semantic_cache',
  up: (db) => {
    for (const ddl of [
      'ALTER TABLE semantic_cache ADD COLUMN usage_count INTEGER DEFAULT 0',
      'ALTER TABLE semantic_cache ADD COLUMN confidence_score REAL DEFAULT 0.7',
      "ALTER TABLE semantic_cache ADD COLUMN workspace_id TEXT DEFAULT 'global'",
    ]) {
      try { db.exec(ddl); } catch { /* column already exists */ }
    }
    try { db.exec('CREATE INDEX IF NOT EXISTS idx_workspace ON semantic_cache(workspace_id)'); }
    catch { /* already exists */ }
  },
};

const v3_engine_metrics: Migration = {
  version: 3,
  description: 'Append-only engine_metrics counters table',
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS engine_metrics (
        metric TEXT PRIMARY KEY,
        count INTEGER NOT NULL DEFAULT 0,
        last_at INTEGER NOT NULL DEFAULT 0
      );
    `);
  },
};

const v4_audit_log: Migration = {
  version: 4,
  description: 'Tamper-evident audit_log for compliance evidence',
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        event TEXT NOT NULL,
        workspace_id TEXT,
        actor TEXT,
        prompt_hash TEXT,
        prompt_raw TEXT,
        redaction_hits INTEGER DEFAULT 0,
        details TEXT,
        prev_hash TEXT,
        row_hash TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);
      CREATE INDEX IF NOT EXISTS idx_audit_event ON audit_log(event);
      CREATE INDEX IF NOT EXISTS idx_audit_ws ON audit_log(workspace_id);
    `);
  },
};

const v5_peer_transport: Migration = {
  version: 5,
  description: 'peer_workspaces.kind / endpoint / auth_token for HTTPS federation',
  up: (db) => {
    for (const ddl of [
      "ALTER TABLE peer_workspaces ADD COLUMN kind TEXT DEFAULT 'sqlite'",
      'ALTER TABLE peer_workspaces ADD COLUMN endpoint TEXT',
      'ALTER TABLE peer_workspaces ADD COLUMN auth_token TEXT',
    ]) {
      try { db.exec(ddl); } catch { /* column already exists */ }
    }
  },
};

/** Content-addressed store of context segments already sent to the model so
 *  recurring file/log/memory blocks can be referenced instead of resent. */
const v6_prompt_segments: Migration = {
  version: 6,
  description: 'prompt_segments store for partial (segment-level) cache reuse',
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS prompt_segments (
        workspace_id TEXT NOT NULL,
        segment_hash TEXT NOT NULL,
        label TEXT NOT NULL DEFAULT '',
        char_length INTEGER NOT NULL DEFAULT 0,
        token_estimate INTEGER NOT NULL DEFAULT 0,
        hit_count INTEGER NOT NULL DEFAULT 0,
        first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        PRIMARY KEY (workspace_id, segment_hash)
      );
      CREATE INDEX IF NOT EXISTS idx_prompt_segments_ws ON prompt_segments(workspace_id);
    `);
  },
};

/** Ordered list — append new migrations to the end. */
export const MIGRATIONS: Migration[] = [
  v1_initial,
  v2_cache_columns,
  v3_engine_metrics,
  v4_audit_log,
  v5_peer_transport,
  v6_prompt_segments,
];

export const CURRENT_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

/** Apply pragmas + every pending migration in a single transaction per step. */
export function runMigrations(db: Database.Database): { from: number; to: number; applied: number[] } {
  const fromRow = (() => {
    try {
      return (db.prepare('SELECT version FROM schema_version WHERE id = 1').get() as { version?: number } | undefined)?.version ?? 0;
    } catch {
      return 0;
    }
  })();

  const applied: number[] = [];
  for (const migration of MIGRATIONS) {
    if (migration.version <= fromRow) { continue; }
    const txn = db.transaction(() => {
      migration.up(db);
      db.prepare(`
        INSERT INTO schema_version (id, version, applied_at) VALUES (1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET version = excluded.version, applied_at = excluded.applied_at
      `).run(migration.version, Date.now());
    });
    txn();
    applied.push(migration.version);
  }
  return { from: fromRow, to: CURRENT_SCHEMA_VERSION, applied };
}
