import * as vscode from 'vscode';

import * as fs from 'fs';
import * as path from 'path';

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
  getConversation,
  resolveReferences,
} from '../state/conversation';
import { getCurrentMode } from '../state/mode';
import { getTargetModel, setTargetModel, getDbPath, getCreditForecastConfig } from '../state/config';
import { getLastAnalysis } from '../state/session';
import type {
  CustomSecretPatternConfig,
  PromptProxyPanelState,
  ProxyMode,
} from '../types';
import { computeWorkspaceId } from '../util/workspace';
import { reportError } from '../util/errorReporter';
import { renderWebviewHtml } from '../webview/loader';
import { validateMessage } from '../webview/validator';
import { PROMPT_PROXY_VIEW_TYPE } from './view-type';
import { runEngineRaw } from '../engine/runner';
import { seedCacheFromWorkspace } from '../engine/seeder';
import { ocrImage as runOcrOnBuffer } from '../chat/ocr';

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
      localResourceRoots: [
        vscode.Uri.joinPath(this._extensionUri, 'media'),
        vscode.Uri.joinPath(this._extensionUri, 'images'),
      ],
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
        // Surface a one-click "Email author" toast for unhandled webview
        // errors so users can report problems without leaving the editor.
        void reportError('Prompt Optimizer panel hit an error.', err, {
          scope: `webview:${data.type ?? 'unknown'}`,
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
      case 'reportIssue':
        await vscode.commands.executeCommand('prompt-proxy.reportIssue');
        return;
      case 'resetToDefaults':
        await vscode.commands.executeCommand('prompt-proxy.resetToDefaults');
        return;
      case 'requestStatusOverview':
        return this._sendStatusOverview(webviewView);
      case 'openSecretSettings': return this._sendSecretSettings(webviewView);
      case 'saveSecretSettings': return this._saveSecretSettings(webviewView, data);
      case 'ocrImage': return this._handleOcrImage(webviewView, data);
      case 'createAgent':
        return this._handleCreateAgent(webviewView, data.agentName ?? '', data.agentContent ?? '');
      case 'deleteAgent':
        return this._handleDeleteAgent(webviewView, data.agentId ?? '');
      case 'refreshOverview':
        return this._handleRefreshOverview(webviewView);
    }
  }

  private _handleReady(webviewView: vscode.WebviewView): void {
    const state = getLastAnalysis(this._context);
    if (state) { this.publishAnalysis(state); }
    webviewView.webview.postMessage({ type: 'modeState', mode: getCurrentMode(this._context) });
    webviewView.webview.postMessage({ type: 'targetModelPattern', model: getTargetModel(this._context) });
    webviewView.webview.postMessage({ type: 'creditForecastConfig', config: getCreditForecastConfig() });
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

    try {
      const state = await analyzePrompt(this._context, trimmed, 'panel');
      if (agentToken.isCancellationRequested) { return; }
      this.publishAnalysis(state);

      const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const wsId = computeWorkspaceId(wsRoot);
      const history = getConversation(this._context, wsId);
      const enriched = resolveReferences(state.optimized, history);

      // Record the user turn locally so follow-up references continue to
      // resolve. The assistant turn is not captured here because the
      // response is rendered in Copilot Chat, not the panel.
      await addConversationTurn(this._context, wsId, {
        user_raw: trimmed,
        user_optimized: enriched,
        assistant: '',
      });

      // Send the optimized prompt straight to Copilot Chat with auto-submit
      // and no @promptoptimizer participant prefix \u2014 the Copilot agent
      // handles the request natively in the Chat view.
      await openChatWithPrompt(enriched, false, true);
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

  /**
   * Decode the base64 image payload posted by the webview, run it through
   * Tesseract OCR (fully offline), and ship the extracted text back. The
   * webview correlates responses to requests via the `id` field.
   */
  private async _handleOcrImage(
    webviewView: vscode.WebviewView,
    data: { id?: string; name?: string; dataBase64?: string },
  ): Promise<void> {
    const id = data.id;
    if (!id || !data.dataBase64) {
      if (id) {
        webviewView.webview.postMessage({ type: 'ocrImageResult', id, ok: false, error: 'invalid payload' });
      }
      return;
    }
    try {
      const buffer = Buffer.from(data.dataBase64, 'base64');
      if (buffer.length === 0) {
        webviewView.webview.postMessage({ type: 'ocrImageResult', id, ok: false, error: 'empty image' });
        return;
      }
      const text = await runOcrOnBuffer(this._context, buffer);
      webviewView.webview.postMessage({
        type: 'ocrImageResult',
        id,
        ok: true,
        name: data.name,
        text: text ?? '',
      });
    } catch (err) {
      webviewView.webview.postMessage({
        type: 'ocrImageResult',
        id,
        ok: false,
        error: err instanceof Error ? err.message : 'OCR failed',
      });
    }
  }

  private async _handleCreateAgent(
    webviewView: vscode.WebviewView,
    agentName: string,
    agentContent: string,
  ): Promise<void> {
    const reply = (ok: boolean, extra: Record<string, unknown> = {}): void => {
      webviewView.webview.postMessage({ type: 'agentCreated', ok, ...extra });
    };

    const label = agentName.trim();
    if (label === '') {
      reply(false, { error: 'Enter a name for the agent.' });
      return;
    }

    const id = label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 41);
    if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(id)) {
      reply(false, { error: 'Use a name with at least 2 letters or digits.' });
      return;
    }

    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!wsRoot) {
      reply(false, { error: 'Open a workspace folder first to save agents.' });
      return;
    }

    const targetDir = path.join(wsRoot, '.promptoptimizer', 'skills');
    const targetPath = path.join(targetDir, `${id}.md`);

    try {
      fs.mkdirSync(targetDir, { recursive: true });
    } catch (err) {
      reply(false, { error: err instanceof Error ? err.message : 'Could not create skills folder.' });
      return;
    }

    if (fs.existsSync(targetPath)) {
      reply(false, { error: `An agent with id "${id}" already exists.` });
      return;
    }

    const body = agentContent.trim();
    const hasFrontmatter = /^---\s*\n[\s\S]*?\n---/.test(body);
    let fileText: string;
    if (hasFrontmatter) {
      fileText = body.endsWith('\n') ? body : `${body}\n`;
    } else {
      const inner = body === ''
        ? `## Role\nDescribe what this agent does in one or two sentences.\n\n## Instructions\n- Step 1: …\n- Step 2: …\n\n## Output format\nExplain the structure of the response you want this agent to produce.`
        : body;
      fileText =
`---
id: ${id}
label: ${label}
readOnly: false
tags: [custom]
---

# ${label}

${inner}
`;
    }

    try {
      fs.writeFileSync(targetPath, fileText, { encoding: 'utf8', flag: 'wx' });
    } catch (err) {
      reply(false, { error: err instanceof Error ? err.message : 'Could not write agent file.' });
      return;
    }

    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(targetPath));
      await vscode.window.showTextDocument(doc, { preview: false });
    } catch {
      // Opening the file is best-effort; the agent is already saved.
    }

    reply(true, { id, label });
  }

  private async _handleDeleteAgent(
    webviewView: vscode.WebviewView,
    agentId: string,
  ): Promise<void> {
    const reply = (ok: boolean, extra: Record<string, unknown> = {}): void => {
      webviewView.webview.postMessage({ type: 'agentDeleted', ok, ...extra });
    };

    const id = agentId.trim();
    if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(id)) {
      reply(false, { error: 'Invalid agent id.' });
      return;
    }

    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!wsRoot) {
      reply(false, { error: 'No workspace folder is open.' });
      return;
    }

    const targetPath = path.join(wsRoot, '.promptoptimizer', 'skills', `${id}.md`);
    if (!fs.existsSync(targetPath)) {
      reply(false, { error: `Agent "${id}" no longer exists.` });
      return;
    }

    try {
      fs.unlinkSync(targetPath);
    } catch (err) {
      reply(false, { error: err instanceof Error ? err.message : 'Could not delete the agent file.' });
      return;
    }

    // Close the editor tab if the freshly-created file is still open.
    try {
      const uri = vscode.Uri.file(targetPath);
      for (const editor of vscode.window.visibleTextEditors) {
        if (editor.document.uri.fsPath === uri.fsPath) {
          await vscode.window.showTextDocument(editor.document, editor.viewColumn);
          await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        }
      }
    } catch {
      // Best-effort; the file is already deleted.
    }

    reply(true, { id });
  }

  private async _handleRefreshOverview(webviewView: vscode.WebviewView): Promise<void> {
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Window,
          title: 'Prompt Optimizer: refreshing index…',
        },
        async () => { await seedCacheFromWorkspace(this._context, { force: true }); },
      );
    } catch {
      // Non-fatal: still re-read whatever the engine can report.
    } finally {
      await this._sendStatusOverview(webviewView);
      webviewView.webview.postMessage({ type: 'overviewRefreshed' });
    }
  }

  private _getHtmlForWebview(): string {
    const secretPatternModeOptions = SECRET_PATTERN_MODE_VALUES
      .map((mode) => `<option value="${mode}">${SECRET_PATTERN_MODE_LABELS[mode]}</option>`)
      .join('');
    const logoUri = this._view!.webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'images', 'icon.png'),
    ).toString();
    return renderWebviewHtml(this._view!.webview, this._extensionUri, {
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
}
