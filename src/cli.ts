#!/usr/bin/env node

import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { PromptOptimizationRequest, PromptProxyEngineOptions } from './contracts.js';
import { PromptProxyEngine } from './PromptProxyEngine.js';
import { SemanticCacheManager } from './SemanticCacheManager.js';
import { PromptEvalEngine } from './PromptEvalEngine.js';
import { listRegisteredModes, listSkillErrors } from './engine/promptModes.js';
import { buildInstructionsOverview } from './engine/instructionsManager.js';
import {
  compileInstructionStudioGraph,
  parseInstructionStudioGraph,
  writeInstructionStudioSnapshot,
} from './engine/instructionStudio.js';
import { detectInstructionStudioConflicts } from './engine/instructionStudioConflicts.js';
import { INSTRUCTION_STUDIO_PRESETS } from './engine/instructionStudioPresets.js';
import {
  deleteInstructionStudioCustomPersona,
  listInstructionStudioCustomPersonas,
  saveInstructionStudioCustomPersona,
} from './engine/instructionStudioPersonas.js';
import {
  appendInstructionStudioTraceEntry,
  listInstructionStudioTraceEntries,
  summarizeInstructionStudioTrace,
} from './engine/instructionStudioTrace.js';
import { writeInstructionStudioTelemetryArtifacts } from './engine/instructionStudioTelemetry.js';
import {
  loadInstructionStudioReplay,
  summarizeInstructionStudioInsights,
} from './engine/instructionStudioInsights.js';
import { runHealthCheck } from './engine/health.js';
import { exportDatabase } from './engine/backup.js';
import { redactForPersistence } from './engine/redactor.js';
import {
  handleRecallMemory,
  handleExportMemory,
  handleSyncCopilotInstructions,
} from './cli/memoryCommands.js';

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
      '   or: prompt-proxy-engine --prompt "your prompt" [--target-model <claude|gpt|gemini|local>] [--db <path>]\n' +
      '   or: prompt-proxy-engine --benchmark <benchmark_config.json> [--db <path>]\n' +
      '   or: prompt-proxy-engine --cache-stats [--db <path>]\n' +
      '   or: prompt-proxy-engine --clear-cache [--db <path>]\n' +
      '   or: prompt-proxy-engine --peer-list [--db <path>]\n' +
      '   or: prompt-proxy-engine --peer-add --label <name> --peer-db <path> [--db <path>]\n' +
      '   or: prompt-proxy-engine --peer-remove --peer-db <path> [--db <path>]\n' +
      '   or: prompt-proxy-engine --peer-toggle --peer-db <path> [--enabled true|false] [--db <path>]\n' +
      '   or: prompt-proxy-engine --kg-stats [--workspace <id>] [--db <path>]\n' +
      '   or: prompt-proxy-engine --reset-graph [--workspace <id>] [--db <path>]\n' +
      '   or: prompt-proxy-engine --digest-stats [--workspace <id>] [--db <path>]\n' +
      '   or: prompt-proxy-engine --digest-list --workspace <id> [--limit <n>] [--db <path>]\n' +
      '   or: prompt-proxy-engine --digest-clear [--workspace <id>] [--db <path>]\n' +
      '   or: prompt-proxy-engine --health-check [--db <path>]\n' +
      '   or: prompt-proxy-engine --metrics [--reset] [--db <path>]\n' +
      '   or: prompt-proxy-engine --metrics-otlp [--otlp-endpoint <url>] [--db <path>]\n' +
      '   or: prompt-proxy-engine --schema (prints schemas/contracts.schema.json)\n' +
      '   or: prompt-proxy-engine --audit-log [--limit N] [--verify] [--db <path>]\n' +
      '   or: prompt-proxy-engine --db-prune [--max-cache N] [--max-digests N] [--max-kg N] [--older-than-days N] [--vacuum] [--db <path>]\n' +
      '   or: prompt-proxy-engine --export-db <destination.db> [--db <path>]\n' +
      '   or: prompt-proxy-engine --recall-memory [--query "..."] [--workspace <id>] [--scope workspace|user|all] [--limit N] [--format json|markdown] [--db <path>]\n' +
      '   or: prompt-proxy-engine --export-memory [--tier workspace|user|all] [--workspace <id>] [--out <file.json|.md>] [--db <path>]\n' +
      '   or: prompt-proxy-engine --sync-copilot-instructions --workspace-root <path> [--workspace <id>]\n' +
      '   or: prompt-proxy-engine --instructions-overview --workspace-root <path> [--persona-dir <path>]\n' +
      '   or: prompt-proxy-engine --instruction-studio-presets\n' +
      '   or: prompt-proxy-engine --instruction-studio-personas-list --workspace-root <path>\n' +
      '   or: prompt-proxy-engine --instruction-studio-persona-save --workspace-root <path> (reads persona JSON from stdin)\n' +
      '   or: prompt-proxy-engine --instruction-studio-persona-delete --workspace-root <path> --id <persona-id>\n' +
      '   or: prompt-proxy-engine --instruction-studio-trace-list --workspace-root <path> [--limit N]\n' +
      '   or: prompt-proxy-engine --instruction-studio-trace-append --workspace-root <path> (reads trace JSON from stdin)\n' +
      '   or: prompt-proxy-engine --instruction-studio-trace-analytics --workspace-root <path>\n' +
      '   or: prompt-proxy-engine --instruction-studio-insights --workspace-root <path>\n' +
      '   or: prompt-proxy-engine --instruction-studio-replay --workspace-root <path> [--session-id <id>]\n' +
      '   or: prompt-proxy-engine --instruction-studio-conflicts (reads graph JSON from stdin)\n' +
      '   or: prompt-proxy-engine --instruction-studio-compile --workspace-root <path> (reads graph JSON from stdin)\n' +
      '   or: prompt-proxy-engine --redact-test (reads stdin, prints redacted output)\n'
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
  const wsRoot = resolveArg(args, '--workspace-root');
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
  // Pass workspace_root in ide_context so the engine's collectAugmentedSections
  // also harvests AGENTS.md / CLAUDE.md / .promptoptimizer/memory.md and the
  // knowledge-graph receives nodes/edges for every bootstrap prompt.
  const ideContext = wsRoot ? { workspace_root: wsRoot } : undefined;
  for (const raw of prompts) {
    if (!raw?.trim()) { continue; }
    try {
      await engine.processRequest({
        raw_prompt: raw,
        mode: 'blocking',
        workspace_id: wsId,
        ide_context: ideContext,
        seeding: true,
      });
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

/**
 * Cross-workspace + knowledge-graph admin endpoints.  All of these reuse the
 * already-running engine so the SQLite schema is applied consistently.
 */
async function handlePeerCommand(args: string[]): Promise<void> {
  const engine = new PromptProxyEngine(resolveDbPath(args) ? { db_path: resolveDbPath(args) } : {});
  await engine.initialize();
  try {
    const federation = engine.getFederation();
    if (!federation) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: 'federation unavailable' })}\n`);
      return;
    }
    if (args.includes('--peer-list')) {
      process.stdout.write(`${JSON.stringify({ ok: true, peers: federation.list() })}\n`);
      return;
    }
    if (args.includes('--peer-add')) {
      const label = resolveArg(args, '--label') ?? 'peer';
      const peerDb = resolveArg(args, '--peer-db');
      if (!peerDb) { throw new Error('--peer-add requires --peer-db <path>'); }
      const result = federation.addPeer(label, peerDb);
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return;
    }
    if (args.includes('--peer-remove')) {
      const peerDb = resolveArg(args, '--peer-db');
      if (!peerDb) { throw new Error('--peer-remove requires --peer-db <path>'); }
      const ok = federation.removePeer(peerDb);
      process.stdout.write(`${JSON.stringify({ ok })}\n`);
      return;
    }
    if (args.includes('--peer-toggle')) {
      const peerDb = resolveArg(args, '--peer-db');
      const enabled = resolveArg(args, '--enabled') !== 'false';
      if (!peerDb) { throw new Error('--peer-toggle requires --peer-db <path>'); }
      const ok = federation.setEnabled(peerDb, enabled);
      process.stdout.write(`${JSON.stringify({ ok })}\n`);
      return;
    }
  } finally {
    engine.close();
  }
}

async function handleKgStats(args: string[]): Promise<void> {
  const engine = new PromptProxyEngine(resolveDbPath(args) ? { db_path: resolveDbPath(args) } : {});
  await engine.initialize();
  try {
    const kg = engine.getKnowledgeGraph();
    if (!kg) {
      process.stdout.write(`${JSON.stringify({ nodes: 0, edges: 0 })}\n`);
      return;
    }
    const workspace = resolveArg(args, '--workspace');
    process.stdout.write(`${JSON.stringify(kg.stats(workspace))}\n`);
  } finally {
    engine.close();
  }
}

async function handleResetGraph(args: string[]): Promise<void> {
  const engine = new PromptProxyEngine(resolveDbPath(args) ? { db_path: resolveDbPath(args) } : {});
  await engine.initialize();
  try {
    const kg = engine.getKnowledgeGraph();
    if (!kg) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: 'knowledge graph unavailable' })}\n`);
      return;
    }
    const workspace = resolveArg(args, '--workspace') ?? 'global';
    const removed = kg.clearGraph(workspace);
    process.stdout.write(`${JSON.stringify({ ok: true, workspace, removed_nodes: removed })}\n`);
  } finally {
    engine.close();
  }
}

