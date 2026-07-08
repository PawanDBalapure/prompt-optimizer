/**
 * Indexer — .gitignore-aware repo walk + AST-flavoured file outliner.
 *
 * The index stores ONLY paths and symbol line-ranges (name/type/start/end),
 * never file bodies. That keeps the whole in-memory index a few KB even for
 * large repos, and lets the router answer "which file defines X?" without a
 * single LLM token or whole-file read.
 *
 * Outlining uses a regex declaration scanner + brace/indent end-detection —
 * the tree-sitter *concepts* (named declaration nodes with ranges) without
 * requiring native grammar builds. Swappable for web-tree-sitter later.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  MAX_FILE_BYTES,
  MAX_INDEX_DEPTH,
  MAX_INDEX_FILES,
  type FileOutline,
  type OutlineSymbol,
  type SymbolKind,
} from './types.js';

const ALWAYS_IGNORED = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.idea', '.vscode-test']);
const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.java', '.kt', '.go', '.rs', '.cs']);

/** Parse .gitignore into simple matchers. Supports the common cases (dir
 *  names, globs with one `*`, anchored paths) — enough to skip vendored and
 *  generated trees, which is where the token savings are. */
export function parseGitignore(workspaceRoot: string): (relPath: string) => boolean {
  const patterns: RegExp[] = [];
  try {
    const raw = fs.readFileSync(path.join(workspaceRoot, '.gitignore'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('!')) { continue; }
      const cleaned = trimmed.replace(/^\//, '').replace(/\/$/, '');
      // Escape regex metachars, then re-expand glob stars.
      const escaped = cleaned.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*');
      patterns.push(new RegExp(`(^|/)${escaped}(/|$)`));
    }
  } catch {
    // No .gitignore — fall through to the built-in ignore set only.
  }
  return (relPath: string) => {
    const normalized = relPath.replace(/\\/g, '/');
    for (const segment of normalized.split('/')) {
      if (ALWAYS_IGNORED.has(segment) || (segment.startsWith('.') && segment !== '.' && segment !== '.github')) { return true; }
    }
    return patterns.some((p) => p.test(normalized));
  };
}

export interface RepoIndexEntry {
  relPath: string;
  absPath: string;
}

/** Bounded walk: caps on depth/file-count/file-size keep indexing latency and
 *  memory flat regardless of repo size. */
export function buildRepoIndex(workspaceRoot: string): RepoIndexEntry[] {
  const isIgnored = parseGitignore(workspaceRoot);
  const entries: RepoIndexEntry[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_INDEX_DEPTH || entries.length >= MAX_INDEX_FILES) { return; }
    let children: fs.Dirent[];
    try { children = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const child of children) {
      if (entries.length >= MAX_INDEX_FILES) { return; }
      const abs = path.join(dir, child.name);
      const rel = path.relative(workspaceRoot, abs);
      if (isIgnored(rel)) { continue; }
      if (child.isSymbolicLink()) { continue; }
      if (child.isDirectory()) { walk(abs, depth + 1); continue; }
      if (!CODE_EXTENSIONS.has(path.extname(child.name))) { continue; }
      try { if (fs.statSync(abs).size > MAX_FILE_BYTES) { continue; } } catch { continue; }
      entries.push({ relPath: rel.replace(/\\/g, '/'), absPath: abs });
    }
  };
  walk(workspaceRoot, 0);
  return entries;
}

/** Declaration matchers per symbol kind (TS/JS-centric, tolerant of exports). */
const DECLARATION_PATTERNS: Array<{ kind: SymbolKind; regex: RegExp }> = [
  { kind: 'class', regex: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'interface', regex: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'function', regex: /^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'function', regex: /^\s*(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/ },
  { kind: 'function', regex: /^\s*(?:public|private|protected|static|async|\s)*([A-Za-z_$][\w$]*)\s*\([^;]*\)\s*(?::[^{;]+)?\{\s*$/ },
  { kind: 'function', regex: /^\s*def\s+([A-Za-z_]\w*)/ }, // python
];

const METHOD_NAME_BLOCKLIST = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'constructor', 'super', 'new']);

/** Find where a declaration ends by brace balancing (falls back to indent for
 *  brace-less languages). Bounded scan — outline generation is O(lines). */
function findSymbolEnd(lines: string[], startIdx: number): number {
  let depth = 0;
  let sawBrace = false;
  for (let i = startIdx; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') { depth++; sawBrace = true; } else if (ch === '}') { depth--; }
    }
    if (sawBrace && depth <= 0) { return i + 1; }
    if (!sawBrace && i > startIdx && /^\S/.test(lines[i]) && lines[i].trim() !== '') { return i; } // indent-based end
  }
  return lines.length;
}

/** Build a structural outline: symbol names + line ranges only (~10 tokens per
 *  symbol) — the cheapest possible "map" of a file for the LLM. */
export function outlineFile(absPath: string): FileOutline {
  let content = '';
  try { content = fs.readFileSync(absPath, 'utf8'); } catch { /* unreadable → empty outline */ }
  const lines = content.split(/\r?\n/);
  const symbols: OutlineSymbol[] = [];
  for (let i = 0; i < lines.length; i++) {
    for (const { kind, regex } of DECLARATION_PATTERNS) {
      const match = regex.exec(lines[i]);
      if (!match) { continue; }
      const name = match[1];
      if (METHOD_NAME_BLOCKLIST.has(name)) { break; }
      symbols.push({ name, type: kind, startLine: i + 1, endLine: findSymbolEnd(lines, i) });
      break; // first pattern wins per line
    }
    if (symbols.length >= 200) { break; } // hard cap: outline stays compact
  }
  return { filePath: absPath, totalLines: lines.length, symbols };
}
