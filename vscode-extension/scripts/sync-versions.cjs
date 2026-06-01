#!/usr/bin/env node
/**
 * Single source of truth: vscode-extension/package.json `version`.
 *
 * Propagates that version into every other file that mentions it so docs,
 * onboarding, lockfiles, and changelog stay consistent.
 *
 * Usage:
 *   node scripts/sync-versions.cjs        # apply
 *   node scripts/sync-versions.cjs --check # exit 1 if anything would change
 *
 * This is invoked automatically by prepare-release.cjs and by the
 * `compile` npm script, so a stale version can never make it into a vsix.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const extensionRoot = path.resolve(__dirname, '..');
const repoRoot      = path.resolve(extensionRoot, '..');
const pkgPath       = path.join(extensionRoot, 'package.json');

const checkOnly = process.argv.includes('--check');

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const VERSION = pkg.version;
if (!/^\d+\.\d+\.\d+/.test(VERSION)) {
  throw new Error(`Invalid version in ${pkgPath}: "${VERSION}"`);
}

/**
 * Each rule = { file, find (RegExp), replace (string|fn), reason }.
 * `find` MUST be a global RegExp so we replace all occurrences.
 *
 * NOTE: media/onboarding.html uses a runtime placeholder
 * `{{PROMPT_OPTIMIZER_VERSION}}` substituted in src/commands/open.ts; no
 * file rewrite is needed there.
 */
const rules = [
  // Root engine package.json — the `npm --prefix .. run build` log shows this.
  {
    file: path.join(repoRoot, 'package.json'),
    find: /("version"\s*:\s*")\d+\.\d+\.\d+(")/g,
    replace: `$1${VERSION}$2`,
    reason: 'root engine package.json',
  },
  // README sentence: "Prompt Optimizer 2.8.0 includes ..."
  {
    file: path.join(extensionRoot, 'README.md'),
    find: /(Prompt Optimizer )\d+\.\d+\.\d+( includes a built-in SDLC mode layer)/g,
    replace: `$1${VERSION}$2`,
    reason: 'README SDLC blurb',
  },
  // package-lock.json top-level "version" + first nested package "" entry.
  {
    file: path.join(extensionRoot, 'package-lock.json'),
    find: /^(\s*"version"\s*:\s*")\d+\.\d+\.\d+(")/m,
    replace: `$1${VERSION}$2`,
    reason: 'package-lock root version',
  },
  {
    file: path.join(extensionRoot, 'package-lock.json'),
    // Match the empty-string ("") root package entry's "version" only.
    // Lock files start: "packages": { "": { "name": ..., "version": "..." }, ... }
    find: /("":\s*\{[^}]*?"version"\s*:\s*")\d+\.\d+\.\d+(")/s,
    replace: `$1${VERSION}$2`,
    reason: 'package-lock root package entry',
  },
];

const changes = [];
for (const rule of rules) {
  if (!fs.existsSync(rule.file)) {
    console.warn(`(skip) missing: ${path.relative(repoRoot, rule.file)}`);
    continue;
  }
  const before = fs.readFileSync(rule.file, 'utf8');
  const after = before.replace(rule.find, rule.replace);
  if (after !== before) {
    changes.push({ file: rule.file, reason: rule.reason });
    if (!checkOnly) {
      fs.writeFileSync(rule.file, after, 'utf8');
    }
  }
}

if (changes.length === 0) {
  console.log(`Versions already consistent at ${VERSION}.`);
  process.exit(0);
}

const verb = checkOnly ? 'Would update' : 'Updated';
console.log(`${verb} version to ${VERSION} in:`);
for (const c of changes) {
  console.log(`  - ${path.relative(repoRoot, c.file)}  (${c.reason})`);
}

if (checkOnly) {
  console.error('\nVersion drift detected. Run: node scripts/sync-versions.cjs');
  process.exit(1);
}

// Best-effort: refresh package-lock for the repo root too, if present and npm
// is available, so transitive dep info stays accurate. Non-fatal on failure.
const rootLock = path.join(repoRoot, 'package-lock.json');
if (fs.existsSync(rootLock)) {
  // Only patch the *root* package version line if it differs.
  try {
    const lock = JSON.parse(fs.readFileSync(rootLock, 'utf8'));
    if (lock.packages && lock.packages[''] && typeof lock.packages[''].version === 'string') {
      // Leave the workspace-level lock alone unless the root pkg name matches.
      const rootPkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
      if (rootPkg.name === pkg.name) {
        lock.packages[''].version = VERSION;
        if (typeof lock.version === 'string') { lock.version = VERSION; }
        fs.writeFileSync(rootLock, JSON.stringify(lock, null, 2) + '\n', 'utf8');
        console.log(`  - ${path.relative(repoRoot, rootLock)}  (root lockfile)`);
      }
    }
  } catch { /* ignore — root lockfile is independent */ }
  void spawnSync; // reserved for future `npm i --package-lock-only` if needed
}
