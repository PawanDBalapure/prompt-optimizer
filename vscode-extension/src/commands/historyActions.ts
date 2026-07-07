import * as vscode from 'vscode';

import { CONVERSATION_KEY } from '../constants';
import type { PromptProxyViewProvider } from '../panel/PromptProxyViewProvider';
import { getConversation } from '../state/conversation';
import type { ConversationTurn } from '../types';

type HistoryAction =
  | 'diff'
  | 'restore'
  | 'send'
  | 'copyOptimized'
  | 'copyOriginal'
  | 'peek'
  | 'delete';

interface ActionItem extends vscode.QuickPickItem {
  id: HistoryAction;
}

export function preview(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}

/** Step 2: the clearly-labelled action menu for one history entry. */
export async function runActionMenu(
  context: vscode.ExtensionContext,
  provider: PromptProxyViewProvider | undefined,
  turn: ConversationTurn,
): Promise<void> {
  const when = new Date(turn.timestamp).toLocaleString();
  const actions: ActionItem[] = [
    {
      id: 'diff',
      label: '$(diff) View original ↔ optimized side by side',
      description: 'Opens a diff editor — easiest way to see what the optimizer changed.',
    },
    {
      id: 'restore',
      label: '$(arrow-circle-up) Restore original prompt to the panel',
      description: 'Loads this prompt back into the panel input so you can re-run or edit it.',
    },
    {
      id: 'send',
      label: '$(send) Send optimized prompt to Copilot Chat',
      description: 'Opens Chat with the optimized version pre-filled (not auto-sent).',
    },
    {
      id: 'copyOptimized',
      label: '$(clippy) Copy optimized prompt to clipboard',
      description: `${turn.user_optimized.length} characters`,
    },
    {
      id: 'copyOriginal',
      label: '$(clippy) Copy original prompt to clipboard',
      description: `${turn.user_raw.length} characters`,
    },
    {
      id: 'peek',
      label: '$(eye) Peek the full prompt in a scratch editor',
      description: 'Read-only preview — useful for long prompts.',
    },
    {
      id: 'delete',
      label: '$(trash) Delete this history entry',
      description: 'Removes only this prompt; the rest of the history is kept.',
    },
  ];

  const picked = await vscode.window.showQuickPick<ActionItem>(actions, {
    title: `What do you want to do with this prompt? · ${when}`,
    placeHolder: preview(turn.user_raw, 100),
    matchOnDescription: true,
  });
  if (!picked) { return; }

  switch (picked.id) {
    case 'diff': return openDiff(turn);
    case 'restore': return restoreToPanel(provider, turn);
    case 'send': return sendToChat(turn);
    case 'copyOptimized': return copyToClipboard(turn.user_optimized, 'Optimized prompt');
    case 'copyOriginal': return copyToClipboard(turn.user_raw, 'Original prompt');
    case 'peek': return peekPrompt(turn);
    case 'delete': return deleteEntry(context, turn);
  }
}

async function restoreToPanel(
  provider: PromptProxyViewProvider | undefined,
  turn: ConversationTurn,
): Promise<void> {
  if (!provider) {
    // Provider isn't wired in this build — fall back to a peek so the user
    // still gets the prompt content somewhere they can grab it.
    await peekPrompt(turn);
    return;
  }
  await vscode.commands.executeCommand('prompt-proxy.focusPanel');
  provider.restorePromptInPanel(turn.user_raw);
  vscode.window.setStatusBarMessage('$(check) Prompt restored to panel', 3000);
}

async function sendToChat(turn: ConversationTurn): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.chat.open', {
    query: turn.user_optimized,
    isPartialQuery: true,
  });
}

async function copyToClipboard(text: string, label: string): Promise<void> {
  await vscode.env.clipboard.writeText(text);
  vscode.window.setStatusBarMessage(`$(check) ${label} copied to clipboard`, 2500);
}

export async function peekPrompt(turn: ConversationTurn): Promise<void> {
  const when = new Date(turn.timestamp).toLocaleString();
  const body = `# Prompt Optimizer — peek\n\n` +
    `_Captured ${when}_\n\n` +
    `## Original prompt (${turn.user_raw.length} chars)\n\n${turn.user_raw}\n\n` +
    `---\n\n` +
    `## Optimized prompt (${turn.user_optimized.length} chars)\n\n${turn.user_optimized}\n`;
  const doc = await vscode.workspace.openTextDocument({ content: body, language: 'markdown' });
  await vscode.window.showTextDocument(doc, { preview: true });
}

async function deleteEntry(
  context: vscode.ExtensionContext,
  turn: ConversationTurn,
): Promise<void> {
  const YES = 'Delete';
  const pick = await vscode.window.showWarningMessage(
    `Delete this history entry? "${preview(turn.user_raw, 60)}"`,
    { modal: true }, YES,
  );
  if (pick !== YES) { return; }
  const all = getConversation(context);
  const remaining = all.filter((t) => t.id !== turn.id);
  await context.globalState.update(CONVERSATION_KEY, remaining);
  vscode.window.setStatusBarMessage('$(check) History entry deleted', 3000);
  // Reopen the picker so the user can keep working through the list.
  void vscode.commands.executeCommand('prompt-proxy.showHistory');
}

async function openDiff(turn: ConversationTurn): Promise<void> {
  const original = await vscode.workspace.openTextDocument({
    content: turn.user_raw, language: 'markdown',
  });
  const optimized = await vscode.workspace.openTextDocument({
    content: turn.user_optimized, language: 'markdown',
  });
  const when = new Date(turn.timestamp).toLocaleString();
  await vscode.commands.executeCommand(
    'vscode.diff', original.uri, optimized.uri,
    `Prompt Optimizer · original ↔ optimized (${when})`,
    { preview: true, viewColumn: vscode.ViewColumn.Active },
  );
}
