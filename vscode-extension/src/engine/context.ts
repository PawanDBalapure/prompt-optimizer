import * as vscode from 'vscode';

import { MAX_CHAT_HISTORY_ITEMS } from '../constants';
import { isSessionContextEnabled } from '../state/config';
import { getSessionBuffer } from '../state/session';
import { formatCurrency, locationToText, trimForDisplay } from '../util/format';

export interface IdeContextBundle {
  workspace_root?: string;
  active_file?: {
    path: string;
    content: string;
    is_active: boolean;
    selection: string;
    language: string;
  };
  open_files: Array<{
    path: string;
    content: string;
    selection: string;
    language: string;
    is_active: boolean;
  }>;
  logs: Array<{ source: string; kind: string; content: string }>;
}

export function getSessionHistoryLogs(
  context: vscode.ExtensionContext,
): Array<{ source: string; kind: string; content: string }> {
  if (!isSessionContextEnabled()) { return []; }

  const history = getSessionBuffer(context);
  if (history.length === 0) { return []; }

  const content = history
    .map((item, index) => {
      const turnNumber = index + 1;
      return [
        `Turn ${turnNumber} [${item.source}]`,
        `Prompt: ${trimForDisplay(item.prompt, 180)}`,
        `Optimized: ${trimForDisplay(item.optimized_prompt, 180)}`,
        `Cache: ${item.cache_status}; Saved: ${item.tokens_saved} tokens; Cost: ${formatCurrency(item.estimated_cost_usd)}`,
      ].join('\n');
    })
    .join('\n\n');

  return [{ source: 'Prompt Optimizer Session Buffer', kind: 'general', content }];
}

export function getChatHistoryLogs(
  chatContext?: vscode.ChatContext,
): Array<{ source: string; kind: string; content: string }> {
  if (!chatContext || chatContext.history.length === 0) { return []; }

  const content = chatContext.history
    .slice(-MAX_CHAT_HISTORY_ITEMS)
    .map((turn, index) => `${index + 1}. ${extractChatTurnText(turn)}`)
    .filter((value) => value.trim() !== '')
    .join('\n');

  if (content.trim() === '') { return []; }

  return [{ source: 'Prompt Optimizer Chat History', kind: 'general', content }];
}

export function extractChatTurnText(
  turn: vscode.ChatRequestTurn | vscode.ChatResponseTurn,
): string {
  if (turn instanceof vscode.ChatRequestTurn) {
    return `User: ${trimForDisplay(turn.prompt, 240)}`;
  }

  const parts = turn.response.map((part) => {
    if (part instanceof vscode.ChatResponseMarkdownPart) { return part.value.value; }
    if (part instanceof vscode.ChatResponseAnchorPart) { return part.title ?? locationToText(part.value); }
    if (part instanceof vscode.ChatResponseFileTreePart) {
      return `[file tree: ${part.value.map((node) => node.name).join(', ')}]`;
    }
    if (part instanceof vscode.ChatResponseCommandButtonPart) { return `[button: ${part.value.title}]`; }
    return '';
  });

  return `Assistant: ${trimForDisplay(parts.join(' '), 320)}`;
}

export function getIdeContext(
  context: vscode.ExtensionContext,
  chatContext?: vscode.ChatContext,
  options: { includeHistoryLogs?: boolean } = {},
): IdeContextBundle {
  const ideContext: IdeContextBundle = {
    workspace_root: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    active_file: undefined,
    open_files: [],
    logs: [],
  };

  const activeEditor = vscode.window.activeTextEditor;
  if (activeEditor) {
    ideContext.active_file = {
      path: activeEditor.document.uri.fsPath,
      content: activeEditor.document.getText(),
      is_active: true,
      selection: activeEditor.document.getText(activeEditor.selection),
      language: activeEditor.document.languageId,
    };
  }

  for (const editor of vscode.window.visibleTextEditors) {
    if (editor === activeEditor) { continue; }
    ideContext.open_files.push({
      path: editor.document.uri.fsPath,
      content: editor.document.getText(),
      selection: editor.document.getText(editor.selection),
      language: editor.document.languageId,
      is_active: false,
    });
  }

  // Historical prompts and Copilot turns are useful when building the LM
  // message chain inside the chat-participant handler, but they MUST NOT be
  // packed into the user-facing optimized prompt — the engine treats every
  // log as relevant context and would otherwise echo prior prompts back to
  // the user.  Default is therefore off; chat-participant callers opt in.
  if (options.includeHistoryLogs) {
    ideContext.logs.push(...getSessionHistoryLogs(context));
    ideContext.logs.push(...getChatHistoryLogs(chatContext));
  }

  return ideContext;
}

