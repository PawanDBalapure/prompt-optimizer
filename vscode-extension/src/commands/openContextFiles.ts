import * as path from 'path';
import * as vscode from 'vscode';

import { getLastAnalysis } from '../state/session';
import type { PromptProxyPanelState } from '../types';

/**
 * Open every workspace file the last optimization pulled into context and
 * select the prompt-relevant text inside each one.
 *
 * Selection precision is best-effort, in priority order:
 *   1. EXACT — `analysis.context.context_snippets` carries the 0-based line
 *      ranges the engine's context packer actually extracted; we select those.
 *   2. HEURISTIC — when ranges are absent (e.g. the engine used a raw user
 *      selection, or an older analysis without snippet data) we re-derive the
 *      relevant lines using the same rule the packer uses: a line is "related"
 *      when it contains one of the prompt's query terms.
 */

/** Very common words that carry no locating signal — excluded from query terms. */
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'into', 'your', 'you',
  'are', 'was', 'were', 'has', 'have', 'had', 'not', 'but', 'can', 'will',
  'should', 'would', 'could', 'please', 'make', 'add', 'use', 'using', 'get',
  'set', 'all', 'any', 'how', 'what', 'when', 'where', 'why', 'which', 'them',
  'then', 'than', 'its', 'his', 'her', 'our', 'out', 'new', 'now', 'one', 'two',
]);

/** Tokenize the raw prompt into lower-cased query terms (len >= 3, no stop words). */
function buildQueryTerms(prompt: string): string[] {
  const terms = new Set<string>();
  for (const token of prompt.toLowerCase().match(/[a-z0-9_]+/g) ?? []) {
    if (token.length >= 3 && !STOP_WORDS.has(token)) {
      terms.add(token);
    }
  }
  return Array.from(terms);
}

/**
 * Literal code symbols the prompt is about — backticked spans plus
 * camelCase / PascalCase / snake_case identifiers (>= 4 chars). These are
 * matched as whole words and take priority over generic terms so a query like
 * "what does buildModeItems do" selects only the symbol's lines, not every
 * line that happens to contain a common word.
 */
