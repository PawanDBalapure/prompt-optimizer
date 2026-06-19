/**
 * Pure (vectorizer-independent) helpers for {@link ContextPacker}. Kept in a
 * focused module so the packer class stays small and the snippet-extraction
 * logic can also report the exact line ranges it selected.
 */
import type { IdeContextFile, IdeContextLog } from '../contracts.js';
import { MAX_FILE_LINES, MAX_LOG_LINES, SMALL_FILE_LINES } from './constants.js';
import { compressLogStack, isCodeLanguage, preFilterCode } from './contentPipelines.js';

const LANGUAGE_BY_EXT: Record<string, string> = {
  ts: 'ts',
  tsx: 'ts',
  js: 'js',
  jsx: 'js',
  py: 'python',
  java: 'java',
  kt: 'kotlin',
  json: 'json',
  md: 'md',
  xml: 'xml',
};

/** A 0-based, inclusive line range within a file's original content. */
export interface LineRange {
  start: number;
  end: number;
}

/** Snippet text plus the original-file line ranges it was drawn from. */
export interface FileSnippet {
  text: string;
  ranges: LineRange[];
}

export function detectLanguageFromPath(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase();
  return (ext && LANGUAGE_BY_EXT[ext]) ?? '';
}

export function lineMatchesQuery(line: string, queryTerms: Set<string>): boolean {
  for (const term of queryTerms) {
    if (term !== '' && line.includes(term.toLowerCase())) { return true; }
  }
  return false;
}

const IDENT_CHAR = /[a-z0-9_$]/;

/**
 * Pull the literal code symbols a prompt is *about* — backticked spans plus
 * camelCase / PascalCase / snake_case identifiers (≥ 4 chars). Unlike the
 * vectorizer tokens these are NOT split on case, so `buildModeItems` stays
 * whole and can be matched precisely instead of via its generic `build` /
 * `mode` / `item` fragments (which light up most of a large file).
 */
export function extractSalientTerms(rawPrompt: string): Set<string> {
  const out = new Set<string>();
  for (const match of rawPrompt.matchAll(/`([^`]+)`/g)) {
    const term = match[1].trim().toLowerCase();
    if (term.length >= 3) { out.add(term); }
  }
  for (const match of rawPrompt.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) {
    const token = match[0];
    if (token.length < 4) { continue; }
    const isCamel = /[a-z]/.test(token) && /[A-Z]/.test(token);
    const isSnake = token.includes('_');
    if (isCamel || isSnake) { out.add(token.toLowerCase()); }
  }
  return out;
}

/** Whole-identifier (word-boundary) match for a literal symbol on a line. */
export function lineMatchesLiteral(lineLower: string, terms: Set<string>): boolean {
  for (const term of terms) {
    if (term === '') { continue; }
    let from = 0;
    let index = lineLower.indexOf(term, from);
    while (index !== -1) {
      const before = index === 0 ? '' : lineLower[index - 1];
      const after = lineLower[index + term.length] ?? '';
      if (!IDENT_CHAR.test(before) && !IDENT_CHAR.test(after)) { return true; }
      from = index + term.length;
      index = lineLower.indexOf(term, from);
    }
  }
  return false;
}

const FENCE_BLOCK = /```[^\n]*\n([\s\S]*?)```/g;
const INLINE_CODE = /`([^`\n]+)`/g;
const QUOTED_SPAN = /"([^"\n]{6,})"|'([^'\n]{6,})'/g;

/**
 * Pull the verbatim code/text *lines* a prompt quotes so they can be matched
 * exactly against a file: fenced-code block lines, inline-backtick spans, and
 * quoted strings. Single bare identifiers are intentionally excluded (those
 * flow through {@link extractSalientTerms}); a literal here is a multi-token
 * fragment worth pinpointing to an exact line. Returned trimmed, de-duplicated,
 * and ordered longest-first so the most specific fragment wins a tie.
 */
export function extractPromptLiterals(rawPrompt: string): string[] {
  const out = new Set<string>();
  const add = (value: string): void => {
    const literal = value.trim();
    // Keep only fragments specific enough to pin a line: length >= 6 and either
    // multiple tokens or an operator/punctuation character (real code/text),
    // never a lone word that would match too loosely.
    if (literal.length < 6) { return; }
    const multiToken = /\s/.test(literal);
    const hasSymbol = /[=(){}\[\].;:<>+\-*/%&|!?]/.test(literal);
    if (!multiToken && !hasSymbol) { return; }
    out.add(literal);
  };

  for (const match of rawPrompt.matchAll(FENCE_BLOCK)) {
    for (const line of match[1].split(/\r?\n/)) { add(line); }
  }
  for (const match of rawPrompt.matchAll(INLINE_CODE)) { add(match[1]); }
  for (const match of rawPrompt.matchAll(QUOTED_SPAN)) { add(match[1] ?? match[2] ?? ''); }

  return [...out].sort((left, right) => right.length - left.length);
}

const WHITESPACE_RUN = /\s+/g;

/** Word/identifier tokens of a line, lowercased, for overlap scoring. */
function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9_$]+/g) ?? [];
}

