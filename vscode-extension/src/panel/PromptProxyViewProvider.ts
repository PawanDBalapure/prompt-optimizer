import * as vscode from 'vscode';

import { openChatWithPrompt, openExtensionReadme } from '../commands/open';
import { handleInstructionsMessage } from '../instructions/messageRouter';
import { MODE_KEY } from '../constants';
import { estimateTokens } from '../memory/budget';
import { getCurrentMode } from '../state/mode';
import { getCreditForecastConfig, getDensity, getTargetModel, setDensity, setTargetModel } from '../state/config';
import { getLastAnalysis } from '../state/session';
import type { PromptProxyPanelState, ProxyMode } from '../types';
import { reportError } from '../util/errorReporter';
import { validateMessage } from '../webview/validator';
import { createAgentFile, deleteAgentFile } from './agentFiles';
import {
  handleOcrImage,
  refreshOverview,
  saveSecretSettings,
  sendSecretSettings,
  sendStatusOverview,
} from './panelActions';
import { buildPanelHtml } from './panelHtml';
import { handleAgentRun, handleAnalyze, type PromptRunPorts } from './promptRuns';
import { ProxyStatusPanel } from './ProxyStatusPanel';
import { PROMPT_PROXY_VIEW_TYPE } from './view-type';

export class PromptProxyViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = PROMPT_PROXY_VIEW_TYPE;

  private _view?: vscode.WebviewView;
  private _agentCts?: vscode.CancellationTokenSource;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _context: vscode.ExtensionContext,
  ) {}

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      // Restrict resource loading to our bundled webview assets.
      localResourceRoots: [
        vscode.Uri.joinPath(this._extensionUri, 'media'),
        vscode.Uri.joinPath(this._extensionUri, 'images'),
      ],
    };

    webviewView.webview.onDidReceiveMessage(async (raw: unknown) => {
      const data = validateMessage(raw);
      if (!data) { return; }
      try {
        await this._dispatch(webviewView.webview, data);
      } catch (err) {
        webviewView.webview.postMessage({
          type: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
        // One-click "Email author" toast so users can report problems.
        void reportError('Prompt Optimizer panel hit an error.', err, {
          scope: `webview:${data.type ?? 'unknown'}`,
        });
      }
    });

    webviewView.webview.html = buildPanelHtml(webviewView.webview, this._extensionUri);
  }

  public publishAnalysis(state: PromptProxyPanelState): void {
    this._view?.webview.postMessage({ type: 'analysisState', payload: state });
    // Mirror to the standalone status panel so both surfaces stay in sync.
    ProxyStatusPanel.current?.publishAnalysis(state);
    this.refreshStatusOverview();
  }

  public notifyModeChange(mode: ProxyMode): void {
    this._view?.webview.postMessage({ type: 'modeState', mode });
  }

  /** Push a committed prompt back into the panel textarea (Git-style checkout). */
  public restorePromptInPanel(text: string): void {
    this._view?.webview.postMessage({ type: 'restorePrompt', prompt: text });
  }

  /** Nudge the webview after a version commit. Safe no-op today. */
  public notifyVersionsChanged(): void {
    this._view?.webview.postMessage({ type: 'versionsChanged' });
  }

  public refreshStatusOverview(): void {
    if (!this._view) { return; }
    void sendStatusOverview(this._context, this._view.webview);
  }

  private _runPorts(webview: vscode.Webview): PromptRunPorts {
    return {
      context: this._context,
      webview,
      publishAnalysis: (state) => this.publishAnalysis(state),
    };
  }

  private async _dispatch(
    webview: vscode.Webview,
    data: NonNullable<ReturnType<typeof validateMessage>>,
  ): Promise<void> {
    if (await handleInstructionsMessage(webview, this._extensionUri.fsPath, data)) { return; }

    switch (data.type) {
      case 'ready': return this._handleReady(webview);
      case 'setMode':
        if (data.mode) { await this._context.globalState.update(MODE_KEY, data.mode as ProxyMode); }
        return;
      case 'setTargetModel': await setTargetModel(this._context, data.model ?? 'gpt'); return;
      case 'setDensity': await setDensity(this._context, data.density ?? 'rich'); return;
      case 'estimateTokens':
        if (typeof data.text === 'string') {
          webview.postMessage({
            type: 'tokenCountResult', fieldId: data.fieldId, tokens: estimateTokens(data.text),
          });
        }
        return;
      case 'agentRun': return this._handleAgentRun(webview, data.prompt ?? '');
      case 'analyze': return handleAnalyze(this._runPorts(webview), data.prompt ?? '');
      case 'sendPrompt': await openChatWithPrompt(data.prompt ?? '', false); return;
      case 'openChatWithPrompt': await openChatWithPrompt(data.prompt ?? '', true); return;
      case 'copyPrompt':
        if (data.prompt) { await vscode.env.clipboard.writeText(data.prompt); }
        return;
      case 'openChat': await openChatWithPrompt('', true); return;
      case 'openReadme': await openExtensionReadme(this._context); return;
      case 'openOnboarding': await vscode.commands.executeCommand('prompt-proxy.openOnboarding'); return;
      case 'openMemoryFile': await vscode.commands.executeCommand('prompt-proxy.openMemoryFile'); return;
      case 'openContextFiles': await vscode.commands.executeCommand('prompt-proxy.openContextFiles'); return;
      case 'openPeerWorkspaces': await vscode.commands.executeCommand('prompt-proxy.peerWorkspaces'); return;
      case 'manageAgentSkills': await vscode.commands.executeCommand('prompt-proxy.manageAgentSkills'); return;
      case 'openUserGuide': await vscode.commands.executeCommand('prompt-proxy.userGuide'); return;
      case 'showHistory': await vscode.commands.executeCommand('prompt-proxy.showHistory'); return;
      case 'commitPrompt':
        await vscode.commands.executeCommand('prompt-proxy.commitPrompt', {
          prompt: data.prompt ?? '',
          optimized: data.optimized,
        });
        return;
      case 'showPromptLog': await vscode.commands.executeCommand('prompt-proxy.showPromptLog'); return;
      case 'switchPromptBranch': await vscode.commands.executeCommand('prompt-proxy.switchPromptBranch'); return;
      case 'reportIssue': await vscode.commands.executeCommand('prompt-proxy.reportIssue'); return;
      case 'resetToDefaults': await vscode.commands.executeCommand('prompt-proxy.resetToDefaults'); return;
      case 'requestStatusOverview': return sendStatusOverview(this._context, webview);
      case 'openSecretSettings': return sendSecretSettings(webview);
      case 'saveSecretSettings': return saveSecretSettings(webview, data);
      case 'ocrImage': return handleOcrImage(this._context, webview, data);
      case 'createAgent':
        webview.postMessage({ type: 'agentCreated', ...(await createAgentFile(data.agentName ?? '', data.agentContent ?? '')) });
        return;
      case 'deleteAgent':
        webview.postMessage({ type: 'agentDeleted', ...(await deleteAgentFile(data.agentId ?? '')) });
        return;
      case 'refreshOverview': return refreshOverview(this._context, webview);
    }
  }

  private _handleReady(webview: vscode.Webview): void {
    const state = getLastAnalysis(this._context);
    if (state) { this.publishAnalysis(state); }
    webview.postMessage({ type: 'modeState', mode: getCurrentMode(this._context) });
    webview.postMessage({ type: 'targetModelPattern', model: getTargetModel(this._context) });
    webview.postMessage({ type: 'densityState', density: getDensity(this._context) });
    webview.postMessage({ type: 'creditForecastConfig', config: getCreditForecastConfig() });
    // Render immediately; background seeding pushes fresher counts later.
    this.refreshStatusOverview();
  }

  private _handleAgentRun(webview: vscode.Webview, prompt: string): Promise<void> {
    // Cancel any in-flight request.
    if (this._agentCts) { this._agentCts.cancel(); this._agentCts.dispose(); }
    this._agentCts = new vscode.CancellationTokenSource();
    return handleAgentRun(this._runPorts(webview), prompt, this._agentCts.token);
  }
}
