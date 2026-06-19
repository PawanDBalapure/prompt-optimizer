import * as path from 'path';
import * as vscode from 'vscode';

import { getLastAnalysis } from '../state/session';
import type { PromptProxyPanelState } from '../types';

/** A 0-based, inclusive line range as carried by the engine response. */
type SnippetRange = { start_line: number; end_line: number };

/** Resolve a (possibly workspace-relative) context path to a file URI. */
function resolveUri(filePath: string, workspaceRoot?: string): vscode.Uri {
  // Normalize forward slashes to OS-appropriate separators
  const normalized = filePath.replace(/\//g, path.sep);
  
  if (path.isAbsolute(normalized)) {
    return vscode.Uri.file(normalized);
  }
  
  const root = workspaceRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (root) {
    return vscode.Uri.file(path.join(root, normalized));
  }
  
  // Fallback to treating as absolute if no workspace root available
  return vscode.Uri.file(normalized);
}

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
 * Command handler for `prompt-proxy.openContextFiles`.
 *
 * Deterministic policy:
 * 1. Open files from the last analysis context.
 * 2. Select text ONLY when exact snippet ranges are present.
 * 3. If exact ranges are unavailable, do not infer; report unresolved state.
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

  const snippetsByPath = new Map<string, SnippetRange[]>();
  for (const snippet of ctx.context_snippets ?? []) {
    if (snippet.ranges.length > 0) {
      snippetsByPath.set(snippet.path, snippet.ranges);
    }
  }

  let opened = 0;
  let selected = 0;
  let unresolved = 0;
  const failures: Array<{ path: string; error: string }> = [];

  for (const filePath of paths) {
    const uri = resolveUri(filePath, ctx.workspace_root);
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc, { preview: false });
      opened++;

      const exact = snippetsByPath.get(filePath);
      if (!exact || exact.length === 0) {
        unresolved++;
        continue;
      }

      const ranges = rangesFromSnippet(doc, exact);
      if (ranges.length === 0) {
        unresolved++;
        continue;
      }

      editor.selections = ranges.map((r) => new vscode.Selection(r.start, r.end));
      editor.revealRange(ranges[0], vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      selected++;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      failures.push({ path: filePath, error: errMsg });
    }
  }

  const parts = [`opened ${opened} file${opened === 1 ? '' : 's'}`];
  if (selected > 0) {
    parts.push(`selected exact ranges in ${selected}`);
  }
  if (unresolved > 0) {
    parts.push(`no exact range available for ${unresolved}`);
  }
  if (failures.length > 0) {
    const preview = failures.map((f) => `${f.path} (${f.error})`).slice(0, 2).join('; ');
    parts.push(`couldn't open ${failures.length} (${preview}${failures.length > 2 ? '…' : ''})`);
  }
  if (ctx.deterministic_routing && ctx.deterministic_routing.status !== 'resolved') {
    parts.push(`routing ${ctx.deterministic_routing.status}: ${ctx.deterministic_routing.reason}`);
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