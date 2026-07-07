import * as child_process from 'node:child_process';
import * as vscode from 'vscode';

import type { PromptProxyResponse } from '../types';
import { findSystemNode, getCliPath } from './nodeRuntime';

const SUBPROCESS_TIMEOUT_MS = 60_000;

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

/**
 * Async variant of {@link runEngineRaw}. Long-running engine work (workspace
 * seeding / full static indexing) MUST use this: `spawnSync` blocks the whole
 * extension host, which froze the UI and made the panel's refresh spinner
 * appear stuck until the 60 s kill. Supports a per-call timeout so heavy
 * index passes get more headroom than quick status reads.
 */
export function runEngineRawAsync(
  args: string[],
  options?: { input?: string; timeoutMs?: number },
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = child_process.spawn(
      findSystemNode(),
      [getCliPath(), ...args],
      { env: budgetEnv(), shell: false },
    );

    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) { return; }
      settled = true;
      try { child.kill(); } catch { /* already gone */ }
      reject(new Error(`Engine CLI timed out after ${options?.timeoutMs ?? SUBPROCESS_TIMEOUT_MS} ms.`));
    }, options?.timeoutMs ?? SUBPROCESS_TIMEOUT_MS);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', (err) => {
      if (settled) { return; }
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) { return; }
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr.trim() || 'CLI subprocess exited with an error.'));
        return;
      }
      resolve(stdout.trim());
    });

    if (options?.input !== undefined) {
      child.stdin.write(options.input);
    }
    child.stdin.end();
  });
}
