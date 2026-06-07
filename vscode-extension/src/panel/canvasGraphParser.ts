// This file implements parsing of copilot-instructions.md into a canvas graph.
import * as fs from 'fs';
import * as path from 'path';

export interface VNode { id: string; type: string; text: string; priority: string; x: number; y: number }
export interface VEdge { from: string; to: string }
export interface CanvasGraphResult { nodes: VNode[]; edges: VEdge[]; notice: string; }

export function parseCopilotInstructionsCanvas(wsRoot: string | undefined): CanvasGraphResult {
  if (!wsRoot) {
    return { nodes: [], edges: [], notice: 'No workspace found.' };
  }
  const MANAGED_BEGIN = '<!-- prompt-optimizer:memory:begin -->';
  const MANAGED_END   = '<!-- prompt-optimizer:memory:end -->';
  const COL_W = 180; // Compact width
  const ROW_H = 34;  // Highly clustered height for maximum density

  const candidates = [
    path.join(wsRoot, '.github', 'copilot-instructions.md'),
    path.join(wsRoot, '.copilot-instructions.md'),
    path.join(wsRoot, 'copilot-instructions.md'),
  ];

  let mainPath = '';
  let relLabel = 'copilot-instructions.md';
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      mainPath = p;
      relLabel = path.relative(wsRoot, p).replace(/\\/g, '/');
      break;
    }
  }

  if (!mainPath) {
    return { nodes: [], edges: [], notice: 'No copilot-instructions.md found — add one to your workspace.' };
  }

  const nodes: VNode[] = [];
  const edges: VEdge[] = [];
  const visited = new Set<string>();

  type Item = { parentIdx: number; kind: 'section' | 'rule' | 'file'; text: string; priority: string };
  const items: Item[] = [];

  const parseFile = (filePath: string, parentSectionIdx: number) => {
    const normalizedPath = path.normalize(filePath);
    if (visited.has(normalizedPath)) { return; }
    visited.add(normalizedPath);

    if (!fs.existsSync(filePath)) { return; }
    const raw = fs.readFileSync(filePath, 'utf8');

    const bi = raw.indexOf(MANAGED_BEGIN);
    const ei = raw.indexOf(MANAGED_END);
    const cleaned = (bi !== -1 && ei > bi)
      ? (raw.slice(0, bi).trimEnd() + '\n' + raw.slice(ei + MANAGED_END.length).trimStart())
      : raw;

    let currentSectionIdx = parentSectionIdx;

    for (const rawLine of cleaned.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('<!--') || line.startsWith('>') || line.startsWith('---')) { continue; }

      if (/^#{1,3}\s/.test(line)) {
        const text = line.replace(/^#+\s*/, '').trim();
        if (text.length >= 2) {
          currentSectionIdx = items.length;
          items.push({ parentIdx: parentSectionIdx, kind: 'section', text, priority: 'High' });
        }
        continue;
      }

      // Match markdown file paths, allowing leading `.` or `/`, without relying on `\b` which fails on `../`
      const mdMatches = [...line.matchAll(/(?:^|\s|<|\[|'|")([\w./\\-]+\.md)(?=$|\s|>|\]|'|"|[,.;!])/gi)];
      if (mdMatches.length > 0) {
        for (const match of mdMatches) {
          const refPath = match[1];
          try {
            const absPath = refPath.startsWith('.') 
              ? path.resolve(path.dirname(filePath), refPath)
              : path.resolve(wsRoot, refPath);
            if (fs.existsSync(absPath)) {
              const fileNodeIdx = items.length;
              items.push({ parentIdx: currentSectionIdx, kind: 'file', text: path.basename(absPath), priority: 'Critical' });
              parseFile(absPath, fileNodeIdx);
            }
          } catch { /* ignore */ }
        }
        continue;
      }

      if (/^[-*+]\s+/.test(line) || /^\d+[.)]\s+/.test(line)) {
        const text = line.replace(/^[-*+]\s+/, '').replace(/^\d+[.)]\s+/, '').trim();
        if (text.length >= 4) {
          items.push({ parentIdx: currentSectionIdx, kind: 'rule', text, priority: 'Medium' });
        }
        continue;
      }

      if (line.length > 8) {
        const sentences = line.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(s => s.length > 6);
        for (const s of sentences) {
          items.push({ parentIdx: currentSectionIdx, kind: 'rule', text: s, priority: 'High' });
        }
      }
    }
  };

  parseFile(mainPath, -1);

  const rootId = 'ci_root';
  const rootX = 20;

  // Build parent-to-children adjacency map
  const adjacency = new Map<number, number[]>();
  for (let i = 0; i < items.length; i++) {
    const parentIdx = items[i].parentIdx;
    if (!adjacency.has(parentIdx)) {
      adjacency.set(parentIdx, []);
    }
    adjacency.get(parentIdx)!.push(i);
  }

  const idMap = new Map<number, string>();
  let globalRow = 0;

  const layoutNode = (idx: number, depth: number, parentId: string) => {
    const item = items[idx];
    const id = item.kind === 'file' ? `ci_f_${idx + 1}` : (item.kind === 'section' ? `ci_c_${idx + 1}` : `ci_r_${idx + 1}`);
    idMap.set(idx, id);

    const row = globalRow++;
    const xPos = rootX + depth * COL_W;
    const yPos = row * ROW_H + 50;

    nodes.push({
      id,
      type: item.kind === 'file' ? 'file' : (item.kind === 'section' ? 'condition' : 'rule'),
      text: item.text,
      priority: item.priority,
      x: xPos,
      y: yPos,
    });
    edges.push({ from: parentId, to: id });

    const children = adjacency.get(idx) || [];
    for (const childIdx of children) {
      layoutNode(childIdx, depth + 1, id);
    }
  };

  // Layout all child paths starting from the recursive root (-1 hierarchy)
  const rootChildren = adjacency.get(-1) || [];
  for (const childIdx of rootChildren) {
    layoutNode(childIdx, 1, rootId);
  }

  const allY = nodes.map(n => n.y);
  const midY = allY.length > 0 ? Math.round((Math.min(...allY) + Math.max(...allY)) / 2) : 50;
  nodes.unshift({ id: rootId, type: 'persona', text: 'Copilot Instructions', priority: 'Critical', x: rootX, y: midY });

  return { nodes, edges, notice: `Loaded recursively starting from ${relLabel}` };
}