/**
 * Jaccard token-overlap similarity in [0, 1]. Order-independent so reflowed or
 * lightly-edited code still scores high; used only as a gated last-resort
 * fallback and as the primary tiebreak between equally-strong candidates.
 */
function tokenSimilarity(a: string, b: string): number {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  if (ta.size === 0 || tb.size === 0) { return 0; }
  let intersection = 0;
  for (const token of ta) { if (tb.has(token)) { intersection++; } }
  return intersection / (ta.size + tb.size - intersection);
}

const REGEX_META = /[.*+?^${}()|[\]\\]/g;

/**
 * Build a whitespace-flexible, anchor-free regex from a literal so a quoted
 * fragment still matches a file line whose indentation or inner spacing drifted
 * (e.g. `if (x===5)` vs `if (x === 5)`). Regex metacharacters are escaped first,
 * then runs of whitespace are relaxed to `\s+`. Returns null on an un-compilable
 * pattern so callers degrade gracefully instead of throwing.
 */
function buildFlexibleRegex(literal: string): RegExp | null {
  const escaped = literal.trim().replace(REGEX_META, '\\$&').replace(/\s+/g, '\\s*');
  try {
    return new RegExp(escaped, 'i');
  } catch {
    return null;
  }
}

/** Minimum token-overlap for the fuzzy fallback tier to accept a line. */
const FUZZY_MIN_SIMILARITY = 0.7;

/**
 * Tiered exact-match strength of a literal against a single file line, from
 * strongest to a gated fuzzy fallback:
 *   5 exact · 4 whitespace-normalized · 3 containment · 2 regex-flexible ·
 *   1 fuzzy token-overlap (>= {@link FUZZY_MIN_SIMILARITY}). 0 = no match.
 */
function literalMatchTier(lineTrimmed: string, literal: string): number {
  if (lineTrimmed === literal) { return 5; }                                   // exact
  const lineWs = lineTrimmed.replace(WHITESPACE_RUN, ' ');
  const litWs = literal.replace(WHITESPACE_RUN, ' ');
  if (lineWs === litWs) { return 4; }                                          // whitespace-normalized
  if (literal.length >= 8 && lineWs.includes(litWs)) { return 3; }             // containment
  if (literal.length >= 8) {                                                   // regex-flexible
    const flexible = buildFlexibleRegex(literal);
    if (flexible && flexible.test(lineTrimmed)) { return 2; }
  }
  if (tokenSimilarity(lineTrimmed, literal) >= FUZZY_MIN_SIMILARITY) { return 1; } // fuzzy fallback
  return 0;
}

/**
 * Resolve each quoted prompt literal to the single most-likely file line,
 * disambiguating ties deterministically:
 *   1. strongest match tier (exact → … → fuzzy);
 *   2. highest token-overlap with the literal (most similar content wins —
 *      this is what finalizes "confusing" near-duplicate lines);
 *   3. nearest to a salient-symbol anchor line (tight clustering wins);
 *   4. nearest to lines already claimed by other literals (context cohesion);
 *   5. lowest line index (stable final tiebreak).
 * Lines whose only candidates are weak/ambiguous and cannot be narrowed are
 * dropped rather than guessed — callers stay exact and never hallucinate.
 */
export function resolveLiteralLineIndexes(
  lines: string[],
  literals: string[],
  anchorIndexes: number[],
): number[] {
  if (literals.length === 0) { return []; }
  const trimmed = lines.map((line) => line.trim());
  const resolved: number[] = [];
  const claimed = new Set<number>();

  const nearest = (index: number, others: number[]): number => {
    let best = Number.POSITIVE_INFINITY;
    for (const other of others) { best = Math.min(best, Math.abs(index - other)); }
    return best;
  };

  for (const literal of literals) {
    let bestTier = 0;
    const candidates: number[] = [];
    for (let index = 0; index < trimmed.length; index++) {
      const tier = literalMatchTier(trimmed[index], literal);
      if (tier === 0) { continue; }
      if (tier > bestTier) { bestTier = tier; candidates.length = 0; }
      if (tier === bestTier) { candidates.push(index); }
    }
    if (candidates.length === 0) { continue; }

    let winner = candidates[0];
    if (candidates.length > 1) {
      const cohesion = [...claimed, ...anchorIndexes];
      winner = candidates
        .map((index) => ({
          index,
          similarity: tokenSimilarity(trimmed[index], literal),
          anchor: nearest(index, anchorIndexes),
          cohere: nearest(index, cohesion),
        }))
        .sort((a, b) =>
          b.similarity - a.similarity
          || a.anchor - b.anchor
          || a.cohere - b.cohere
          || a.index - b.index)[0]
        .index;
    }
    if (!claimed.has(winner)) {
      claimed.add(winner);
      resolved.push(winner);
    }
  }
  return resolved.sort((left, right) => left - right);
}

