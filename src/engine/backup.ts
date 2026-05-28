import * as fs from 'node:fs';
import * as path from 'node:path';
import type Database from 'better-sqlite3';

/**
 * Online backup using SQLite's safe Online Backup API.  Unlike a plain file
 * copy this works even while the source DB is open and being written to.
 * Returns a serializable report so the CLI can JSON-emit it.
 */

export interface BackupReport {
  ok: boolean;
  source_path: string;
  destination_path: string;
  bytes: number;
  duration_ms: number;
  error?: string;
}

export async function exportDatabase(
  db: Database.Database,
  sourcePath: string,
  destinationPath: string,
): Promise<BackupReport> {
  const started = Date.now();
  const absDest = path.resolve(destinationPath);
  try {
    await fs.promises.mkdir(path.dirname(absDest), { recursive: true });
  } catch { /* destination dir may already exist or be a root */ }

  try {
    // better-sqlite3 exposes a promise-returning backup() method.
    // We cast through unknown because the typings vary between versions.
    const backup = (db as unknown as { backup: (dest: string) => Promise<{ totalPages: number; remainingPages: number }> }).backup;
    if (typeof backup === 'function') {
      await backup.call(db, absDest);
    } else {
      // Fallback for older bindings: copy the file after a checkpoint.
      try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* ignore */ }
      await fs.promises.copyFile(sourcePath, absDest);
    }
    const size = (await fs.promises.stat(absDest)).size;
    return {
      ok: true,
      source_path: sourcePath,
      destination_path: absDest,
      bytes: size,
      duration_ms: Date.now() - started,
    };
  } catch (err) {
    return {
      ok: false,
      source_path: sourcePath,
      destination_path: absDest,
      bytes: 0,
      duration_ms: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
