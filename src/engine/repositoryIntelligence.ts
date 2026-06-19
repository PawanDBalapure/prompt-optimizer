import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { LocalSemanticVectorizer } from '../localSemanticVectorizer.js';

export type NodeKind =
  | 'workspace'
  | 'project'
  | 'file'
  | 'class'
  | 'interface'
  | 'function'
  | 'method'
  | 'annotation'
  | 'doc_chunk'
  | 'test';

export type EdgeKind =
  | 'CONTAINS'
  | 'IMPORTS'
  | 'CALLS'
  | 'IMPLEMENTS'
  | 'ANNOTATED_WITH'
  | 'COVERS'
  | 'DOC_FOR'
  | 'CHANGED_WITH';

export interface GraphNode {
  id: string;
  kind: NodeKind;
  language?: 'ts' | 'java' | 'python' | 'markdown' | 'meta';
  label: string;
  uri?: string;
  range?: { startLine: number; endLine: number; startCol: number; endCol: number };
  score?: number;
  metadata?: Record<string, string | number | boolean>;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  weight: number;
  metadata?: Record<string, string | number | boolean>;
}

export interface RepositoryGraphSchema {
  version: string;
  storageMode: 'local-json';
  graphPath: string;
  indexPath: string;
  nodeKinds: NodeKind[];
  edgeKinds: EdgeKind[];
  ingestion: {
    maxFiles: number;
    maxFileBytes: number;
    concurrency: number;
    includeGitHistory: boolean;
    includeCoverage: boolean;
  };
  parsers: {
    ts: 'regex-fallback';
    java: 'regex-fallback';
    python: 'regex-fallback';
    docs: 'chunk-400';
  };
  retrieval: {
    defaultTraversalDepth: number;
    defaultVectorTopK: number;
    defaultKeywordTopK: number;
    weights: {
      keyword: number;
      vector: number;
      graph: number;
    };
  };
}

export interface DiscoveryResult {
  workspaceRoot: string;
  typescript: { detected: boolean; roots: string[] };
  java: { detected: boolean; roots: string[] };
  python: { detected: boolean; roots: string[] };
}

export interface IngestionStats {
  discoveredFiles: number;
  parsedFiles: number;
  nodes: number;
  edges: number;
  docsChunks: number;
  coverageLinks: number;
  gitChurnFiles: number;
}

export interface ImpactAnalysisRequest {
  query: string;
  radius?: number;
  vectorTopK?: number;
  keywordTopK?: number;
}

export interface ImpactAnalysisResult {
  query: string;
  matchedNodes: GraphNode[];
  traversedEdges: GraphEdge[];
  relatedDocChunks: Array<{ nodeId: string; score: number; snippet: string }>;
  blastRadius: Array<{ nodeId: string; depth: number }>;
  churnHotspots: Array<{ file: string; churn: number }>;
  routing: {
    keywordSeeds: number;
    vectorSeeds: number;
    fusedSeeds: number;
  };
}

interface QueryProfile {
  raw: string;
  coreTerms: string[];
  filenameTerms: string[];
  phrase: string;
  relationIntent: boolean;
  anchorTerms: string[];
}

interface StoredGraph {
  nodes: Record<string, GraphNode>;
  edges: GraphEdge[];
  vectors: Record<string, number[]>;
}

const MAX_FILES = 12_000;
const MAX_FILE_BYTES = 512_000;
const INGEST_CONCURRENCY = 8;
const IGNORE_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  '.idea',
  '.vscode',
  '.gradle',
  '.venv',
  'venv',
  '__pycache__',
]);

