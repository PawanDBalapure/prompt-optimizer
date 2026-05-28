/**
 * Simple djb2 hash to derive a stable workspace ID from the folder path.
 * Deterministic, fast, and avoids leaking absolute paths into cache keys.
 */
export function computeWorkspaceId(workspaceRoot?: string): string {
  if (!workspaceRoot) { return 'global'; }
  let hash = 5381;
  for (let i = 0; i < workspaceRoot.length; i++) {
    hash = ((hash << 5) + hash) ^ workspaceRoot.charCodeAt(i);
    hash = hash >>> 0; // keep 32-bit unsigned
  }
  return hash.toString(16);
}
