import * as vscode from 'vscode';

import { openChatWithPrompt } from './open';
import { getLastAnalysis } from '../state/session';
import { clearPendingOptimization, getPendingOptimization } from '../state/pending';

/** Register clipboard/send/pending-prompt lifecycle commands. */
export function registerPendingPromptCommands(context: vscode.ExtensionContext): void {
  const push = (d: vscode.Disposable) => context.subscriptions.push(d);

  push(vscode.commands.registerCommand('prompt-proxy.copyPrompt', async (prompt?: string) => {
    const text = prompt ?? getLastAnalysis(context)?.optimized;
    if (!text) {
      vscode.window.showWarningMessage('No optimized prompt is available yet.');
      return;
    }
    await vscode.env.clipboard.writeText(text);
    vscode.window.showInformationMessage('Prompt Optimizer copied the optimized prompt to the clipboard.');
  }));

  push(vscode.commands.registerCommand('prompt-proxy.sendPromptToChat', async (prompt?: string) => {
    const text = prompt ?? getLastAnalysis(context)?.optimized;
    if (!text) {
      vscode.window.showWarningMessage('No optimized prompt is available yet.');
      return;
    }
    await openChatWithPrompt(text, false);
  }));

  // Confirms the most recent pending optimized prompt and forwards it to
  // Copilot via the chat participant (`/send` auto-submitted).
  push(vscode.commands.registerCommand('prompt-proxy.confirmAndSend', async (pendingId?: string) => {
    const pending = getPendingOptimization(context);
    if (!pending) {
      vscode.window.showWarningMessage('No pending optimized prompt to send. Run @promptoptimizer first.');
      return;
    }
    if (pendingId && pending.id !== pendingId) {
      // The user clicked an older confirmation card after a newer one was created.
      vscode.window.showWarningMessage(
        'A newer optimized prompt is pending. Use the most recent confirmation card.',
      );
      return;
    }
    await vscode.commands.executeCommand('workbench.action.chat.open', {
      query: '@promptoptimizer /send',
      isPartialQuery: false,
    });
  }));

  // Opens the chat with the optimized prompt prefilled (no auto-submit) so
  // the user can edit it before sending.
  push(vscode.commands.registerCommand('prompt-proxy.editPendingPrompt', async (pendingId?: string) => {
    const pending = getPendingOptimization(context);
    if (!pending) {
      vscode.window.showWarningMessage('No pending optimized prompt to edit.');
      return;
    }
    if (pendingId && pending.id !== pendingId) {
      vscode.window.showWarningMessage('A newer optimized prompt is pending.');
      return;
    }
    clearPendingOptimization(context);
    await openChatWithPrompt(pending.optimized, true, false);
  }));

  push(vscode.commands.registerCommand('prompt-proxy.cancelPending', async (_pendingId?: string) => {
    clearPendingOptimization(context);
    vscode.window.showInformationMessage('Prompt Optimizer: pending optimized prompt discarded.');
  }));
}