export class RepositoryIntelligenceBuilder {
  private readonly workspaceRoot: string;
  private readonly schema: RepositoryGraphSchema;
  private readonly vectorizer = new LocalSemanticVectorizer();

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
    this.schema = buildRepositoryGraphSchema(workspaceRoot);
  }

  getSchema(): RepositoryGraphSchema {
    return this.schema;
  }

  discoverWorkspace(): DiscoveryResult {
    const roots = this.listWorkspaceFiles();
    return {
      workspaceRoot: this.workspaceRoot,
      typescript: {
        detected: roots.some((p) => p.endsWith('package.json') || p.endsWith('tsconfig.json')),
        roots: this.collectProjectRoots(roots, ['package.json', 'tsconfig.json', 'pnpm-workspace.yaml', 'yarn.lock']),
      },
      java: {
        detected: roots.some((p) => p.endsWith('pom.xml') || p.endsWith('build.gradle') || p.endsWith('build.gradle.kts')),
        roots: this.collectProjectRoots(roots, ['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle.kts']),
      },
      python: {
        detected: roots.some((p) => p.endsWith('pyproject.toml') || p.endsWith('requirements.txt') || p.endsWith('Pipfile')),
        roots: this.collectProjectRoots(roots, ['pyproject.toml', 'requirements.txt', 'Pipfile', 'poetry.lock']),
      },
    };
  }

  async ingest(): Promise<IngestionStats> {
    const graph: StoredGraph = { nodes: {}, edges: [], vectors: {} };
    const discovery = this.discoverWorkspace();
    const files = this.discoverCodeAndDocs();

    const workspaceNodeId = `workspace:${this.workspaceRoot}`;
    graph.nodes[workspaceNodeId] = { id: workspaceNodeId, kind: 'workspace', language: 'meta', label: path.basename(this.workspaceRoot) || 'workspace', uri: this.workspaceRoot };

    for (const projectRoot of new Set([...discovery.typescript.roots, ...discovery.java.roots, ...discovery.python.roots])) {
      const id = `project:${projectRoot}`;
      graph.nodes[id] = { id, kind: 'project', language: 'meta', label: path.basename(projectRoot), uri: projectRoot };
      graph.edges.push({ from: workspaceNodeId, to: id, kind: 'CONTAINS', weight: 1 });
    }

    let parsedFiles = 0;
    let docsChunks = 0;
    await runWithConcurrency(files, INGEST_CONCURRENCY, async (file) => {
      const parsed = this.parseFile(file.abs, graph);
      parsedFiles += parsed.parsed ? 1 : 0;
      docsChunks += parsed.docsChunks;
    });

    const churn = this.ingestGitHistory(graph);
    const coverageLinks = this.ingestCoverageAndTests(graph);

    this.persistGraph(graph);

    return {
      discoveredFiles: files.length,
      parsedFiles,
      nodes: Object.keys(graph.nodes).length,
      edges: graph.edges.length,
      docsChunks,
      coverageLinks,
      gitChurnFiles: churn,
    };
  }

  async impactAnalysis(request: ImpactAnalysisRequest): Promise<ImpactAnalysisResult> {
    const graph = this.loadGraph();
    const radius = request.radius ?? this.schema.retrieval.defaultTraversalDepth;
    const vectorTopK = request.vectorTopK ?? this.schema.retrieval.defaultVectorTopK;
    const keywordTopK = request.keywordTopK ?? this.schema.retrieval.defaultKeywordTopK;
    const queryProfile = this.buildQueryProfile(request.query);

    const keywordMatches = this.keywordSearch(graph, queryProfile, keywordTopK);
    const vectorMatches = this.vectorSearch(graph, request.query, vectorTopK);
    const fusedRanked = this.rankHybridSeeds(graph, keywordMatches, vectorMatches, queryProfile);
    this.applyRelationNeighborBoost(graph, fusedRanked, queryProfile);
    const seedIds = fusedRanked.slice(0, 24).map((row) => row.nodeId);

    const matchedNodes = fusedRanked
      .slice(0, keywordTopK)
      .map((row) => {
        const node = graph.nodes[row.nodeId];
        if (!node) { return undefined; }
        return { ...node, score: row.score } as GraphNode;
      })
      .filter((row): row is GraphNode => row !== undefined);

    const traversed = this.traverse(graph, seedIds, radius);
    const relatedDocChunks = vectorMatches
      .map((m) => ({ nodeId: m.nodeId, score: m.score, snippet: graph.nodes[m.nodeId]?.label ?? '' }))
      .filter((row) => row.nodeId in graph.nodes);

    const churnHotspots = keywordMatches
      .filter((n) => n.kind === 'file')
      .map((n) => ({ file: n.label, churn: Number(n.metadata?.churn ?? 0) }))
      .filter((n) => n.churn > 0)
      .sort((a, b) => b.churn - a.churn)
      .slice(0, 10);

    return {
      query: request.query,
      matchedNodes,
      traversedEdges: traversed.edges,
      relatedDocChunks,
      blastRadius: traversed.nodes,
      churnHotspots,
      routing: {
        keywordSeeds: keywordMatches.length,
        vectorSeeds: vectorMatches.length,
        fusedSeeds: seedIds.length,
      },
    };
  }

  private listWorkspaceFiles(): string[] {
    const out: string[] = [];
    const queue = [this.workspaceRoot];
    while (queue.length > 0 && out.length < MAX_FILES) {
      const current = queue.pop() as string;
      let entries: fs.Dirent[] = [];
      try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        const abs = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (!IGNORE_DIRS.has(entry.name)) { queue.push(abs); }
          continue;
        }
        out.push(abs);
        if (out.length >= MAX_FILES) { break; }
      }
    }
    return out;
  }

  private collectProjectRoots(allFiles: string[], markers: string[]): string[] {
    const roots = new Set<string>();
    for (const file of allFiles) {
      const base = path.basename(file);
      if (markers.includes(base)) {
        roots.add(path.dirname(file));
      }
    }
    if (roots.size === 0) { roots.add(this.workspaceRoot); }
    return Array.from(roots);
  }

  private discoverCodeAndDocs(): Array<{ abs: string }> {
    const all = this.listWorkspaceFiles();
    const allowed = new Set(['.ts', '.tsx', '.js', '.jsx', '.java', '.py', '.md']);
    return all
      .filter((p) => allowed.has(path.extname(p).toLowerCase()))
      .map((abs) => ({ abs }));
  }

  private parseFile(absPath: string, graph: StoredGraph): { parsed: boolean; docsChunks: number } {
    let text = '';
    try {
      const stat = fs.statSync(absPath);
      if (stat.size > MAX_FILE_BYTES) { return { parsed: false, docsChunks: 0 }; }
      text = fs.readFileSync(absPath, 'utf8');
    } catch {
      return { parsed: false, docsChunks: 0 };
    }

    const rel = path.relative(this.workspaceRoot, absPath).replace(/\\/g, '/');
    const ext = path.extname(absPath).toLowerCase();
    const language: GraphNode['language'] = ext === '.java' ? 'java' : ext === '.py' ? 'python' : ext === '.md' ? 'markdown' : 'ts';
    const fileNodeId = `file:${rel}`;
    graph.nodes[fileNodeId] = { id: fileNodeId, kind: 'file', language, label: rel, uri: absPath };

    let docsChunks = 0;
    if (language === 'markdown') {
      docsChunks = this.indexDocChunks(fileNodeId, text, graph);
      return { parsed: true, docsChunks };
    }

    const symbols = this.extractSymbols(text, language);
    const symbolIds = new Map<string, string>();
    const classSymbolIds: string[] = [];
    for (const symbol of symbols) {
      const symbolId = `${symbol.kind}:${rel}:${symbol.name}:${symbol.line}`;
      graph.nodes[symbolId] = {
        id: symbolId,
        kind: symbol.kind,
        language,
        label: symbol.name,
        uri: absPath,
        range: { startLine: symbol.line, endLine: symbol.line, startCol: 0, endCol: Math.max(1, symbol.name.length) },
      };
      graph.edges.push({ from: fileNodeId, to: symbolId, kind: 'CONTAINS', weight: 1 });
      symbolIds.set(symbol.name.toLowerCase(), symbolId);
      if (symbol.kind === 'class' || symbol.kind === 'interface') {
        classSymbolIds.push(symbolId);
      }

      if (symbol.annotation) {
        const annId = `annotation:${symbol.annotation}`;
        if (!(annId in graph.nodes)) {
          graph.nodes[annId] = { id: annId, kind: 'annotation', language: 'meta', label: symbol.annotation };
        }
        graph.edges.push({ from: symbolId, to: annId, kind: 'ANNOTATED_WITH', weight: 1 });
      }
    }

    for (const target of this.extractImplementsTargets(text, language)) {
      const targetKey = target.toLowerCase();
      const targetId = symbolIds.get(targetKey) ?? `class:${target}`;
      if (!(targetId in graph.nodes)) {
        graph.nodes[targetId] = {
          id: targetId,
          kind: 'class',
          language: 'meta',
          label: target,
        };
      }
      for (const srcClassId of classSymbolIds) {
        graph.edges.push({ from: srcClassId, to: targetId, kind: 'IMPLEMENTS', weight: 1 });
      }
    }

    for (const call of this.extractCallCandidates(text, language)) {
      const targetId = symbolIds.get(call.toLowerCase()) ?? `function:${call}`;
      if (!(targetId in graph.nodes)) {
        graph.nodes[targetId] = {
          id: targetId,
          kind: 'function',
          language: 'meta',
          label: call,
        };
      }
      graph.edges.push({ from: fileNodeId, to: targetId, kind: 'CALLS', weight: 0.7 });
    }

    for (const imported of this.extractImports(text, language)) {
      const importCandidates = this.resolveImportTargets(rel, imported, language);
      if (importCandidates.length === 0) {
        const importId = `file:${imported}`;
        if (!(importId in graph.nodes)) {
          graph.nodes[importId] = { id: importId, kind: 'file', language, label: imported };
        }
        graph.edges.push({ from: fileNodeId, to: importId, kind: 'IMPORTS', weight: 1 });
        continue;
      }
      for (const targetRel of importCandidates) {
        const importId = `file:${targetRel}`;
        if (!(importId in graph.nodes)) {
          graph.nodes[importId] = { id: importId, kind: 'file', language, label: targetRel };
        }
        graph.edges.push({ from: fileNodeId, to: importId, kind: 'IMPORTS', weight: 1 });
      }
    }

    const docCarrier = this.extractDocStrings(text, language);
    if (docCarrier.length > 0) {
      docsChunks += this.indexDocChunks(fileNodeId, docCarrier.join('\n\n'), graph);
    }

    return { parsed: true, docsChunks };
  }

  private extractSymbols(text: string, language: GraphNode['language']): Array<{ name: string; kind: Extract<NodeKind, 'class' | 'interface' | 'function' | 'method'>; line: number; annotation?: string }> {
    const out: Array<{ name: string; kind: Extract<NodeKind, 'class' | 'interface' | 'function' | 'method'>; line: number; annotation?: string }> = [];
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const ann = line.match(/^\s*[@][A-Za-z_][A-Za-z0-9_]*/)?.[0]?.slice(1);
      const classMatch = line.match(/\bclass\s+([A-Za-z_][A-Za-z0-9_]*)/);
      if (classMatch) { out.push({ name: classMatch[1], kind: 'class', line: i + 1, annotation: ann }); continue; }
      const ifaceMatch = line.match(/\binterface\s+([A-Za-z_][A-Za-z0-9_]*)/);
      if (ifaceMatch) { out.push({ name: ifaceMatch[1], kind: 'interface', line: i + 1, annotation: ann }); continue; }
      const fnTs = line.match(/\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)/);
      if (fnTs) { out.push({ name: fnTs[1], kind: 'function', line: i + 1, annotation: ann }); continue; }
      const fnPy = language === 'python' ? line.match(/^\s*def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/) : null;
      if (fnPy) { out.push({ name: fnPy[1], kind: 'function', line: i + 1, annotation: ann }); continue; }
      const methodJava = language === 'java' ? line.match(/\b(?:public|private|protected)?\s*(?:static\s+)?[A-Za-z0-9_<>,\[\]]+\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/) : null;
      if (methodJava) { out.push({ name: methodJava[1], kind: 'method', line: i + 1, annotation: ann }); }
    }
    return out;
  }

  private extractImports(text: string, language: GraphNode['language']): string[] {
    const out = new Set<string>();
    if (language === 'python') {
      const re = /^\s*(?:from\s+([A-Za-z0-9_\.]+)\s+import|import\s+([A-Za-z0-9_\.]+))/gm;
      let m: RegExpExecArray | null = null;
      while ((m = re.exec(text)) !== null) { out.add((m[1] ?? m[2] ?? '').replace(/\./g, '/')); }
    } else if (language === 'java') {
      const re = /^\s*import\s+([A-Za-z0-9_\.]+);/gm;
      let m: RegExpExecArray | null = null;
      while ((m = re.exec(text)) !== null) { out.add(m[1].replace(/\./g, '/')); }
    } else {
      const re = /import\s+[^'"\n]*['"]([^'"\n]+)['"]/gm;
      let m: RegExpExecArray | null = null;
      while ((m = re.exec(text)) !== null) { out.add(m[1]); }
    }
    return Array.from(out).slice(0, 40);
  }

  private resolveImportTargets(currentRel: string, imported: string, language: GraphNode['language']): string[] {
    const normalized = imported.replace(/\\/g, '/').trim();
    if (normalized === '') { return []; }

    // Keep external imports untouched; relation ranking should focus on workspace files.
    if (
      normalized.startsWith('node:')
      || (!normalized.startsWith('.') && !normalized.startsWith('/'))
    ) {
      return [];
    }

    const currentDir = path.posix.dirname(currentRel.replace(/\\/g, '/'));
    const base = path.posix.normalize(path.posix.join(currentDir, normalized));
    const ext = path.posix.extname(base).toLowerCase();
    const extCandidates = ext !== ''
      ? [base, base.replace(/\.[^.]+$/, '.ts'), base.replace(/\.[^.]+$/, '.tsx'), base.replace(/\.[^.]+$/, '.js'), base.replace(/\.[^.]+$/, '.jsx')]
      : [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, `${base}/index.ts`, `${base}/index.tsx`, `${base}/index.js`, `${base}/index.jsx`];

    const out = new Set<string>();
    for (const candidate of extCandidates) {
      const rel = candidate.replace(/^\/+/, '').replace(/\\/g, '/');
      const abs = path.join(this.workspaceRoot, rel);
      if (!fs.existsSync(abs)) { continue; }
      out.add(rel);
    }

    // Python/Java normalization fallback for relative-looking imports.
    if (out.size === 0 && (language === 'python' || language === 'java')) {
      const rel = base.replace(/^\/+/, '').replace(/\\/g, '/');
      out.add(rel);
    }

    return Array.from(out).slice(0, 8);
  }

  private extractCallCandidates(text: string, language: GraphNode['language']): string[] {
    const out = new Set<string>();
    const skip = new Set([
      'if', 'for', 'while', 'switch', 'catch', 'return', 'new', 'super',
      'function', 'class', 'def', 'print', 'console', 'log', 'map', 'filter',
    ]);

    if (language === 'python') {
      const re = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
      let m: RegExpExecArray | null = null;
      while ((m = re.exec(text)) !== null) {
        const name = m[1];
        if (!skip.has(name)) { out.add(name); }
      }
    } else {
      const re = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
      let m: RegExpExecArray | null = null;
      while ((m = re.exec(text)) !== null) {
        const name = m[1];
        if (!skip.has(name)) { out.add(name); }
      }
    }

    return Array.from(out).slice(0, 80);
  }

  private extractImplementsTargets(text: string, language: GraphNode['language']): string[] {
    const out = new Set<string>();

    if (language === 'java') {
      for (const m of text.matchAll(/\bimplements\s+([A-Za-z0-9_,\s]+)/g)) {
        for (const part of m[1].split(',')) {
          const t = part.trim();
          if (t) { out.add(t); }
        }
      }
      for (const m of text.matchAll(/\bextends\s+([A-Za-z0-9_]+)/g)) {
        out.add(m[1]);
      }
    } else if (language === 'ts') {
      for (const m of text.matchAll(/\b(?:class|interface)\s+[A-Za-z0-9_]+\s+implements\s+([A-Za-z0-9_,\s]+)/g)) {
        for (const part of m[1].split(',')) {
          const t = part.trim();
          if (t) { out.add(t); }
        }
      }
      for (const m of text.matchAll(/\bclass\s+[A-Za-z0-9_]+\s+extends\s+([A-Za-z0-9_]+)/g)) {
        out.add(m[1]);
      }
    } else if (language === 'python') {
      for (const m of text.matchAll(/\bclass\s+[A-Za-z0-9_]+\(([A-Za-z0-9_,\s]+)\)\s*:/g)) {
        for (const part of m[1].split(',')) {
          const t = part.trim();
          if (t) { out.add(t); }
        }
      }
    }

    return Array.from(out).slice(0, 40);
  }

  private extractDocStrings(text: string, language: GraphNode['language']): string[] {
    if (language === 'python') {
      return Array.from(text.matchAll(/"""([\s\S]*?)"""/gm)).map((m) => m[1].trim()).filter((s) => s.length > 0);
    }
    if (language === 'java' || language === 'ts') {
      return Array.from(text.matchAll(/\/\*\*([\s\S]*?)\*\//gm)).map((m) => m[1].replace(/^[ \t]*\* ?/gm, '').trim()).filter((s) => s.length > 0);
    }
    return [];
  }

  private indexDocChunks(parentId: string, text: string, graph: StoredGraph): number {
    const tokens = text.split(/\s+/).filter((t) => t.length > 0);
    if (tokens.length === 0) { return 0; }
    let count = 0;
    for (let i = 0; i < tokens.length; i += 400) {
      const chunkTokens = tokens.slice(i, i + 400);
      if (chunkTokens.length === 0) { continue; }
      const chunkText = chunkTokens.join(' ');
      const chunkId = `doc_chunk:${parentId}:${Math.floor(i / 400)}`;
      graph.nodes[chunkId] = { id: chunkId, kind: 'doc_chunk', language: 'markdown', label: chunkText.slice(0, 300), metadata: { tokenCount: chunkTokens.length } };
      graph.edges.push({ from: parentId, to: chunkId, kind: 'DOC_FOR', weight: 1 });
      graph.vectors[chunkId] = Array.from(this.vectorizer.vectorize(chunkText));
      count++;
    }
    return count;
  }

  private ingestGitHistory(graph: StoredGraph): number {
    const git = spawnSync('git', ['log', '--name-only', '--pretty=format:__COMMIT__'], { cwd: this.workspaceRoot, encoding: 'utf8', timeout: 10_000, shell: false });
    if (git.status !== 0 || !git.stdout) { return 0; }
    const churn = new Map<string, number>();
    const lines = git.stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0 && l !== '__COMMIT__');
    for (const line of lines) {
      const rel = line.replace(/\\/g, '/');
      churn.set(rel, (churn.get(rel) ?? 0) + 1);
    }
    for (const [rel, count] of churn.entries()) {
      const id = `file:${rel}`;
      if (id in graph.nodes) {
        const existing = graph.nodes[id].metadata ?? {};
        graph.nodes[id].metadata = { ...existing, churn: count };
      }
    }
    return churn.size;
  }

  private ingestCoverageAndTests(graph: StoredGraph): number {
    let links = 0;
    const coverageFiles = [
      path.join(this.workspaceRoot, 'coverage', 'lcov.info'),
      path.join(this.workspaceRoot, 'coverage.xml'),
    ];
    for (const covPath of coverageFiles) {
      if (!fs.existsSync(covPath)) { continue; }
      let text = '';
      try { text = fs.readFileSync(covPath, 'utf8'); } catch { continue; }
      if (covPath.endsWith('lcov.info')) {
        const entries = text.split('end_of_record');
        for (const entry of entries) {
          const sf = entry.match(/\nSF:(.+)\n/);
          if (!sf) { continue; }
          const rel = path.relative(this.workspaceRoot, sf[1].trim()).replace(/\\/g, '/');
          const fileId = `file:${rel}`;
          if (!(fileId in graph.nodes)) { continue; }
          const testId = `test:lcov:${rel}`;
          if (!(testId in graph.nodes)) {
            graph.nodes[testId] = { id: testId, kind: 'test', language: 'meta', label: `Coverage(${rel})` };
          }
          graph.edges.push({ from: testId, to: fileId, kind: 'COVERS', weight: 1 });
          links++;
        }
      } else {
        for (const match of text.matchAll(/filename="([^"]+)"/g)) {
          const rel = path.relative(this.workspaceRoot, match[1]).replace(/\\/g, '/');
          const fileId = `file:${rel}`;
          if (!(fileId in graph.nodes)) { continue; }
          const testId = `test:xml:${rel}`;
          if (!(testId in graph.nodes)) {
            graph.nodes[testId] = { id: testId, kind: 'test', language: 'meta', label: `CoverageXML(${rel})` };
          }
          graph.edges.push({ from: testId, to: fileId, kind: 'COVERS', weight: 1 });
          links++;
        }
      }
    }
    return links;
  }

  private keywordSearch(graph: StoredGraph, query: QueryProfile, topK: number): GraphNode[] {
    const q = query.phrase;
    const scored: Array<{ node: GraphNode; score: number }> = [];
    for (const node of Object.values(graph.nodes)) {
      const hay = `${node.label} ${node.uri ?? ''}`.toLowerCase();
      let score = 0;

      if (q.length > 0 && hay.includes(q)) { score += 0.6; }
      for (const term of query.coreTerms) {
        if (hay.includes(term)) { score += 0.35; }
      }

      for (const fileTerm of query.filenameTerms) {
        if (hay.includes(fileTerm)) { score += 2.2; }
        const singular = fileTerm.endsWith('s.ts') ? fileTerm.slice(0, -4) + '.ts' : '';
        const plural = fileTerm.endsWith('.ts') && !fileTerm.endsWith('s.ts') ? fileTerm.replace('.ts', 's.ts') : '';
        if (singular !== '' && hay.includes(singular)) { score += 1.6; }
        if (plural !== '' && hay.includes(plural)) { score += 1.6; }
      }

      if (score <= 0) { continue; }
      scored.push({ node, score });
    }
    scored.sort((a, b) => b.score - a.score || a.node.id.localeCompare(b.node.id));
    return scored.slice(0, topK).map((r) => ({ ...r.node, score: r.score }));
  }

  private vectorSearch(graph: StoredGraph, query: string, topK: number): Array<{ nodeId: string; score: number }> {
    const qv = this.vectorizer.vectorize(query);
    const out: Array<{ nodeId: string; score: number }> = [];
    for (const [nodeId, vec] of Object.entries(graph.vectors)) {
      out.push({ nodeId, score: this.vectorizer.cosineSimilarity(qv, new Float32Array(vec)) });
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, topK);
  }

  private rankHybridSeeds(
    graph: StoredGraph,
    keyword: GraphNode[],
    vector: Array<{ nodeId: string; score: number }>,
    query: QueryProfile,
  ): Array<{ nodeId: string; score: number }> {
    const fused = new Map<string, { keyword: number; vector: number; graph: number }>();

    for (const row of keyword) {
      const prev = fused.get(row.id) ?? { keyword: 0, vector: 0, graph: 0 };
      prev.keyword = Math.max(prev.keyword, row.score ?? 0);
      fused.set(row.id, prev);
    }

    for (const row of vector) {
      const prev = fused.get(row.nodeId) ?? { keyword: 0, vector: 0, graph: 0 };
      prev.vector = Math.max(prev.vector, row.score);
      fused.set(row.nodeId, prev);
    }

    const degreeByNode = new Map<string, number>();
    for (const edge of graph.edges) {
      degreeByNode.set(edge.from, (degreeByNode.get(edge.from) ?? 0) + 1);
      degreeByNode.set(edge.to, (degreeByNode.get(edge.to) ?? 0) + 1);
    }

    let maxDegree = 1;
    for (const degree of degreeByNode.values()) {
      if (degree > maxDegree) { maxDegree = degree; }
    }

    for (const [nodeId, row] of fused.entries()) {
      const degree = degreeByNode.get(nodeId) ?? 0;
      row.graph = degree / maxDegree;
      fused.set(nodeId, row);
    }

    const weights = this.schema.retrieval.weights;
    const ranked: Array<{ nodeId: string; score: number }> = [];
    for (const [nodeId, row] of fused.entries()) {
      const node = graph.nodes[nodeId];
      const hay = `${node?.label ?? ''} ${node?.uri ?? ''}`.toLowerCase();
      let fileIntentBoost = 0;
      for (const fileTerm of query.filenameTerms) {
        if (hay.includes(fileTerm)) { fileIntentBoost += 1.1; }
        const singular = fileTerm.endsWith('s.ts') ? fileTerm.slice(0, -4) + '.ts' : '';
        const plural = fileTerm.endsWith('.ts') && !fileTerm.endsWith('s.ts') ? fileTerm.replace('.ts', 's.ts') : '';
        if (singular !== '' && hay.includes(singular)) { fileIntentBoost += 0.7; }
        if (plural !== '' && hay.includes(plural)) { fileIntentBoost += 0.7; }
      }
      const score =
        row.keyword * weights.keyword +
        row.vector * weights.vector +
        row.graph * weights.graph +
        fileIntentBoost;
      ranked.push({ nodeId, score });
    }

    ranked.sort((a, b) => b.score - a.score || a.nodeId.localeCompare(b.nodeId));
    return ranked;
  }

  private applyRelationNeighborBoost(
    graph: StoredGraph,
    ranked: Array<{ nodeId: string; score: number }>,
    query: QueryProfile,
  ): void {
    if (!query.relationIntent || query.anchorTerms.length === 0 || ranked.length === 0) { return; }

    const boostById = new Map<string, number>();
    const anchorIds = new Set<string>();

    // Prefer exact/near-exact file basename anchors when query asks for relationships.
    for (const [nodeId, node] of Object.entries(graph.nodes)) {
      if (node.kind !== 'file') { continue; }
      const base = path.posix.basename((node.label ?? '').toLowerCase()).replace(/\.[^.]+$/, '');
      if (query.anchorTerms.some((term) => base === term || base.includes(term))) {
        anchorIds.add(nodeId);
      }
    }

    // Also include class/interface symbols defined in the same anchored files.
    if (anchorIds.size > 0) {
      const anchoredUris = new Set<string>();
      for (const id of anchorIds) {
        const node = graph.nodes[id];
        if (node?.uri) { anchoredUris.add(node.uri); }
      }
      for (const [nodeId, node] of Object.entries(graph.nodes)) {
        if ((node.kind === 'class' || node.kind === 'interface') && node.uri && anchoredUris.has(node.uri)) {
          anchorIds.add(nodeId);
        }
      }
    }

    const rankedAnchors = ranked
      .slice(0, 20)
      .map((row) => ({ row, node: graph.nodes[row.nodeId] }))
      .filter((item) => item.node && (item.node.kind === 'file' || item.node.kind === 'class' || item.node.kind === 'interface'))
      .filter((item) => {
        const hay = `${item.node.label} ${item.node.uri ?? ''}`.toLowerCase();
        return query.anchorTerms.some((term) => hay.includes(term));
      })
      .sort((a, b) => b.row.score - a.row.score);

    if (anchorIds.size === 0 && rankedAnchors.length > 0) {
      const best = rankedAnchors[0].row.score;
      for (const item of rankedAnchors) {
        if (item.row.score < best - 0.08) { break; }
        anchorIds.add(item.row.nodeId);
        if (anchorIds.size >= 2) { break; }
      }
    }

    if (anchorIds.size === 0) {
      for (const [nodeId, node] of Object.entries(graph.nodes)) {
        if (node.kind !== 'file' && node.kind !== 'class' && node.kind !== 'interface') { continue; }
        const hay = `${node.label} ${node.uri ?? ''}`.toLowerCase();
        if (query.anchorTerms.some((term) => hay.includes(term))) {
          anchorIds.add(nodeId);
          if (anchorIds.size >= 2) { break; }
        }
      }
    }

    if (anchorIds.size === 0) { return; }

    let anchoredImportOrdinal = 0;

    for (const edge of graph.edges) {
      const fromAnchor = anchorIds.has(edge.from);
      const toAnchor = anchorIds.has(edge.to);
      if (!fromAnchor && !toAnchor) { continue; }

      const other = fromAnchor ? edge.to : edge.from;
      const otherNode = graph.nodes[other];
      if (!otherNode) { continue; }

      if (otherNode.kind === 'file') {
        let edgeBoost = 0.75;
        if (edge.kind === 'IMPORTS') {
          // Prefer what the anchored file imports/uses over who imports it.
          if (fromAnchor) {
            // Preserve source import order as a deterministic tie-breaker.
            edgeBoost = 30 + Math.max(0, 1 - (anchoredImportOrdinal * 0.02));
            anchoredImportOrdinal += 1;
          } else {
            edgeBoost = 1.0;
          }
        } else if (edge.kind === 'CALLS') {
          edgeBoost = fromAnchor ? 4.0 : 1.0;
        } else if (edge.kind === 'CONTAINS') {
          edgeBoost = 1.0;
        }
        boostById.set(other, (boostById.get(other) ?? 0) + edgeBoost);
      }
    }

    const rankedIndex = new Map<string, number>();
    for (let i = 0; i < ranked.length; i++) {
      rankedIndex.set(ranked[i].nodeId, i);
    }

    for (const [nodeId, boost] of boostById.entries()) {
      if (rankedIndex.has(nodeId)) { continue; }
      ranked.push({ nodeId, score: boost });
      rankedIndex.set(nodeId, ranked.length - 1);
    }

    for (const row of ranked) {
      if (anchorIds.has(row.nodeId)) {
        row.score -= 0.45;
      }
      row.score += boostById.get(row.nodeId) ?? 0;
    }

    ranked.sort((a, b) => b.score - a.score || a.nodeId.localeCompare(b.nodeId));
  }

  private traverse(graph: StoredGraph, seeds: string[], radius: number): { nodes: Array<{ nodeId: string; depth: number }>; edges: GraphEdge[] } {
    const visited = new Map<string, number>();
    const queue: Array<{ id: string; depth: number }> = seeds.map((id) => ({ id, depth: 0 }));
    const keptEdges: GraphEdge[] = [];
    while (queue.length > 0) {
      const current = queue.shift() as { id: string; depth: number };
      const prevDepth = visited.get(current.id);
      if (prevDepth !== undefined && prevDepth <= current.depth) { continue; }
      visited.set(current.id, current.depth);
      if (current.depth >= radius) { continue; }
      for (const edge of graph.edges) {
        if (edge.from !== current.id && edge.to !== current.id) { continue; }
        keptEdges.push(edge);
        const next = edge.from === current.id ? edge.to : edge.from;
        queue.push({ id: next, depth: current.depth + 1 });
      }
    }
    const nodes = Array.from(visited.entries()).map(([nodeId, depth]) => ({ nodeId, depth }));
    nodes.sort((a, b) => a.depth - b.depth || a.nodeId.localeCompare(b.nodeId));
    return { nodes, edges: dedupeEdges(keptEdges) };
  }

  private persistGraph(graph: StoredGraph): void {
    fs.mkdirSync(path.dirname(this.schema.graphPath), { recursive: true });
    fs.writeFileSync(this.schema.graphPath, JSON.stringify(graph), 'utf8');
  }

  private loadGraph(): StoredGraph {
    try {
      const raw = fs.readFileSync(this.schema.graphPath, 'utf8');
      const parsed = JSON.parse(raw) as StoredGraph;
      if (!parsed || !parsed.nodes || !parsed.edges || !parsed.vectors) {
        return { nodes: {}, edges: [], vectors: {} };
      }
      return parsed;
    } catch {
      return { nodes: {}, edges: [], vectors: {} };
    }
  }

  private buildQueryProfile(query: string): QueryProfile {
    const phrase = query.toLowerCase().trim();
    const stop = new Set([
      'what', 'is', 'are', 'does', 'do', 'doing', 'the', 'a', 'an', 'in', 'of', 'to', 'for', 'and', 'or', 'please',
      'other', 'file', 'files', 'relate', 'related', 'relates', 'use', 'uses', 'used', 'using', 'with',
    ]);
    const relationCue = /(relat|depend|use|used|using|import|imports|connected|coupled|other files|linked)/.test(phrase);
    const rawTerms = phrase.split(/[^a-z0-9._/\\-]+/).filter((t) => t.length > 1);
    const filenameTerms: string[] = [];
    const coreTerms: string[] = [];

    for (const term of rawTerms) {
      if (/\.(ts|tsx|js|jsx|java|py|md)$/.test(term)) {
        filenameTerms.push(term);
        coreTerms.push(term.replace(/\.(ts|tsx|js|jsx|java|py|md)$/g, ''));
        continue;
      }
      if (!stop.has(term)) { coreTerms.push(term); }
    }

    // Handle prompts like "scenario ts" that omit the dot before extension.
    for (let i = 0; i < rawTerms.length - 1; i++) {
      const a = rawTerms[i];
      const b = rawTerms[i + 1];
      if (['ts', 'tsx', 'js', 'jsx', 'java', 'py', 'md'].includes(b)) {
        filenameTerms.push(`${a}.${b}`);
      }
    }

    const anchorTerms = rawTerms
      .flatMap((term) => this.splitIdentifierTokens(term))
      .filter((t) => !stop.has(t) && t.length > 2 && !['files', 'file', 'other', 'relate', 'relates', 'use', 'uses', 'used'].includes(t));

    return {
      raw: query,
      coreTerms: Array.from(new Set(coreTerms)),
      filenameTerms: Array.from(new Set(filenameTerms)),
      phrase,
      relationIntent: relationCue,
      anchorTerms: Array.from(new Set(anchorTerms)),
    };
  }

  private splitIdentifierTokens(value: string): string[] {
    const x = value
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .toLowerCase();
    return x
      .split(/[^a-z0-9]+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
  }
}

