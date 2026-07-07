import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

/**
 * Privacy-preserving snapshot of workspace memory files, prompt versions,
 * and the local cache dir — consumed by the onboarding guide's memory tab.
 * File contents are abstracted to "silhouettes" so real text never leaks.
 */

const MEMORY_FILE_NAMES = [
  'AGENTS.md', 'CLAUDE.md', 'CLAUDE.local.md',
  '.promptoptimizer/memory.md', '.promptoptimizer/knowledge.md',
  'memory.md', 'knowledge.md',
];

interface MemoryFileSnapshot {
  name: string;
  relPath: string;
  bytes: number;
  lines: number;
  tokens: number;
  mtime: number;
  /** Abstract preview: alphanumerics replaced with bullets so contents are not leaked. */
  silhouette: string;
}

export interface MemorySnapshot {
  generatedAt: number;
  workspace: string | null;
  files: MemoryFileSnapshot[];
  totals: { files: number; bytes: number; tokens: number };
  versions: { commits: number; head: string | null; recentTimestamps: number[] };
  cacheDir: { exists: boolean; entries: number; bytes: number };
  tokenBudget: { used: number; max: number };
}

function silhouetteOf(content: string, maxChars = 160): string {
  // Abstract preview — preserve whitespace + structure but redact letters/digits
  // with a Unicode bullet so we never expose secrets or real text.
  const trimmed = content.replace(/\s+/g, ' ').trim().slice(0, maxChars);
  return trimmed.replace(/[A-Za-z0-9]/g, '•');
}

function estimateTokensApprox(bytes: number): number {
  return Math.max(1, Math.round(bytes / 4));
}

function collectMemoryFiles(root: string): { files: MemoryFileSnapshot[]; totalBytes: number } {
  const files: MemoryFileSnapshot[] = [];
  let totalBytes = 0;
  for (const rel of MEMORY_FILE_NAMES) {
    const abs = path.join(root, rel);
    try {
      const st = fs.statSync(abs);
      if (!st.isFile()) { continue; }
      const content = fs.readFileSync(abs, 'utf8');
      const bytes = Buffer.byteLength(content, 'utf8');
      totalBytes += bytes;
      files.push({
        name: path.basename(rel),
        relPath: rel,
        bytes,
        lines: content.split(/\r?\n/).length,
        tokens: estimateTokensApprox(bytes),
        mtime: st.mtimeMs,
        silhouette: silhouetteOf(content),
      });
    } catch { /* file absent — skip silently */ }
  }
  return { files, totalBytes };
}

function collectVersionLog(root: string): MemorySnapshot['versions'] {
  let commits = 0;
  let head: string | null = null;
  const recentTimestamps: number[] = [];
  const vp = path.join(root, '.promptoptimizer', 'versions.jsonl');
  try {
    const text = fs.readFileSync(vp, 'utf8');
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
    commits = lines.length;
    if (lines.length > 0) {
      try {
        const last = JSON.parse(lines[lines.length - 1]) as { id?: string };
        head = (last.id ?? '').slice(0, 7) || null;
      } catch { /* malformed line */ }
    }
    // Pull up to last 40 timestamps for a sparkline.
    for (const ln of lines.slice(-40)) {
      try {
        const obj = JSON.parse(ln) as { ts?: number; time?: number; createdAt?: number };
        const t = obj.ts ?? obj.time ?? obj.createdAt;
        if (typeof t === 'number' && isFinite(t)) { recentTimestamps.push(t); }
      } catch { /* skip */ }
    }
  } catch { /* no version log yet */ }
  return { commits, head, recentTimestamps };
}

function collectCacheDir(root: string): MemorySnapshot['cacheDir'] {
  const cd = path.join(root, '.promptoptimizer', 'cache');
  try {
    const entries = fs.readdirSync(cd);
    let bytes = 0;
    for (const e of entries) {
      try {
        const st = fs.statSync(path.join(cd, e));
        if (st.isFile()) { bytes += st.size; }
      } catch { /* skip */ }
    }
    return { exists: true, entries: entries.length, bytes };
  } catch {
    return { exists: false, entries: 0, bytes: 0 };
  }
}

export function collectMemorySnapshot(): MemorySnapshot {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
  const { files, totalBytes } = root ? collectMemoryFiles(root) : { files: [], totalBytes: 0 };

  const TOKEN_BUDGET_MAX = 24_000; // matches MAX_TOTAL_BYTES default in memory/budget.ts
  return {
    generatedAt: Date.now(),
    workspace: root ? path.basename(root) : null,
    files,
    totals: {
      files: files.length,
      bytes: totalBytes,
      tokens: estimateTokensApprox(totalBytes),
    },
    versions: root ? collectVersionLog(root) : { commits: 0, head: null, recentTimestamps: [] },
    cacheDir: root ? collectCacheDir(root) : { exists: false, entries: 0, bytes: 0 },
    tokenBudget: { used: totalBytes, max: TOKEN_BUDGET_MAX },
  };
}
