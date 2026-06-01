#!/usr/bin/env node
/**
 * Downloads + extracts a Node.js runtime for a given vsce target into
 * vscode-extension/engine-runtime/. The single binary is what the engine
 * sidecar will spawn, so users do not need Node installed.
 *
 * Usage:
 *   node scripts/download-node.cjs <target>
 *
 * Targets (vsce naming):
 *   win32-x64  win32-arm64
 *   linux-x64  linux-arm64  linux-armhf
 *   darwin-x64 darwin-arm64
 *
 * Env:
 *   PROMPT_OPT_NODE_VERSION   override the Node version (e.g. "22.11.0")
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const NODE_VERSION = process.env.PROMPT_OPT_NODE_VERSION || '22.11.0';
const extensionRoot = path.resolve(__dirname, '..');
const runtimeDir = path.join(extensionRoot, 'engine-runtime');
const cacheDir = path.join(extensionRoot, '.node-runtime-cache');

const TARGETS = {
  'win32-x64':    { dist: 'win-x64',     ext: 'zip',    bin: 'node.exe' },
  'win32-arm64':  { dist: 'win-arm64',   ext: 'zip',    bin: 'node.exe' },
  'linux-x64':    { dist: 'linux-x64',   ext: 'tar.gz', bin: 'bin/node' },
  'linux-arm64':  { dist: 'linux-arm64', ext: 'tar.gz', bin: 'bin/node' },
  'linux-armhf':  { dist: 'linux-armv7l',ext: 'tar.gz', bin: 'bin/node' },
  'darwin-x64':   { dist: 'darwin-x64',  ext: 'tar.gz', bin: 'bin/node' },
  'darwin-arm64': { dist: 'darwin-arm64',ext: 'tar.gz', bin: 'bin/node' },
};

function quoteForShell(s) {
  if (process.platform !== 'win32') { return s; }
  if (s === '' || /[\s"()&|<>^]/.test(s)) {
    return `"${String(s).replace(/"/g, '\\"')}"`;
  }
  return s;
}

function run(cmd, args, opts = {}) {
  const useShell = process.platform === 'win32';
  const finalCmd = useShell ? quoteForShell(cmd) : cmd;
  const finalArgs = useShell ? args.map(quoteForShell) : args;
  const r = spawnSync(finalCmd, finalArgs, { stdio: 'inherit', shell: useShell, ...opts });
  if (r.status !== 0) { throw new Error(`Command failed: ${cmd} ${args.join(' ')}`); }
}

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

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const get = (u, redirects) => {
      https.get(u, (res) => {
        if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
          res.resume();
          return get(res.headers.location, redirects - 1);
        }
        if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode} for ${u}`)); return; }
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => data += c);
        res.on('end', () => resolve(data));
      }).on('error', reject);
    };
    get(url, 5);
  });
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

function extractTarGz(archive, outDir, members) {
  // tar with -z works on Linux/macOS and Windows 10+ (bsdtar).
  // We pass only the members we actually need (bin/node + LICENSE) because
  // the Linux/macOS Node tarballs contain symlinks (npm, npx, corepack)
  // that Windows tar cannot recreate ("Invalid argument" errors).
  const args = ['-xzf', archive, '-C', outDir];
  if (members && members.length) { args.push(...members); }
  run('tar', args);
}

function extractZip(archive, outDir, members) {
  if (process.platform === 'win32') {
    // bsdtar in Windows 10+ understands zip.
    const args = ['-xf', archive, '-C', outDir];
    if (members && members.length) { args.push(...members); }
    run('tar', args);
  } else {
    const args = ['-q', archive];
    if (members && members.length) { args.push(...members); }
    args.push('-d', outDir);
    run('unzip', args);
  }
}

async function main() {
  const target = process.argv[2];
  if (!target || !TARGETS[target]) {
    console.error(`Usage: node scripts/download-node.cjs <target>\nValid: ${Object.keys(TARGETS).join(', ')}`);
    process.exit(1);
  }

  const meta = TARGETS[target];
  const stem = `node-v${NODE_VERSION}-${meta.dist}`;
  const archiveName = `${stem}.${meta.ext}`;
  const url = `https://nodejs.org/dist/v${NODE_VERSION}/${archiveName}`;
  const shasumsUrl = `https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt`;

  fs.mkdirSync(cacheDir, { recursive: true });
  const archivePath = path.join(cacheDir, archiveName);

  if (!fs.existsSync(archivePath)) {
    console.log(`Downloading ${url}`);
    await download(url, archivePath);
  } else {
    console.log(`Cache hit: ${archivePath}`);
  }

  // Verify SHA256 against the official SHASUMS256.txt.
  console.log('Verifying SHA256...');
  const shasums = await fetchText(shasumsUrl);
  const line = shasums.split('\n').find((l) => l.includes(archiveName));
  if (!line) { throw new Error(`SHASUMS256.txt missing entry for ${archiveName}`); }
  const expected = line.trim().split(/\s+/)[0];
  const actual = await sha256(archivePath);
  if (expected.toLowerCase() !== actual.toLowerCase()) {
    fs.unlinkSync(archivePath);
    throw new Error(`SHA256 mismatch for ${archiveName}: expected ${expected}, got ${actual}`);
  }

  // Reset runtime dir.
  fs.rmSync(runtimeDir, { recursive: true, force: true });
  fs.mkdirSync(runtimeDir, { recursive: true });

  const stagingDir = fs.mkdtempSync(path.join(cacheDir, 'stage-'));
  try {
    // Only extract the binary + LICENSE — the symlinks (npm/npx/corepack)
    // in Linux/macOS tarballs cannot be created on Windows.
    const members = [`${stem}/${meta.bin}`, `${stem}/LICENSE`];
    if (meta.ext === 'tar.gz') {
      extractTarGz(archivePath, stagingDir, members);
    } else {
      extractZip(archivePath, stagingDir, members);
    }

    const innerBinary = path.join(stagingDir, stem, meta.bin);
    if (!fs.existsSync(innerBinary)) {
      throw new Error(`Binary not found in archive: ${innerBinary}`);
    }
    const outName = meta.bin.endsWith('.exe') ? 'node.exe' : 'node';
    const outBinary = path.join(runtimeDir, outName);
    fs.copyFileSync(innerBinary, outBinary);
    if (!outName.endsWith('.exe')) {
      fs.chmodSync(outBinary, 0o755);
    }

    // Copy LICENSE (Node ships under MIT — required redistribution notice).
    const licenseSrc = path.join(stagingDir, stem, 'LICENSE');
    if (fs.existsSync(licenseSrc)) {
      fs.copyFileSync(licenseSrc, path.join(runtimeDir, 'LICENSE-node.txt'));
    }

    // Manifest tells the runner which target this binary was built for.
    fs.writeFileSync(
      path.join(runtimeDir, 'manifest.json'),
      JSON.stringify({ target, nodeVersion: NODE_VERSION, binary: outName }, null, 2),
      'utf8',
    );
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }

  console.log(`Bundled Node ${NODE_VERSION} for ${target} into ${runtimeDir}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
