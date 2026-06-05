import * as fs from 'node:fs';
import * as path from 'node:path';

import { detectInstructionStudioConflicts } from './instructionStudioConflicts.js';
import { parseInstructionStudioGraph, type InstructionStudioGraph } from './instructionStudio.js';
import type { InstructionStudioLineageRow, InstructionStudioRuleUsageRow } from './instructionStudioTelemetry.js';

const STUDIO_DIR = '.instruction_studio';
const AGENT_DIR = '.agent';

export interface InstructionStudioRuleMetric {
  rule: string;
  count: number;
}

export interface InstructionStudioInsights {
  compileCount: number;
  activeRules: number;
  inactiveRules: number;
  mostUsedRules: InstructionStudioRuleMetric[];
  unusedRules: string[];
  conflictingRules: number;
  conflictCodes: Record<string, number>;
  effectiveness: {
    executedActiveRules: number;
    activeRules: number;
    score: number;
  };
}

export interface InstructionStudioReplayStep {
  type: 'execution' | 'rule' | 'lineage';
  timestamp: string;
  title: string;
  detail: string;
}

export interface InstructionStudioReplaySession {
  sessionId: string;
  workflowName: string;
  timestamp: string;
  steps: InstructionStudioReplayStep[];
}

function readJsonArray<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    return Array.isArray(raw) ? (raw as T[]) : [];
  } catch {
    return [];
  }
}

function latestLayoutPath(workspaceRoot: string): string | undefined {
  const historyRoot = path.join(workspaceRoot, STUDIO_DIR, 'history');
  if (!fs.existsSync(historyRoot)) {
    return undefined;
  }
  const dirs = fs.readdirSync(historyRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => /^v\d+$/.test(name))
    .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  if (dirs.length === 0) {
    return undefined;
  }
  return path.join(historyRoot, dirs[dirs.length - 1], 'layout.json');
}

function readLatestGraph(workspaceRoot: string): InstructionStudioGraph | undefined {
  const file = latestLayoutPath(workspaceRoot);
  if (!file || !fs.existsSync(file)) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    return parseInstructionStudioGraph(parsed);
  } catch {
    return undefined;
  }
}

function normalizeRuleText(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

export function summarizeInstructionStudioInsights(workspaceRoot: string): InstructionStudioInsights {
  const traceRows = readJsonArray<{ sessionId?: string }>(path.join(workspaceRoot, STUDIO_DIR, 'trace-log.json'));
  const ruleUsage = readJsonArray<InstructionStudioRuleUsageRow>(path.join(workspaceRoot, AGENT_DIR, 'rule-usage.json'));
  const graph = readLatestGraph(workspaceRoot);

  const usageByRuleText = new Map<string, number>();
  for (const row of ruleUsage) {
    const key = normalizeRuleText(String((row as any).ruleText || (row as any).rule || (row as any).ruleId || ''));
    if (!key) {
      continue;
    }
    usageByRuleText.set(key, (usageByRuleText.get(key) ?? 0) + 1);
  }

  const mostUsedRules = [...usageByRuleText.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([rule, count]) => ({ rule, count }));

  const activeRules = graph
    ? graph.nodes.filter((n) => n.type === 'rule' && n.active !== false && normalizeRuleText(n.text ?? n.label ?? '')).length
    : 0;
  const inactiveRules = graph
    ? graph.nodes.filter((n) => n.type === 'rule' && n.active === false && normalizeRuleText(n.text ?? n.label ?? '')).length
    : 0;

  const graphRules = graph
    ? graph.nodes
        .filter((n) => n.type === 'rule')
        .map((n) => ({ text: normalizeRuleText(n.text ?? n.label ?? ''), active: n.active !== false }))
        .filter((n) => n.text.length > 0)
    : [];

  const unusedRules = graphRules
    .filter((r) => (r.active && !usageByRuleText.has(r.text)) || !r.active)
    .map((r) => r.text)
    .slice(0, 10);

  const conflicts = graph ? detectInstructionStudioConflicts(graph) : [];
  const conflictCodes: Record<string, number> = {};
  for (const c of conflicts) {
    conflictCodes[c.code] = (conflictCodes[c.code] ?? 0) + 1;
  }

  const executedActiveRules = usageByRuleText.size;
  const denom = activeRules || 1;
  const score = Math.max(0, Math.min(100, Math.round((executedActiveRules / denom) * 100)));

  return {
    compileCount: traceRows.length,
    activeRules,
    inactiveRules,
    mostUsedRules,
    unusedRules,
    conflictingRules: conflicts.length,
    conflictCodes,
    effectiveness: {
      executedActiveRules,
      activeRules,
      score,
    },
  };
}

export function loadInstructionStudioReplay(
  workspaceRoot: string,
  sessionId?: string,
): { sessions: InstructionStudioReplaySession[]; activeSessionId: string | null } {
  const executionRows = readJsonArray<any>(path.join(workspaceRoot, AGENT_DIR, 'execution-log.json'));
  const ruleRows = readJsonArray<InstructionStudioRuleUsageRow>(path.join(workspaceRoot, AGENT_DIR, 'rule-usage.json'));
  const lineageRows = readJsonArray<InstructionStudioLineageRow>(path.join(workspaceRoot, AGENT_DIR, 'lineage.json'));

  const sessions = executionRows.map((row) => {
    const sid = String(row.sessionId || '');
    const relatedRules = ruleRows.filter((r) => String((r as any).sessionId || '') === sid);
    const relatedLineage = lineageRows.filter((l) => String((l as any).sessionId || '') === sid);

    const steps: InstructionStudioReplayStep[] = [
      {
        type: 'execution',
        timestamp: String(row.timestamp || ''),
        title: `${String(row.workflowName || 'Workflow')} · v${String(row.versionIndex || 0)}`,
        detail: `Active ${Number(row.activeRuleCount || 0)} / Disabled ${Number(row.inactiveRuleCount || 0)} rules`,
      },
      ...relatedRules.map((r) => ({
        type: 'rule' as const,
        timestamp: String((r as any).timestamp || row.timestamp || ''),
        title: `Rule ${(r as any).ruleId || 'unknown'}`,
        detail: `${String((r as any).status || 'executed')} · confidence ${Number((r as any).confidence || 0).toFixed(2)}`,
      })),
      ...relatedLineage.map((l) => ({
        type: 'lineage' as const,
        timestamp: String((l as any).timestamp || row.timestamp || ''),
        title: `${String((l as any).modifiedBy || 'Persona')} -> ${String((l as any).file || 'file')}`,
        detail: String((l as any).rule || ''),
      })),
    ];

    return {
      sessionId: sid,
      workflowName: String(row.workflowName || 'Workflow'),
      timestamp: String(row.timestamp || ''),
      steps,
    };
  }).filter((s) => s.sessionId.length > 0);

  sessions.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const reversed = sessions.reverse();
  const activeSessionId = sessionId && reversed.some((s) => s.sessionId === sessionId)
    ? sessionId
    : (reversed[0]?.sessionId ?? null);

  return {
    sessions: reversed,
    activeSessionId,
  };
}
