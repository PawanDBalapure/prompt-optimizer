import * as vscode from 'vscode';

import { maybeAutoOpenContextFiles } from '../commands/openContextFiles';
import { getConversation, resolveReferences } from '../state/conversation';
import { setPendingOptimization } from '../state/pending';
import type { ProxyMode } from '../types';
import { formatCurrency } from '../util/format';
import { computeWorkspaceId } from '../util/workspace';
import { analyzePrompt } from './analyzer';
import { forwardToCopilot, renderConfirmationCard } from './forward';
import { ocrChatReferences } from './ocr';
import { handleSlashCommand } from './slashCommands';

export interface ChatHandlerSinks {
  publishAnalysis: (state: import('../types').PromptProxyPanelState) => void;
  notifyModeChange: (mode: ProxyMode) => void;
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

  const slashResult = await handleSlashCommand(
    context, sinks, statusBarItem, request, chatContext, stream, token, workspaceId,
  );
  if (slashResult) { return slashResult; }

  const prompt = request.prompt.trim();
  if (!prompt) {
    stream.markdown(
      'Enter a prompt or use `/context` to inspect your workspace context, `/memory` to review conversation history, or `/clear` to reset it.',
    );
    return { metadata: { command: request.command ?? 'optimize' } };
  }

  // Image attachments: extract text via local OCR (fully offline) and fold
  // it into the prompt before optimization. Skipped silently when there are
  // no image references or the OCR worker is unavailable.
  let promptWithOcr = prompt;
  try {
    if ((request.references?.length ?? 0) > 0) {
      stream.progress('Reading text from attached images\u2026');
      const ocrText = await ocrChatReferences(context, request);
      if (ocrText.length > 0) {
        promptWithOcr = `${prompt}\n\n${ocrText}`;
        stream.markdown(
          `> \uD83D\uDDBC\uFE0F *Extracted ${ocrText.length} characters from attached image(s) and added to the prompt context.*\n\n`,
        );
      }
    }
  } catch (err) {
    console.warn('[prompt-optimizer] OCR step failed (continuing without it):', err);
  }

  stream.progress('Checking the local semantic cache and packing workspace context\u2026');
  const state = await analyzePrompt(context, promptWithOcr, 'chat', chatContext);

  if (token.isCancellationRequested) {
    return { metadata: { command: request.command ?? 'optimize' } };
  }

  sinks.publishAnalysis(state);
  await maybeAutoOpenContextFiles(context, state);

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
  // and wait for the user to click Send / Edit / Cancel before forwarding.
  const confirmBeforeSend = vscode.workspace.getConfiguration('promptProxy')
    .get<boolean>('confirmBeforeSend') !== false;

  if (confirmBeforeSend && (request.command === undefined || request.command === 'optimize')) {
    const pending = setPendingOptimization(context, {
      workspaceId,
      rawPrompt: promptWithOcr,
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
    context, workspaceId, promptWithOcr, enrichedPrompt, state, stream, token,
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
