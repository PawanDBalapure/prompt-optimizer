#!/usr/bin/env node

import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { PromptOptimizationRequest, PromptProxyEngineOptions } from './contracts.js';
import { PromptProxyEngine } from './PromptProxyEngine.js';
import { SemanticCacheManager } from './SemanticCacheManager.js';

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function printHelp(): void {
  process.stderr.write(
    'Usage: prompt-proxy-engine --stdin [--db <path>]\n' +
      '   or: prompt-proxy-engine --file <request.json> [--db <path>]\n' +
      '   or: prompt-proxy-engine --prompt "your prompt" [--db <path>]\n' +
      '   or: prompt-proxy-engine --cache-stats [--db <path>]\n' +
      '   or: prompt-proxy-engine --clear-cache [--db <path>]\n'
  );
}

function resolveDbPath(args: string[]): string | undefined {
  const idx = args.indexOf('--db');
  return idx !== -1 ? args[idx + 1] : undefined;
}

function resolveArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : undefined;
}

/** Returns true if the string looks like a natural-language prompt (not code). */
function looksLikePrompt(s: string): boolean {
  const t = s.trim();
  if (t.length < 15 || t.length > 500) { return false; }
  if (/^(import |export |const |let |var |function |class |if \(|for \(|while \(|\{|\}|<[a-z]|\/\/|#!)/.test(t)) { return false; }
  if (/^https?:\/\//.test(t)) { return false; }
  const alphaRatio = (t.match(/[a-zA-Z]/g) ?? []).length / t.length;
  return alphaRatio >= 0.45;
}

function collectPromptStrings(obj: unknown, out: string[], depth = 0): void {
  if (depth > 8 || obj === null || obj === undefined) { return; }
  if (typeof obj === 'string') {
    if (looksLikePrompt(obj)) { out.push(obj.trim()); }
    return;
  }
  if (Array.isArray(obj)) {
    for (const item of obj) { collectPromptStrings(item, out, depth + 1); }
    return;
  }
  if (typeof obj === 'object') {
    // Prioritise fields most likely to carry the user's message text.
    for (const key of ['text', 'message', 'prompt', 'content', 'input', 'request', 'query']) {
      const val = (obj as Record<string, unknown>)[key];
      if (val !== undefined) { collectPromptStrings(val, out, depth + 1); }
    }
    for (const val of Object.values(obj as Record<string, unknown>)) {
      collectPromptStrings(val, out, depth + 1);
    }
  }
}

async function extractVSCodeChatHistory(vscodePath?: string): Promise<string[]> {
  if (!vscodePath) { return []; }

  // VS Code stores global state in globalStorage/state.vscdb (SQLite, ItemTable).
  const stateDbPath = path.join(vscodePath, 'state.vscdb');
  if (!fs.existsSync(stateDbPath)) { return []; }

  const prompts: string[] = [];
  let db: InstanceType<typeof Database> | null = null;

  try {
    db = new Database(stateDbPath, { readonly: true, fileMustExist: true });
    const rows = db.prepare(
      "SELECT value FROM ItemTable WHERE key LIKE '%chat%' OR key LIKE '%copilot%' OR key LIKE '%interactive%' LIMIT 30"
    ).all() as Array<{ value: string }>;

    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.value) as unknown;
        collectPromptStrings(parsed, prompts);
      } catch { /* not JSON or unparseable */ }
    }
  } catch { /* DB locked, missing, or wrong format */ } finally {
    try { db?.close(); } catch { /* ignore */ }
  }

  return [...new Set(prompts)];
}

async function handleSeedBatch(args: string[]): Promise<void> {
  const wsId = resolveArg(args, '--workspace-id') ?? 'global';
  const dbPath = resolveDbPath(args);
  const stdin = await readStdin();
  let prompts: string[];
  try {
    prompts = JSON.parse(stdin) as string[];
  } catch {
    process.stderr.write('--seed-batch: stdin must be a JSON array of strings\n');
    process.exitCode = 1;
    return;
  }

  const engine = new PromptProxyEngine(dbPath ? { db_path: dbPath } : {});
  await engine.initialize();
  let count = 0;
  for (const raw of prompts) {
    if (!raw?.trim()) { continue; }
    try {
      await engine.processRequest({ raw_prompt: raw, mode: 'blocking', workspace_id: wsId });
      count++;
    } catch { /* skip bad seeds */ }
  }
  engine.close();
  process.stdout.write(`${JSON.stringify({ seeded: count })}\n`);
}

async function handleCacheStats(dbPath?: string): Promise<void> {
  const manager = new SemanticCacheManager(dbPath);
  await manager.initialize();
  const stats = manager.getStats();
  manager.close();
  process.stdout.write(`${JSON.stringify(stats)}\n`);
}

async function handleClearCache(dbPath?: string): Promise<void> {
  const manager = new SemanticCacheManager(dbPath);
  await manager.initialize();
  manager.clearCache();
  const pruned = manager.pruneStale(0); // prune all stale regardless of age after full clear
  manager.close();
  process.stdout.write(`${JSON.stringify({ cleared: true, pruned })}\n`);
}

async function loadRequest(args: string[]): Promise<{ request: PromptOptimizationRequest; options: PromptProxyEngineOptions }> {
  let dbPath: string | undefined;
  let request: PromptOptimizationRequest | null = null;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];

    if (arg === '--db') {
      dbPath = args[index + 1];
      index++;
      continue;
    }

    if (arg === '--file') {
      const filePath = args[index + 1];
      if (!filePath) {
        throw new Error('Missing value for --file');
      }

      request = JSON.parse(fs.readFileSync(filePath, 'utf8')) as PromptOptimizationRequest;
      index++;
      continue;
    }

    if (arg === '--prompt') {
      const rawPrompt = args[index + 1];
      if (!rawPrompt) {
        throw new Error('Missing value for --prompt');
      }

      request = { raw_prompt: rawPrompt };
      index++;
      continue;
    }

    if (arg === '--stdin') {
      const stdin = await readStdin();
      request = JSON.parse(stdin) as PromptOptimizationRequest;
    }
  }

  if (!request && !process.stdin.isTTY) {
    const stdin = await readStdin();
    if (stdin.trim() !== '') {
      request = JSON.parse(stdin) as PromptOptimizationRequest;
    }
  }

  if (!request) {
    throw new Error('No request payload provided');
  }

  return {
    request,
    options: dbPath ? { db_path: dbPath } : {},
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return;
  }

  if (args.includes('--cache-stats')) {
    await handleCacheStats(resolveDbPath(args));
    return;
  }

  if (args.includes('--clear-cache')) {
    await handleClearCache(resolveDbPath(args));
    return;
  }

  if (args.includes('--seed-batch')) {
    await handleSeedBatch(args);
    return;
  }

  if (args.includes('--read-chat-history')) {
    const vscodePath = resolveArg(args, '--vscode-path');
    const prompts = await extractVSCodeChatHistory(vscodePath);
    process.stdout.write(`${JSON.stringify(prompts)}\n`);
    return;
  }

  const { request, options } = await loadRequest(args);
  const engine = new PromptProxyEngine(options);

  try {
    await engine.initialize();
    const response = await engine.processRequest(request);
    process.stdout.write(`${JSON.stringify(response)}\n`);
  } finally {
    engine.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});