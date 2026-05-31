#!/usr/bin/env node
/**
 * Downloads the prebuilt INT8-quantized Flan-T5-Small ONNX bundle
 * (Xenova/flan-t5-small on HuggingFace) into
 * vscode-extension/models/flan-t5-small-q4/.
 *
 * This is the Phase-1 fallback model used by src/local/localOptimizer.ts
 * when no custom distilled model is present. Run once before packaging:
 *
 *   node scripts/fetch-model.cjs
 *
 * The model is bundled into the VSIX so installs work fully offline.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { URL } = require('url');

const REPO = 'Xenova/flan-t5-small';
const REVISION = 'main';
const OUT_DIR = path.resolve(__dirname, '..', 'models', 'flan-t5-small-q4');

const FILES = [
  'config.json',
  'generation_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
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
  for (const rel of FILES) {
    const dest = path.join(OUT_DIR, rel);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
      console.log(`  skip  ${rel} (exists)`);
      continue;
    }
    const url = `https://huggingface.co/${REPO}/resolve/${REVISION}/${rel}`;
    process.stdout.write(`  get   ${rel}\n`);
    await download(url, dest);
    const size = fs.statSync(dest).size;
    console.log(`  ok    ${rel} (${(size / 1048576).toFixed(2)} MB)`);
  }
  console.log('Done.');
}

main().catch((err) => {
  console.error('fetch-model failed:', err.message);
  process.exit(1);
});
