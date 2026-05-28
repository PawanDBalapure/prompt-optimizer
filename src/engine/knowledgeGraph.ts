import type Database from 'better-sqlite3';
import type { PromptIDEContext } from '../contracts.js';
import type { RepoStackInfo } from '../RepoAwareness.js';
import { STOP_WORDS } from '../vector/lexicon.js';

/**
 * Lightweight knowledge graph inspired by the Graphify pattern: every prompt,
 * file, framework, and inferred concept becomes a node; references and
 * co-occurrences become weighted directed edges.  Storage lives in the
 * existing SQLite cache (see `cache/schema.ts`) so no extra deps are added.
 *
 * The KG is used in two directions:
 *   1. **Harvest** — on every optimization pass, recordWorkspaceGraph() adds
 *      nodes/edges derived from the active IDE context and stack info.
 *   2. **Suggest** — collectGraphContext() walks the graph from terms in the
 *      raw prompt and returns short text summaries of related nodes that the
 *      optimizer can then prepend to the prompt as long-context memory.
 */

export type KgNodeType = 'prompt' | 'file' | 'framework' | 'language' | 'orm' | 'auth' | 'concept';

export interface KgNode {
  id: number;
  workspaceId: string;
  nodeType: KgNodeType;
  name: string;
  summary: string;
  updatedAt: number;
}

export interface KgSuggestion {
  /** Human readable text section to merge into the optimized prompt. */
  text: string;
  /** Stable ID of the seed node from which this suggestion was derived. */
  seedNodeId: number;
  /** Number of edges traversed to reach this suggestion. */
  hops: number;
  /** Confidence proxy — higher means more frequently associated. */
  weight: number;
}

const MAX_SEED_TERMS   = 8;
const MAX_SUGGESTIONS  = 4;
const MAX_NODE_SUMMARY = 240;

export class KnowledgeGraph {
  constructor(private readonly db: Database.Database) {}

  /** Insert (or refresh) a single node and return its id. */
  upsertNode(workspaceId: string, nodeType: KgNodeType, name: string, summary = ''): number {
    const truncated = summary.slice(0, MAX_NODE_SUMMARY);
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO kg_nodes (workspace_id, node_type, name, summary, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, node_type, name) DO UPDATE SET
        summary = CASE WHEN length(excluded.summary) > 0 THEN excluded.summary ELSE kg_nodes.summary END,
        updated_at = excluded.updated_at
    `);
    stmt.run(workspaceId, nodeType, name, truncated, now);

    const row = this.db.prepare(
      'SELECT id FROM kg_nodes WHERE workspace_id = ? AND node_type = ? AND name = ?',
    ).get(workspaceId, nodeType, name) as { id: number } | undefined;
    return row?.id ?? -1;
  }

  /** Insert (or strengthen) a directed edge. */
  upsertEdge(srcId: number, dstId: number, relation: string, weightDelta = 1.0): void {
    if (srcId < 0 || dstId < 0 || srcId === dstId) { return; }
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO kg_edges (src_id, dst_id, relation, weight, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(src_id, dst_id, relation) DO UPDATE SET
        weight = kg_edges.weight + excluded.weight,
        updated_at = excluded.updated_at
    `).run(srcId, dstId, relation, weightDelta, now);
  }

  /** Record nodes + edges for a single optimization invocation. */
  recordWorkspaceGraph(
    workspaceId: string,
    rawPrompt: string,
    ide: PromptIDEContext | undefined,
    stack: RepoStackInfo,
  ): void {
    try {
      const promptName = shortPromptId(rawPrompt);
      const promptId = this.upsertNode(workspaceId, 'prompt', promptName, summarizePrompt(rawPrompt));

      for (const framework of stack.frameworks) {
        const id = this.upsertNode(workspaceId, 'framework', framework, `Framework: ${framework}`);
        this.upsertEdge(promptId, id, 'uses-framework');
      }
      for (const lang of stack.languages) {
        const id = this.upsertNode(workspaceId, 'language', lang, `Language: ${lang}`);
        this.upsertEdge(promptId, id, 'uses-language');
      }
      for (const orm of stack.orm) {
        const id = this.upsertNode(workspaceId, 'orm', orm, `ORM: ${orm}`);
        this.upsertEdge(promptId, id, 'uses-orm');
      }
      for (const auth of stack.auth) {
        const id = this.upsertNode(workspaceId, 'auth', auth, `Auth: ${auth}`);
        this.upsertEdge(promptId, id, 'uses-auth');
      }

      const files = collectFileRefs(ide);
      for (const file of files) {
        const id = this.upsertNode(workspaceId, 'file', file.path, file.summary);
        this.upsertEdge(promptId, id, 'mentions-file', 2.0);
      }

      for (const term of extractConceptTerms(rawPrompt)) {
        const id = this.upsertNode(workspaceId, 'concept', term, '');
        this.upsertEdge(promptId, id, 'mentions-concept', 0.5);
      }
    } catch { /* graph harvest must never break optimization */ }
  }

  /** Walk the graph from prompt terms and return text suggestions to merge in. */
  collectGraphContext(workspaceId: string, rawPrompt: string): KgSuggestion[] {
    const seedTerms = Array.from(new Set(extractConceptTerms(rawPrompt))).slice(0, MAX_SEED_TERMS);
    if (seedTerms.length === 0) { return []; }

    let seeds: KgNode[] = [];
    try {
      const placeholders = seedTerms.map(() => '?').join(',');
      seeds = (this.db.prepare(
        `SELECT id, workspace_id AS workspaceId, node_type AS nodeType, name, summary, updated_at AS updatedAt
         FROM kg_nodes
         WHERE workspace_id = ? AND name IN (${placeholders})`,
      ).all(workspaceId, ...seedTerms) as KgNode[]);
    } catch { return []; }

    if (seeds.length === 0) { return []; }

    const suggestions: KgSuggestion[] = [];
    for (const seed of seeds) {
      const neighbors = this.topNeighbors(seed.id, 3);
      for (const neighbor of neighbors) {
        const text = renderSuggestion(seed, neighbor);
        if (text) {
          suggestions.push({ text, seedNodeId: seed.id, hops: 1, weight: neighbor.weight });
        }
      }
    }
    suggestions.sort((a, b) => b.weight - a.weight);
    return dedupe(suggestions).slice(0, MAX_SUGGESTIONS);
  }

  /** Return graph statistics (used by CLI / status panel). */
  stats(workspaceId?: string): { nodes: number; edges: number } {
    const nodesRow = workspaceId
      ? this.db.prepare('SELECT COUNT(*) AS c FROM kg_nodes WHERE workspace_id = ?').get(workspaceId)
      : this.db.prepare('SELECT COUNT(*) AS c FROM kg_nodes').get();
    const edgesRow = this.db.prepare('SELECT COUNT(*) AS c FROM kg_edges').get();
    return {
      nodes: (nodesRow as { c: number }).c,
      edges: (edgesRow as { c: number }).c,
    };
  }

  private topNeighbors(
    nodeId: number,
    limit: number,
  ): Array<{ node: KgNode; weight: number; relation: string }> {
    const rows = this.db.prepare(`
      SELECT n.id, n.workspace_id AS workspaceId, n.node_type AS nodeType,
             n.name, n.summary, n.updated_at AS updatedAt,
             e.weight AS weight, e.relation AS relation
      FROM kg_edges e
      JOIN kg_nodes n ON n.id = e.dst_id
      WHERE e.src_id = ?
      ORDER BY e.weight DESC, e.updated_at DESC
      LIMIT ?
    `).all(nodeId, limit) as Array<KgNode & { weight: number; relation: string }>;

    return rows.map((row) => ({
      node: {
        id: row.id,
        workspaceId: row.workspaceId,
        nodeType: row.nodeType,
        name: row.name,
        summary: row.summary,
        updatedAt: row.updatedAt,
      },
      weight: row.weight,
      relation: row.relation,
    }));
  }
}

