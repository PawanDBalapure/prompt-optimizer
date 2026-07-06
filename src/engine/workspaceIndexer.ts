/**
 * Full-workspace static code indexer for the SQLite knowledge graph.
 *
 * Historically the KG only harvested the files the IDE happened to hand the
 * engine (active + open editors), so a workspace "index/refresh" never put
 * the code base itself into the graph. This module walks the whole workspace
 * (bounded, symlink-free) and feeds every source file through
 * {@link KnowledgeGraph.indexStaticFiles}, producing:
 *
 *   file nodes      — one per source file (stable name = relative path);
 *   concept nodes   — exported/defined symbols + filename stems;
 *   edges           — file→concept `implements`, concept→file `implemented-by`,
 *                     stem→file `names-file`, file→file `depends-on`.
 *
 * All upserts are keyed on (workspace, type, name), so re-indexing is
 * idempotent: node/edge *counts* never grow on repeated refreshes.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { KnowledgeGraph } from './knowledgeGraph.js';

/** Directories never worth indexing: vendored, generated, or VCS internals. */
const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'out', 'build', 'coverage', 'target', 'vendor',
  '__pycache__', 'venv', '.venv', 'bin', 'obj',
]);

/** Dot-directories are skipped except these (they hold indexable config/docs). */
const ALLOWED_DOT_DIRS = new Set(['.github', '.promptoptimizer']);

/** Source extensions eligible for static graph indexing. */
const SOURCE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'java', 'kt', 'kts', 'go',
  'rs', 'rb', 'php', 'cs', 'c', 'h', 'cpp', 'hpp', 'swift', 'scala', 'sql',
  'vue', 'svelte',
]);

const MAX_INDEX_FILES = 2000;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_SCAN_DEPTH = 10;
const MAX_SCAN_ENTRIES = 20_000;
const READ_BATCH_SIZE = 100;

export interface WorkspaceIndexStats {
  /** Source files discovered inside the bounded walk. */
  scannedFiles: number;
  /** Files whose content was read and indexed into the graph. */
  indexedFiles: number;
  /** Symbol (concept) upserts performed. */
  symbols: number;
  /** Edge upserts performed. */
  edges: number;
}

/** Bounded, symlink-free walk returning workspace-relative source paths. */
function discoverSourceFiles(workspaceRoot: string): string[] {
  const out: string[] = [];
  let visited = 0;

  const walk = (dirAbs: string, relPrefix: string, depth: number): void => {
    if (depth > MAX_SCAN_DEPTH || visited >= MAX_SCAN_ENTRIES || out.length >= MAX_INDEX_FILES) { return; }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (visited >= MAX_SCAN_ENTRIES || out.length >= MAX_INDEX_FILES) { return; }
      visited++;
      const name = entry.name;
      if (entry.isSymbolicLink()) { continue; }
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(name)) { continue; }
        if (name.startsWith('.') && !ALLOWED_DOT_DIRS.has(name)) { continue; }
        walk(path.join(dirAbs, name), relPrefix === '' ? name : `${relPrefix}/${name}`, depth + 1);
        continue;
      }
      if (!entry.isFile()) { continue; }
      const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
      if (!SOURCE_EXTENSIONS.has(ext)) { continue; }
      out.push(relPrefix === '' ? name : `${relPrefix}/${name}`);
    }
  };

  walk(path.resolve(workspaceRoot), '', 0);
  return out;
}

/**
 * Index every source file in the workspace into the knowledge graph.
 * Reads files in small batches (bounded memory) while resolving relative
 * imports against the *complete* discovered path set, so cross-directory
 * `depends-on` edges land correctly. Never throws — I/O failures simply mean
 * fewer files are indexed.
 */
export function indexWorkspaceStatic(
  kg: KnowledgeGraph,
  workspaceId: string,
  workspaceRoot: string,
): WorkspaceIndexStats {
  const stats: WorkspaceIndexStats = { scannedFiles: 0, indexedFiles: 0, symbols: 0, edges: 0 };
  try {
    if (!fs.statSync(workspaceRoot).isDirectory()) { return stats; }
  } catch {
    return stats;
  }

  const relPaths = discoverSourceFiles(workspaceRoot);
  stats.scannedFiles = relPaths.length;
  if (relPaths.length === 0) { return stats; }

  const rootAbs = path.resolve(workspaceRoot);
  for (let offset = 0; offset < relPaths.length; offset += READ_BATCH_SIZE) {
    const batch: Array<{ path: string; content: string }> = [];
    for (const relPath of relPaths.slice(offset, offset + READ_BATCH_SIZE)) {
      try {
        const abs = path.join(rootAbs, relPath);
        if (fs.statSync(abs).size > MAX_FILE_BYTES) { continue; }
        batch.push({ path: relPath, content: fs.readFileSync(abs, 'utf8') });
      } catch {
        // Unreadable file — skip, indexing is best-effort.
      }
    }
    if (batch.length === 0) { continue; }
    const result = kg.indexStaticFiles(workspaceId, batch, relPaths);
    stats.indexedFiles += result.files;
    stats.symbols += result.symbols;
    stats.edges += result.edges;
  }
  return stats;
}
