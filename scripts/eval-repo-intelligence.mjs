import fs from 'node:fs';

import { RepositoryIntelligenceBuilder } from '../dist/engine/repositoryIntelligence.js';

const builder = new RepositoryIntelligenceBuilder(process.cwd());
const ingestStats = await builder.ingest();
const schema = builder.getSchema();
const graph = JSON.parse(fs.readFileSync(schema.graphPath, 'utf8'));

const cases = [
  {
    id: 'Q1',
    query: 'What does the promptPRoxyEngine does ?',
    expected: ['promptproxyengine.ts', 'promptproxyengine'],
  },
  {
    id: 'Q2',
    query: 'What is scenario.ts doing?',
    expected: ['scenarios.ts', 'scenario.ts', 'src/tests/scenarios.ts'],
  },
  {
    id: 'Q3',
    query: 'what does PromptProxyEngine.ts do',
    expected: ['promptproxyengine.ts', 'promptproxyengine'],
  },
  {
    id: 'Q4',
    query: 'explain PromptProxyEngine responsibilities',
    expected: ['promptproxyengine.ts', 'promptproxyengine'],
  },
  {
    id: 'Q5',
    query: 'what is scenarios.ts doing',
    expected: ['scenarios.ts', 'src/tests/scenarios.ts'],
  },
  {
    id: 'Q6',
    query: 'explain scenario ts test file',
    expected: ['scenarios.ts', 'src/tests/scenarios.ts'],
  },
  {
    id: 'Q7',
    query: 'What other files does promptProxyEngine relate to and use ?',
    expected: ['promptbuilder', 'contextpacker', 'semanticcachemanager', 'knowledgegraph'],
  },
  {
    id: 'Q8',
    query: 'where is the logic written to parse graph inside canvas ?',
    expected: ['canvasgraphparser.ts', 'parsecopilotinstructionscanvas', 'instruction-studio.js'],
  },
];

const STRUCTURAL_KINDS = new Set(['file', 'class', 'interface', 'function', 'method']);

function normalize(s) {
  return String(s ?? '').toLowerCase();
}

function tokenSet(s) {
  return new Set(normalize(s).split(/[^a-z0-9_]+/).filter((t) => t.length > 1));
}

function containsExpected(text, expectedTerms) {
  const t = normalize(text);
  return expectedTerms.some((term) => t.includes(normalize(term)));
}

function rankExpectedInList(list, expectedTerms) {
  for (let i = 0; i < list.length; i++) {
    if (containsExpected(list[i], expectedTerms)) {
      return i + 1;
    }
  }
  return null;
}

function baselineKeywordSearch(query, topK = 20) {
  const terms = [...tokenSet(query)];
  const rows = [];
  for (const node of Object.values(graph.nodes)) {
    if (!STRUCTURAL_KINDS.has(node.kind)) { continue; }
    const hay = normalize(`${node.label ?? ''} ${node.uri ?? ''}`);
    let score = 0;
    for (const term of terms) {
      if (hay.includes(term)) {
        score += 1;
      }
    }
    if (score > 0) {
      rows.push({ node, score });
    }
  }
  rows.sort((a, b) => b.score - a.score || String(a.node.id).localeCompare(String(b.node.id)));
  return rows.slice(0, topK).map((r) => `${r.node.label ?? ''} ${r.node.uri ?? ''}`.trim());
}

function formatTop(list, max = 5) {
  return list.slice(0, max);
}

const results = [];
for (const tc of cases) {
  const hybrid = await builder.impactAnalysis({ query: tc.query });

  const hybridList = hybrid.matchedNodes
    .filter((n) => STRUCTURAL_KINDS.has(n.kind))
    .map((n) => `${n.label ?? ''} ${n.uri ?? ''}`.trim());
  const hybridRank = rankExpectedInList(hybridList, tc.expected);
  const hybridDirect = hybridRank ? 1 / hybridRank : 0;
  const hybridRadiusHit = hybrid.blastRadius.some((n) => containsExpected(n.nodeId, tc.expected));
  const hybridScore = Math.min(1, (0.8 * hybridDirect) + (0.2 * (hybridRadiusHit ? 1 : 0)));

  const baselineList = baselineKeywordSearch(tc.query, 20);
  const baselineRank = rankExpectedInList(baselineList, tc.expected);
  const baselineScore = baselineRank ? (1 / baselineRank) : 0;

  results.push({
    id: tc.id,
    query: tc.query,
    expected: tc.expected,
    hybrid: {
      score: Number(hybridScore.toFixed(4)),
      directRank: hybridRank,
      radiusHit: hybridRadiusHit,
      routing: hybrid.routing,
      top: formatTop(hybridList),
    },
    baseline: {
      score: Number(baselineScore.toFixed(4)),
      rank: baselineRank,
      top: formatTop(baselineList),
    },
    delta: Number((hybridScore - baselineScore).toFixed(4)),
  });
}

const avgHybrid = results.reduce((s, r) => s + r.hybrid.score, 0) / results.length;
const avgBaseline = results.reduce((s, r) => s + r.baseline.score, 0) / results.length;
const consistentHits = results.filter((r) => r.hybrid.directRank === 1).length;
const consistentRate = consistentHits / results.length;

const summary = {
  ingestStats,
  aggregate: {
    averageHybridScore: Number(avgHybrid.toFixed(4)),
    averageBaselineScore: Number(avgBaseline.toFixed(4)),
    netDelta: Number((avgHybrid - avgBaseline).toFixed(4)),
    rank1ConsistencyRate: Number(consistentRate.toFixed(4)),
    rank1ConsistencyHits: consistentHits,
    totalCases: results.length,
  },
  results,
};

console.log(JSON.stringify(summary, null, 2));