export function buildRepositoryGraphSchema(workspaceRoot: string): RepositoryGraphSchema {
  const baseDir = path.join(workspaceRoot, '.promptoptimizer', 'repo-intelligence');
  return {
    version: 'ri.v1',
    storageMode: 'local-json',
    graphPath: path.join(baseDir, 'graph.json'),
    indexPath: path.join(baseDir, 'vector-index.json'),
    nodeKinds: ['workspace', 'project', 'file', 'class', 'interface', 'function', 'method', 'annotation', 'doc_chunk', 'test'],
    edgeKinds: ['CONTAINS', 'IMPORTS', 'CALLS', 'IMPLEMENTS', 'ANNOTATED_WITH', 'COVERS', 'DOC_FOR', 'CHANGED_WITH'],
    ingestion: {
      maxFiles: MAX_FILES,
      maxFileBytes: MAX_FILE_BYTES,
      concurrency: INGEST_CONCURRENCY,
      includeGitHistory: true,
      includeCoverage: true,
    },
    parsers: {
      ts: 'regex-fallback',
      java: 'regex-fallback',
      python: 'regex-fallback',
      docs: 'chunk-400',
    },
    retrieval: {
      defaultTraversalDepth: 3,
      defaultVectorTopK: 8,
      defaultKeywordTopK: 12,
      weights: {
        keyword: 0.45,
        vector: 0.35,
        graph: 0.20,
      },
    },
  };
}

function dedupeEdges(edges: GraphEdge[]): GraphEdge[] {
  const seen = new Set<string>();
  const out: GraphEdge[] = [];
  for (const edge of edges) {
    const key = `${edge.from}|${edge.to}|${edge.kind}`;
    if (seen.has(key)) { continue; }
    seen.add(key);
    out.push(edge);
  }
  return out;
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const limit = Math.max(1, concurrency);
  let cursor = 0;
  const runners: Array<Promise<void>> = [];

  for (let i = 0; i < Math.min(limit, items.length); i++) {
    runners.push((async () => {
      while (true) {
        const idx = cursor;
        cursor += 1;
        if (idx >= items.length) { return; }
        await worker(items[idx]);
      }
    })());
  }

  await Promise.all(runners);
}
