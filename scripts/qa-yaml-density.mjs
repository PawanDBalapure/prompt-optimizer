// Standalone QA harness — runs representative prompts through the full
// IR → YAML compiler path and prints the optimized YAML plus token deltas.
// Run with: node scripts/qa-yaml-density.mjs
import { parseToPromptIR } from '../dist/promptIR/parser.js';
import { compilePromptIR } from '../dist/promptIR/compiler.js';
import { encode } from 'gpt-tokenizer';

const STACK = 'Tech: TS/JS, Strict TypeScript';

const PROMPTS = [
  'where is the promptProxyEngine.ts and where is it located and what does it do ?',
  'Could you please refactor the auth middleware to use async/await? Kindly add unit tests for the happy path and the 401 case.',
  'I would like you to walk me through how to set up a CI pipeline that runs lint, type-check, and tests on every pull request, and also deploys to staging on merge to main. Please make sure the pipeline is fast and reliable.',
  'fix the bug where the login button does nothing when clicked, it should call the auth endpoint and redirect',
  'build me a nice responsive landing page for my startup that looks modern and is fast',
];

function tok(s) {
  try { return encode(s).length; } catch { return Math.ceil(s.length / 4); }
}

console.log('═'.repeat(78));
console.log(' YAML Density QA — IR → compilePromptIR(local)');
console.log('═'.repeat(78));

for (const raw of PROMPTS) {
  const ir = parseToPromptIR(raw);
  const rich = compilePromptIR(ir, 'local', STACK, 'rich');
  const lean = compilePromptIR(ir, 'local', STACK, 'lean');
  const rawTok = tok(raw);
  console.log('\n' + '─'.repeat(78));
  console.log(`RAW  (${rawTok} tok): ${JSON.stringify(raw)}`);
  console.log(`RICH (${tok(rich)} tok, Δ${tok(rich) - rawTok >= 0 ? '+' : ''}${tok(rich) - rawTok}):`);
  console.log(rich);
  console.log(`\nLEAN (${tok(lean)} tok, Δ${tok(lean) - rawTok >= 0 ? '+' : ''}${tok(lean) - rawTok}):`);
  console.log(lean);
}
console.log('\n' + '═'.repeat(78));
