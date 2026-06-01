import * as vscode from 'vscode';

import { PENDING_OPTIMIZATION_KEY } from '../constants';
import type { PromptProxyPanelState } from '../types';

/**
 * A prompt that has been analyzed via @promptoptimizer in chat but is
 * awaiting explicit user confirmation before being forwarded to Copilot.
 */
export interface PendingOptimization {
  id: string;
  workspaceId: string;
  rawPrompt: string;
  optimized: string;
  enriched: string;
  createdAt: number;
  /** Persisted snapshot used to reproduce metrics in the confirmation card. */
  state: PromptProxyPanelState;
}

/** Pending optimizations expire after 30 minutes to prevent stale sends. */
const PENDING_TTL_MS = 30 * 60 * 1000;

function newId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function setPendingOptimization(
  context: vscode.ExtensionContext,
  pending: Omit<PendingOptimization, 'id' | 'createdAt'>,
): PendingOptimization {
  const full: PendingOptimization = {
    ...pending,
    id: newId(),
    createdAt: Date.now(),
  };
  void context.workspaceState.update(PENDING_OPTIMIZATION_KEY, full);
  return full;
}

export function getPendingOptimization(
  context: vscode.ExtensionContext,
): PendingOptimization | undefined {
  const raw = context.workspaceState.get<PendingOptimization>(PENDING_OPTIMIZATION_KEY);
  if (!raw) { return undefined; }
  if (Date.now() - raw.createdAt > PENDING_TTL_MS) {
    void context.workspaceState.update(PENDING_OPTIMIZATION_KEY, undefined);
    return undefined;
  }
  return raw;
}

export function clearPendingOptimization(context: vscode.ExtensionContext): void {
  void context.workspaceState.update(PENDING_OPTIMIZATION_KEY, undefined);
}
