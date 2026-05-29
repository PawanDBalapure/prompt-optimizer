import * as vscode from 'vscode';

import { MODE_KEY } from '../constants';
import { openChatWithPrompt, openExtensionReadme } from '../commands/open';
import { analyzePrompt } from '../chat/analyzer';
import {
  SECRET_PATTERNS,
  scanForSecrets,
} from '../security/secret-patterns';
import {
  SECRET_PATTERN_MODE_LABELS,
  SECRET_PATTERN_MODE_PLACEHOLDERS,
  SECRET_PATTERN_MODE_VALUES,
} from '../security/secret-modes';
import { renderSecretPatternHelpTooltip } from '../security/secret-help';
import { ProxyStatusPanel } from './ProxyStatusPanel';
import {
  addConversationTurn,
  buildLMMessages,
  getConversation,
  resolveReferences,
} from '../state/conversation';
import { getCurrentMode } from '../state/mode';
import { getTargetModel, setTargetModel, getDbPath } from '../state/config';
import { getLastAnalysis } from '../state/session';
import type {
  CustomSecretPatternConfig,
  PromptProxyPanelState,
  ProxyMode,
} from '../types';
import { computeWorkspaceId } from '../util/workspace';
import { renderWebviewHtml } from '../webview/loader';
import { validateMessage } from '../webview/validator';
import { PROMPT_PROXY_VIEW_TYPE } from './view-type';
import { runEngineRaw } from '../engine/runner';

// `scanForSecrets` is re-exported for callers that share the secrets module
// surface with the panel.
void scanForSecrets;

