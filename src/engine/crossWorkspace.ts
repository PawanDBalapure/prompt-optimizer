import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import { LocalSemanticVectorizer } from '../localSemanticVectorizer.js';
import { calculateSimilarityScore, SEMANTIC_HIT_THRESHOLD } from '../cache/similarity.js';

/**
 * Cross-workspace cache federation: when the local cache misses, optionally
 * fan out to other workspaces' SQLite caches the user has registered, and
 * surface the closest semantic match.  All access is **read-only** and the
 * peer paths are validated to exist before being opened, with each handle
 * cached for the lifetime of the manager and closed in `dispose()`.
 *
 * Peer paths are stored in the main cache DB's `peer_workspaces` table so
 * adding a peer survives restarts (see schema in `cache/schema.ts`).
 */

export interface PeerWorkspace {
  id: number;
  label: string;
  dbPath: string;
  enabled: boolean;
  addedAt: number;
}

export interface CrossWorkspaceMatch {
  peerLabel: string;
  peerWorkspaceId: string;
  rawPrompt: string;
  optimizedPrompt: string;
  confidence: number;
}

const MAX_PEER_MATCHES = 3;

export class CrossWorkspaceFederation {
  private readonly handles = new Map<string, Database.Database>();
  private readonly vectorizer = new LocalSemanticVectorizer();

  constructor(private readonly mainDb: Database.Database) {}

  /** List all registered peers (including disabled). */
  list(): PeerWorkspace[] {
    try {
      const rows = this.mainDb.prepare(
        'SELECT id, label, db_path AS dbPath, enabled, added_at AS addedAt FROM peer_workspaces ORDER BY added_at DESC',
      ).all() as Array<{ id: number; label: string; dbPath: string; enabled: number; addedAt: number }>;
      return rows.map((row) => ({
        id: row.id,
        label: row.label,
        dbPath: row.dbPath,
        enabled: row.enabled === 1,
        addedAt: row.addedAt,
      }));
    } catch {
      return [];
    }
  }

  /** Register a peer workspace cache DB.  Path is validated to exist. */
  addPeer(label: string, dbPath: string): { ok: boolean; error?: string } {
    const safeLabel = String(label).trim().slice(0, 80);
    const safePath = String(dbPath).trim();
    if (!safeLabel || !safePath) { return { ok: false, error: 'label and dbPath are required' }; }
    if (!fs.existsSync(safePath)) { return { ok: false, error: `db path does not exist: ${safePath}` }; }

    try {
      const stat = fs.statSync(safePath);
      if (!stat.isFile()) { return { ok: false, error: 'path is not a file' }; }
    } catch {
      return { ok: false, error: 'cannot stat db path' };
    }

    try {
      this.mainDb.prepare(`
        INSERT INTO peer_workspaces (label, db_path, enabled, added_at)
        VALUES (?, ?, 1, ?)
        ON CONFLICT(db_path) DO UPDATE SET label = excluded.label, enabled = 1
      `).run(safeLabel, safePath, Date.now());
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'insert failed' };
    }
  }

  /** Remove a peer by db_path. Closes any cached read handle. */
  removePeer(dbPath: string): boolean {
    try {
      const handle = this.handles.get(dbPath);
      if (handle) { try { handle.close(); } catch { /* ignore */ } this.handles.delete(dbPath); }
      this.mainDb.prepare('DELETE FROM peer_workspaces WHERE db_path = ?').run(dbPath);
      return true;
    } catch {
      return false;
    }
  }

  /** Toggle the enabled flag without removing the registration. */
  setEnabled(dbPath: string, enabled: boolean): boolean {
    try {
      this.mainDb.prepare('UPDATE peer_workspaces SET enabled = ? WHERE db_path = ?')
        .run(enabled ? 1 : 0, dbPath);
      return true;
    } catch {
      return false;
    }
  }

  /** Search all enabled peers and return the strongest semantic matches. */
  searchPeers(rawPrompt: string, limit = MAX_PEER_MATCHES): CrossWorkspaceMatch[] {
    if (!rawPrompt.trim()) { return []; }

    const peers = this.list().filter((p) => p.enabled);
    if (peers.length === 0) { return []; }

    const queryVector = this.vectorizer.vectorize(rawPrompt);
    const collected: CrossWorkspaceMatch[] = [];

    for (const peer of peers) {
      const handle = this.openHandle(peer.dbPath);
      if (!handle) { continue; }
      try {
        const rows = handle.prepare(
          'SELECT raw_prompt, optimized_prompt, embedding, workspace_id FROM semantic_cache',
        ).all() as Array<{
          raw_prompt: string;
          optimized_prompt: string;
          embedding: Buffer | null;
          workspace_id: string;
        }>;

        for (const row of rows) {
          if (!row.embedding) { continue; }
          const cachedVector = this.vectorizer.deserialize(row.embedding);
          if (cachedVector.length !== queryVector.length || cachedVector.length === 0) { continue; }
          const similarity = calculateSimilarityScore(
            this.vectorizer, rawPrompt, queryVector, row.raw_prompt, cachedVector,
          );
          if (Number.isNaN(similarity) || similarity < SEMANTIC_HIT_THRESHOLD) { continue; }
          collected.push({
            peerLabel: peer.label,
            peerWorkspaceId: row.workspace_id,
            rawPrompt: row.raw_prompt,
            optimizedPrompt: row.optimized_prompt,
            confidence: similarity,
          });
        }
      } catch {
        // unreadable peer — skip
      }
    }

    collected.sort((a, b) => b.confidence - a.confidence);
    return collected.slice(0, limit);
  }

  /** Format peer matches as additional knowledge sections for the prompt. */
  static formatPeerSections(matches: CrossWorkspaceMatch[]): string[] {
    return matches.map((match) => {
      const confidencePct = Math.round(match.confidence * 100);
      return `# Peer workspace (${match.peerLabel}) — similar prior prompt (${confidencePct}% match)\nPrior prompt: ${match.rawPrompt}\nPrior optimization:\n${match.optimizedPrompt}`;
    });
  }

  dispose(): void {
    for (const handle of this.handles.values()) {
      try { handle.close(); } catch { /* ignore */ }
    }
    this.handles.clear();
  }

  private openHandle(dbPath: string): Database.Database | null {
    const cached = this.handles.get(dbPath);
    if (cached) { return cached; }
    if (!fs.existsSync(dbPath)) { return null; }
    try {
      const handle = new Database(dbPath, { readonly: true, fileMustExist: true });
      this.handles.set(dbPath, handle);
      return handle;
    } catch {
      return null;
    }
  }
}
