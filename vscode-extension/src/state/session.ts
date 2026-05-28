import * as path from 'path';
import * as vscode from 'vscode';

import {
  LAST_ANALYSIS_KEY,
  MAX_PASSIVE_EVENTS,
  MAX_SESSION_ITEMS,
  PASSIVE_EVENTS_KEY,
  SESSION_BUFFER_KEY,
} from '../constants';
import type { PromptProxyPanelState, SessionBufferedPrompt } from '../types';
import { isSessionContextEnabled } from './config';

export function getSessionBuffer(context: vscode.ExtensionContext): SessionBufferedPrompt[] {
  return context.globalState.get<SessionBufferedPrompt[]>(SESSION_BUFFER_KEY) ?? [];
}

export function getLastAnalysis(
  context: vscode.ExtensionContext,
): PromptProxyPanelState | undefined {
  return context.globalState.get<PromptProxyPanelState>(LAST_ANALYSIS_KEY);
}

export async function addToSessionBuffer(
  context: vscode.ExtensionContext,
  state: PromptProxyPanelState,
): Promise<void> {
  if (!isSessionContextEnabled()) {
    // Even when buffering is disabled, expose the latest analysis to the
    // panel so the UI keeps working.
    await context.globalState.update(LAST_ANALYSIS_KEY, state);
    return;
  }

  const history = getSessionBuffer(context);
  history.push({
    prompt: state.original,
    optimized_prompt: state.optimized,
    timestamp: state.generated_at,
    source: state.source,
    estimated_cost_usd: state.metrics.estimated_cost_usd,
    tokens_saved: state.metrics.tokens_saved,
    cache_status: state.analysis.cache.status,
  });

  while (history.length > MAX_SESSION_ITEMS) {
    history.shift();
  }

  await Promise.all([
    context.globalState.update(SESSION_BUFFER_KEY, history),
    context.globalState.update(LAST_ANALYSIS_KEY, state),
  ]);
}

export function addPassiveEvent(
  context: vscode.ExtensionContext,
  eventType: string,
  detail: string,
): void {
  const events = context.globalState
    .get<Array<{ type: string; detail: string; ts: number }>>(PASSIVE_EVENTS_KEY) ?? [];
  events.push({ type: eventType, detail: path.basename(detail), ts: Date.now() });
  while (events.length > MAX_PASSIVE_EVENTS) { events.shift(); }
  // Fire-and-forget — global state will persist on next event loop tick.
  void context.globalState.update(PASSIVE_EVENTS_KEY, events);
}
