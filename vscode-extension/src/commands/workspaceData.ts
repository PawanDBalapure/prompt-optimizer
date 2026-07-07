import * as vscode from 'vscode';

import { runEngineRaw } from '../engine/runner';
import { getDbPath } from '../state/config';
import { computeWorkspaceId } from '../util/workspace';

/** Register the peer-workspace federation QuickPick command. */
export function registerPeerCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.commands.registerCommand('prompt-proxy.peerWorkspaces', async () => {
    const dbPath = getDbPath(context);
    const action = await vscode.window.showQuickPick(
      [
        { label: '$(list-unordered) List peer workspaces', value: 'list' },
        { label: '$(add) Add peer workspace', value: 'add' },
        { label: '$(trash) Remove peer workspace', value: 'remove' },
      ],
      { placeHolder: 'Peer workspaces — federate semantic cache across workspaces' },
    );
    if (!action) { return; }

    try {
      if (action.value === 'list') {
        const raw = runEngineRaw(['--peer-list', '--db', dbPath]);
        const parsed = JSON.parse(raw) as { peers?: Array<{ label: string; dbPath: string; enabled: boolean }> };
        const peers = parsed.peers ?? [];
        if (peers.length === 0) {
          vscode.window.showInformationMessage('No peer workspaces registered.');
          return;
        }
        const lines = peers.map((p) => `${p.enabled ? '$(check)' : '$(circle-slash)'} ${p.label} — ${p.dbPath}`);
        await vscode.window.showQuickPick(lines, { placeHolder: `${peers.length} peer(s) registered` });
        return;
      }

      if (action.value === 'add') {
        const label = await vscode.window.showInputBox({
          prompt: 'Label for peer workspace',
          validateInput: (v) => (v.trim().length === 0 ? 'Label is required' : null),
        });
        if (!label) { return; }
        const picked = await vscode.window.showOpenDialog({
          canSelectFiles: true,
          canSelectFolders: false,
          canSelectMany: false,
          filters: { 'SQLite database': ['db', 'sqlite', 'sqlite3'] },
          openLabel: 'Select peer cache database',
        });
        if (!picked || picked.length === 0) { return; }
        const raw = runEngineRaw(['--peer-add', '--label', label, '--peer-db', picked[0].fsPath, '--db', dbPath]);
        const result = JSON.parse(raw) as { ok: boolean; error?: string };
        if (result.ok) {
          vscode.window.showInformationMessage(`Peer "${label}" added.`);
        } else {
          vscode.window.showErrorMessage(`Add failed: ${result.error}`);
        }
        return;
      }

      if (action.value === 'remove') {
        const raw = runEngineRaw(['--peer-list', '--db', dbPath]);
        const parsed = JSON.parse(raw) as { peers?: Array<{ label: string; dbPath: string }> };
        const peers = parsed.peers ?? [];
        if (peers.length === 0) {
          vscode.window.showInformationMessage('No peer workspaces to remove.');
          return;
        }
        const choice = await vscode.window.showQuickPick(
          peers.map((p) => ({ label: p.label, description: p.dbPath, value: p.dbPath })),
          { placeHolder: 'Pick peer to remove' },
        );
        if (!choice) { return; }
        runEngineRaw(['--peer-remove', '--peer-db', choice.value, '--db', dbPath]);
        vscode.window.showInformationMessage(`Removed peer "${choice.label}".`);
      }
    } catch (err) {
      vscode.window.showErrorMessage(`Peer command failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }));
}

/** Register the studied-file digests QuickPick command. */
export function registerDigestCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.commands.registerCommand('prompt-proxy.fileDigests', async () => {
    const dbPath = getDbPath(context);
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const wsId = computeWorkspaceId(wsRoot);
    try {
      const statsRaw = runEngineRaw(['--digest-stats', '--workspace', wsId, '--db', dbPath]);
      const stats = JSON.parse(statsRaw) as { files: number; total_visits: number };
      const listRaw = runEngineRaw(['--digest-list', '--workspace', wsId, '--limit', '50', '--db', dbPath]);
      const rows = JSON.parse(listRaw) as Array<{ path: string; language: string; visitCount: number; summary: string }>;

      if (rows.length === 0) {
        const action = await vscode.window.showInformationMessage(
          `Studied files (workspace ${wsId}): 0. The optimizer records files the moment they appear in an optimization context.`,
          'Clear all',
        );
        if (action === 'Clear all') {
          runEngineRaw(['--digest-clear', '--workspace', wsId, '--db', dbPath]);
        }
        return;
      }

      const items = rows.map((row) => ({
        label: `$(file-code) ${row.path}`,
        description: `${row.language || '—'} · seen ${row.visitCount}x`,
        detail: row.summary?.trim() ? row.summary.slice(0, 160) : '(no summary)',
        path: row.path,
      }));
      items.push({
        label: '$(trash) Clear all studied-file digests for this workspace',
        description: `${stats.files} file(s) · ${stats.total_visits} visit(s)`,
        detail: 'Removes the cross-session "I have studied this file" memory. Cache and knowledge graph are not touched.',
        path: '__clear__',
      });

      const pick = await vscode.window.showQuickPick(items, {
        placeHolder: `${stats.files} studied file(s) — ${stats.total_visits} total visits`,
        matchOnDescription: true,
        matchOnDetail: true,
      });
      if (!pick) { return; }
      if (pick.path === '__clear__') {
        const confirm = await vscode.window.showWarningMessage(
          `Clear all ${stats.files} studied-file digest(s) for workspace ${wsId}?`,
          { modal: true },
          'Clear',
        );
        if (confirm !== 'Clear') { return; }
        runEngineRaw(['--digest-clear', '--workspace', wsId, '--db', dbPath]);
        vscode.window.showInformationMessage('Studied-file digests cleared for this workspace.');
        return;
      }
      if (wsRoot) {
        try {
          const fileUri = vscode.Uri.joinPath(vscode.Uri.file(wsRoot), pick.path);
          const doc = await vscode.workspace.openTextDocument(fileUri);
          await vscode.window.showTextDocument(doc);
        } catch {
          vscode.window.showWarningMessage(`Could not open ${pick.path} — it may have moved or been deleted.`);
        }
      }
    } catch (err) {
      vscode.window.showErrorMessage(`Studied files command failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }));
}
