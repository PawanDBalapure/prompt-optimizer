import * as vscode from 'vscode';

import { CONVERSATION_KEY } from '../constants';
import type { PromptProxyViewProvider } from '../panel/PromptProxyViewProvider';
import { getConversation } from '../state/conversation';
import type { ConversationTurn } from '../types';
import { computeWorkspaceId } from '../util/workspace';
import { peekPrompt, preview, runActionMenu } from './historyActions';

/**
 * Prompt history browser — minimalist two-step UX.
 *
 *   Step 1: a QuickPick listing past prompts (newest first) with a "peek"
 *           button that previews the full prompt without leaving the picker.
 *   Step 2: picking an entry opens a clearly-labelled action menu
 *           (diff / restore / send / copy / peek / delete).
 */

interface HistoryItem extends vscode.QuickPickItem {
  turn: ConversationTurn;
}

export function registerHistoryCommand(
  context: vscode.ExtensionContext,
  provider?: PromptProxyViewProvider,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('prompt-proxy.showHistory', () => showHistory(context, provider)),
  );
}

function formatRelative(timestamp: number): string {
  const s = Math.round((Date.now() - timestamp) / 1000);
  if (s < 60) { return `${s}s ago`; }
  const m = Math.round(s / 60);
  if (m < 60) { return `${m}m ago`; }
  const h = Math.round(m / 60);
  if (h < 24) { return `${h}h ago`; }
  return `${Math.round(h / 24)}d ago`;
}

async function showHistory(
  context: vscode.ExtensionContext,
  provider?: PromptProxyViewProvider,
): Promise<void> {
  const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const wsId = computeWorkspaceId(wsRoot);
  const all = getConversation(context);
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
