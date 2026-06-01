import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { LocalSemanticVectorizer } from './localSemanticVectorizer.js';
import type { Vectorizer } from './vector/vectorizer.js';
import { initializeSchema } from './cache/schema.js';
import {
  calculateSimilarityScore,
  effectiveThreshold,
} from './cache/similarity.js';
import {
  PromptVersionRow,
  getVersions as getVersionsImpl,
  recordVersion as recordVersionImpl,
  rollbackToVersion as rollbackToVersionImpl,
} from './cache/versioning.js';
import { createLogger } from './engine/logger.js';
import { redactForPersistence } from './engine/redactor.js';
import { MetricsRegistry } from './engine/metrics.js';
import { recordAuditEvent } from './engine/auditLog.js';

/**
 * Hard cap on how many cache rows we deserialise per similarity scan.  A
 * full table scan was scaling O(n) on workspaces with hundreds of thousands
 * of cached prompts; this cap keeps the scan bounded while still surfacing
 * the highest-quality candidates (most-recently-used wins ties).
 *
 * Override at runtime via `PROMPT_OPT_MAX_CANDIDATES`.
 */
const CANDIDATE_CAP_DEFAULT = 2000;
function resolveCandidateCap(): number {
  const raw = process.env.PROMPT_OPT_MAX_CANDIDATES;
  if (!raw) { return CANDIDATE_CAP_DEFAULT; }
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(50_000, n) : CANDIDATE_CAP_DEFAULT;
}

const log = createLogger('SemanticCacheManager');

export interface CacheQueryResult {
  optimizedPrompt: string;
  confidence: number;
  matchType: 'exact' | 'semantic';
}

export interface CacheSearchResult extends CacheQueryResult {
  id: number;
  rawPrompt: string;
  timestamp: number;
}

export interface CacheStats {
  total_entries: number;
  avg_confidence: number;
  total_hits: number;
  oldest_entry_ms: number;
  newest_entry_ms: number;
}

interface SemanticCacheRow {
  id: number;
  raw_prompt: string;
  optimized_prompt: string;
  embedding: Buffer | null;
  timestamp: number;
  usage_count: number;
  confidence_score: number;
  workspace_id: string;
}

const ROW_COLUMNS = 'id, raw_prompt, optimized_prompt, embedding, timestamp, usage_count, confidence_score, workspace_id';

export class SemanticCacheManager {
  private readonly db: Database.Database;
  private readonly vectorizer: Vectorizer = new LocalSemanticVectorizer();
  private readonly dbPath: string;
  private isInitialized = false;
  private metricsRegistry: MetricsRegistry | null = null;

  constructor(dbPath: string = 'prompt_semantic_cache.db') {
    this.dbPath = dbPath;
    try {
      // Ensure the parent directory exists before SQLite tries to open the
      // file. SQLite does not create missing directories, which is the most
      // common cause of "Failed to open SQLite database" on a fresh machine.
      // Skip for in-memory / URI databases.
      if (dbPath !== ':memory:' && !dbPath.startsWith('file:')) {
        const dir = path.dirname(path.resolve(dbPath));
        if (dir && dir !== '.') { fs.mkdirSync(dir, { recursive: true }); }
      }
      this.db = new Database(dbPath);
    } catch (error) {
      log.error('Failed to open SQLite database', { dbPath, error: String(error) });
      throw error;
    }
  }

  public async initialize(): Promise<void> {
    if (this.isInitialized) { return; }
    try {
      initializeSchema(this.db);
      this.metricsRegistry = new MetricsRegistry(this.db);
      this.isInitialized = true;
    } catch (error) {
      log.error('Initialization error', { error: String(error) });
      throw error;
    }
  }

  /** Path used to open the underlying SQLite DB (for backup / health). */
  public databasePath(): string { return this.dbPath; }

  /** Lazy accessor for the metrics registry. */
  public metrics(): MetricsRegistry | null { return this.metricsRegistry; }

