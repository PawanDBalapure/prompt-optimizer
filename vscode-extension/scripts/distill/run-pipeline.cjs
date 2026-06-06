'use strict';
/**
 * Phase 2 distillation pipeline orchestrator.
 *
 *   train.py  -> .distill-work/final/   (HF seq2seq model)
 *   export_onnx.py -> models/distilled-rewriter/   (INT8 ONNX bundle)
 *
 * Required Python packages (run once):
 *   pip install transformers datasets "optimum[onnxruntime]" onnxruntime sentencepiece accelerate
 *
 * Inputs:
 *   PROMPT_DATASET   Path to a JSONL of {input, output} pairs.
 *                    Default: <extension>/training-data/training-pairs.jsonl
 *   PYTHON           Python interpreter to invoke. Default: "python".
 *   PROMPT_BASE      HF base model id.
 *                    Default: microsoft/llmlingua-2-bert-base-multilingual-cased-meetingbank.
 *
 * After this script finishes, `vsce package` will pick up
 * models/distilled-rewriter automatically and the runtime will prefer it.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const here = __dirname;
const extRoot = path.resolve(here, '..', '..');

const dataset = process.env.PROMPT_DATASET
  || path.join(extRoot, 'training-data', 'training-pairs.jsonl');
const workdir = path.join(extRoot, '.distill-work');
const outModel = path.join(extRoot, 'models', 'distilled-rewriter');
const py = process.env.PYTHON || 'python';
const base = process.env.PROMPT_BASE || 'microsoft/llmlingua-2-bert-base-multilingual-cased-meetingbank';

if (!fs.existsSync(dataset)) {
  console.error(`Dataset not found: ${dataset}`);
  console.error(
    'Set PROMPT_DATASET or place a JSONL at training-data/training-pairs.jsonl. '
    + 'Each line: {"input":"...","output":"..."}.',
  );
  process.exit(1);
}

fs.mkdirSync(workdir, { recursive: true });
fs.mkdirSync(path.dirname(outModel), { recursive: true });

const trainScript = path.join(here, 'train.py');
const exportScript = path.join(here, 'export_onnx.py');

execSync(
  `"${py}" "${trainScript}" --data "${dataset}" --base "${base}" --out "${workdir}"`,
  { stdio: 'inherit' },
);

execSync(
  `"${py}" "${exportScript}" --model "${path.join(workdir, 'final')}" --out "${outModel}"`,
  { stdio: 'inherit' },
);

console.log('\nDistilled model is ready at:', outModel);
console.log('Run `vsce package` to bundle it into the extension.');
