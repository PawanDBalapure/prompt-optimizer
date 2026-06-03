import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { countTokens } from './pricing.js';

/**
 * Partial (segment-level) cache reuse.
 *
 * The whole-prompt semantic cache only fires when an *entire* optimized prompt
 * matches.  In practice the bulk of a prompt's tokens are recurring context
 * blocks — the same file snippet, the same error log, the same workspace
 * memory — that get re-sent on every turn.  This store content-addresses each
 * context segment we have already emitted for a workspace; on a later turn, if
 * the identical block shows up again we replace its body with a compact
 * "reused from cache" reference instead of resending the full text.
 *
 * The store is purely additive and fault-tolerant: if the DB is unavailable or
 * a row write fails we simply fall back to sending the full segment.
 */

export interface ReusedSegment {
  /** Human-readable label (the section header / file path). */
  label: string;
  /** Stable reference id embedded in the optimized prompt. */
  ref: string;
  /** Tokens saved by referencing instead of resending this block. */
  tokens_saved: number;
  /** How many times this exact block has now been reused from cache. */
  hit_count: number;
  /** First time this block was seen (epoch ms). */
  first_seen: number;
}

export interface SegmentReuseResult {
  /** Context sections with recurring blocks collapsed to cache references. */
  sections: string[];
  /** Metadata for every block that was served from cache this turn. */
  reused: ReusedSegment[];
  /** Total tokens saved across all reused blocks. */
  tokens_saved: number;
}

interface SegmentRow {
  segment_hash: string;
  label: string;
  token_estimate: number;
  hit_count: number;
  first_seen: number;
}

/** Blocks smaller than this many tokens are never worth a cache reference. */
const MIN_SEGMENT_TOKENS = 24;

function hashSegment(body: string): string {
  return createHash('sha256').update(body).digest('hex').slice(0, 12);
}

function normalizeBody(body: string): string {
  return body
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .trim();
}

function splitSection(section: string): { header: string | null; body: string } {
  const trimmed = section.replace(/\s+$/, '');
  const newlineIndex = trimmed.indexOf('\n');
  if (trimmed.startsWith('# ') && newlineIndex !== -1) {
    return {
      header: trimmed.slice(0, newlineIndex).trim(),
      body: trimmed.slice(newlineIndex + 1),
    };
  }
  return { header: null, body: trimmed };
}

function deriveLabel(header: string | null, body: string): string {
  if (header) { return header.replace(/^#\s*/, '').trim(); }
  const firstLine = body.split(/\r?\n/).find((line) => line.trim() !== '') ?? '';
  const compact = firstLine.trim().slice(0, 48);
  return compact === '' ? 'context block' : compact;
}

export class SegmentReuseStore {
  private readonly db: Database.Database | null;
  private readonly enabled: boolean;

  constructor(db: Database.Database | null, enabled = true) {
    this.db = db;
    this.enabled = enabled;
  }

  /**
   * Replace any context section whose body has already been emitted for this
   * workspace with a compact cache reference.  Returns the rewritten sections
   * plus per-block reuse metadata.  Never throws — falls back to the originals.
   */
  applyReuse(workspaceId: string, sections: string[]): SegmentReuseResult {
    if (!this.enabled || this.db === null || sections.length === 0) {
      return { sections, reused: [], tokens_saved: 0 };
    }

    try {
      return this.applyReuseInner(this.db, workspaceId, sections);
    } catch {
      return { sections, reused: [], tokens_saved: 0 };
    }
  }

  private applyReuseInner(
    db: Database.Database,
    workspaceId: string,
    sections: string[],
  ): SegmentReuseResult {
    const select = db.prepare(
      'SELECT segment_hash, label, token_estimate, hit_count, first_seen FROM prompt_segments WHERE workspace_id = ? AND segment_hash = ?',
    );
    const bumpHit = db.prepare(
      'UPDATE prompt_segments SET hit_count = hit_count + 1, last_seen = ? WHERE workspace_id = ? AND segment_hash = ?',
    );
    const insert = db.prepare(
      `INSERT INTO prompt_segments
         (workspace_id, segment_hash, label, char_length, token_estimate, hit_count, first_seen, last_seen)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?)
       ON CONFLICT(workspace_id, segment_hash) DO NOTHING`,
    );

    const now = Date.now();
    const reused: ReusedSegment[] = [];
    let tokensSaved = 0;
    const seenThisTurn = new Set<string>();

    const rewritten = sections.map((section) => {
      const { header, body } = splitSection(section);
      const normalized = normalizeBody(body);
      if (normalized === '') { return section; }

      const bodyTokens = countTokens(normalized);
      if (bodyTokens < MIN_SEGMENT_TOKENS) { return section; }

      const hash = hashSegment(normalized);
      // Don't collapse two identical blocks within the same turn — the model
      // needs at least one full copy present to honor the reference.
      if (seenThisTurn.has(hash)) { return section; }

      const existing = select.get(workspaceId, hash) as SegmentRow | undefined;
      const label = deriveLabel(header, normalized);

      if (existing) {
        bumpHit.run(now, workspaceId, hash);
        const ref = `seg_${hash}`;
        const marker = this.buildMarker(header, label, ref, existing.first_seen, bodyTokens);
        const markerTokens = countTokens(marker);
        const saved = Math.max(0, bodyTokens - markerTokens);
        tokensSaved += saved;
        reused.push({
          label,
          ref,
          tokens_saved: saved,
          hit_count: existing.hit_count + 1,
          first_seen: existing.first_seen,
        });
        return marker;
      }

      insert.run(workspaceId, hash, label, normalized.length, bodyTokens, now, now);
      seenThisTurn.add(hash);
      return section;
    });

    return { sections: rewritten, reused, tokens_saved: tokensSaved };
  }

  private buildMarker(
    header: string | null,
    label: string,
    ref: string,
    firstSeen: number,
    savedTokens: number,
  ): string {
    const since = new Date(firstSeen).toISOString().slice(0, 10);
    const headerLine = header ? `${header}  [reused-from-cache]` : `# ${label}  [reused-from-cache]`;
    const note =
      `(Identical block already sent in this workspace (first seen ${since}); served from ` +
      `local cache, not resent. ~${savedTokens} tokens saved. ref: ${ref})`;
    return `${headerLine}\n${note}`;
  }
}
