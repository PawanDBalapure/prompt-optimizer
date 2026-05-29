import * as vscode from 'vscode';

import { CONVERSATION_KEY } from '../constants';
import type { ConversationTurn } from '../types';
import { computeWorkspaceId } from '../util/workspace';

/**
 * QuickPick-based prompt history browser.  Lists conversation turns from
 * `globalState[CONVERSATION_KEY]` for the current workspace, with a side
 * action that opens the original ↔ optimized prompt as a `vscode.diff`
 * view so the user can inspect what the optimizer did to each prompt.
 */

interface HistoryItem extends vscode.QuickPickItem {
  turn: ConversationTurn;
}

export function registerHistoryCommand(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('prompt-proxy.showHistory', () => showHistory(context)),
  );
}

async function showHistory(context: vscode.ExtensionContext): Promise<void> {
  const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const wsId = computeWorkspaceId(wsRoot);
  const all = context.globalState.get<ConversationTurn[]>(CONVERSATION_KEY) ?? [];
  const turns = all.filter((t) => t.workspace_id === wsId);

  if (turns.length === 0) {
    const OPEN = 'Open Panel';
    const pick = await vscode.window.showInformationMessage(
      'Prompt Optimizer has no prompt history for this workspace yet. Run a prompt from the panel or @promptoptimizer chat first.',
      OPEN,
    );
    if (pick === OPEN) { await vscode.commands.executeCommand('prompt-proxy.focusPanel'); }
    return;
  }

  // Newest first — most useful when re-opening recent prompts.
  const sorted = [...turns].sort((a, b) => b.timestamp - a.timestamp);
  const items: HistoryItem[] = sorted.map((t) => ({
    label: `$(history) ${preview(t.user_raw, 80)}`,
    description: formatRelative(t.timestamp),
    detail: `original ${t.user_raw.length} chars → optimized ${t.user_optimized.length} chars`,
    turn: t,
  }));

  const compareButton: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('diff'),
    tooltip: 'Compare original ↔ optimized prompt side by side',
  };
  const copyButton: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('copy'),
    tooltip: 'Copy optimized prompt to clipboard',
  };
  const sendButton: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('send'),
    tooltip: 'Send optimized prompt to Copilot Chat',
  };
  for (const it of items) {
    it.buttons = [compareButton, copyButton, sendButton];
  }

  const qp = vscode.window.createQuickPick<HistoryItem>();
  qp.title = `Prompt Optimizer — ${turns.length} prompt(s) in this workspace`;
  qp.placeholder = 'Type to filter · Enter to view · use the side icons to diff / copy / send';
  qp.matchOnDescription = true;
  qp.matchOnDetail = true;
  qp.items = items;
  qp.buttons = [
    { iconPath: new vscode.ThemeIcon('trash'), tooltip: 'Clear all history for this workspace' },
  ];

  qp.onDidTriggerButton(async (btn) => {
    if (btn.tooltip?.startsWith('Clear all')) {
      const YES = 'Yes, clear all';
      const pick = await vscode.window.showWarningMessage(
        `Clear ${turns.length} prompt history entries for this workspace? Cached results are kept.`,
        { modal: true }, YES,
      );
      if (pick === YES) {
        const remaining = all.filter((t) => t.workspace_id !== wsId);
        await context.globalState.update(CONVERSATION_KEY, remaining);
        qp.hide();
        vscode.window.setStatusBarMessage('$(check) Prompt Optimizer: history cleared', 3000);
      }
    }
  });

  qp.onDidTriggerItemButton(async (e) => {
    const turn = e.item.turn;
    if (e.button === compareButton) {
      await openDiff(turn);
    } else if (e.button === copyButton) {
      await vscode.env.clipboard.writeText(turn.user_optimized);
      vscode.window.setStatusBarMessage('$(check) Optimized prompt copied', 2000);
    } else if (e.button === sendButton) {
      await vscode.commands.executeCommand('workbench.action.chat.open', {
        query: turn.user_optimized,
        isPartialQuery: true,
      });
      qp.hide();
    }
  });

  qp.onDidAccept(async () => {
    const picked = qp.selectedItems[0];
    if (picked) { await openDiff(picked.turn); }
    qp.hide();
  });

  qp.onDidHide(() => qp.dispose());
  qp.show();
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
    `Prompt Optimizer: original ↔ optimized (${when})`,
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