  public async searchSimilarPrompts(
    rawPrompt: string,
    limit = 3,
    workspaceId?: string,
  ): Promise<CacheSearchResult[]> {
    if (!rawPrompt || rawPrompt.trim() === '') { return []; }

    try {
      if (!this.isInitialized) { await this.initialize(); }

      const queryVector = this.vectorizer.vectorize(rawPrompt);
      const rows = this.loadRows(workspaceId);
      const matches: CacheSearchResult[] = [];

      for (const row of rows) {
        if (!row.embedding) { continue; }

        const cachedVector = this.vectorizer.deserialize(row.embedding);
        if (cachedVector.length !== queryVector.length || cachedVector.length === 0) {
          continue;
        }

        const similarity = calculateSimilarityScore(
          this.vectorizer, rawPrompt, queryVector, row.raw_prompt, cachedVector,
        );
        if (Number.isNaN(similarity) || similarity <= 0) { continue; }

        const threshold = effectiveThreshold(row.confidence_score ?? 0.7);
        if (similarity < threshold * 0.5) { continue; }

        matches.push({
          id: row.id,
          rawPrompt: row.raw_prompt,
          optimizedPrompt: row.optimized_prompt,
          confidence: similarity,
          matchType: 'semantic',
          timestamp: row.timestamp,
        });
      }

      matches.sort((l, r) => r.confidence - l.confidence);
      return matches.slice(0, Math.max(1, limit));
    } catch (error) {
      log.error('Semantic search failed', { error: String(error) });
      this.metricsRegistry?.increment('errors.cache_semantic_search');
      return [];
    }
  }

  public async checkCache(rawPrompt: string, workspaceId?: string): Promise<CacheQueryResult | null> {
    if (!rawPrompt || rawPrompt.trim() === '') { return null; }

    try {
      if (!this.isInitialized) { await this.initialize(); }

      const exact = this.findExactMatch(rawPrompt, workspaceId ?? 'global');
      if (exact) {
        this.bumpUsage(exact.id, 0.03);
        return { optimizedPrompt: exact.optimized_prompt, confidence: 1, matchType: 'exact' };
      }

      const [bestMatch] = await this.searchSimilarPrompts(rawPrompt, 1, workspaceId);
      if (!bestMatch) { return null; }

      const rowConfidence =
        (this.db.prepare('SELECT confidence_score FROM semantic_cache WHERE id = ?').get(bestMatch.id) as
          { confidence_score?: number } | undefined)?.confidence_score ?? 0.7;

      if (bestMatch.confidence >= effectiveThreshold(rowConfidence)) {
        this.bumpUsage(bestMatch.id, 0.02);
        return {
          optimizedPrompt: bestMatch.optimizedPrompt,
          confidence: bestMatch.confidence,
          matchType: 'semantic',
        };
      }
      return null;
    } catch (error) {
      log.error('Cache check failed', { error: String(error) });
      this.metricsRegistry?.increment('errors.cache_check');
      return null;
    }
  }

  public async writeToCache(
    rawPrompt: string,
    optimizedPrompt: string,
    workspaceId?: string,
  ): Promise<void> {
    if (!rawPrompt || rawPrompt.trim() === '') { return; }

    try {
      if (!this.isInitialized) { await this.initialize(); }

      const embedding = this.vectorizer.vectorize(rawPrompt);
      const buffer = this.vectorizer.serialize(embedding);
      const wsId = workspaceId ?? 'global';

      // Redact the *persisted* copy of the optimized prompt only.  The version
      // returned synchronously to the caller is untouched (see processRequest);
      // this prevents secrets from leaking into the on-disk cache while
      // keeping the live response faithful to the user's intent.
      const redaction = redactForPersistence(optimizedPrompt);
      if (redaction.hits.length > 0) {
        this.metricsRegistry?.increment('cache.redaction_hits', redaction.hits.reduce((s, h) => s + h.count, 0));
        log.debug('Redacted secrets before cache persistence', { hits: redaction.hits });
      }

      // workspace_id is intentionally not updated on conflict: the first writer
      // owns the entry; cross-workspace queries still get a semantic hit.
      this.db.prepare(`
        INSERT INTO semantic_cache (raw_prompt, optimized_prompt, embedding, timestamp, usage_count, confidence_score, workspace_id)
        VALUES (?, ?, ?, ?, 0, 0.7, ?)
        ON CONFLICT(raw_prompt) DO UPDATE SET
          optimized_prompt = excluded.optimized_prompt,
          embedding = excluded.embedding,
          timestamp = excluded.timestamp
      `).run(rawPrompt, redaction.redacted, buffer, Date.now(), wsId);
      this.metricsRegistry?.increment('cache.writes');
      recordAuditEvent(this.db, 'cache.write', {
        workspaceId: wsId,
        prompt: rawPrompt,
        redactionHits: redaction.hits.reduce((s, h) => s + h.count, 0),
      });
    } catch (error) {
      log.error('Write to cache failed', { error: String(error) });
    }
  }

  public clearCache(): void {
    try {
      this.db.exec('DELETE FROM semantic_cache');
      recordAuditEvent(this.db, 'cache.clear', {});
    } catch (error) {
      log.error('Failed to clear database cache', { error: String(error) });
      this.metricsRegistry?.increment('errors.cache_clear');
    }
  }

