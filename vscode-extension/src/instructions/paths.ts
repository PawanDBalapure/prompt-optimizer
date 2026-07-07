import * as path from 'node:path';
import * as vscode from 'vscode';

/** Outcome of an instruction action, transport-agnostic so any panel can post it. */
export interface ActionResult {
  ok: boolean;
  message?: string;
  error?: string;
}

/** One git commit row for the instruction-history view. */
export interface InstructionCommit {
  sha: string;
  author: string;
  date: string;
  relative: string;
  subject: string;
}

/** First workspace folder path, or undefined when no folder is open. */
export function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/**
 * Resolve and validate a workspace-relative instruction path.
 * Rejects absolute paths and any traversal outside the workspace.
 */
export function resolveInstructionPath(
  relPath: string,
): { wsRoot: string; abs: string } | null {
  const wsRoot = workspaceRoot();
  if (!wsRoot) { return null; }
  const normalized = relPath.replace(/\\/g, '/');
  if (!normalized || normalized.includes('..') || path.isAbsolute(normalized)) { return null; }
  const abs = path.resolve(wsRoot, normalized);
  const rel = path.relative(wsRoot, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) { return null; }
  return { wsRoot, abs };
}

/** Bundled persona/skill library directory inside the installed extension. */
export function personaLibraryDir(extensionFsPath: string): string {
  return path.join(extensionFsPath, 'media', 'skill-library');
}

/** Workspace skills directory (`.promptoptimizer/skills`). */
export function workspaceSkillsDir(wsRoot: string): string {
  return path.join(wsRoot, '.promptoptimizer', 'skills');
}
