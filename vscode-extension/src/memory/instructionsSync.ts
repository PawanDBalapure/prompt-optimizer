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
/** Per-workspace flag — set after the first successful bootstrap toast. */
const BOOTSTRAP_NOTIFIED_KEY = 'promptProxy.bootstrapInstructionsNotified';

const MEMORY_FILE_NAMES = new Set([
  'memory.md', 'knowledge.md', 'AGENTS.md', 'CLAUDE.md', 'CLAUDE.local.md',
  '.cursorrules', '.clinerules',
]);

interface SyncReport {
  ok: boolean;
  path: string;
  created: boolean;
  changed: boolean;
  entries_written?: number;
}

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

  // Bootstrap on activation: ensure `.github/copilot-instructions.md` exists
  // so the very first chat turn after install already has Prompt Optimizer
  // memory wired into Copilot.  Runs once per workspace, then notifies the
  // user with a one-time toast if the file (or the .github folder) had to
  // be created.
  void bootstrapInstructions(context);
}

async function bootstrapInstructions(context: vscode.ExtensionContext): Promise<void> {
  const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!wsRoot) { return; }
  // Defer slightly so activation isn't blocked on the engine subprocess.
  await new Promise((r) => setTimeout(r, 1200));
  const report = await runSync(context, wsRoot);
  if (!report?.ok || !report.created) { return; }

  const alreadyNotified = context.workspaceState.get<boolean>(BOOTSTRAP_NOTIFIED_KEY) === true;
  if (alreadyNotified) { return; }
  await context.workspaceState.update(BOOTSTRAP_NOTIFIED_KEY, true);

  const OPEN = 'Open file';
  const GUIDE = 'What is this?';
  const choice = await vscode.window.showInformationMessage(
    `Prompt Optimizer created \`.github/copilot-instructions.md\` so GitHub Copilot will automatically see your workspace memory on every chat turn. ${report.entries_written ?? 0} memory source(s) wired in.`,
    OPEN, GUIDE,
  );
  if (choice === OPEN) {
    const uri = vscode.Uri.file(report.path);
    await vscode.window.showTextDocument(uri, { preview: false });
  } else if (choice === GUIDE) {
    await vscode.commands.executeCommand('prompt-proxy.userGuide');
  }
}

async function runSync(
  context: vscode.ExtensionContext,
  workspaceRoot: string,
): Promise<SyncReport | undefined> {
  const dbPath = getDbPath(context);
  const wsId = computeWorkspaceId(workspaceRoot);
  try {
    const raw = runEngineRaw([
      '--sync-copilot-instructions',
      '--workspace-root', workspaceRoot,
      '--workspace', wsId,
      '--db', dbPath,
    ]);
    return JSON.parse(raw) as SyncReport;
  } catch (error) {
    // Non-fatal — log to the extension console only.
    console.warn('[prompt-optimizer] copilot-instructions sync failed:', error);
    return undefined;
  }
}
