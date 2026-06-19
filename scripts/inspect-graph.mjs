import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const args = process.argv.slice(2);

function argValue(flag, fallback) {
  const idx = args.indexOf(flag);
  if (idx < 0 || idx + 1 >= args.length) { return fallback; }
  return args[idx + 1];
}

function toInt(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const workspaceRoot = process.cwd();
const jsonPath = path.resolve(workspaceRoot, argValue('--json', '.promptoptimizer/repo-intelligence/graph.json'));
const dbPath = path.resolve(workspaceRoot, argValue('--db', 'prompt_semantic_cache_pipeline_test.db'));
const limit = toInt(argValue('--limit', '8'), 8);

function printSection(title, payload) {
  console.log(`\n=== ${title} ===`);
  console.log(JSON.stringify(payload, null, 2));
}

function inspectJsonGraph() {
  if (!fs.existsSync(jsonPath)) {
    printSection('JSON Graph', {
      path: jsonPath,
      exists: false,
      hint: 'Run repository intelligence ingest first.',
    });
    return;
  }

  const raw = fs.readFileSync(jsonPath, 'utf8');
  const graph = JSON.parse(raw);

  const nodeIds = Object.keys(graph.nodes ?? {});
  const nodes = nodeIds.map((id) => graph.nodes[id]);
  const edges = Array.isArray(graph.edges) ? graph.edges : [];
  const vectors = Object.keys(graph.vectors ?? {});

  const byKind = {};
  for (const node of nodes) {
    const key = String(node?.kind ?? 'unknown');
    byKind[key] = (byKind[key] ?? 0) + 1;
  }

  const topKinds = Object.entries(byKind)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([kind, count]) => ({ kind, count }));

  printSection('JSON Graph Summary', {
    path: jsonPath,
    exists: true,
    nodes: nodeIds.length,
    edges: edges.length,
    vectors: vectors.length,
    topNodeKinds: topKinds,
  });

  printSection('JSON Graph Sample Nodes',
    nodeIds.slice(0, limit).map((id) => ({
      id,
      kind: graph.nodes[id]?.kind,
      label: graph.nodes[id]?.label,
      uri: graph.nodes[id]?.uri,
    })),
  );

  printSection('JSON Graph Sample Edges', edges.slice(0, limit));
}

function inspectSqliteGraph() {
  if (!fs.existsSync(dbPath)) {
    printSection('SQLite Graph', {
      path: dbPath,
      exists: false,
      hint: 'No SQLite database found at this path.',
    });
    return;
  }

  const db = new Database(dbPath, { readonly: true });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
    const tableNames = tables.map((t) => t.name);
    const hasKgNodes = tableNames.includes('kg_nodes');
    const hasKgEdges = tableNames.includes('kg_edges');

    const payload = {
      path: dbPath,
      exists: true,
      hasKgNodes,
      hasKgEdges,
    };

    if (hasKgNodes && hasKgEdges) {
      payload.kg_nodes = db.prepare('SELECT COUNT(*) AS c FROM kg_nodes').get().c;
      payload.kg_edges = db.prepare('SELECT COUNT(*) AS c FROM kg_edges').get().c;
      payload.kg_nodes_sample = db.prepare('SELECT id, workspace_id, node_type, name FROM kg_nodes LIMIT ?').all(limit);
      payload.kg_edges_sample = db.prepare('SELECT src_id, dst_id, relation, weight FROM kg_edges LIMIT ?').all(limit);
    }

    printSection('SQLite Graph Summary', payload);
  } finally {
    db.close();
  }
}

printSection('Inspector Args', {
  workspaceRoot,
  jsonPath,
  dbPath,
  limit,
  usage: [
    'npm run inspect:graph',
    'node scripts/inspect-graph.mjs --json .promptoptimizer/repo-intelligence/graph.json --db prompt_semantic_cache_pipeline_test.db --limit 12',
  ],
});

inspectJsonGraph();
inspectSqliteGraph();
