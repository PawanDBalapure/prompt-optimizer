#!/usr/bin/env node
/**
 * One-shot release helper.
 *
 *   node scripts/prepare-release.cjs [<bump> | <explicit-version>] [--no-tag] [--no-build] [--no-local-vsix] [--push]
 *
 *   bump: patch (default) | minor | major
 *
 * Steps:
 *   1. Validate clean working tree (unless --allow-dirty).
 *   2. Bump version in vscode-extension/package.json.
 *   3. Update CHANGELOG.md with a new heading + today's date (if file exists).
 *   4. Commit the bump (unless --no-commit).
 *   5. Build all 7 platform .vsix files (unless --no-build).
 *   6. Always build a host-platform .vsix for local install/testing
 *      (unless --no-local-vsix; skipped when step 5 already built it).
 *   7. Tag the commit `v<version>` (unless --no-tag).
 *   8. Optionally `git push --follow-tags` (with --push) to trigger CI publish.
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

const ALLOW_DIRTY    = flags.has('--allow-dirty');
const NO_COMMIT      = flags.has('--no-commit');
const NO_TAG         = flags.has('--no-tag');
const NO_BUILD       = flags.has('--no-build');
const NO_LOCAL_VSIX  = flags.has('--no-local-vsix');
const DO_PUSH        = flags.has('--push');

/** Map process.platform + process.arch to a vsce --target string. */
function hostTarget() {
  const map = {
    'win32:x64':    'win32-x64',
    'win32:arm64':  'win32-arm64',
    'linux:x64':    'linux-x64',
    'linux:arm64':  'linux-arm64',
    'linux:arm':    'linux-armhf',
    'darwin:x64':   'darwin-x64',
    'darwin:arm64': 'darwin-arm64',
  };
  const key = `${process.platform}:${process.arch}`;
  return map[key] || null;
}

/**
 * Quote an argument so it survives Windows cmd.exe when spawnSync is invoked
 * with `shell: true`. Without this, args containing spaces, parens, or `:`
 * (e.g. `chore(release): v1.2.3`) get split into multiple tokens.
 */
function quoteArgIfNeeded(arg) {
  if (process.platform !== 'win32') { return arg; }
  if (arg === '' || /[\s"()&|<>^]/.test(arg)) {
    return `"${String(arg).replace(/"/g, '\\"')}"`;
  }
  return arg;
}

function run(cmd, cmdArgs, opts = {}) {
  console.log(`> ${cmd} ${cmdArgs.join(' ')}`);
  const useShell = process.platform === 'win32';
  const finalArgs = useShell ? cmdArgs.map(quoteArgIfNeeded) : cmdArgs;
  const r = spawnSync(cmd, finalArgs, {
    stdio: 'inherit',
    shell: useShell,
    cwd: opts.cwd || extensionRoot,
    ...opts,
  });
  if (r.status !== 0) { throw new Error(`Command failed: ${cmd} ${cmdArgs.join(' ')}`); }
}

function capture(cmd, cmdArgs, opts = {}) {
  const useShell = process.platform === 'win32';
  const finalArgs = useShell ? cmdArgs.map(quoteArgIfNeeded) : cmdArgs;
  const r = spawnSync(cmd, finalArgs, {
    encoding: 'utf8',
    shell: useShell,
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
  const heading = `## ${newVersion}\n\n- _Summarize this release in a few high-level, user-facing bullets. Keep it generic — avoid internal/implementation detail._\n\n`;
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

  // Propagate the new version into onboarding/README/lockfiles so every
  // user-facing surface stays consistent with package.json.
  run('node', ['scripts/sync-versions.cjs']);

  if (!NO_COMMIT) {
    run('git', ['add', '-A'], { cwd: extensionRoot });
    run('git', ['commit', '-m', `chore(release): v${newVersion}`], { cwd: repoRoot });
  }

  if (!NO_BUILD) {
    run('node', ['scripts/package-targets.cjs', 'all']);
  }

  // Always produce a fresh host-platform .vsix locally so the developer has
  // an installable artifact for testing. We rebuild unconditionally after a
  // version bump because a stale dist/<target>.vsix from an earlier version
  // would otherwise be picked up by an existence check.
  let localVsix = null;
  if (!NO_LOCAL_VSIX) {
    const target = hostTarget();
    if (!target) {
      console.warn(`\nSkipping local .vsix: unsupported host ${process.platform}/${process.arch}`);
    } else {
      localVsix = path.join(extensionRoot, 'dist', `${target}.vsix`);
      const builtThisRun = !NO_BUILD; // package:all already produced it
      if (!builtThisRun) {
        // Remove any stale .vsix from a previous release before rebuilding.
        if (fs.existsSync(localVsix)) {
          try { fs.unlinkSync(localVsix); } catch { /* ignore */ }
        }
        console.log(`\nBuilding host-platform .vsix (${target}) for local install...`);
        run('node', ['scripts/package-targets.cjs', target]);
      }
      if (!fs.existsSync(localVsix)) {
        throw new Error(`Expected ${localVsix} to exist after build.`);
      }
    }
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

  if (localVsix && fs.existsSync(localVsix)) {
    console.log(`\nInstall locally for testing:`);
    console.log(`  code --install-extension "${localVsix}" --force`);
  }
}

try {
  main();
} catch (err) {
  console.error(`\nRelease aborted: ${err.message}`);
  process.exit(1);
}
