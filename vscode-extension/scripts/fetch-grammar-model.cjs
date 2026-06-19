#!/usr/bin/env node
/**
 * Downloads a small seq2seq grammar/spelling model (ONNX, quantized) into
 * vscode-extension/models/grammar-correction/ for the optional on-device
 * grammar refiner (src/local/grammarRefiner.ts).
 *
 * This model is consulted ONLY when the user enables
 * `promptProxy.enableGrammarModel`. It is an enhancement layered on top of the
 * always-on deterministic corrector in the shared engine — every rewrite it
 * produces is validated by the engine's meaning-preservation guard, so it can
 * polish grammar but can never change what a prompt asks for.
 *
 * Default model: Xenova/flan-t5-small (instruction-following T5, ~80 MB int8),
 * which reliably follows a "fix grammar, keep meaning" instruction and ships in
 * the @xenova ONNX layout. Override with another text2text-generation ONNX repo
 * via `--repo <hf-id>` (e.g. a grammar-tuned T5).
 *
 *   node scripts/fetch-grammar-model.cjs
 *   node scripts/fetch-grammar-model.cjs --repo Xenova/flan-t5-small
 *
 * The model is bundled into the VSIX so installs work fully offline.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { URL } = require('url');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const REPO = arg('--repo', 'Xenova/flan-t5-small');
const REVISION = arg('--revision', 'main');
const OUT_DIR = path.resolve(__dirname, '..', 'models', 'grammar-correction');

const FILES = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
  'generation_config.json',
  'onnx/encoder_model_quantized.onnx',
  'onnx/decoder_model_merged_quantized.onnx',
];

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const tmp = dest + '.part';
    ensureDir(path.dirname(dest));
    const file = fs.createWriteStream(tmp);
    const req = https.get(url, { headers: { 'User-Agent': 'prompt-optimizer-fetch/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = new URL(res.headers.location, url).toString();
        file.close();
        fs.unlink(tmp, () => {});
        resolve(download(next, dest));
        return;
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlink(tmp, () => {});
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      const total = Number(res.headers['content-length'] || 0);
      let received = 0;
      let lastPct = -1;
      res.on('data', (chunk) => {
        received += chunk.length;
        if (total > 0) {
          const pct = Math.floor((received / total) * 100);
          if (pct !== lastPct && pct % 10 === 0) {
            process.stdout.write(`  ${pct}% (${(received / 1048576).toFixed(1)} MB)\r`);
            lastPct = pct;
          }
        }
      });
      res.pipe(file);
      file.on('finish', () => {
        file.close((err) => {
          if (err) { reject(err); return; }
          fs.rename(tmp, dest, (err2) => err2 ? reject(err2) : resolve());
        });
      });
    });
    req.on('error', (err) => {
      file.close();
      fs.unlink(tmp, () => {});
      reject(err);
    });
  });
}

async function main() {
  ensureDir(OUT_DIR);
  console.log(`Fetching ${REPO}@${REVISION} -> ${OUT_DIR}`);
  const optional = new Set(['generation_config.json']);
  for (const rel of FILES) {
    const dest = path.join(OUT_DIR, rel);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
      console.log(`  skip  ${rel} (exists)`);
      continue;
    }
    const url = `https://huggingface.co/${REPO}/resolve/${REVISION}/${rel}`;
    process.stdout.write(`  get   ${rel}\n`);
    try {
      await download(url, dest);
    } catch (err) {
      if (optional.has(rel)) {
        console.log(`  skip  ${rel} (optional, not found)`);
        continue;
      }
      throw err;
    }
    const size = fs.statSync(dest).size;
    console.log(`  ok    ${rel} (${(size / 1048576).toFixed(2)} MB)`);
  }
  console.log('Done. Enable promptProxy.enableGrammarModel to use it.');
}

main().catch((err) => {
  console.error('fetch-grammar-model failed:', err.message);
  process.exit(1);
});
