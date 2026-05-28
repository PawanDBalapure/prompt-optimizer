import type Database from 'better-sqlite3';

/**
 * Current logical schema version.  Bumped whenever an additive migration is
 * appended below.  The on-disk DB tracks its own version in `schema_version`
 * so we never re-run an already-applied migration.
 */
export const CURRENT_SCHEMA_VERSION = 3;

/**
 * Apply SQLite-level safety pragmas before any DML runs.  Idempotent: each
 * pragma is safe to set repeatedly.  Tuned for VS Code's multi-window pattern
 * where several extension hosts may share one workspace DB.
 *
 * - `journal_mode=WAL`     readers never block writers (within the same fs)
 * - `busy_timeout=5000`    wait 5 s before raising SQLITE_BUSY on contention
 * - `synchronous=NORMAL`   durable enough for a cache; ~2x faster than FULL
 * - `foreign_keys=ON`      future FKs are enforced
 * - `temp_store=MEMORY`    avoid scratch files in user temp dirs
 */
export function applyDatabasePragmas(db: Database.Database): void {
  try { db.pragma('journal_mode = WAL'); } catch { /* readonly fs — skip */ }
  try { db.pragma('busy_timeout = 5000'); } catch { /* noop */ }
  try { db.pragma('synchronous = NORMAL'); } catch { /* noop */ }
  try { db.pragma('foreign_keys = ON'); } catch { /* noop */ }
  try { db.pragma('temp_store = MEMORY'); } catch { /* noop */ }
}

/** Idempotently create tables, indexes, and migrations for the semantic cache. */
export function initializeSchema(db: Database.Database): void {
  applyDatabasePragmas(db);

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version INTEGER NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);

  db.exec(`
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

    -- Graphify-style knowledge graph: nodes + weighted directed edges.
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

    -- Cross-workspace federation: paths to peer DB files plus enabled flag.
    CREATE TABLE IF NOT EXISTS peer_workspaces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL,
      db_path TEXT NOT NULL UNIQUE,
      enabled INTEGER DEFAULT 1,
      added_at INTEGER NOT NULL
    );

    -- Persistent workspace knowledge base entries harvested from .md files.
    CREATE TABLE IF NOT EXISTS workspace_memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id TEXT NOT NULL,
      source TEXT NOT NULL,
      content TEXT NOT NULL,
      mtime INTEGER NOT NULL,
      UNIQUE(workspace_id, source)
    );
    CREATE INDEX IF NOT EXISTS idx_ws_memory_ws ON workspace_memory(workspace_id);

    -- Per-file "studied" digest so cross-session prompts can remember which
    -- files have already been analyzed in this workspace.  Keyed by
    -- (workspace_id, path); content_hash + mtime + size let us cheaply
    -- detect when a file has actually changed since the last visit.
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

  // Safe migrations — ADD COLUMN throws if the column already exists in older
  // SQLite versions (no IF NOT EXISTS support).  Each statement is independent.
  for (const ddl of [
    'ALTER TABLE semantic_cache ADD COLUMN usage_count INTEGER DEFAULT 0',
    'ALTER TABLE semantic_cache ADD COLUMN confidence_score REAL DEFAULT 0.7',
    "ALTER TABLE semantic_cache ADD COLUMN workspace_id TEXT DEFAULT 'global'",
  ]) {
    try { db.exec(ddl); } catch { /* column already exists */ }
  }

  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_workspace ON semantic_cache(workspace_id)');
  } catch { /* already exists */ }

  // Enterprise: local-only operation counters for the --metrics CLI.
  // Append-only (UPSERT) so concurrent writers can't corrupt the totals.
  db.exec(`
    CREATE TABLE IF NOT EXISTS engine_metrics (
      metric TEXT PRIMARY KEY,
      count INTEGER NOT NULL DEFAULT 0,
      last_at INTEGER NOT NULL DEFAULT 0
    );
  `);

  // Record the resolved schema version after all migrations applied.
  try {
    db.prepare(`
      INSERT INTO schema_version (id, version, applied_at) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET version = excluded.version, applied_at = excluded.applied_at
    `).run(CURRENT_SCHEMA_VERSION, Date.now());
  } catch { /* schema_version may not exist on truly ancient DBs — ignore */ }
}

/** Read the on-disk schema version (0 if uninitialised). */
export function readSchemaVersion(db: Database.Database): number {
  try {
    const row = db.prepare('SELECT version FROM schema_version WHERE id = 1').get() as { version: number } | undefined;
    return row?.version ?? 0;
  } catch {
    return 0;
  }
}

