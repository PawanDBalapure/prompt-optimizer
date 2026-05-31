import * as fs from 'node:fs';
import type Database from 'better-sqlite3';
import { CURRENT_SCHEMA_VERSION, readSchemaVersion } from '../cache/schema.js';
import { activeLogLevel } from './logger.js';
import { redactionStatus } from './redactor.js';

/**
 * Aggregate health probe.  Designed to be the single command an operator or
 * CI pipeline runs to determine whether a workspace's local store is
 * healthy.  The report is intentionally fully JSON-serializable.
 */

export interface HealthCheck {
  id: string;
  ok: boolean;
  detail?: string;
}

export interface HealthReport {
  ok: boolean;
  generated_at: number;
  schema_version: { on_disk: number; expected: number };
  pragmas: Record<string, string | number>;
  database: { path: string; size_bytes: number; wal_bytes: number };
  tables: Record<string, number>;
  redaction: { enabled: boolean; pii: boolean };
  log_level: string;
  checks: HealthCheck[];
}

const REQUIRED_TABLES = [
  'semantic_cache',
  'prompt_versions',
  'kg_nodes',
  'kg_edges',
  'peer_workspaces',
  'workspace_memory',
  'file_digest',
  'engine_metrics',
  'schema_version',
] as const;

export function runHealthCheck(db: Database.Database, dbPath: string): HealthReport {
  const checks: HealthCheck[] = [];

  // 1. Quick integrity check.
  let integrity: HealthCheck = { id: 'sqlite.integrity', ok: false };
  try {
    const row = db.prepare('PRAGMA quick_check').get() as { quick_check?: string };
    integrity = { id: 'sqlite.integrity', ok: row?.quick_check === 'ok', detail: row?.quick_check };
  } catch (err) {
    integrity = { id: 'sqlite.integrity', ok: false, detail: String(err) };
  }
  checks.push(integrity);

  // 2. Schema version matches expected.
  const onDisk = readSchemaVersion(db);
  checks.push({
    id: 'schema.version',
    ok: onDisk === CURRENT_SCHEMA_VERSION,
    detail: `on_disk=${onDisk} expected=${CURRENT_SCHEMA_VERSION}`,
  });

  // 3. All required tables exist.
  const tables: Record<string, number> = {};
  for (const name of REQUIRED_TABLES) {
    try {
      const row = db.prepare(`SELECT COUNT(*) AS c FROM ${name}`).get() as { c: number };
      tables[name] = row?.c ?? 0;
    } catch {
      tables[name] = -1;
    }
  }
  const missing = REQUIRED_TABLES.filter((t) => tables[t] === -1);
  checks.push({
    id: 'tables.exist',
    ok: missing.length === 0,
    detail: missing.length === 0 ? 'all required tables present' : `missing: ${missing.join(', ')}`,
  });

  // 4. Capture key pragmas for the report.
  const pragmas: Record<string, string | number> = {};
  for (const name of ['journal_mode', 'busy_timeout', 'synchronous', 'foreign_keys', 'page_size']) {
    try { pragmas[name] = db.pragma(name, { simple: true }) as string | number; }
    catch { pragmas[name] = 'unknown'; }
  }

  // 5. File sizes on disk.
  const fileStats = statSafe(dbPath);
  const walStats = statSafe(dbPath + '-wal');

  // 6. Peer-workspace DBs declared in `peer_workspaces`: every enabled peer
  //    must point to an existing readable file.  Broken peers don't fail
  //    optimization (the federation layer skips them) but they do degrade
  //    cross-workspace recall, so surface them in health.
  try {
    const rows = db.prepare(
      'SELECT label, db_path AS dbPath, enabled FROM peer_workspaces',
    ).all() as Array<{ label: string; dbPath: string; enabled: number }>;
    const enabled = rows.filter((r) => r.enabled === 1);
    const broken = enabled.filter((r) => {
      try { return !fs.statSync(r.dbPath).isFile(); }
      catch { return true; }
    });
    checks.push({
      id: 'peers.readable',
      ok: broken.length === 0,
      detail: broken.length === 0
        ? `${enabled.length} enabled peer(s) reachable`
        : `unreachable: ${broken.map((b) => `${b.label}@${b.dbPath}`).join(', ')}`,
    });
  } catch (err) {
    checks.push({ id: 'peers.readable', ok: false, detail: String(err) });
  }

  const ok = checks.every((c) => c.ok);

  return {
    ok,
    generated_at: Date.now(),
    schema_version: { on_disk: onDisk, expected: CURRENT_SCHEMA_VERSION },
    pragmas,
    database: { path: dbPath, size_bytes: fileStats.size, wal_bytes: walStats.size },
    tables,
    redaction: redactionStatus(),
    log_level: activeLogLevel(),
    checks,
  };
}

function statSafe(p: string): { size: number } {
  try { return { size: fs.statSync(p).size }; }
  catch { return { size: 0 }; }
}
