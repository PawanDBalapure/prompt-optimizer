import * as vscode from 'vscode';

import {
  DEFAULT_BRANCH,
  emptyGraph,
  readStore,
  writeStore,
  type PromptCommit,
  type WorkspaceVersionGraph,
} from './versionsStore';

// The full store surface stays importable from `state/versions` so callers
// keep a single import path.
export {
  commitPrompt,
  getGraph,
  MAX_COMMITS_PER_WORKSPACE,
  type PromptCommit,
  type WorkspaceVersionGraph,
} from './versionsStore';

export async function checkout(
  context: vscode.ExtensionContext,
  wsId: string,
  sha: string,
): Promise<PromptCommit | undefined> {
  const store = readStore(context);
  const graph = store.workspaces[wsId];
  if (!graph) { return undefined; }
  const commit = graph.commits[sha];
  if (!commit) { return undefined; }
  graph.head = sha;
  // Detached-HEAD-ish: don't move the branch pointer.  Restore the branch
  // record so subsequent commits build on the checked-out version.
  graph.currentBranch = commit.branch;
  store.workspaces[wsId] = graph;
  await writeStore(context, store);
  return commit;
}

export async function createBranch(
  context: vscode.ExtensionContext,
  wsId: string,
  name: string,
  fromSha?: string,
): Promise<void> {
  const store = readStore(context);
  const graph = store.workspaces[wsId] ?? emptyGraph();
  const target = fromSha ?? graph.head;
  if (!target || !graph.commits[target]) {
    throw new Error('Cannot create a branch: no commits exist yet.');
  }
  if (graph.branches[name]) {
    throw new Error(`Branch "${name}" already exists.`);
  }
  graph.branches[name] = target;
  graph.currentBranch = name;
  graph.head = target;
  store.workspaces[wsId] = graph;
  await writeStore(context, store);
}

export async function deleteBranch(
  context: vscode.ExtensionContext,
  wsId: string,
  name: string,
): Promise<void> {
  if (name === DEFAULT_BRANCH) {
    throw new Error(`Cannot delete the default branch "${DEFAULT_BRANCH}".`);
  }
  const store = readStore(context);
  const graph = store.workspaces[wsId];
  if (!graph || !graph.branches[name]) { return; }
  delete graph.branches[name];
  if (graph.currentBranch === name) {
    graph.currentBranch = DEFAULT_BRANCH;
    graph.head = graph.branches[DEFAULT_BRANCH] ?? null;
  }
  store.workspaces[wsId] = graph;
  await writeStore(context, store);
}

export async function tagCommit(
  context: vscode.ExtensionContext,
  wsId: string,
  sha: string,
  tag: string,
): Promise<void> {
  const store = readStore(context);
  const graph = store.workspaces[wsId];
  const commit = graph?.commits[sha];
  if (!commit) { throw new Error(`Unknown commit ${sha}.`); }
  const clean = tag.trim();
  if (!clean) { return; }
  if (!commit.tags.includes(clean)) { commit.tags.push(clean); }
  await writeStore(context, store);
}

export async function deleteCommit(
  context: vscode.ExtensionContext,
  wsId: string,
  sha: string,
): Promise<void> {
  const store = readStore(context);
  const graph = store.workspaces[wsId];
  if (!graph || !graph.commits[sha]) { return; }
  // Re-parent any children of this commit onto the deleted commit's parent
  // so the chain doesn't break.
  const parent = graph.commits[sha].parent;
  for (const c of Object.values(graph.commits)) {
    if (c.parent === sha) { c.parent = parent; }
  }
  for (const [name, refSha] of Object.entries(graph.branches)) {
    if (refSha === sha) { graph.branches[name] = parent ?? Object.keys(graph.commits)[0]; }
  }
  if (graph.head === sha) { graph.head = parent; }
  delete graph.commits[sha];
  await writeStore(context, store);
}

/**
 * Return commits in `git log --topo-order`-ish order: HEAD first, then
 * walk the parent chain.  Unreachable commits (e.g. on deleted branches)
 * are appended at the end, newest-first.
 */
export function logCommits(graph: WorkspaceVersionGraph): PromptCommit[] {
  const out: PromptCommit[] = [];
  const seen = new Set<string>();
  const queue: string[] = [];
  if (graph.head) { queue.push(graph.head); }
  for (const refSha of Object.values(graph.branches)) {
    if (!seen.has(refSha)) { queue.push(refSha); }
  }
  while (queue.length) {
    const sha = queue.shift();
    if (!sha || seen.has(sha)) { continue; }
    const c = graph.commits[sha];
    if (!c) { continue; }
    seen.add(sha);
    out.push(c);
    if (c.parent) { queue.push(c.parent); }
  }
  // Anything left over (unreachable from refs/HEAD) — append by recency.
  const orphans = Object.values(graph.commits)
    .filter((c) => !seen.has(c.sha))
    .sort((a, b) => b.timestamp - a.timestamp);
  out.push(...orphans);
  return out;
}