async function handleDigestStats(args: string[]): Promise<void> {
  const engine = new PromptProxyEngine(resolveDbPath(args) ? { db_path: resolveDbPath(args) } : {});
  await engine.initialize();
  try {
    const store = engine.getFileDigestStore();
    const workspace = resolveArg(args, '--workspace');
    const stats = store ? store.stats(workspace) : { files: 0, total_visits: 0, last_updated: null };
    process.stdout.write(`${JSON.stringify(stats)}\n`);
  } finally {
    engine.close();
  }
}

async function handleDigestList(args: string[]): Promise<void> {
  const workspace = resolveArg(args, '--workspace');
  if (!workspace) {
    process.stderr.write('Error: --digest-list requires --workspace <id>.\n');
    process.exitCode = 1;
    return;
  }
  const limitStr = resolveArg(args, '--limit');
  const limit = limitStr ? Math.max(1, Math.min(500, Number(limitStr) || 50)) : 50;
  const engine = new PromptProxyEngine(resolveDbPath(args) ? { db_path: resolveDbPath(args) } : {});
  await engine.initialize();
  try {
    const store = engine.getFileDigestStore();
    const rows = store ? store.list(workspace, limit) : [];
    process.stdout.write(`${JSON.stringify(rows)}\n`);
  } finally {
    engine.close();
  }
}

