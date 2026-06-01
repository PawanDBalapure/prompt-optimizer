#!/usr/bin/env node
/**
 * Download Tesseract's English trained data (LSTM, integer-quantized) into
 * vscode-extension/models/tesseract/. Bundled inside the .vsix so OCR works
 * fully offline.
 *
 * Source: https://github.com/tesseract-ocr/tessdata_fast (~4 MB compressed,
 * ~10 MB on disk). `tessdata_fast` keeps the vsix lean while still giving
 * good accuracy on screenshots and PDF-style images.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const URL = 'https://github.com/tesseract-ocr/tessdata_fast/raw/main/eng.traineddata';
const OUT_DIR = path.resolve(__dirname, '..', 'models', 'tesseract');
const OUT_FILE = path.join(OUT_DIR, 'eng.traineddata');

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const get = (u, redirects) => {
      https.get(u, (res) => {
        if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
          res.resume();
          return get(res.headers.location, redirects - 1);
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${u}`));
          return;
        }
        res.pipe(file);
        file.on('finish', () => file.close((err) => err ? reject(err) : resolve()));
      }).on('error', reject);
    };
    get(url, 5);
  });
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  if (fs.existsSync(OUT_FILE) && fs.statSync(OUT_FILE).size > 1_000_000) {
    console.log(`Tesseract eng.traineddata already present (${(fs.statSync(OUT_FILE).size / 1024 / 1024).toFixed(1)} MB)`);
    return;
  }
  console.log(`Downloading ${URL} ...`);
  await download(URL, OUT_FILE);
  const sz = fs.statSync(OUT_FILE).size;
  console.log(`Saved ${OUT_FILE} (${(sz / 1024 / 1024).toFixed(1)} MB)`);
}

main().catch((err) => { console.error(err); process.exit(1); });
