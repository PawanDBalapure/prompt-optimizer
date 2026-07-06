/**
 * Workspace-ID migration: merge all rows stored under a legacy workspace id
 * into a new (canonical) id.
 *
 * Why this exists: the VS Code extension derives the workspace id by hashing
 * the workspace folder path. On Windows, VS Code reports the drive letter
 * with inconsistent casing across sessions (`c:\…` vs `C:\…`), which used to
 * hash to *different* ids — the index was written under one id and read back
 * under another, so the panel showed 0 memory/graph/cache/digest counts.
 * The extension now canonicalizes the path before hashing and calls this
 * migration once per workspace to rescue data stored under the old ids.
 *
 * Strategy per table: `UPDATE OR IGNORE` moves every row that does not
 * collide with an existing row of the target id; colliding leftovers (the
 * target already has that unique key) are deleted. For `kg_nodes`, edges of
 * deleted leftover nodes are removed first so no orphan edges remain.
 */
import type Database from 'better-sqlite3';

/** Tables carrying a workspace_id column, in migration order. */
const WORKSPACE_TABLES = [
  'semantic_cache',
  'kg_nodes',
  'workspace_memory',
  'file_digest',
  'audit_log',
  'prompt_segments',
] as const;

export interface WorkspaceMigrationResult {
  ok: boolean;
  from: string;
  to: string;
  /** Rows moved per table. */
  moved: Record<string, number>;
  /** Colliding leftover rows deleted per table. */
  deleted: Record<string, number>;
}

export function migrateWorkspaceId(
  db: Database.Database,
  fromId: string,
  toId: string,
): WorkspaceMigrationResult {
  const result: WorkspaceMigrationResult = {
    ok: false, from: fromId, to: toId, moved: {}, deleted: {},
  };
  if (fromId === '' || toId === '' || fromId === toId) { return result; }

  try {
    const txn = db.transaction(() => {
      for (const table of WORKSPACE_TABLES) {
        let moved = 0;
        let deleted = 0;
        try {
          moved = db.prepare(
            `UPDATE OR IGNORE ${table} SET workspace_id = ? WHERE workspace_id = ?`,
          ).run(toId, fromId).changes;

          if (table === 'kg_nodes') {
            // Leftover nodes collide with target-id nodes; drop their edges
            // first so the graph keeps no dangling references.
            db.prepare(`
              DELETE FROM kg_edges
              WHERE src_id IN (SELECT id FROM kg_nodes WHERE workspace_id = ?)
                 OR dst_id IN (SELECT id FROM kg_nodes WHERE workspace_id = ?)
            `).run(fromId, fromId);
          }
          deleted = db.prepare(
            `DELETE FROM ${table} WHERE workspace_id = ?`,
          ).run(fromId).changes;
        } catch {
          // Table missing in an older schema — skip it.
        }
        if (moved > 0) { result.moved[table] = moved; }
        if (deleted > 0) { result.deleted[table] = deleted; }
      }
    });
    txn();
    result.ok = true;
  } catch {
    result.ok = false;
  }
  return result;
}
