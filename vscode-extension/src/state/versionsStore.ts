import * as crypto from 'node:crypto';
import * as vscode from 'vscode';

/**
 * Git-style prompt version store primitives.  One graph per workspace, kept
 * in `globalState` so it survives reloads.  Schema-versioned so future
 * migrations don't silently corrupt older data.
 */

const STORE_KEY = 'promptProxy.versions.v1';
const SCHEMA_VERSION = 1;
export const DEFAULT_BRANCH = 'main';
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

export interface VersionStoreFile {
  schemaVersion: number;
  workspaces: Record<string, WorkspaceVersionGraph>;
}

export function readStore(context: vscode.ExtensionContext): VersionStoreFile {
  const raw = context.globalState.get<VersionStoreFile>(STORE_KEY);
  if (!raw || typeof raw !== 'object' || raw.schemaVersion !== SCHEMA_VERSION) {
    return { schemaVersion: SCHEMA_VERSION, workspaces: {} };
  }
  return raw;
}

export async function writeStore(
  context: vscode.ExtensionContext,
  store: VersionStoreFile,
): Promise<void> {
  await context.globalState.update(STORE_KEY, store);
}

export function emptyGraph(): WorkspaceVersionGraph {
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
  const remaining = Object.values(graph.commits).sort((a, b) => a.timestamp - b.timestamp);
  const branchHeads = new Set(Object.values(graph.branches));
  while (remaining.length > cap) {
    const victim = remaining.shift();
    if (!victim) { break; }
    if (branchHeads.has(victim.sha)) { break; }
    delete graph.commits[victim.sha];
  }
}

/**
 * Create a new commit on the current branch.  Returns the saved commit.
 * No-op (returns the existing HEAD commit) if the prompt text is identical
 * to HEAD and `force` is false — prevents accidental duplicate snapshots.
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

  if (Object.keys(graph.commits).length > MAX_COMMITS_PER_WORKSPACE) {
    pruneUnreachable(graph, MAX_COMMITS_PER_WORKSPACE);
  }

  store.workspaces[wsId] = graph;
  await writeStore(context, store);
  return commit;
}
