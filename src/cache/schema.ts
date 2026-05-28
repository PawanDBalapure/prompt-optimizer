import type Database from 'better-sqlite3';

/** Idempotently create tables, indexes, and migrations for the semantic cache. */
export function initializeSchema(db: Database.Database): void {
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
}

