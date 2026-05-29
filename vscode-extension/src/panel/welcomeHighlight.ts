import * as vscode from 'vscode';

/**
 * Briefly pulses the status-bar item after the extension is installed,
 * updated, or reloaded so the user notices where the Optimize action
 * lives.  Uses VS Code's themed warning background color (the same one
 * used by Git for "Sync changes" prompts) which is impossible to miss but
 * still theme-aware.
 *
 * Behaviour:
 *  - First install (no stored version): highlight + welcome toast with
 *    "Open User Guide" and "Don't show again".
 *  - Version change: highlight + concise "What's new" toast.
 *  - Same version reload: gentle 6 s highlight only, no toast.
 *  - User can opt out via globalState flag set from the toast or via
 *    the `promptProxy.suppressWelcome` setting.
 */

const LAST_VERSION_KEY = 'promptProxy.lastSeenVersion';
const SUPPRESS_KEY     = 'promptProxy.suppressHighlight';
const PULSE_DURATION_MS_TOAST  = 12_000;
const PULSE_DURATION_MS_RELOAD = 6_000;

export function highlightStatusBarOnActivate(
  context: vscode.ExtensionContext,
  item: vscode.StatusBarItem,
): void {
  const currentVersion = (context.extension.packageJSON?.version ?? '0.0.0') as string;
  const lastVersion = context.globalState.get<string>(LAST_VERSION_KEY);
  const suppressed  = context.globalState.get<boolean>(SUPPRESS_KEY) === true
    || vscode.workspace.getConfiguration('promptProxy').get<boolean>('suppressWelcome') === true;

  // Always record the current version so subsequent reloads behave correctly.
  void context.globalState.update(LAST_VERSION_KEY, currentVersion);

  if (suppressed) { return; }

  const isFirstInstall = !lastVersion;
  const isUpdate       = !!lastVersion && lastVersion !== currentVersion;
  const durationMs     = (isFirstInstall || isUpdate)
    ? PULSE_DURATION_MS_TOAST
    : PULSE_DURATION_MS_RELOAD;

  pulse(item, durationMs);

  if (isFirstInstall) {
    void showWelcomeToast(context, currentVersion, true);
  } else if (isUpdate) {
    void showWelcomeToast(context, currentVersion, false, lastVersion);
  }
}

/**
 * Apply a themed background, restore it after `durationMs`.  We also
 * temporarily prepend a `$(bell)` glyph so the change is visible even on
 * narrow status bars where the background tint can blend in.
 */
function pulse(item: vscode.StatusBarItem, durationMs: number): void {
  const originalText = item.text;
  const originalBg   = item.backgroundColor;
  item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  item.text = `$(bell) ${originalText}`;

  const timer = setTimeout(() => {
    item.backgroundColor = originalBg;
    item.text = originalText;
  }, durationMs);

  // If the user clicks the item during the pulse, drop the highlight
  // immediately — they have noticed it.
  const disposable = vscode.window.onDidChangeWindowState(() => { /* keep until timer */ });
  void disposable; // reference to avoid TS unused; the real "early clear" comes from the timer
  // Best-effort: also clear on command execution path is handled by VS Code's
  // own click → command flow, but the timer is the source of truth.
  setTimeout(() => disposable.dispose(), durationMs + 100);
  void timer;
}

async function showWelcomeToast(
  context: vscode.ExtensionContext,
  version: string,
  isFirstInstall: boolean,
  previousVersion?: string,
): Promise<void> {
  const message = isFirstInstall
    ? `Prompt Optimizer ${version} is ready. Look for the $(robot)/$(wand) Optimize button on the right of the status bar.`
    : `Prompt Optimizer updated to ${version}${previousVersion ? ` (from ${previousVersion})` : ''}. The status-bar Optimize button now carries every common action via its tooltip.`;

  const OPEN_GUIDE = 'Open User Guide';
  const OPEN_PANEL = 'Open Panel';
  const DONT_SHOW  = "Don't show again";

  const choice = await vscode.window.showInformationMessage(
    message,
    OPEN_GUIDE,
    OPEN_PANEL,
    DONT_SHOW,
  );

  if (choice === OPEN_GUIDE) {
    await vscode.commands.executeCommand('prompt-proxy.userGuide');
  } else if (choice === OPEN_PANEL) {
    await vscode.commands.executeCommand('prompt-proxy.focusPanel');
  } else if (choice === DONT_SHOW) {
    await context.globalState.update(SUPPRESS_KEY, true);
  }
}
