import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

/**
 * Generates a cryptographically suitable nonce for the webview CSP.
 * Using crypto-strong random bytes (not Math.random) prevents predictable
 * nonces that could be abused if the webview ever loaded untrusted content.
 */
export function createNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = require('node:crypto').randomBytes(32) as Buffer;
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += chars.charAt(bytes[i] % chars.length);
  }
  return out;
}

/**
 * Loads a webview HTML template from disk and substitutes the standard
 * placeholders ({{NONCE}}, {{CSS_URI}}, {{JS_URI}}, {{CSP_SOURCE}}) plus
 * any caller-supplied extras.  Centralising this keeps CSP and asset
 * wiring consistent between every webview surface.
 */
export interface WebviewAssets {
  /** Base name (without extension). Looks up {name}.html, {name}.css, {name}.js in media/. */
  name: string;
  /** Extra named substitutions, applied as raw text replacement on {{KEY}}. */
  extras?: Record<string, string>;
}

export function renderWebviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  assets: WebviewAssets,
): string {
  const mediaDir = vscode.Uri.joinPath(extensionUri, 'media');
  const htmlDisk = path.join(mediaDir.fsPath, `${assets.name}.html`);
  const cssDisk = vscode.Uri.joinPath(mediaDir, `${assets.name}.css`);
  const jsDisk = vscode.Uri.joinPath(mediaDir, `${assets.name}.js`);

  // Auto-discover sibling stylesheets (`${name}.<suffix>.css`) so a single
  // panel can be split into multiple CSS modules without hardcoding their
  // URIs here.  The primary `${name}.css` is already linked separately.
  const primaryCss = `${assets.name}.css`;
  const siblingCssTags = fs
    .readdirSync(mediaDir.fsPath)
    .filter((file) =>
      file !== primaryCss
      && file.startsWith(`${assets.name}.`)
      && file.endsWith('.css'))
    .sort()
    .map((file) => {
      const uri = webview.asWebviewUri(vscode.Uri.joinPath(mediaDir, file)).toString();
      return `<link rel="stylesheet" href="${uri}">`;
    })
    .join('\n  ');

  // Generate a single nonce up-front so it can be baked into EXTRA_JS_SCRIPTS
  // tags directly (the {{NONCE}} substitution covers the rest of the HTML).
  const nonce = createNonce();

  // Auto-discover sibling scripts (`${name}.<suffix>.js`) loaded BEFORE the
  // primary script so helpers/render modules are available when the main
  // script wires up its event listeners.
  const primaryJs = `${assets.name}.js`;
  const siblingJsTags = fs
    .readdirSync(mediaDir.fsPath)
    .filter((file) =>
      file !== primaryJs
      && file.startsWith(`${assets.name}.`)
      && file.endsWith('.js'))
    .sort()
    .map((file) => {
      const uri = webview.asWebviewUri(vscode.Uri.joinPath(mediaDir, file)).toString();
      return `<script nonce="${nonce}" src="${uri}"></script>`;
    })
    .join('\n  ');

  let html = fs.readFileSync(htmlDisk, 'utf8');
  const substitutions: Record<string, string> = {
    NONCE: nonce,
    CSS_URI: webview.asWebviewUri(cssDisk).toString(),
    JS_URI: webview.asWebviewUri(jsDisk).toString(),
    CSP_SOURCE: webview.cspSource,
    EXTRA_CSS_LINKS: siblingCssTags,
    EXTRA_JS_SCRIPTS: siblingJsTags,
    ...(assets.extras ?? {}),
  };

  for (const [key, value] of Object.entries(substitutions)) {
    html = html.split(`{{${key}}}`).join(value);
  }
  return html;
}
