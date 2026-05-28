import * as path from 'path';
import * as vscode from 'vscode';

import { TARGET_MODEL_KEY } from '../constants';
import type { TargetModel } from '../types';

function getConfig(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('promptProxy');
}

export function getDbPath(context: vscode.ExtensionContext): string {
  const configuredPath = getConfig().get<string>('dbPath');
  if (configuredPath && configuredPath.trim() !== '') {
    return path.resolve(configuredPath);
  }
  return path.resolve(context.globalStorageUri.fsPath, 'prompt_semantic_cache.db');
}

export function getPricingConfig(): {
  input_cost_per_1k_tokens: number;
  output_cost_per_1k_tokens: number;
} {
  const config = getConfig();
  return {
    input_cost_per_1k_tokens: config.get<number>('pricingInput') ?? 0.0015,
    output_cost_per_1k_tokens: config.get<number>('pricingOutput') ?? 0.002,
  };
}

export function getProcessingMode(): string {
  return getConfig().get<string>('processingMode') ?? 'blocking';
}

function isTargetModel(value: unknown): value is TargetModel {
  return value === 'claude' || value === 'gpt' || value === 'gemini' || value === 'local';
}

export function getTargetModel(context: vscode.ExtensionContext): TargetModel {
  const stored = context.globalState.get<string>(TARGET_MODEL_KEY);
  if (isTargetModel(stored)) { return stored; }

  const fallback = getConfig().get<string>('targetModel') ?? 'gpt';
  if (isTargetModel(fallback)) { return fallback; }
  return 'gpt';
}

export async function setTargetModel(
  context: vscode.ExtensionContext,
  val: string,
): Promise<void> {
  if (isTargetModel(val)) {
    await context.globalState.update(TARGET_MODEL_KEY, val);
  }
}

export function isSessionContextEnabled(): boolean {
  return getConfig().get<boolean>('enableSessionContext') === true;
}
