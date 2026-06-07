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
): FileSnippet {
  const language = file.language ?? detectLanguageFromPath(file.path);

  // 1. An explicit user selection is the most relevant, slimmest context.
  if ((file.selection ?? '').trim() !== '') {
    return { text: stripCodeBoilerplate((file.selection as string).trim(), language), ranges: [] };
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
  if (salientTerms && salientTerms.size > 0) {
    const symbolLineIndexes: number[] = [];
    for (let index = 0; index < lines.length; index++) {
      if (lineMatchesLiteral(lines[index].toLowerCase(), salientTerms)) {
        symbolLineIndexes.push(index);
      }
    }
    if (symbolLineIndexes.length > 0) {
      const region = buildSnippetFromLineIndexes(lines, symbolLineIndexes, MAX_FILE_LINES);
      return { text: stripCodeBoilerplate(region.text.trim(), language), ranges: region.ranges };
    }
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
