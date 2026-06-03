import * as vscode from 'vscode';

import type {
  PromptProxyAnalysis,
  PromptProxyPanelState,
  RuntimeSnapshot,
} from '../types';
import {
  formatCacheStatus,
  formatCurrency,
  toFileUri,
  trimForDisplay,
} from '../util/format';

export function renderChatAnalysisMarkdown(
  state: PromptProxyPanelState,
  command: string,
): string {
  const savingsPercent = state.metrics.raw_input_tokens > 0
    ? Math.round((state.metrics.tokens_saved / state.metrics.raw_input_tokens) * 100)
    : 0;
  const lines = [
    '### Prompt Optimizer report',
    '',
    `- Mode: **${command}**`,
    `- Cache: **${formatCacheStatus(state.analysis.cache.status, state.analysis.cache.confidence)}**`,
    `- Tokens: **${state.metrics.raw_input_tokens} -> ${state.metrics.optimized_input_tokens}** input, saved **${state.metrics.tokens_saved} (${savingsPercent}%)**`,
    `- Estimated output: **${state.metrics.estimated_output_tokens}** tokens`,
    `- Cost: **${formatCurrency(state.analysis.cost.total_cost_usd)}** total (${formatCurrency(state.analysis.cost.input_cost_usd)} input + ${formatCurrency(state.analysis.cost.output_cost_usd)} output)`,
    `- Context: **${state.analysis.context.selected_files.length}** file(s), **${state.analysis.context.selected_logs.length}** log source(s), **${state.analysis.context.open_file_count}** open editor(s)`,
  ];

  if (state.improvements.length > 0) {
    lines.push('', '#### Suggested prompt refinements');
    for (const improvement of state.improvements) {
      lines.push(`- ${improvement}`);
    }
  }

  if (state.analysis.cache.candidates.length > 0) {
    lines.push('', '#### Similar cached prompts');
    for (const candidate of state.analysis.cache.candidates.slice(0, 3)) {
      lines.push(`- ${Math.round(candidate.confidence * 100)}%: ${trimForDisplay(candidate.raw_prompt, 120)}`);
    }
  }

  const reusedSegments = state.analysis.cache.reused_segments ?? [];
  if (reusedSegments.length > 0) {
    const reusedSaved = state.analysis.cache.reused_tokens_saved ?? 0;
    lines.push(
      '',
      `#### Reused from cache (~${reusedSaved} tokens saved)`,
      '_These context blocks were already sent for this workspace and are referenced in the optimized prompt instead of resent._',
    );
    for (const segment of reusedSegments) {
      lines.push(`- ${segment.label} (~${segment.tokens_saved} tokens, ref: ${segment.ref})`);
    }
  }

  lines.push('', '#### Optimized prompt', '```text', state.optimized, '```');
  lines.push(
    '',
    "_Prompt Optimizer can use its own chat history, the local session buffer, editor context, and diagnostics. The public VS Code API does not expose Copilot's private transcript for other chat participants._",
  );

  return lines.join('\n');
}

export function renderContextReportMarkdown(snapshot: RuntimeSnapshot): string {
  const lines = [
    '### Prompt Optimizer context snapshot',
    '',
    `- Active file: **${snapshot.active_file ?? 'none'}**`,
    `- Open editor count: **${snapshot.open_file_count}**`,
    `- Chat history turns for @promptoptimizer: **${snapshot.chat_history_turns}**`,
    `- Context log sources: **${snapshot.log_sources.length > 0 ? snapshot.log_sources.join(', ') : 'none'}**`,
    `- Buffered session turns: **${snapshot.session_buffer.length}**`,
    '',
    '_Prompt Optimizer can read its own chat history, the local session buffer, open editors, active selection, and diagnostics. It cannot read the private transcript of other chat participants through the public VS Code API._',
  ];

  if (snapshot.session_buffer.length > 0) {
    lines.push('', '#### Buffered turns');
    for (const item of snapshot.session_buffer.slice(-3).reverse()) {
      lines.push(`- [${item.source}] ${trimForDisplay(item.prompt, 110)} (${item.cache_status}, ${formatCurrency(item.estimated_cost_usd)})`);
    }
  }

  if (snapshot.last_analysis) {
    lines.push('', '#### Last analysis');
    lines.push(`- Cache: **${formatCacheStatus(snapshot.last_analysis.analysis.cache.status, snapshot.last_analysis.analysis.cache.confidence)}**`);
    lines.push(`- Cost: **${formatCurrency(snapshot.last_analysis.analysis.cost.total_cost_usd)}**`);
    lines.push(`- Selected files: **${snapshot.last_analysis.analysis.context.selected_files.length}**`);
  }

  return lines.join('\n');
}

export function addContextReferences(
  stream: vscode.ChatResponseStream,
  context: PromptProxyAnalysis['context'],
): void {
  for (const filePath of context.selected_files.slice(0, 3)) {
    const uri = toFileUri(filePath, context.workspace_root);
    if (uri) { stream.reference(uri); }
  }
}
