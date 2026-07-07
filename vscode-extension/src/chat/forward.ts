import * as vscode from 'vscode';

import {
  addConversationTurn,
  buildLMMessages,
  getConversation,
} from '../state/conversation';
import type { PromptProxyPanelState } from '../types';
import { addContextReferences, renderChatAnalysisMarkdown } from './rendering';

/**
 * Renders the optimized prompt with explicit Send / Edit / Cancel buttons.
 * The user must click one before the prompt is forwarded to Copilot.
 */
export function renderConfirmationCard(
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

  stream.button({ command: 'prompt-proxy.confirmAndSend', title: '\u2713 Send to Copilot', arguments: [pendingId] });
  stream.button({ command: 'prompt-proxy.editPendingPrompt', title: '\u270E Edit & send', arguments: [pendingId] });
  stream.button({ command: 'prompt-proxy.cancelPending', title: '\u2715 Cancel', arguments: [pendingId] });
  stream.button({ command: 'prompt-proxy.copyPrompt', title: 'Copy optimized prompt', arguments: [state.optimized] });
  stream.button({ command: 'prompt-proxy.focusPanel', title: 'Open control panel' });
}

/**
 * Sends the (already-optimized, already-enriched) prompt to the Copilot
 * language model and streams the response into the chat. Falls back to the
 * static analysis card if no LM is available.
 */
export async function forwardToCopilot(
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
