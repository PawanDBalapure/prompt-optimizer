import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { runEngineRaw } from '../engine/runner';

interface ModeRow {
  id: string;
  label: string;
  readOnly: boolean;
  source: string;
  slashAliases: string[];
  keywords?: string[];
  filePatterns?: string[];
  tags?: string[];
  priority?: number;
}

interface SkillError { filePath: string; source: string; message: string; }

function listModes(): { modes: ModeRow[]; errors?: SkillError[] } {
  const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  return JSON.parse(runEngineRaw(['--list-modes', '--workspace-root', wsRoot]));
}

const SKILL_TEMPLATE = (id: string, label: string): string => [
  '---',
  `id: ${id}`,
  `label: ${label}`,
  'readOnly: false',
  'priority: 0',
  `slashAliases: [${id}]`,
  `keywords: [${id.replace(/-/g, ' ')}]`,
  '# requires: [tokenA, tokenB]   # uncomment to AND-gate this skill',
  '# filePatterns:                 # uncomment to auto-trigger on file types',
  '#   - "*.ts"',
  '# intentPatterns:',
  `#   - "\\b${id.replace(/-/g, ' ')}\\b"`,
  '---',
  `You are operating as ${label}. Describe the role in 2-3 sentences.`,
  '',
  '## Checklist',
  '- First quality criterion this agent must satisfy.',
  '- Second quality criterion.',
  '',
].join('\n');

/** Register list / create / diagnose commands for agent skills (SDLC modes). */
export function registerSkillCommands(context: vscode.ExtensionContext): void {
  const push = (d: vscode.Disposable) => context.subscriptions.push(d);

  push(vscode.commands.registerCommand('prompt-proxy.listSkills', async () => {
    try {
      const { modes, errors } = listModes();
      if (errors && errors.length > 0) {
        const view = await vscode.window.showWarningMessage(
          `${errors.length} skill file(s) failed to load.`, 'Show errors', 'Dismiss',
        );
        if (view === 'Show errors') {
          await vscode.commands.executeCommand('prompt-proxy.diagnoseSkills');
          return;
        }
      }
      const items = modes.map((m) => {
        const extras: string[] = [];
        if (m.keywords?.length) { extras.push(`keywords: ${m.keywords.join(', ')}`); }
        if (m.filePatterns?.length) { extras.push(`files: ${m.filePatterns.join(', ')}`); }
        if (typeof m.priority === 'number' && m.priority !== 0) { extras.push(`priority: ${m.priority}`); }
        if (m.tags?.length) { extras.push(`tags: ${m.tags.join(', ')}`); }
        return {
          label: `${m.source === 'builtin' ? '$(symbol-class)' : '$(extensions)'} /${m.id}`,
          description: `${m.label}${m.readOnly ? ' (read-only)' : ''}`,
          detail: [
            `source: ${m.source}`,
            `triggers: ${m.slashAliases.map((a) => `/${a}`).join(', ')}`,
            ...extras,
          ].join(' • '),
          value: m,
        };
      });
      const pick = await vscode.window.showQuickPick(items, {
        placeHolder: 'Agent skills (modes) registered for this workspace',
        matchOnDescription: true,
        matchOnDetail: true,
      });
      if (!pick) { return; }
      // Offer to open the override file if it lives in the workspace.
      const skillPath = path.join(
        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd(),
        '.promptoptimizer', 'skills', `${pick.value.id}.md`,
      );
      if (fs.existsSync(skillPath)) {
        const doc = await vscode.workspace.openTextDocument(skillPath);
        await vscode.window.showTextDocument(doc);
      } else {
        const open = await vscode.window.showInformationMessage(
          `Mode "${pick.value.id}" is a built-in. Create a workspace override?`,
          'Create override', 'Cancel',
        );
        if (open === 'Create override') {
          await vscode.commands.executeCommand('prompt-proxy.createSkill', pick.value.id);
        }
      }
    } catch (err) {
      vscode.window.showErrorMessage(`List skills failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }));

  push(vscode.commands.registerCommand('prompt-proxy.createSkill', async (presetId?: string) => {
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!wsRoot) {
      vscode.window.showWarningMessage('Open a workspace folder first.');
      return;
    }
    const id = presetId ?? await vscode.window.showInputBox({
      prompt: 'Skill id (lowercase, e.g. "a11y", "perf", "data-migration")',
      validateInput: (v) => /^[a-z][a-z0-9-]*$/.test(v) ? null : 'Lowercase letters, digits and dashes only.',
    });
    if (!id) { return; }
    const dir = path.join(wsRoot, '.promptoptimizer', 'skills');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${id}.md`);
    if (!fs.existsSync(file)) {
      const label = id.split(/[-_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      fs.writeFileSync(file, SKILL_TEMPLATE(id, label));
    }
    const doc = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(doc);
    vscode.window.showInformationMessage(
      `Skill "${id}" ready. Edits hot-reload on the next prompt — trigger with /${id}.`,
    );
  }));

  push(vscode.commands.registerCommand('prompt-proxy.diagnoseSkills', async () => {
    try {
      const { errors } = listModes();
      if (!errors || errors.length === 0) {
        vscode.window.showInformationMessage('All skill files parse cleanly.');
        return;
      }
      const items = errors.map((e) => ({
        label: `$(error) ${path.basename(e.filePath)}`,
        description: e.message,
        detail: `${e.source} \u2022 ${e.filePath}`,
        value: e,
      }));
      const pick = await vscode.window.showQuickPick(items, {
        placeHolder: `${errors.length} skill file(s) failed to load — select to open`,
        matchOnDescription: true,
        matchOnDetail: true,
      });
      if (!pick) { return; }
      const doc = await vscode.workspace.openTextDocument(pick.value.filePath);
      await vscode.window.showTextDocument(doc);
    } catch (err) {
      vscode.window.showErrorMessage(`Diagnose skills failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }));
}
