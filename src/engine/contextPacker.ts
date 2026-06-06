import type {
  IdeContextFile,
  IdeContextLog,
  PromptIDEContext,
  PromptOptimizationAnalysis,
} from '../contracts.js';
import { LocalSemanticVectorizer } from '../localSemanticVectorizer.js';
import {
  MAX_CONTEXT_FILES,
  MAX_CONTEXT_LOGS,
  MAX_FILE_LINES,
  MAX_LOG_LINES,
  SMALL_FILE_LINES,
} from './constants.js';
import { compressLogStack, isCodeLanguage, preFilterCode } from './contentPipelines.js';
import type { RelevantContextPack } from './types.js';

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

function detectLanguageFromPath(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase();
  return (ext && LANGUAGE_BY_EXT[ext]) ?? '';
}

function lineMatchesQuery(line: string, queryTerms: Set<string>): boolean {
  for (const term of queryTerms) {
    if (term !== '' && line.includes(term.toLowerCase())) { return true; }
  }
  return false;
}

function buildSnippetFromLineIndexes(
  lines: string[],
  indexes: number[],
  maxLines: number,
): string {
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
  let previousIndex = -2;
  for (const index of sortedIndexes) {
    if (previousIndex >= 0 && index > previousIndex + 1) {
      snippetLines.push('...');
    }
    snippetLines.push(lines[index]);
    previousIndex = index;
  }
  return snippetLines.join('\n');
}

function formatFileSection(file: IdeContextFile, snippet: string): string {
  const language = file.language ?? detectLanguageFromPath(file.path);
  const fenceStart = language === '' ? '```' : `\`\`\`${language}`;
  return [`# ${file.path}`, fenceStart, snippet, '```'].join('\n');
}

function formatLogSection(log: IdeContextLog, snippet: string): string {
  return [`# ${log.source}`, '```text', snippet, '```'].join('\n');
}

export class ContextPacker {
  private readonly vectorizer = new LocalSemanticVectorizer();

  buildQueryTerms(rawPrompt: string): Set<string> {
    const features = this.vectorizer.analyze(rawPrompt);
    return new Set(features.tokens);
  }

  countDistinctFiles(ideContext?: PromptIDEContext): number {
    const paths = new Set<string>();
    if (ideContext?.active_file?.path) { paths.add(ideContext.active_file.path); }
    for (const file of ideContext?.open_files ?? []) { paths.add(file.path); }
    return paths.size;
  }

  scoreTextRelevance(text: string, queryTerms: Set<string>): number {
    if (queryTerms.size === 0) { return 0; }
    const features = this.vectorizer.analyze(text);
    const candidateTerms = new Set(features.tokens);
    let matches = 0;
    for (const term of queryTerms) {
      if (candidateTerms.has(term)) { matches++; }
    }
    return matches / queryTerms.size;
  }

  selectRelevantFiles(ideContext: PromptIDEContext, queryTerms: Set<string>): IdeContextFile[] {
    const candidates = new Map<string, IdeContextFile>();
    if (ideContext.active_file) {
      candidates.set(ideContext.active_file.path, { ...ideContext.active_file, is_active: true });
    }
    for (const file of ideContext.open_files ?? []) {
      if (!candidates.has(file.path)) { candidates.set(file.path, file); }
    }

    return Array.from(candidates.values())
      .map((file) => ({
        file,
        score: this.scoreTextRelevance(`${file.path}\n${file.selection ?? ''}\n${file.content}`, queryTerms),
      }))
      .filter(({ file, score }) => Boolean(file.is_active) || score >= 0.08)
      .sort((l, r) => Number(Boolean(r.file.is_active)) - Number(Boolean(l.file.is_active)) || r.score - l.score)
      .slice(0, MAX_CONTEXT_FILES)
      .map((entry) => entry.file);
  }

  selectRelevantLogs(logs: IdeContextLog[], queryTerms: Set<string>): IdeContextLog[] {
    return logs
      .map((log) => ({ log, score: this.scoreTextRelevance(log.content, queryTerms) }))
      .filter(({ log, score }) =>
        log.kind !== 'problems'
        && (score >= 0.05 || /error|exception|failed|warning|stack/i.test(log.content)))
      .sort((l, r) => r.score - l.score)
      .slice(0, MAX_CONTEXT_LOGS)
      .map((entry) => entry.log);
  }

