import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { reportEngineError } from './logger.js';

/**
 * Append-only audit log.  Every row records *that* an event happened
 * (cache write, version recorded, redaction triggered, peer add/remove)
 * without storing the underlying prompt by default — the prompt is
 * SHA-256 hashed.  Set `PROMPT_OPT_AUDIT_RAW=1` to keep raw bodies for
 * forensic investigations (subject to your security review).
 *
 * Designed for SOC-2 / ISO-27001 evidence:
 *   - append-only (no UPDATE / DELETE outside `MaintenanceService.purge`)
 *   - tamper-evident via per-row `prev_hash` chain
 *   - emits-and-recovers — never throws back into the optimizer
 */

export type AuditEvent =
  | 'cache.write'
  | 'cache.clear'
  | 'cache.prune'
  | 'version.record'
  | 'version.rollback'
  | 'peer.add'
  | 'peer.remove'
  | 'peer.toggle'
  | 'redaction.fired'
  | 'maintenance.run';

export interface AuditPayload {
  workspaceId?: string;
  actor?: string;
  prompt?: string;
  redactionHits?: number;
  details?: Record<string, unknown>;
}

const STORE_RAW = (process.env.PROMPT_OPT_AUDIT_RAW ?? '').toLowerCase() === '1';
const ENABLED   = (process.env.PROMPT_OPT_AUDIT_ENABLED ?? '1').toLowerCase() !== '0';

let prevHashCache: string | null = null;

function hashPrompt(prompt: string): string {
  return createHash('sha256').update(prompt, 'utf8').digest('hex');
}

function chainHash(prev: string, row: string): string {
  return createHash('sha256').update(prev + '|' + row, 'utf8').digest('hex');
}

function loadLastHash(db: Database.Database): string {
  if (prevHashCache !== null) { return prevHashCache; }
  try {
    const row = db.prepare(
      'SELECT row_hash FROM audit_log ORDER BY id DESC LIMIT 1',
    ).get() as { row_hash?: string } | undefined;
    prevHashCache = row?.row_hash ?? '';
  } catch {
    prevHashCache = '';
  }
  return prevHashCache;
}

export function recordAuditEvent(
  db: Database.Database,
  event: AuditEvent,
  payload: AuditPayload = {},
): void {
  if (!ENABLED) { return; }
  try {
    const ts = Date.now();
    const promptHash = payload.prompt ? hashPrompt(payload.prompt) : '';
    const promptRaw = STORE_RAW && payload.prompt ? payload.prompt : null;
    const detailsJson = payload.details ? JSON.stringify(payload.details) : null;
    const prevHash = loadLastHash(db);
    const rowSig = [event, payload.workspaceId ?? '', payload.actor ?? '',
                    promptHash, payload.redactionHits ?? 0, detailsJson ?? ''].join('|');
    const rowHash = chainHash(prevHash, rowSig);

    db.prepare(`
      INSERT INTO audit_log (
        ts, event, workspace_id, actor, prompt_hash, prompt_raw,
        redaction_hits, details, prev_hash, row_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      ts,
      event,
      payload.workspaceId ?? null,
      payload.actor ?? null,
      promptHash || null,
      promptRaw,
      payload.redactionHits ?? 0,
      detailsJson,
      prevHash || null,
      rowHash,
    );
    prevHashCache = rowHash;
  } catch (err) {
    reportEngineError('audit_write', err, { level: 'warn' });
  }
}

/** Read the last `limit` audit rows (newest first). */
export function readAuditTail(
  db: Database.Database,
  limit = 100,
): Array<{
  id: number; ts: number; event: string; workspace_id: string | null; actor: string | null;
  prompt_hash: string | null; redaction_hits: number; details: string | null;
  prev_hash: string | null; row_hash: string;
}> {
  try {
    return db.prepare(
      `SELECT id, ts, event, workspace_id, actor, prompt_hash, redaction_hits,
              details, prev_hash, row_hash
         FROM audit_log
         ORDER BY id DESC
         LIMIT ?`,
    ).all(Math.max(1, Math.min(10_000, limit))) as Array<{
      id: number; ts: number; event: string; workspace_id: string | null; actor: string | null;
      prompt_hash: string | null; redaction_hits: number; details: string | null;
      prev_hash: string | null; row_hash: string;
    }>;
  } catch {
    return [];
  }
}

/** Walk the chain forwards and verify every `row_hash` matches its computed value. */
export function verifyAuditChain(db: Database.Database): { ok: boolean; broken_at?: number; checked: number } {
  try {
    const rows = db.prepare(
      `SELECT id, event, workspace_id, actor, prompt_hash, redaction_hits,
              details, prev_hash, row_hash
         FROM audit_log
         ORDER BY id ASC`,
    ).all() as Array<{
      id: number; event: string; workspace_id: string | null; actor: string | null;
      prompt_hash: string | null; redaction_hits: number; details: string | null;
      prev_hash: string | null; row_hash: string;
    }>;
    let prev = '';
    for (const row of rows) {
      const rowSig = [
        row.event, row.workspace_id ?? '', row.actor ?? '',
        row.prompt_hash ?? '', row.redaction_hits, row.details ?? '',
      ].join('|');
      const expected = chainHash(prev, rowSig);
      if (expected !== row.row_hash || (row.prev_hash ?? '') !== prev) {
        return { ok: false, broken_at: row.id, checked: rows.length };
      }
      prev = row.row_hash;
    }
    return { ok: true, checked: rows.length };
  } catch {
    return { ok: false, checked: 0 };
  }
}

/** Reset the in-process cache (test-only). */
export function _resetAuditCache(): void { prevHashCache = null; }
