import * as crypto from 'crypto';
import * as vscode from 'vscode';

/**
 * Git-style prompt version store.  One graph per workspace, kept in
 * `globalState` so it survives reloads and rides along with the rest of
 * the extension's state.  The store intentionally mirrors a tiny subset
 * of Git semantics so the UX feels familiar:
 *
 *   - **Commit**: an immutable snapshot of a prompt (plus optional
 *     optimized output) with a sha, author, message, parent and tags.
 *   - **HEAD**: the sha that "checkout" / "commit on top of" point at.
 *   - **Branches**: named refs that move with each commit on that branch.
 *   - **Tags**: lightweight labels you can stick on any commit.
 *
 * The store is deliberately schema-versioned (`schemaVersion`) so future
 * migrations don't silently corrupt older data.
 */

const STORE_KEY = 'promptProxy.versions.v1';
const SCHEMA_VERSION = 1;
const DEFAULT_BRANCH = 'main';
/** Hard cap so a runaway commit loop never blows up globalState. */
export const MAX_COMMITS_PER_WORKSPACE = 500;

export interface PromptCommit {
  sha: string;
  parent: string | null;
  branch: string;
  timestamp: number;
  author: string;
  message: string;
  prompt: string;
  optimized?: string;
  tags: string[];
}

export interface WorkspaceVersionGraph {
  head: string | null;
  currentBranch: string;
  /** branchName -> commit sha that branch currently points at. */
  branches: Record<string, string>;
  /** All commits keyed by sha, oldest-first iteration not guaranteed. */
  commits: Record<string, PromptCommit>;
}

interface VersionStoreFile {
  schemaVersion: number;
  workspaces: Record<string, WorkspaceVersionGraph>;
}

function readStore(context: vscode.ExtensionContext): VersionStoreFile {
  const raw = context.globalState.get<VersionStoreFile>(STORE_KEY);
  if (!raw || typeof raw !== 'object' || raw.schemaVersion !== SCHEMA_VERSION) {
    return { schemaVersion: SCHEMA_VERSION, workspaces: {} };
  }
  return raw;
}

async function writeStore(
  context: vscode.ExtensionContext,
  store: VersionStoreFile,
): Promise<void> {
  await context.globalState.update(STORE_KEY, store);
}

function emptyGraph(): WorkspaceVersionGraph {
  return {
    head: null,
    currentBranch: DEFAULT_BRANCH,
    branches: {},
    commits: {},
  };
}

export function getGraph(
  context: vscode.ExtensionContext,
  wsId: string,
): WorkspaceVersionGraph {
  const store = readStore(context);
  return store.workspaces[wsId] ?? emptyGraph();
}

function defaultAuthor(): string {
  const cfg = vscode.workspace.getConfiguration('promptProxy.versions');
  const custom = cfg.get<string>('author');
  if (custom && custom.trim()) { return custom.trim(); }
  return process.env.USERNAME || process.env.USER || 'local';
}

function shortSha(input: string): string {
  return crypto.createHash('sha1').update(input).digest('hex').slice(0, 7);
}

/**
 * Create a new commit on the current branch.  Returns the saved commit
 * (with assigned sha, parent, timestamp).  No-op (returns the existing
 * HEAD commit) if the prompt text is identical to HEAD and `force` is
 * false — this prevents accidental duplicate snapshots when the user
 * mashes "Commit" twice.
 */
export async function commitPrompt(
  context: vscode.ExtensionContext,
  wsId: string,
  args: {
    prompt: string;
    optimized?: string;
    message: string;
    force?: boolean;
    branch?: string;
  },
): Promise<PromptCommit> {
  const store = readStore(context);
  const graph = store.workspaces[wsId] ?? emptyGraph();
  const branch = (args.branch ?? graph.currentBranch ?? DEFAULT_BRANCH).trim() || DEFAULT_BRANCH;
  graph.currentBranch = branch;

  const parent = graph.branches[branch] ?? graph.head ?? null;
  if (!args.force && parent) {
    const parentCommit = graph.commits[parent];
    if (parentCommit && parentCommit.prompt === args.prompt && (parentCommit.optimized ?? '') === (args.optimized ?? '')) {
      return parentCommit;
    }
  }

  const ts = Date.now();
  const sha = shortSha(`${parent ?? ''}\n${ts}\n${args.prompt}\n${args.optimized ?? ''}`);
  const commit: PromptCommit = {
    sha,
    parent,
    branch,
    timestamp: ts,
    author: defaultAuthor(),
    message: args.message.trim() || '(no message)',
    prompt: args.prompt,
    optimized: args.optimized,
    tags: [],
  };
  graph.commits[sha] = commit;
  graph.branches[branch] = sha;
  graph.head = sha;

  // Prune the oldest commits if we blow past the cap.  We walk the parent
  // chain from HEAD; anything unreachable from any branch ref is deleted.
  const totalCommits = Object.keys(graph.commits).length;
  if (totalCommits > MAX_COMMITS_PER_WORKSPACE) {
    pruneUnreachable(graph, MAX_COMMITS_PER_WORKSPACE);
  }

  store.workspaces[wsId] = graph;
  await writeStore(context, store);
  return commit;
}

function pruneUnreachable(graph: WorkspaceVersionGraph, cap: number): void {
  const reachable = new Set<string>();
  const seeds = new Set<string>();
  for (const sha of Object.values(graph.branches)) { seeds.add(sha); }
  if (graph.head) { seeds.add(graph.head); }
  for (const seed of seeds) {
    let cur: string | null = seed;
    while (cur && !reachable.has(cur)) {
      reachable.add(cur);
      cur = graph.commits[cur]?.parent ?? null;
    }
  }
  for (const sha of Object.keys(graph.commits)) {
    if (!reachable.has(sha)) { delete graph.commits[sha]; }
  }
  // Still over cap?  Trim oldest reachable commits by timestamp, stopping
  // before we orphan a branch ref.
  let remaining = Object.values(graph.commits).sort((a, b) => a.timestamp - b.timestamp);
  const branchHeads = new Set(Object.values(graph.branches));
  while (remaining.length > cap) {
    const victim = remaining.shift();
    if (!victim) { break; }
    if (branchHeads.has(victim.sha)) { break; }
    delete graph.commits[victim.sha];
  }
}

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
