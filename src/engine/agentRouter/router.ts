/**
 * Router — deterministic query parsing. ZERO LLM tokens.
 *
 * The single biggest token saving in the whole pipeline: instead of asking a
 * model "which tool should I call?", plain regex/heuristics classify the
 * prompt into path / symbol / concept routes and pre-plan the exact tool
 * calls. An LLM only ever sees the *results*.
 */
import {
  DEFAULT_MAX_GREP_RESULTS,
  type PlannedToolCall,
  type RouteDecision,
  type RouteKind,
} from './types.js';

/** Explicit file paths: "src/engine/foo.ts", "panel.html", "a\\b.py". */
const PATH_PATTERN = /(?:[A-Za-z0-9_.-]+[/\\])*[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|java|kt|go|rs|cs|json|md|html|css)\b/g;

/** Code identifiers: backticked, camelCase, PascalCase or snake_case ≥4 chars.
 *  These are *exact-match* candidates → symbol search, not fuzzy search. */
const BACKTICK_PATTERN = /`([A-Za-z_$][\w$.]*)`/g;
const CAMEL_PATTERN = /\b([a-z]+[A-Z][A-Za-z0-9]*|[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*|[a-z0-9]+_[a-z0-9_]{2,})\b/g;

/** English filler that must never become a grep concept — greps for "the" or
 *  "should" return thousands of useless (token-burning) hits. */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'into', 'what', 'how',
  'why', 'where', 'when', 'does', 'can', 'should', 'would', 'will', 'have',
  'has', 'are', 'was', 'were', 'not', 'you', 'about', 'file', 'code', 'make',
  'add', 'fix', 'change', 'update', 'implement', 'create', 'use', 'using',
  'work', 'works', 'need', 'want', 'like', 'all', 'any', 'get', 'set',
]);

export function parseQuery(prompt: string): { pathHints: string[]; symbols: string[]; concepts: string[] } {
  const pathHints = Array.from(new Set((prompt.match(PATH_PATTERN) ?? []).map((p) => p.replace(/\\/g, '/'))));
  const symbols = new Set<string>();
  for (const match of prompt.matchAll(BACKTICK_PATTERN)) { symbols.add(match[1]); }
  for (const match of prompt.matchAll(CAMEL_PATTERN)) {
    // Skip tokens already claimed as part of a path hint.
    if (!pathHints.some((p) => p.includes(match[1]))) { symbols.add(match[1]); }
  }
  // Concepts: remaining meaningful words (≥4 chars, not stopwords, not symbols).
  const concepts: string[] = [];
  for (const word of prompt.toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) ?? []) {
    if (STOPWORDS.has(word)) { continue; }
    if (concepts.includes(word)) { continue; }
    if (Array.from(symbols).some((s) => s.toLowerCase() === word)) { continue; }
    concepts.push(word);
    if (concepts.length >= 4) { break; } // cap: ≥5 concept greps is noise, not signal
  }
  return { pathHints, symbols: Array.from(symbols).slice(0, 4), concepts };
}

/**
 * Deterministically plan tool calls. Priority order mirrors evidence
 * strength — a named path beats a named symbol beats vague wording:
 *   1. path   → outline the file, then slice its most relevant region
 *   2. symbol → grep the exact identifier (word-boundary) to find def/usages
 *   3. concept→ broad-ish grep of the 1-2 strongest content words
 */
export function routeQuery(prompt: string): RouteDecision {
  const { pathHints, symbols, concepts } = parseQuery(prompt);
  const plannedCalls: PlannedToolCall[] = [];
  let kind: RouteKind = 'concept';

  if (pathHints.length > 0) {
    kind = 'path';
    for (const hint of pathHints.slice(0, 2)) {
      // Outline first: costs ~10 tokens/symbol and tells us WHICH lines matter.
      plannedCalls.push({ tool: 'get_file_outline', input: { filePath: hint } });
    }
  }
  if (symbols.length > 0) {
    if (kind !== 'path') { kind = 'symbol'; }
    for (const symbol of symbols.slice(0, 3)) {
      plannedCalls.push({
        tool: 'grep',
        // \b word boundary: exact identifier only — substring matches on short
        // names (e.g. "run") would flood the result cap with noise.
        input: { pattern: `\\b${escapeRegex(symbol)}\\b`, maxResults: DEFAULT_MAX_GREP_RESULTS },
      });
    }
  }
  if (plannedCalls.length === 0 && concepts.length > 0) {
    // Vague prompt: one alternation grep over top concepts, capped tighter —
    // concept hits are lower-confidence, so we spend fewer tokens on them.
    plannedCalls.push({
      tool: 'grep',
      input: { pattern: concepts.slice(0, 3).map(escapeRegex).join('|'), maxResults: 6 },
    });
  }
  return { kind, plannedCalls, pathHints, symbols, concepts };
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
