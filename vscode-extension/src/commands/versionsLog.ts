import * as vscode from 'vscode';

import type { PromptProxyViewProvider } from '../panel/PromptProxyViewProvider';
import {
  checkout,
  deleteCommit,
  getGraph,
  logCommits,
  tagCommit,
  type PromptCommit,
  type WorkspaceVersionGraph,
} from '../state/versions';
import { createBranchCommand, openDiff, switchBranchCommand, workspaceId } from './versionsBranches';

interface LogItem extends vscode.QuickPickItem { commit: PromptCommit }

function previewPrompt(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 110 ? flat.slice(0, 109) + '…' : flat;
}

function formatRelative(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) { return `${s}s ago`; }
  if (s < 3600) { return `${Math.round(s / 60)}m ago`; }
  if (s < 86400) { return `${Math.round(s / 3600)}h ago`; }
  return `${Math.round(s / 86400)}d ago`;
}

/** Interactive Git-style prompt log QuickPick (checkout / diff / tag / delete). */
export async function showLogCommand(
  context: vscode.ExtensionContext,
  provider: PromptProxyViewProvider,
  onEmptyCommit: () => Promise<void>,
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
    if (pick === COMMIT) { await onEmptyCommit(); }
    return;
  }

  const checkoutBtn: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('history'), tooltip: 'Checkout — restore this prompt into the panel input' };
  const diffParentBtn: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('diff'), tooltip: 'Diff vs parent commit' };
  const diffHeadBtn: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('git-compare'), tooltip: 'Diff vs HEAD' };
  const tagBtn: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('tag'), tooltip: 'Add a tag to this commit' };
  const deleteBtn: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('trash'), tooltip: 'Delete this commit (children get re-parented)' };

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
  qp.title = `Prompt log · ${commits.length} commit(s) · on ${graph.currentBranch}${graph.head ? ' @ ' + graph.head.slice(0, 7) : ''}`;
  qp.placeholder = 'Type to filter · Enter to checkout · use the side icons for diff / tag / delete';
  qp.matchOnDescription = true;
  qp.matchOnDetail = true;
  qp.items = buildItems(graph);

  const newBranchBtn: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('git-branch'), tooltip: 'New branch from selected commit' };
  const switchBranchBtn: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('git-pull-request'), tooltip: 'Switch branch' };
  qp.buttons = [newBranchBtn, switchBranchBtn];

  const reload = (): void => {
    const fresh = getGraph(context, wsId);
    qp.title = `Prompt log · ${Object.keys(fresh.commits).length} commit(s) · on ${fresh.currentBranch}${fresh.head ? ' @ ' + fresh.head.slice(0, 7) : ''}`;
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