// ── pure helpers ──────────────────────────────────────────────────────────────

function shortPromptId(rawPrompt: string): string {
  const trimmed = rawPrompt.trim().replace(/\s+/g, ' ');
  return trimmed.length <= 60 ? trimmed : trimmed.slice(0, 57) + '...';
}

function summarizePrompt(rawPrompt: string): string {
  return rawPrompt.trim().replace(/\s+/g, ' ').slice(0, MAX_NODE_SUMMARY);
}

function collectFileRefs(ide?: PromptIDEContext): Array<{ path: string; summary: string }> {
  if (!ide) { return []; }
  const refs: Array<{ path: string; summary: string }> = [];
  if (ide.active_file) {
    refs.push({ path: ide.active_file.path, summary: `Active file (${ide.active_file.language ?? 'text'})` });
  }
  for (const f of ide.open_files ?? []) {
    if (ide.active_file && f.path === ide.active_file.path) { continue; }
    refs.push({ path: f.path, summary: `Open file (${f.language ?? 'text'})` });
  }
  return refs.slice(0, 8);
}

function extractConceptTerms(rawPrompt: string): string[] {
  const tokens = rawPrompt
    .toLowerCase()
    .split(/[^a-zA-Z0-9_]+/)
    .filter((t) => t.length >= 3 && t.length <= 32 && !STOP_WORDS.has(t) && !/^\d+$/.test(t));
  return Array.from(new Set(tokens)).slice(0, 32);
}

function renderSuggestion(
  seed: KgNode,
  neighbor: { node: KgNode; weight: number; relation: string },
): string | null {
  if (!neighbor.node.name) { return null; }
  const summary = neighbor.node.summary || `${neighbor.node.nodeType} ${neighbor.node.name}`;
  return `# Knowledge graph — ${seed.name} ${neighbor.relation} ${neighbor.node.name}\n${summary}`;
}

function dedupe(items: KgSuggestion[]): KgSuggestion[] {
  const seen = new Set<string>();
  const out: KgSuggestion[] = [];
  for (const item of items) {
    if (seen.has(item.text)) { continue; }
    seen.add(item.text);
    out.push(item);
  }
  return out;
}
