import * as child_process from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { runEngineRaw } from './runner';

/**
 * Whitelisted seed files inside the workspace.  Restricting harvesting to
 * known relative paths avoids path-traversal abuse from a hostile workspace
 * config and keeps seeding deterministic.
 */
const SEED_FILES = [
  '.github/copilot-instructions.md',
  'AGENTS.md',
  'CLAUDE.md',
  '.cursorrules',
  '.copilot-instructions.md',
  'copilot-instructions.md',
] as const;

export const MIN_SEED_LEN = 15;
const MAX_SEED_LEN = 300;
const README_HEAD_BYTES = 5000;
const GIT_LOG_COUNT = 80;
const GIT_TIMEOUT_MS = 5000;
/** Full seed + static workspace indexing can legitimately take minutes on big repos. */
export const SEED_TIMEOUT_MS = 5 * 60_000;

export function normalizePromptText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

function isWithinWorkspace(absoluteFile: string, workspaceRoot: string): boolean {
  const normalisedRoot = path.resolve(workspaceRoot) + path.sep;
  const normalisedFile = path.resolve(absoluteFile);
  return normalisedFile === path.resolve(workspaceRoot)
    || normalisedFile.startsWith(normalisedRoot);
}

export function harvestChatHistory(context: vscode.ExtensionContext): string[] {
  try {
    // globalStorageUri is .../globalStorage/<extensionId>;
    // state.vscdb sits one level up inside globalStorage/.
    const vscodePath = path.dirname(context.globalStorageUri.fsPath);
    const raw = runEngineRaw(['--read-chat-history', '--vscode-path', vscodePath]);
    return JSON.parse(raw) as string[];
  } catch {
    return [];
  }
}

export function harvestGitLog(workspaceRoot: string): string[] {
  try {
    const git = child_process.spawnSync(
      'git',
      ['log', '--pretty=format:%s%n%b', '-n', String(GIT_LOG_COUNT)],
      { cwd: workspaceRoot, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, shell: false },
    );
    if (git.status !== 0) { return []; }
    return git.stdout.split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length >= MIN_SEED_LEN && l.length <= MAX_SEED_LEN);
  } catch {
    return [];
  }
}

export function harvestInstructionFiles(workspaceRoot: string): string[] {
  const out: string[] = [];
  for (const rel of SEED_FILES) {
    try {
      const full = path.join(workspaceRoot, rel);
      if (!isWithinWorkspace(full, workspaceRoot) || !fs.existsSync(full)) { continue; }
      const lines = fs.readFileSync(full, 'utf8').split('\n');
      out.push(
        ...lines
          .map((l) => l.replace(/^[-*#>\s]+/, '').trim())
          .filter((l) => l.length >= 20 && l.length <= MAX_SEED_LEN),
      );
    } catch {
      /* missing or unreadable */
    }
  }
  return out;
}

export function harvestPackageJson(workspaceRoot: string): string[] {
  try {
    const pkgPath = path.join(workspaceRoot, 'package.json');
    if (!isWithinWorkspace(pkgPath, workspaceRoot) || !fs.existsSync(pkgPath)) { return []; }
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as Record<string, unknown>;
    const out: string[] = [];
    if (typeof pkg.description === 'string' && pkg.description.length > 10) {
      out.push(`Explain ${typeof pkg.name === 'string' ? pkg.name : 'this project'}: ${pkg.description}`);
    }
    const scripts = (pkg.scripts ?? {}) as Record<string, unknown>;
    for (const name of Object.keys(scripts)) {
      out.push(`What does the npm ${name} script do and when should I run it?`);
    }
    return out;
  } catch {
    return [];
  }
}

export function harvestReadme(workspaceRoot: string): string[] {
  try {
    const readmePath = path.join(workspaceRoot, 'README.md');
    if (!isWithinWorkspace(readmePath, workspaceRoot) || !fs.existsSync(readmePath)) { return []; }
    const lines = fs.readFileSync(readmePath, 'utf8').slice(0, README_HEAD_BYTES).split('\n');
    return lines
      .map((l) => l.replace(/^[#*\->|\s]+/, '').trim())
      .filter((l) => l.length >= 30 && l.length <= MAX_SEED_LEN && !l.startsWith('!'));
  } catch {
    return [];
  }
}
