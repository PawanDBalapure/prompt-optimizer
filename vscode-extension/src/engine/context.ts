import * as vscode from 'vscode';

import { MAX_CHAT_HISTORY_ITEMS } from '../constants';
import { isSessionContextEnabled } from '../state/config';
import { getSessionBuffer } from '../state/session';
import { formatCurrency, locationToText, trimForDisplay } from '../util/format';

export { augmentContextWithReferencedFiles } from './fileDiscovery';

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
