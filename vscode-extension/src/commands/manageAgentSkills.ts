import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

import {
  applySkillSelections,
  loadLibraryEntries,
  mergeCustomEntries,
  newAgentTemplate,
  type LibEntry,
} from './skillLibrary';

type AgentItem = vscode.QuickPickItem & { entry: LibEntry };

/** Prompt for id + label, write the template, and open the new agent file. */
async function createCustomAgent(entries: LibEntry[], targetDir: string): Promise<void> {
  const idRaw = await vscode.window.showInputBox({
    title: 'New agent — id',
    prompt: 'Short slug used as filename and /command (lowercase, hyphens).',
    placeHolder: 'e.g. release-notes-writer',
    validateInput: (v) => {
      const s = (v ?? '').trim();
      if (!s) { return 'Required.'; }
      if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(s)) { return 'Use lowercase letters, digits, and hyphens (2–41 chars).'; }
      if (entries.some((e) => e.id === s)) { return `An agent with id "${s}" already exists.`; }
      return undefined;
    },
  });
  const id = (idRaw ?? '').trim();
  if (!id) { return; }
  const label = (await vscode.window.showInputBox({
    title: 'New agent — display label',
    prompt: 'Human-friendly name shown in the picker.',
    placeHolder: 'e.g. Release Notes Writer',
    value: id.split('-').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(' '),
  }))?.trim() || id;

  const targetPath = path.join(targetDir, `${id}.md`);
  try {
    fs.writeFileSync(targetPath, newAgentTemplate(id, label), { encoding: 'utf8', flag: 'wx' });
  } catch (err) {
    vscode.window.showErrorMessage(
      `Could not create agent "${id}": ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }
  entries.push({ id, label, readOnly: false, tags: ['custom'], libPath: targetPath, targetPath, installed: true });
  entries.sort((a, b) => a.id.localeCompare(b.id));
  try {
    const doc = await vscode.workspace.openTextDocument(targetPath);
    await vscode.window.showTextDocument(doc, { preview: false });
  } catch { /* non-fatal */ }
  vscode.window.showInformationMessage(
    `Created agent "${id}". Edit the file then re-run a prompt — skills hot-reload.`,
  );
  // Reopen the manage panel with the new entry visible & ticked.
  void vscode.commands.executeCommand('prompt-proxy.manageAgentSkills');
}

/** Register the multi-select manage-SDLC-agent-skills QuickPick. */
export function registerManageAgentSkills(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.commands.registerCommand('prompt-proxy.manageAgentSkills', async () => {
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!wsRoot) {
      vscode.window.showWarningMessage('Open a workspace folder first to enable agent skills.');
      return;
    }
    const libDir = path.join(context.extensionPath, 'media', 'skill-library');
    if (!fs.existsSync(libDir)) {
      vscode.window.showErrorMessage('Bundled skill library is missing from the extension package.');
      return;
    }
    const targetDir = path.join(wsRoot, '.promptoptimizer', 'skills');
    fs.mkdirSync(targetDir, { recursive: true });

    const entries = loadLibraryEntries(libDir, targetDir);
    mergeCustomEntries(entries, targetDir);

    const editButton: vscode.QuickInputButton = {
      iconPath: new vscode.ThemeIcon('edit'),
      tooltip: 'Edit this agent definition (enables it first if needed)',
    };
    const resetButton: vscode.QuickInputButton = {
      iconPath: new vscode.ThemeIcon('discard'),
      tooltip: 'Reset to the bundled default (overwrites local edits)',
    };
    const newButton: vscode.QuickInputButton = {
      iconPath: new vscode.ThemeIcon('add'),
      tooltip: 'Create a new custom agent in this workspace',
    };
    const buildItem = (e: LibEntry): AgentItem => ({
      label: `${e.installed ? '$(check)' : '$(circle-outline)'} /${e.id}`,
      description: `${e.label}${e.readOnly ? ' (read-only)' : ''}`,
      detail: e.tags.length ? `tags: ${e.tags.join(', ')}` : undefined,
      picked: e.installed,
      entry: e,
      buttons: e.installed ? [editButton, resetButton] : [editButton],
    });

    const qp = vscode.window.createQuickPick<AgentItem>();
    qp.canSelectMany = true;
    qp.matchOnDescription = true;
    qp.matchOnDetail = true;
    qp.placeholder = 'Tick agents to enable. Click the pencil icon to edit a definition.';
    qp.title = 'Manage SDLC Agent Skills';
    qp.buttons = [newButton];
    qp.items = entries.map(buildItem);
    qp.selectedItems = qp.items.filter((i) => i.entry.installed);

    const refresh = (): void => {
      // Re-stat to pick up files that were just created by an edit action.
      for (const e of entries) { e.installed = fs.existsSync(e.targetPath); }
      const newItems = entries.map(buildItem);
      const stillSelectedIds = new Set(qp.selectedItems.map((i) => i.entry.id));
      // Newly-installed entries become ticked because "edit" implies "enable".
      for (const e of entries) { if (e.installed) { stillSelectedIds.add(e.id); } }
      qp.items = newItems;
      qp.selectedItems = newItems.filter((i) => stillSelectedIds.has(i.entry.id));
    };

    qp.onDidTriggerButton(async (btn) => {
      if (btn !== newButton) { return; }
      qp.hide();
      await createCustomAgent(entries, targetDir);
    });

    qp.onDidTriggerItemButton(async (ev) => {
      const e = ev.item.entry;
      if (ev.button === resetButton && e.installed) {
        const choice = await vscode.window.showWarningMessage(
          `Reset "${e.id}.md" to the bundled default? Local edits will be lost.`,
          { modal: true }, 'Reset',
        );
        if (choice !== 'Reset') { return; }
        try {
          fs.copyFileSync(e.libPath, e.targetPath);
          vscode.window.showInformationMessage(`Reset ${e.id}.md to bundled default.`);
        } catch (err) {
          vscode.window.showErrorMessage(`Reset failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        refresh();
        return;
      }
      // Edit: ensure a workspace copy exists, then open it.
      if (!e.installed) {
        try { fs.copyFileSync(e.libPath, e.targetPath); }
        catch (err) {
          vscode.window.showErrorMessage(
            `Could not enable "${e.id}" for editing: ${err instanceof Error ? err.message : String(err)}`,
          );
          return;
        }
      }
      try {
        const doc = await vscode.workspace.openTextDocument(e.targetPath);
        await vscode.window.showTextDocument(doc, { preview: false });
      } catch (err) {
        vscode.window.showErrorMessage(`Open failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      refresh();
    });

    const picks = await new Promise<readonly AgentItem[] | undefined>((resolve) => {
      qp.onDidAccept(() => { resolve(qp.selectedItems); qp.hide(); });
      qp.onDidHide(() => { resolve(undefined); qp.dispose(); });
      qp.show();
    });
    if (!picks) { return; }

    const { added, removed } = await applySkillSelections(entries, new Set(picks.map((p) => p.entry.id)));
    if (added + removed === 0) {
      vscode.window.showInformationMessage('Agent skills: no changes.');
    } else {
      vscode.window.showInformationMessage(
        `Agent skills updated: +${added} enabled, -${removed} disabled. Skills hot-reload on the next prompt.`,
      );
    }
  }));
}
