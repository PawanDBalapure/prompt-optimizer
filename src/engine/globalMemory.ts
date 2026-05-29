import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';

import { initializeSchema } from '../cache/schema.js';
import type { CrossWorkspaceFederation } from './crossWorkspace.js';

/**
 * Tier L1 (user-global) memory: a single SQLite DB under the user's home
 * directory that every workspace federates against.  This is what makes
 * Prompt Optimizer memory follow the *user* across projects without any
 * server.  Implemented as a peer workspace so all existing recall paths
 * (federation, recall service, etc.) work unchanged.
 *
 * Disabled by setting PROMPT_OPT_DISABLE_GLOBAL=1 for hermetic test runs.
 */

export const USER_GLOBAL_LABEL = '__user_global__';

/** Default location of the user-global memory DB. Overridable via env. */
export function getGlobalDbPath(): string {
  const overridden = process.env.PROMPT_OPT_GLOBAL_DB;
  if (overridden && overridden.trim().length > 0) {
    return path.resolve(overridden.trim());
  }
  return path.join(os.homedir(), '.promptoptimizer', 'global.db');
}

/** Create the global DB (and its parent directory) if it does not exist. */
export function ensureGlobalDatabase(): string {
  const destination = getGlobalDbPath();
  if (!fs.existsSync(destination)) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const db = new Database(destination);
    try {
      initializeSchema(db);
    } finally {
      db.close();
    }
  }
  return destination;
}

/**
 * Auto-register the global DB as a peer of the given workspace.  Safe to
 * call from `PromptProxyEngine.initialize()` on every startup; no-ops when:
 *
 *   - the env disables it,
 *   - the main DB *is* the global DB (avoid self-reference),
 *   - the peer is already registered.
 *
 * Never throws — federation failures must not break engine initialization.
 */
export function ensureGlobalPeer(
  federation: CrossWorkspaceFederation,
  mainDbPath: string,
): { registered: boolean; alreadyPresent: boolean; skipped: boolean; reason?: string } {
  if (process.env.PROMPT_OPT_DISABLE_GLOBAL === '1') {
    return { registered: false, alreadyPresent: false, skipped: true, reason: 'disabled' };
  }
  try {
    const globalPath = ensureGlobalDatabase();
    if (path.resolve(globalPath) === path.resolve(mainDbPath)) {
      return { registered: false, alreadyPresent: false, skipped: true, reason: 'self' };
    }
    const existing = federation.list();
    if (existing.some((p) => path.resolve(p.dbPath) === path.resolve(globalPath))) {
      return { registered: false, alreadyPresent: true, skipped: false };
    }
    const result = federation.addPeer(USER_GLOBAL_LABEL, globalPath);
    return { registered: !!result.ok, alreadyPresent: false, skipped: false, reason: result.error };
  } catch (error) {
    return {
      registered: false,
      alreadyPresent: false,
      skipped: true,
      reason: error instanceof Error ? error.message : 'unknown',
    };
  }
}
