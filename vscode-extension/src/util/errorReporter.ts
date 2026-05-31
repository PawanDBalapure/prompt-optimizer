import * as vscode from 'vscode';
import * as os from 'os';

/**
 * Centralised error reporting helper.
 *
 * Every error surfaced through this helper is shown via
 * `window.showErrorMessage` together with a small set of recovery
 * actions that include "📧 Email author" — composing a pre-filled
 * mailto: link with extension/VS Code/OS metadata and the captured
 * stack trace so users can report problems without copy-pasting
 * environment details by hand.
 *
 * Design notes:
 * - The author's contact is sourced (in priority order) from:
 *     1. VS Code setting `promptProxy.support.email`
 *     2. `package.json` → `bugs.email`
 *     3. The hard-coded fallback below.
 * - If the email is empty the action is hidden and only the
 *   GitHub issues fallback is offered.
 * - This helper never throws — error reporting must not error.
 */

const FALLBACK_EMAIL = 'pawandbalapure@gmail.com';
const ISSUES_URL = 'https://github.com/PawanDBalapure/prompt-optimizer/issues/new';

interface ReporterContext {
  /** Human-readable scope, e.g. "Optimize prompt" or "Webview message". */
  scope?: string;
  /** Extra structured data appended to the email body. */
  details?: Record<string, unknown>;
  /** Suppress the toast (returns immediately) — useful for silent paths. */
  silent?: boolean;
}

let extensionContext: vscode.ExtensionContext | undefined;
let extensionVersion = 'unknown';
let bugsEmail: string | undefined;

/**
 * Wire the reporter into the extension lifecycle.  Must be called once
 * from `activate`.  Installs `process.on('unhandledRejection')` and
 * `uncaughtException` listeners so background failures still reach the
 * user with a one-click email button.
 */
