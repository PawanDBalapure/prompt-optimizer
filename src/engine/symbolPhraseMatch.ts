/**
 * Resolve natural-language phrases in a prompt to the code symbols / filenames
 * they actually refer to.
 *
 * The literal-symbol extractor in {@link ./contextPacker.helpers} only keeps
 * verbatim camelCase / snake_case tokens, so a prompt that *names a file in
 * plain English* — "is there a prompt ir helper" → `PromptIRHelper.ts` — slips
 * through with zero deterministic evidence. This module closes that gap with
 * three tolerant-but-bounded strategies:
 *
 *   1. **Subword decomposition** — `PromptIRHelper` → `['prompt','ir','helper']`
 *      (splits camelCase, ACRONYM↔Word, snake/kebab, and letter↔digit seams).
 *   2. **Concatenated n-gram match** — a run of consecutive prompt content-words
 *      whose join equals the identifier (`prompt`+`ir`+`helper` === stem).
 *   3. **Fuzzy subword coverage** — bounded Levenshtein per subword so typos
 *      like "hepler" still resolve, without devolving into a loose substring
 *      match that lights up unrelated files.
 *
 * Everything here is pure and deterministic so it can feed the existing
 * deterministic file-routing path in {@link ./contextPacker}.
 */

import { STOP_WORDS } from '../vector/lexicon.js';
import { correctWord } from './typoDictionary.js';

/**
 * Split an identifier into its lowercase subword tokens. Handles camelCase
 * (`promptHelper`), acronym boundaries (`IRHelper` → `ir helper`), snake/kebab/
 * path separators, and letter↔digit seams (`utf8Decode` → `utf 8 decode`).
 */
export function decomposeIdentifier(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')      // camelCase seam: promptIR -> prompt IR
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')    // acronym↔Word: IRHelper -> IR Helper
    .replace(/([a-zA-Z])([0-9])/g, '$1 $2')       // letter↔digit: utf8 -> utf 8
    .replace(/([0-9])([a-zA-Z])/g, '$1 $2')       // digit↔letter: 8decode -> 8 decode
    .replace(/[_\-./\\]+/g, ' ')                   // separators
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

/**
 * Ordered, stop-word-stripped, typo-normalised content words of a prompt. These
 * are the candidate words that may, in sequence, name a symbol or file.
 */
export function extractPromptPhraseWords(rawPrompt: string): string[] {
  const words: string[] = [];
  for (const match of rawPrompt.toLowerCase().matchAll(/[a-z0-9]+/g)) {
    // Normalise known typos via the vendored crate-ci/typos dictionary before
    // dropping stop-words, so misspellings like "wht" / "hepler" still resolve.
    const corrected = correctWord(match[0]);
    if (STOP_WORDS.has(corrected)) { continue; }
    words.push(corrected);
  }
  return words;
}

/** Classic Levenshtein edit distance with a small early-exit cap. */
function levenshtein(a: string, b: string): number {
  if (a === b) { return 0; }
  const rows = a.length + 1;
  const cols = b.length + 1;
  let prev = new Array<number>(cols);
  let curr = new Array<number>(cols);
  for (let j = 0; j < cols; j++) { prev[j] = j; }
  for (let i = 1; i < rows; i++) {
    curr[0] = i;
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[cols - 1];
}

/**
 * Length-aware fuzzy equality: exact match always wins; otherwise allow a small
 * edit distance scaled to word length. Short words (< 4 chars) must match
 * exactly — a single edit there is too likely to be a different word.
 */
function fuzzyEqual(a: string, b: string): boolean {
  if (a === b) { return true; }
  const maxLen = Math.max(a.length, b.length);
  if (maxLen < 4) { return false; }
  if (Math.abs(a.length - b.length) > 2) { return false; }
  const tolerance = maxLen >= 8 ? 2 : 1;
  return levenshtein(a, b) <= tolerance;
}

/**
 * Score how strongly an identifier `stem` (a filename basename or symbol name,
 * extension already stripped) is named by the prompt's content `words`.
 *
 * Returns a deterministic-routing-grade score in [0, 100]:
 *   - 95: a consecutive run of prompt words concatenates exactly to the stem.
 *   - 92: every meaningful subword of the stem is covered (fuzzily) by a word.
 *   - 75: a 2+-subword stem is mostly (≥ 2/3) covered.
 *   -  0: not enough evidence.
 */
export function scoreFilenamePhraseMatch(stem: string, words: string[]): number {
  if (stem === '' || words.length === 0) { return 0; }
  const subwords = decomposeIdentifier(stem);
  if (subwords.length === 0) { return 0; }

  // Strategy 2: a contiguous window of prompt words whose join equals the stem.
  const joined = subwords.join('');
  if (joined.length >= 4) {
    for (let i = 0; i < words.length; i++) {
      let accumulated = '';
      for (let j = i; j < words.length && accumulated.length < joined.length; j++) {
        accumulated += words[j];
        if (accumulated === joined) { return 95; }
      }
    }
  }

  // Strategy 3: fuzzy per-subword coverage. Only meaningful subwords count.
  const meaningful = subwords.filter((part) => part.length >= 2);
  const denominator = meaningful.length || subwords.length;
  if (denominator < 2) { return 0; }
  let matched = 0;
  for (const part of meaningful) {
    if (words.some((word) => fuzzyEqual(word, part))) { matched++; }
  }
  const coverage = matched / denominator;
  if (coverage >= 0.999) { return 92; }
  if (coverage >= 2 / 3) { return 75; }
  return 0;
}
