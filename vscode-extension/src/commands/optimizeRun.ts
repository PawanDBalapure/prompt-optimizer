import * as vscode from 'vscode';

import { analyzePrompt } from '../chat/analyzer';
import { openChatWithPrompt, openPromptProxyPanel } from './open';
import { maybeAutoOpenContextFiles } from './openContextFiles';
import { describeSource, pickPromptSource } from './promptSource';
import type { PromptProxyViewProvider } from '../panel/PromptProxyViewProvider';
import { getCurrentMode, updateStatusBarItem } from '../state/mode';
import type { PromptProxyPanelState } from '../types';
import { formatCurrency } from '../util/format';

/** Post-optimize toast with send / diff / panel / copy follow-ups. */
async function showResultActions(
  source: string,
  state: PromptProxyPanelState,
  summary: string,
  autoOpenChat: boolean,
): Promise<void> {
  const SEND = autoOpenChat ? 'Reopen Chat' : 'Send to Copilot Chat';
  const saved = state.metrics.tokens_saved;
  const cost = formatCurrency(state.metrics.estimated_cost_usd);
  const choice = await vscode.window.showInformationMessage(summary, SEND, 'Show diff', 'Open Panel', 'Copy again');
  if (choice === SEND) {
    await openChatWithPrompt(state.optimized, false);
  } else if (choice === 'Show diff') {
    const original = await vscode.workspace.openTextDocument({ content: source, language: 'markdown' });
    const optimized = await vscode.workspace.openTextDocument({ content: state.optimized, language: 'markdown' });
    await vscode.commands.executeCommand(
      'vscode.diff', original.uri, optimized.uri,
      `Prompt Optimizer: original ↔ optimized (saved ${saved} tokens, ~${cost})`,
      { preview: true, viewColumn: vscode.ViewColumn.Active },
    );
  } else if (choice === 'Open Panel') {
    await vscode.commands.executeCommand('prompt-proxy.focusPanel');
  } else if (choice === 'Copy again') {
    await vscode.env.clipboard.writeText(state.optimized);
  }
}

/** The `prompt-proxy.optimizeChatPrompt` command body. */
export async function optimizeChatPromptCommand(
  context: vscode.ExtensionContext,
  provider: PromptProxyViewProvider,
  statusBarItem: vscode.StatusBarItem,
): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('promptProxy');
  const strategy = cfg.get<string>('optimize.sourcePicker') ?? 'ask';
  const autoOpenChat = cfg.get<boolean>('optimize.autoOpenChat') === true;

  const chosen = await pickPromptSource(strategy);
  if (!chosen) { return; }
  const source = chosen.text;
  const title = describeSource(chosen);

  // Spinning busy state for the duration of the optimize call.
  const originalText = statusBarItem.text;
  const originalCmd = statusBarItem.command;
  statusBarItem.text = '$(sync~spin) Optimizing…';
  statusBarItem.command = undefined;
  const restoreStatusBar = (): void => {
    statusBarItem.command = originalCmd;
    statusBarItem.text = originalText;
    updateStatusBarItem(statusBarItem, getCurrentMode(context));
  };

  try {
    const state = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Prompt Optimizer — optimizing ${title}…`,
        cancellable: true,
      },
      async (progress, token) => {
        progress.report({ message: 'Consulting local cache + workspace memory…' });
        const op = analyzePrompt(context, source, 'clipboard');
        const cancelled = new Promise<null>((resolve) => {
          token.onCancellationRequested(() => resolve(null));
        });
        const result = await Promise.race([op, cancelled]);
        if (!result) { throw new Error('Cancelled by user'); }
        return result;
      },
    );

    restoreStatusBar();
    provider.publishAnalysis(state);
    await maybeAutoOpenContextFiles(context, state);
    await vscode.env.clipboard.writeText(state.optimized);
    if (autoOpenChat) { await openChatWithPrompt(state.optimized, false); }

    const summary = `Optimized ${title} — saved ${state.metrics.tokens_saved} tokens `
      + `(~${formatCurrency(state.metrics.estimated_cost_usd)}). Already copied to clipboard.`;
    await showResultActions(source, state, summary, autoOpenChat);
  } catch (error) {
    restoreStatusBar();
    const message = error instanceof Error ? error.message : String(error);
    if (message === 'Cancelled by user') {
      vscode.window.setStatusBarMessage('$(circle-slash) Prompt Optimizer: cancelled', 3000);
      return;
    }
    const pick = await vscode.window.showErrorMessage(
      `Prompt Optimizer could not optimize: ${message}`, 'Retry', 'Open Panel',
    );
    if (pick === 'Retry') {
      await vscode.commands.executeCommand('prompt-proxy.optimizeChatPrompt');
    } else if (pick === 'Open Panel') {
      await vscode.commands.executeCommand('prompt-proxy.focusPanel');
    }
  }
}

/** The `prompt-proxy.optimizeClipboard` command body. */
export async function optimizeClipboardCommand(
  context: vscode.ExtensionContext,
  provider: PromptProxyViewProvider,
): Promise<void> {
  const clipboardText = (await vscode.env.clipboard.readText()).trim();
  if (!clipboardText) {
    vscode.window.showWarningMessage('Clipboard is empty.');
    return;
  }
  try {
    const state = await analyzePrompt(context, clipboardText, 'clipboard');
    provider.publishAnalysis(state);
    await maybeAutoOpenContextFiles(context, state);
    await openPromptProxyPanel();
    await vscode.env.clipboard.writeText(state.optimized);
    vscode.window.showInformationMessage(
      `Prompt Optimizer saved ${state.metrics.tokens_saved} tokens. Estimated cost ${formatCurrency(state.metrics.estimated_cost_usd)}.`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`Prompt Optimizer failed to optimize the clipboard prompt: ${message}`);
  }
}
