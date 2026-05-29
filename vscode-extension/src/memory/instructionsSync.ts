import * as vscode from 'vscode';

import { runEngineRaw } from '../engine/runner';
import { getDbPath } from '../state/config';
import { computeWorkspaceId } from '../util/workspace';

/**
 * Debounced synchronizer for `.github/copilot-instructions.md`.  Hooks
 * `onDidSaveTextDocument` so that whenever the user edits a memory-bearing
 * file (AGENTS.md, CLAUDE.md, .promptoptimizer/memory.md, etc.) the
 * managed block inside copilot-instructions.md is regenerated.  This is
 * what makes Copilot itself see Prompt Optimizer memory without the user
 * having to install any tool.
 *
 * Delegates the actual write to the engine CLI to keep the writer logic
 * in a single (engine-side) place.
 */

const DEBOUNCE_MS = 1500;

const MEMORY_FILE_NAMES = new Set([
  'memory.md', 'knowledge.md', 'AGENTS.md', 'CLAUDE.md', 'CLAUDE.local.md',
  '.cursorrules', '.clinerules',
]);

export function registerCopilotInstructionsSync(context: vscode.ExtensionContext): void {
  let pendingTimer: NodeJS.Timeout | undefined;

  const trigger = (workspaceRoot: string) => {
    if (pendingTimer) { clearTimeout(pendingTimer); }
    pendingTimer = setTimeout(() => {
      pendingTimer = undefined;
      void runSync(context, workspaceRoot);
    }, DEBOUNCE_MS);
  };

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const base = doc.fileName.split(/[\\/]/).pop() ?? '';
      if (!MEMORY_FILE_NAMES.has(base)) { return; }
      const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!wsRoot) { return; }
      trigger(wsRoot);
    }),
    {
      dispose: () => {
        if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = undefined; }
      },
    },
  );

  // Also register an explicit command so users can force a refresh.
  context.subscriptions.push(
    vscode.commands.registerCommand('prompt-proxy.syncCopilotInstructions', async () => {
      const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!wsRoot) {
        await vscode.window.showWarningMessage('Prompt Optimizer: open a workspace first.');
        return;
      }
      const report = await runSync(context, wsRoot);
      if (report?.ok) {
        vscode.window.setStatusBarMessage(
          `$(check) Prompt Optimizer: ${report.changed ? 'updated' : 'verified'} ${report.path}`,
          4000,
        );
      }
    }),
  );
}

async function runSync(
  context: vscode.ExtensionContext,
  workspaceRoot: string,
): Promise<{ ok: boolean; path: string; changed: boolean } | undefined> {
  const dbPath = getDbPath(context);
  const wsId = computeWorkspaceId(workspaceRoot);
  try {
    const raw = runEngineRaw([
      '--sync-copilot-instructions',
      '--workspace-root', workspaceRoot,
      '--workspace', wsId,
      '--db', dbPath,
    ]);
    return JSON.parse(raw);
  } catch (error) {
    // Non-fatal — log to the extension console only.
    console.warn('[prompt-optimizer] copilot-instructions sync failed:', error);
    return undefined;
  }
}
