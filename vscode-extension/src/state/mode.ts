import * as vscode from 'vscode';

import { MODE_KEY } from '../constants';
import type { ProxyMode } from '../types';

export function getCurrentMode(context: vscode.ExtensionContext): ProxyMode {
  return context.globalState.get<ProxyMode>(MODE_KEY) ?? 'optimize';
}

export async function setCurrentMode(
  context: vscode.ExtensionContext,
  mode: ProxyMode,
): Promise<void> {
  await context.globalState.update(MODE_KEY, mode);
}

/** Mode-aware leading icon so the single status-bar item still shows the active mode at a glance. */
const MODE_ICONS: Record<ProxyMode, string> = {
  agent: '$(robot)',
  optimize: '$(wand)',
  direct: '$(comment-discussion)',
};

const MODE_NAMES: Record<ProxyMode, string> = {
  agent: 'Agent',
  optimize: 'Optimize only',
  direct: 'Direct (chat)',
};

const MODE_HELP: Record<ProxyMode, string> = {
  agent: 'Optimizes your prompt locally, then opens Copilot Chat with the optimized prompt and sends it directly to the Copilot agent.',
  optimize: 'Optimizes the prompt and shows analysis (cost, savings, refinements) without calling Copilot.',
  direct: 'Pre-fills the `@promptoptimizer` chat participant with the prompt — you press Enter to send.',
};

export function updateStatusBarItem(item: vscode.StatusBarItem, mode: ProxyMode): void {
  // Single minimalist item: mode icon + primary action label.
  item.text = `${MODE_ICONS[mode]} Optimize`;
  item.name = 'Prompt Optimizer';
  item.command = 'prompt-proxy.optimizeChatPrompt';

  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = true;
  md.supportThemeIcons = true;
  md.appendMarkdown(`**Prompt Optimizer** — ${MODE_ICONS[mode]} \`${MODE_NAMES[mode]}\` mode\n\n`);
  md.appendMarkdown(`${MODE_HELP[mode]}\n\n`);
  md.appendMarkdown(`**Click** to optimize the current selection / clipboard — keybinding \`Ctrl+Alt+O\`.\n\n`);
  md.appendMarkdown(`---\n\n`);
  md.appendMarkdown(
    `[$(arrow-swap) Switch mode](command:prompt-proxy.selectMode) · ` +
    `[$(window) Open panel](command:prompt-proxy.focusPanel) · ` +
    `[$(comment-discussion) Open chat](command:prompt-proxy.startChat) · ` +
    `[$(book) User guide](command:prompt-proxy.userGuide)`,
  );
  item.tooltip = md;
}
