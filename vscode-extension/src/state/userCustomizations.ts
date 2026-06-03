import * as vscode from 'vscode';

/**
 * Single source of truth for everything a user can customize in Prompt
 * Optimizer.  Two guarantees hang off this list:
 *
 *   1. **Preserve on update** — a marketplace update only replaces files that
 *      ship *inside* the extension package (`extensionPath`).  None of the
 *      surfaces below live there: settings are VS Code user/workspace config,
 *      custom agents + memory live in the workspace, and the cache/global
 *      state live in global storage.  The extension never rewrites any of
 *      them on activation, so user changes always survive an upgrade.
 *
 *   2. **Reset to defaults** — `prompt-proxy.resetToDefaults` is the *only*
 *      path that clears these surfaces, and only the ones the user explicitly
 *      ticks.  It is never invoked automatically.
 */

/** Every contributed `promptProxy.*` configuration key. */
export const PROMPT_PROXY_SETTING_KEYS: readonly string[] = [
  'support.email',
  'targetModel',
  'dbPath',
  'processingMode',
  'enableSessionContext',
  'pricingInput',
  'pricingOutput',
  'subscriptionPlan',
  'forecastRequestsPerDay',
  'creditOveragePrice',
  'enableSecretDetection',
  'confirmBeforeSend',
  'tokenBudget.augmentedBytes',
  'tokenBudget.managedBytes',
  'tokenBudget.perFileBytes',
  'tokenBudget.totalBytes',
  'suppressWelcome',
  'versions.author',
  'onboarding.autoOpen',
  'optimize.autoOpenChat',
  'optimize.sourcePicker',
  'collectTrainingData',
  'secretPatterns',
];

/**
 * Reset every contributed setting back to its package.json default by
 * clearing the user's Global and Workspace overrides.  VS Code then falls
 * back to the declared default automatically.
 */
export async function resetSettingsToDefault(): Promise<void> {
  const config = vscode.workspace.getConfiguration('promptProxy');
  for (const key of PROMPT_PROXY_SETTING_KEYS) {
    // Clear both scopes; undefined removes the override entirely.
    await config.update(key, undefined, vscode.ConfigurationTarget.Global);
    try {
      await config.update(key, undefined, vscode.ConfigurationTarget.Workspace);
    } catch {
      // Workspace scope is unavailable when no folder is open — ignore.
    }
  }
}
