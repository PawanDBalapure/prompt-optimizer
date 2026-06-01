import * as child_process from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import type { PromptProxyResponse } from '../types';

/**
 * Build an env block that propagates user-configurable token budget caps
 * from VS Code settings to the engine sidecar.  Falls back to the engine's
 * built-in defaults when a setting is missing or invalid.
 */
function budgetEnv(): NodeJS.ProcessEnv {
  const cfg = vscode.workspace.getConfiguration('promptProxy');
  const out: NodeJS.ProcessEnv = { ...process.env };
  const map: Array<[string, string, number]> = [
    ['tokenBudget.augmentedBytes', 'POMEMORY_MAX_AUGMENTED_BYTES', 1_024],
    ['tokenBudget.managedBytes',   'POMEMORY_MAX_MANAGED_BYTES',     512],
    ['tokenBudget.perFileBytes',   'POMEMORY_MAX_BYTES_PER_FILE',    256],
    ['tokenBudget.totalBytes',     'POMEMORY_MAX_TOTAL_BYTES',       512],
  ];
  for (const [setting, envName, min] of map) {
    const v = cfg.get<number>(setting);
    if (typeof v === 'number' && Number.isFinite(v) && v >= min) {
      out[envName] = String(Math.floor(v));
    }
  }
  return out;
}

/**
 * Locate the Node.js binary the engine sidecar should run under.
 *
 * Order:
 *   1. Bundled Node runtime that ships inside the .vsix at
 *      `<extension>/engine-runtime/node[.exe]`. Each platform-specific
 *      .vsix carries the matching binary, so end users need nothing
 *      installed.
 *   2. System `node` on PATH (legacy fallback for source installs).
 *   3. Common Windows install locations.
 *   4. Electron binary (process.execPath) — last resort; will fail for
 *      native modules but better than throwing here.
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

  // 1. Bundled runtime (preferred).
  const bundledName = process.platform === 'win32' ? 'node.exe' : 'node';
  const bundled = path.resolve(__dirname, '../../engine-runtime', bundledName);
  if (fs.existsSync(bundled)) {
    // Cross-platform safety: .vsix is a ZIP, which doesn't always preserve
    // the Unix executable bit. Force +x on macOS/Linux before probing so a
    // .vsix produced on Windows still works on POSIX.
    if (process.platform !== 'win32') {
      try {
        const st = fs.statSync(bundled);
        // 0o111 = any-execute bits set
        if ((st.mode & 0o111) === 0) {
          fs.chmodSync(bundled, 0o755);
        }
      } catch { /* ignore — probe will fail and we fall through */ }
    }
    // macOS Gatekeeper marks downloaded binaries with com.apple.quarantine.
    // Strip it so spawn() doesn't get blocked. Best-effort; ignore failure.
    if (process.platform === 'darwin') {
      try {
        child_process.spawnSync('xattr', ['-d', 'com.apple.quarantine', bundled], {
          stdio: 'ignore', shell: false,
        });
      } catch { /* ignore */ }
    }
    if (probe(bundled)) { return bundled; }
  }

  // 2. System node on PATH.
  const name = process.platform === 'win32' ? 'node.exe' : 'node';
  if (probe(name)) { return name; }

  // 3. Well-known Windows install locations.
  if (process.platform === 'win32') {
    const candidates = [
      'C:\\Program Files\\nodejs\\node.exe',
      'C:\\Program Files (x86)\\nodejs\\node.exe',
    ];
    for (const p of candidates) {
      if (fs.existsSync(p) && probe(p)) { return p; }
    }
  }

  // 4. Electron fallback.
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
      env: budgetEnv(),
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
      env: budgetEnv(),
      shell: false,
      timeout: SUBPROCESS_TIMEOUT_MS,
    },
  );

  if (child.status !== 0) {
    throw new Error(child.stderr?.trim() || 'CLI subprocess exited with an error.');
  }

  return child.stdout.trim();
}
