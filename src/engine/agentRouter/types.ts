/**
 * Agent Router — shared types + hard budget constants.
 *
 * Every cap in this file exists for ONE reason: token economy. The router
 * never sends whole files to an LLM — it sends line slices, outlines and
 * grep snippets, each individually capped, so the assembled context stays
 * predictably small no matter how large the repository is.
 */

/** HARD CAP: never read more than this many lines in a single tool call.
 *  Whole-file reads are the #1 source of context bloat — a 2k-line file is
 *  ~20k tokens. Callers must page with offset/limit instead. */
export const MAX_LINES_PER_READ = 100;

/** Total context budget (estimated tokens) for one assembled prompt.
 *  Once reached, slice admission STOPS — later hits are dropped, not trimmed,
 *  so every admitted slice stays coherent. */
export const MAX_CONTEXT_TOKENS = 8000;

/** The agentic loop may request more context at most this many times.
 *  Prevents infinite grep→read→grep cycles from burning tokens/time. */
export const MAX_TOOL_ROUNDS = 5;

/** Grep returns at most this many hits by default — presearch is a *scout*,
 *  not a dump. 10 file:line pointers cost ~150 tokens; 500 would cost 7k. */
export const DEFAULT_MAX_GREP_RESULTS = 10;

/** Each grep hit snippet is capped at 5 lines: enough to judge relevance,
 *  cheap enough to show many candidates. */
export const MAX_SNIPPET_LINES = 5;

/** Bounded repo walk so indexing cost is O(repo-but-capped), never unbounded. */
export const MAX_INDEX_FILES = 2000;
export const MAX_INDEX_DEPTH = 10;
export const MAX_FILE_BYTES = 512 * 1024;

// ---------------------------------------------------------------- tool I/O

/** Tool 1: fast text search (ripgrep). */
export interface GrepToolInput {
  pattern: string;
  includeGlob?: string; // e.g. "*.ts"
  excludeGlob?: string; // e.g. "node_modules"
  maxResults?: number; // default DEFAULT_MAX_GREP_RESULTS
}

/** Tool 2: read exact line range (1-based, inclusive). */
export interface ReadSliceToolInput {
  filePath: string;
  startLine: number;
  endLine: number;
}

/** Tool 3: structural outline of one file. */
export interface GetOutlineToolInput {
  filePath: string;
}

export type SymbolKind = 'function' | 'class' | 'interface';

export interface OutlineSymbol {
  name: string;
  type: SymbolKind;
  startLine: number; // 1-based
  endLine: number; // 1-based inclusive
}

export interface FileOutline {
  filePath: string;
  totalLines: number;
  symbols: OutlineSymbol[];
}

export interface ReadSliceResult {
  slice: string;
  /** Present ONLY when the file exceeds MAX_LINES_PER_READ — the outline is a
   *  ~10-token-per-symbol map of "the rest of the file" so the LLM can ask
   *  for a follow-up slice instead of the whole file. */
  outline?: FileOutline;
  startLine: number;
  endLine: number;
  totalLines: number;
}

/** One grep hit, already snippet-capped: "path:start-end:snippet". */
export interface GrepHit {
  filePath: string;
  startLine: number;
  endLine: number;
  snippet: string;
}

// ---------------------------------------------------------------- routing

export type RouteKind = 'path' | 'symbol' | 'concept';

export interface PlannedToolCall {
  tool: 'grep' | 'read_file_slice' | 'get_file_outline';
  input: GrepToolInput | ReadSliceToolInput | GetOutlineToolInput;
}

export interface RouteDecision {
  kind: RouteKind;
  /** Deterministic — computed with zero LLM tokens. */
  plannedCalls: PlannedToolCall[];
  pathHints: string[];
  symbols: string[];
  concepts: string[];
}

/** One admitted context slice, ready for prompt assembly. */
export interface ContextSlice {
  filePath: string;
  startLine: number;
  endLine: number;
  code: string;
}
