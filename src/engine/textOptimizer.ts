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
 */
const DIRECTIVE_REWRITES: ReadonlyArray<readonly [RegExp, string]> = [
  // Politeness / filler openers (drop entirely).
  [/\b(?:please|kindly)\b/gi, ''],
  [/\b(?:can|could|would)\s+you\b/gi, ''],
  [/\bI (?:need|want) you to\b/gi, ''],
  [/\bI would like(?: you)? to\b/gi, ''],
  [/\bI'd like(?: you)? to\b/gi, ''],
  [/\bhow (?:do|can) I\b/gi, ''],
  [/\bhelp me(?: to)?\b/gi, ''],
  [/\bassist me(?: with| in)?\b/gi, ''],
  [/\btell me(?: how to| about)?\b/gi, ''],
  [/\bgo ahead and\b/gi, ''],
  [/\bfeel free to\b/gi, ''],
  [/\blet(?:'s| us)\b/gi, ''],
  [/\bYour (?:task|job) is to\b/gi, ''],
  [/\bIt is important to\b/gi, ''],
  [/\bIt should be noted that\b/gi, ''],
  [/\bAs a matter of fact,?\b/gi, ''],
  [/\bNeedless to say,?\b/gi, ''],
  [/\bPlease note that\b/gi, ''],
  [/\bBasically,?\b/gi, ''],
  [/\bjust\b/gi, ''],

  // Verbose phrasings → concise verbs / prepositions (apply before single-word
  // swaps so multi-word patterns are not partially rewritten).
  [/\bwalk me through\b/gi, 'explain'],
  [/\bshow me how to\b/gi, 'describe'],
  [/\bmake sure\b/gi, 'ensure'],
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

function compressDirectiveLine(line: string): string {
  let normalized = line;
  for (const [pattern, replacement] of DIRECTIVE_REWRITES) {
    normalized = normalized.replace(pattern, replacement);
  }

  normalized = normalized
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim()
    .replace(/^[,:;\-\s]+/, '')
    .trim();

  if (normalized === '') { return ''; }
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
