import * as vscode from 'vscode';

import type { PromptProxyViewProvider } from '../panel/PromptProxyViewProvider';
import { checkout, createBranch, deleteBranch, getGraph } from '../state/versions';
import { computeWorkspaceId } from '../util/workspace';

export function workspaceId(): string {
  const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return computeWorkspaceId(wsRoot);
}

export async function openDiff(a: string, b: string, title: string): Promise<void> {
  const left = await vscode.workspace.openTextDocument({ content: a, language: 'markdown' });
  const right = await vscode.workspace.openTextDocument({ content: b, language: 'markdown' });
  await vscode.commands.executeCommand('vscode.diff', left.uri, right.uri, `Prompt diff · ${title}`, {
    preview: true,
    viewColumn: vscode.ViewColumn.Active,
  });
}

export async function createBranchCommand(
  context: vscode.ExtensionContext,
  fromSha?: string,
): Promise<void> {
  const wsId = workspaceId();
  const graph = getGraph(context, wsId);
  if (!graph.head) {
    vscode.window.showWarningMessage('Cannot create a branch: no commits yet.');
    return;
  }
  const name = await vscode.window.showInputBox({
    title: `New branch from ${fromSha ?? graph.head}`,
    prompt: 'Branch name (Git-style: lowercase, hyphens/slashes, no spaces).',
    placeHolder: 'e.g. experiment/strict-tone',
    validateInput: (v) => {
      const s = (v ?? '').trim();
      if (!s) { return 'Required.'; }
      if (!/^[A-Za-z0-9][A-Za-z0-9._\-/]{0,60}$/.test(s)) { return 'Use letters, digits, ./-/_ and slashes.'; }
      if (graph.branches[s]) { return `Branch "${s}" already exists.`; }
      return undefined;
    },
  });
  if (!name) { return; }
  try {
    await createBranch(context, wsId, name.trim(), fromSha);
    vscode.window.setStatusBarMessage(`$(git-branch) Switched to new branch ${name.trim()}`, 3000);
  } catch (err) {
    vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
  }
}

export async function switchBranchCommand(
  context: vscode.ExtensionContext,
  provider: PromptProxyViewProvider,
): Promise<void> {
  const wsId = workspaceId();
  const graph = getGraph(context, wsId);
  const names = Object.keys(graph.branches).sort();
  if (names.length === 0) {
    vscode.window.showInformationMessage('No branches yet. Commit a prompt first to create "main".');
    return;
  }
  const DELETE_PREFIX = '$(trash) Delete branch ';
  const items: vscode.QuickPickItem[] = names.map((n) => {
    const isCurrent = n === graph.currentBranch;
    const tip = graph.commits[graph.branches[n]];
    return {
      label: `${isCurrent ? '$(check)' : '$(git-branch)'} ${n}`,
      description: tip ? `${tip.sha} · ${tip.message}` : '(empty)',
      detail: isCurrent ? 'current branch' : undefined,
    };
  });
  for (const n of names) {
    if (n !== 'main') {
      items.push({ label: `${DELETE_PREFIX}${n}`, description: 'Removes the ref; commits stay if reachable from elsewhere.' });
    }
  }
  const pick = await vscode.window.showQuickPick(items, {
    title: 'Switch prompt branch',
    placeHolder: 'Pick a branch to switch to, or a delete action.',
  });
  if (!pick) { return; }
  if (pick.label.startsWith(DELETE_PREFIX)) {
    const name = pick.label.slice(DELETE_PREFIX.length);
    try {
      await deleteBranch(context, wsId, name);
      vscode.window.setStatusBarMessage(`$(check) Deleted branch ${name}`, 3000);
    } catch (err) {
      vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
    }
    return;
  }
  const targetName = pick.label.replace(/^\$\([^)]+\)\s*/, '').trim();
  const sha = graph.branches[targetName];
  if (!sha) { return; }
  const restored = await checkout(context, wsId, sha);
  if (restored) {
    provider.restorePromptInPanel?.(restored.prompt);
    vscode.window.setStatusBarMessage(`$(git-branch) Switched to ${targetName}`, 3000);
  }
}
