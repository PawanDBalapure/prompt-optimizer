import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { PROMPT_PROXY_VIEW_TYPE } from '../panel/view-type';

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
