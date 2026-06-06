/**
 * Deterministic content pre-filters that run *before* the LLMLingua-2
 * compressor. Each "pipeline" strips structural noise from a specific content
 * type so the downstream model spends its token budget on signal, not
 * boilerplate. A lightweight meta-router classifies raw text and dispatches it
 * to the matching pipeline.
 *
 *   Pipeline 1 — Code-Boilerplate Stripper  (`preFilterCode`)
 *   Pipeline 3 — Log Aggregator / Deduper   (`compressLogStack`)
 *   Meta        — Content router            (`classifyContentType`, `routeContent`)
 *
 * (Pipeline 2 — the sliding-window chat summary cache — lives in the SQLite
 *  segment cache, not here.)
 *
 * Everything in this module is pure and synchronous: no model calls, no I/O.
 */

import { MAX_LOG_LINES } from './constants.js';

export type ContentKind = 'code' | 'log' | 'text';

/** Languages whose snippets benefit from the boilerplate stripper. */
const CODE_LANGUAGES = new Set([
  'ts', 'tsx', 'typescript',
  'js', 'jsx', 'javascript',
  'java', 'kt', 'kotlin',
  'go', 'rs', 'rust',
  'c', 'cpp', 'cc', 'h', 'hpp', 'cs',
  'py', 'python',
  'rb', 'ruby',
  'php', 'swift', 'scala',
]);

/** Languages that use `#` for single-line comments. */
const HASH_COMMENT_LANGUAGES = new Set([
  'py', 'python', 'rb', 'ruby', 'sh', 'bash', 'zsh', 'yaml', 'yml', 'toml',
]);

export function isCodeLanguage(language?: string): boolean {
  return CODE_LANGUAGES.has((language ?? '').toLowerCase());
}

function isFullLineComment(trimmed: string, tokens: string[]): boolean {
  if (trimmed === '') { return false; }
  // Leftover JSDoc / block-comment continuation lines.
  if (trimmed === '*' || trimmed === '*/' || trimmed.startsWith('* ')) { return true; }
  for (const token of tokens) {
    if (trimmed.startsWith(token)) { return true; }
  }
  return false;
}

/**
 * Detects standalone import / pure re-export / `require` lines. Declarations
 * such as `export function`, `export class` or `export const X = <value>` are
 * intentionally preserved — they are logic, not boilerplate.
 */
