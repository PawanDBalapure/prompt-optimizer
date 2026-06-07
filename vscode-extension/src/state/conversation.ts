import * as vscode from 'vscode';

import { CONVERSATION_KEY, MAX_CONVERSATION_TURNS } from '../constants';
import type { ConversationTurn, PromptProxyPanelState } from '../types';
 
function isConversationTurn(value: unknown): value is ConversationTurn {
  const v = value as Partial<ConversationTurn> | null;
  return Boolean(
    v
    && typeof v === 'object'
    && typeof v.id === 'string'
    && typeof v.timestamp === 'number'
    && typeof v.user_raw === 'string'
    && typeof v.user_optimized === 'string'
    && typeof v.assistant === 'string'
    && typeof v.workspace_id === 'string',
  );
}

function readConversationStore(context: vscode.ExtensionContext): ConversationTurn[] {
  const raw = context.globalState.get<unknown>(CONVERSATION_KEY);
  if (!Array.isArray(raw)) { return []; }
  return raw.filter((entry): entry is ConversationTurn => isConversationTurn(entry));
}

export function getConversation(
  context: vscode.ExtensionContext,
  workspaceId?: string,
): ConversationTurn[] {
  const all = readConversationStore(context);
  if (!workspaceId) { return all; }
  return all.filter((t) => t.workspace_id === workspaceId || t.workspace_id === 'global');
}

export async function addConversationTurn(
  context: vscode.ExtensionContext,
  workspaceId: string,
  turn: { user_raw: string; user_optimized: string; assistant: string },
): Promise<void> {
  const all = readConversationStore(context);
  all.push({
    id: Date.now().toString(36),
    timestamp: Date.now(),
    workspace_id: workspaceId,
    ...turn,
  });
  // Keep at most MAX_CONVERSATION_TURNS per workspace, overall cap 3x.
  while (all.length > MAX_CONVERSATION_TURNS * 3) { all.shift(); }
  await context.globalState.update(CONVERSATION_KEY, all);
}

export async function clearConversationForWorkspace(
  context: vscode.ExtensionContext,
  workspaceId: string,
): Promise<void> {
  const all = readConversationStore(context);
  const kept = all.filter((t) => t.workspace_id !== workspaceId);
  await context.globalState.update(CONVERSATION_KEY, kept);
}

/** True if the prompt is short and uses pronouns that reference prior context. */
export function containsBackReference(prompt: string): boolean {
  return (
    prompt.split(/\s+/).length <= 20 &&
    /\b(it|that|this|those|them|the same|the file|the function|the class|the error|the bug|previous|last one|aforementioned)\b/i.test(prompt)
  );
}

/** Prepend the most recent user request as context when the prompt references it. */
export function resolveReferences(prompt: string, history: ConversationTurn[]): string {
  if (!containsBackReference(prompt) || history.length === 0) { return prompt; }
  const last = history[history.length - 1];
  const ref = last.user_raw.length > 180 ? `${last.user_raw.slice(0, 180)}\u2026` : last.user_raw;
  return `[Continuing from: "${ref}"]\n${prompt}`;
}

/**
 * Build the message array for the VS Code LM API call.
 * Injects a workspace context preamble then replays the conversation history
 * before the current optimized prompt.
 */
export function buildLMMessages(
  history: ConversationTurn[],
  currentPrompt: string,
  state: PromptProxyPanelState,
): vscode.LanguageModelChatMessage[] {
  const msgs: vscode.LanguageModelChatMessage[] = [];

  // Context preamble (expressed as the first user message since not all
  // LM providers expose a separate system role).
  const ctxLines = ['You are a helpful coding assistant working inside VS Code.'];
  if (state.analysis.context.workspace_root) {
    ctxLines.push(`Workspace: ${state.analysis.context.workspace_root}`);
  }
  if (state.analysis.context.active_file) {
    ctxLines.push(`Active file: ${state.analysis.context.active_file}`);
  }
  msgs.push(vscode.LanguageModelChatMessage.User(ctxLines.join('\n')));
  msgs.push(vscode.LanguageModelChatMessage.Assistant('Understood. Ready to help.'));

  // Replay up to 8 previous turns.
  for (const turn of history.slice(-8)) {
    msgs.push(vscode.LanguageModelChatMessage.User(turn.user_optimized));
    if (turn.assistant) {
      msgs.push(vscode.LanguageModelChatMessage.Assistant(turn.assistant));
    }
  }

  msgs.push(vscode.LanguageModelChatMessage.User(currentPrompt));
  return msgs;
}
