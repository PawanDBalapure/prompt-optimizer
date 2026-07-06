import * as path from 'path';

/**
 * Simple djb2 hash to derive a stable workspace ID from the folder path.
 * Deterministic, fast, and avoids leaking absolute paths into cache keys.
 */
function djb2(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash) ^ text.charCodeAt(i);
    hash = hash >>> 0; // keep 32-bit unsigned
  }
  return hash.toString(16);
}

/**
 * Canonicalize a workspace root before hashing. On Windows, VS Code reports
 * the drive letter with inconsistent casing across sessions (`c:\…` vs
 * `C:\…`); paths there are case-insensitive, so the id must be too —
 * otherwise the same folder hashes to different ids and previously indexed
 * memory/graph/cache data "disappears" from the panel.
 */
export function canonicalizeWorkspaceRoot(workspaceRoot: string): string {
  let resolved = path.resolve(workspaceRoot);
  // Strip trailing separators (keep bare drive roots like "C:\" intact).
  resolved = resolved.replace(/[\\/]+$/, '') || resolved;
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** Stable workspace ID derived from the canonicalized folder path. */
export function computeWorkspaceId(workspaceRoot?: string): string {
  if (!workspaceRoot) { return 'global'; }
  return djb2(canonicalizeWorkspaceRoot(workspaceRoot));
}

/**
 * Ids this folder may have hashed to before canonicalization — the raw path
 * plus upper/lower drive-letter variants. Used once per workspace to migrate
 * legacy rows onto the canonical id. Excludes the canonical id itself.
 */
export function computeLegacyWorkspaceIds(workspaceRoot?: string): string[] {
  if (!workspaceRoot) { return []; }
  const canonical = computeWorkspaceId(workspaceRoot);
  const resolved = path.resolve(workspaceRoot).replace(/[\\/]+$/, '') || path.resolve(workspaceRoot);
  const variants = new Set<string>([workspaceRoot, resolved]);
  if (/^[a-zA-Z]:/.test(resolved)) {
    variants.add(resolved[0].toUpperCase() + resolved.slice(1));
    variants.add(resolved[0].toLowerCase() + resolved.slice(1));
  }
  const out = new Set<string>();
  for (const variant of variants) {
    const id = djb2(variant);
    if (id !== canonical) { out.add(id); }
  }
  return [...out];
}
