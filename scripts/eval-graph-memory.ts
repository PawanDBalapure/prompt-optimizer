import { PromptProxyEngine } from '../src/PromptProxyEngine.js';
import { PromptEvalEngine } from '../src/PromptEvalEngine.js';
import { enterpriseRelevanceScore } from '../src/engine/relevanceScoring.js';
import Database from 'better-sqlite3';

function mockDBSetup(db: Database.Database) {
  // Create schema basics
  db.exec(`
    CREATE TABLE IF NOT EXISTS semantic_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      raw_prompt TEXT UNIQUE,
      optimized_prompt TEXT,
      embedding BLOB,
      timestamp INTEGER
    );
  `);
  
  const insert = db.prepare('INSERT OR IGNORE INTO semantic_cache (raw_prompt, optimized_prompt, timestamp) VALUES (?, ?, ?)');
  
  const testCases = [
    {
      raw: 'Refactor the UserAuth class to use the IdentityService alias',
      opt: 'context: refactor UserAuth\nrequirements:\n  - "Use IdentityService instead of UserAuth"\noutput_format: "Updated TS class"',
    },
    {
      raw: 'Fix the memory leak in the graph node traversal',
      opt: 'context: graph node traversal\nrequirements:\n  - "Prevent memory leak in loop"\noutput_format: "Patched traversal function"',
    },
    {
      raw: 'Add neo4j backend support for the KnowledgeGraph',
      opt: 'context: KnowledgeGraph Neo4j\nrequirements:\n  - "Add Neo4j backend adapter for graph store"\noutput_format: "New Neo4j adapter file"',
    }
  ];

  for (const tc of testCases) {
    insert.run(tc.raw, tc.opt, Date.now());
  }
}

async function runEvaluation() {
  console.log('======================================================');
  console.log('ENTERPRISE GRAPH MEMORY RETRIEVAL: QUALITY EVALUATION');
  console.log('======================================================\n');
  
  console.log('-- 1. Scoring simulated node retrieval against Enterprise Relevance Formula');
  const candidate1 = {
    exactMatch: 0.95,
    symbolMatch: 1.0,
    fileProximity: 0.8,
    graphDistance: 1.0,
    usageFrequency: 0.5,
    recency: 0.9,
    embeddingSimilarity: 0.87,
    evidenceTrust: 1.0
  };
  const score1 = enterpriseRelevanceScore(candidate1);
  console.log(`Node [UserAuth -> IdentityService] relevance score: ${(score1 * 100).toFixed(2)} / 100`);

  const candidate2 = {
    exactMatch: 0.2,
    symbolMatch: 0.4,
    fileProximity: 0.1,
    graphDistance: 0.33, // 2 hops away
    usageFrequency: 0.1,
    recency: 0.4,
    embeddingSimilarity: 0.65,
    evidenceTrust: 0.7  // Penalty for contradictory evidence
  };
  const score2 = enterpriseRelevanceScore(candidate2);
  console.log(`Node [ObsoleteAuthHelper] relevance score: ${(score2 * 100).toFixed(2)} / 100`);
  console.log('');

  console.log('-- 2. Running full Prompt Eval Engine via cached prompts');
  const db = new Database(':memory:');
  mockDBSetup(db);

  const engine = new PromptProxyEngine({ db_path: ':memory:' });
  // Engine uses internal cache db since we pass path
  await engine.initialize();
  
  // Backdoor db swap for mock
  const realDb = engine.getCacheManager().rawDatabase();
  if (realDb) {
    mockDBSetup(realDb);
  }

  const evalEngine = new PromptEvalEngine(engine);
  const rows = realDb?.prepare('SELECT raw_prompt, optimized_prompt FROM semantic_cache').all() as any[];
  
  const tests = rows.map((r, i) => ({
    name: `DB Test Case ${i + 1}`,
    input: r.raw_prompt,
    expected: 'Follow standard architecture conventions and concise outputs.',
  }));

  const report = await evalEngine.runBenchmark({
    name: 'Graph Memory Architecture Check',
    tests,
  });

  console.log(`Benchmark completed. Evaluated ${tests.length} prompts across 6 models.`);
  console.log(`Overall Quality Score Average: ${report.averageScoreCount} / 100\n`);
  
  for (const result of report.results) {
    console.log(`Test: ${result.testName}`);
    console.log(`Input: ${result.input}`);
    // Sample one variant (claude optimal)
    const claudeScore = result.variantScores.find(v => v.variantName === 'Claude Optimal');
    if (claudeScore) {
      console.log(`-> Claude Optimal Score: ${claudeScore.score} / 100`);
      if (claudeScore.score < 100) {
         console.log(`   Deductions: ${claudeScore.reason}`);
      }
    }
    console.log('');
  }
}

runEvaluation().catch(err => {
  console.error('Eval failed', err);
});
