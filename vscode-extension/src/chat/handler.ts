import * as vscode from 'vscode';

import { CONVERSATION_KEY } from '../constants';
import { openChatWithPrompt, openPromptProxyPanel, openExtensionReadme } from '../commands/open';
import {
  addConversationTurn,
  buildLMMessages,
  clearConversationForWorkspace,
  getConversation,
  resolveReferences,
} from '../state/conversation';
import { getCurrentMode, setCurrentMode, updateStatusBarItem } from '../state/mode';
import {
  clearPendingOptimization,
  getPendingOptimization,
  setPendingOptimization,
} from '../state/pending';
import type { ConversationTurn, ProxyMode, PromptProxyPanelState } from '../types';
import { formatCurrency } from '../util/format';
import { computeWorkspaceId } from '../util/workspace';
import { analyzePrompt, buildRuntimeSnapshot } from './analyzer';
import { addContextReferences, renderChatAnalysisMarkdown, renderContextReportMarkdown } from './rendering';

void openExtensionReadme; // re-exported helper kept reachable for command wiring

export interface ChatHandlerSinks {
  publishAnalysis: (state: import('../types').PromptProxyPanelState) => void;
  notifyModeChange: (mode: ProxyMode) => void;
}

function isProxyMode(value: string): value is ProxyMode {
  return value === 'agent' || value === 'optimize' || value === 'direct';
}

