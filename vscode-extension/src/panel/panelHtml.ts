import * as vscode from 'vscode';

import { renderSecretPatternHelpTooltip } from '../security/secret-help';
import {
  SECRET_PATTERN_MODE_LABELS,
  SECRET_PATTERN_MODE_PLACEHOLDERS,
  SECRET_PATTERN_MODE_VALUES,
} from '../security/secret-modes';
import { renderWebviewHtml } from '../webview/loader';

/** Render the main panel webview HTML with secret-pattern extras + logo URI. */
export function buildPanelHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const secretPatternModeOptions = SECRET_PATTERN_MODE_VALUES
    .map((mode) => `<option value="${mode}">${SECRET_PATTERN_MODE_LABELS[mode]}</option>`)
    .join('');
  const logoUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'images', 'icon.png'),
  ).toString();
  return renderWebviewHtml(webview, extensionUri, {
    name: 'panel',
    extras: {
      SECRET_PATTERN_HELP_TOOLTIP: renderSecretPatternHelpTooltip(),
      SECRET_PATTERN_MODE_OPTIONS: secretPatternModeOptions,
      SECRET_PATTERN_MODE_LABELS_JSON: JSON.stringify(SECRET_PATTERN_MODE_LABELS),
      SECRET_PATTERN_MODE_PLACEHOLDERS_JSON: JSON.stringify(SECRET_PATTERN_MODE_PLACEHOLDERS),
      LOGO_URI: logoUri,
    },
  });
}
