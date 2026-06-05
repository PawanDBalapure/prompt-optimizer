import * as fs from 'node:fs';
import * as path from 'node:path';

export type InstructionStudioNodeType =
  | 'workflow'
  | 'persona'
  | 'condition'
  | 'rule'
  | 'priority'
  | 'merge'
  | 'agentScope';

export interface InstructionStudioNode {
  id: string;
  type: InstructionStudioNodeType;
  label?: string;
  text?: string;
  active?: boolean;
}

export interface InstructionStudioEdge {
  from: string;
  to: string;
}

export interface InstructionStudioGraph {
  workflowName: string;
  nodes: InstructionStudioNode[];
  edges: InstructionStudioEdge[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readStringField(
  source: Record<string, unknown>,
  field: string,
  context: string,
  required: boolean,
): string | undefined {
  const raw = source[field];
  if (raw === undefined || raw === null) {
    if (required) {
      throw new Error(`Instruction Studio graph: ${context}.${field} is required.`);
    }
    return undefined;
  }
  if (typeof raw !== 'string') {
    throw new Error(`Instruction Studio graph: ${context}.${field} must be a string.`);
  }
  const trimmed = raw.trim();
  if (required && trimmed.length === 0) {
    throw new Error(`Instruction Studio graph: ${context}.${field} cannot be empty.`);
  }
  return trimmed;
}

function parseNodeType(raw: string, context: string): InstructionStudioNodeType {
  const allowed: InstructionStudioNodeType[] = [
    'workflow',
    'persona',
    'condition',
    'rule',
    'priority',
    'merge',
    'agentScope',
  ];
  if (!allowed.includes(raw as InstructionStudioNodeType)) {
    throw new Error(
      `Instruction Studio graph: ${context}.type must be one of ${allowed.join(', ')}.`,
    );
  }
  return raw as InstructionStudioNodeType;
}

export function parseInstructionStudioGraph(input: unknown): InstructionStudioGraph {
  if (!isObject(input)) {
    throw new Error('Instruction Studio graph: payload must be an object.');
  }

  const workflowName = readStringField(input, 'workflowName', 'graph', true)!;
  const rawNodes = input.nodes;
  const rawEdges = input.edges;

  if (!Array.isArray(rawNodes)) {
    throw new Error('Instruction Studio graph: graph.nodes must be an array.');
  }
  if (!Array.isArray(rawEdges)) {
    throw new Error('Instruction Studio graph: graph.edges must be an array.');
  }

  const nodeIds = new Set<string>();
  const nodes: InstructionStudioNode[] = rawNodes.map((raw, index) => {
    const context = `graph.nodes[${index}]`;
    if (!isObject(raw)) {
      throw new Error(`Instruction Studio graph: ${context} must be an object.`);
    }
    const id = readStringField(raw, 'id', context, true)!;
    if (nodeIds.has(id)) {
      throw new Error(`Instruction Studio graph: duplicate node id "${id}".`);
    }
    nodeIds.add(id);

    const typeRaw = readStringField(raw, 'type', context, true)!;
    const type = parseNodeType(typeRaw, context);
    const label = readStringField(raw, 'label', context, false);
    const text = readStringField(raw, 'text', context, false);

    let active: boolean | undefined;
    if (raw.active !== undefined) {
      if (typeof raw.active !== 'boolean') {
        throw new Error(`Instruction Studio graph: ${context}.active must be a boolean.`);
      }
      active = raw.active;
    }

    return { id, type, label, text, active };
  });

  const edges: InstructionStudioEdge[] = rawEdges.map((raw, index) => {
    const context = `graph.edges[${index}]`;
    if (!isObject(raw)) {
      throw new Error(`Instruction Studio graph: ${context} must be an object.`);
    }
    const from = readStringField(raw, 'from', context, true)!;
    const to = readStringField(raw, 'to', context, true)!;
    if (!nodeIds.has(from)) {
      throw new Error(`Instruction Studio graph: ${context}.from references unknown node "${from}".`);
    }
    if (!nodeIds.has(to)) {
      throw new Error(`Instruction Studio graph: ${context}.to references unknown node "${to}".`);
    }
    return { from, to };
  });

  return { workflowName, nodes, edges };
}

export interface CompiledInstructionEntry {
  nodeId: string;
  text: string;
  persona: string;
  condition: string;
  priority: string;
  agentScope: string;
}

export interface InstructionStudioManifest {
  schemaVersion: 1;
  generatedAt: string;
  workflowName: string;
  orderedNodeIds: string[];
  entries: CompiledInstructionEntry[];
  graph: {
    nodeCount: number;
    edgeCount: number;
  };
}

export interface CompiledInstructionStudio {
  markdown: string;
  manifest: InstructionStudioManifest;
}

interface TraversalContext {
  persona: string;
  condition: string;
  priority: string;
  agentScope: string;
}

const DEFAULT_CONTEXT: TraversalContext = {
  persona: 'General',
  condition: 'Always',
  priority: 'Medium',
  agentScope: 'Code Generation',
};

function normalizeRuleText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) { return ''; }
  return trimmed.replace(/\s+/g, ' ');
}

