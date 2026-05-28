import * as vscode from 'vscode';

import { MODE_KEY } from '../constants';
import type { ProxyMode } from '../types';

export function getCurrentMode(context: vscode.ExtensionContext): ProxyMode {
  return context.globalState.get<ProxyMode>(MODE_KEY) ?? 'agent';
}

export async function setCurrentMode(
  context: vscode.ExtensionContext,
  mode: ProxyMode,
): Promise<void> {
  await context.globalState.update(MODE_KEY, mode);
}

export function updateStatusBarItem(item: vscode.StatusBarItem, mode: ProxyMode): void {
  const labels: Record<ProxyMode, string> = {
    agent: '$(robot) Optimizer [Agent]',
    optimize: '$(wand) Optimizer [Optimize]',
    direct: '$(comment-discussion) Optimizer [Direct]',
  };
  item.text = labels[mode];
  item.tooltip = `Prompt Optimizer: ${mode} mode \u2014 click to change`;
  item.command = 'prompt-proxy.selectMode';
}