export async function handleChatRequest(
  context: vscode.ExtensionContext,
  sinks: ChatHandlerSinks,
  statusBarItem: vscode.StatusBarItem,
  request: vscode.ChatRequest,
  chatContext: vscode.ChatContext,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<vscode.ChatResult> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const workspaceId = computeWorkspaceId(workspaceRoot);

  if (request.command === 'context') {
    const runtime = buildRuntimeSnapshot(context, chatContext);
    stream.markdown(renderContextReportMarkdown(runtime));
    stream.button({ command: 'prompt-proxy.focusPanel', title: 'Open control panel' });
    stream.button({ command: 'prompt-proxy.openReadme', title: 'Open README' });
    return { metadata: { command: 'context' } };
  }

  if (request.command === 'memory') {
    const history = getConversation(context, workspaceId);
    if (history.length === 0) {
      stream.markdown('No conversation memory yet. Start chatting with `@promptoptimizer` to build context across turns.');
    } else {
      stream.markdown(`**Conversation memory** \u2014 ${history.length} turn${history.length === 1 ? '' : 's'} remembered\n\n`);
      for (const [i, turn] of history.entries()) {
        const ago = Math.round((Date.now() - turn.timestamp) / 60000);
        stream.markdown(`**Turn ${i + 1}** *(${ago < 2 ? 'just now' : `${ago} min ago`})*\n\n`);
        stream.markdown(`> You: ${turn.user_raw.slice(0, 200)}\n\n`);
        stream.markdown(`> Assistant: ${turn.assistant.slice(0, 300)}${turn.assistant.length > 300 ? '\u2026' : ''}\n\n---\n\n`);
      }
    }
    stream.button({ command: 'prompt-proxy.clearMemory', title: 'Clear memory' });
    return { metadata: { command: 'memory' } };
  }

  if (request.command === 'clear') {
    await clearConversationForWorkspace(context, workspaceId);
    stream.markdown('Conversation memory for this workspace has been cleared.');
    return { metadata: { command: 'clear' } };
  }

  if (request.command === 'mode') {
    const arg = request.prompt.trim().toLowerCase();
    if (isProxyMode(arg)) {
      await setCurrentMode(context, arg);
      updateStatusBarItem(statusBarItem, arg);
      sinks.notifyModeChange(arg);
      const modeDescriptions: Record<ProxyMode, string> = {
        agent: 'optimize the prompt locally, then send it directly to Copilot Chat (no `@promptoptimizer` prefix needed)',
        optimize: 'show analysis only \u2014 you control when it goes to Copilot',
        direct: 'pre-fill `@promptoptimizer` in Chat and press Enter',
      };
      stream.markdown(`Mode set to **${arg}** \u2014 ${modeDescriptions[arg]}.\n\nThis applies to the sidebar panel. In the Chat panel, any message to \`@promptoptimizer\` still follows the same mode.`);
    } else {
      const current = getCurrentMode(context);
      stream.markdown(
        `**Current mode: ${current}**\n\n` +
        'Available modes:\n' +
        '- `agent` \u2014 optimize the prompt and send it directly to Copilot Chat\n' +
        '- `optimize` \u2014 show optimization analysis only\n' +
        '- `direct` \u2014 open @promptoptimizer chat with prompt pre-filled\n\n' +
        'Usage: `@promptoptimizer /mode agent`',
      );
    }
    return { metadata: { command: 'mode' } };
  }

  if (request.command === 'cancel') {
    clearPendingOptimization(context);
    stream.markdown('Pending optimized prompt discarded. Nothing was sent to Copilot.');
    return { metadata: { command: 'cancel' } };
  }

  if (request.command === 'send') {
    const pending = getPendingOptimization(context);
    if (!pending) {
      stream.markdown(
        'No pending optimized prompt to send. Type `@promptoptimizer <your prompt>` first to optimize, then run `/send`.',
      );
      return { metadata: { command: 'send' } };
    }
    if (pending.workspaceId !== workspaceId) {
      stream.markdown(
        'The pending optimized prompt belongs to a different workspace. Re-run `@promptoptimizer` here to optimize again.',
      );
      return { metadata: { command: 'send' } };
    }
    stream.markdown(
      `> \u2192 *Sending the optimized prompt you confirmed (${pending.state.metrics.tokens_saved} tokens saved).*\n\n`,
    );
    await forwardToCopilot(
      context,
      workspaceId,
      pending.rawPrompt,
      pending.enriched,
      pending.state,
      stream,
      token,
    );
    clearPendingOptimization(context);
    return {
      metadata: {
        command: 'send',
        cache: pending.state.analysis.cache.status,
        estimatedCostUSD: pending.state.metrics.estimated_cost_usd,
      },
    };
  }

  const prompt = request.prompt.trim();
  if (!prompt) {
    stream.markdown(
      'Enter a prompt or use `/context` to inspect your workspace context, `/memory` to review conversation history, or `/clear` to reset it.',
    );
    return { metadata: { command: request.command ?? 'optimize' } };
  }

  stream.progress('Checking the local semantic cache and packing workspace context\u2026');
  const state = await analyzePrompt(context, prompt, 'chat', chatContext);

  if (token.isCancellationRequested) {
    return { metadata: { command: request.command ?? 'optimize' } };
  }

  sinks.publishAnalysis(state);

  const savedPct = state.metrics.raw_input_tokens > 0
    ? Math.round((state.metrics.tokens_saved / state.metrics.raw_input_tokens) * 100)
    : 0;
  if (state.metrics.tokens_saved > 0) {
    stream.markdown(
      `> \u2726 *Prompt optimized \u2014 ${state.metrics.tokens_saved} tokens saved (${savedPct}%), estimated cost ${formatCurrency(state.metrics.estimated_cost_usd)}*\n\n`,
    );
  }

  const history = getConversation(context, workspaceId);
  const enrichedPrompt = resolveReferences(state.optimized, history);

  // Confirmation gate: when enabled (default), present the optimized prompt
  // and wait for the user to click Send / Edit / Cancel before forwarding to
  // Copilot. This prevents the surprise of a prompt being sent automatically.
  const confirmBeforeSend = vscode.workspace.getConfiguration('promptProxy')
    .get<boolean>('confirmBeforeSend') !== false;

  if (confirmBeforeSend && (request.command === undefined || request.command === 'optimize')) {
    const pending = setPendingOptimization(context, {
      workspaceId,
      rawPrompt: prompt,
      optimized: state.optimized,
      enriched: enrichedPrompt,
      state,
    });
    renderConfirmationCard(stream, state, pending.id);
    return {
      metadata: {
        command: request.command ?? 'optimize',
        cache: state.analysis.cache.status,
        estimatedCostUSD: state.metrics.estimated_cost_usd,
        pendingId: pending.id,
      },
    };
  }

  await forwardToCopilot(
    context,
    workspaceId,
    prompt,
    enrichedPrompt,
    state,
    stream,
    token,
  );

  stream.button({ command: 'prompt-proxy.focusPanel', title: 'Open control panel' });

  return {
    metadata: {
      command: request.command ?? 'optimize',
      cache: state.analysis.cache.status,
      estimatedCostUSD: state.metrics.estimated_cost_usd,
    },
  };
}

