import * as fs from 'node:fs';
import * as path from 'node:path';

import { PromptProxyEngine } from '../PromptProxyEngine.js';
import { recallMemory, type RecallScope } from '../engine/memoryRecall.js';
import { syncCopilotInstructions } from '../engine/copilotInstructions.js';
import { getGlobalDbPath } from '../engine/globalMemory.js';

/**
 * CLI handlers for the Phase A memory channels.  Kept in their own module so
 * `src/cli.ts` only adds three one-line dispatch entries.  All three handlers
 * delegate to the shared `MemoryRecallService` / writer so behavior is
 * identical to the LM tool and chat variable surfaces.
 */

export interface CliArgReader {
  args: string[];
  resolveArg(flag: string): string | undefined;
  resolveDbPath(): string | undefined;
}

/** Build the helper shape from the CLI's raw argv. */
export function makeReader(args: string[]): CliArgReader {
  return {
    args,
    resolveArg(flag) {
      const idx = args.indexOf(flag);
      return idx !== -1 ? args[idx + 1] : undefined;
    },
    resolveDbPath() {
      const idx = args.indexOf('--db');
      return idx !== -1 ? args[idx + 1] : undefined;
    },
  };
}

/** `--recall-memory [--query "..."] [--workspace <id>] [--scope ...] [--limit N]` */
export async function handleRecallMemory(args: string[]): Promise<void> {
  const reader = makeReader(args);
  const dbPath = reader.resolveDbPath();
  const workspaceId   = reader.resolveArg('--workspace');
  const workspaceRoot = reader.resolveArg('--workspace-root');
  const scopeRaw = (reader.resolveArg('--scope') ?? 'all').toLowerCase();
  const scope: RecallScope = scopeRaw === 'workspace' || scopeRaw === 'user' ? scopeRaw : 'all';
  const query = reader.resolveArg('--query') ?? '';
  const limit = Number.parseInt(reader.resolveArg('--limit') ?? '8', 10);
  const format = (reader.resolveArg('--format') ?? 'json').toLowerCase();

  const engine = new PromptProxyEngine(dbPath ? { db_path: dbPath } : {});
  try {
    await engine.initialize();
    const federation = engine.getFederation() ?? undefined;
    const db = (engine as unknown as { cacheManager: { rawDatabase(): unknown } })
      .cacheManager.rawDatabase() as Parameters<typeof recallMemory>[0];
    const result = recallMemory(db, federation ?? undefined, {
      query,
      workspaceId,
      scope,
      limit,
      workspaceRoot,
    });
    if (format === 'markdown' || format === 'md') {
      process.stdout.write(result.formatted + '\n');
    } else {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    }
  } finally {
    engine.close();
  }
}

/**
 * `--export-memory [--tier workspace|user|all] [--workspace <id>]
 *                  [--workspace-root <path>] [--out <file.json|file.md>]`
 *
 * A no-query bulk dump of the recall service — useful for backups, audits,
 * and shipping memory between machines.  Tier names map 1:1 to recall
 * scopes; `team` is reserved for Phase B and currently aliases to `user`.
 */
export async function handleExportMemory(args: string[]): Promise<void> {
  const reader = makeReader(args);
  const dbPath = reader.resolveDbPath();
  const workspaceId   = reader.resolveArg('--workspace');
  const workspaceRoot = reader.resolveArg('--workspace-root');
  const out = reader.resolveArg('--out');
  const tier = (reader.resolveArg('--tier') ?? 'workspace').toLowerCase();
  const scope: RecallScope =
      tier === 'user' || tier === 'team' ? 'user'
    : tier === 'all' ? 'all'
    : 'workspace';
  const limit = Number.parseInt(reader.resolveArg('--limit') ?? '50', 10);

  const engine = new PromptProxyEngine(dbPath ? { db_path: dbPath } : {});
  try {
    await engine.initialize();
    const federation = engine.getFederation() ?? undefined;
    const db = (engine as unknown as { cacheManager: { rawDatabase(): unknown } })
      .cacheManager.rawDatabase() as Parameters<typeof recallMemory>[0];
    const result = recallMemory(db, federation ?? undefined, {
      query: '',
      workspaceId,
      scope,
      limit,
      workspaceRoot,
    });

    const isMarkdown = !!out && /\.md$/i.test(out);
    const payload = isMarkdown ? result.formatted : JSON.stringify({
      version: 1,
      generated_at: new Date().toISOString(),
      tier,
      scope,
      workspace_id: workspaceId ?? 'global',
      global_db_path: getGlobalDbPath(),
      entries: result.entries,
    }, null, 2);

    if (out) {
      fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
      fs.writeFileSync(out, payload, { encoding: 'utf8' });
      process.stdout.write(JSON.stringify({
        ok: true, path: path.resolve(out), bytes: Buffer.byteLength(payload, 'utf8'),
        entries: result.entries.length, tier, scope,
      }, null, 2) + '\n');
    } else {
      process.stdout.write(payload + '\n');
    }
  } finally {
    engine.close();
  }
}

/**
 * `--sync-copilot-instructions --workspace-root <path> [--workspace <id>]`
 *
 * Auto-maintains `.github/copilot-instructions.md` so GitHub Copilot (which
 * always reads that file) sees Prompt Optimizer's harvested workspace
 * memory between idempotent markers.
 */
export async function handleSyncCopilotInstructions(args: string[]): Promise<void> {
  const reader = makeReader(args);
  const workspaceRoot = reader.resolveArg('--workspace-root') ?? process.cwd();
  const workspaceId   = reader.resolveArg('--workspace');
  const dbPath        = reader.resolveDbPath();

  // Open the engine (when a DB path is available) so the writer can append
  // compact knowledge-graph + studied-file highlights to the always-on
  // Copilot channel. Falls back to memory-files-only when no DB is given.
  if (!dbPath) {
    const report = syncCopilotInstructions({ workspaceRoot, workspaceId });
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return;
  }

  const engine = new PromptProxyEngine({ db_path: dbPath });
  try {
    await engine.initialize();
    const db = (engine as unknown as { cacheManager: { rawDatabase(): unknown } })
      .cacheManager.rawDatabase() as Parameters<typeof syncCopilotInstructions>[0]['db'];
    const report = syncCopilotInstructions({ workspaceRoot, workspaceId, db });
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } finally {
    engine.close();
  }
}
