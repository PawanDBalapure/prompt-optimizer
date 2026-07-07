import * as vscode from 'vscode';

import { runEngineRaw } from '../../engine/runner';
import { workspaceRoot } from '../../instructions/paths';

interface InstructionStudioConflict {
  code: string;
  severity: 'warning' | 'error';
  message: string;
  nodeIds: string[];
}

interface InstructionStudioReplaySession {
  sessionId: string;
  workflowName: string;
  timestamp: string;
  steps: Array<{ type: string; timestamp: string; title: string; detail: string }>;
}

const STUDIO_DIR = '.instruction_studio';

const FALLBACK_GRAPH = {
  workflowName: 'Copilot Instructions Starter',
  nodes: [
    { id: 'persona-architect', type: 'persona', label: 'SDLC Architect' },
    { id: 'condition-code', type: 'condition', label: 'If writing code' },
    { id: 'priority-critical', type: 'priority', label: 'Critical' },
    { id: 'scope-generation', type: 'agentScope', label: 'Code Generation' },
    { id: 'rule-architect', type: 'rule', text: 'Read .promptoptimizer/skills/sdlc-architect.md. Follow everything written there. Do not write any code until you have read and understood the entire file.' },
  ],
  edges: [
    { from: 'persona-architect', to: 'condition-code' },
    { from: 'condition-code', to: 'priority-critical' },
    { from: 'priority-critical', to: 'scope-generation' },
    { from: 'scope-generation', to: 'rule-architect' },
  ],
};

/**
 * Conflict-check the graph, compile it through the engine, and open the
 * generated instructions file. Returns true when a compile happened (so the
 * caller can refresh trace/insights/replay views).
 */
export async function compileStudioGraph(
  webview: vscode.Webview,
  graphFromWebview?: unknown,
): Promise<boolean> {
  const wsRoot = workspaceRoot();
  if (!wsRoot) {
    vscode.window.showWarningMessage('Open a workspace folder first.');
    return false;
  }
  const graph = graphFromWebview ?? FALLBACK_GRAPH;
  try {
    const conflictRaw = runEngineRaw(['--instruction-studio-conflicts'], JSON.stringify(graph));
    const conflictPayload = JSON.parse(conflictRaw) as { conflicts?: InstructionStudioConflict[] };
    const conflicts = conflictPayload.conflicts ?? [];
    await webview.postMessage({ type: 'conflicts', conflicts });
    if (conflicts.some((c) => c.severity === 'error')) {
      vscode.window.showWarningMessage('Instruction Studio compile blocked due to error-level conflicts.');
      return false;
    }

    const raw = runEngineRaw(
      ['--instruction-studio-compile', '--workspace-root', wsRoot],
      JSON.stringify(graph),
    );
    const result = JSON.parse(raw) as {
      ok: boolean;
      versionIndex: number;
      files: { instructions: string };
    };
    if (!result.ok) { throw new Error('Engine CLI returned a failed studio compile result.'); }
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(result.files.instructions));
    await vscode.window.showTextDocument(doc, { preview: false });
    vscode.window.showInformationMessage(
      `Instruction Studio scaffold saved to ${STUDIO_DIR}/ (history v${result.versionIndex}).`,
    );
    return true;
  } catch (error) {
    vscode.window.showErrorMessage(
      `Instruction Studio scaffold failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

/** Post dashboard insight metrics. */
export async function postInsights(webview: vscode.Webview): Promise<void> {
  const wsRoot = workspaceRoot();
  if (!wsRoot) {
    await webview.postMessage({ type: 'insights', insights: null });
    return;
  }
  try {
    const raw = runEngineRaw(['--instruction-studio-insights', '--workspace-root', wsRoot]);
    const payload = JSON.parse(raw) as { insights?: unknown };
    await webview.postMessage({ type: 'insights', insights: payload.insights ?? null });
  } catch {
    await webview.postMessage({ type: 'insights', insights: null });
  }
}

/** Post replay sessions (optionally focused on one session id). */
export async function postReplay(webview: vscode.Webview, sessionId?: string): Promise<void> {
  const wsRoot = workspaceRoot();
  if (!wsRoot) {
    await webview.postMessage({ type: 'replay', sessions: [], activeSessionId: null });
    return;
  }
  try {
    const args = ['--instruction-studio-replay', '--workspace-root', wsRoot];
    if (sessionId) { args.push('--session-id', sessionId); }
    const raw = runEngineRaw(args);
    const payload = JSON.parse(raw) as {
      sessions?: InstructionStudioReplaySession[];
      activeSessionId?: string | null;
    };
    await webview.postMessage({
      type: 'replay',
      sessions: payload.sessions ?? [],
      activeSessionId: payload.activeSessionId ?? null,
    });
  } catch {
    await webview.postMessage({ type: 'replay', sessions: [], activeSessionId: null });
  }
}
