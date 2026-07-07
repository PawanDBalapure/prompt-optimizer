import * as os from 'node:os';
import * as vscode from 'vscode';

/**
 * Support-email machinery for the error reporter: builds the diagnostic
 * body, encodes a safe mailto: URI, and degrades gracefully when no mail
 * client is registered. Never throws.
 */

const FALLBACK_EMAIL = 'pawandbalapure@gmail.com';
export const ISSUES_URL = 'https://github.com/PawanDBalapure/prompt-optimizer/issues/new';

let extensionVersion = 'unknown';
let bugsEmail: string | undefined;

/** Called once from initErrorReporter with package.json metadata. */
export function setSupportMetadata(version: string, email?: string): void {
  extensionVersion = version;
  bugsEmail = email;
}

function getSupportEmail(): string {
  try {
    const configured = vscode.workspace.getConfiguration('promptProxy').get<string>('support.email');
    if (configured && configured.trim()) { return configured.trim(); }
  } catch { /* ignore */ }
  return (bugsEmail && bugsEmail.trim()) || FALLBACK_EMAIL;
}

export function buildBody(
  scope: string | undefined,
  error: unknown,
  details?: Record<string, unknown>,
): string {
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
  if (scope) { lines.push(`Scope     : ${scope}`); }
  if (details) {
    for (const [key, value] of Object.entries(details)) {
      try {
        lines.push(`${key.padEnd(10, ' ')}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
      } catch { /* skip un-serialisable */ }
    }
  }
  if (errMsg) {
    lines.push('', 'Error:', errMsg);
  }
  if (stack) {
    lines.push('', 'Stack:', stack);
  }
  return lines.join('\n');
}

/**
 * Windows ShellExecute / `start mailto:` rejects URIs longer than ~2048
 * characters with ENOENT.  We cap the encoded body well below that threshold
 * and append a marker telling the user the rest is on the clipboard.
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
 * Try to open the user's default mail client with diagnostics, degrading
 * to clipboard + GitHub issue when no `mailto:` handler is registered.
 */
export async function tryOpenMailto(title: string, body: string): Promise<void> {
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
 * Open the email composer manually (used by the "Report an issue"
 * command + panel chip).  No actual error required — body will list
 * environment metadata only.
 */
export async function openSupportEmail(reason = 'Feedback / question'): Promise<void> {
  await tryOpenMailto(reason, buildBody(reason, undefined));
}
