// Standalone QA harness — runs 10 representative prompts through
// optimizePromptText (the sentence-shortener) and grades each result.
// Run with: node scripts/qa-text-optimizer.mjs
import { optimizePromptText } from '../dist/engine/textOptimizer.js';

/**
 * Each case has:
 *  - id        : short label
 *  - input     : raw user prompt
 *  - mustKeep  : substrings that MUST appear in the optimized text
 *  - mustDrop  : substrings that MUST be removed
 *  - maxRatio  : optimized.length / input.length must be <= this (compression)
 */
const CASES = [
  {
    id: 'P1-politeness',
    input: 'Could you please refactor the auth middleware to use async/await? Kindly add unit tests for the happy path and the 401 case.',
    mustKeep: ['Refactor', 'auth middleware', 'async/await', 'unit tests', '401'],
    mustDrop: ['Could you please', 'Kindly'],
    maxRatio: 0.85,
  },
  {
    id: 'P2-conditional',
    input: 'If the request fails, return a 401. For each retry attempt log the error code. Let us also rate-limit the endpoint.',
    mustKeep: ['If the request fails', 'return a 401', 'retry', 'log the error', 'rate-limit'],
    mustDrop: ['Let us'],
    maxRatio: 0.95,
  },
  {
    id: 'P3-fluff',
    input: 'It is important to note that, basically, you should utilize a large number of unit tests in order to demonstrate that the API is working as expected.',
    mustKeep: ['unit tests', 'API'],
    mustDrop: ['It is important to note', 'basically', 'in order to', 'utilize'],
    maxRatio: 0.7,
  },
  {
    id: 'P4-codefence',
    input: '```ts\nexport function add(a: number, b: number) {\n  return a + b;\n}\n```\nPlease add JSDoc comments to the function above and ensure type safety.',
    mustKeep: ['export function add', 'return a + b', 'JSDoc'],
    mustDrop: ['Please'],
    maxRatio: 1.0,
  },
  {
    id: 'P5-format-keys',
    input: 'I want you to provide an explanation of how the cache layer works. Return JSON with the keys: name, status, count.',
    mustKeep: ['cache layer', 'JSON', 'name', 'status', 'count'],
    mustDrop: ['I want you to', 'provide an explanation of'],
    maxRatio: 0.9,
  },
  {
    id: 'P6-duplicates',
    input: 'Add tests for the happy path.\nAdd tests for the happy path.\nAlso add tests for the 401 case.',
    mustKeep: ['happy path', '401'],
    mustDrop: [],
    maxRatio: 0.85,
  },
  {
    id: 'P7-prepositions',
    input: 'Subsequent to the merge, due to the fact that the build is broken, in the event that tests fail, please revert the change.',
    mustKeep: ['merge', 'build is broken', 'tests fail', 'revert'],
    mustDrop: ['Subsequent to', 'due to the fact that', 'in the event that', 'please'],
    maxRatio: 0.7,
  },
  {
    id: 'P8-mixed-code',
    input: 'Refactor this snippet to be more idiomatic:\n```js\nvar x = 5;\nif (x === 5) { console.log("ok"); }\n```\nMake sure to use const and arrow functions where appropriate.',
    mustKeep: ['Refactor', 'idiomatic', 'var x = 5', 'console.log', 'const', 'arrow functions'],
    mustDrop: ['Make sure'],
    maxRatio: 1.0,
  },
  {
    id: 'P9-long',
    input: 'I would like you to walk me through how to set up a CI pipeline that runs lint, type-check, and tests on every pull request, and also deploys to staging on merge to main. Please make sure the pipeline is fast and reliable.',
    mustKeep: ['CI pipeline', 'lint', 'type-check', 'tests', 'pull request', 'staging', 'main'],
    mustDrop: ['I would like you to', 'walk me through', 'Please', 'make sure'],
    // After dropping every removable filler the remaining content is all
    // load-bearing nouns/verbs, so 0.85 is the realistic compression floor.
    maxRatio: 0.85,
  },
  {
    id: 'P10-imperatives',
    input: 'Help me write a function that returns the Fibonacci sequence up to N. Tell me how to handle large N efficiently. Show me how to add memoization.',
    mustKeep: ['Fibonacci', 'function', 'large N', 'memoization'],
    mustDrop: ['Help me', 'Tell me how to', 'Show me how to'],
    maxRatio: 0.85,
  },
];

function grade(c) {
  const out = optimizePromptText(c.input);
  const issues = [];

  for (const phrase of c.mustKeep) {
    if (!out.toLowerCase().includes(phrase.toLowerCase())) {
      issues.push(`drop:${JSON.stringify(phrase)}`);
    }
  }
  for (const phrase of c.mustDrop) {
    if (out.toLowerCase().includes(phrase.toLowerCase())) {
      issues.push(`leak:${JSON.stringify(phrase)}`);
    }
  }
  const ratio = out.length / c.input.length;
  const ratioOk = ratio <= c.maxRatio;
  if (!ratioOk) {
    issues.push(`ratio:${ratio.toFixed(2)} > ${c.maxRatio}`);
  }

  // Per-test score: 100 if no issues, else weighted.
  // mustKeep miss → -25 each, mustDrop leak → -15 each, ratio miss → -10
  let score = 100;
  for (const issue of issues) {
    if (issue.startsWith('drop:')) score -= 25;
    else if (issue.startsWith('leak:')) score -= 15;
    else if (issue.startsWith('ratio:')) score -= 10;
  }
  score = Math.max(0, score);

  return { id: c.id, input: c.input, output: out, ratio, score, issues };
}

const results = CASES.map(grade);
const avg = results.reduce((a, r) => a + r.score, 0) / results.length;

console.log('═'.repeat(72));
console.log(' Sentence-Shortener QA Report — 10 prompts');
console.log('═'.repeat(72));
for (const r of results) {
  console.log(`\n[${r.id}] score=${r.score}  compression=${(r.ratio * 100).toFixed(0)}%`);
  console.log(`  IN  : ${JSON.stringify(r.input)}`);
  console.log(`  OUT : ${JSON.stringify(r.output)}`);
  if (r.issues.length) {
    console.log(`  issues: ${r.issues.join(', ')}`);
  } else {
    console.log('  issues: none');
  }
}
console.log('\n' + '─'.repeat(72));
console.log(` Average score: ${avg.toFixed(1)} / 100`);
console.log('─'.repeat(72));
