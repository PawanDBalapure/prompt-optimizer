import type Database from 'better-sqlite3';
import { CURRENT_SCHEMA_VERSION as MIGRATIONS_VERSION, runMigrations } from './migrations.js';

/**
 * Current logical schema version.  Bumped whenever a new entry is appended
 * to `MIGRATIONS` in `./migrations.ts`.  The on-disk DB tracks its own
 * version in `schema_version` so we never re-run an already-applied
 * migration.
 */
export const CURRENT_SCHEMA_VERSION = MIGRATIONS_VERSION;

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
  runMigrations(db);
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

