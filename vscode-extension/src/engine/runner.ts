import * as child_process from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import type { PromptProxyResponse } from '../types';

/**
 * Locate the system Node.js binary.  VS Code's `process.execPath` is the
 * Electron binary whose embedded Node ABI differs from the ABI used when
 * `better-sqlite3` was compiled, so the engine sidecar must run under system
 * Node instead.
 */
function findSystemNode(): string {
  const probe = (exe: string): boolean => {
    try {
      const r = child_process.spawnSync(exe, ['--version'], {
        encoding: 'utf8', shell: false, env: process.env,
      });
      return r.status === 0 && typeof r.stdout === 'string' && r.stdout.trim().startsWith('v');
    } catch {
      return false;
    }
  };

  const name = process.platform === 'win32' ? 'node.exe' : 'node';
  if (probe(name)) { return name; }

  if (process.platform === 'win32') {
    const candidates = [
      'C:\\Program Files\\nodejs\\node.exe',
      'C:\\Program Files (x86)\\nodejs\\node.exe',
    ];
    for (const p of candidates) {
      if (fs.existsSync(p) && probe(p)) { return p; }
    }
  }

  // Fallback: Electron binary.  Will fail for native modules but better than
  // crashing the call site.
  return process.execPath;
}

function getCliPath(): string {
  return path.resolve(__dirname, '../../engine/dist/cli.js');
}

const SUBPROCESS_TIMEOUT_MS = 60_000;

/** Sync invocation kept for legacy commands that demand a return value. */
export function runEngine(request: unknown, dbPath: string): PromptProxyResponse {
  const child = child_process.spawnSync(
    findSystemNode(),
    [getCliPath(), '--stdin', '--db', dbPath],
    {
      input: JSON.stringify(request),
      encoding: 'utf8',
      env: process.env,
      shell: false,
      timeout: SUBPROCESS_TIMEOUT_MS,
    },
  );

  if (child.status !== 0) {
    const stderr = child.stderr ? child.stderr.trim() : '';
    const hint = stderr.includes('NODE_MODULE_VERSION')
      ? ' (native module ABI mismatch \u2014 ensure "node" on PATH matches the version used to install the extension)'
      : '';
    throw new Error((stderr || 'CLI subprocess exited with an error.') + hint);
  }

  try {
    return JSON.parse(child.stdout.trim()) as PromptProxyResponse;
  } catch {
    throw new Error(`Invalid JSON returned from the engine CLI: ${child.stdout}`);
  }
}

/** Run CLI with arbitrary flags. Pass `input` for modes that read stdin. */
export function runEngineRaw(args: string[], input?: string): string {
  const child = child_process.spawnSync(
    findSystemNode(),
    [getCliPath(), ...args],
    {
      input,
      encoding: 'utf8',
      env: process.env,
      shell: false,
      timeout: SUBPROCESS_TIMEOUT_MS,
    },
  );

  if (child.status !== 0) {
    throw new Error(child.stderr?.trim() || 'CLI subprocess exited with an error.');
  }

  return child.stdout.trim();
}
