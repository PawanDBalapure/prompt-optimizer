import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { runEngineRaw } from '../engine/runner';
import type { ActionResult } from './paths';

function isCopilotInstructionsFile(relPath: string): boolean {
  const rel = relPath.replace(/\\/g, '/').toLowerCase();
  return rel === '.github/copilot-instructions.md'
    || rel === '.copilot-instructions.md'
    || rel === 'copilot-instructions.md';
}

function appendInstructionText(existing: string, incoming: string): string {
  const existingTrim = existing.replace(/\s+$/g, '');
  const incomingTrim = incoming.trim();
  if (!incomingTrim) { return existing; }
  if (existingTrim.includes(incomingTrim)) { return existingTrim + '\n'; }
  if (!existingTrim) { return incomingTrim + '\n'; }
  const eol = existing.includes('\r\n') ? '\r\n' : '\n';
  return [existingTrim, '', '<!-- prompt-optimizer:import:append -->', incomingTrim, ''].join(eol);
}

/** Export all existing instruction sources into a JSON bundle the user picks. */
export async function exportInstructionsBundle(wsRoot: string): Promise<ActionResult> {
  try {
    const raw = runEngineRaw(['--instructions-overview', '--workspace-root', wsRoot]);
    const overview = JSON.parse(raw) as {
      sources: Array<{ id: string; label: string; relPath: string; exists: boolean }>;
    };
    const files: Array<{ relPath: string; label: string; content: string }> = [];
    for (const src of overview.sources) {
      if (!src.exists) { continue; }
      const abs = path.resolve(wsRoot, src.relPath);
      try {
        files.push({ relPath: src.relPath, label: src.label, content: fs.readFileSync(abs, 'utf8') });
      } catch { /* skip unreadable */ }
    }
    const target = await vscode.window.showSaveDialog({
      title: 'Export instruction sources',
      defaultUri: vscode.Uri.file(path.join(wsRoot, 'instructions-bundle.json')),
      filters: { JSON: ['json'] },
    });
    if (!target) { return { ok: false, error: 'Export cancelled.' }; }
    const bundle = {
      kind: 'prompt-optimizer.instructions-bundle',
      version: 1,
      exportedAt: new Date().toISOString(),
      files,
    };
    fs.writeFileSync(target.fsPath, JSON.stringify(bundle, null, 2), 'utf8');
    return { ok: true, message: `Exported ${files.length} instruction file${files.length === 1 ? '' : 's'}.` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Export failed.' };
  }
}

/** Import an instruction bundle, writing each file back after user confirmation. */
export async function importInstructionsBundle(wsRoot: string): Promise<ActionResult> {
  try {
    const picked = await vscode.window.showOpenDialog({
      title: 'Import instruction bundle',
      canSelectMany: false,
      filters: { JSON: ['json'] },
    });
    if (!picked || picked.length === 0) { return { ok: false, error: 'Import cancelled.' }; }

    const bundle = JSON.parse(fs.readFileSync(picked[0].fsPath, 'utf8')) as {
      kind?: string;
      files?: Array<{ relPath?: string; content?: string }>;
    };
    if (bundle.kind !== 'prompt-optimizer.instructions-bundle' || !Array.isArray(bundle.files)) {
      return { ok: false, error: 'Not a valid instructions bundle file.' };
    }

    const confirm = await vscode.window.showWarningMessage(
      `Import ${bundle.files.length} instruction file(s)? Existing files with the same path will be overwritten (copilot-instructions files are appended).`,
      { modal: true },
      'Import',
    );
    if (confirm !== 'Import') { return { ok: false, error: 'Import cancelled.' }; }

    let written = 0;
    for (const file of bundle.files) {
      const rel = typeof file.relPath === 'string' ? file.relPath.replace(/\\/g, '/') : '';
      const content = typeof file.content === 'string' ? file.content : '';
      if (!rel || rel.includes('..') || path.isAbsolute(rel)) { continue; }
      const abs = path.resolve(wsRoot, rel);
      const containment = path.relative(wsRoot, abs);
      if (containment.startsWith('..') || path.isAbsolute(containment)) { continue; }
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      if (isCopilotInstructionsFile(rel) && fs.existsSync(abs)) {
        const existing = fs.readFileSync(abs, 'utf8');
        fs.writeFileSync(abs, appendInstructionText(existing, content), 'utf8');
      } else {
        fs.writeFileSync(abs, content, 'utf8');
      }
      written++;
    }
    return { ok: true, message: `Imported ${written} instruction file${written === 1 ? '' : 's'}.` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Import failed.' };
  }
}
