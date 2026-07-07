import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { BOOTSTRAP_DONE_KEY, SEEDING_DONE_KEY, SEEDING_INTERVAL_MS } from '../constants';
import { getDbPath } from '../state/config';
import { computeLegacyWorkspaceIds, computeWorkspaceId } from '../util/workspace';
import { runEngineRawAsync } from './runner';
import {
  harvestChatHistory,
  harvestGitLog,
  harvestInstructionFiles,
  harvestPackageJson,
  harvestReadme,
  MIN_SEED_LEN,
  SEED_TIMEOUT_MS,
} from './seedHarvest';

export { syncCopilotChatsToConversationMemory } from './chatHistorySync';

const MAX_SEED_COUNT = 200;
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
    if (options?.skipChatHistory !== true) {
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

    const cliArgs = ['--seed-batch', '--db', getDbPath(context), '--workspace-id', workspaceId];
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
    await runEngineRawAsync(
      ['--seed-batch', '--db', getDbPath(context), '--workspace-id', workspaceId, '--workspace-root', workspaceRoot],
      {
        input: JSON.stringify(['Refresh long-lived memory and project conventions for this workspace.']),
        timeoutMs: SEED_TIMEOUT_MS,
      },
    );
  } catch {
    /* silent */
  }
}
