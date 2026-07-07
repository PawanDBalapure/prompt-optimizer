import * as fs from 'node:fs';
import * as vscode from 'vscode';

/**
 * One-time import of "rules" from the file open in the active editor into a
 * preserved section of `.github/copilot-instructions.md` — runs on first
 * bootstrap so pre-existing conventions the user had open aren't lost.
 */

const MANAGED_BEGIN = '<!-- prompt-optimizer:memory:begin -->';
const OPEN_RULES_BEGIN = '<!-- prompt-optimizer:install-open-rules:begin -->';
const OPEN_RULES_END = '<!-- prompt-optimizer:install-open-rules:end -->';
const MAX_OPEN_RULES_CHARS = 12_000;

function safeRead(filePath: string): string {
  try { return fs.readFileSync(filePath, 'utf8'); }
  catch { return ''; }
}

function normalizeRuleLine(line: string): string {
  const trimmed = line.trim();
  if (!trimmed) { return ''; }
  if (trimmed === '## Installation Rules (from open file)') { return ''; }
  return trimmed.replace(/\s+/g, ' ').toLowerCase();
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

/**
 * Append the active editor's contents into the preserved open-rules section
 * of the target instructions file. Returns true when the file was changed.
 */
export function appendOpenEditorRules(targetPath: string): boolean {
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
