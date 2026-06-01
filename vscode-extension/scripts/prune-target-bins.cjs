#!/usr/bin/env node
/**
 * Prune platform-specific native binaries from node_modules so the .vsix
 * for a given target only carries the matching arch.
 *
 * Usage:
 *   node scripts/prune-target-bins.cjs apply <target>
 *   node scripts/prune-target-bins.cjs restore
 *
 * `apply` MOVES the non-target prebuilds out to .vsix-prune-cache/ so vsce
 * does not include them. `restore` puts them back. Always pair the two.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const extensionRoot = path.resolve(__dirname, '..');
const cacheRoot = path.join(extensionRoot, '.vsix-prune-cache');

const TARGET_TO_NPM = {
  'win32-x64':    { platform: 'win32',  arch: 'x64' },
  'win32-arm64':  { platform: 'win32',  arch: 'arm64' },
  'linux-x64':    { platform: 'linux',  arch: 'x64' },
  'linux-arm64':  { platform: 'linux',  arch: 'arm64' },
  'linux-armhf':  { platform: 'linux',  arch: 'arm' },
  'darwin-x64':   { platform: 'darwin', arch: 'x64' },
  'darwin-arm64': { platform: 'darwin', arch: 'arm64' },
};

function moveAside(absPath) {
  if (!fs.existsSync(absPath)) { return; }
  const rel = path.relative(extensionRoot, absPath);
  const dest = path.join(cacheRoot, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(absPath, dest);
  console.log(`  pruned ${rel}`);
}

function pruneOnnxRuntimeNode(target) {
  const npm = TARGET_TO_NPM[target];
  if (!npm) { return; }
  const base = path.join(extensionRoot, 'node_modules', 'onnxruntime-node', 'bin', 'napi-v3');
  if (!fs.existsSync(base)) { return; }
  const platforms = fs.readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory()).map((e) => e.name);
  for (const plat of platforms) {
    const platDir = path.join(base, plat);
    const arches = fs.readdirSync(platDir, { withFileTypes: true })
      .filter((e) => e.isDirectory()).map((e) => e.name);
    for (const arch of arches) {
      if (plat !== npm.platform || arch !== npm.arch) {
        moveAside(path.join(platDir, arch));
      }
    }
    // If the platform dir is now empty, remove it too.
    const rest = fs.existsSync(platDir) ? fs.readdirSync(platDir) : [];
    if (rest.length === 0 && fs.existsSync(platDir)) {
      fs.rmdirSync(platDir);
    }
  }
}

function apply(target) {
  if (fs.existsSync(cacheRoot)) {
    throw new Error(`prune cache already exists at ${cacheRoot}; run "restore" first.`);
  }
  fs.mkdirSync(cacheRoot, { recursive: true });
  console.log(`Pruning native binaries for target=${target} ...`);
  pruneOnnxRuntimeNode(target);
  console.log('Prune complete.');
}

function restoreDir(absCacheDir) {
  if (!fs.existsSync(absCacheDir)) { return; }
  const rel = path.relative(cacheRoot, absCacheDir);
  const dest = path.join(extensionRoot, rel);
  if (fs.statSync(absCacheDir).isDirectory()) {
    const entries = fs.readdirSync(absCacheDir);
    fs.mkdirSync(dest, { recursive: true });
    for (const e of entries) {
      restoreDir(path.join(absCacheDir, e));
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(absCacheDir, dest);
  }
}

function restore() {
  if (!fs.existsSync(cacheRoot)) {
    console.log('No prune cache to restore.');
    return;
  }
  console.log('Restoring pruned binaries ...');
  for (const e of fs.readdirSync(cacheRoot)) {
    restoreDir(path.join(cacheRoot, e));
  }
  fs.rmSync(cacheRoot, { recursive: true, force: true });
  console.log('Restore complete.');
}

function main() {
  const [cmd, target] = process.argv.slice(2);
  if (cmd === 'apply') {
    if (!TARGET_TO_NPM[target]) {
      throw new Error(`Unknown target: ${target}`);
    }
    apply(target);
  } else if (cmd === 'restore') {
    restore();
  } else {
    console.error('Usage: prune-target-bins.cjs apply <target> | restore');
    process.exit(1);
  }
}

main();
