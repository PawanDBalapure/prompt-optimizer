import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { TARGET_MODEL_KEY } from '../constants';
import type { TargetModel } from '../types';

function getConfig(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('promptProxy');
}

export function getDbPath(context: vscode.ExtensionContext): string {
  const configuredPath = getConfig().get<string>('dbPath');
  const resolved = configuredPath && configuredPath.trim() !== ''
    ? path.resolve(configuredPath)
    : path.resolve(context.globalStorageUri.fsPath, 'prompt_semantic_cache.db');
  // SQLite will not create parent directories; guarantee the folder exists
  // on every machine before we hand the path to the engine sidecar.
  try { fs.mkdirSync(path.dirname(resolved), { recursive: true }); } catch { /* surfaced later if open fails */ }
  return resolved;
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

const PLAN_ALLOWANCES: Record<string, { label: string; allowance: number }> = {
  'free': { label: 'Copilot Free', allowance: 50 },
  'pro': { label: 'Copilot Pro', allowance: 300 },
  'pro-plus': { label: 'Copilot Pro+', allowance: 1500 },
  'business': { label: 'Copilot Business', allowance: 300 },
  'enterprise': { label: 'Copilot Enterprise', allowance: 1000 },
};

export function getCreditForecastConfig(): {
  plan: string;
  planLabel: string;
  monthlyAllowance: number;
  requestsPerDay: number;
  overagePrice: number;
} {
  const config = getConfig();
  const planRaw = config.get<string>('subscriptionPlan') ?? 'pro';
  const plan = PLAN_ALLOWANCES[planRaw] ? planRaw : 'pro';
  const entry = PLAN_ALLOWANCES[plan];
  const requestsPerDay = Math.max(0, config.get<number>('forecastRequestsPerDay') ?? 20);
  const overagePrice = Math.max(0, config.get<number>('creditOveragePrice') ?? 0.04);
  return {
    plan,
    planLabel: entry.label,
    monthlyAllowance: entry.allowance,
    requestsPerDay,
    overagePrice,
  };
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