async function handleDigestClear(args: string[]): Promise<void> {
  const workspace = resolveArg(args, '--workspace');
  const engine = new PromptProxyEngine(resolveDbPath(args) ? { db_path: resolveDbPath(args) } : {});
  await engine.initialize();
  try {
    const store = engine.getFileDigestStore();
    const removed = store ? store.clear(workspace) : 0;
    process.stdout.write(`${JSON.stringify({ removed })}\n`);
  } finally {
    engine.close();
  }
}

async function handleHealthCheck(args: string[]): Promise<void> {
  const dbPath = resolveDbPath(args) ?? 'prompt_semantic_cache.db';
  const engine = new PromptProxyEngine({ db_path: dbPath });
  await engine.initialize();
  try {
    const db = engine.getCacheManager().rawDatabase();
    const report = runHealthCheck(db, engine.getCacheManager().databasePath());
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.ok) { process.exitCode = 2; }
  } finally {
    engine.close();
  }
}

async function handleMetrics(args: string[]): Promise<void> {
  const reset = args.includes('--reset');
  const engine = new PromptProxyEngine(resolveDbPath(args) ? { db_path: resolveDbPath(args) } : {});
  await engine.initialize();
  try {
    const metrics = engine.getCacheManager().metrics();
    if (!metrics) {
      process.stdout.write(`${JSON.stringify({ counters: [] })}\n`);
      return;
    }
    if (reset) {
      const removed = metrics.reset();
      process.stdout.write(`${JSON.stringify({ reset: true, removed })}\n`);
      return;
    }
    process.stdout.write(`${JSON.stringify({ counters: metrics.snapshot() }, null, 2)}\n`);
  } finally {
    engine.close();
  }
}

