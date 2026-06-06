import type { PromptIDEContext } from '../contracts.js';
import { isInternalPromptSection } from './sanitizer.js';
import { optimizePromptText } from './textOptimizer.js';
import { MAX_IMPROVEMENTS } from './constants.js';

/**
 * Build the snapshot string that is fed into the semantic cache key.  Keeps
 * the active file plus open files plus logs, all joined by section headers.
 */
export function buildRawInputSnapshot(
  rawPrompt: string,
  ideContext?: PromptIDEContext,
): string {
  const sections = ['# Request', rawPrompt.trim()];

  if (!ideContext) {
    return sections.join('\n\n');
  }

  if (ideContext.active_file) {
    sections.push(`# ${ideContext.active_file.path}`, ideContext.active_file.content.trim());
  }

  for (const file of ideContext.open_files ?? []) {
    if (ideContext.active_file && file.path === ideContext.active_file.path) {
      continue;
    }
    sections.push(`# ${file.path}`, file.content.trim());
  }

  for (const log of ideContext.logs ?? []) {
    sections.push(`# ${log.source}`, log.content.trim());
  }

  return sections.filter((section) => section.trim() !== '').join('\n\n');
}

/**
 * Compose the optimized prompt: strip leaked context blocks, run the text
 * compressor on the request, then append packed context sections.
 */
export function buildOptimizedPrompt(rawPrompt: string, contextSections: string[]): string {
  const cleanPrompt = rawPrompt
    .replace(/(?:^|\n\n)# Problems\n[\s\S]*?(?=\n\n#|$)/g, '')
    .replace(/(?:^|\n\n)# Prompt (?:Proxy|Optimizer)[^\n]*\n[\s\S]*?(?=\n\n#|$)/g, '')
    .trim();

  // We no longer append IDE context files or code blocks to the optimized prompt.
  // We simply return the optimized compiler structure directly.
  return cleanPrompt;
}

export function selectImprovementSuggestions(
  prompt: string,
  ideContext?: PromptIDEContext,
): string[] {
  const suggestions: string[] = [];
  const lowerPrompt = prompt.toLowerCase();

  if (!/\bjson\b|\byaml\b|\bmarkdown\b|\bbullet\b|\btable\b/.test(lowerPrompt)) {
    suggestions.push('Specify the exact output format, for example JSON with required keys or a fixed checklist.');
  }

  if ((ideContext?.active_file || /#\s+[^\n]+\.(ts|tsx|js|jsx|py|java|kt|json|xml)/i.test(prompt))
    && !lowerPrompt.includes('selection')) {
    suggestions.push('Limit the request to the active selection or the smallest failing snippet to improve answer precision.');
  }

  if (/\b(function|class|const|let|var|import|export|interface)\b/.test(lowerPrompt) && !/```/.test(prompt)) {
    suggestions.push('Wrap source code in fenced code blocks and keep one file anchor per snippet.');
  }

  if (suggestions.length === 0) {
    suggestions.push('Add explicit acceptance criteria so the response can be validated without extra clarification.');
  }

  return Array.from(new Set(suggestions)).slice(0, MAX_IMPROVEMENTS);
}
