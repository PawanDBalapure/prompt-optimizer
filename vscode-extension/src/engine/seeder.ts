import * as child_process from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import {
  BOOTSTRAP_DONE_KEY,
  CONVERSATION_KEY,
  MAX_CONVERSATION_TURNS,
  SEEDING_DONE_KEY,
  SEEDING_INTERVAL_MS,
} from '../constants';
import { getDbPath } from '../state/config';
import { getConversation } from '../state/conversation';
import type { ConversationTurn } from '../types';
import { computeLegacyWorkspaceIds, computeWorkspaceId } from '../util/workspace';
import { runEngineRaw, runEngineRawAsync } from './runner';

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

const MIN_SEED_LEN = 15;
const MAX_SEED_LEN = 300;
const MAX_SEED_COUNT = 200;
const README_HEAD_BYTES = 5000;
const GIT_LOG_COUNT = 80;
const GIT_TIMEOUT_MS = 5000;
const MAX_COPILOT_IMPORT_PER_SYNC = 10;
/** Full seed + static workspace indexing can legitimately take minutes on big repos. */
const SEED_TIMEOUT_MS = 5 * 60_000;
const WORKSPACE_ID_MIGRATED_KEY = 'promptProxy.workspaceIdMigrated.v1';

/**
 * One-time rescue of data stored under legacy workspace ids (pre-
 * canonicalization, Windows drive-letter casing made the same folder hash to
 * different ids). Merges each legacy id's rows onto the canonical id.
 */
async function migrateLegacyWorkspaceIds(
  context: vscode.ExtensionContext,
  workspaceRoot: string,
  dbPath: string,
): Promise<void> {
  const canonical = computeWorkspaceId(workspaceRoot);
  const doneKey = `${WORKSPACE_ID_MIGRATED_KEY}.${canonical}`;
  if (context.globalState.get<boolean>(doneKey) === true) { return; }
  for (const legacyId of computeLegacyWorkspaceIds(workspaceRoot)) {
    try {
      await runEngineRawAsync(
        ['--migrate-workspace', '--from', legacyId, '--to', canonical, '--db', dbPath],
      );
    } catch { /* best-effort; retried next activation until marked done */ }
  }
  await context.globalState.update(doneKey, true);
}

function normalizePromptText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

function isWithinWorkspace(absoluteFile: string, workspaceRoot: string): boolean {
  const normalisedRoot = path.resolve(workspaceRoot) + path.sep;
  const normalisedFile = path.resolve(absoluteFile);
  return normalisedFile === path.resolve(workspaceRoot)
    || normalisedFile.startsWith(normalisedRoot);
}