async function handleMetricsOtlp(args: string[]): Promise<void> {
  const { snapshotAsOtlp, pushOtlp } = await import('./engine/otlp.js');
  const endpoint = resolveArg(args, '--otlp-endpoint') ?? process.env.PROMPT_OPT_OTLP_ENDPOINT;
  const engine = new PromptProxyEngine(resolveDbPath(args) ? { db_path: resolveDbPath(args) } : {});
  await engine.initialize();
  try {
    const metrics = engine.getCacheManager().metrics();
    if (!metrics) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: 'metrics unavailable' })}\n`);
      process.exitCode = 1;
      return;
    }
    const envelope = snapshotAsOtlp(metrics);
    if (!endpoint) {
      // No endpoint — print the OTLP/JSON payload so a sidecar can pipe it.
      process.stdout.write(`${JSON.stringify(envelope)}\n`);
      return;
    }
    const result = await pushOtlp(endpoint, envelope);
    process.stdout.write(`${JSON.stringify({ endpoint, ...result })}\n`);
    if (!result.ok) { process.exitCode = 1; }
  } finally {
    engine.close();
  }
}

function handleSchemaPrint(): void {
  // schemas/ ships beside the package; resolve relative to this module.
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')) ;
  const candidates = [
    path.resolve(here, '..', 'schemas', 'contracts.schema.json'),
    path.resolve(here, '..', '..', 'schemas', 'contracts.schema.json'),
    path.resolve(process.cwd(), 'schemas', 'contracts.schema.json'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      process.stdout.write(fs.readFileSync(candidate, 'utf8'));
      if (!fs.readFileSync(candidate, 'utf8').endsWith('\n')) {
        process.stdout.write('\n');
      }
      return;
    }
  }
  process.stderr.write('Error: contracts.schema.json not found.\n');
  process.exitCode = 1;
}

async function handleAuditLog(args: string[]): Promise<void> {
  const { readAuditTail, verifyAuditChain } = await import('./engine/auditLog.js');
  const engine = new PromptProxyEngine(resolveDbPath(args) ? { db_path: resolveDbPath(args) } : {});
  await engine.initialize();
  try {
    const db = engine.getCacheManager().rawDatabase();
    if (args.includes('--verify')) {
      const result = verifyAuditChain(db);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      if (!result.ok) { process.exitCode = 1; }
      return;
    }
    const limitRaw = resolveArg(args, '--limit');
    const limit = limitRaw ? Math.max(1, Number.parseInt(limitRaw, 10) || 100) : 100;
    const rows = readAuditTail(db, limit);
    process.stdout.write(`${JSON.stringify({ rows }, null, 2)}\n`);
  } finally {
    engine.close();
  }
}

async function handleDbPrune(args: string[]): Promise<void> {
  const numArg = (flag: string): number | undefined => {
    const v = resolveArg(args, flag);
    if (v === undefined) { return undefined; }
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const engine = new PromptProxyEngine(resolveDbPath(args) ? { db_path: resolveDbPath(args) } : {});
  await engine.initialize();
  try {
    const service = engine.getMaintenanceService();
    if (!service) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: 'maintenance unavailable' })}\n`);
      process.exitCode = 1;
      return;
    }
    const report = service.run({
      maxCacheEntries:        numArg('--max-cache'),
      maxDigestsPerWorkspace: numArg('--max-digests'),
      maxKgNodesPerWorkspace: numArg('--max-kg'),
      staleCacheAgeDays:      numArg('--older-than-days'),
      staleDigestAgeDays:     numArg('--older-than-days'),
      vacuum:                 args.includes('--vacuum'),
    });
    engine.getCacheManager().metrics()?.increment('maintenance.runs');
    engine.getCacheManager().metrics()?.increment(
      'maintenance.entries_evicted',
      report.evicted.cache_rows + report.evicted.digest_rows + report.evicted.kg_nodes,
    );
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    engine.close();
  }
}

