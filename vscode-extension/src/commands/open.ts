import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { PROMPT_PROXY_VIEW_TYPE } from '../panel/view-type';
import { collectMemorySnapshot } from './memorySnapshot';

export { collectMemorySnapshot } from './memorySnapshot';

export async function openPromptProxyPanel(): Promise<void> {
  await vscode.commands.executeCommand(`${PROMPT_PROXY_VIEW_TYPE}.focus`);
}

/**
 * Opens the Copilot Chat view and prefills the input box.
 *
 * Pass `autoSend: true` only when the caller has explicit user intent to
 * submit (e.g. an "Ask Copilot now" action).  The default is `false` so
 * optimize-style flows merely populate the prompt and leave the actual
 * submission to the user pressing Enter / the chat send button.
 */
export async function openChatWithPrompt(
  prompt: string,
  mentionParticipant: boolean,
  autoSend = false,
): Promise<void> {
  const prefix = mentionParticipant ? '@promptoptimizer ' : '';
  const text = `${prefix}${prompt}`.trim();
  await vscode.commands.executeCommand('workbench.action.chat.open', {
    query: text,
    // `isPartialQuery: true` keeps the text in the input box without
    // submitting it; omitting it (or sending false) triggers an immediate
    // send the moment the chat view opens.
    isPartialQuery: !autoSend,
  });
}

export async function openExtensionReadme(
  context: vscode.ExtensionContext,
): Promise<void> {
  const readmePath = path.resolve(context.extensionPath, 'README.md');
  if (!fs.existsSync(readmePath)) {
    vscode.window.showWarningMessage(
      'Prompt Optimizer README.md was not found in the extension package.',
    );
    return;
  }

  // Open the README in Markdown preview mode by default — much friendlier
  // than raw markdown source.  Fall back to the text editor if the
  // built-in markdown extension is somehow unavailable.
  const uri = vscode.Uri.file(readmePath);
  try {
    await vscode.commands.executeCommand('markdown.showPreview', uri);
  } catch {
    const document = await vscode.workspace.openTextDocument(readmePath);
    await vscode.window.showTextDocument(document, { preview: false });
  }
}

/**
 * Opens the interactive HTML onboarding guide in a webview panel.
 *
 * The static asset lives at `media/onboarding.html`.  It contains its own
 * CSS animations and an inline `<script>` block — both of which are stripped
 * by the Marketplace / GitHub Markdown renderer, so we render it ourselves
 * inside a webview where scripts are allowed.
 */
let onboardingPanel: vscode.WebviewPanel | undefined;
export async function openOnboardingGuide(
  context: vscode.ExtensionContext,
): Promise<void> {
  if (onboardingPanel) {
    onboardingPanel.reveal(vscode.ViewColumn.Active);
    return;
  }

  const htmlPath = path.resolve(context.extensionPath, 'media', 'onboarding.html');
  if (!fs.existsSync(htmlPath)) {
    vscode.window.showWarningMessage(
      'Prompt Optimizer onboarding guide is missing (media/onboarding.html).',
    );
    return;
  }

  onboardingPanel = vscode.window.createWebviewPanel(
    'promptOptimizer.onboarding',
    'Prompt Optimizer — Onboarding',
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.file(path.dirname(htmlPath))],
    },
  );

  const renderHtml = (): string => {
    const raw = fs.readFileSync(htmlPath, 'utf8');
    const snapshot = collectMemorySnapshot();
    const injection =
      `<script id="__poMemorySeed">window.__POMemorySeed = ${JSON.stringify(snapshot)};</script>`;
    // Substitute version + any other simple template tokens. The version
    // is read from package.json at runtime, so onboarding always shows the
    // installed extension's actual version with no static asset edits.
    const version = (context.extension.packageJSON?.version ?? '') as string;
    const templated = raw.replace(/\{\{PROMPT_OPTIMIZER_VERSION\}\}/g, version);
    // Replace placeholder if present, else inject before </body>
    if (templated.includes('<!-- __PO_MEMORY_SNAPSHOT__ -->')) {
      return templated.replace('<!-- __PO_MEMORY_SNAPSHOT__ -->', injection);
    }
    return templated.replace('</body>', `${injection}\n</body>`);
  };

  onboardingPanel.webview.html = renderHtml();

  onboardingPanel.webview.onDidReceiveMessage(async (msg: unknown) => {
    if (!msg || typeof msg !== 'object') { return; }
    const type = (msg as { type?: unknown }).type;
    if (type === 'requestMemorySnapshot' && onboardingPanel) {
      await onboardingPanel.webview.postMessage({
        type: 'memorySnapshot',
        snapshot: collectMemorySnapshot(),
      });
    } else if (type === 'openMemoryFile') {
      await vscode.commands.executeCommand('prompt-proxy.openMemoryFile');
    }
  });

  onboardingPanel.onDidDispose(() => { onboardingPanel = undefined; });
}
