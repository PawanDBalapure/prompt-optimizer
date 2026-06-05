import * as fs from 'node:fs';
import * as path from 'node:path';

const STUDIO_DIR = '.instruction_studio';
const TRACE_FILE = 'trace-log.json';
const MAX_TRACE_ROWS = 200;

export interface InstructionStudioTraceEntry {
  sessionId: string;
  timestamp: string;
  workflowName: string;
  persona: string;
  condition: string;
  priority: string;
  agentScope: string;
  ruleText: string;
  versionIndex: number;
  activeRuleCount: number;
  inactiveRuleCount: number;
}

export interface InstructionStudioTraceAppendInput {
  workflowName: string;
  persona: string;
  condition: string;
  priority: string;
  agentScope: string;
  ruleText: string;
  versionIndex: number;
  activeRuleCount?: number;
  inactiveRuleCount?: number;
}

export interface InstructionStudioTraceAnalytics {
  compileCount: number;
  topPersona: { name: string; count: number } | null;
  topRulePrefix: { prefix: string; count: number } | null;
}

function tracePath(workspaceRoot: string): string {
  return path.join(workspaceRoot, STUDIO_DIR, TRACE_FILE);
}

function normalizeCount(raw: unknown, fallback: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return fallback;
  }
  return Math.max(0, Math.floor(raw));
}

function normalizeTraceEntry(raw: unknown): InstructionStudioTraceEntry | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const item = raw as Record<string, unknown>;
  const workflowName = String(item.workflowName || '').trim();
  const persona = String(item.persona || '').trim();
  const condition = String(item.condition || '').trim();
  const priority = String(item.priority || '').trim();
  const agentScope = String(item.agentScope || '').trim();
  const ruleText = String(item.ruleText || '').trim();
  const versionIndex = normalizeCount(item.versionIndex, 1);
  if (!workflowName || !persona || !condition || !priority || !agentScope) {
    return null;
  }
  return {
    sessionId: String(item.sessionId || `sess-${Date.now().toString(36)}-legacy`),
    timestamp: String(item.timestamp || new Date().toISOString()),
    workflowName,
    persona,
    condition,
    priority,
    agentScope,
    ruleText,
    versionIndex,
    activeRuleCount: normalizeCount(item.activeRuleCount, 1),
    inactiveRuleCount: normalizeCount(item.inactiveRuleCount, 0),
  };
}

function readTraceEntries(workspaceRoot: string): InstructionStudioTraceEntry[] {
  const file = tracePath(workspaceRoot);
  if (!fs.existsSync(file)) { return []; }
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (!Array.isArray(raw)) { return []; }
    return raw.map((item) => normalizeTraceEntry(item)).filter((item): item is InstructionStudioTraceEntry => !!item);
  } catch {
    return [];
  }
}

function writeTraceEntries(workspaceRoot: string, rows: InstructionStudioTraceEntry[]): void {
  const file = tracePath(workspaceRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(rows, null, 2)}\n`, 'utf8');
}

export function listInstructionStudioTraceEntries(workspaceRoot: string, limit = 50): InstructionStudioTraceEntry[] {
  const rows = readTraceEntries(workspaceRoot);
  const capped = Math.max(1, Math.min(500, Math.floor(limit)));
  return rows.slice(-capped).reverse();
}

export function appendInstructionStudioTraceEntry(
  workspaceRoot: string,
  entryInput: InstructionStudioTraceAppendInput,
): InstructionStudioTraceEntry {
  const entry: InstructionStudioTraceEntry = {
    sessionId: `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    workflowName: entryInput.workflowName,
    persona: entryInput.persona,
    condition: entryInput.condition,
    priority: entryInput.priority,
    agentScope: entryInput.agentScope,
    ruleText: entryInput.ruleText,
    versionIndex: entryInput.versionIndex,
    activeRuleCount: normalizeCount(entryInput.activeRuleCount, 1),
    inactiveRuleCount: normalizeCount(entryInput.inactiveRuleCount, 0),
  };

  const rows = readTraceEntries(workspaceRoot);
  rows.push(entry);
  const next = rows.length > MAX_TRACE_ROWS ? rows.slice(rows.length - MAX_TRACE_ROWS) : rows;
  writeTraceEntries(workspaceRoot, next);
  return entry;
}

function topCount(map: Map<string, number>): { key: string; count: number } | null {
  let bestKey = '';
  let bestCount = 0;
  for (const [key, count] of map.entries()) {
    if (count > bestCount) {
      bestKey = key;
      bestCount = count;
    }
  }
  return bestCount > 0 ? { key: bestKey, count: bestCount } : null;
}

export function summarizeInstructionStudioTrace(
  workspaceRoot: string,
): InstructionStudioTraceAnalytics {
  const rows = readTraceEntries(workspaceRoot);
  const personaCounts = new Map<string, number>();
  const rulePrefixCounts = new Map<string, number>();

  for (const row of rows) {
    const persona = (row.persona || '').trim() || 'Unknown';
    personaCounts.set(persona, (personaCounts.get(persona) ?? 0) + 1);

    const prefix = ((row.ruleText || '').trim().split(/\s+/).slice(0, 4).join(' ') || 'n/a').toLowerCase();
    rulePrefixCounts.set(prefix, (rulePrefixCounts.get(prefix) ?? 0) + 1);
  }

  const topPersona = topCount(personaCounts);
  const topRulePrefix = topCount(rulePrefixCounts);

  return {
    compileCount: rows.length,
    topPersona: topPersona ? { name: topPersona.key, count: topPersona.count } : null,
    topRulePrefix: topRulePrefix ? { prefix: topRulePrefix.key, count: topRulePrefix.count } : null,
  };
}
