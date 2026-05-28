import * as vscode from 'vscode';

import { openChatWithPrompt } from '../commands/open';
import { analyzePrompt } from '../chat/analyzer';
import { getTargetModel, setTargetModel } from '../state/config';
import { getLastAnalysis } from '../state/session';
import type { PromptProxyPanelState } from '../types';
import { renderWebviewHtml } from '../webview/loader';
import { validateMessage } from '../webview/validator';
import { PromptProxyViewProvider } from './PromptProxyViewProvider';

/**
 * Compact popup panel opened by clicking the "Proxy" status-bar item.
 * Styled to match the Copilot Pro panel: header, savings metric + progress
 * bar, info rows, inline analyse input, and closable footer link rows.
 */
export class ProxyStatusPanel {
  static current: ProxyStatusPanel | undefined;

  private readonly _panel: vscode.WebviewPanel;
  private readonly _disposables: vscode.Disposable[] = [];
  private _isDisposed = false;

  private constructor(
    private readonly _context: vscode.ExtensionContext,
    private readonly _provider: PromptProxyViewProvider,
  ) {
    this._panel = vscode.window.createWebviewPanel(
      'promptProxyStatus',
      'Prompt Optimizer',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(_context.extensionUri, 'media')],
      },
    );
    this._panel.iconPath = vscode.Uri.joinPath(_context.extensionUri, 'images', 'icon.png');
    this._panel.webview.onDidReceiveMessage(
      async (raw: unknown) => {
        const data = validateMessage(raw);
        if (!data) { return; }
        await this._handleMessage(data);
      },
      null,
      this._disposables,
    );
    this._panel.onDidDispose(() => {
      this._isDisposed = true;
      ProxyStatusPanel.current = undefined;
      while (this._disposables.length > 0) {
        this._disposables.pop()?.dispose();
      }
    });
    this._panel.webview.html = this._getHtml();
  }

  static toggle(
    context: vscode.ExtensionContext,
    provider: PromptProxyViewProvider,
  ): void {
    if (ProxyStatusPanel.current) {
      ProxyStatusPanel.current._panel.reveal(vscode.ViewColumn.Beside, true);
      return;
    }
    ProxyStatusPanel.current = new ProxyStatusPanel(context, provider);
    const last = getLastAnalysis(context);
    if (last) {
      ProxyStatusPanel.current.publishAnalysis(last);
    }
  }

  publishAnalysis(state: PromptProxyPanelState): void {
    this._panel.webview.postMessage({ type: 'analysisState', payload: state });
  }

  dispose(): void {
    if (this._isDisposed) { return; }
    ProxyStatusPanel.current = undefined;
    this._panel.dispose();
  }

  private async _handleMessage(
    data: { type: string; prompt?: string; model?: string },
  ): Promise<void> {
    switch (data.type) {
      case 'ready': {
        const state = getLastAnalysis(this._context);
        if (state) { this.publishAnalysis(state); }
        this._panel.webview.postMessage({ type: 'targetModelPattern', model: getTargetModel(this._context) });
        return;
      }
      case 'setTargetModel':
        await setTargetModel(this._context, data.model ?? 'gpt');
        return;
      case 'analyze': {
        const prompt = data.prompt?.trim() ?? '';
        if (!prompt) {
          this._panel.webview.postMessage({ type: 'error', message: 'Enter a prompt to analyze.' });
          return;
        }
        try {
          const state = await analyzePrompt(this._context, prompt, 'panel');
          this.publishAnalysis(state);
          this._provider.publishAnalysis(state);
        } catch (error) {
          this._panel.webview.postMessage({
            type: 'error',
            message: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }
      case 'sendPrompt': await openChatWithPrompt(data.prompt ?? '', false); return;
      case 'copyPrompt':
        if (data.prompt) { await vscode.env.clipboard.writeText(data.prompt); }
        return;
      case 'openChat': await openChatWithPrompt('', true); return;
      case 'openSettings':
        await vscode.commands.executeCommand('workbench.action.openSettings', 'promptProxy');
        return;
      case 'close': this._panel.dispose(); return;
    }
  }

  private _getHtml(): string {
    return renderWebviewHtml(this._panel.webview, this._context.extensionUri, { name: 'status' });
  }
}
