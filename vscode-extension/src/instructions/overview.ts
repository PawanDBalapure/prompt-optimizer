import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { runEngineRaw } from '../engine/runner';
import { resolveInstructionPath, type ActionResult, type InstructionCommit } from './paths';

/** Fetch the instructions overview JSON from the engine sidecar. */
export function fetchInstructionsOverview(
  wsRoot: string,
  personaDir?: string,
): { ok: true; payload: unknown } | { ok: false; error: string } {
  try {
    const args = ['--instructions-overview', '--workspace-root', wsRoot];
    if (personaDir) { args.push('--persona-dir', personaDir); }
    return { ok: true, payload: JSON.parse(runEngineRaw(args)) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not read instructions.' };
  }
}

/** Read git history (authorship + timestamps) for one instruction file. */
export function readInstructionHistory(
  relPath: string,
): { ok: true; commits: InstructionCommit[] } | { ok: false; error: string } {
  const resolved = resolveInstructionPath(relPath);
  if (!resolved) { return { ok: false, error: 'Invalid instruction path.' }; }
  try {
    // %h sha, %an author, %ad ISO-ish date, %ar relative date, %s subject.
    const out = childProcess.execFileSync(
      'git',
      [
        '-C', resolved.wsRoot,
        'log', '--max-count=25', '--follow',
        '--pretty=format:%h\u001f%an\u001f%ad\u001f%ar\u001f%s',
        '--date=short', '--', relPath,
      ],
      { encoding: 'utf8', timeout: 8000 },
    );
    const commits = out
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [sha, author, date, relative, subject] = line.split('\u001f');
        return { sha, author, date, relative, subject };
      });
    return { ok: true, commits };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const notGit = /not a git repository|command not found|ENOENT/i.test(msg);
    return {
      ok: false,
      error: notGit
        ? 'No git history available (workspace is not a git repository or git is not installed).'
        : 'Could not read git history for this file.',
    };
  }
}

/** Open an instruction source in the editor (creating it if missing). */
export async function openInstructionFile(relPath: string): Promise<ActionResult> {
  const resolved = resolveInstructionPath(relPath);
  if (!resolved) { return { ok: false, error: 'Invalid instruction path.' }; }
  try {
    if (!fs.existsSync(resolved.abs)) {
      fs.mkdirSync(path.dirname(resolved.abs), { recursive: true });
      fs.writeFileSync(resolved.abs, '', { encoding: 'utf8', flag: 'wx' });
    }
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(resolved.abs));
    await vscode.window.showTextDocument(doc, { preview: false });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not open the instruction file.' };
  }
}
