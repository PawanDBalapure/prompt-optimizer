import * as fs from 'node:fs';
import * as path from 'node:path';

import { resolveInstructionPath, workspaceRoot, workspaceSkillsDir, type ActionResult } from './paths';

const OFF_RE = /^(\s*)<!--\s*po-off:\s?([\s\S]*?)\s*-->\s*$/;

/** Strip po-off wrappers and list markers so a line can be compared to rule text. */
function strippedLine(s: string): string {
  return s
    .replace(/^\s*<!--\s*po-off:\s?/, '')
    .replace(/\s*-->\s*$/, '')
    .replace(/^>\s?/, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/^\d+[.)]\s+/, '')
    .replace(/^\[[ xX]\]\s+/, '')
    .trim();
}

/** Copy a bundled skill file into the workspace when toggling a not-yet-installed skill. */
function ensureSkillFileFromLibrary(abs: string, relPath: string, libraryDir?: string): void {
  if (!libraryDir || fs.existsSync(abs)) { return; }
  const normalized = relPath.replace(/\\/g, '/');
  if (!/^\.promptoptimizer\/skills\/[A-Za-z0-9._-]+\.md$/i.test(normalized)) { return; }
  const srcPath = path.join(libraryDir, path.basename(normalized));
  const srcRel = path.relative(libraryDir, srcPath);
  if (srcRel.startsWith('..') || path.isAbsolute(srcRel) || !fs.existsSync(srcPath)) { return; }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.copyFileSync(srcPath, abs);
}

/**
 * Select / deselect a single rule by rewriting its line in the source file.
 * Disabled rules become `<!-- po-off: ... -->` comments (reversible).
 */
export async function toggleInstructionRule(
  data: { relPath?: string; line?: number; ruleText?: string; enabled?: boolean },
  options: { skillLibraryDir?: string } = {},
): Promise<ActionResult> {
  const relPath = data.relPath;
  const ruleText = (data.ruleText ?? '').trim();
  const targetEnabled = data.enabled === true;
  if (!relPath || !ruleText) { return { ok: false, error: 'Missing rule details.' }; }
  // The marker close sequence inside rule text would corrupt the comment.
  if (ruleText.includes('-->')) {
    return { ok: false, error: 'Rule cannot be toggled because it contains "-->".' };
  }
  const resolved = resolveInstructionPath(relPath);
  if (!resolved) { return { ok: false, error: 'Invalid instruction path.' }; }

  try {
    ensureSkillFileFromLibrary(resolved.abs, relPath, options.skillLibraryDir);
    const original = fs.readFileSync(resolved.abs, 'utf8');
    const eol = original.includes('\r\n') ? '\r\n' : '\n';
    const lines = original.split(/\r?\n/);

    // Locate the target line: prefer the reported index, fall back to a
    // unique content match (line numbers can drift after edits).
    let idx = (typeof data.line === 'number' ? data.line : 0) - 1;
    if (idx < 0 || idx >= lines.length || strippedLine(lines[idx]) !== ruleText) {
      const matches: number[] = [];
      for (let i = 0; i < lines.length; i++) {
        if (strippedLine(lines[i]) === ruleText) { matches.push(i); }
      }
      if (matches.length !== 1) { return { ok: false, error: 'Could not locate that rule in the file.' }; }
      idx = matches[0];
    }

    // Refuse edits inside an auto-managed block.
    let managed = false;
    for (let i = 0; i <= idx; i++) {
      const t = lines[i].trim();
      if (t.includes('prompt-optimizer:memory:begin')) { managed = true; }
      else if (t.includes('prompt-optimizer:memory:end')) { managed = false; }
    }
    if (managed) {
      return { ok: false, error: 'This rule is in an auto-managed block and cannot be toggled.' };
    }

    const line = lines[idx];
    const isOff = OFF_RE.test(line);
    if (targetEnabled) {
      if (isOff) {
        const m = OFF_RE.exec(line)!;
        lines[idx] = m[1] + m[2];
      }
    } else if (!isOff) {
      const indent = (/^(\s*)/.exec(line) ?? ['', ''])[1];
      lines[idx] = `${indent}<!-- po-off: ${line.slice(indent.length)} -->`;
    }

    fs.writeFileSync(resolved.abs, lines.join(eol), 'utf8');
    return { ok: true, message: targetEnabled ? 'Rule enabled.' : 'Rule disabled.' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not update the rule.' };
  }
}

/** Enable / disable a bundled persona by installing or removing its skill copy. */
export async function togglePersona(
  data: { personaId?: string; sourceFile?: string; enabled?: boolean },
  skillLibraryDir: string,
): Promise<ActionResult> {
  const wsRoot = workspaceRoot();
  if (!wsRoot) { return { ok: false, error: 'Open a workspace folder first.' }; }
  const personaId = data.personaId;
  if (!personaId || !/^[a-z0-9][a-z0-9-]*$/.test(personaId)) {
    return { ok: false, error: 'Invalid persona id.' };
  }

  const targetDir = workspaceSkillsDir(wsRoot);
  const targetPath = path.join(targetDir, `${personaId}.md`);
  try {
    if (data.enabled === true) {
      const sourceFile = data.sourceFile;
      if (!sourceFile || !/^[A-Za-z0-9._-]+\.md$/.test(sourceFile)) {
        return { ok: false, error: 'Invalid persona source file.' };
      }
      const srcPath = path.join(skillLibraryDir, sourceFile);
      // Containment: the source must stay inside the bundled library.
      const srcRel = path.relative(skillLibraryDir, srcPath);
      if (srcRel.startsWith('..') || path.isAbsolute(srcRel) || !fs.existsSync(srcPath)) {
        return { ok: false, error: 'Bundled persona not found.' };
      }
      fs.mkdirSync(targetDir, { recursive: true });
      fs.copyFileSync(srcPath, targetPath);
      return { ok: true, message: 'Persona enabled.' };
    }
    if (fs.existsSync(targetPath)) { fs.rmSync(targetPath); }
    return { ok: true, message: 'Persona disabled.' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not update the persona.' };
  }
}