  extractRelevantFileSnippet(file: IdeContextFile, queryTerms: Set<string>): string {
    const language = file.language ?? detectLanguageFromPath(file.path);

    // 1. An explicit user selection is the most relevant, slimmest context.
    if ((file.selection ?? '').trim() !== '') {
      return this.stripCodeBoilerplate((file.selection as string).trim(), language);
    }

    const lines = file.content.split(/\r?\n/);

    // 2. Tiny files carry little noise — keep them whole.
    if (lines.length <= SMALL_FILE_LINES) {
      return this.stripCodeBoilerplate(file.content.trim(), language);
    }

    // 3. Larger files: extract only the query-relevant region so the optimized
    //    prompt stays slim instead of embedding the full file text.
    const matchingLineIndexes: number[] = [];
    for (let index = 0; index < lines.length; index++) {
      if (lineMatchesQuery(lines[index].toLowerCase(), queryTerms)) {
        matchingLineIndexes.push(index);
      }
    }

    if (matchingLineIndexes.length > 0) {
      const region = buildSnippetFromLineIndexes(lines, matchingLineIndexes, MAX_FILE_LINES).trim();
      return this.stripCodeBoilerplate(region, language);
    }

    // 4. No relevant lines: only the active file is worth a short head excerpt;
    //    background files are dropped entirely to avoid noise.
    return file.is_active
      ? this.stripCodeBoilerplate(lines.slice(0, SMALL_FILE_LINES).join('\n').trim(), language)
      : '';
  }

  /**
   * Pipeline 1 entry point: run the code-boilerplate stripper on snippets whose
   * language is a recognised programming language. The `...` snippet separators
   * inserted by {@link buildSnippetFromLineIndexes} are preserved so the model
   * still sees where regions were elided. Non-empty results are guaranteed; an
   * over-eager strip that empties the snippet falls back to the original text.
   */
  private stripCodeBoilerplate(snippet: string, language: string): string {
    if (snippet === '' || !isCodeLanguage(language)) { return snippet; }
    const stripped = preFilterCode(snippet, language);
    return stripped === '' ? snippet : stripped;
  }

  extractRelevantLogSnippet(log: IdeContextLog, queryTerms: Set<string>): string {
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

  collectRelevantContext(rawPrompt: string, ideContext?: PromptIDEContext): RelevantContextPack {
    const emptyInsight: PromptOptimizationAnalysis['context'] = {
      workspace_root: ideContext?.workspace_root,
      active_file: ideContext?.active_file?.path,
      selected_files: [],
      selected_logs: [],
      log_sources: (ideContext?.logs ?? []).map((log) => log.source),
      open_file_count: this.countDistinctFiles(ideContext),
      total_log_count: ideContext?.logs?.length ?? 0,
    };

    if (!ideContext) {
      return { files: [], logs: [], sections: [], insight: emptyInsight };
    }

    const queryTerms = this.buildQueryTerms(rawPrompt);
    const sections: string[] = [];
    const seenSections = new Set<string>();
    const selectedFiles: IdeContextFile[] = [];
    const selectedLogs: IdeContextLog[] = [];

    for (const file of this.selectRelevantFiles(ideContext, queryTerms)) {
      const snippet = this.extractRelevantFileSnippet(file, queryTerms);
      if (snippet === '') { continue; }
      const section = formatFileSection(file, snippet);
      if (!seenSections.has(section)) {
        seenSections.add(section);
        selectedFiles.push(file);
        sections.push(section);
      }
    }

    for (const log of this.selectRelevantLogs(ideContext.logs ?? [], queryTerms)) {
      const snippet = this.extractRelevantLogSnippet(log, queryTerms);
      if (snippet === '') { continue; }
      const section = formatLogSection(log, snippet);
      if (!seenSections.has(section)) {
        seenSections.add(section);
        selectedLogs.push(log);
        sections.push(section);
      }
    }

    return {
      files: selectedFiles,
      logs: selectedLogs,
      sections,
      insight: {
        workspace_root: ideContext.workspace_root,
        active_file: ideContext.active_file?.path,
        selected_files: selectedFiles.map((file) => file.path),
        selected_logs: selectedLogs.map((log) => log.source),
        log_sources: (ideContext.logs ?? []).map((log) => log.source),
        open_file_count: this.countDistinctFiles(ideContext),
        total_log_count: ideContext.logs?.length ?? 0,
      },
    };
  }
}
