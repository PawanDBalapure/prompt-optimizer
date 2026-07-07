import * as vscode from 'vscode';

import { analyzePrompt } from '../chat/analyzer';
import { openChatWithPrompt } from '../commands/open';
import { maybeAutoOpenContextFiles } from '../commands/openContextFiles';
import { addConversationTurn, getConversation, resolveReferences } from '../state/conversation';
import type { PromptProxyPanelState } from '../types';
import { computeWorkspaceId } from '../util/workspace';

export interface PromptRunPorts {
  context: vscode.ExtensionContext;
  webview: vscode.Webview;
  publishAnalysis(state: PromptProxyPanelState): void;
}

/** Analyze a prompt typed in the panel and publish the result. */
export async function handleAnalyze(ports: PromptRunPorts, prompt: string): Promise<void> {
  if (!prompt.trim()) {
    ports.webview.postMessage({ type: 'error', message: 'Enter a prompt to analyze.' });
    return;
  }
  const state = await analyzePrompt(ports.context, prompt.trim(), 'panel');
  ports.publishAnalysis(state);
  await maybeAutoOpenContextFiles(ports.context, state);
}

/**
 * Agent mode: optimize locally, record the conversation turn, then send the
 * optimized prompt straight to Copilot Chat (auto-submitted).
 */
export async function handleAgentRun(
  ports: PromptRunPorts,
  prompt: string,
  token: vscode.CancellationToken,
): Promise<void> {
  const trimmed = prompt.trim();
  if (!trimmed) {
    ports.webview.postMessage({ type: 'error', message: 'Enter a prompt.' });
    return;
  }
  try {
    const state = await analyzePrompt(ports.context, trimmed, 'panel');
    if (token.isCancellationRequested) { return; }
    ports.publishAnalysis(state);
    await maybeAutoOpenContextFiles(ports.context, state);

    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const wsId = computeWorkspaceId(wsRoot);
    const history = getConversation(ports.context, wsId);
    const enriched = resolveReferences(state.optimized, history);

    // Record the user turn locally so follow-up references continue to
    // resolve. The assistant turn is not captured here because the
    // response is rendered in Copilot Chat, not the panel.
    await addConversationTurn(ports.context, wsId, {
      user_raw: trimmed,
      user_optimized: enriched,
      assistant: '',
    });

    // No @promptoptimizer prefix — the Copilot agent handles the request
    // natively in the Chat view.
    await openChatWithPrompt(enriched, false, true);
    ports.webview.postMessage({ type: 'responseDone' });
  } catch (err) {
    ports.webview.postMessage({
      type: 'responseError',
      message: err instanceof Error ? err.message : 'Agent call failed.',
    });
  }
}