async function handleExportDb(args: string[]): Promise<void> {
  const dest = resolveArg(args, '--export-db');
  if (!dest) {
    process.stderr.write('Error: --export-db requires a destination path.\n');
    process.exitCode = 1;
    return;
  }
  const engine = new PromptProxyEngine(resolveDbPath(args) ? { db_path: resolveDbPath(args) } : {});
  await engine.initialize();
  try {
    const cm = engine.getCacheManager();
    const report = await exportDatabase(cm.rawDatabase(), cm.databasePath(), dest);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.ok) { process.exitCode = 1; }
  } finally {
    engine.close();
  }
}

async function handleRedactTest(): Promise<void> {
  const input = await readStdin();
  const result = redactForPersistence(input);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

/**
 * Combined snapshot used by the VS Code panel to show users that their local
 * indexing is active and growing.  Returns counts for cache, knowledge graph,
 * peer workspaces, and ingested memory files in a single JSON object so the
 * panel can render a status row with one subprocess call.
 */
async function handleStatusOverview(args: string[]): Promise<void> {
  const dbPath = resolveDbPath(args);
  const workspace = resolveArg(args, '--workspace');
  const engine = new PromptProxyEngine(dbPath ? { db_path: dbPath } : {});
  await engine.initialize();
  try {
    const cacheManager = engine.getCacheManager();
    const cacheStats = cacheManager.getStats();
    const kg = engine.getKnowledgeGraph();
    const kgStats = kg ? kg.stats(workspace) : { nodes: 0, edges: 0 };
    const federation = engine.getFederation();
    const peers = federation ? federation.list() : [];
    let memoryCount = 0;
    if (workspace) {
      try {
        const db = cacheManager.rawDatabase();
        const row = db.prepare('SELECT COUNT(*) AS c FROM workspace_memory WHERE workspace_id = ?').get(workspace) as { c: number } | undefined;
        memoryCount = row?.c ?? 0;
      } catch { /* ignore */ }
    }
    const digestStore = engine.getFileDigestStore();
    const digestStats = digestStore ? digestStore.stats(workspace) : { files: 0, total_visits: 0, last_updated: null };
    process.stdout.write(`${JSON.stringify({
      cache: { entries: cacheStats.total_entries, hits: cacheStats.total_hits, avg_confidence: cacheStats.avg_confidence },
      kg: kgStats,
      peers: { total: peers.length, enabled: peers.filter((p) => p.enabled).length },
      memory: { entries: memoryCount },
      digests: digestStats,
    })}\n`);
  } finally {
    engine.close();
  }
}

function handleInstructionsOverview(args: string[]): void {
  const workspaceRoot = resolveArg(args, '--workspace-root') ?? process.cwd();
  const personaDir = resolveArg(args, '--persona-dir');
  const overview = buildInstructionsOverview({ workspaceRoot, personaDir });
  process.stdout.write(`${JSON.stringify(overview)}\n`);
}

async function handleInstructionStudioCompile(args: string[]): Promise<void> {
  const workspaceRoot = resolveArg(args, '--workspace-root');
  if (!workspaceRoot) {
    process.stderr.write('Error: --instruction-studio-compile requires --workspace-root <path>.\n');
    process.exitCode = 1;
    return;
  }

  const stdin = await readStdin();
  let graph: unknown;
  try {
    graph = JSON.parse(stdin);
  } catch {
    process.stderr.write('Error: --instruction-studio-compile expects graph JSON on stdin.\n');
    process.exitCode = 1;
    return;
  }

  const parsedGraph = parseInstructionStudioGraph(graph);
  const compiled = compileInstructionStudioGraph(parsedGraph);
  const result = writeInstructionStudioSnapshot(path.resolve(workspaceRoot), parsedGraph);
  const graphRuleNodes = parsedGraph.nodes.filter((node) =>
    node.type === 'rule' && String(node.text ?? node.label ?? '').trim().length > 0,
  );
  const activeRuleCount = graphRuleNodes.filter((node) => node.active !== false).length;
  const inactiveRuleCount = graphRuleNodes.length - activeRuleCount;
  const firstEntry = compiled.manifest.entries[0];
  if (firstEntry) {
    appendInstructionStudioTraceEntry(path.resolve(workspaceRoot), {
      workflowName: compiled.manifest.workflowName,
      persona: firstEntry.persona,
      condition: firstEntry.condition,
      priority: firstEntry.priority,
      agentScope: firstEntry.agentScope,
      ruleText: firstEntry.text,
      versionIndex: result.versionIndex,
      activeRuleCount,
      inactiveRuleCount,
    });
  }
  writeInstructionStudioTelemetryArtifacts(
    path.resolve(workspaceRoot),
    compiled.manifest,
    result.versionIndex,
    activeRuleCount,
    inactiveRuleCount,
  );
  process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
}

async function handleInstructionStudioPersonasList(args: string[]): Promise<void> {
  const workspaceRoot = resolveArg(args, '--workspace-root');
  if (!workspaceRoot) {
    process.stderr.write('Error: --instruction-studio-personas-list requires --workspace-root <path>.\n');
    process.exitCode = 1;
    return;
  }
  const personas = listInstructionStudioCustomPersonas(path.resolve(workspaceRoot));
  process.stdout.write(`${JSON.stringify({ personas })}\n`);
}

async function handleInstructionStudioPersonaSave(args: string[]): Promise<void> {
  const workspaceRoot = resolveArg(args, '--workspace-root');
  if (!workspaceRoot) {
    process.stderr.write('Error: --instruction-studio-persona-save requires --workspace-root <path>.\n');
    process.exitCode = 1;
    return;
  }
  const stdin = await readStdin();
  let payload: unknown;
  try {
    payload = JSON.parse(stdin);
  } catch {
    process.stderr.write('Error: --instruction-studio-persona-save expects persona JSON on stdin.\n');
    process.exitCode = 1;
    return;
  }
  if (!payload || typeof payload !== 'object') {
    process.stderr.write('Error: persona payload must be an object.\n');
    process.exitCode = 1;
    return;
  }
  const persona = saveInstructionStudioCustomPersona(path.resolve(workspaceRoot), payload as any);
  process.stdout.write(`${JSON.stringify({ ok: true, persona })}\n`);
}

async function handleInstructionStudioPersonaDelete(args: string[]): Promise<void> {
  const workspaceRoot = resolveArg(args, '--workspace-root');
  const id = resolveArg(args, '--id');
  if (!workspaceRoot) {
    process.stderr.write('Error: --instruction-studio-persona-delete requires --workspace-root <path>.\n');
    process.exitCode = 1;
    return;
  }
  if (!id) {
    process.stderr.write('Error: --instruction-studio-persona-delete requires --id <persona-id>.\n');
    process.exitCode = 1;
    return;
  }
  const removed = deleteInstructionStudioCustomPersona(path.resolve(workspaceRoot), id);
  process.stdout.write(`${JSON.stringify({ ok: true, removed })}\n`);
}

async function handleInstructionStudioTraceList(args: string[]): Promise<void> {
  const workspaceRoot = resolveArg(args, '--workspace-root');
  if (!workspaceRoot) {
    process.stderr.write('Error: --instruction-studio-trace-list requires --workspace-root <path>.\n');
    process.exitCode = 1;
    return;
  }
  const limitRaw = resolveArg(args, '--limit');
  const limit = limitRaw ? Math.max(1, Math.min(500, Number(limitRaw) || 50)) : 50;
  const rows = listInstructionStudioTraceEntries(path.resolve(workspaceRoot), limit);
  process.stdout.write(`${JSON.stringify({ rows })}\n`);
}

async function handleInstructionStudioTraceAppend(args: string[]): Promise<void> {
  const workspaceRoot = resolveArg(args, '--workspace-root');
  if (!workspaceRoot) {
    process.stderr.write('Error: --instruction-studio-trace-append requires --workspace-root <path>.\n');
    process.exitCode = 1;
    return;
  }
  const stdin = await readStdin();
  let payload: unknown;
  try {
    payload = JSON.parse(stdin);
  } catch {
    process.stderr.write('Error: --instruction-studio-trace-append expects trace JSON on stdin.\n');
    process.exitCode = 1;
    return;
  }
  if (!payload || typeof payload !== 'object') {
    process.stderr.write('Error: trace payload must be an object.\n');
    process.exitCode = 1;
    return;
  }
  const trace = appendInstructionStudioTraceEntry(path.resolve(workspaceRoot), payload as any);
  process.stdout.write(`${JSON.stringify({ ok: true, trace })}\n`);
}

async function handleInstructionStudioTraceAnalytics(args: string[]): Promise<void> {
  const workspaceRoot = resolveArg(args, '--workspace-root');
  if (!workspaceRoot) {
    process.stderr.write('Error: --instruction-studio-trace-analytics requires --workspace-root <path>.\n');
    process.exitCode = 1;
    return;
  }
  const analytics = summarizeInstructionStudioTrace(path.resolve(workspaceRoot));
  process.stdout.write(`${JSON.stringify({ analytics })}\n`);
}

async function handleInstructionStudioInsights(args: string[]): Promise<void> {
  const workspaceRoot = resolveArg(args, '--workspace-root');
  if (!workspaceRoot) {
    process.stderr.write('Error: --instruction-studio-insights requires --workspace-root <path>.\n');
    process.exitCode = 1;
    return;
  }
  const insights = summarizeInstructionStudioInsights(path.resolve(workspaceRoot));
  process.stdout.write(`${JSON.stringify({ insights })}\n`);
}

async function handleInstructionStudioReplay(args: string[]): Promise<void> {
  const workspaceRoot = resolveArg(args, '--workspace-root');
  if (!workspaceRoot) {
    process.stderr.write('Error: --instruction-studio-replay requires --workspace-root <path>.\n');
    process.exitCode = 1;
    return;
  }
  const sessionId = resolveArg(args, '--session-id');
  const replay = loadInstructionStudioReplay(path.resolve(workspaceRoot), sessionId);
  process.stdout.write(`${JSON.stringify(replay)}\n`);
}

async function handleInstructionStudioConflicts(): Promise<void> {
  const stdin = await readStdin();
  let payload: unknown;
  try {
    payload = JSON.parse(stdin);
  } catch {
    process.stderr.write('Error: --instruction-studio-conflicts expects graph JSON on stdin.\n');
    process.exitCode = 1;
    return;
  }
  const graph = parseInstructionStudioGraph(payload);
  const conflicts = detectInstructionStudioConflicts(graph);
  process.stdout.write(`${JSON.stringify({ conflicts })}\n`);
}

async function handleBenchmark(benchmarkPath: string, dbPath?: string): Promise<void> {
  const absolutePath = path.resolve(benchmarkPath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Benchmark config file not found at ${absolutePath}`);
  }
  const config = JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
  const engine = new PromptProxyEngine(dbPath ? { db_path: dbPath } : {});
  await engine.initialize();
  const evalEngine = new PromptEvalEngine(engine);
  const report = await evalEngine.runBenchmark(config);
  engine.close();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

async function loadRequest(args: string[]): Promise<{ request: PromptOptimizationRequest; options: PromptProxyEngineOptions }> {
  let dbPath: string | undefined;
  let targetModel: string | undefined;
  let request: PromptOptimizationRequest | null = null;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];

    if (arg === '--db') {
      dbPath = args[index + 1];
      index++;
      continue;
    }

    if (arg === '--target-model') {
      targetModel = args[index + 1];
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

  if (targetModel) {
    request.target_model = targetModel as any;
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

  if (args.includes('--peer-list') || args.includes('--peer-add') || args.includes('--peer-remove') || args.includes('--peer-toggle')) {
    await handlePeerCommand(args);
    return;
  }

  if (args.includes('--kg-stats')) {
    await handleKgStats(args);
    return;
  }

  if (args.includes('--reset-graph')) {
    await handleResetGraph(args);
    return;
  }

  if (args.includes('--digest-stats')) {
    await handleDigestStats(args);
    return;
  }

  if (args.includes('--digest-list')) {
    await handleDigestList(args);
    return;
  }

  if (args.includes('--digest-clear')) {
    await handleDigestClear(args);
    return;
  }

  if (args.includes('--health-check')) {
    await handleHealthCheck(args);
    return;
  }

  if (args.includes('--metrics-otlp')) {
    await handleMetricsOtlp(args);
    return;
  }

  if (args.includes('--metrics')) {
    await handleMetrics(args);
    return;
  }

  if (args.includes('--schema')) {
    handleSchemaPrint();
    return;
  }

  if (args.includes('--audit-log')) {
    await handleAuditLog(args);
    return;
  }

  if (args.includes('--db-prune')) {
    await handleDbPrune(args);
    return;
  }

  if (args.includes('--export-db')) {
    await handleExportDb(args);
    return;
  }

  if (args.includes('--redact-test')) {
    await handleRedactTest();
    return;
  }

  if (args.includes('--recall-memory')) {
    await handleRecallMemory(args);
    return;
  }

  if (args.includes('--export-memory')) {
    await handleExportMemory(args);
    return;
  }

  if (args.includes('--sync-copilot-instructions')) {
    await handleSyncCopilotInstructions(args);
    return;
  }

  if (args.includes('--status-overview')) {
    await handleStatusOverview(args);
    return;
  }

  if (args.includes('--instructions-overview')) {
    handleInstructionsOverview(args);
    return;
  }

  if (args.includes('--instruction-studio-compile')) {
    await handleInstructionStudioCompile(args);
    return;
  }

  if (args.includes('--instruction-studio-personas-list')) {
    await handleInstructionStudioPersonasList(args);
    return;
  }

  if (args.includes('--instruction-studio-persona-save')) {
    await handleInstructionStudioPersonaSave(args);
    return;
  }

  if (args.includes('--instruction-studio-persona-delete')) {
    await handleInstructionStudioPersonaDelete(args);
    return;
  }

  if (args.includes('--instruction-studio-trace-list')) {
    await handleInstructionStudioTraceList(args);
    return;
  }

  if (args.includes('--instruction-studio-trace-append')) {
    await handleInstructionStudioTraceAppend(args);
    return;
  }

  if (args.includes('--instruction-studio-trace-analytics')) {
    await handleInstructionStudioTraceAnalytics(args);
    return;
  }

  if (args.includes('--instruction-studio-insights')) {
    await handleInstructionStudioInsights(args);
    return;
  }

  if (args.includes('--instruction-studio-replay')) {
    await handleInstructionStudioReplay(args);
    return;
  }

  if (args.includes('--instruction-studio-conflicts')) {
    await handleInstructionStudioConflicts();
    return;
  }

  if (args.includes('--instruction-studio-presets')) {
    process.stdout.write(`${JSON.stringify({ presets: INSTRUCTION_STUDIO_PRESETS })}\n`);
    return;
  }

  if (args.includes('--list-modes')) {
    const workspaceRoot = resolveArg(args, '--workspace-root') ?? process.cwd();
    const modes = listRegisteredModes(workspaceRoot);
    const errors = listSkillErrors(workspaceRoot);
    process.stdout.write(JSON.stringify({ modes, errors }, null, 2) + '\n');
    return;
  }

  if (args.includes('--benchmark')) {
    const configPath = resolveArg(args, '--benchmark');
    if (!configPath) {
      process.stderr.write('Error: --benchmark requires a configuration file path.\n');
      process.exitCode = 1;
      return;
    }
    await handleBenchmark(configPath, resolveDbPath(args));
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