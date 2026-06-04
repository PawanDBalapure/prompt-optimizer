import type { TextSegment } from './types.js';

const CODE_LIKE_KEYWORDS = /^(?:import|export|const|let|var|function|class|interface|type|enum|async|await|return|if|else|switch|case|for|while|try|catch)\b/;
const CODE_LIKE_SUFFIXES = /=>|[{}();]$/;
const CODE_LIKE_CALL = /^\s*[\w$.]+\(/;

function splitTextSegments(text: string): TextSegment[] {
  return text
    .split(/(```[\s\S]*?```)/g)
    .filter((segment) => segment !== '')
    .map((segment) => ({
      content: segment,
      is_code: segment.startsWith('```') && segment.endsWith('```'),
    }));
}

function isBlankCommentLine(line: string): boolean {
  return /^\/\/+$/.test(line)
    || /^#+$/.test(line)
    || /^\/\*+$/.test(line)
    || /^\*+$/.test(line)
    || /^\*\/+$/.test(line);
}

function isStandaloneImportLine(line: string): boolean {
  return /^(?:import\s+.*\s+from\s+['"].*['"];?|require\s*\(\s*['"].*['"]\s*\);?)$/i.test(line);
}

function looksLikeCodeLine(line: string): boolean {
  return CODE_LIKE_KEYWORDS.test(line) || CODE_LIKE_SUFFIXES.test(line) || CODE_LIKE_CALL.test(line);
}

/**
 * Ordered list of safe, meaning-preserving rewrites applied to natural-language
 * directive lines. Each entry is [pattern, replacement]. Order matters: longer
 * / more specific phrases come before their shorter overlaps so they win.
 *
 * Style rule for "drop" patterns that may swallow a trailing comma: place the
 * `,?` *outside* the closing word boundary (e.g. `\bBasically\b,?`).  Putting
 * `,?` inside two `\b` anchors causes the engine to backtrack out of the
 * comma (since `\b` doesn't match between two non-word chars), leaving stray
 * commas behind.  See unit case `P3-fluff` in scripts/qa-text-optimizer.mjs.
 */
const DIRECTIVE_REWRITES: ReadonlyArray<readonly [RegExp, string]> = [
  // Politeness / filler openers (drop entirely).
  [/\b(?:please|kindly)\b\s*,?/gi, ''],
  [/\b(?:can|could|would)\s+you\b\s*,?/gi, ''],
  [/\bI (?:need|want) you to\b\s*,?/gi, ''],
  [/\bI would like(?: you)? to\b\s*,?/gi, ''],
  [/\bI'd like(?: you)? to\b\s*,?/gi, ''],
  [/\bhow (?:do|can) I\b\s*,?/gi, ''],
  [/\bhelp me(?: to)?\b\s*,?/gi, ''],
  [/\bassist me(?: with| in)?\b\s*,?/gi, ''],
  [/\btell me(?: how to| about)?\b\s*,?/gi, ''],
  [/\bshow me how to\b\s*,?/gi, ''],
  [/\bgo ahead and\b\s*,?/gi, ''],
  [/\bfeel free to\b\s*,?/gi, ''],
  [/\blet(?:'s| us)\b\s*,?/gi, ''],
  [/\bYour (?:task|job) is to\b\s*,?/gi, ''],
  [/\bIt is important to(?: note that)?\b\s*,?/gi, ''],
  [/\bIt should be noted that\b\s*,?/gi, ''],
  [/\bAs a matter of fact\b,?/gi, ''],
  [/\bNeedless to say\b,?/gi, ''],
  [/\bPlease note that\b\s*,?/gi, ''],
  [/\bBasically\b,?/gi, ''],
  [/\bjust\b/gi, ''],

  // Verbose phrasings → concise verbs / prepositions (apply before single-word
  // swaps so multi-word patterns are not partially rewritten).
  [/\bwalk me through\b/gi, 'explain'],
  [/\bmake sure\b/gi, 'ensure'],
  // Relative-clause tightening: "the tests that are failing" → "failing tests",
  // "the file that is missing" → "missing file". Grammar-preserving reorder.
  [/\bthe (\w+) that are (\w+)\b/gi, '$2 $1'],
  [/\bthe (\w+) that is (\w+)\b/gi, '$2 $1'],
  // "a list of integers" → "integer list", "an array of strings" → "string array".
  [/\b(?:a |an )?(?:list|array|set|collection) of (\w+?)s\b/gi, '$1 list'],
  [/\bin order to\b/gi, 'to'],
  [/\bin order for\b/gi, 'for'],
  [/\bfor the purpose of\b/gi, 'for'],
  [/\bwith the aim of\b/gi, 'to'],
  [/\bwith regard to\b/gi, 'about'],
  [/\bwith respect to\b/gi, 'about'],
  [/\bin terms of\b/gi, 'for'],
  [/\bin the event that\b/gi, 'if'],
  [/\bin the case (?:that|of)\b/gi, 'if'],
  [/\bin (?:light|view) of the fact that\b/gi, 'because'],
  [/\bdue to the fact that\b/gi, 'because'],
  [/\bowing to the fact that\b/gi, 'because'],
  [/\bon the grounds that\b/gi, 'because'],
  [/\bin spite of the fact that\b/gi, 'although'],
  [/\bdespite the fact that\b/gi, 'although'],
  [/\bregardless of the fact that\b/gi, 'although'],
  [/\bdespite of\b/gi, 'despite'],
  [/\bduring the course of\b/gi, 'during'],
  [/\bin the process of\b/gi, ''],
  [/\bat (?:this|the) (?:point|moment) in time\b/gi, 'now'],
  [/\bat the present time\b/gi, 'now'],
  [/\bin the near future\b/gi, 'soon'],
  [/\bon a regular basis\b/gi, 'regularly'],
  [/\bin close proximity to\b/gi, 'near'],
  [/\bin the vicinity of\b/gi, 'near'],
  [/\ba (?:large|great) number of\b/gi, 'many'],
  [/\bthe (?:vast )?majority of\b/gi, 'most'],
  [/\ba number of\b/gi, 'several'],
  [/\bgive consideration to\b/gi, 'consider'],
  [/\btake into consideration\b/gi, 'consider'],
  [/\bmake (?:a )?(?:decision|determination)\b/gi, 'decide'],
  [/\bcome to (?:a|the) conclusion\b/gi, 'conclude'],
  [/\bcarry out\b/gi, 'do'],
  [/\bperform an analysis of\b/gi, 'analyze'],
  [/\bprovide (?:a |an )?(?:explanation|description) (?:of|for)\b/gi, 'explain'],
  [/\bprior to\b/gi, 'before'],
  [/\bsubsequent to\b/gi, 'after'],
  [/\bin addition to\b/gi, 'besides'],
  [/\bas well as\b/gi, 'and'],
  [/\bhas the ability to\b/gi, 'can'],
  [/\bis able to\b/gi, 'can'],
  [/\bare able to\b/gi, 'can'],
  [/\bin the absence of\b/gi, 'without'],
  [/\bsurrounding IDE context\b/gi, 'IDE context'],

  // Hedge adjectives add no instruction value in a directive: drop them
  // (with a leading article if present). "write a quick function" →
  // "write function"; "a simple REST API" → "REST API".
  [/\b(?:a |an )?(?:quick|simple|basic|trivial|small|short)\s+(?=\w)/gi, ''],

  // Single-word substitutions (kept last to avoid breaking phrase rewrites).
  [/\butili[sz]e(s|d)?\b/gi, 'use$1'],
  [/\bdemonstrate(s|d)?\b/gi, 'show$1'],
  [/\bapproximately\b/gi, 'about'],
  [/\bnumerous\b/gi, 'many'],
  [/\badditional\b/gi, 'more'],
  [/\bcommence(s|d)?\b/gi, 'start$1'],
  [/\bterminate(s|d)?\b/gi, 'end$1'],
  [/\bsufficient\b/gi, 'enough'],
  [/\bobtain\b/gi, 'get'],
  [/\bregarding\b/gi, 'about'],
  [/\bconcerning\b/gi, 'about'],
];

/**
 * Single combined alternation of every DIRECTIVE_REWRITES left-hand side.
 * A line that matches none of these phrases cannot be rewritten, so we can
 * skip the full ~120-pattern loop entirely after one O(n) scan. This is a
 * pure performance gate — it does not change output, since the rewrite loop
 * over a non-matching line is a no-op anyway. All source patterns are
 * `\b`-anchored word phrases with no `^`/`$` anchors, so unioning them with
 * `|` is a safe membership test.
 */
const DIRECTIVE_GATE = new RegExp(
  DIRECTIVE_REWRITES.map(([pattern]) => `(?:${pattern.source})`).join('|'),
  'i',
);

/**
 * Recapitalise the first alphabetical character after sentence-ending
 * punctuation (".", "!", "?").  Removed phrases mid-sentence frequently
 * leave a lowercase word stranded after a period, e.g.
 *   "Refactor X. add Y."  →  "Refactor X. Add Y."
 */
function recapitaliseSentences(text: string): string {
  return text.replace(/([.!?])\s+([a-z])/g, (_match, punct, ch) => `${punct} ${ch.toUpperCase()}`);
}

function compressDirectiveLine(line: string): string {
  let normalized = line;
  if (DIRECTIVE_GATE.test(line)) {
    for (const [pattern, replacement] of DIRECTIVE_REWRITES) {
      normalized = normalized.replace(pattern, replacement);
    }
  }

  normalized = normalized
    // Collapse whitespace.
    .replace(/\s+/g, ' ')
    // Pull stray spaces away from punctuation: "word ," → "word,".
    .replace(/\s+([,.;:!?])/g, '$1')
    // Collapse repeated punctuation introduced by phrase removal:
    // ",,"  →  ",", " . . " → ".", "!." → "!", etc.
    .replace(/([,.;:!?])(?:\s*[,.;:!?])+/g, '$1')
    .trim()
    // Strip leftover leading punctuation / dashes left by an opener removal.
    .replace(/^[,:;\-\s]+/, '')
    .trim();

  if (normalized === '') { return ''; }
  normalized = recapitaliseSentences(normalized);
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function optimizePlainTextSegment(text: string): string {
  const lines = text.split(/\r?\n/);
  const optimizedLines: string[] = [];
  const seenLines = new Set<string>();

  for (const rawLine of lines) {
    const trimmedLine = rawLine.trim();

    if (trimmedLine === '') {
      if (optimizedLines.length > 0 && optimizedLines[optimizedLines.length - 1] !== '') {
        optimizedLines.push('');
      }
      continue;
    }

    if (isBlankCommentLine(trimmedLine) || isStandaloneImportLine(trimmedLine)) {
      continue;
    }

    if (looksLikeCodeLine(trimmedLine)) {
      optimizedLines.push(rawLine);
      continue;
    }

    const compressedLine = compressDirectiveLine(trimmedLine);
    if (compressedLine === '') { continue; }

    const normalizedLine = compressedLine.toLowerCase().replace(/\s+/g, ' ').trim();
    if (seenLines.has(normalizedLine)) { continue; }
    seenLines.add(normalizedLine);
    optimizedLines.push(compressedLine);
  }

  return optimizedLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function optimizePromptText(prompt: string): string {
  const segments = splitTextSegments(prompt);
  const optimizedSegments: string[] = [];
  const seenCodeBlocks = new Set<string>();

  for (const segment of segments) {
    if (segment.is_code) {
      const normalizedCode = segment.content.trim();
      if (seenCodeBlocks.has(normalizedCode)) { continue; }
      seenCodeBlocks.add(normalizedCode);
      optimizedSegments.push(normalizedCode);
      continue;
    }

    const optimizedText = optimizePlainTextSegment(segment.content);
    if (optimizedText !== '') {
      optimizedSegments.push(optimizedText);
    }
  }

  return optimizedSegments.join('\n\n').trim();
}

/** Exported for unit-level testing of the line classifier. */
export const __testables = {
  isBlankCommentLine,
  isStandaloneImportLine,
  looksLikeCodeLine,
  compressDirectiveLine,
};