function buildSalientTerms(prompt: string): string[] {
  const terms = new Set<string>();
  for (const m of prompt.matchAll(/`([^`]+)`/g)) {
    const t = m[1].trim().toLowerCase();
    if (t.length >= 3) { terms.add(t); }
  }
  for (const m of prompt.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) {
    const token = m[0];
    if (token.length < 4) { continue; }
    const isCamel = /[a-z]/.test(token) && /[A-Z]/.test(token);
    if (isCamel || token.includes('_')) { terms.add(token.toLowerCase()); }
  }
  return Array.from(terms);
}

/** True when `term` appears in `haystack` as a whole identifier (word-boundary). */
function containsWord(haystack: string, term: string): boolean {
  let from = 0;
  let index = haystack.indexOf(term, from);
  while (index !== -1) {
    const before = index === 0 ? '' : haystack[index - 1];
    const after = haystack[index + term.length] ?? '';
    if (!/[a-z0-9_$]/.test(before) && !/[a-z0-9_$]/.test(after)) { return true; }
    from = index + term.length;
    index = haystack.indexOf(term, from);
  }
  return false;
}

/** Resolve a (possibly workspace-relative) context path to a file URI. */
function resolveUri(filePath: string, workspaceRoot?: string): vscode.Uri {
  if (path.isAbsolute(filePath)) {
    return vscode.Uri.file(filePath);
  }
  const root = workspaceRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return vscode.Uri.file(root ? path.join(root, filePath) : filePath);
}

/** Find every non-blank document line that contains a query term. */
function findMatchingRanges(
  doc: vscode.TextDocument,
  terms: string[],
  salientTerms: string[],
): vscode.Range[] {
  if (terms.length === 0 && salientTerms.length === 0) {
    return [];
  }
  const rangeAt = (i: number): vscode.Range => {
    const line = doc.lineAt(i);
    return new vscode.Range(i, line.firstNonWhitespaceCharacterIndex, i, line.text.length);
  };

  // Tier 1: whole-word literal symbol matches — tight and on-topic.
  if (salientTerms.length > 0) {
    const precise: vscode.Range[] = [];
    for (let i = 0; i < doc.lineCount; i++) {
      const line = doc.lineAt(i);
      if (line.isEmptyOrWhitespace) { continue; }
      const haystack = line.text.toLowerCase();
      if (salientTerms.some((t) => containsWord(haystack, t))) { precise.push(rangeAt(i)); }
    }
    if (precise.length > 0) { return precise; }
  }

  // Tier 2: generic substring fallback when no symbol was named or matched.
  const ranges: vscode.Range[] = [];
  for (let i = 0; i < doc.lineCount; i++) {
    const line = doc.lineAt(i);
    if (line.isEmptyOrWhitespace) {
      continue;
    }
    const haystack = line.text.toLowerCase();
    if (terms.some((term) => haystack.includes(term))) {
      ranges.push(rangeAt(i));
    }
  }
  return ranges;
}

/** A 0-based, inclusive line range as carried by the engine response. */
type SnippetRange = { start_line: number; end_line: number };

/** Convert engine line ranges into full-line editor ranges, clamped to the doc. */
function rangesFromSnippet(doc: vscode.TextDocument, snippetRanges: SnippetRange[]): vscode.Range[] {
  const ranges: vscode.Range[] = [];
  const lastLine = doc.lineCount - 1;
  for (const { start_line, end_line } of snippetRanges) {
    if (start_line > lastLine) {
      continue;
    }
    const start = Math.max(0, start_line);
    const end = Math.min(lastLine, Math.max(start, end_line));
    ranges.push(new vscode.Range(start, 0, end, doc.lineAt(end).text.length));
  }
  return ranges;
}

/**
 * Command handler for `prompt-proxy.openContextFiles`. Opens all context files
 * from the most recent optimization (each in its own tab) and selects the
 * related text in each.
 */
export async function openContextFilesAndSelect(
  context: vscode.ExtensionContext,
  options?: { notify?: boolean },
): Promise<void> {
  const notify = options?.notify !== false;
  const state = getLastAnalysis(context);
  if (!state) {
    if (notify) {
      vscode.window.showInformationMessage(
        'Prompt Optimizer: optimize a prompt first — there is no analysis to open files from yet.',
      );
    }
    return;
  }

  const ctx = state.analysis.context;
  const paths = Array.from(
    new Set([
      ...(ctx.active_file ? [ctx.active_file] : []),
      ...ctx.selected_files,
    ]),
  );
  if (paths.length === 0) {
    if (notify) {
      vscode.window.showInformationMessage(
        'Prompt Optimizer: the last optimization did not use any workspace files.',
      );
    }
    return;
  }

  const terms = buildQueryTerms(state.original);
  const salientTerms = buildSalientTerms(state.original);
  const snippetsByPath = new Map<string, SnippetRange[]>();
  for (const snippet of ctx.context_snippets ?? []) {
    if (snippet.ranges.length > 0) {
      snippetsByPath.set(snippet.path, snippet.ranges);
    }
  }

  let opened = 0;
  let selected = 0;
  const failures: string[] = [];

  for (const filePath of paths) {
    const uri = resolveUri(filePath, ctx.workspace_root);
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc, { preview: false });
      opened++;

      const exact = snippetsByPath.get(filePath);
      const ranges = exact ? rangesFromSnippet(doc, exact) : findMatchingRanges(doc, terms, salientTerms);
      if (ranges.length > 0) {
        editor.selections = ranges.map((r) => new vscode.Selection(r.start, r.end));
        editor.revealRange(ranges[0], vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        selected++;
      }
    } catch {
      failures.push(filePath);
    }
  }

  const parts = [`opened ${opened} file${opened === 1 ? '' : 's'}`];
  if (selected > 0) {
    parts.push(`selected related text in ${selected}`);
  }
  if (failures.length > 0) {
    const preview = failures.slice(0, 3).join(', ');
    parts.push(`couldn't open ${failures.length} (${preview}${failures.length > 3 ? '…' : ''})`);
  }
  if (notify) {
    vscode.window.showInformationMessage(`Prompt Optimizer: ${parts.join('; ')}.`);
  }
}

/**
 * Optional post-analysis UX: auto-open context files right after local
 * optimization so users can inspect the exact ranges the engine used.
 */
export async function maybeAutoOpenContextFiles(
  context: vscode.ExtensionContext,
  state: PromptProxyPanelState,
): Promise<void> {
  const enabled = vscode.workspace
    .getConfiguration('promptProxy')
    .get<boolean>('optimize.autoOpenContextFiles', false);
  if (!enabled) { return; }

  const hasFiles = Boolean(state.analysis.context.active_file)
    || state.analysis.context.selected_files.length > 0;
  if (!hasFiles) { return; }

  await openContextFilesAndSelect(context, { notify: false });
}
