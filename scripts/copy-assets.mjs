/**
 * Copy non-TS engine assets that `tsc` leaves behind into `dist/`, preserving
 * directory structure. Runs as the second half of `npm run build` so the
 * vendored data files (e.g. the typos dictionary) are present in the published
 * package and travel through the extension's `sync-engine` copy step.
 */
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Source → destination directories, relative to the repo root. */
const assetDirs = [['src/engine/data', 'dist/engine/data']];

for (const [from, to] of assetDirs) {
  const src = join(repoRoot, from);
  if (!existsSync(src)) { continue; }
  const dest = join(repoRoot, to);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true });
  console.log(`Copied asset dir ${from} -> ${to}`);
}