export class PromptProxyViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = PROMPT_PROXY_VIEW_TYPE;

  private _view?: vscode.WebviewView;
  private _agentCts?: vscode.CancellationTokenSource;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _context: vscode.ExtensionContext,
  ) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      // Restrict resource loading to the media folder containing our
      // bundled webview assets.
      localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'media')],
    };

    webviewView.webview.onDidReceiveMessage(async (raw: unknown) => {
      const data = validateMessage(raw);
      if (!data) { return; }
      try {
        await this._dispatch(webviewView, data);
      } catch (err) {
        webviewView.webview.postMessage({
          type: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    });

    webviewView.webview.html = this._getHtmlForWebview();
  }

  public publishAnalysis(state: PromptProxyPanelState): void {
    this._view?.webview.postMessage({ type: 'analysisState', payload: state });
    // Mirror the analysis to the standalone status panel so both surfaces
    // stay in sync regardless of which entry point triggered the analyze.
    ProxyStatusPanel.current?.publishAnalysis(state);
    this.refreshStatusOverview();
  }

  public notifyModeChange(mode: ProxyMode): void {
    this._view?.webview.postMessage({ type: 'modeState', mode });
  }

  /**
   * Push a previously-committed prompt back into the panel textarea
   * (Git-style `checkout` updating the working tree).
   */
  public restorePromptInPanel(text: string): void {
    this._view?.webview.postMessage({ type: 'restorePrompt', prompt: text });
  }

  /**
   * Hook for the versions command to nudge the webview after a commit
   * (so it can refresh a count badge or similar in the future).  Safe
   * no-op today; kept so the call sites stay simple.
   */
  public notifyVersionsChanged(): void {
    this._view?.webview.postMessage({ type: 'versionsChanged' });
  }

  public refreshStatusOverview(): void {
    if (!this._view) { return; }
    void this._sendStatusOverview(this._view);
  }

  private async _dispatch(
    webviewView: vscode.WebviewView,
    data: ReturnType<typeof validateMessage> & object,
  ): Promise<void> {
    switch (data.type) {
      case 'ready': return this._handleReady(webviewView);
      case 'setMode':
        if (data.mode) {
          await this._context.globalState.update(MODE_KEY, data.mode as ProxyMode);
        }
        return;
      case 'setTargetModel':
        await setTargetModel(this._context, data.model ?? 'gpt');
        return;
      case 'agentRun': return this._handleAgentRun(webviewView, data.prompt ?? '');
      case 'analyze': return this._handleAnalyze(webviewView, data.prompt ?? '');
      case 'sendPrompt': await openChatWithPrompt(data.prompt ?? '', false); return;
      case 'openChatWithPrompt': await openChatWithPrompt(data.prompt ?? '', true); return;
      case 'copyPrompt':
        if (data.prompt) { await vscode.env.clipboard.writeText(data.prompt); }
        return;
      case 'openChat': await openChatWithPrompt('', true); return;
      case 'openReadme': await openExtensionReadme(this._context); return;
      case 'openOnboarding':
        await vscode.commands.executeCommand('prompt-proxy.openOnboarding');
        return;
      case 'openMemoryFile':
        await vscode.commands.executeCommand('prompt-proxy.openMemoryFile');
        return;
      case 'openPeerWorkspaces':
        await vscode.commands.executeCommand('prompt-proxy.peerWorkspaces');
        return;
      case 'manageAgentSkills':
        await vscode.commands.executeCommand('prompt-proxy.manageAgentSkills');
        return;
      case 'openUserGuide':
        await vscode.commands.executeCommand('prompt-proxy.userGuide');
        return;
      case 'showHistory':
        await vscode.commands.executeCommand('prompt-proxy.showHistory');
        return;
      case 'commitPrompt':
        await vscode.commands.executeCommand('prompt-proxy.commitPrompt', {
          prompt: data.prompt ?? '',
          optimized: data.optimized,
        });
        return;
      case 'showPromptLog':
        await vscode.commands.executeCommand('prompt-proxy.showPromptLog');
        return;
      case 'switchPromptBranch':
        await vscode.commands.executeCommand('prompt-proxy.switchPromptBranch');
        return;
      case 'requestStatusOverview':
        return this._sendStatusOverview(webviewView);
      case 'openSecretSettings': return this._sendSecretSettings(webviewView);
      case 'saveSecretSettings': return this._saveSecretSettings(webviewView, data);
    }
  }

  private _handleReady(webviewView: vscode.WebviewView): void {
    const state = getLastAnalysis(this._context);
    if (state) { this.publishAnalysis(state); }
    webviewView.webview.postMessage({ type: 'modeState', mode: getCurrentMode(this._context) });
    webviewView.webview.postMessage({ type: 'targetModelPattern', model: getTargetModel(this._context) });
    // Render immediately, then let activation/bootstrap push fresher counts
    // once the background seeding pass finishes.
    this.refreshStatusOverview();
  }

  private async _sendStatusOverview(webviewView: vscode.WebviewView): Promise<void> {
    try {
      const dbPath = getDbPath(this._context);
      const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const wsId = computeWorkspaceId(wsRoot);
      const raw = runEngineRaw(['--status-overview', '--workspace', wsId, '--db', dbPath]);
      const overview = JSON.parse(raw);
      webviewView.webview.postMessage({ type: 'statusOverview', payload: overview });
    } catch {
      // Non-fatal: leave the status strip hidden if the engine call fails.
    }
  }

  private async _handleAnalyze(webviewView: vscode.WebviewView, prompt: string): Promise<void> {
    if (!prompt.trim()) {
      webviewView.webview.postMessage({ type: 'error', message: 'Enter a prompt to analyze.' });
      return;
    }
    const state = await analyzePrompt(this._context, prompt.trim(), 'panel');
    this.publishAnalysis(state);
  }

  private async _handleAgentRun(webviewView: vscode.WebviewView, prompt: string): Promise<void> {
    const trimmed = prompt.trim();
    if (!trimmed) {
      webviewView.webview.postMessage({ type: 'error', message: 'Enter a prompt.' });
      return;
    }

    // Cancel any in-flight request.
    if (this._agentCts) { this._agentCts.cancel(); this._agentCts.dispose(); }
    this._agentCts = new vscode.CancellationTokenSource();
    const agentToken = this._agentCts.token;

    webviewView.webview.postMessage({ type: 'responseStart' });
    try {
      const state = await analyzePrompt(this._context, trimmed, 'panel');
      this.publishAnalysis(state);

      const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const wsId = computeWorkspaceId(wsRoot);
      const history = getConversation(this._context, wsId);
      const enriched = resolveReferences(state.optimized, history);

      const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
      if (models.length === 0 || agentToken.isCancellationRequested) {
        webviewView.webview.postMessage({
          type: 'responseError',
          message: "No Copilot model available. Switch to 'Optimize only' mode or ensure GitHub Copilot is active.",
        });
        return;
      }

      const messages = buildLMMessages(history, enriched, state);
      const lmResponse = await models[0].sendRequest(messages, {}, agentToken);

      let fullResponse = '';
      for await (const chunk of lmResponse.text) {
        if (agentToken.isCancellationRequested) { break; }
        webviewView.webview.postMessage({ type: 'responseChunk', chunk });
        fullResponse += chunk;
      }
      if (fullResponse.trim()) {
        await addConversationTurn(this._context, wsId, {
          user_raw: trimmed,
          user_optimized: enriched,
          assistant: fullResponse.trim(),
        });
      }
      webviewView.webview.postMessage({ type: 'responseDone' });
    } catch (err) {
      webviewView.webview.postMessage({
        type: 'responseError',
        message: err instanceof Error ? err.message : 'Agent call failed.',
      });
    }
  }

  private _sendSecretSettings(webviewView: vscode.WebviewView): void {
    const cfg = vscode.workspace.getConfiguration('promptProxy');
    webviewView.webview.postMessage({
      type: 'secretSettingsState',
      enabled: cfg.get<boolean>('enableSecretDetection') !== false,
      customPatterns: cfg.get<CustomSecretPatternConfig[]>('secretPatterns') ?? [],
      builtinLabels: SECRET_PATTERNS.map((s) => s.label),
    });
  }

  private async _saveSecretSettings(
    webviewView: vscode.WebviewView,
    data: { enabled?: boolean; customPatterns?: CustomSecretPatternConfig[] },
  ): Promise<void> {
    const saveCfg = vscode.workspace.getConfiguration('promptProxy');
    await saveCfg.update('enableSecretDetection', data.enabled === true, vscode.ConfigurationTarget.Global);
    await saveCfg.update('secretPatterns', data.customPatterns ?? [], vscode.ConfigurationTarget.Global);
    webviewView.webview.postMessage({ type: 'secretSettingsSaved' });
  }

  private _getHtmlForWebview(): string {
    const secretPatternModeOptions = SECRET_PATTERN_MODE_VALUES
      .map((mode) => `<option value="${mode}">${SECRET_PATTERN_MODE_LABELS[mode]}</option>`)
      .join('');
    return renderWebviewHtml(this._view!.webview, this._extensionUri, {
      name: 'panel',
      extras: {
        SECRET_PATTERN_HELP_TOOLTIP: renderSecretPatternHelpTooltip(),
        SECRET_PATTERN_MODE_OPTIONS: secretPatternModeOptions,
        SECRET_PATTERN_MODE_LABELS_JSON: JSON.stringify(SECRET_PATTERN_MODE_LABELS),
        SECRET_PATTERN_MODE_PLACEHOLDERS_JSON: JSON.stringify(SECRET_PATTERN_MODE_PLACEHOLDERS),
      },
    });
  }
}
