/**
 * 20-prompt model-aware optimization benchmark.
 *
 * Runs 20 diverse engineering prompts through the upgraded engine with
 * model-aware framing enabled, scores each across all six model families, and
 * prints the aggregate quality. Used to validate the framing upgrade lifts
 * output quality toward ~100/100.
 */
import { PromptProxyEngine } from '../src/PromptProxyEngine.js';
import { PromptEvalEngine, type BenchmarkConfig } from '../src/PromptEvalEngine.js';
import * as fs from 'fs';

const DB_FILE = 'prompt_eval_20.db';

function reset(file: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(file + suffix); } catch { /* ignore */ }
  }
}

const benchmark: BenchmarkConfig = {
  name: '20-Prompt Model-Aware Quality Benchmark',
  tests: [
    {
      name: 'JWT auth middleware',
      input: 'Build an Express middleware that verifies a JWT bearer token and returns 401 on failure.',
      expected: 'Return updated TypeScript middleware code in markdown.',
      keywords: ['jwt', 'middleware', 'token'],
    },
    {
      name: 'Refactor auth class',
      input: 'Refactor the UserAuth class to use the IdentityService alias and keep the public API stable.',
      expected: 'Return the updated TypeScript class.',
      keywords: ['refactor', 'class', 'api'],
    },
    {
      name: 'Fix memory leak',
      input: 'Fix the memory leak in the graph node traversal loop and explain the root cause.',
      expected: 'Return root cause plus a minimal patch.',
      keywords: ['memory', 'leak', 'graph'],
    },
    {
      name: 'Neo4j backend',
      input: 'Add a Neo4j backend adapter for the KnowledgeGraph store behind the existing interface.',
      expected: 'Return a new Neo4j adapter file.',
      keywords: ['neo4j', 'adapter', 'store'],
    },
    {
      name: 'SQL query optimisation',
      input: 'Optimise the SQL query that joins orders and customers so it uses an index on customer_id.',
      expected: 'Return the optimised SQL query.',
      keywords: ['sql', 'query', 'index'],
    },
    {
      name: 'React hook',
      input: 'Create a React hook useDebouncedValue that debounces a changing input value by a delay.',
      expected: 'Return the React hook implementation.',
      keywords: ['react', 'hook', 'debounce'],
    },
    {
      name: 'REST endpoint',
      input: 'Add a REST endpoint POST /users that validates the request body and creates a user.',
      expected: 'Return the new endpoint handler.',
      keywords: ['rest', 'endpoint', 'user'],
    },
    {
      name: 'Unit tests',
      input: 'Write unit tests for the parseToPromptIR function covering empty and malformed input.',
      expected: 'Return the test suite.',
      keywords: ['test', 'function', 'input'],
    },
    {
      name: 'Race condition',
      input: 'Diagnose and fix the race condition in the parallel cache write path.',
      expected: 'Return the root cause and a corrected implementation.',
      keywords: ['race', 'cache', 'write'],
    },
    {
      name: 'Dockerfile',
      input: 'Write a multi-stage Dockerfile for a Node.js service that produces a small production image.',
      expected: 'Return the Dockerfile.',
      keywords: ['dockerfile', 'node', 'production'],
    },
    {
      name: 'GraphQL resolver',
      input: 'Implement a GraphQL resolver for the orders field that batches database lookups.',
      expected: 'Return the resolver implementation.',
      keywords: ['graphql', 'resolver', 'orders'],
    },
    {
      name: 'CLI command',
      input: 'Add a CLI command that exports the knowledge graph to a JSON file at a given path.',
      expected: 'Return the CLI command implementation.',
      keywords: ['cli', 'export', 'json'],
    },
    {
      name: 'Rate limiter',
      input: 'Implement a token-bucket rate limiter middleware with a configurable requests-per-second limit.',
      expected: 'Return the rate limiter middleware.',
      keywords: ['rate', 'limiter', 'middleware'],
    },
    {
      name: 'Pagination',
      input: 'Add cursor-based pagination to the listUsers query and return a nextCursor token.',
      expected: 'Return the paginated query implementation.',
      keywords: ['pagination', 'cursor', 'query'],
    },
    {
      name: 'Logging',
      input: 'Add structured JSON logging with a correlation id to every incoming HTTP request.',
      expected: 'Return the logging middleware.',
      keywords: ['logging', 'correlation', 'request'],
    },
    {
      name: 'Migration script',
      input: 'Write a database migration that adds a non-null email column with a default to the users table.',
      expected: 'Return the migration script.',
      keywords: ['migration', 'column', 'users'],
    },
    {
      name: 'Retry logic',
      input: 'Add exponential backoff retry logic to the HTTP client for transient 5xx errors.',
      expected: 'Return the retry wrapper.',
      keywords: ['retry', 'backoff', 'client'],
    },
    {
      name: 'Type guard',
      input: 'Write a TypeScript type guard isPromptIR that validates the PromptIR shape at runtime.',
      expected: 'Return the type guard function.',
      keywords: ['type', 'guard', 'runtime'],
    },
    {
      name: 'Webhook handler',
      input: 'Implement a webhook handler that verifies the signature header before processing the payload.',
      expected: 'Return the webhook handler.',
      keywords: ['webhook', 'signature', 'payload'],
    },
    {
      name: 'Cache invalidation',
      input: 'Add cache invalidation that evicts stale entries when the underlying record is updated.',
      expected: 'Return the invalidation logic.',
      keywords: ['cache', 'invalidation', 'stale'],
    },
  ],
};

async function main(): Promise<void> {
  reset(DB_FILE);
  const engine = new PromptProxyEngine({ db_path: DB_FILE });
  await engine.initialize();
  const evalEngine = new PromptEvalEngine(engine);

  console.log('==============================================================');
  console.log(`  ${benchmark.name}`);
  console.log(`  ${benchmark.tests.length} prompts x 6 model families`);
  console.log('==============================================================\n');

  const report = await evalEngine.runBenchmark(benchmark);

  let perfect = 0;
  let total = 0;
  const failing: string[] = [];

  for (const result of report.results) {
    const scores = result.variantScores.map((v) => v.score);
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    const min = Math.min(...scores);
    total += scores.length;
    perfect += scores.filter((s) => s >= 100).length;
    const flag = avg >= 99.99 ? 'OK ' : '!! ';
    console.log(`${flag}${result.testName.padEnd(24)} avg=${avg.toFixed(1).padStart(5)}  min=${String(min).padStart(3)}`);
    for (const v of result.variantScores) {
      if (v.score < 100) {
        failing.push(`   - ${result.testName} / ${v.variantName} = ${v.score} :: ${v.reason}`);
      }
    }
  }

  console.log('\n--------------------------------------------------------------');
  console.log(`AVERAGE SCORE: ${report.averageScoreCount} / 100`);
  console.log(`PERFECT (100): ${perfect}/${total} variant runs`);
  console.log('--------------------------------------------------------------');

  if (failing.length > 0) {
    console.log('\nSub-100 runs:');
    for (const f of failing.slice(0, 40)) { console.log(f); }
  }

  engine.close();
  reset(DB_FILE);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
