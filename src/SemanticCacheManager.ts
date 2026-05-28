import Database from 'better-sqlite3';
import { LocalSemanticVectorizer } from './localSemanticVectorizer.js';

const SEMANTIC_HIT_THRESHOLD = 0.68;
// High-confidence entries (heavily used, frequently hit) can match at a lower
// similarity threshold — they've proven reliable.  Low-confidence entries
// (newly inserted or never re-used) need a higher bar before being served.
const CONFIDENCE_THRESHOLD_BUMP = 0.06; // added to threshold when confidence < 0.4
const CONFIDENCE_THRESHOLD_EASE = 0.04; // subtracted from threshold when confidence > 0.8

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

export class SemanticCacheManager {
  private readonly db: Database.Database;
  private readonly vectorizer = new LocalSemanticVectorizer();
  private isInitialized = false;

  constructor(dbPath: string = 'prompt_semantic_cache.db') {
    try {
      this.db = new Database(dbPath);
    } catch (error) {
      console.error('[SemanticCacheManager] Failed to open SQLite database:', error);
      throw error;
    }
  }

  public async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      // Create table with the original schema so existing DBs aren't broken.
      this.db.exec(`
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
      `);

      // Safe migration — ADD COLUMN is idempotent via try/catch (SQLite <3.35
      // does not support IF NOT EXISTS for columns).
      for (const ddl of [
        'ALTER TABLE semantic_cache ADD COLUMN usage_count INTEGER DEFAULT 0',
        'ALTER TABLE semantic_cache ADD COLUMN confidence_score REAL DEFAULT 0.7',
        "ALTER TABLE semantic_cache ADD COLUMN workspace_id TEXT DEFAULT 'global'",
      ]) {
        try { this.db.exec(ddl); } catch { /* column already exists */ }
      }

      // Create workspace index only after the column is guaranteed to exist.
      try {
        this.db.exec('CREATE INDEX IF NOT EXISTS idx_workspace ON semantic_cache(workspace_id)');
      } catch { /* already exists */ }

