import Database from 'better-sqlite3';
import { LocalSemanticVectorizer } from './localSemanticVectorizer.js';
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
  private readonly vectorizer = new LocalSemanticVectorizer();
  private readonly dbPath: string;
  private isInitialized = false;
  private metricsRegistry: MetricsRegistry | null = null;

  constructor(dbPath: string = 'prompt_semantic_cache.db') {
    this.dbPath = dbPath;
    try {
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
      console.error('[SemanticCacheManager] Semantic search failed:', error);
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
      console.error('[SemanticCacheManager] Cache check failed:', error);
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
    } catch (error) {
      log.error('Write to cache failed', { error: String(error) });
    }
  }

  public clearCache(): void {
    try {
      this.db.exec('DELETE FROM semantic_cache');
    } catch (error) {
      console.error('[SemanticCacheManager] Failed to clear database cache:', error);
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
      console.error('[SemanticCacheManager] Prune failed:', error);
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
    const scoped = workspaceId !== undefined && workspaceId !== 'global';
    const statement = scoped
      ? this.db.prepare(`SELECT ${ROW_COLUMNS} FROM semantic_cache WHERE embedding IS NOT NULL AND (workspace_id = ? OR workspace_id = 'global')`)
      : this.db.prepare(`SELECT ${ROW_COLUMNS} FROM semantic_cache WHERE embedding IS NOT NULL`);
    return (scoped ? statement.all(workspaceId) : statement.all()) as SemanticCacheRow[];
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