export function initErrorReporter(context: vscode.ExtensionContext): void {
  extensionContext = context;
  try {
    const pkg = context.extension?.packageJSON ?? {};
    extensionVersion = String(pkg.version ?? 'unknown');
    const bugs = pkg.bugs;
    if (bugs && typeof bugs === 'object' && typeof bugs.email === 'string') {
      bugsEmail = bugs.email;
    }
  } catch {
    /* ignore — reporter must not throw */
  }

  const onUnhandled = (reason: unknown) => {
    void reportError('An unexpected background error occurred in Prompt Optimizer.', reason, {
      scope: 'unhandledRejection',
    });
  };
  const onUncaught = (err: Error) => {
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

function getSupportEmail(): string {
  try {
    const cfg = vscode.workspace.getConfiguration('promptProxy');
    const configured = cfg.get<string>('support.email');
    if (configured && configured.trim()) {
      return configured.trim();
    }
  } catch {
    /* ignore */
  }
  return (bugsEmail && bugsEmail.trim()) || FALLBACK_EMAIL;
}

function buildBody(scope: string | undefined, error: unknown, details?: Record<string, unknown>): string {
  const errMsg = error instanceof Error ? error.message : (error == null ? '' : String(error));
  const stack = error instanceof Error && error.stack ? error.stack : '';
  const lines: string[] = [];
  lines.push('Hi,');
  lines.push('');
  lines.push('I hit the error below while using Prompt Optimizer. Steps to reproduce:');
  lines.push('1. ');
  lines.push('2. ');
  lines.push('');
  lines.push('--- diagnostics (auto-filled — please keep) ---');
  lines.push(`Extension : Prompt Optimizer v${extensionVersion}`);
  lines.push(`VS Code   : ${vscode.version}`);
  lines.push(`OS        : ${os.platform()} ${os.release()} (${os.arch()})`);
  lines.push(`Node      : ${process.version}`);
  if (scope) {
    lines.push(`Scope     : ${scope}`);
  }
  if (details) {
    for (const [key, value] of Object.entries(details)) {
      try {
        lines.push(`${key.padEnd(10, ' ')}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
      } catch {
        /* skip un-serialisable */
      }
    }
  }
  if (errMsg) {
    lines.push('');
    lines.push('Error:');
    lines.push(errMsg);
  }
  if (stack) {
    lines.push('');
    lines.push('Stack:');
    lines.push(stack);
  }
  return lines.join('\n');
}

/**
 * Windows ShellExecute / `start mailto:` rejects URIs longer than ~2048
 * characters with ENOENT ("system cannot find the specified file").  We
 * cap the encoded body well below that threshold and append a marker
 * telling the user the rest is on the clipboard.
 */
const MAX_MAILTO_BODY_CHARS = 1500;

function buildMailto(title: string, body: string): { uri: vscode.Uri; truncated: boolean } {
  const email = getSupportEmail();
  const subject = `[Prompt Optimizer v${extensionVersion}] ${title}`;
  let safeBody = body;
  let truncated = false;
  if (safeBody.length > MAX_MAILTO_BODY_CHARS) {
    safeBody = safeBody.slice(0, MAX_MAILTO_BODY_CHARS)
      + '\n\n[…truncated — full diagnostics are on your clipboard]';
    truncated = true;
  }
  const params = new URLSearchParams({ subject, body: safeBody });
  // mailto needs RFC2368-style encoding; URLSearchParams uses '+' for spaces
  // which most mail clients accept, but we normalise to %20 for safety.
  const qs = params.toString().replace(/\+/g, '%20');
  return { uri: vscode.Uri.parse(`mailto:${email}?${qs}`), truncated };
}

/**
 * Try to open the user's default mail client with diagnostics, and degrade
 * gracefully if Windows / the OS has no `mailto:` handler registered.
 *
 * Failure path:
 *   1. Copy the full diagnostic body to the clipboard.
 *   2. Show a follow-up dialog offering "Open GitHub issue" + "Copy email
 *      address" so the user can still report the problem.
 *
 * This avoids the bare ENOENT ("system cannot find the specified file")
 * error users see when no default mail client is registered.
 */
async function tryOpenMailto(title: string, body: string): Promise<void> {
  const email = getSupportEmail();
  const { uri, truncated } = buildMailto(title, body);

  // Always stage the full body on the clipboard first — that way the user
  // never loses information even if openExternal fails.
  try { await vscode.env.clipboard.writeText(body); } catch { /* ignore */ }

  let opened = false;
  try {
    opened = await vscode.env.openExternal(uri);
  } catch {
    opened = false;
  }
  if (opened) {
    if (truncated) {
      vscode.window.setStatusBarMessage(
        'Prompt Optimizer: full diagnostics copied to clipboard (paste into the email).',
        6000,
      );
    }
    return;
  }

  const OPEN_GITHUB = '🐞 Open GitHub issue';
  const COPY_EMAIL = '📋 Copy email address';
  const choice = await vscode.window.showWarningMessage(
    'No default mail client is configured on this system. The full diagnostic '
    + 'message has been copied to your clipboard — paste it into a GitHub '
    + 'issue or send it to ' + email + '.',
    OPEN_GITHUB, COPY_EMAIL,
  );
  if (choice === OPEN_GITHUB) {
    await vscode.env.openExternal(vscode.Uri.parse(ISSUES_URL));
  } else if (choice === COPY_EMAIL) {
    await vscode.env.clipboard.writeText(email);
    vscode.window.setStatusBarMessage('Prompt Optimizer: support email copied to clipboard.', 4000);
  }
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
      // Still log to the extension's output channel via console for debugging.
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

/**
 * Open the email composer manually (used by the "Report an issue"
 * command + panel chip).  No actual error required — body will list
 * environment metadata only.
 */
export async function openSupportEmail(reason = 'Feedback / question'): Promise<void> {
  void extensionContext;
  const body = buildBody(reason, undefined);
  await tryOpenMailto(reason, body);
}
