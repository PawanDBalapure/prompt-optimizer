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

function compressDirectiveLine(line: string): string {
  let normalized = line
    .replace(/\b(?:please|kindly)\b/gi, '')
    .replace(/\b(?:can|could|would)\s+you\b/gi, '')
    .replace(/\bI (?:need|want) you to\b/gi, '')
    .replace(/\bI would like(?: you)? to\b/gi, '')
    .replace(/\bI'd like(?: you)? to\b/gi, '')
    .replace(/\bhow (?:do|can) I\b/gi, '')
    .replace(/\bhelp me(?: to)?\b/gi, '')
    .replace(/\bassist me(?: with| in)?\b/gi, '')
    .replace(/\btell me(?: how to| about)?\b/gi, '')
    .replace(/\bwalk me through\b/gi, 'explain')
    .replace(/\bgo ahead and\b/gi, '')
    .replace(/\bfeel free to\b/gi, '')
    .replace(/\blet(?:'s| us)\b/gi, '')
    .replace(/\bjust\b/gi, '')
    .replace(/\bYour (?:task|job) is to\b/gi, '')
    .replace(/\bIt is important to\b/gi, '')
    .replace(/\bmake sure\b/gi, 'ensure')
    .replace(/\bshow me how to\b/gi, 'describe')
    .replace(/\bsurrounding IDE context\b/gi, 'IDE context')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim();

  normalized = normalized.replace(/^[,:;\-\s]+/, '').trim();
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
