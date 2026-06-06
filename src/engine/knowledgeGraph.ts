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
    seeding = false,
  ): void {
    try {
      // During bulk harvest passes (workspace refresh) we collapse every seed
      // prompt onto one stable node and skip concept nodes, so structural
      // nodes stay bounded by the workspace and the graph count is idempotent
      // across repeated refreshes. Real user prompts (seeding === false) keep
      // their own prompt + concept nodes as a record of work done.
      const promptName = seeding ? '__workspace_seed__' : shortPromptId(rawPrompt);
      const promptSummary = seeding ? 'Aggregated workspace harvest' : summarizePrompt(rawPrompt);
      const promptId = this.upsertNode(workspaceId, 'prompt', promptName, promptSummary);

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
      const fileByKey = buildPathLookup(files);
      const fileNodeIds = new Map<string, number>();
      for (const file of files) {
        const id = this.upsertNode(workspaceId, 'file', file.path, file.summary);
        this.upsertEdge(promptId, id, 'mentions-file', 2.0);
        fileNodeIds.set(file.path, id);

        const signals = extractFileSignals(file.content, file.path, fileByKey);
        for (const symbol of signals.implements) {
          const symbolId = this.upsertNode(workspaceId, 'concept', symbol, `Symbol: ${symbol}`);
          this.upsertEdge(id, symbolId, 'implements', 1.5);
        }
        for (const depPath of signals.dependencies) {
          const depId = this.upsertNode(workspaceId, 'file', depPath, `Dependency file: ${depPath}`);
          this.upsertEdge(id, depId, 'depends-on', 1.0);
        }
      }

      if (!seeding) {
        for (const term of extractConceptTerms(rawPrompt)) {
          const id = this.upsertNode(workspaceId, 'concept', term, '');
          this.upsertEdge(promptId, id, 'mentions-concept', 0.5);
        }
      }
    } catch { /* graph harvest must never break optimization */ }
  }

  /**
   * Build a compact architecture map from SQLite graph data for prompt-time
   * injection. The shape is intentionally stable so downstream compressors
   * preserve structure and references.
   */
  buildArchitectureSummary(workspaceId: string, rawPrompt: string): string | null {
    const seedTerms = Array.from(new Set(extractConceptTerms(rawPrompt))).slice(0, MAX_SEED_TERMS);
    if (seedTerms.length === 0) { return null; }

    let files = this.rankTargetFiles(workspaceId, seedTerms).slice(0, 4);
    if (files.length === 0) {
      // Fallback: when term matching is sparse, still surface the most recent
      // graph-backed file map so the optimizer receives concrete file anchors.
      files = this.rankTargetFiles(workspaceId, []).slice(0, 4);
    }
    if (files.length === 0) { return null; }

    const lines: string[] = [
      '[PROJECT ARCHITECTURE SUMMARY]',
      'Target files identified by local graph dependency search:',
      '',
    ];

    for (const file of files) {
      lines.push(`#file: ${file.path}`);
      lines.push(`   └─ 🔗 Implements: ${file.implements.length > 0 ? file.implements.join(', ') : '-'}`);
      lines.push(`   └─ 🔌 Dependencies: ${file.dependencies.length > 0 ? file.dependencies.join(', ') : '-'}`);
      lines.push('');
    }

    lines.push('[AGENT INSTRUCTION]');
    lines.push('Based *only* on the reference architecture map above, analyze the user request. Do not crawl any files outside of this specified dependency map.');
    lines.push('');
    lines.push('[USER REQUEST]');
    lines.push(compactUserRequest(rawPrompt));
    return lines.join('\n').trim();
  }

  /**
   * Remove every node + edge for a workspace.  Backs the "reset graph" action
   * so users can zero a graph that has accumulated stale prompt/concept nodes.
   * Returns the number of nodes deleted.
   */
  clearGraph(workspaceId: string): number {
    try {
      const before = this.db
        .prepare('SELECT COUNT(*) AS c FROM kg_nodes WHERE workspace_id = ?')
        .get(workspaceId) as { c: number } | undefined;
      const txn = this.db.transaction((ws: string) => {
        this.db.prepare(`
          DELETE FROM kg_edges WHERE src_id IN (SELECT id FROM kg_nodes WHERE workspace_id = ?)
             OR dst_id IN (SELECT id FROM kg_nodes WHERE workspace_id = ?)
        `).run(ws, ws);
        this.db.prepare('DELETE FROM kg_nodes WHERE workspace_id = ?').run(ws);
      });
      txn(workspaceId);
      return before?.c ?? 0;
    } catch {
      return 0;
    }
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
    const edgesRow = workspaceId
      ? this.db.prepare(`
          SELECT COUNT(*) AS c
          FROM kg_edges e
          JOIN kg_nodes n ON n.id = e.src_id
          WHERE n.workspace_id = ?
        `).get(workspaceId)
      : this.db.prepare('SELECT COUNT(*) AS c FROM kg_edges').get();
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

  private rankTargetFiles(
    workspaceId: string,
    seedTerms: string[],
  ): Array<{ path: string; score: number; updatedAt: number; implements: string[]; dependencies: string[] }> {
    let fileRows: Array<{ id: number; name: string; summary: string; updatedAt: number }> = [];
    try {
      fileRows = this.db.prepare(`
        SELECT id, name, summary, updated_at AS updatedAt
        FROM kg_nodes
        WHERE workspace_id = ? AND node_type = 'file'
        ORDER BY updated_at DESC
        LIMIT 80
      `).all(workspaceId) as Array<{ id: number; name: string; summary: string; updatedAt: number }>;
    } catch {
      return [];
    }

    const out: Array<{ path: string; score: number; updatedAt: number; implements: string[]; dependencies: string[] }> = [];
    for (const file of fileRows) {
      const signals = this.loadFileSignals(file.id);
      const lowerPath = file.name.toLowerCase();
      const lowerSummary = (file.summary ?? '').toLowerCase();

      let score = 0;
      for (const term of seedTerms) {
        const t = term.toLowerCase();
        if (lowerPath.includes(t)) { score += 3; }
        if (lowerSummary.includes(t)) { score += 2; }
        if (signals.implements.some((s) => s.toLowerCase().includes(t))) { score += 2; }
        if (signals.dependencies.some((d) => d.toLowerCase().includes(t))) { score += 1.5; }
      }
      score += this.scorePromptMentions(file.id, seedTerms);

      if (score <= 0 && signals.implements.length === 0 && signals.dependencies.length === 0) {
        continue;
      }

      out.push({
        path: file.name,
        score,
        updatedAt: file.updatedAt,
        implements: signals.implements.slice(0, 4),
        dependencies: signals.dependencies.slice(0, 4),
      });
    }

    out.sort((a, b) => {
      if (b.score !== a.score) { return b.score - a.score; }
      return b.updatedAt - a.updatedAt;
    });
    return out;
  }

  private loadFileSignals(fileNodeId: number): { implements: string[]; dependencies: string[] } {
    let rows: Array<{ relation: string; nodeType: KgNodeType; name: string; weight: number }> = [];
    try {
      rows = this.db.prepare(`
        SELECT e.relation AS relation,
               n.node_type AS nodeType,
               n.name AS name,
               e.weight AS weight
        FROM kg_edges e
        JOIN kg_nodes n ON n.id = e.dst_id
        WHERE e.src_id = ?
          AND e.relation IN ('implements', 'depends-on')
        ORDER BY e.weight DESC, e.updated_at DESC
        LIMIT 32
      `).all(fileNodeId) as Array<{ relation: string; nodeType: KgNodeType; name: string; weight: number }>;
    } catch {
      return { implements: [], dependencies: [] };
    }

    const impl = new Set<string>();
    const deps = new Set<string>();
    for (const row of rows) {
      if (row.relation === 'implements' && row.nodeType === 'concept' && row.name) {
        impl.add(row.name);
      }
      if (row.relation === 'depends-on' && row.nodeType === 'file' && row.name) {
        deps.add(row.name);
      }
    }
    return { implements: Array.from(impl), dependencies: Array.from(deps) };
  }

  private scorePromptMentions(fileNodeId: number, seedTerms: string[]): number {
    let rows: Array<{ name: string; summary: string; weight: number }> = [];
    try {
      rows = this.db.prepare(`
        SELECT p.name AS name, p.summary AS summary, e.weight AS weight
        FROM kg_edges e
        JOIN kg_nodes p ON p.id = e.src_id
        WHERE e.dst_id = ?
          AND e.relation = 'mentions-file'
          AND p.node_type = 'prompt'
        ORDER BY e.updated_at DESC
        LIMIT 16
      `).all(fileNodeId) as Array<{ name: string; summary: string; weight: number }>;
    } catch {
      return 0;
    }

    let score = 0;
    for (const row of rows) {
      const hay = `${row.name} ${row.summary}`.toLowerCase();
      for (const term of seedTerms) {
        if (hay.includes(term)) { score += Math.max(0.2, row.weight * 0.2); }
      }
    }
    return score;
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

function compactUserRequest(rawPrompt: string): string {
  const noFences = rawPrompt.replace(/```[\s\S]*?```/g, ' ');
  const noHeaders = noFences.replace(/^#\s+.*$/gm, ' ');
  const flattened = noHeaders.replace(/\s+/g, ' ').trim();
  return flattened.slice(0, 220);
}

function collectFileRefs(ide?: PromptIDEContext): Array<{ path: string; summary: string; content: string }> {
  if (!ide) { return []; }
  const refs: Array<{ path: string; summary: string; content: string }> = [];
  if (ide.active_file) {
    refs.push({
      path: ide.active_file.path,
      summary: `Active file (${ide.active_file.language ?? 'text'})`,
      content: ide.active_file.content ?? '',
    });
  }
  for (const f of ide.open_files ?? []) {
    if (ide.active_file && f.path === ide.active_file.path) { continue; }
    refs.push({
      path: f.path,
      summary: `Open file (${f.language ?? 'text'})`,
      content: f.content ?? '',
    });
  }
  return refs.slice(0, 8);
}

function buildPathLookup(files: Array<{ path: string }>): Map<string, string> {
  const out = new Map<string, string>();
  for (const file of files) {
    const normalized = normalizePath(file.path);
    out.set(normalized, file.path);
    const noExt = normalized.replace(/\.[a-z0-9]+$/i, '');
    out.set(noExt, file.path);
    out.set(noExt + '/index', file.path);
  }
  return out;
}

function extractFileSignals(
  content: string,
  filePath: string,
  pathLookup: Map<string, string>,
): { implements: string[]; dependencies: string[] } {
  if (!content) { return { implements: [], dependencies: [] }; }
  const impl = new Set<string>();
  const deps = new Set<string>();

  for (const symbol of extractImplementedSymbols(content)) {
    impl.add(symbol);
  }
  for (const specifier of extractImportSpecifiers(content)) {
    const resolved = resolveDependencyPath(filePath, specifier, pathLookup);
    if (resolved) { deps.add(resolved); }
  }

  return {
    implements: Array.from(impl).slice(0, 8),
    dependencies: Array.from(deps).slice(0, 8),
  };
}

function extractImplementedSymbols(content: string): string[] {
  const found = new Set<string>();
  const patterns = [
    /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)/g,
    /(?:export\s+)?class\s+([A-Za-z_][A-Za-z0-9_]*)/g,
    /(?:export\s+)?interface\s+([A-Za-z_][A-Za-z0-9_]*)/g,
    /(?:export\s+)?type\s+([A-Za-z_][A-Za-z0-9_]*)\s*=/g,
    /(?:export\s+)?(?:const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=/g,
    /def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null = null;
    while ((m = re.exec(content)) !== null) {
      found.add(m[1]);
      if (found.size >= 12) { break; }
    }
    if (found.size >= 12) { break; }
  }
  return Array.from(found);
}

function extractImportSpecifiers(content: string): string[] {
  const found = new Set<string>();
  const patterns = [
    /import\s+[^'"\n]+\s+from\s+['"]([^'"\n]+)['"]/g,
    /import\s+['"]([^'"\n]+)['"]/g,
    /require\(\s*['"]([^'"\n]+)['"]\s*\)/g,
    /from\s+([A-Za-z0-9_./-]+)\s+import\s+/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null = null;
    while ((m = re.exec(content)) !== null) {
      found.add(m[1]);
      if (found.size >= 20) { break; }
    }
    if (found.size >= 20) { break; }
  }
  return Array.from(found);
}

function resolveDependencyPath(
  sourcePath: string,
  importSpecifier: string,
  pathLookup: Map<string, string>,
): string | null {
  const spec = importSpecifier.trim();
  if (!spec.startsWith('.')) { return null; }

  const sourceDir = normalizePath(sourcePath).replace(/\/[^/]*$/, '');
  const raw = normalizePath(joinPath(sourceDir, spec));
  const noExt = raw.replace(/\.[a-z0-9]+$/i, '');

  return pathLookup.get(raw)
    ?? pathLookup.get(noExt)
    ?? pathLookup.get(noExt + '/index')
    ?? raw;
}

function joinPath(baseDir: string, relative: string): string {
  const stack = baseDir.split('/').filter(Boolean);
  for (const part of relative.split('/')) {
    if (!part || part === '.') { continue; }
    if (part === '..') {
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  return stack.join('/');
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\.\//, '');
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
