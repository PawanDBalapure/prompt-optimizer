import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { runEngineRaw } from '../engine/runner';
import type { PromptProxyViewProvider } from '../panel/PromptProxyViewProvider';
import { getDbPath } from '../state/config';
import { clearConversationForWorkspace } from '../state/conversation';
import { resetSettingsToDefault } from '../state/userCustomizations';
import { computeWorkspaceId } from '../util/workspace';

type ResetItem = vscode.QuickPickItem & { value: string };

const RESET_ITEMS: ResetItem[] = [
  {
    label: '$(settings-gear) Settings',
    description: 'Revert all Prompt Optimizer settings to their defaults',
    value: 'settings',
    picked: true,
  },
  {
    label: '$(database) Semantic cache',
    description: 'Clear the local semantic cache database',
    value: 'cache',
  },
  {
    label: '$(comment-discussion) Conversation memory',
    description: 'Clear stored conversation history for this workspace',
    value: 'conversation',
  },
  {
    label: '$(circuit-board) Knowledge graph',
    description: 'Reset the workspace knowledge-graph node/edge counts to zero',
    value: 'graph',
  },
  {
    label: '$(robot) Custom agents',
    description: 'Delete user-created agents in .promptoptimizer/skills',
    value: 'agents',
  },
];

/** Delete user-created (non-bundled) agent files; returns how many were removed. */
function removeCustomAgents(extensionPath: string, wsRoot: string): number {
  const skillsDir = path.join(wsRoot, '.promptoptimizer', 'skills');
  if (!fs.existsSync(skillsDir)) { return 0; }
  const libDir = path.join(extensionPath, 'media', 'skill-library');
  const bundled = new Set(
    fs.existsSync(libDir)
      ? fs.readdirSync(libDir).filter((f) => /\.md$/i.test(f)).map((f) => f.toLowerCase())
      : [],
  );
  let removed = 0;
  for (const file of fs.readdirSync(skillsDir).filter((f) => /\.md$/i.test(f))) {
    // Only delete user-created agents — leave enabled bundled copies.
    if (bundled.has(file.toLowerCase())) { continue; }
    fs.unlinkSync(path.join(skillsDir, file));
    removed++;
  }
  return removed;
}

/**
 * Register the opt-in, multi-select reset command. Nothing here runs
 * automatically — surfaces only change when the user ticks them explicitly.
 */
export function registerResetCommand(
  context: vscode.ExtensionContext,
  provider: PromptProxyViewProvider,
): void {
  context.subscriptions.push(vscode.commands.registerCommand('prompt-proxy.resetToDefaults', async () => {
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const picks = await vscode.window.showQuickPick(RESET_ITEMS, {
      canPickMany: true,
      title: 'Reset Prompt Optimizer to defaults',
      placeHolder: 'Tick what to reset — nothing is changed until you confirm',
    });
    if (!picks || picks.length === 0) { return; }

    const chosen = new Set(picks.map((p) => p.value));
    const confirm = await vscode.window.showWarningMessage(
      `Reset ${picks.length} item(s) to defaults? This cannot be undone.`,
      { modal: true },
      'Reset',
    );
    if (confirm !== 'Reset') { return; }

    const done: string[] = [];
    const warn = (label: string, err: unknown): void => {
      vscode.window.showWarningMessage(`${label} failed: ${err instanceof Error ? err.message : String(err)}`);
    };

    if (chosen.has('settings')) {
      try { await resetSettingsToDefault(); done.push('settings'); }
      catch (err) { warn('Settings reset', err); }
    }
    if (chosen.has('cache')) {
      try { runEngineRaw(['--clear-cache', '--db', getDbPath(context)]); done.push('cache'); }
      catch (err) { warn('Cache reset', err); }
    }
    if (chosen.has('conversation')) {
      try {
        await clearConversationForWorkspace(context, computeWorkspaceId(wsRoot));
        done.push('conversation memory');
      } catch (err) { warn('Conversation reset', err); }
    }
    if (chosen.has('graph')) {
      try {
        runEngineRaw(['--reset-graph', '--workspace', computeWorkspaceId(wsRoot), '--db', getDbPath(context)]);
        done.push('knowledge graph');
      } catch (err) { warn('Graph reset', err); }
    }
    if (chosen.has('agents')) {
      if (!wsRoot) {
        vscode.window.showWarningMessage('No workspace folder open — skipped custom agent reset.');
      } else {
        try { done.push(`${removeCustomAgents(context.extensionPath, wsRoot)} custom agent(s)`); }
        catch (err) { warn('Agent reset', err); }
      }
    }

    if (done.length > 0) {
      provider.refreshStatusOverview();
      vscode.window.showInformationMessage(`Prompt Optimizer reset: ${done.join(', ')}.`);
    }
  }));
}
