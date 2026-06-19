/**
 * Lazy, deterministic single-word typo corrector backed by the vendored
 * **crate-ci/typos** dictionary (`./data/typos-words.csv`, ~95k entries).
 *
 * `typos` keeps a curated *known-typo → correction* list rather than guessing
 * via edit distance, which keeps false positives near-zero. That makes it an
 * ideal high-confidence normalisation pass *before* the fuzzy phrase→filename
 * matcher in {@link ./symbolPhraseMatch}: known typos are fixed exactly, and
 * anything the dictionary doesn't know is left for the matcher's bounded
 * Levenshtein step to handle.
 *
 * The dictionary is parsed once on first use and cached. If the asset is
 * missing (e.g. a partial package), correction degrades gracefully to the
 * built-in {@link SEED_CORRECTIONS} only — it never throws.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Curated overrides applied with priority over the vendored dictionary. Covers
 * domain words we always want corrected (and guards against the dictionary ever
 * dropping them). Keys and values are lowercase.
 */
const SEED_CORRECTIONS = new Map<string, string>([
  ['wht', 'what'],
  ['waht', 'what'],
  ['hepler', 'helper'],
  ['helepr', 'helper'],
  ['hlper', 'helper'],
  ['mecahnism', 'mechanism'],
  ['mechansim', 'mechanism'],
  ['cofig', 'config'],
  ['confog', 'config'],
  ['promtp', 'prompt'],
  ['propmt', 'prompt'],
]);

const DICTIONARY_URL = new URL('./data/typos-words.csv', import.meta.url);

let merged: Map<string, string> | null = null;

/**
 * Parse the vendored CSV into a `typo → correction` map. Only *unambiguous*
 * entries (exactly one correction) are kept — typos itself refuses to
 * auto-apply multi-correction rows, and so do we.
 */
function parseDictionary(csv: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const rawLine of csv.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '') { continue; }
    const fields = line.split(',');
    if (fields.length !== 2) { continue; }       // skip ambiguous / malformed rows
    const typo = fields[0].trim().toLowerCase();
    const correction = fields[1].trim().toLowerCase();
    if (typo === '' || correction === '' || typo === correction) { continue; }
    out.set(typo, correction);
  }
  return out;
}

/** Build (once) the merged correction map: vendored dictionary + seed overrides. */
function getCorrectionMap(): Map<string, string> {
  if (merged) { return merged; }
  let map: Map<string, string>;
  try {
    map = parseDictionary(readFileSync(fileURLToPath(DICTIONARY_URL), 'utf8'));
  } catch {
    map = new Map<string, string>();   // asset unavailable — seed-only fallback
  }
  for (const [typo, correction] of SEED_CORRECTIONS) { map.set(typo, correction); }
  merged = map;
  return merged;
}

/**
 * Return the dictionary correction for a single lowercase word, or the word
 * unchanged when it is not a known typo. Cheap after the first call (cached).
 */
export function correctWord(word: string): string {
  if (word === '') { return word; }
  return getCorrectionMap().get(word) ?? word;
}

/** Number of known corrections currently loaded (for diagnostics/tests). */
export function correctionCount(): number {
  return getCorrectionMap().size;
}
