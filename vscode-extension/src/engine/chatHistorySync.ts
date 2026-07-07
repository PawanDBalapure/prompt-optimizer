import * as vscode from 'vscode';

import { CONVERSATION_KEY, MAX_CONVERSATION_TURNS } from '../constants';
import { getConversation } from '../state/conversation';
import type { ConversationTurn } from '../types';
import { computeWorkspaceId } from '../util/workspace';
import { harvestChatHistory, MIN_SEED_LEN, normalizePromptText } from './seedHarvest';

const MAX_COPILOT_IMPORT_PER_SYNC = 10;

/**
 * Imports prompts harvested from GitHub Copilot Chat into Prompt Optimizer's
 * conversation memory so they can be replayed as enrichment context.
 *
 * These imported entries are tagged as `copilot-history`, allowing the chat
 * handler to include them for LM context while keeping back-reference logic
 * focused on direct @promptoptimizer turns.
 */
export async function syncCopilotChatsToConversationMemory(
  context: vscode.ExtensionContext,
): Promise<number> {
  try {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const workspaceId = computeWorkspaceId(workspaceRoot);

    const harvested = harvestChatHistory(context)
      .map((p) => p.trim())
      .filter((p) => p.length >= MIN_SEED_LEN && p.length <= 400)
      .slice(-MAX_COPILOT_IMPORT_PER_SYNC);

    if (harvested.length === 0) { return 0; }

    const all = getConversation(context);
    const existing = new Set(
      all
        .filter((turn) => turn.workspace_id === workspaceId)
        .map((turn) => normalizePromptText(turn.user_raw)),
    );

    const now = Date.now();
    const toInsert: ConversationTurn[] = [];
    for (const [idx, prompt] of harvested.entries()) {
      const normalized = normalizePromptText(prompt);
      if (!normalized || existing.has(normalized)) { continue; }
      existing.add(normalized);
      toInsert.push({
        id: `copilot-${(now + idx).toString(36)}`,
        timestamp: now - (harvested.length - idx) * 1000,
        user_raw: prompt,
        user_optimized: prompt,
        assistant: '',
        workspace_id: workspaceId,
        source: 'copilot-history',
      });
    }

    if (toInsert.length === 0) { return 0; }

    all.push(...toInsert);
    while (all.length > MAX_CONVERSATION_TURNS * 3) { all.shift(); }
    await context.globalState.update(CONVERSATION_KEY, all);
    return toInsert.length;
  } catch {
    return 0;
  }
}