function stableNodeSort(a: string, b: string): number {
  return a.localeCompare(b);
}

function renderMarkdown(workflowName: string, entries: CompiledInstructionEntry[]): string {
  const lines: string[] = [`# Workflow: ${workflowName}`, ''];
  let lastPersona = '';
  let lastCondition = '';

  for (const entry of entries) {
    if (entry.persona !== lastPersona) {
      lines.push(`## Persona: ${entry.persona}`);
      lastPersona = entry.persona;
      lastCondition = '';
    }
    if (entry.condition !== lastCondition) {
      lines.push(`### Condition: ${entry.condition}`);
      lastCondition = entry.condition;
    }
    lines.push(`- [${entry.priority}] (${entry.agentScope}) ${entry.text}`);
  }

  if (entries.length === 0) {
    lines.push('## Persona: General');
    lines.push('### Condition: Always');
    lines.push('- [Medium] (Code Generation) No active rule nodes were found.');
  }

  lines.push('');
  return lines.join('\n');
}

export function compileInstructionStudioGraph(graph: InstructionStudioGraph): CompiledInstructionStudio {
  const nodesById = new Map<string, InstructionStudioNode>();
  for (const node of graph.nodes) {
    nodesById.set(node.id, node);
  }

  const outgoing = new Map<string, string[]>();
  const incomingCount = new Map<string, number>();
  for (const node of graph.nodes) {
    outgoing.set(node.id, []);
    incomingCount.set(node.id, 0);
  }
  for (const edge of graph.edges) {
    if (!nodesById.has(edge.from) || !nodesById.has(edge.to)) { continue; }
    outgoing.get(edge.from)!.push(edge.to);
    incomingCount.set(edge.to, (incomingCount.get(edge.to) ?? 0) + 1);
  }
  for (const [nodeId, neighbors] of outgoing.entries()) {
    neighbors.sort(stableNodeSort);
    outgoing.set(nodeId, neighbors);
  }

  const rootIds = graph.nodes
    .map((n) => n.id)
    .filter((id) => (incomingCount.get(id) ?? 0) === 0)
    .sort(stableNodeSort);

  const entries: CompiledInstructionEntry[] = [];
  const orderedNodeIds: string[] = [];
  const emittedRuleKeys = new Set<string>();
  const globallyVisited = new Set<string>();

  const dfs = (nodeId: string, context: TraversalContext, stack: Set<string>): void => {
    if (stack.has(nodeId)) { return; }
    const node = nodesById.get(nodeId);
    if (!node) { return; }

    globallyVisited.add(nodeId);
    if (!orderedNodeIds.includes(nodeId)) {
      orderedNodeIds.push(nodeId);
    }

    let nextContext: TraversalContext = { ...context };
    if (node.type === 'persona' && node.label) {
      nextContext = { ...nextContext, persona: node.label.trim() || nextContext.persona };
    } else if (node.type === 'condition' && node.label) {
      nextContext = { ...nextContext, condition: node.label.trim() || nextContext.condition };
    } else if (node.type === 'priority' && node.label) {
      nextContext = { ...nextContext, priority: node.label.trim() || nextContext.priority };
    } else if (node.type === 'agentScope' && node.label) {
      nextContext = { ...nextContext, agentScope: node.label.trim() || nextContext.agentScope };
    }

    if (node.type === 'rule' && node.active !== false) {
      const text = normalizeRuleText(node.text ?? node.label ?? '');
      if (text) {
        const key = `${nodeId}|${nextContext.persona}|${nextContext.condition}|${text}`;
        if (!emittedRuleKeys.has(key)) {
          emittedRuleKeys.add(key);
          entries.push({
            nodeId,
            text,
            persona: nextContext.persona,
            condition: nextContext.condition,
            priority: nextContext.priority,
            agentScope: nextContext.agentScope,
          });
        }
      }
    }

    const nextStack = new Set(stack);
    nextStack.add(nodeId);
    for (const childId of outgoing.get(nodeId) ?? []) {
      dfs(childId, nextContext, nextStack);
    }
  };

  for (const rootId of rootIds) {
    dfs(rootId, DEFAULT_CONTEXT, new Set<string>());
  }
  for (const node of graph.nodes.map((n) => n.id).sort(stableNodeSort)) {
    if (!globallyVisited.has(node)) {
      dfs(node, DEFAULT_CONTEXT, new Set<string>());
    }
  }

  const markdown = renderMarkdown(graph.workflowName, entries);
  const manifest: InstructionStudioManifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    workflowName: graph.workflowName,
    orderedNodeIds,
    entries,
    graph: {
      nodeCount: graph.nodes.length,
      edgeCount: graph.edges.length,
    },
  };
  return { markdown, manifest };
}

