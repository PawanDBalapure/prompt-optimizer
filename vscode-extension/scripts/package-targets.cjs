#!/usr/bin/env node
/**
 * Build a platform-specific .vsix by fetching the matching better-sqlite3
 * prebuilt native binary, syncing the engine runtime, and invoking vsce.
 *
 * Usage:
 *   node scripts/package-targets.cjs <target> [<target> ...]
 *   node scripts/package-targets.cjs all
 *
 * Targets follow vsce's --target naming:
 *   win32-x64  win32-arm64
 *   linux-x64  linux-arm64  linux-armhf
 *   darwin-x64 darwin-arm64
 *
 * Requires `vsce` (or `@vscode/vsce`) to be available on PATH.
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const extensionRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(extensionRoot, '..');

const ALL_TARGETS = [
  'win32-x64',
  'win32-arm64',
  'linux-x64',
  'linux-arm64',
  'linux-armhf',
  'darwin-x64',
  'darwin-arm64',
];

const TARGET_TO_NPM = {
  'win32-x64':   { platform: 'win32',  arch: 'x64' },
  'win32-arm64': { platform: 'win32',  arch: 'arm64' },
  'linux-x64':   { platform: 'linux',  arch: 'x64' },
  'linux-arm64': { platform: 'linux',  arch: 'arm64' },
  'linux-armhf': { platform: 'linux',  arch: 'arm' },
  'darwin-x64':  { platform: 'darwin', arch: 'x64' },
  'darwin-arm64':{ platform: 'darwin', arch: 'arm64' },
};

function run(cmd, args, opts = {}) {
  console.log(`\n> ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...opts,
  });
  if (r.status !== 0) {
    throw new Error(`Command failed (${r.status}): ${cmd} ${args.join(' ')}`);
  }
}

function rebuildBetterSqliteFor(target) {
  const { platform, arch } = TARGET_TO_NPM[target];
  // prebuild-install ships with better-sqlite3 and downloads the matching
  // prebuilt .node binary without compiling locally.
  const bin = path.join(
    repoRoot,
    'node_modules',
    'better-sqlite3',
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'prebuild-install.cmd' : 'prebuild-install',
  );
  const fallback = path.join(
    repoRoot,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'prebuild-install.cmd' : 'prebuild-install',
  );
  const prebuildBin = fs.existsSync(bin) ? bin : fallback;

  const cwd = path.join(repoRoot, 'node_modules', 'better-sqlite3');
  if (!fs.existsSync(cwd)) {
    throw new Error(`better-sqlite3 not installed at ${cwd}. Run \`npm install\` in the repo root first.`);
  }

  // Wipe any previous arch's binary so a stale .node never sneaks into the vsix.
  const releaseDir = path.join(cwd, 'build', 'Release');
  if (fs.existsSync(releaseDir)) {
    fs.rmSync(releaseDir, { recursive: true, force: true });
  }

  if (fs.existsSync(prebuildBin)) {
    run(prebuildBin, [
      '--platform', platform,
      '--arch', arch,
      '--runtime', 'node',
      '--target', process.versions.node,
    ], { cwd });
  } else {
    // Last-resort: npm rebuild with target env vars (requires toolchain).
    run('npm', ['rebuild', 'better-sqlite3', '--build-from-source=false'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        npm_config_target_platform: platform,
        npm_config_target_arch: arch,
      },
    });
  }
}

function packageTarget(target) {
  console.log(`\n=== Packaging ${target} ===`);
  rebuildBetterSqliteFor(target);
  // Bundle the matching Node runtime so end users do not need Node installed.
  run(process.execPath, [path.join(__dirname, 'download-node.cjs'), target]);
  // sync-engine.cjs copies repoRoot/node_modules/better-sqlite3 into the
  // extension bundle, so it will pick up the freshly-fetched binary.
  run('npm', ['run', 'compile'], { cwd: extensionRoot });
  run('npx', ['vsce', 'package', '--target', target, '--out', `dist/${target}.vsix`], {
    cwd: extensionRoot,
  });
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: node scripts/package-targets.cjs <target> [<target> ...] | all');
    process.exit(1);
  }
  const targets = args.includes('all') ? ALL_TARGETS : args;
  for (const t of targets) {
    if (!TARGET_TO_NPM[t]) {
      throw new Error(`Unknown target "${t}". Valid: ${ALL_TARGETS.join(', ')}`);
    }
  }
  fs.mkdirSync(path.join(extensionRoot, 'dist'), { recursive: true });
  for (const t of targets) {
    packageTarget(t);
  }
  console.log('\nAll targets built successfully.');
}

main();
