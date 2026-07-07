import * as child_process from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Locate the Node.js binary the engine sidecar should run under.
 *
 * Order:
 *   1. Bundled Node runtime that ships inside the .vsix at
 *      `<extension>/engine-runtime/node[.exe]`. Each platform-specific
 *      .vsix carries the matching binary, so end users need nothing
 *      installed.
 *   2. System `node` on PATH (legacy fallback for source installs).
 *   3. Common Windows install locations.
 *   4. Electron binary (process.execPath) — last resort; will fail for
 *      native modules but better than throwing here.
 */
export function findSystemNode(): string {
  const probe = (exe: string): boolean => {
    try {
      const r = child_process.spawnSync(exe, ['--version'], {
        encoding: 'utf8', shell: false, env: process.env,
      });
      return r.status === 0 && typeof r.stdout === 'string' && r.stdout.trim().startsWith('v');
    } catch {
      return false;
    }
  };

  // 1. Bundled runtime (preferred).
  const bundledName = process.platform === 'win32' ? 'node.exe' : 'node';
  const bundled = path.resolve(__dirname, '../../engine-runtime', bundledName);
  if (fs.existsSync(bundled)) {
    // Cross-platform safety: .vsix is a ZIP, which doesn't always preserve
    // the Unix executable bit. Force +x on macOS/Linux before probing so a
    // .vsix produced on Windows still works on POSIX.
    if (process.platform !== 'win32') {
      try {
        const st = fs.statSync(bundled);
        // 0o111 = any-execute bits set
        if ((st.mode & 0o111) === 0) {
          fs.chmodSync(bundled, 0o755);
        }
      } catch { /* ignore — probe will fail and we fall through */ }
    }
    // macOS Gatekeeper marks downloaded binaries with com.apple.quarantine.
    // Strip it so spawn() doesn't get blocked. Best-effort; ignore failure.
    if (process.platform === 'darwin') {
      try {
        child_process.spawnSync('xattr', ['-d', 'com.apple.quarantine', bundled], {
          stdio: 'ignore', shell: false,
        });
      } catch { /* ignore */ }
    }
    if (probe(bundled)) { return bundled; }
  }

  // 2. System node on PATH.
  const name = process.platform === 'win32' ? 'node.exe' : 'node';
  if (probe(name)) { return name; }

  // 3. Well-known Windows install locations.
  if (process.platform === 'win32') {
    const candidates = [
      'C:\\Program Files\\nodejs\\node.exe',
      'C:\\Program Files (x86)\\nodejs\\node.exe',
    ];
    for (const p of candidates) {
      if (fs.existsSync(p) && probe(p)) { return p; }
    }
  }

  // 4. Electron fallback.
  return process.execPath;
}

export function getCliPath(): string {
  return path.resolve(__dirname, '../../engine/dist/cli.js');
}