function harvestChatHistory(context: vscode.ExtensionContext): string[] {
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

function harvestGitLog(workspaceRoot: string): string[] {
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

function harvestInstructionFiles(workspaceRoot: string): string[] {
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

function harvestPackageJson(workspaceRoot: string): string[] {
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

function harvestReadme(workspaceRoot: string): string[] {
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

/**
 * On activation, harvest prompts from multiple sources (git log, Copilot chat
 * history, AI instruction files, package.json, README.md) and batch-seed the
 * local semantic cache so the very first user prompt benefits from prior
 * context.  Runs in the background; errors are silently swallowed.
 *
 * Behavior:
 *   - **First time ever for this workspace** (no `BOOTSTRAP_DONE_KEY` set):
 *     runs unconditionally so a fresh extension install always populates the
 *     knowledge graph + workspace memory before the first user prompt.
 *   - **Subsequent activations**: gated by `SEEDING_INTERVAL_MS` (24 h) to
 *     avoid redundant heavy harvests.
 */
export async function seedCacheFromWorkspace(
  context: vscode.ExtensionContext,
  options?: { force?: boolean; skipChatHistory?: boolean },
): Promise<void> {
  try {
    const force = options?.force === true;
    const skipChatHistory = options?.skipChatHistory === true;
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const workspaceId = computeWorkspaceId(workspaceRoot);
    const seededKey = `${SEEDING_DONE_KEY}.${workspaceId}`;
    const bootstrapKey = `${BOOTSTRAP_DONE_KEY}.${workspaceId}`;
    const hasBootstrapped = context.globalState.get<boolean>(bootstrapKey) === true;
    const lastSeeded = context.globalState.get<number>(seededKey) ?? 0;

    // Rescue data indexed under a legacy (pre-canonicalization) id. This must
    // run BEFORE the seeding gate below, otherwise an already-bootstrapped
    // workspace whose seeding is throttled would never migrate its old rows —
    // leaving the panel reading an empty canonical id.
    const dbPath = getDbPath(context);
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    if (workspaceRoot) {
      await migrateLegacyWorkspaceIds(context, workspaceRoot, dbPath);
    }

    if (!force && hasBootstrapped && Date.now() - lastSeeded < SEEDING_INTERVAL_MS) { return; }

    const seeds: string[] = [];
    // Chat history is volatile and grows as the user keeps chatting, so a
    // manual refresh that re-harvested it would inflate the knowledge-graph
    // node count on every click. Callers that want a deterministic re-index
    // (e.g. the panel's Refresh button) pass skipChatHistory; the background
    // enrich timer + activation bootstrap still ingest chat history.
    if (!skipChatHistory) {
      seeds.push(...harvestChatHistory(context));
    }
    if (workspaceRoot) {
      seeds.push(...harvestGitLog(workspaceRoot));
      seeds.push(...harvestInstructionFiles(workspaceRoot));
      seeds.push(...harvestPackageJson(workspaceRoot));
      seeds.push(...harvestReadme(workspaceRoot));
    }

    const unique = [...new Set(
      seeds.map((s) => s.trim()).filter((s) => s.length >= MIN_SEED_LEN && s.length <= 400),
    )].slice(0, MAX_SEED_COUNT);

    if (unique.length > 0) {
      const cliArgs = ['--seed-batch', '--db', dbPath, '--workspace-id', workspaceId];
      if (workspaceRoot) { cliArgs.push('--workspace-root', workspaceRoot); }
      await runEngineRawAsync(cliArgs, { input: JSON.stringify(unique), timeoutMs: SEED_TIMEOUT_MS });
    } else if (workspaceRoot) {
      // No prompts to seed but we still want workspace memory + KG primed.
      // A single synthetic harvest prompt is enough to trigger the engine's
      // augmented-sections pipeline (memory ingestion + repo-stack KG nodes).
      await runEngineRawAsync(
        ['--seed-batch', '--db', dbPath, '--workspace-id', workspaceId, '--workspace-root', workspaceRoot],
        {
          input: JSON.stringify(['Summarize the architecture and conventions of this codebase.']),
          timeoutMs: SEED_TIMEOUT_MS,
        },
      );
    }

    await context.globalState.update(seededKey, Date.now());
    await context.globalState.update(bootstrapKey, true);
  } catch {
    /* never surface seeding errors to the user */
  }
}

/**
 * Lightweight delta enrichment: harvests only Copilot chat history (fast —
 * single SQLite read) and pushes any new prompts into the engine so the
 * knowledge graph + cache absorb conversations as they happen.  Safe to call
 * on a timer while VS Code is open.
 */
export async function enrichFromChatHistory(
  context: vscode.ExtensionContext,
): Promise<void> {
  try {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const workspaceId = computeWorkspaceId(workspaceRoot);
    const prompts = harvestChatHistory(context).filter((p) => p.length >= MIN_SEED_LEN && p.length <= 400);
    if (prompts.length === 0) { return; }

    const dbPath = getDbPath(context);
    const cliArgs = ['--seed-batch', '--db', dbPath, '--workspace-id', workspaceId];
    if (workspaceRoot) { cliArgs.push('--workspace-root', workspaceRoot); }
    // The engine deduplicates via the semantic cache + KG upserts, so re-sending
    // already-seen prompts is cheap and idempotent.
    await runEngineRawAsync(cliArgs, {
      input: JSON.stringify(prompts.slice(0, 50)),
      timeoutMs: SEED_TIMEOUT_MS,
    });
  } catch {
    /* silent — enrichment is best-effort */
  }
}

/**
 * Imports prompts harvested from GitHub Copilot Chat into Prompt Optimizer's
 * conversation memory so they can be replayed as enrichment context.
 *
 * These imported entries are tagged as `copilot-history`, allowing the chat
 * handler to include them for LM context while keeping back-reference logic
 * focused on direct @promptoptimizer turns.
 */
export async function syncCopilotChatsToConversationMemory(
  context: vscode.ExtensionContext,
): Promise<number> {
  try {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const workspaceId = computeWorkspaceId(workspaceRoot);

    const harvested = harvestChatHistory(context)
      .map((p) => p.trim())
      .filter((p) => p.length >= MIN_SEED_LEN && p.length <= 400)
      .slice(-MAX_COPILOT_IMPORT_PER_SYNC);

    if (harvested.length === 0) { return 0; }

    const all = getConversation(context);
    const existing = new Set(
      all
        .filter((turn) => turn.workspace_id === workspaceId)
        .map((turn) => normalizePromptText(turn.user_raw)),
    );

    const now = Date.now();
    const toInsert: ConversationTurn[] = [];
    for (const [idx, prompt] of harvested.entries()) {
      const normalized = normalizePromptText(prompt);
      if (!normalized || existing.has(normalized)) { continue; }
      existing.add(normalized);
      toInsert.push({
        id: `copilot-${(now + idx).toString(36)}`,
        timestamp: now - (harvested.length - idx) * 1000,
        user_raw: prompt,
        user_optimized: prompt,
        assistant: '',
        workspace_id: workspaceId,
        source: 'copilot-history',
      });
    }

    if (toInsert.length === 0) { return 0; }

    all.push(...toInsert);
    while (all.length > MAX_CONVERSATION_TURNS * 3) { all.shift(); }
    await context.globalState.update(CONVERSATION_KEY, all);
    return toInsert.length;
  } catch {
    return 0;
  }
}

/**
 * Reactive memory ingestion: triggered when a workspace memory file is saved
 * (AGENTS.md, CLAUDE.md, .promptoptimizer/memory.md, etc.).  Sends one
 * synthetic harvest prompt so the engine re-reads memory files and writes
 * them into the `workspace_memory` table.
 */
export async function ingestMemoryFiles(
  context: vscode.ExtensionContext,
): Promise<void> {
  try {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) { return; }
    const workspaceId = computeWorkspaceId(workspaceRoot);
    const dbPath = getDbPath(context);
    await runEngineRawAsync(
      ['--seed-batch', '--db', dbPath, '--workspace-id', workspaceId, '--workspace-root', workspaceRoot],
      {
        input: JSON.stringify(['Refresh long-lived memory and project conventions for this workspace.']),
        timeoutMs: SEED_TIMEOUT_MS,
      },
    );
  } catch {
    /* silent */
  }
}
