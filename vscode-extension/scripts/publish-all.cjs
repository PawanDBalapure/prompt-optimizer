#!/usr/bin/env node
/**
 * Publish every .vsix in vscode-extension/dist/ to the VS Code Marketplace.
 *
 * Usage:
 *   $env:VSCE_PAT = "your-pat-here"
 *   node scripts/publish-all.cjs           # publishes every dist/*.vsix
 *   node scripts/publish-all.cjs --dry-run # show what would be published
 *
 * Why a script instead of a shell loop:
 *  - Consistent quoting/spawn behaviour across PowerShell, cmd, bash.
 *  - Skips files that don't match the per-target naming convention.
 *  - Continues on a per-target failure so a transient network blip on one
 *    arch doesn't abort the rest. Final exit code is non-zero if any
 *    target failed.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const extensionRoot = path.resolve(__dirname, '..');
const distDir = path.join(extensionRoot, 'dist');

const KNOWN_TARGETS = new Set([
  'win32-x64', 'win32-arm64',
  'linux-x64', 'linux-arm64', 'linux-armhf',
  'darwin-x64', 'darwin-arm64',
]);

function quoteForShell(s) {
  if (process.platform !== 'win32') { return s; }
  if (s === '' || /[\s"()&|<>^]/.test(s)) {
    return `"${String(s).replace(/"/g, '\\"')}"`;
  }
  return s;
}

function run(cmd, args) {
  console.log(`\n> ${cmd} ${args.join(' ')}`);
  const useShell = process.platform === 'win32';
  const finalCmd = useShell ? quoteForShell(cmd) : cmd;
  const finalArgs = useShell ? args.map(quoteForShell) : args;
  const r = spawnSync(finalCmd, finalArgs, {
    stdio: 'inherit',
    shell: useShell,
    cwd: extensionRoot,
  });
  return r.status === 0;
}

function main() {
  const dryRun = process.argv.includes('--dry-run');
  const pat = process.env.VSCE_PAT;
  if (!pat && !dryRun) {
    console.error('VSCE_PAT environment variable is not set.');
    console.error('PowerShell:  $env:VSCE_PAT = "your-pat"');
    console.error('cmd.exe:     set VSCE_PAT=your-pat');
    console.error('bash:        export VSCE_PAT=your-pat');
    process.exit(1);
  }

  if (!fs.existsSync(distDir)) {
    console.error(`No dist/ directory at ${distDir}. Run "npm run package:all" first.`);
    process.exit(1);
  }

  const files = fs.readdirSync(distDir)
    .filter((f) => f.endsWith('.vsix'))
    .filter((f) => {
      const target = path.basename(f, '.vsix');
      if (!KNOWN_TARGETS.has(target)) {
        console.warn(`Skipping ${f} (unrecognised target).`);
        return false;
      }
      return true;
    })
    .sort();

  if (files.length === 0) {
    console.error('No .vsix files found in dist/. Run "npm run package:all" first.');
    process.exit(1);
  }

  console.log(`Found ${files.length} .vsix file(s) to publish:`);
  files.forEach((f) => console.log(`  - ${f}`));

  if (dryRun) {
    console.log('\n(dry-run; no uploads performed)');
    return;
  }

  const failed = [];
  for (const file of files) {
    const target = path.basename(file, '.vsix');
    const fullPath = path.join('dist', file);
    console.log(`\n=== Publishing ${target} ===`);
    const ok = run('npx', [
      '@vscode/vsce', 'publish',
      '--packagePath', fullPath,
      '--pat', pat,
    ]);
    if (!ok) { failed.push(target); }
  }

  console.log('');
  if (failed.length > 0) {
    console.error(`Failed: ${failed.join(', ')}`);
    process.exit(1);
  }
  console.log(`Successfully published ${files.length} platform(s) to the Marketplace.`);
}

main();
