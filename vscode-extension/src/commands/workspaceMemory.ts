import * as vscode from 'vscode';

import { openContextFilesAndSelect } from './openContextFiles';
import { runEngineRaw } from '../engine/runner';
import { getDbPath } from '../state/config';
import { clearConversationForWorkspace } from '../state/conversation';
import { computeWorkspaceId } from '../util/workspace';

const MEMORY_SEED =
  '# Prompt Optimizer workspace memory\n\n' +
  'Notes here are automatically included as long-lived context for every optimization.\n' +
  'Keep it concise — bullet points and short paragraphs work best.\n\n' +
  '- Stack: \n- Conventions: \n- Things to avoid: \n';

/** Register workspace memory / context-file commands. */
export function registerWorkspaceMemoryCommands(context: vscode.ExtensionContext): void {
  const push = (d: vscode.Disposable) => context.subscriptions.push(d);

  push(vscode.commands.registerCommand('prompt-proxy.clearMemory', async () => {
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    await clearConversationForWorkspace(context, computeWorkspaceId(wsRoot));
    vscode.window.showInformationMessage('Prompt Optimizer conversation memory cleared.');
  }));

  push(vscode.commands.registerCommand('prompt-proxy.openMemoryFile', async () => {
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!wsRoot) {
      vscode.window.showWarningMessage('Open a workspace folder first.');
      return;
    }
    const memoryUri = vscode.Uri.joinPath(vscode.Uri.file(wsRoot), '.promptoptimizer', 'memory.md');
    try {
      await vscode.workspace.fs.stat(memoryUri);
    } catch {
      try {
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(vscode.Uri.file(wsRoot), '.promptoptimizer'));
        await vscode.workspace.fs.writeFile(memoryUri, new TextEncoder().encode(MEMORY_SEED));
      } catch (err) {
        vscode.window.showErrorMessage(`Could not create memory file: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
    }
    const doc = await vscode.workspace.openTextDocument(memoryUri);
    await vscode.window.showTextDocument(doc);
  }));

  push(vscode.commands.registerCommand('prompt-proxy.openContextFiles', async () => {
    await openContextFilesAndSelect(context);
  }));

  push(vscode.commands.registerCommand('prompt-proxy.toggleAutoOpenContextFiles', async () => {
    const cfg = vscode.workspace.getConfiguration('promptProxy');
    const next = !cfg.get<boolean>('optimize.autoOpenContextFiles', false);
    await cfg.update('optimize.autoOpenContextFiles', next, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage(
      `Prompt Optimizer: auto-open context files ${next ? 'enabled' : 'disabled'}.`,
    );
  }));

  push(vscode.commands.registerCommand('prompt-proxy.knowledgeGraphStats', async () => {
    try {
      const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const wsId = computeWorkspaceId(wsRoot);
      const raw = runEngineRaw(['--kg-stats', '--workspace', wsId, '--db', getDbPath(context)]);
      const stats = JSON.parse(raw) as { nodes: number; edges: number };
      vscode.window.showInformationMessage(
        `Knowledge graph (workspace ${wsId}): ${stats.nodes} node(s), ${stats.edges} edge(s).`,
      );
    } catch (err) {
      vscode.window.showErrorMessage(`KG stats failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }));
}
