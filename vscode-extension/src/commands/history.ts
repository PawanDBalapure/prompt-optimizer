import * as vscode from 'vscode';

import { CONVERSATION_KEY } from '../constants';
import type { ConversationTurn } from '../types';
import { computeWorkspaceId } from '../util/workspace';
import type { PromptProxyViewProvider } from '../panel/PromptProxyViewProvider';

/**
 * Prompt history browser — minimalist two-step UX.
 *
 *   Step 1: a QuickPick listing past prompts (newest first), each shown as
 *           a short preview + relative timestamp.  No tiny side icons to
 *           hunt for; only one optional "peek" button that previews the
 *           full prompt inline without leaving the picker.
 *
 *   Step 2: when the user picks an entry, a second QuickPick opens with
 *           clearly labelled actions ("View original ↔ optimized side by
 *           side", "Send to Copilot Chat", …) so the available actions are
 *           always discoverable.
 *
 * The two-step shape mirrors patterns the user already knows from
 * built-in commands ("Git: Checkout to…", "Tasks: Run Task…") which is
 * why it feels native.
 */

interface HistoryItem extends vscode.QuickPickItem {
  turn: ConversationTurn;
}

interface ActionItem extends vscode.QuickPickItem {
  id: HistoryAction;
}

type HistoryAction =
  | 'diff'
  | 'restore'
  | 'send'
  | 'copyOptimized'
  | 'copyOriginal'
  | 'peek'
  | 'delete';

export function registerHistoryCommand(
  context: vscode.ExtensionContext,
  provider?: PromptProxyViewProvider,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('prompt-proxy.showHistory', () => showHistory(context, provider)),
  );
}

async function showHistory(
  context: vscode.ExtensionContext,
  provider?: PromptProxyViewProvider,
): Promise<void> {
  const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const wsId = computeWorkspaceId(wsRoot);
  const all = context.globalState.get<ConversationTurn[]>(CONVERSATION_KEY) ?? [];
  const turns = all.filter((t) => t.workspace_id === wsId);

  if (turns.length === 0) {
    const OPEN = 'Open Panel';
    const pick = await vscode.window.showInformationMessage(
      'No prompt history yet. Run a prompt from the Prompt Optimizer panel (or @promptoptimizer chat), then come back here.',
      OPEN,
    );
    if (pick === OPEN) { await vscode.commands.executeCommand('prompt-proxy.focusPanel'); }
    return;
  }

  const sorted = [...turns].sort((a, b) => b.timestamp - a.timestamp);

  const peekButton: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('eye'),
    tooltip: 'Peek: open the full prompt in a scratch editor',
  };

  const buildItems = (list: ConversationTurn[]): HistoryItem[] => list.map((t, i) => {
    const savings = t.user_raw.length - t.user_optimized.length;
    const stats = savings > 0
      ? `saved ~${savings} chars`
      : savings < 0 ? `+${-savings} chars` : 'no length change';
    return {
      label: `$(comment-discussion) ${preview(t.user_raw, 90)}`,
      description: `${formatRelative(t.timestamp)}${i === 0 ? '  ·  most recent' : ''}`,
      detail: `${stats}  ·  original ${t.user_raw.length} chars → optimized ${t.user_optimized.length} chars`,
      buttons: [peekButton],
      turn: t,
    };
  });

  const clearAllButton: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('clear-all'),
    tooltip: 'Clear all prompt history for this workspace',
  };

  const qp = vscode.window.createQuickPick<HistoryItem>();
  qp.title = `Prompt history · ${sorted.length} prompt${sorted.length === 1 ? '' : 's'} in this workspace`;
  qp.placeholder = 'Pick a prompt to see actions (diff, restore, send to Chat, copy, delete) · Esc to close';
  qp.matchOnDescription = true;
  qp.matchOnDetail = true;
  qp.items = buildItems(sorted);
  qp.buttons = [clearAllButton];

  qp.onDidTriggerButton(async (btn) => {
    if (btn === clearAllButton) {
      const YES = `Clear ${sorted.length} entries`;
      const choice = await vscode.window.showWarningMessage(
        `Clear all ${sorted.length} prompt history entries for this workspace? Cached results are kept.`,
        { modal: true }, YES,
      );
      if (choice === YES) {
        const remaining = all.filter((t) => t.workspace_id !== wsId);
        await context.globalState.update(CONVERSATION_KEY, remaining);
        vscode.window.setStatusBarMessage('$(check) Prompt Optimizer: history cleared', 3000);
        qp.hide();
      }
    }
  });

  qp.onDidTriggerItemButton(async (e) => {
    if (e.button === peekButton) { await peekPrompt(e.item.turn); }
  });

  qp.onDidAccept(async () => {
    const picked = qp.selectedItems[0];
    if (!picked) { return; }
    qp.hide();
    await runActionMenu(context, provider, picked.turn);
  });

  qp.onDidHide(() => qp.dispose());
  qp.show();
}

async function runActionMenu(
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
    case 'diff':           return openDiff(turn);
    case 'restore':        return restoreToPanel(provider, turn);
    case 'send':           return sendToChat(turn);
    case 'copyOptimized':  return copyToClipboard(turn.user_optimized, 'Optimized prompt');
    case 'copyOriginal':   return copyToClipboard(turn.user_raw, 'Original prompt');
    case 'peek':           return peekPrompt(turn);
    case 'delete':         return deleteEntry(context, turn);
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

async function peekPrompt(turn: ConversationTurn): Promise<void> {
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
  const all = context.globalState.get<ConversationTurn[]>(CONVERSATION_KEY) ?? [];
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

function preview(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}

function formatRelative(timestamp: number): string {
  const diffMs = Date.now() - timestamp;
  const s = Math.round(diffMs / 1000);
  if (s < 60)     { return `${s}s ago`; }
  const m = Math.round(s / 60);
  if (m < 60)     { return `${m}m ago`; }
  const h = Math.round(m / 60);
  if (h < 24)     { return `${h}h ago`; }
  const d = Math.round(h / 24);
  return `${d}d ago`;
}