export interface InstructionStudioWriteResult {
  rootDir: string;
  versionIndex: number;
  files: {
    instructions: string;
    manifest: string;
    historyInstructions: string;
    historyManifest: string;
    historyLayout: string;
  };
}

function nextVersionIndex(historyRoot: string): number {
  if (!fs.existsSync(historyRoot)) { return 1; }
  const entries = fs.readdirSync(historyRoot, { withFileTypes: true });
  let max = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) { continue; }
    const match = /^v(\d+)$/.exec(entry.name);
    if (!match) { continue; }
    const value = Number(match[1]);
    if (Number.isFinite(value) && value > max) {
      max = value;
    }
  }
  return max + 1;
}

export function writeInstructionStudioSnapshot(
  workspaceRoot: string,
  graph: InstructionStudioGraph,
): InstructionStudioWriteResult {
  const compiled = compileInstructionStudioGraph(graph);

  const studioRoot = path.join(workspaceRoot, '.instruction_studio');
  const historyRoot = path.join(studioRoot, 'history');
  const versionIndex = nextVersionIndex(historyRoot);
  const versionDir = path.join(historyRoot, `v${versionIndex}`);

  fs.mkdirSync(versionDir, { recursive: true });

  const instructionsPath = path.join(studioRoot, 'instructions.md');
  const manifestPath = path.join(studioRoot, 'instruction-manifest.json');
  const historyInstructionsPath = path.join(versionDir, 'instructions.md');
  const historyManifestPath = path.join(versionDir, 'instruction-manifest.json');
  const historyLayoutPath = path.join(versionDir, 'layout.json');

  const manifestJson = `${JSON.stringify(compiled.manifest, null, 2)}\n`;
  const layoutJson = `${JSON.stringify(graph, null, 2)}\n`;

  fs.writeFileSync(instructionsPath, compiled.markdown, 'utf8');
  fs.writeFileSync(manifestPath, manifestJson, 'utf8');
  fs.writeFileSync(historyInstructionsPath, compiled.markdown, 'utf8');
  fs.writeFileSync(historyManifestPath, manifestJson, 'utf8');
  fs.writeFileSync(historyLayoutPath, layoutJson, 'utf8');

  return {
    rootDir: studioRoot,
    versionIndex,
    files: {
      instructions: instructionsPath,
      manifest: manifestPath,
      historyInstructions: historyInstructionsPath,
      historyManifest: historyManifestPath,
      historyLayout: historyLayoutPath,
    },
  };
}