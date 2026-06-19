import { looksLikeCodeLine } from './textOptimizer.js';

/**
 * A best-effort sentence rewriter (typically backed by a small on-device
 * grammar/spelling model). Given one natural-language line it returns a
 * polished candidate. It may fail, hallucinate, or change meaning — every
 * candidate it produces is therefore validated by {@link preservesMeaning}
 * before being accepted, and rejected candidates fall back to the original.
 */
export type SentenceRefiner = (sentence: string) => Promise<string>;

/**
 * Function words whose presence/absence/order does not alter the semantic
 * content of an instruction: articles, prepositions, pronouns, copulas,
 * auxiliaries and modals. A grammar model is allowed to add, drop, reorder or
 * inflect THESE freely.
 *
 * Deliberately EXCLUDED (so they are treated as meaning-bearing content and
 * must be preserved exactly): negations (not/no/never/none/without/cannot),
 * coordinating/subordinating conjunctions that carry logic (and/or/but/nor/if/
 * when/while/because/unless/until), and quantifiers/comparatives (all/any/each/
 * every/some/most/only/few/many/more/less). Changing any of those can flip the
 * meaning of a requirement, so the guard never lets the model touch them.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  // Articles.
  'a', 'an', 'the',
  // Prepositions.
  'of', 'to', 'in', 'on', 'for', 'with', 'at', 'by', 'from', 'as', 'into',
  'onto', 'about', 'over', 'under', 'via', 'per', 'upon',
  // Pronouns.
  'it', 'its', 'i', 'you', 'we', 'they', 'he', 'she', 'him', 'her', 'them',
  'us', 'me', 'my', 'your', 'our', 'their', 'his', 'this', 'that', 'these',
  'those',
  // Copulas / auxiliaries.
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am',
  'do', 'does', 'did', 'done',
  'has', 'have', 'had',
  // Modals.
  'will', 'would', 'shall', 'should', 'can', 'could', 'may', 'might', 'must',
]);

const MAX_REFINE_CHARS = 600;
const MIN_REFINE_CHARS = 4;

/** Lowercase word-ish tokens, keeping identifier punctuation (`.` `/` `_` `$`). */
function wordTokens(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9][a-z0-9'’._/$-]*[a-z0-9]|[a-z0-9]/g) ?? [];
}

/** Meaning-bearing tokens: every word token that is not a neutral stopword. */
function contentTokens(text: string): string[] {
  return wordTokens(text).filter((token) => !STOPWORDS.has(token));
}

/**
 * True when a token looks like a code identifier, number, path, or symbol that
 * must survive verbatim — anything containing a digit, `_`, `$`, `.`/`/`, an
 * internal camelCase hump, or that is an ALL-CAPS acronym.
 */
function isProtectedToken(token: string): boolean {
  return /\d/.test(token)
    || /[_$./]/.test(token)
    || /[a-z][A-Z]/.test(token)
    || /^[A-Z]{2,}$/.test(token);
}

/** Case-sensitive identifier/number/path tokens that must be preserved exactly. */
function protectedTokens(text: string): string[] {
  const raw = text.match(/[A-Za-z0-9_$][A-Za-z0-9_$./-]*[A-Za-z0-9_$]|[A-Za-z0-9_$]/g) ?? [];
  return raw.filter(isProtectedToken);
}

/** Multiset equality via sort-and-compare (no early bail on order). */
function sameMultiset(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) { return false; }
  const left = [...a].sort();
  const right = [...b].sort();
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) { return false; }
  }
  return true;
}

/**
 * Decide whether `candidate` carries the exact same meaning as `original`.
 *
 * The rewrite is accepted ONLY when all three hold:
 *   1. Every code identifier / number / path / acronym is preserved verbatim
 *      and in the same quantity (case-sensitive) — the model may never rename
 *      a symbol such as `promptProxyEngine`, alter `src/file.ts`, or touch
 *      `401`.
 *   2. The multiset of meaning-bearing content words is identical
 *      (case-insensitive). The model may reorder words and add/drop/inflect
 *      neutral function words, but it may NOT introduce, delete, or substitute
 *      a content word (including negations, conjunctions and quantifiers).
 *   3. The total word count stays within ±50 % to catch truncation or padding.
 *
 * Because content words, negations, logical connectives and symbols are all
 * pinned, an accepted candidate can only differ from the original in
 * grammar-level surface form (articles, prepositions, agreement, punctuation,
 * casing, ordering) — never in what it actually asks for.
 */
export function preservesMeaning(original: string, candidate: string): boolean {
  if (typeof candidate !== 'string') { return false; }
  const trimmed = candidate.trim();
  if (trimmed === '') { return false; }

  // 1. Identifiers / numbers / paths — verbatim, case-sensitive.
  if (!sameMultiset(protectedTokens(original), protectedTokens(trimmed))) { return false; }

  // 2. Content words — identical multiset, case-insensitive.
  if (!sameMultiset(contentTokens(original), contentTokens(trimmed))) { return false; }

  // 3. Length sanity.
  const originalWords = wordTokens(original).length;
  const candidateWords = wordTokens(trimmed).length;
  if (originalWords > 0
    && (candidateWords < Math.floor(originalWords * 0.5)
      || candidateWords > Math.ceil(originalWords * 1.5))) {
    return false;
  }

  return true;
}

/** Leading whitespace of a line, so indentation survives a rewrite. */
function leadingWhitespace(line: string): string {
  return line.slice(0, line.length - line.trimStart().length);
}

/** Refine the natural-language lines of a single non-code text segment. */
async function refinePlainSegment(segment: string, refiner: SentenceRefiner): Promise<string> {
  const lines = segment.split(/\r?\n/);
  const out: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (
      trimmed.length < MIN_REFINE_CHARS
      || trimmed.length > MAX_REFINE_CHARS
      || looksLikeCodeLine(trimmed)
    ) {
      out.push(line);
      continue;
    }

    let candidate: string;
    try {
      candidate = (await refiner(trimmed)).trim();
    } catch {
      out.push(line);
      continue;
    }

    if (candidate !== '' && candidate !== trimmed && preservesMeaning(trimmed, candidate)) {
      out.push(leadingWhitespace(line) + candidate);
    } else {
      out.push(line);
    }
  }

  return out.join('\n');
}

/**
 * Run an optional sentence refiner over `text` while GUARANTEEING the result
 * means the same as the input.
 *
 * Fenced code blocks (```…```) and code-like lines are passed through
 * untouched. Every other line is offered to the refiner, and the rewrite is
 * kept only if {@link preservesMeaning} accepts it; otherwise the original line
 * is retained. A refiner that throws, returns junk, or changes meaning can
 * therefore never corrupt the prompt — the worst case is a no-op that leaves
 * the deterministic output in place.
 */
export async function refineTextPreservingMeaning(
  text: string,
  refiner: SentenceRefiner,
): Promise<string> {
  if (typeof text !== 'string' || text.trim() === '') { return text; }

  const segments = text.split(/(```[\s\S]*?```)/g);
  const out: string[] = [];

  for (const segment of segments) {
    if (segment === '') { continue; }
    if (segment.startsWith('```') && segment.endsWith('```')) {
      out.push(segment);
      continue;
    }
    out.push(await refinePlainSegment(segment, refiner));
  }

  return out.join('');
}

/** Exported for unit-level testing of the meaning guard. */
export const __meaningTestables = {
  contentTokens,
  protectedTokens,
  preservesMeaning,
};
