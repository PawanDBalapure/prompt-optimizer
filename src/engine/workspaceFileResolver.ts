/**
 * Workspace exact-match file resolver.
 *
 * The context packer's deterministic routing only sees the files the IDE
 * hands it (active + open editors). When a prompt names a file or symbol
 * that is NOT open — "fix the bug in tokenBudget.ts", "what does
 * SegmentReuseStore do" — the exact match exists in the code base but the
 * engine never finds it. This module closes that gap with a bounded, safe,
 * deterministic scan of `workspace_root` that resolves prompt evidence
 * (explicit path hints, salient identifiers, plain-English phrase words)
 * to real files on disk.
 *
 * Safety bounds (never throws, degrades to an empty result):
 *   - directory walk capped by depth and total entries visited;
 *   - symlinks are never followed (no cycles, no escape from the root);
 *   - heavy/vendored directories are skipped (node_modules, .git, dist, …);
 *   - only text-like source extensions are considered;
 *   - at most {@link MAX_DISCOVERED_FILES} files are read, each capped at
 *     {@link MAX_FILE_BYTES} bytes.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { IdeContextFile } from '../contracts.js';
import { detectLanguageFromPath } from './contextPacker.helpers.js';
import { scoreFilenamePhraseMatch } from './symbolPhraseMatch.js';

/** Directories never worth scanning: vendored, generated, or VCS internals. */
const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'out', 'build', 'coverage', 'target', 'vendor',
  '__pycache__', 'venv', '.venv', 'bin', 'obj',
]);

/** Dot-directories are skipped except these (users do ask about them). */
const ALLOWED_DOT_DIRS = new Set(['.github', '.promptoptimizer']);

/** Text/source extensions eligible for exact-match discovery. */
const TEXT_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'java', 'kt', 'kts', 'go',
  'rs', 'rb', 'php', 'cs', 'c', 'h', 'cpp', 'hpp', 'swift', 'scala', 'sql',
  'json', 'yaml', 'yml', 'toml', 'xml', 'html', 'css', 'scss', 'less', 'md',
  'txt', 'sh', 'ps1', 'bat', 'gradle', 'properties', 'vue', 'svelte',
]);

const MAX_SCAN_DEPTH = 8;
const MAX_SCAN_ENTRIES = 4000;
const MAX_DISCOVERED_FILES = 3;
const MAX_FILE_BYTES = 512 * 1024;

/** Minimum evidence score for a scanned file to be admitted as an exact match. */
const MIN_EVIDENCE_SCORE = 75;

export interface WorkspaceResolveQuery {
  workspaceRoot: string;
  /** Normalized (lowercase, forward-slash) relative path hints from the prompt. */
  pathHints: Set<string>;
  /** Lowercased whole identifiers the prompt is about (camelCase kept intact). */
  salientTerms: Set<string>;
  /** Plain prompt words for filename-phrase matching (original casing kept). */
  promptWords: string[];
  /** Paths already supplied by the IDE — never re-discovered. */
  excludePaths: Set<string>;
}

interface ScoredPath {
  relPath: string;
  absPath: string;
  score: number;
}

function normalizeRel(input: string): string {
  return input.replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase();
}

function stemOf(basename: string): string {
  return basename.includes('.') ? basename.slice(0, basename.indexOf('.')) : basename;
}

function scorePathAgainstQuery(relPath: string, query: WorkspaceResolveQuery): number {
  const normalized = normalizeRel(relPath);
  const base = normalized.slice(normalized.lastIndexOf('/') + 1);

  let best = 0;
  for (const hint of query.pathHints) {
    if (normalized === hint || normalized.endsWith(`/${hint}`)) { return 100; }
    const hintBase = hint.slice(hint.lastIndexOf('/') + 1);
    if (base === hintBase) { best = Math.max(best, 90); }
  }

  const stemLower = stemOf(base);
  if (stemLower !== '' && query.salientTerms.has(stemLower)) {
    best = Math.max(best, 90);
  }

  if (query.promptWords.length > 0) {
    // Preserve original casing for subword decomposition (camelCase boundaries).
    const originalBase = relPath.replace(/\\/g, '/');
    const casedStem = stemOf(originalBase.slice(originalBase.lastIndexOf('/') + 1));
    best = Math.max(best, scoreFilenamePhraseMatch(casedStem, query.promptWords));
  }
  return best;
}

/**
 * Walk the workspace tree (bounded, symlink-free) collecting candidate file
 * paths whose name/path matches the prompt evidence at or above
 * {@link MIN_EVIDENCE_SCORE}.
 */
function scanForMatches(query: WorkspaceResolveQuery): ScoredPath[] {
  const matches: ScoredPath[] = [];
  let visited = 0;
  const rootReal = path.resolve(query.workspaceRoot);

  const walk = (dirAbs: string, relPrefix: string, depth: number): void => {
    if (depth > MAX_SCAN_DEPTH || visited >= MAX_SCAN_ENTRIES) { return; }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (visited >= MAX_SCAN_ENTRIES) { return; }
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
      if (!TEXT_EXTENSIONS.has(ext)) { continue; }
      const relPath = relPrefix === '' ? name : `${relPrefix}/${name}`;
      if (query.excludePaths.has(normalizeRel(relPath))) { continue; }
      const score = scorePathAgainstQuery(relPath, query);
      if (score >= MIN_EVIDENCE_SCORE) {
        matches.push({ relPath, absPath: path.join(rootReal, relPath), score });
      }
    }
  };

  walk(rootReal, '', 0);
  return matches.sort((l, r) => r.score - l.score || l.relPath.length - r.relPath.length);
}

/**
 * Resolve prompt evidence to actual workspace files. Returns at most
 * {@link MAX_DISCOVERED_FILES} files, strongest evidence first, with content
 * loaded (capped) so they can join the packer's normal candidate scoring.
 * Never throws — any I/O problem simply yields fewer (or zero) results.
 */
export function resolveWorkspaceFiles(query: WorkspaceResolveQuery): IdeContextFile[] {
  if (query.workspaceRoot.trim() === '') { return []; }
  if (query.pathHints.size === 0 && query.salientTerms.size === 0 && query.promptWords.length === 0) {
    return [];
  }

  let rootStat: fs.Stats;
  try {
    rootStat = fs.statSync(query.workspaceRoot);
  } catch {
    return [];
  }
  if (!rootStat.isDirectory()) { return []; }

  const resolved: IdeContextFile[] = [];
  for (const match of scanForMatches(query)) {
    if (resolved.length >= MAX_DISCOVERED_FILES) { break; }
    try {
      const stat = fs.statSync(match.absPath);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) { continue; }
      // Containment guard: the resolved path must stay under the workspace root.
      const real = path.resolve(match.absPath);
      const rootReal = path.resolve(query.workspaceRoot);
      if (real !== rootReal && !real.startsWith(rootReal + path.sep)) { continue; }
      const content = fs.readFileSync(match.absPath, 'utf8');
      resolved.push({
        path: match.relPath,
        content,
        language: detectLanguageFromPath(match.relPath) || undefined,
      });
    } catch {
      // Unreadable file — skip, never break optimization.
    }
  }
  return resolved;
}
