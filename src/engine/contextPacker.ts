import type {
  IdeContextFile,
  IdeContextLog,
  PromptIDEContext,
  PromptOptimizationAnalysis,
} from '../contracts.js';
import { LocalSemanticVectorizer } from '../localSemanticVectorizer.js';
import { MAX_CONTEXT_FILES, MAX_CONTEXT_LOGS } from './constants.js';
import {
  extractRelevantFileSnippet,
  extractRelevantLogSnippet,
  extractSalientTerms,
  formatFileSection,
  formatLogSection,
} from './contextPacker.helpers.js';
import type { RelevantContextPack } from './types.js';

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

  private buildInsight(
    ideContext: PromptIDEContext | undefined,
    selectedFiles: IdeContextFile[],
    selectedLogs: IdeContextLog[],
    snippets: PromptOptimizationAnalysis['context']['context_snippets'],
  ): PromptOptimizationAnalysis['context'] {
    return {
      workspace_root: ideContext?.workspace_root,
      active_file: ideContext?.active_file?.path,
      selected_files: selectedFiles.map((file) => file.path),
      selected_logs: selectedLogs.map((log) => log.source),
      log_sources: (ideContext?.logs ?? []).map((log) => log.source),
      open_file_count: this.countDistinctFiles(ideContext),
      total_log_count: ideContext?.logs?.length ?? 0,
      context_snippets: snippets,
    };
  }

  collectRelevantContext(rawPrompt: string, ideContext?: PromptIDEContext): RelevantContextPack {
    if (!ideContext) {
      return { files: [], logs: [], sections: [], insight: this.buildInsight(undefined, [], [], undefined) };
    }

    const queryTerms = this.buildQueryTerms(rawPrompt);
    const salientTerms = extractSalientTerms(rawPrompt);
    const sections: string[] = [];
    const seenSections = new Set<string>();
    const selectedFiles: IdeContextFile[] = [];
    const selectedLogs: IdeContextLog[] = [];
    const contextSnippets: NonNullable<PromptOptimizationAnalysis['context']['context_snippets']> = [];

    for (const file of this.selectRelevantFiles(ideContext, queryTerms)) {
      const snippet = extractRelevantFileSnippet(file, queryTerms, salientTerms);
      if (snippet.text === '') { continue; }
      const section = formatFileSection(file, snippet.text);
      if (seenSections.has(section)) { continue; }
      seenSections.add(section);
      selectedFiles.push(file);
      sections.push(section);
      contextSnippets.push({
        path: file.path,
        ranges: snippet.ranges.map((r) => ({ start_line: r.start, end_line: r.end })),
      });
    }

    for (const log of this.selectRelevantLogs(ideContext.logs ?? [], queryTerms)) {
      const snippet = extractRelevantLogSnippet(log, queryTerms);
      if (snippet === '') { continue; }
      const section = formatLogSection(log, snippet);
      if (seenSections.has(section)) { continue; }
      seenSections.add(section);
      selectedLogs.push(log);
      sections.push(section);
    }

    return {
      files: selectedFiles,
      logs: selectedLogs,
      sections,
      insight: this.buildInsight(ideContext, selectedFiles, selectedLogs, contextSnippets),
    };
  }
}
