/**
 * Workspace-ID candidate derivation (engine-side mirror of the extension's
 * `computeWorkspaceId` / `computeLegacyWorkspaceIds`).
 *
 * The VS Code extension hashes the workspace folder path to a stable id. On
 * Windows the drive-letter casing has varied across sessions (`c:\` vs `C:\`)
 * and older builds hashed the raw (non-canonicalized) path, so the same folder
 * has been stored under several ids over time. Given a `workspace_root`, this
 * reproduces every id that folder may have hashed to, canonical first, so a
 * read path can transparently find data written under any historical id.
 */
import * as path from 'node:path';

/** djb2 — must byte-for-byte match vscode-extension/src/util/workspace.ts. */
function djb2(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash) ^ text.charCodeAt(i);
    hash = hash >>> 0;
  }
  return hash.toString(16);
}

/** Canonical id: resolved, trailing-separator-stripped, lowercased on win32. */
export function canonicalWorkspaceId(workspaceRoot: string): string {
  let resolved = path.resolve(workspaceRoot);
  resolved = resolved.replace(/[\\/]+$/, '') || resolved;
  const normalized = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  return djb2(normalized);
}

/**
 * Every id the folder may have hashed to — canonical first, then legacy
 * variants (raw path, drive-letter case variants). De-duplicated, order
 * preserved so callers can prefer the canonical id.
 */
export function workspaceIdCandidates(workspaceRoot: string): string[] {
  const ids: string[] = [canonicalWorkspaceId(workspaceRoot)];
  const resolved = path.resolve(workspaceRoot).replace(/[\\/]+$/, '') || path.resolve(workspaceRoot);
  const variants = new Set<string>([workspaceRoot, resolved]);
  if (/^[a-zA-Z]:/.test(resolved)) {
    variants.add(resolved[0].toUpperCase() + resolved.slice(1));
    variants.add(resolved[0].toLowerCase() + resolved.slice(1));
  }
  for (const variant of variants) {
    const id = djb2(variant);
    if (!ids.includes(id)) { ids.push(id); }
  }
  return ids;
}
