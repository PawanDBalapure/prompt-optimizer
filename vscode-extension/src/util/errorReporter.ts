import * as vscode from 'vscode';

import { buildBody, ISSUES_URL, setSupportMetadata, tryOpenMailto } from './supportMail';

export { openSupportEmail } from './supportMail';

/**
 * Centralised error reporting.  Every error surfaced through this helper is
 * shown via `window.showErrorMessage` with recovery actions including
 * "📧 Email author" — a pre-filled mailto: link with extension/VS Code/OS
 * metadata so users can report problems in one click.  Never throws.
 */

interface ReporterContext {
  /** Human-readable scope, e.g. "Optimize prompt" or "Webview message". */
  scope?: string;
  /** Extra structured data appended to the email body. */
  details?: Record<string, unknown>;
  /** Suppress the toast (returns immediately) — useful for silent paths. */
  silent?: boolean;
}

/**
 * Checks if an error is a benign cancellation or originated from another
 * extension.  All VS Code extensions share one process, so we must not show
 * error toasts for unhandled rejections thrown by GitLens or others.
 */
function isForeignOrCancellationError(error: unknown): boolean {
  if (!error) { return false; }

  const name = error instanceof Error ? error.name : (error as { name?: string }).name;
  const message = error instanceof Error ? error.message : (error as { message?: string }).message;
  if (name === 'CancellationError' || name === 'Canceled' || message === 'Canceled' || message === 'Operation cancelled') {
    return true;
  }

  // Inspect the stack: if it clearly comes from another extension, ignore it.
  const stack = error instanceof Error ? error.stack : (error as { stack?: string }).stack;
  if (typeof stack === 'string') {
    if (stack.includes('.vscode') || stack.includes('extensions/')) {
      if (!stack.includes('prompt-optimizer') && !stack.includes('promptProxy')) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Wire the reporter into the extension lifecycle.  Must be called once from
 * `activate`.  Installs `unhandledRejection` / `uncaughtException` listeners
 * so background failures still reach the user with a one-click email button.
 */
export function initErrorReporter(context: vscode.ExtensionContext): void {
  try {
    const pkg = context.extension?.packageJSON ?? {};
    const bugs = pkg.bugs;
    setSupportMetadata(
      String(pkg.version ?? 'unknown'),
      bugs && typeof bugs === 'object' && typeof bugs.email === 'string' ? bugs.email : undefined,
    );
  } catch {
    /* ignore — reporter must not throw */
  }

  const onUnhandled = (reason: unknown) => {
    if (isForeignOrCancellationError(reason)) { return; }
    void reportError('An unexpected background error occurred in Prompt Optimizer.', reason, {
      scope: 'unhandledRejection',
    });
  };
  const onUncaught = (err: Error) => {
    if (isForeignOrCancellationError(err)) { return; }
    void reportError('Prompt Optimizer encountered an uncaught exception.', err, {
      scope: 'uncaughtException',
    });
  };
  process.on('unhandledRejection', onUnhandled);
  process.on('uncaughtException', onUncaught);
  context.subscriptions.push({
    dispose: () => {
      process.removeListener('unhandledRejection', onUnhandled);
      process.removeListener('uncaughtException', onUncaught);
    },
  });
}

/**
 * Show an error to the user with one-click recovery actions:
 *   - 📧 Email author  → opens the default mail client with diagnostics.
 *   - 🐞 Report on GitHub → opens the issues page in the browser.
 *   - 📋 Copy details → copies the full diagnostic block to clipboard.
 *
 * Always safe to call — never throws.
 */
export async function reportError(
  title: string,
  error?: unknown,
  ctx?: ReporterContext,
): Promise<void> {
  try {
    const message = error instanceof Error ? error.message : (error == null ? '' : String(error));
    const summary = message ? `${title}\n\n${message}` : title;
    const body = buildBody(ctx?.scope, error, ctx?.details);

    if (ctx?.silent) {
      // Still log for debugging.
      console.error('[prompt-optimizer]', title, error);
      return;
    }

    const EMAIL = '📧 Email author';
    const GITHUB = '🐞 Report on GitHub';
    const COPY = '📋 Copy details';
    const choice = await vscode.window.showErrorMessage(summary, EMAIL, GITHUB, COPY);
    if (choice === EMAIL) {
      await tryOpenMailto(title, body);
    } else if (choice === GITHUB) {
      await vscode.env.openExternal(vscode.Uri.parse(ISSUES_URL));
    } else if (choice === COPY) {
      await vscode.env.clipboard.writeText(body);
      vscode.window.setStatusBarMessage('Prompt Optimizer: error details copied to clipboard.', 4000);
    }
  } catch (innerErr) {
    // Reporter must never throw; fall back to a plain console log.
    console.error('[prompt-optimizer] reportError failed', innerErr);
  }
}