function isImportOrReexport(trimmed: string): boolean {
  return (
    /^import\b/.test(trimmed) // ES import (incl. `import 'x'`)
    || /^from\s+\S+\s+import\b/.test(trimmed) // Python from-import
    || /^export\s+\{[^}]*\}\s+from\s+['"]/.test(trimmed) // re-export named
    || /^export\s+\*\s+from\s+['"]/.test(trimmed) // re-export all
    || /^export\s+type\s+\{[^}]*\}\s+from\s+['"]/.test(trimmed) // re-export types
    || /^(?:const|let|var)\s+[\w{}\s,]+=\s*require\(/.test(trimmed) // CJS require
    || /^#include\b/.test(trimmed) // C/C++ include
    || /^(?:using|package)\s+[\w.]+;?$/.test(trimmed) // C#/Java using/package
  );
}

/**
 * Pipeline 1 — strip comments, import/boilerplate lines and redundant blank
 * runs from a code snippet while preserving every line of executable logic.
 */
export function preFilterCode(rawCode: string, language?: string): string {
  if (rawCode.trim() === '') { return ''; }

  // 1. Drop block comments (`/* ... */`, JSDoc) across the whole snippet.
  const withoutBlocks = rawCode.replace(/\/\*[\s\S]*?\*\//g, '');

  const lang = (language ?? '').toLowerCase();
  const commentTokens: string[] = [];
  if (!HASH_COMMENT_LANGUAGES.has(lang)) { commentTokens.push('//'); }
  if (HASH_COMMENT_LANGUAGES.has(lang) || lang === '') { commentTokens.push('#'); }

  const kept: string[] = [];
  for (const rawLine of withoutBlocks.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (isFullLineComment(trimmed, commentTokens)) { continue; }
    if (isImportOrReexport(trimmed)) { continue; }
    kept.push(rawLine);
  }

  return kept
    .join('\n')
    .replace(/\n{3,}/g, '\n\n') // collapse 3+ blank lines → a single gap
    .trim();
}

/**
 * Normalises a single log line so structurally identical entries collapse into
 * one cluster: timestamps, hex addresses, UUIDs and stack `:line:col`
 * coordinates are masked, leaving the stable message anchor.
 */
export function normalizeLogLine(line: string): string {
  return line
    // ISO-8601 timestamps (with optional millis / Z).
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, '[TIMESTAMP]')
    // Bare clock times (HH:MM:SS[.mmm]).
    .replace(/\b\d{2}:\d{2}:\d{2}(?:\.\d+)?\b/g, '[TIMESTAMP]')
    // UUIDs.
    .replace(/\b[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}\b/g, '[UUID]')
    // Hex / memory addresses.
    .replace(/\b0x[0-9a-fA-F]+\b/g, '[ADDR]')
    // Stack-frame coordinates: keep the file, drop volatile :line:col.
    .replace(/:(\d+):(\d+)(?=[)\s]|$)/g, '')
    .trim();
}

export interface LogClusterOptions {
  /** Maximum distinct clusters to emit (default: `MAX_LOG_LINES`). */
  maxClusters?: number;
  /** Optional header line prepended to the deduplicated template. */
  header?: string;
}

/**
 * Pipeline 3 — collapse a noisy log/stack dump into a deduplicated template.
 * Structurally identical lines are merged and prefixed with an `(Nx)`
 * occurrence multiplier; the first concrete sample is shown for readability.
 */
export function compressLogStack(rawLogs: string, options: LogClusterOptions = {}): string {
  const order: string[] = [];
  const clusters = new Map<string, { count: number; sample: string }>();

  for (const rawLine of rawLogs.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (trimmed === '') { continue; }
    const anchor = normalizeLogLine(trimmed);
    const existing = clusters.get(anchor);
    if (existing) {
      existing.count++;
    } else {
      clusters.set(anchor, { count: 1, sample: trimmed });
      order.push(anchor);
    }
  }

  if (order.length === 0) { return ''; }

  const limit = options.maxClusters ?? MAX_LOG_LINES;
  const lines: string[] = [];
  if (options.header) { lines.push(options.header); }

  for (const anchor of order.slice(0, limit)) {
    const { count, sample } = clusters.get(anchor)!;
    lines.push(count > 1 ? `(${count}x) ${sample}` : sample);
  }

  return lines.join('\n').trim();
}

/**
 * Meta-router — classify raw content so the caller can dispatch it to the
 * right pipeline. Explicit hints (language / log source) win; otherwise a few
 * cheap heuristics inspect the text itself.
 */
export function classifyContentType(
  text: string,
  hint?: { language?: string; logSource?: string; isLog?: boolean },
): ContentKind {
  if (hint?.isLog || (hint?.logSource ?? '') !== '') { return 'log'; }
  if (isCodeLanguage(hint?.language)) { return 'code'; }

  if (/\b(?:ERROR|WARN|WARNING|FATAL|Exception|Traceback)\b/.test(text)
    || /\bat\s+.+\(.+:\d+:\d+\)/.test(text)) {
    return 'log';
  }

  if (/^\s*(?:import|export|function|class|interface|const|let|var|def|public|private|func)\b/m.test(text)
    && /[{};]/.test(text)) {
    return 'code';
  }

  return 'text';
}

/**
 * Dispatch content through its matching deterministic pipeline. Plain text is
 * returned unchanged (the LLMLingua-2 / text optimizer stages handle prose).
 */
export function routeContent(
  text: string,
  hint?: { language?: string; logSource?: string; isLog?: boolean },
): { kind: ContentKind; content: string } {
  const kind = classifyContentType(text, hint);
  switch (kind) {
    case 'code':
      return { kind, content: preFilterCode(text, hint?.language) };
    case 'log':
      return { kind, content: compressLogStack(text) };
    default:
      return { kind, content: text };
  }
}
