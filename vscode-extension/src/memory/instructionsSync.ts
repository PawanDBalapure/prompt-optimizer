import * as vscode from 'vscode';
import * as fs from 'node:fs';

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
const BOOTSTRAP_IMPORTED_OPEN_RULES_KEY = 'promptProxy.bootstrapImportedOpenRules';
const MANAGED_BEGIN = '<!-- prompt-optimizer:memory:begin -->';
const OPEN_RULES_BEGIN = '<!-- prompt-optimizer:install-open-rules:begin -->';
const OPEN_RULES_END = '<!-- prompt-optimizer:install-open-rules:end -->';
const MAX_OPEN_RULES_CHARS = 12_000;

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

  // One-time import on installation: if the user already has rules open in
  // the active editor, append them into a dedicated preserved section.
  const importedOpenRules = context.workspaceState.get<boolean>(BOOTSTRAP_IMPORTED_OPEN_RULES_KEY) === true;
  if (!importedOpenRules) {
    const appended = appendOpenEditorRules(report.path);
    if (appended) {
      await context.workspaceState.update(BOOTSTRAP_IMPORTED_OPEN_RULES_KEY, true);
    }
  }

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

function appendOpenEditorRules(targetPath: string): boolean {
  const editor = vscode.window.activeTextEditor;
  if (!editor) { return false; }
  const openText = editor.document.getText().trim();
  if (!openText) { return false; }

  const existing = safeRead(targetPath);
  const clipped = openText.length > MAX_OPEN_RULES_CHARS
    ? `${openText.slice(0, MAX_OPEN_RULES_CHARS)}\n... (truncated)`
    : openText;

  const beginMarker = existing.indexOf(OPEN_RULES_BEGIN);
  const endMarker = beginMarker === -1 ? -1 : existing.indexOf(OPEN_RULES_END, beginMarker);
  if (beginMarker !== -1 && endMarker !== -1) {
    const sectionStart = beginMarker + OPEN_RULES_BEGIN.length;
    const currentBody = existing.slice(sectionStart, endMarker).replace(/^\r?\n/, '');
    const mergedBody = mergeRuleBlocks(currentBody, clipped);
    if (mergedBody === currentBody) { return false; }

    const updatedExisting = [
      existing.slice(0, sectionStart),
      '\n',
      mergedBody.replace(/\s+$/g, ''),
      '\n',
      existing.slice(endMarker),
    ].join('');
    fs.writeFileSync(targetPath, updatedExisting, { encoding: 'utf8' });
    return true;
  }

  const block = [
    OPEN_RULES_BEGIN,
    '## Installation Rules (from open file)',
    '',
    clipped,
    OPEN_RULES_END,
  ].join('\n');

  let updated: string;
  const beginIdx = existing.indexOf(MANAGED_BEGIN);
  if (beginIdx === -1) {
    const trimmed = existing.replace(/\s+$/g, '');
    updated = trimmed ? `${trimmed}\n\n${block}\n` : `${block}\n`;
  } else {
    const before = existing.slice(0, beginIdx).replace(/\s+$/g, '');
    const after = existing.slice(beginIdx).replace(/^\s+/g, '');
    updated = `${before}\n\n${block}\n\n${after}`;
  }

  fs.writeFileSync(targetPath, updated, { encoding: 'utf8' });
  return true;
}

function mergeRuleBlocks(existingBody: string, incomingBody: string): string {
  const existingLines = existingBody.split(/\r?\n/);
  const existingNorm = new Set(existingLines.map(normalizeRuleLine).filter(Boolean));

  const incomingLines = incomingBody.split(/\r?\n/);
  const additions: string[] = [];
  for (const line of incomingLines) {
    const norm = normalizeRuleLine(line);
    if (!norm) { continue; }
    if (existingNorm.has(norm)) { continue; }
    additions.push(line);
    existingNorm.add(norm);
  }

  if (additions.length === 0) { return existingBody; }
  const base = existingBody.replace(/\s+$/g, '');
  return base ? `${base}\n${additions.join('\n')}` : additions.join('\n');
}

function normalizeRuleLine(line: string): string {
  const trimmed = line.trim();
  if (!trimmed) { return ''; }
  if (trimmed === '## Installation Rules (from open file)') { return ''; }
  return trimmed.replace(/\s+/g, ' ').toLowerCase();
}

function safeRead(filePath: string): string {
  try { return fs.readFileSync(filePath, 'utf8'); }
  catch { return ''; }
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
