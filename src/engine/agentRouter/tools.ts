/**
 * Tools — grep (ripgrep), read_file_slice, get_file_outline.
 *
 * Design rules that save tokens:
 *  - grep shells out to ripgrep (`rg`) — native speed, and its own
 *    --max-count keeps result payloads tiny. NO custom JS file scanner.
 *  - read_file_slice HARD-caps at MAX_LINES_PER_READ; big files return an
 *    outline alongside so the model can page instead of asking for the file.
 *  - every result is `file:start-end:snippet` — pointers, not payloads.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { outlineFile } from './indexer.js';
import {
  DEFAULT_MAX_GREP_RESULTS,
  MAX_LINES_PER_READ,
  MAX_SNIPPET_LINES,
  type FileOutline,
  type GetOutlineToolInput,
  type GrepHit,
  type GrepToolInput,
  type ReadSliceResult,
  type ReadSliceToolInput,
} from './types.js';

let ripgrepCommand: string | null | undefined;

/** Resolve the ripgrep binary once per process. Checks PATH, an explicit
 *  override, and the @vscode/ripgrep vendored binary — we always shell out
 *  to real rg, never a JS scanner (speed + built-in result capping). */
function resolveRipgrep(): string | null {
  if (ripgrepCommand !== undefined) { return ripgrepCommand; }
  const exe = process.platform === 'win32' ? 'rg.exe' : 'rg';
  const candidates = [
    process.env.PROMPT_OPT_RG_PATH ?? '',
    'rg',
    path.join(process.cwd(), 'node_modules', '@vscode', 'ripgrep', 'bin', exe),
  ].filter((c) => c !== '');
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ['--version'], { stdio: 'ignore', timeout: 3000 });
      ripgrepCommand = candidate;
      return ripgrepCommand;
    } catch { /* try next */ }
  }
  ripgrepCommand = null;
  return ripgrepCommand;
}

export class AgentToolExecutor {
  constructor(private readonly workspaceRoot: string) {}

  /**
   * Tool 1 — fast text presearch. Returns AT MOST maxResults hits, each
   * snippet-capped at MAX_SNIPPET_LINES. Presearch exists to find *pointers*
   * (file + line range); the agent then reads exact slices — never files.
   */
  grep(input: GrepToolInput): GrepHit[] {
    const maxResults = Math.max(1, Math.min(input.maxResults ?? DEFAULT_MAX_GREP_RESULTS, 50));
    const rg = resolveRipgrep();
    if (rg === null) { return []; } // fault-tolerant: enrichment is optional, never fatal
    const args = [
      '--line-number', '--no-heading', '--color', 'never',
      '--max-count', '3', // per-file cap: spread hits across files, not 50 in one
      '--max-filesize', '512K',
      '-g', '!node_modules', '-g', '!.git', '-g', '!dist', '-g', '!out',
    ];
    if (input.includeGlob) { args.push('-g', input.includeGlob); }
    if (input.excludeGlob) { args.push('-g', `!${input.excludeGlob}`); }
    // -F would break regex patterns; -e keeps patterns starting with '-' safe.
    args.push('-e', input.pattern, '.');
    let stdout = '';
    try {
      stdout = execFileSync(rg, args, {
        cwd: this.workspaceRoot,
        encoding: 'utf8',
        timeout: 10_000,
        maxBuffer: 4 * 1024 * 1024,
      });
    } catch (err) {
      // rg exits 1 on "no matches" — that's a valid empty result, not an error.
      const anyErr = err as { status?: number; stdout?: string };
      if (anyErr.status === 1) { return []; }
      stdout = typeof anyErr.stdout === 'string' ? anyErr.stdout : '';
    }
    const hits: GrepHit[] = [];
    for (const line of stdout.split(/\r?\n/)) {
      if (hits.length >= maxResults) { break; }
      // Format: path:lineNo:text — split on the first two colons only
      // (Windows drive letters are avoided because rg runs with cwd + './').
      const match = /^(.+?):(\d+):(.*)$/.exec(line);
      if (!match) { continue; }
      const relPath = match[1].replace(/^\.\//, '').replace(/\\/g, '/');
      const lineNo = Number(match[2]);
      const snippet = this.readSnippetAround(relPath, lineNo);
      if (snippet === undefined) { continue; }
      hits.push({ filePath: relPath, startLine: snippet.start, endLine: snippet.end, snippet: snippet.text });
    }
    return hits;
  }

  /** Formats hits exactly as the schema demands: "path:start-end:snippet". */
  static formatHits(hits: GrepHit[]): string[] {
    return hits.map((h) => `${h.filePath}:${h.startLine}-${h.endLine}:${h.snippet.replace(/\n/g, '\\n')}`);
  }

  /**
   * Tool 2 — read an exact line slice (1-based inclusive). The range is
   * clamped to MAX_LINES_PER_READ; if the file is bigger than one read, the
   * result carries a structural outline of the whole file so the model can
   * target its next read precisely instead of paging blindly.
   */
  readFileSlice(input: ReadSliceToolInput): ReadSliceResult {
    const abs = this.resolveInside(input.filePath);
    const content = fs.readFileSync(abs, 'utf8');
    const lines = content.split(/\r?\n/);
    const total = lines.length;
    const start = Math.max(1, Math.min(input.startLine, total));
    // HARD CAP: never emit more than MAX_LINES_PER_READ lines per call.
    const cappedEnd = Math.min(input.endLine, start + MAX_LINES_PER_READ - 1, total);
    const slice = lines.slice(start - 1, cappedEnd).join('\n');
    const result: ReadSliceResult = { slice, startLine: start, endLine: cappedEnd, totalLines: total };
    if (total > MAX_LINES_PER_READ) {
      result.outline = this.getFileOutline({ filePath: input.filePath });
    }
    return result;
  }

  /** Tool 3 — symbol map (name/type/range). ~10 tokens per symbol. */
  getFileOutline(input: GetOutlineToolInput): FileOutline {
    const abs = this.resolveInside(input.filePath);
    const outline = outlineFile(abs);
    return { ...outline, filePath: input.filePath.replace(/\\/g, '/') };
  }

  /** Path-containment guard: tools must never read outside the workspace. */
  private resolveInside(filePath: string): string {
    const abs = path.isAbsolute(filePath) ? filePath : path.join(this.workspaceRoot, filePath);
    const normalized = path.resolve(abs);
    const root = path.resolve(this.workspaceRoot);
    if (!normalized.toLowerCase().startsWith(root.toLowerCase() + path.sep) && normalized.toLowerCase() !== root.toLowerCase()) {
      throw new Error(`Path escapes workspace: ${filePath}`);
    }
    return normalized;
  }

  /** ±2 lines around a hit, capped at MAX_SNIPPET_LINES total. */
  private readSnippetAround(relPath: string, lineNo: number): { start: number; end: number; text: string } | undefined {
    try {
      const lines = fs.readFileSync(this.resolveInside(relPath), 'utf8').split(/\r?\n/);
      const half = Math.floor(MAX_SNIPPET_LINES / 2);
      const start = Math.max(1, lineNo - half);
      const end = Math.min(lines.length, start + MAX_SNIPPET_LINES - 1);
      return { start, end, text: lines.slice(start - 1, end).join('\n') };
    } catch {
      return undefined;
    }
  }
}
