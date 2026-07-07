import * as vscode from 'vscode';

import {
  maybeAutoOpenOnboarding,
  registerChatParticipant,
  registerPassiveListeners,
  startBackgroundIndexing,
} from './activation/background';
import { registerDatabaseCommands } from './commands/database';
import { registerHistoryCommand } from './commands/history';
import { registerManageAgentSkills } from './commands/manageAgentSkills';
import {
  openChatWithPrompt,
  openExtensionReadme,
  openOnboardingGuide,
  openPromptProxyPanel,
} from './commands/open';
import { optimizeChatPromptCommand, optimizeClipboardCommand } from './commands/optimizeRun';
import { registerPendingPromptCommands } from './commands/pendingPrompts';
import { registerResetCommand } from './commands/resetDefaults';
import { registerSkillCommands } from './commands/skills';
import { registerUserGuide } from './commands/userGuide';
import { registerVersionCommands } from './commands/versions';
import { registerDigestCommands, registerPeerCommands } from './commands/workspaceData';
import { registerWorkspaceMemoryCommands } from './commands/workspaceMemory';
import { registerMemoryFeatures } from './memory';
import { InstructionStudioPanel } from './panel/InstructionStudioPanel';
import { PromptProxyViewProvider } from './panel/PromptProxyViewProvider';
import { ProxyStatusPanel } from './panel/ProxyStatusPanel';
import { highlightStatusBarOnActivate } from './panel/welcomeHighlight';
import { getCurrentMode, setCurrentMode, updateStatusBarItem } from './state/mode';
import type { ProxyMode } from './types';
import { initErrorReporter, openSupportEmail, reportError } from './util/errorReporter';

interface ModeQuickPickItem extends vscode.QuickPickItem {
  value: ProxyMode;
}

function buildModeItems(current: ProxyMode): ModeQuickPickItem[] {
  return [
    {
      label: '$(wand) Optimize only',
      description: 'Show analysis, copy / send buttons — you control when it goes to Copilot',
      detail: current === 'optimize' ? '\u25CF Active' : undefined,
      value: 'optimize',
    },
    {
      label: '$(robot) Agent',
      description: 'Optimize + send the optimized prompt directly to Copilot Chat — no @promptoptimizer prefix needed',
      detail: current === 'agent' ? '\u25CF Active' : undefined,
      value: 'agent',
    },
    {
      label: '$(comment-discussion) Direct send',
      description: 'Pre-fill @promptoptimizer in the Chat panel and press Enter',
      detail: current === 'direct' ? '\u25CF Active' : undefined,
      value: 'direct',
    },
  ];
}

/** Small, cross-cutting commands that don't warrant their own module. */
function registerCoreCommands(
  context: vscode.ExtensionContext,
  provider: PromptProxyViewProvider,
  statusBarItem: vscode.StatusBarItem,
): void {
  const push = (d: vscode.Disposable) => context.subscriptions.push(d);

  push(vscode.commands.registerCommand('prompt-proxy.toggleStatusPanel', () => {
    ProxyStatusPanel.toggle(context, provider);
  }));

  push(vscode.commands.registerCommand('prompt-proxy.selectMode', async () => {
    const picked = await vscode.window.showQuickPick(
      buildModeItems(getCurrentMode(context)) as vscode.QuickPickItem[],
      { placeHolder: 'Select default Prompt Optimizer mode', matchOnDescription: true },
    ) as ModeQuickPickItem | undefined;
    if (!picked) { return; }
    await setCurrentMode(context, picked.value);
    updateStatusBarItem(statusBarItem, picked.value);
    provider.notifyModeChange(picked.value);
  }));

  push(vscode.commands.registerCommand('prompt-proxy.focusPanel', async () => {
    await openPromptProxyPanel();
  }));

  push(vscode.commands.registerCommand('prompt-proxy.startChat', async () => {
    await openChatWithPrompt('', true);
  }));

  push(vscode.commands.registerCommand('prompt-proxy.reportIssue', async () => {
    try {
      await openSupportEmail('User-initiated issue report');
    } catch (error) {
      void reportError('Could not open email composer.', error, { scope: 'reportIssue' });
    }
  }));

  push(vscode.commands.registerCommand('prompt-proxy.optimizeClipboard', () =>
    optimizeClipboardCommand(context, provider)));

  push(vscode.commands.registerCommand('prompt-proxy.optimizeChatPrompt', () =>
    optimizeChatPromptCommand(context, provider, statusBarItem)));

  push(vscode.commands.registerCommand('prompt-proxy.openReadme', async () => {
    await openExtensionReadme(context);
  }));

  push(vscode.commands.registerCommand('prompt-proxy.openOnboarding', async () => {
    await openOnboardingGuide(context);
  }));

  push(vscode.commands.registerCommand('prompt-proxy.openInstructionStudio', async () => {
    InstructionStudioPanel.show(context);
  }));
}

export function activate(context: vscode.ExtensionContext) {
  initErrorReporter(context);
  const provider = new PromptProxyViewProvider(context.extensionUri, context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(PromptProxyViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  updateStatusBarItem(statusBarItem, getCurrentMode(context));
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  registerCoreCommands(context, provider, statusBarItem);
  registerPendingPromptCommands(context);
  registerDatabaseCommands(context);
  registerWorkspaceMemoryCommands(context);
  registerPeerCommands(context);
  registerDigestCommands(context);
  registerSkillCommands(context);
  registerManageAgentSkills(context);
  registerResetCommand(context, provider);
  registerPassiveListeners(context, provider);
  // Phase A: LM tool + copilot-instructions auto-sync + (auto) global memory peer.
  registerMemoryFeatures(context);
  // Minimalist single-entrypoint user guide (Ctrl+Shift+P → "User Guide").
  registerUserGuide(context);
  // Prompt history browser (QuickPick with side-by-side diff button).
  registerHistoryCommand(context, provider);
  // Git-style prompt versioning: commit, log, branch, checkout, diff.
  registerVersionCommands(context, provider);
  // Briefly highlight the status-bar item on install / update / reload.
  highlightStatusBarOnActivate(context, statusBarItem);
  // Auto-open the onboarding guide on first install and after updates.
  void maybeAutoOpenOnboarding(context);

  registerChatParticipant(context, provider, statusBarItem);
  startBackgroundIndexing(context, provider);
}

export function deactivate() {
  // Best-effort: shut down the OCR worker if one was started.
  // Imported lazily to avoid loading tesseract.js when never used.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { disposeOcr } = require('./chat/ocr') as { disposeOcr: () => Promise<void> };
    void disposeOcr();
  } catch { /* ignore */ }
}