      this.isInitialized = true;
    } catch (error) {
      console.error('[SemanticCacheManager] Initialization error:', error);
      throw error;
    }
  }

  private vectorize(text: string): Float32Array {
    return this.vectorizer.vectorize(text);
  }

  private calculateCosineSimilarity(left: Float32Array, right: Float32Array): number {
    return this.vectorizer.cosineSimilarity(left, right);
  }

  private calculateOverlapCoefficient(left: string[], right: string[]): number {
    const leftSet = new Set(left);
    const rightSet = new Set(right);

    if (leftSet.size === 0 || rightSet.size === 0) {
      return 0;
    }

    let sharedCount = 0;
    for (const token of leftSet) {
      if (rightSet.has(token)) {
        sharedCount++;
      }
    }

    return sharedCount / Math.min(leftSet.size, rightSet.size);
  }

  private buildComparisonFeatures(features: { tokens: string[]; signals: string[] }): string[] {
    const comparisonFeatures = new Set<string>();

    for (const token of features.tokens) {
      comparisonFeatures.add(`tok:${token}`);
    }

    for (const signal of features.signals) {
      comparisonFeatures.add(`sig:${signal}`);
    }

    for (let index = 0; index < features.tokens.length - 1; index++) {
      comparisonFeatures.add(`bi:${features.tokens[index]}__${features.tokens[index + 1]}`);
    }

    for (let index = 0; index < features.tokens.length - 2; index++) {
      comparisonFeatures.add(`tri:${features.tokens[index]}__${features.tokens[index + 1]}__${features.tokens[index + 2]}`);
    }

    return Array.from(comparisonFeatures);
  }

  private calculateSimilarityScore(queryText: string, queryVector: Float32Array, candidateText: string, candidateVector: Float32Array): number {
    const queryFeatures = this.vectorizer.analyze(queryText);
    const candidateFeatures = this.vectorizer.analyze(candidateText);

    const lexicalFeatures = this.buildComparisonFeatures(queryFeatures);
    const candidateLexicalFeatures = this.buildComparisonFeatures(candidateFeatures);
    const overlapCoefficient = this.calculateOverlapCoefficient(lexicalFeatures, candidateLexicalFeatures);
    const vectorSimilarity = this.calculateCosineSimilarity(queryVector, candidateVector);

    const score = (overlapCoefficient * 0.95) + (vectorSimilarity * 0.05);
    return Math.max(0, Math.min(1, score));
  }

  private bufferToFloat32Array(buffer: Buffer): Float32Array {
    return this.vectorizer.deserialize(buffer);
  }

  private async loadRows(workspaceId?: string): Promise<SemanticCacheRow[]> {
    const statement = workspaceId && workspaceId !== 'global'
      ? this.db.prepare(
          'SELECT id, raw_prompt, optimized_prompt, embedding, timestamp, usage_count, confidence_score, workspace_id FROM semantic_cache WHERE embedding IS NOT NULL AND (workspace_id = ? OR workspace_id = \'global\')'
        )
      : this.db.prepare(
          'SELECT id, raw_prompt, optimized_prompt, embedding, timestamp, usage_count, confidence_score, workspace_id FROM semantic_cache WHERE embedding IS NOT NULL'
        );

    return (workspaceId && workspaceId !== 'global'
      ? statement.all(workspaceId)
      : statement.all()) as SemanticCacheRow[];
  }

  private buildMatch(row: SemanticCacheRow, similarity: number): CacheSearchResult {
    return {
      id: row.id,
      rawPrompt: row.raw_prompt,
      optimizedPrompt: row.optimized_prompt,
      confidence: similarity,
      matchType: 'semantic',
      timestamp: row.timestamp,
    };
  }

  public async searchSimilarPrompts(rawPrompt: string, limit = 3, workspaceId?: string): Promise<CacheSearchResult[]> {
    if (!rawPrompt || rawPrompt.trim() === '') {
      return [];
    }

    try {
      if (!this.isInitialized) {
        await this.initialize();
      }

      const queryVector = this.vectorize(rawPrompt);
      const rows = await this.loadRows(workspaceId);
      const matches: CacheSearchResult[] = [];

      for (const row of rows) {
        if (!row.embedding) {
          continue;
        }

        const cachedVector = this.bufferToFloat32Array(row.embedding);
        if (cachedVector.length !== queryVector.length || cachedVector.length === 0) {
          continue;
        }

        const similarity = this.calculateSimilarityScore(rawPrompt, queryVector, row.raw_prompt, cachedVector);
        if (Number.isNaN(similarity) || similarity <= 0) {
          continue;
        }

        // Confidence-aware threshold: well-used entries are surfaced more readily,
        // brand-new entries need a stricter similarity before they appear.
        const rowConfidence = row.confidence_score ?? 0.7;
        let effectiveThreshold = SEMANTIC_HIT_THRESHOLD;
        if (rowConfidence < 0.4) { effectiveThreshold += CONFIDENCE_THRESHOLD_BUMP; }
        if (rowConfidence > 0.8) { effectiveThreshold -= CONFIDENCE_THRESHOLD_EASE; }
        if (similarity < effectiveThreshold * 0.5) { continue; } // hard lower bound for candidates list

        matches.push(this.buildMatch(row, similarity));
      }

      matches.sort((left, right) => right.confidence - left.confidence);
      return matches.slice(0, Math.max(1, limit));
    } catch (error) {
      console.error('[SemanticCacheManager] Semantic search failed:', error);
      return [];
    }
  }

  public async checkCache(rawPrompt: string, workspaceId?: string): Promise<CacheQueryResult | null> {
    if (!rawPrompt || rawPrompt.trim() === '') {
      return null;
    }

    try {
      if (!this.isInitialized) {
        await this.initialize();
      }

      // Exact match first — update usage stats on hit.
      const exactStatement = this.db.prepare('SELECT id, optimized_prompt, confidence_score FROM semantic_cache WHERE raw_prompt = ?');
      const exactResult = exactStatement.get(rawPrompt) as { id: number; optimized_prompt: string; confidence_score: number } | undefined;

      if (exactResult) {
        this.db.prepare(
          'UPDATE semantic_cache SET usage_count = usage_count + 1, confidence_score = MIN(0.95, COALESCE(confidence_score, 0.7) + 0.03) WHERE id = ?'
        ).run(exactResult.id);
        return {
          optimizedPrompt: exactResult.optimized_prompt,
          confidence: 1,
          matchType: 'exact',
        };
      }

      const matches = await this.searchSimilarPrompts(rawPrompt, 1, workspaceId);
      const bestMatch = matches[0];

      if (bestMatch) {
        // Apply confidence-aware threshold: a high-confidence cached entry can
        // match at slightly lower similarity.
        const rowConfidence = (this.db.prepare('SELECT confidence_score FROM semantic_cache WHERE id = ?').get(bestMatch.id) as { confidence_score?: number } | undefined)?.confidence_score ?? 0.7;
        let effectiveThreshold = SEMANTIC_HIT_THRESHOLD;
        if (rowConfidence > 0.8) { effectiveThreshold -= CONFIDENCE_THRESHOLD_EASE; }
        if (rowConfidence < 0.4) { effectiveThreshold += CONFIDENCE_THRESHOLD_BUMP; }

        if (bestMatch.confidence >= effectiveThreshold) {
          this.db.prepare(
            'UPDATE semantic_cache SET usage_count = usage_count + 1, confidence_score = MIN(0.95, COALESCE(confidence_score, 0.7) + 0.02) WHERE id = ?'
          ).run(bestMatch.id);
          return {
            optimizedPrompt: bestMatch.optimizedPrompt,
            confidence: bestMatch.confidence,
            matchType: 'semantic',
          };
        }
      }

      return null;
    } catch (error) {
      console.error('[SemanticCacheManager] Cache check failed:', error);
      return null;
    }
  }

  public async writeToCache(rawPrompt: string, optimizedPrompt: string, workspaceId?: string): Promise<void> {
    if (!rawPrompt || rawPrompt.trim() === '') {
      return;
    }

    try {
      if (!this.isInitialized) {
        await this.initialize();
      }

      const embedding = this.vectorize(rawPrompt);
      const buffer = this.vectorizer.serialize(embedding);
      const wsId = workspaceId ?? 'global';

      const statement = this.db.prepare(`
        INSERT INTO semantic_cache (raw_prompt, optimized_prompt, embedding, timestamp, usage_count, confidence_score, workspace_id)
        VALUES (?, ?, ?, ?, 0, 0.7, ?)
        ON CONFLICT(raw_prompt) DO UPDATE SET
          optimized_prompt = excluded.optimized_prompt,
          embedding = excluded.embedding,
          timestamp = excluded.timestamp,
          workspace_id = excluded.workspace_id
      `);

      statement.run(rawPrompt, optimizedPrompt, buffer, Date.now(), wsId);
    } catch (error) {
      console.error('[SemanticCacheManager] Write to cache failed:', error);
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
      `).get() as { total_entries: number; avg_confidence: number; total_hits: number; oldest_entry_ms: number; newest_entry_ms: number } | undefined;

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
        'DELETE FROM semantic_cache WHERE timestamp < ? AND COALESCE(confidence_score, 0.7) < 0.4'
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
    performanceScore = 0.0
  ): number {
    try {
      const getVer = this.db.prepare('SELECT MAX(version) as max_v FROM prompt_versions WHERE prompt_key = ?');
      const row = getVer.get(key) as { max_v: number | null } | undefined;
      const nextVer = (row?.max_v ?? 0) + 1;

      const insert = this.db.prepare(`
        INSERT INTO prompt_versions (prompt_key, version, raw_prompt, optimized_prompt, target_model, timestamp, performance_score, experiment_branch)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      insert.run(key, nextVer, rawPrompt, optimizedPrompt, targetModel, Date.now(), performanceScore, branch);
      return nextVer;
    } catch (error) {
      console.error('[SemanticCacheManager] Failed to record version:', error);
      return -1;
    }
  }

  public getVersions(key: string): Array<{
    version: number;
    raw_prompt: string;
    optimized_prompt: string;
    target_model: string;
    timestamp: number;
    performance_score: number;
    experiment_branch: string;
  }> {
    try {
      const statement = this.db.prepare(
        'SELECT version, raw_prompt, optimized_prompt, target_model, timestamp, performance_score, experiment_branch FROM prompt_versions WHERE prompt_key = ? ORDER BY version DESC'
      );
      return statement.all(key) as any[];
    } catch {
      return [];
    }
  }

  public rollbackToVersion(key: string, versionNum: number): { raw_prompt: string; optimized_prompt: string } | null {
    try {
      const statement = this.db.prepare(
        'SELECT raw_prompt, optimized_prompt FROM prompt_versions WHERE prompt_key = ? AND version = ?'
      );
      return statement.get(key, versionNum) as any || null;
    } catch {
      return null;
    }
  }

  public close(): void {
    try {
      this.db.close();
    } catch (error) {
      console.error('[SemanticCacheManager] Error closing SQLite connection:', error);
    }
  }
}