/** Workspace globs never worth searching for prompt-referenced files. */
const DISCOVERY_EXCLUDE =
  '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/build/**,**/.next/**,**/coverage/**,**/*.min.*}';
const MAX_DISCOVERED_FILES = 5;
const MAX_DISCOVERED_BYTES = 200_000;

/**
 * Pull file/symbol references out of a prompt: explicit `name.ext` paths plus
 * camelCase / PascalCase / snake_case identifiers (>= 4 chars) that commonly
 * name a file by its class/module symbol (e.g. `promptProxyEngine`).
 */
function extractReferenceNames(rawPrompt: string): { files: Set<string>; symbols: Set<string> } {
  const files = new Set<string>();
  const symbols = new Set<string>();
  for (const match of rawPrompt.matchAll(/\b([A-Za-z0-9_\-]+\.[A-Za-z0-9]{1,6})\b/g)) {
    files.add(match[1]);
  }
  for (const match of rawPrompt.matchAll(/\b[A-Za-z_$][A-Za-z0-9_$]*\b/g)) {
    const token = match[0];
    if (token.length < 4) { continue; }
    const isCamel = /[a-z]/.test(token) && /[A-Z]/.test(token);
    const isSnake = token.includes('_');
    if (isCamel || isSnake) { symbols.add(token); }
  }
  return { files, symbols };
}

/** Brace-expanded case variants so a Windows/macOS glob still matches a symbol. */
function caseVariants(name: string): string {
  const lower = name.charAt(0).toLowerCase() + name.slice(1);
  const upper = name.charAt(0).toUpperCase() + name.slice(1);
  const set = new Set([name, lower, upper]);
  return set.size === 1 ? name : `{${[...set].join(',')}}`;
}

/**
 * Discover files the prompt references by name but that are NOT currently open,
 * and append them to `open_files` so the engine can route to and open them.
 * Best-effort and bounded: it caps the number of files, skips heavy/binary
 * trees, and silently ignores unreadable matches so it can never block or throw.
 */
export async function augmentContextWithReferencedFiles(
  ideContext: IdeContextBundle,
  rawPrompt: string,
): Promise<void> {
  if (!vscode.workspace.workspaceFolders?.length) { return; }

  const alreadyKnown = new Set<string>(
    [ideContext.active_file?.path, ...ideContext.open_files.map((f) => f.path)]
      .filter((p): p is string => Boolean(p))
      .map((p) => p.toLowerCase()),
  );

  const { files, symbols } = extractReferenceNames(rawPrompt);
  const globs: string[] = [];
  for (const file of files) { globs.push(`**/${file}`); }
  for (const symbol of symbols) { globs.push(`**/${caseVariants(symbol)}.*`); }
  if (globs.length === 0) { return; }

  const found = new Map<string, vscode.Uri>();
  for (const glob of globs) {
    if (found.size >= MAX_DISCOVERED_FILES) { break; }
    let uris: vscode.Uri[] = [];
    try {
      uris = await vscode.workspace.findFiles(glob, DISCOVERY_EXCLUDE, MAX_DISCOVERED_FILES);
    } catch {
      continue;
    }
    for (const uri of uris) {
      const key = uri.fsPath.toLowerCase();
      if (alreadyKnown.has(key) || found.has(key)) { continue; }
      found.set(key, uri);
      if (found.size >= MAX_DISCOVERED_FILES) { break; }
    }
  }

  for (const uri of found.values()) {
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > MAX_DISCOVERED_BYTES) { continue; }
      const doc = await vscode.workspace.openTextDocument(uri);
      ideContext.open_files.push({
        path: uri.fsPath,
        content: doc.getText(),
        selection: '',
        language: doc.languageId,
        is_active: false,
      });
    } catch {
      // Unreadable/binary file — skip silently.
    }
  }
}