/**
 * Renders the optimized prompt with explicit Send / Edit / Cancel buttons.
 * The user must click one before the prompt is forwarded to Copilot.
 */
function renderConfirmationCard(
  stream: vscode.ChatResponseStream,
  state: PromptProxyPanelState,
  pendingId: string,
): void {
  stream.markdown('### Optimized prompt — review before sending\n\n');
  stream.markdown('```text\n' + state.optimized + '\n```\n\n');

  if (state.warnings && state.warnings.length > 0) {
    stream.markdown('> \u26A0\uFE0F **Warnings**\n');
    for (const w of state.warnings) {
      stream.markdown(`> - ${w}\n`);
    }
    stream.markdown('\n');
  }

  stream.markdown(
    '_Click **Send** to forward this to Copilot, **Edit** to tweak it first, or **Cancel** to discard. ' +
    'You can also disable this confirmation in settings (`promptProxy.confirmBeforeSend`)._\n',
  );

  stream.button({
    command: 'prompt-proxy.confirmAndSend',
    title: '\u2713 Send to Copilot',
    arguments: [pendingId],
  });
  stream.button({
    command: 'prompt-proxy.editPendingPrompt',
    title: '\u270E Edit & send',
    arguments: [pendingId],
  });
  stream.button({
    command: 'prompt-proxy.cancelPending',
    title: '\u2715 Cancel',
    arguments: [pendingId],
  });
  stream.button({
    command: 'prompt-proxy.copyPrompt',
    title: 'Copy optimized prompt',
    arguments: [state.optimized],
  });
  stream.button({ command: 'prompt-proxy.focusPanel', title: 'Open control panel' });
}

/**
 * Sends the (already-optimized, already-enriched) prompt to the Copilot
 * language model and streams the response into the chat. Falls back to the
 * static analysis card if no LM is available.
 */
async function forwardToCopilot(
  context: vscode.ExtensionContext,
  workspaceId: string,
  rawPrompt: string,
  enrichedPrompt: string,
  state: PromptProxyPanelState,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<void> {
  const history = getConversation(context, workspaceId);
  let lmSucceeded = false;
  try {
    const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    if (models.length > 0 && !token.isCancellationRequested) {
      const messages = buildLMMessages(history, enrichedPrompt, state);
      const lmResponse = await models[0].sendRequest(messages, {}, token);

      let fullResponse = '';
      for await (const chunk of lmResponse.text) {
        stream.markdown(chunk);
        fullResponse += chunk;
      }
      fullResponse = fullResponse.trim();

      if (fullResponse) {
        await addConversationTurn(context, workspaceId, {
          user_raw: rawPrompt,
          user_optimized: enrichedPrompt,
          assistant: fullResponse,
        });
        lmSucceeded = true;

        const lastLines = fullResponse.split('\n').slice(-4).join(' ');
        if (/\?\s*$/.test(lastLines)) {
          stream.button({ command: 'prompt-proxy.startChat', title: 'Reply \u21B5' });
        }
      }
    }
  } catch {
    /* LM not available or cancelled — fall through to buttons */
  }

  if (!lmSucceeded) {
    stream.markdown(renderChatAnalysisMarkdown(state, 'optimize'));
    addContextReferences(stream, state.analysis.context);
    stream.button({
      command: 'prompt-proxy.copyPrompt',
      title: 'Copy optimized prompt',
      arguments: [state.optimized],
    });
    stream.button({
      command: 'prompt-proxy.sendPromptToChat',
      title: 'Open optimized prompt in chat',
      arguments: [state.optimized],
    });
  }
}

// Re-introduce the trailing helpers below; the original `}` of
// handleChatRequest already closed in the early-return path above.
function _unused() { /* keeps formatting tools from collapsing the file */ }
void _unused;

/** Re-export for activation helper that builds chat followups. */
export function getConversationForWorkspace(
  context: vscode.ExtensionContext,
  workspaceId: string,
): ConversationTurn[] {
  return getConversation(context, workspaceId);
}

/**
 * Exposed for any caller that needs to enumerate raw conversation entries
 * (e.g. the legacy clear-memory command).  Re-exports avoid duplicate logic.
 */
export const CONVERSATION_STORE_KEY = CONVERSATION_KEY;

/** Helper to satisfy "openChatWithPrompt" callers from this barrel. */
export { openChatWithPrompt };
