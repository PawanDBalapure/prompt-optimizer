import * as vscode from 'vscode';

import type { PromptProxyViewProvider } from '../panel/PromptProxyViewProvider';
import { getLastAnalysis } from '../state/session';
import { commitPrompt, getGraph } from '../state/versions';
import { createBranchCommand, switchBranchCommand, workspaceId } from './versionsBranches';
import { showLogCommand } from './versionsLog';

/**
 * Git-style prompt versioning UI: commit, log, checkout, branch, tag,
 * diff, delete.  All commands work against the per-workspace version
 * graph in `state/versions.ts`.
 *
 * A panel reference is required so the `checkout` flow can push the
 * restored prompt back into the webview input box (the equivalent of
 * `git checkout <sha>` updating the working tree).
 */
export function registerVersionCommands(
  context: vscode.ExtensionContext,
  provider: PromptProxyViewProvider,
): void {
  const push = (d: vscode.Disposable) => context.subscriptions.push(d);

  push(vscode.commands.registerCommand(
    'prompt-proxy.commitPrompt',
    (args?: { prompt?: string; optimized?: string }) => commitCommand(context, provider, args),
  ));
  push(vscode.commands.registerCommand(
    'prompt-proxy.showPromptLog',
    () => showLogCommand(context, provider, () => commitCommand(context, provider)),
  ));
  push(vscode.commands.registerCommand(
    'prompt-proxy.createPromptBranch',
    () => createBranchCommand(context),
  ));
  push(vscode.commands.registerCommand(
    'prompt-proxy.switchPromptBranch',
    () => switchBranchCommand(context, provider),
  ));
}

async function commitCommand(
  context: vscode.ExtensionContext,
  provider: PromptProxyViewProvider,
  args?: { prompt?: string; optimized?: string },
): Promise<void> {
  const lastAnalysis = getLastAnalysis(context);
  const prompt = (args?.prompt ?? lastAnalysis?.original ?? '').trim();
  if (!prompt) {
    vscode.window.showWarningMessage(
      'Nothing to commit yet — run a prompt from the panel first, then try again.',
    );
    return;
  }
  const optimized = args?.optimized ?? lastAnalysis?.optimized;

  const wsId = workspaceId();
  const graph = getGraph(context, wsId);
  const branch = graph.currentBranch || 'main';
  const headSha = graph.head ? graph.head.slice(0, 7) : '(no parent)';

  const message = await vscode.window.showInputBox({
    title: `Commit prompt on ${branch} (parent: ${headSha})`,
    prompt: 'Commit message (Git-style — short, imperative, present tense).',
    placeHolder: 'e.g. Tighten auth refactor prompt; mention 401 case',
    validateInput: (v) => (v && v.trim().length > 0 ? undefined : 'Message is required.'),
  });
  if (!message) { return; }

  try {
    const commit = await commitPrompt(context, wsId, { prompt, optimized, message });
    vscode.window.setStatusBarMessage(
      `$(check) Prompt committed · ${commit.sha} on ${commit.branch}`,
      4000,
    );
    provider.notifyVersionsChanged?.();
  } catch (err) {
    vscode.window.showErrorMessage(
      `Commit failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
