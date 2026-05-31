/**
 * Time-ordered, dependency-free correlation ID generator (UUIDv7-shaped).
 *
 * Format: `<unix-ms-hex:12><random:20>` (32 hex chars, no dashes — short
 * enough to embed in log lines and email subjects, long enough to avoid
 * realistic collisions across workstations).  The leading 12 hex chars
 * are the millisecond timestamp so log lines naturally sort by time.
 *
 * We deliberately do **not** depend on Node's `crypto.randomUUID()` to keep
 * this module usable from web-workers and very old Node versions.
 */

import { randomBytes } from 'node:crypto';

export function newRequestId(): string {
  const ts = Date.now().toString(16).padStart(12, '0').slice(-12);
  const rand = randomBytes(10).toString('hex');
  return `${ts}${rand}`;
}

/** Validate that a string looks like one of our IDs (32 hex chars). */
export function isRequestId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value);
}