  public getStats(): CacheStats {
    try {
      const row = this.db.prepare(`
        SELECT
          COUNT(*) AS total_entries,
          AVG(COALESCE(confidence_score, 0.7)) AS avg_confidence,
          SUM(COALESCE(usage_count, 0)) AS total_hits,
          MIN(timestamp) AS oldest_entry_ms,
          MAX(timestamp) AS newest_entry_ms
        FROM semantic_cache
      `).get() as CacheStats | undefined;

      return {
        total_entries: row?.total_entries ?? 0,
        avg_confidence: Number((row?.avg_confidence ?? 0).toFixed(3)),
        total_hits: row?.total_hits ?? 0,
        oldest_entry_ms: row?.oldest_entry_ms ?? 0,
        newest_entry_ms: row?.newest_entry_ms ?? 0,
      };
    } catch {
      return { total_entries: 0, avg_confidence: 0, total_hits: 0, oldest_entry_ms: 0, newest_entry_ms: 0 };
    }
  }

  public pruneStale(olderThanDays = 30): number {
    try {
      const cutoffMs = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
      const result = this.db.prepare(
        'DELETE FROM semantic_cache WHERE timestamp < ? AND COALESCE(confidence_score, 0.7) < 0.4',
      ).run(cutoffMs);
      return result.changes;
    } catch (error) {
      log.error('Prune failed', { error: String(error) });
      this.metricsRegistry?.increment('errors.cache_prune');
      return 0;
    }
  }

  public recordVersion(
    key: string,
    rawPrompt: string,
    optimizedPrompt: string,
    targetModel: string,
    branch = 'main',
    performanceScore = 0.0,
  ): number {
    return recordVersionImpl(this.db, key, rawPrompt, optimizedPrompt, targetModel, branch, performanceScore);
  }

  public getVersions(key: string): PromptVersionRow[] {
    return getVersionsImpl(this.db, key);
  }

  public rollbackToVersion(
    key: string,
    versionNum: number,
  ): { raw_prompt: string; optimized_prompt: string } | null {
    return rollbackToVersionImpl(this.db, key, versionNum);
  }

  public close(): void {
    try {
      this.db.close();
    } catch (error) {
      log.error('Error closing SQLite connection', { error: String(error) });
    }
  }

  /**
   * Exposes the underlying SQLite handle so adjacent modules (knowledge graph,
   * cross-workspace federation, workspace memory persistence) can share the
   * already-open connection without opening a second one.  Intentionally
   * package-internal in spirit — only `PromptProxyEngine` calls this.
   */
  public rawDatabase(): Database.Database {
    return this.db;
  }

  private loadRows(workspaceId?: string): SemanticCacheRow[] {
    const cap = resolveCandidateCap();
    const scoped = workspaceId !== undefined && workspaceId !== 'global';
    // ORDER BY usage_count DESC, timestamp DESC — keeps highest-signal rows
    // in the candidate set when the cap clips the long tail.
    const statement = scoped
      ? this.db.prepare(
          `SELECT ${ROW_COLUMNS} FROM semantic_cache
             WHERE embedding IS NOT NULL
               AND (workspace_id = ? OR workspace_id = 'global')
             ORDER BY COALESCE(usage_count, 0) DESC, timestamp DESC
             LIMIT ?`,
        )
      : this.db.prepare(
          `SELECT ${ROW_COLUMNS} FROM semantic_cache
             WHERE embedding IS NOT NULL
             ORDER BY COALESCE(usage_count, 0) DESC, timestamp DESC
             LIMIT ?`,
        );
    return (scoped ? statement.all(workspaceId, cap) : statement.all(cap)) as SemanticCacheRow[];
  }

  private findExactMatch(
    rawPrompt: string,
    wsId: string,
  ): { id: number; optimized_prompt: string; confidence_score: number } | undefined {
    return this.db.prepare(
      `SELECT id, optimized_prompt, confidence_score FROM semantic_cache
       WHERE raw_prompt = ?
         AND (workspace_id = ? OR workspace_id = 'global')
       ORDER BY CASE WHEN workspace_id = ? THEN 0 ELSE 1 END
       LIMIT 1`,
    ).get(rawPrompt, wsId, wsId) as
      { id: number; optimized_prompt: string; confidence_score: number } | undefined;
  }

  private bumpUsage(id: number, confidenceDelta: number): void {
    this.db.prepare(
      'UPDATE semantic_cache SET usage_count = usage_count + 1, confidence_score = MIN(0.95, COALESCE(confidence_score, 0.7) + ?) WHERE id = ?',
    ).run(confidenceDelta, id);
  }
}
