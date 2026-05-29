import * as vscode from 'vscode';

import { computeWorkspaceId } from '../util/workspace';
import { getLastAnalysis } from '../state/session';
import {
  commitPrompt,
  checkout,
  createBranch,
  deleteBranch,
  tagCommit,
  deleteCommit,
  getGraph,
  logCommits,
  type PromptCommit,
  type WorkspaceVersionGraph,
} from '../state/versions';
import type { PromptProxyViewProvider } from '../panel/PromptProxyViewProvider';

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
    () => showLogCommand(context, provider),
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

function workspaceId(): string {
  const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return computeWorkspaceId(wsRoot);
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

interface LogItem extends vscode.QuickPickItem { commit: PromptCommit }

async function showLogCommand(
  context: vscode.ExtensionContext,
  provider: PromptProxyViewProvider,
): Promise<void> {
  const wsId = workspaceId();
  const graph = getGraph(context, wsId);
  const commits = logCommits(graph);
  if (commits.length === 0) {
    const COMMIT = 'Commit current prompt';
    const pick = await vscode.window.showInformationMessage(
      'No prompt commits yet for this workspace. Run a prompt, then commit it to start a history.',
      COMMIT,
    );
    if (pick === COMMIT) { await commitCommand(context, provider); }
    return;
  }

  const checkoutBtn: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('history'), tooltip: 'Checkout — restore this prompt into the panel input' };
  const diffParentBtn: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('diff'),    tooltip: 'Diff vs parent commit' };
  const diffHeadBtn:   vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('git-compare'), tooltip: 'Diff vs HEAD' };
  const tagBtn:        vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('tag'),     tooltip: 'Add a tag to this commit' };
  const deleteBtn:     vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('trash'),   tooltip: 'Delete this commit (children get re-parented)' };

  const refsAt = (sha: string): string => {
    const labels: string[] = [];
    for (const [branch, refSha] of Object.entries(graph.branches)) {
      if (refSha === sha) { labels.push(branch === graph.currentBranch ? `HEAD → ${branch}` : branch); }
    }
    const commit = graph.commits[sha];
    if (commit?.tags?.length) { labels.push(...commit.tags.map((t) => `tag:${t}`)); }
    return labels.length ? ` (${labels.join(', ')})` : '';
  };

  const buildItems = (g: WorkspaceVersionGraph): LogItem[] => logCommits(g).map((c) => ({
    label: `$(git-commit) ${c.sha}${refsAt(c.sha)}  ${c.message}`,
    description: `${c.author} · ${formatRelative(c.timestamp)}`,
    detail: previewPrompt(c.prompt),
    buttons: [checkoutBtn, diffParentBtn, diffHeadBtn, tagBtn, deleteBtn],
    commit: c,
  }));

  const qp = vscode.window.createQuickPick<LogItem>();
  qp.title = `Prompt log · ${commits.length} commit(s) · on ${graph.currentBranch}${graph.head ? ' @ ' + graph.head.slice(0,7) : ''}`;
  qp.placeholder = 'Type to filter · Enter to checkout · use the side icons for diff / tag / delete';
  qp.matchOnDescription = true;
  qp.matchOnDetail = true;
  qp.items = buildItems(graph);

  const newBranchBtn: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('git-branch'), tooltip: 'New branch from selected commit' };
  const switchBranchBtn: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('git-pull-request'), tooltip: 'Switch branch' };
  qp.buttons = [newBranchBtn, switchBranchBtn];

  const reload = (): void => {
    const fresh = getGraph(context, wsId);
    qp.title = `Prompt log · ${Object.keys(fresh.commits).length} commit(s) · on ${fresh.currentBranch}${fresh.head ? ' @ ' + fresh.head.slice(0,7) : ''}`;
    qp.items = buildItems(fresh);
  };

  qp.onDidTriggerButton(async (btn) => {
    if (btn === newBranchBtn) {
      const selected = qp.activeItems[0]?.commit?.sha;
      qp.hide();
      await createBranchCommand(context, selected);
      void vscode.commands.executeCommand('prompt-proxy.showPromptLog');
    } else if (btn === switchBranchBtn) {
      qp.hide();
      await switchBranchCommand(context, provider);
      void vscode.commands.executeCommand('prompt-proxy.showPromptLog');
    }
  });

  qp.onDidTriggerItemButton(async (ev) => {
    const commit = ev.item.commit;
    try {
      if (ev.button === checkoutBtn) {
        const restored = await checkout(context, wsId, commit.sha);
        if (restored) {
          provider.restorePromptInPanel?.(restored.prompt);
          vscode.window.setStatusBarMessage(`$(check) Checked out ${commit.sha}`, 3000);
        }
        qp.hide();
      } else if (ev.button === diffParentBtn) {
        const parent = commit.parent ? getGraph(context, wsId).commits[commit.parent] : undefined;
        await openDiff(parent?.prompt ?? '', commit.prompt, `parent ${parent?.sha ?? '∅'} ↔ ${commit.sha}`);
      } else if (ev.button === diffHeadBtn) {
        const fresh = getGraph(context, wsId);
        const head = fresh.head ? fresh.commits[fresh.head] : undefined;
        if (!head) { vscode.window.showWarningMessage('No HEAD commit set.'); return; }
        await openDiff(head.prompt, commit.prompt, `HEAD ${head.sha} ↔ ${commit.sha}`);
      } else if (ev.button === tagBtn) {
        const tag = await vscode.window.showInputBox({
          title: `Tag commit ${commit.sha}`,
          prompt: 'Lightweight tag (e.g. v1, baseline, prod-prompt).',
          validateInput: (v) => (v && /^[A-Za-z0-9._-]{1,40}$/.test(v.trim()) ? undefined : 'Use letters, digits, dot, underscore, hyphen (1–40).'),
        });
        if (tag) { await tagCommit(context, wsId, commit.sha, tag.trim()); reload(); }
      } else if (ev.button === deleteBtn) {
        const YES = `Delete ${commit.sha}`;
        const pick = await vscode.window.showWarningMessage(
          `Delete commit ${commit.sha} "${commit.message}"? Children will be re-parented.`,
          { modal: true }, YES,
        );
        if (pick === YES) { await deleteCommit(context, wsId, commit.sha); reload(); }
      }
    } catch (err) {
      vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
    }
  });

  qp.onDidAccept(async () => {
    const picked = qp.selectedItems[0];
    if (!picked) { qp.hide(); return; }
    const restored = await checkout(context, wsId, picked.commit.sha);
    if (restored) {
      provider.restorePromptInPanel?.(restored.prompt);
      vscode.window.setStatusBarMessage(`$(check) Checked out ${picked.commit.sha}`, 3000);
    }
    qp.hide();
  });
  qp.onDidHide(() => qp.dispose());
  qp.show();
}

