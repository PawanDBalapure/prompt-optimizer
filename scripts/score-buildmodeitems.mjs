// Focused scoring harness for the "what does buildModeItems do in extension.ts" combination.
// Measures BOTH (1) task-line symbol fidelity and (2) selection-range tightness.
// Run: node scripts/score-buildmodeitems.mjs   (after `npm run build`)
import { PromptProxyEngine } from '../dist/PromptProxyEngine.js';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const REL = 'vscode-extension/src/extension.ts';
const ABS = path.join(ROOT, REL);
const PROMPT = 'what does buildModeItems does in extension.ts ?';
const SYMBOL = 'buildModeItems';

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/** Line indexes (0-based) that literally contain the symbol — the ideal target. */
function symbolLines(content) {
  const lines = content.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(SYMBOL)) { out.push(i); }
  }
  return out;
}

function totalSelectedLines(snippets) {
  let n = 0;
  for (const s of snippets) {
    for (const r of s.ranges) { n += (r.end_line - r.start_line + 1); }
  }
  return n;
}

/** Fraction of selected lines that are within ±3 of a real symbol line. */
function selectionPrecision(snippets, symLines) {
  let hit = 0;
  let total = 0;
  for (const s of snippets) {
    for (const r of s.ranges) {
      for (let l = r.start_line; l <= r.end_line; l++) {
        total++;
        if (symLines.some((sl) => Math.abs(sl - l) <= 3)) { hit++; }
      }
    }
  }
  return total === 0 ? 0 : hit / total;
}

async function run() {
  const content = read(REL);
  const symLines = symbolLines(content);

  const engine = new PromptProxyEngine({ db_path: ':memory:' });
  await engine.initialize();

  const response = await engine.processRequest({
    raw_prompt: PROMPT,
    workspace_id: 'score-bmi',
    ide_context: {
      workspace_root: ROOT.replace(/\\/g, '/'),
      active_file: { path: REL, content, language: 'ts' },
      open_files: [],
      logs: [],
    },
  });

  const optimized = response.optimized_prompt;
  const snippets = response.analysis.context.context_snippets ?? [];
  const selLines = totalSelectedLines(snippets);
  const precision = selectionPrecision(snippets, symLines);

  console.log('PROMPT:', PROMPT);
  console.log('\nSYMBOL DEFINITION/REFERENCE LINES (0-based):', symLines.join(', '));
  console.log('\nOPTIMIZED OUTPUT:\n' + optimized);
  console.log('\nCONTEXT SNIPPET RANGES:');
  console.log(JSON.stringify(snippets, null, 2));

  // ----- Scoring -----
  const taskHasSymbol = new RegExp(`\\b${SYMBOL}\\b`).test(optimized);
  const taskNotJustFile = !/task:\s*"?explain the purpose of `?extension\.ts`?\.?"?\s*$/im.test(optimized);
  const tight = selLines > 0 && selLines <= 40;
  const precise = precision >= 0.6;

  const score =
    (taskHasSymbol ? 40 : 0) +
    (taskNotJustFile ? 10 : 0) +
    (tight ? 25 : 0) +
    (precise ? 25 : 0);

  console.log('\n================ SCORE ================');
  console.log(`taskHasSymbol (40):    ${taskHasSymbol ? 40 : 0}  [${taskHasSymbol}]`);
  console.log(`taskNotJustFile (10):  ${taskNotJustFile ? 10 : 0}  [${taskNotJustFile}]`);
  console.log(`selectionTight (25):   ${tight ? 25 : 0}  [${selLines} lines selected]`);
  console.log(`selectionPrecise (25): ${precise ? 25 : 0}  [precision=${(precision * 100).toFixed(0)}%]`);
  console.log(`TOTAL: ${score}/100`);
  console.log('=======================================');
}

run().catch((e) => { console.error(e); process.exit(1); });
