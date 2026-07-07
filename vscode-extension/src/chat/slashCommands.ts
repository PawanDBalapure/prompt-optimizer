import * as vscode from 'vscode';

import {
  clearConversationForWorkspace,
  getConversation,
} from '../state/conversation';
import { getCurrentMode, setCurrentMode, updateStatusBarItem } from '../state/mode';
import { clearPendingOptimization, getPendingOptimization } from '../state/pending';
import type { ProxyMode } from '../types';
import { buildRuntimeSnapshot } from './analyzer';
import { forwardToCopilot } from './forward';
import { renderContextReportMarkdown } from './rendering';

export interface SlashCommandSinks {
  notifyModeChange: (mode: ProxyMode) => void;
}

function isProxyMode(value: string): value is ProxyMode {
  return value === 'agent' || value === 'optimize' || value === 'direct';
}

/**
 * Handle the metadata-style slash commands (/context /memory /clear /mode
 * /cancel /send). Returns null when the request is not one of them so the
 * caller runs the main optimize flow.
 */
export async function handleSlashCommand(
  context: vscode.ExtensionContext,
  sinks: SlashCommandSinks,
  statusBarItem: vscode.StatusBarItem,
  request: vscode.ChatRequest,
  chatContext: vscode.ChatContext,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
  workspaceId: string,
): Promise<vscode.ChatResult | null> {
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
        const source = turn.source === 'copilot-history' ? 'copilot-import' : '@promptoptimizer';
        stream.markdown(`**Turn ${i + 1}** *(${ago < 2 ? 'just now' : `${ago} min ago`})* · \`${source}\`\n\n`);
        stream.markdown(`> You: ${turn.user_raw.slice(0, 200)}\n\n`);
        const assistantPreview = turn.assistant.trim().length > 0
          ? `${turn.assistant.slice(0, 300)}${turn.assistant.length > 300 ? '\u2026' : ''}`
          : '(assistant reply not available for imported Copilot history)';
        stream.markdown(`> Assistant: ${assistantPreview}\n\n---\n\n`);
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
      context, workspaceId, pending.rawPrompt, pending.enriched, pending.state, stream, token,
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

  return null;
}