/**
 * Locate a user's editor selection inside the file so the IDE can re-highlight
 * the exact lines it came from. Anchors on the first non-blank selection line
 * (via the tiered exact → fuzzy matcher), then matches each following line as a
 * bounded-gap subsequence so file lines the selection skipped (blank lines,
 * intervening statements) don't break alignment. The best-scoring placement
 * wins; returns the covering range, or `[]` when no placement clears a 60%
 * line-match confidence bar (so a drifted selection never highlights the wrong
 * block).
 */
export function locateSelectionRanges(lines: string[], selection: string): LineRange[] {
  const selectionLines = selection
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (selectionLines.length === 0 || lines.length === 0) { return []; }

  const trimmed = lines.map((line) => line.trim());
  const first = selectionLines[0];
  // Tolerate a few unrelated file lines between consecutive selection lines.
  const MAX_GAP = 3;

  let best: { start: number; end: number; score: number } | null = null;
  for (let start = 0; start < trimmed.length; start++) {
    if (literalMatchTier(trimmed[start], first) === 0) { continue; }

    let matched = 1;
    let cursor = start + 1;
    for (let s = 1; s < selectionLines.length; s++) {
      const limit = Math.min(trimmed.length, cursor + MAX_GAP + 1);
      let found = -1;
      for (let probe = cursor; probe < limit; probe++) {
        if (literalMatchTier(trimmed[probe], selectionLines[s]) > 0) { found = probe; break; }
      }
      if (found !== -1) {
        matched++;
        cursor = found + 1;
      }
    }
    const end = Math.min(Math.max(start, cursor - 1), trimmed.length - 1);
    if (!best || matched > best.score) { best = { start, end, score: matched }; }
  }

  if (best && best.score >= Math.ceil(selectionLines.length * 0.6)) {
    return [{ start: best.start, end: best.end }];
  }
  return [];
}

/**
 * Expand the matched line indexes by ±2 lines of context, cap at `maxLines`,
 * and emit both the rendered snippet (with `...` gap separators) and the
 * contiguous line ranges it covers.
 */
export function buildSnippetFromLineIndexes(
  lines: string[],
  indexes: number[],
  maxLines: number,
): FileSnippet {
  const includedIndexes = new Set<number>();
  for (const index of indexes) {
    for (let cursor = Math.max(0, index - 2); cursor <= Math.min(lines.length - 1, index + 2); cursor++) {
      includedIndexes.add(cursor);
    }
  }

  const sortedIndexes = Array.from(includedIndexes)
    .sort((left, right) => left - right)
    .slice(0, maxLines);

  const snippetLines: string[] = [];
  const ranges: LineRange[] = [];
  let previousIndex = -2;
  for (const index of sortedIndexes) {
    if (index === previousIndex + 1) {
      ranges[ranges.length - 1].end = index;
    } else {
      if (previousIndex >= 0) { snippetLines.push('...'); }
      ranges.push({ start: index, end: index });
    }
    snippetLines.push(lines[index]);
    previousIndex = index;
  }
  return { text: snippetLines.join('\n'), ranges };
}

export function formatFileSection(file: IdeContextFile, snippet: string): string {
  const language = file.language ?? detectLanguageFromPath(file.path);
  const fenceStart = language === '' ? '```' : `\`\`\`${language}`;
  return [`# ${file.path}`, fenceStart, snippet, '```'].join('\n');
}

export function formatLogSection(log: IdeContextLog, snippet: string): string {
  return [`# ${log.source}`, '```text', snippet, '```'].join('\n');
}

/**
 * Run the code-boilerplate stripper on snippets in a recognised programming
 * language. An over-eager strip that empties the snippet falls back to the
 * original text so a non-empty result is guaranteed.
 */
function stripCodeBoilerplate(snippet: string, language: string): string {
  if (snippet === '' || !isCodeLanguage(language)) { return snippet; }
  const stripped = preFilterCode(snippet, language);
  return stripped === '' ? snippet : stripped;
}

/**
 * Extract the prompt-relevant portion of a file along with the original line
 * ranges it came from. Ranges are empty when they cannot be determined (e.g. a
 * user text selection, which carries no line information).
 */
