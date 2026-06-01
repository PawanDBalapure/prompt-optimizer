#!/usr/bin/env node
/**
 * One-shot release helper.
 *
 *   node scripts/prepare-release.cjs [<bump> | <explicit-version>] [--no-tag] [--no-build] [--push]
 *
 *   bump: patch (default) | minor | major
 *
 * Steps:
 *   1. Validate clean working tree (unless --allow-dirty).
 *   2. Bump version in vscode-extension/package.json.
 *   3. Update CHANGELOG.md with a new heading + today's date (if file exists).
 *   4. Commit the bump (unless --no-commit).
 *   5. Build all platform .vsix files (unless --no-build).
 *   6. Tag the commit `v<version>` (unless --no-tag).
 *   7. Optionally `git push --follow-tags` (with --push) to trigger CI publish.
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const extensionRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(extensionRoot, '..');
const pkgPath = path.join(extensionRoot, 'package.json');
const changelogPath = path.join(extensionRoot, 'CHANGELOG.md');

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const positional = args.filter((a) => !a.startsWith('--'));

const ALLOW_DIRTY = flags.has('--allow-dirty');
const NO_COMMIT  = flags.has('--no-commit');
const NO_TAG     = flags.has('--no-tag');
const NO_BUILD   = flags.has('--no-build');
const DO_PUSH    = flags.has('--push');

function run(cmd, cmdArgs, opts = {}) {
  console.log(`> ${cmd} ${cmdArgs.join(' ')}`);
  const r = spawnSync(cmd, cmdArgs, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    cwd: opts.cwd || extensionRoot,
    ...opts,
  });
  if (r.status !== 0) { throw new Error(`Command failed: ${cmd} ${cmdArgs.join(' ')}`); }
}

function capture(cmd, cmdArgs, opts = {}) {
  const r = spawnSync(cmd, cmdArgs, {
    encoding: 'utf8',
    shell: process.platform === 'win32',
    cwd: opts.cwd || repoRoot,
  });
  if (r.status !== 0) { throw new Error(`Command failed: ${cmd} ${cmdArgs.join(' ')}\n${r.stderr}`); }
  return (r.stdout || '').trim();
}

function bumpVersion(current, kind) {
  if (/^\d+\.\d+\.\d+(?:[-.+].+)?$/.test(kind)) { return kind; } // explicit version
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(current);
  if (!m) { throw new Error(`Cannot parse current version "${current}"`); }
  const [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])];
  switch (kind) {
    case 'major': return `${maj + 1}.0.0`;
    case 'minor': return `${maj}.${min + 1}.0`;
    case 'patch':
    case undefined:
    case '':
      return `${maj}.${min}.${pat + 1}`;
    default:
      throw new Error(`Unknown bump kind "${kind}". Use patch | minor | major | <x.y.z>`);
  }
}

function ensureCleanTree() {
  if (ALLOW_DIRTY) { return; }
  const status = capture('git', ['status', '--porcelain']);
  if (status) {
    throw new Error(`Working tree not clean. Commit/stash first or pass --allow-dirty.\n${status}`);
  }
}

function updatePackageJson(newVersion) {
  const raw = fs.readFileSync(pkgPath, 'utf8');
  const updated = raw.replace(/("version"\s*:\s*")[^"]+(")/, `$1${newVersion}$2`);
  if (updated === raw) { throw new Error('Could not patch version field in package.json'); }
  fs.writeFileSync(pkgPath, updated, 'utf8');
}

function updateChangelog(newVersion) {
  if (!fs.existsSync(changelogPath)) { return; }
  const today = new Date().toISOString().slice(0, 10);
  const heading = `## ${newVersion} - ${today}\n\n- _Describe changes here._\n\n`;
  const existing = fs.readFileSync(changelogPath, 'utf8');
  // Insert after the first H1 line if present, otherwise prepend.
  const lines = existing.split(/\r?\n/);
  let insertAt = 0;
  for (let i = 0; i < lines.length; i++) {
    if (/^#\s+/.test(lines[i])) { insertAt = i + 1; break; }
  }
  // Skip blank line right after H1.
  if (lines[insertAt] === '') { insertAt += 1; }
  lines.splice(insertAt, 0, '', heading.trimEnd(), '');
  fs.writeFileSync(changelogPath, lines.join('\n'), 'utf8');
}

function main() {
  ensureCleanTree();

  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const newVersion = bumpVersion(pkg.version, positional[0]);
  console.log(`\nReleasing ${pkg.name}: ${pkg.version} -> ${newVersion}\n`);

  updatePackageJson(newVersion);
  updateChangelog(newVersion);

  if (!NO_COMMIT) {
    run('git', ['add', 'package.json', 'CHANGELOG.md'], { cwd: extensionRoot });
    run('git', ['commit', '-m', `chore(release): v${newVersion}`], { cwd: repoRoot });
  }

  if (!NO_BUILD) {
    run('node', ['scripts/package-targets.cjs', 'all']);
  }

  const tag = `v${newVersion}`;
  if (!NO_TAG) {
    run('git', ['tag', '-a', tag, '-m', `Release ${tag}`], { cwd: repoRoot });
  }

  if (DO_PUSH) {
    run('git', ['push', '--follow-tags'], { cwd: repoRoot });
    console.log(`\nPushed ${tag}. CI will publish all .vsix files.`);
  } else {
    console.log(`\nDone. To publish, run:\n  git push --follow-tags`);
    if (!NO_BUILD) {
      console.log(`Local .vsix files are in vscode-extension/dist/`);
    }
  }
}

try {
  main();
} catch (err) {
  console.error(`\nRelease aborted: ${err.message}`);
  process.exit(1);
}
