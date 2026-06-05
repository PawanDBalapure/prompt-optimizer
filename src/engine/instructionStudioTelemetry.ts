import * as fs from 'node:fs';
import * as path from 'node:path';

import type { InstructionStudioManifest } from './instructionStudio.js';

const AGENT_DIR = '.agent';
const EXECUTION_LOG_FILE = 'execution-log.json';
const LINEAGE_FILE = 'lineage.json';
const RULE_USAGE_FILE = 'rule-usage.json';
const MAX_ROWS = 500;

export interface InstructionStudioPersonaUsage {
  id: string;
  version: string;
}

export interface InstructionStudioRuleUsageRow {
  sessionId: string;
  timestamp: string;
  workflowName: string;
  versionIndex: number;
  ruleId: string;
  status: 'executed';
  confidence: number;
  filesAffected: string[];
}

export interface InstructionStudioLineageRow {
  sessionId: string;
  timestamp: string;
  workflowName: string;
  versionIndex: number;
  file: string;
  modifiedBy: string;
  rule: string;
  commit: string;
}

export interface InstructionStudioExecutionLogRow {
  sessionId: string;
  conversationRef: string;
  timestamp: string;
  workflowName: string;
  versionIndex: number;
  personasActive: InstructionStudioPersonaUsage[];
  activeRuleCount: number;
  inactiveRuleCount: number;
  ruleUsageCount: number;
}

export interface InstructionStudioTelemetryArtifacts {
  sessionId: string;
  files: {
    executionLog: string;
    lineage: string;
    ruleUsage: string;
  };
  rows: {
    execution: InstructionStudioExecutionLogRow;
    lineage: InstructionStudioLineageRow[];
    ruleUsage: InstructionStudioRuleUsageRow[];
  };
}

function readArrayFile<T>(filePath: string): T[] {
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

function appendArrayFile<T>(filePath: string, rowOrRows: T | T[]): T[] {
  const existing = readArrayFile<T>(filePath);
  const incoming = Array.isArray(rowOrRows) ? rowOrRows : [rowOrRows];
  const merged = [...existing, ...incoming];
  const next = merged.length > MAX_ROWS ? merged.slice(merged.length - MAX_ROWS) : merged;
  fs.writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'general';
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter((x) => x.trim().length > 0))].sort((a, b) => a.localeCompare(b));
}

export function writeInstructionStudioTelemetryArtifacts(
  workspaceRoot: string,
  manifest: InstructionStudioManifest,
  versionIndex: number,
  activeRuleCount: number,
  inactiveRuleCount: number,
): InstructionStudioTelemetryArtifacts {
  const agentRoot = path.join(workspaceRoot, AGENT_DIR);
  fs.mkdirSync(agentRoot, { recursive: true });

  const executionLogPath = path.join(agentRoot, EXECUTION_LOG_FILE);
  const lineagePath = path.join(agentRoot, LINEAGE_FILE);
  const ruleUsagePath = path.join(agentRoot, RULE_USAGE_FILE);

  const timestamp = new Date().toISOString();
  const sessionId = `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  const personas = uniqueSorted(manifest.entries.map((entry) => entry.persona || 'General')).map((persona) => ({
    id: slugify(persona),
    version: `v${versionIndex}`,
  }));

  const generatedFiles = [
    '.instruction_studio/instructions.md',
    '.instruction_studio/instruction-manifest.json',
  ];

  const ruleUsageRows: InstructionStudioRuleUsageRow[] = manifest.entries.map((entry) => ({
    sessionId,
    timestamp,
    workflowName: manifest.workflowName,
    versionIndex,
    ruleId: entry.nodeId,
    status: 'executed',
    confidence: 0.96,
    filesAffected: generatedFiles,
  }));

  const lineageRows: InstructionStudioLineageRow[] = manifest.entries.map((entry) => ({
    sessionId,
    timestamp,
    workflowName: manifest.workflowName,
    versionIndex,
    file: '.instruction_studio/instructions.md',
    modifiedBy: entry.persona,
    rule: entry.text,
    commit: 'local-uncommitted',
  }));

  const executionRow: InstructionStudioExecutionLogRow = {
    sessionId,
    conversationRef: `instruction-studio-${versionIndex}`,
    timestamp,
    workflowName: manifest.workflowName,
    versionIndex,
    personasActive: personas,
    activeRuleCount,
    inactiveRuleCount,
    ruleUsageCount: ruleUsageRows.length,
  };

  appendArrayFile<InstructionStudioExecutionLogRow>(executionLogPath, executionRow);
  appendArrayFile<InstructionStudioLineageRow>(lineagePath, lineageRows);
  appendArrayFile<InstructionStudioRuleUsageRow>(ruleUsagePath, ruleUsageRows);

  return {
    sessionId,
    files: {
      executionLog: executionLogPath,
      lineage: lineagePath,
      ruleUsage: ruleUsagePath,
    },
    rows: {
      execution: executionRow,
      lineage: lineageRows,
      ruleUsage: ruleUsageRows,
    },
  };
}