export function extractRelevantFileSnippet(
  file: IdeContextFile,
  queryTerms: Set<string>,
  salientTerms?: Set<string>,
  promptLiterals?: string[],
): FileSnippet {
  const language = file.language ?? detectLanguageFromPath(file.path);

  // 1. An explicit user selection is the most relevant, slimmest context.
  //    Locate it inside the file (exact → normalized → regex → fuzzy) so the
  //    IDE can re-highlight the exact lines; emit no range only when no
  //    confident placement exists rather than guessing.
  if ((file.selection ?? '').trim() !== '') {
    const selectionText = (file.selection as string).trim();
    const selectionRanges = file.content
      ? locateSelectionRanges(file.content.split(/\r?\n/), selectionText)
      : [];
    return { text: stripCodeBoilerplate(selectionText, language), ranges: selectionRanges };
  }

  const lines = file.content.split(/\r?\n/);

  // 2. Tiny files carry little noise — keep them whole.
  if (lines.length <= SMALL_FILE_LINES) {
    return {
      text: stripCodeBoilerplate(file.content.trim(), language),
      ranges: lines.length > 0 ? [{ start: 0, end: lines.length - 1 }] : [],
    };
  }

  // 3a. Prefer literal symbol hits when the prompt names a concrete symbol.
  //     Matching the whole identifier (word-boundary) keeps the snippet tight
  //     and on-topic instead of every line sharing a generic split fragment.
  const symbolLineIndexes: number[] = [];
  if (salientTerms && salientTerms.size > 0) {
    for (let index = 0; index < lines.length; index++) {
      if (lineMatchesLiteral(lines[index].toLowerCase(), salientTerms)) {
        symbolLineIndexes.push(index);
      }
    }
  }

  // 3a-exact. When the prompt quotes verbatim code/text, pin those exact lines
  //     via regex/string match and disambiguate ties against the symbol anchors
  //     above. This is the most precise signal, so it wins outright.
  if (promptLiterals && promptLiterals.length > 0) {
    const literalIndexes = resolveLiteralLineIndexes(lines, promptLiterals, symbolLineIndexes);
    if (literalIndexes.length > 0) {
      const region = buildSnippetFromLineIndexes(lines, literalIndexes, MAX_FILE_LINES);
      return { text: stripCodeBoilerplate(region.text.trim(), language), ranges: region.ranges };
    }
  }

  if (symbolLineIndexes.length > 0) {
    const region = buildSnippetFromLineIndexes(lines, symbolLineIndexes, MAX_FILE_LINES);
    return { text: stripCodeBoilerplate(region.text.trim(), language), ranges: region.ranges };
  }

  // 3b. Larger files: extract only the query-relevant region so the optimized
  //    prompt stays slim instead of embedding the full file text.
  const matchingLineIndexes: number[] = [];
  for (let index = 0; index < lines.length; index++) {
    if (lineMatchesQuery(lines[index].toLowerCase(), queryTerms)) {
      matchingLineIndexes.push(index);
    }
  }

  if (matchingLineIndexes.length > 0) {
    const region = buildSnippetFromLineIndexes(lines, matchingLineIndexes, MAX_FILE_LINES);
    return { text: stripCodeBoilerplate(region.text.trim(), language), ranges: region.ranges };
  }

  // 4. No relevant lines: only the active file is worth a short head excerpt;
  //    background files are dropped entirely to avoid noise.
  if (!file.is_active) {
    return { text: '', ranges: [] };
  }
  const headEnd = Math.min(SMALL_FILE_LINES, lines.length) - 1;
  return {
    text: stripCodeBoilerplate(lines.slice(0, SMALL_FILE_LINES).join('\n').trim(), language),
    ranges: headEnd >= 0 ? [{ start: 0, end: headEnd }] : [],
  };
}

export function extractRelevantLogSnippet(log: IdeContextLog, queryTerms: Set<string>): string {
  // Collect every relevant line *including duplicates* so Pipeline 3 can
  // report accurate `(Nx)` occurrence multipliers when it clusters them.
  const relevantLines: string[] = [];
  for (const line of log.content.split(/\r?\n/)) {
    const trimmedLine = line.trim();
    if (trimmedLine === '') { continue; }
    if (lineMatchesQuery(trimmedLine.toLowerCase(), queryTerms)
      || /error|exception|failed|warning|stack/i.test(trimmedLine)) {
      relevantLines.push(trimmedLine);
    }
  }

  if (relevantLines.length === 0) { return ''; }

  // Pipeline 3: deduplicate and frequency-cluster the noisy log stack.
  return compressLogStack(relevantLines.join('\n'), { maxClusters: MAX_LOG_LINES });
}