async function createBranchCommand(
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

async function switchBranchCommand(
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
  const pick = await vscode.window.showQuickPick(items, { title: 'Switch prompt branch', placeHolder: 'Pick a branch to switch to, or a delete action.' });
  if (!pick) { return; }
  if (pick.label.startsWith(DELETE_PREFIX)) {
    const name = pick.label.slice(DELETE_PREFIX.length);
    try { await deleteBranch(context, wsId, name); vscode.window.setStatusBarMessage(`$(check) Deleted branch ${name}`, 3000); }
    catch (err) { vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err)); }
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

async function openDiff(a: string, b: string, title: string): Promise<void> {
  const left  = await vscode.workspace.openTextDocument({ content: a, language: 'markdown' });
  const right = await vscode.workspace.openTextDocument({ content: b, language: 'markdown' });
  await vscode.commands.executeCommand('vscode.diff', left.uri, right.uri, `Prompt diff · ${title}`, {
    preview: true,
    viewColumn: vscode.ViewColumn.Active,
  });
}

function previewPrompt(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 110 ? flat.slice(0, 109) + '…' : flat;
}

function formatRelative(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60)        { return `${s}s ago`; }
  if (s < 3600)      { return `${Math.round(s / 60)}m ago`; }
  if (s < 86400)     { return `${Math.round(s / 3600)}h ago`; }
  return `${Math.round(s / 86400)}d ago`;
}
