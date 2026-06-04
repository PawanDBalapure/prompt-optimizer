import * as vscode from 'vscode';

import * as fs from 'fs';
import * as path from 'path';
import * as childProcess from 'child_process';

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
      case 'requestInstructionsOverview':
        return this._handleInstructionsOverview(webviewView);
      case 'instructionsHistory':
        return this._handleInstructionsHistory(webviewView, data.relPath ?? '');
      case 'openInstructionFile':
        return this._handleOpenInstructionFile(webviewView, data.relPath ?? '');
      case 'exportInstructions':
        return this._handleExportInstructions(webviewView);
      case 'importInstructions':
        return this._handleImportInstructions(webviewView);
      case 'toggleInstructionRule':
        return this._handleToggleInstructionRule(webviewView, data);
      case 'togglePersona':
        return this._handleTogglePersona(webviewView, data);
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
        async () => { await seedCacheFromWorkspace(this._context, { force: true, skipChatHistory: true }); },
      );
    } catch {
      // Non-fatal: still re-read whatever the engine can report.
    } finally {
      await this._sendStatusOverview(webviewView);
      webviewView.webview.postMessage({ type: 'overviewRefreshed' });
    }
  }

  // ── Instructions Manager ──────────────────────────────────────────────────

  /** Compute the overview JSON via the engine sidecar and push it to the panel. */
  private async _handleInstructionsOverview(webviewView: vscode.WebviewView): Promise<void> {
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!wsRoot) {
      webviewView.webview.postMessage({
        type: 'instructionsOverview',
        ok: false,
        error: 'Open a workspace folder to manage instructions.',
      });
      return;
    }
    try {
      const personaDir = path.join(this._extensionUri.fsPath, 'media', 'skill-library');
      const raw = runEngineRaw(['--instructions-overview', '--workspace-root', wsRoot, '--persona-dir', personaDir]);
      const overview = JSON.parse(raw);
      webviewView.webview.postMessage({ type: 'instructionsOverview', ok: true, payload: overview });
    } catch (err) {
      webviewView.webview.postMessage({
        type: 'instructionsOverview',
        ok: false,
        error: err instanceof Error ? err.message : 'Could not read instructions.',
      });
    }
  }

  /** Resolve and validate a workspace-relative instruction path. */
  private _resolveInstructionPath(relPath: string): { wsRoot: string; abs: string } | null {
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!wsRoot) { return null; }
    const normalized = relPath.replace(/\\/g, '/');
    if (normalized.includes('..') || path.isAbsolute(normalized)) { return null; }
    const abs = path.resolve(wsRoot, normalized);
    // Containment check: the resolved path must stay inside the workspace.
    const rel = path.relative(wsRoot, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) { return null; }
    return { wsRoot, abs };
  }

  /** Read git history (authorship + timestamps) for one instruction file. */
  private async _handleInstructionsHistory(
    webviewView: vscode.WebviewView,
    relPath: string,
  ): Promise<void> {
    const reply = (ok: boolean, extra: Record<string, unknown> = {}): void => {
      webviewView.webview.postMessage({ type: 'instructionsHistory', ok, relPath, ...extra });
    };
    const resolved = this._resolveInstructionPath(relPath);
    if (!resolved) { reply(false, { error: 'Invalid instruction path.' }); return; }

    try {
      // %h sha, %an author, %ad ISO-ish date, %ar relative date, %s subject.
      const out = childProcess.execFileSync(
        'git',
        [
          '-C', resolved.wsRoot,
          'log',
          '--max-count=25',
          '--follow',
          '--pretty=format:%h\u001f%an\u001f%ad\u001f%ar\u001f%s',
          '--date=short',
          '--', relPath,
        ],
        { encoding: 'utf8', timeout: 8000 },
      );
      const commits = out
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [sha, author, date, relative, subject] = line.split('\u001f');
          return { sha, author, date, relative, subject };
        });
      reply(true, { commits });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const notGit = /not a git repository|command not found|ENOENT/i.test(msg);
      reply(false, {
        error: notGit
          ? 'No git history available (workspace is not a git repository or git is not installed).'
          : 'Could not read git history for this file.',
      });
    }
  }

  /** Open an instruction source in the editor (creating it if missing). */
  private async _handleOpenInstructionFile(
    webviewView: vscode.WebviewView,
    relPath: string,
  ): Promise<void> {
    const resolved = this._resolveInstructionPath(relPath);
    if (!resolved) {
      webviewView.webview.postMessage({ type: 'error', message: 'Invalid instruction path.' });
      return;
    }
    try {
      if (!fs.existsSync(resolved.abs)) {
        fs.mkdirSync(path.dirname(resolved.abs), { recursive: true });
        fs.writeFileSync(resolved.abs, '', { encoding: 'utf8', flag: 'wx' });
      }
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(resolved.abs));
      await vscode.window.showTextDocument(doc, { preview: false });
    } catch (err) {
      webviewView.webview.postMessage({
        type: 'error',
        message: err instanceof Error ? err.message : 'Could not open the instruction file.',
      });
    }
  }

  /** Export all instruction sources into a single JSON bundle the user picks. */
  private async _handleExportInstructions(webviewView: vscode.WebviewView): Promise<void> {
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!wsRoot) {
      webviewView.webview.postMessage({ type: 'error', message: 'Open a workspace folder first.' });
      return;
    }
    try {
      const raw = runEngineRaw(['--instructions-overview', '--workspace-root', wsRoot]);
      const overview = JSON.parse(raw) as {
        sources: Array<{ id: string; label: string; relPath: string; exists: boolean }>;
      };
      const files: Array<{ relPath: string; label: string; content: string }> = [];
      for (const src of overview.sources) {
        if (!src.exists) { continue; }
        const abs = path.resolve(wsRoot, src.relPath);
        try {
          files.push({ relPath: src.relPath, label: src.label, content: fs.readFileSync(abs, 'utf8') });
        } catch { /* skip unreadable */ }
      }
      const bundle = {
        kind: 'prompt-optimizer.instructions-bundle',
        version: 1,
        exportedAt: new Date().toISOString(),
        files,
      };
      const target = await vscode.window.showSaveDialog({
        title: 'Export instruction sources',
        defaultUri: vscode.Uri.file(path.join(wsRoot, 'instructions-bundle.json')),
        filters: { JSON: ['json'] },
      });
      if (!target) {
        webviewView.webview.postMessage({ type: 'instructionsActionDone', ok: false, error: 'Export cancelled.' });
        return;
      }
      fs.writeFileSync(target.fsPath, JSON.stringify(bundle, null, 2), 'utf8');
      webviewView.webview.postMessage({
        type: 'instructionsActionDone',
        ok: true,
        message: `Exported ${files.length} instruction file${files.length === 1 ? '' : 's'}.`,
      });
    } catch (err) {
      webviewView.webview.postMessage({
        type: 'instructionsActionDone',
        ok: false,
        error: err instanceof Error ? err.message : 'Export failed.',
      });
    }
  }

  /** Import an instruction bundle, writing each file back after confirmation. */
  private async _handleImportInstructions(webviewView: vscode.WebviewView): Promise<void> {
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!wsRoot) {
      webviewView.webview.postMessage({ type: 'error', message: 'Open a workspace folder first.' });
      return;
    }
    const done = (ok: boolean, extra: Record<string, unknown> = {}): void => {
      webviewView.webview.postMessage({ type: 'instructionsActionDone', ok, ...extra });
    };
    try {
      const picked = await vscode.window.showOpenDialog({
        title: 'Import instruction bundle',
        canSelectMany: false,
        filters: { JSON: ['json'] },
      });
      if (!picked || picked.length === 0) { done(false, { error: 'Import cancelled.' }); return; }

      const bundle = JSON.parse(fs.readFileSync(picked[0].fsPath, 'utf8')) as {
        kind?: string;
        files?: Array<{ relPath?: string; content?: string }>;
      };
      if (bundle.kind !== 'prompt-optimizer.instructions-bundle' || !Array.isArray(bundle.files)) {
        done(false, { error: 'Not a valid instructions bundle file.' });
        return;
      }

      const confirm = await vscode.window.showWarningMessage(
        `Import ${bundle.files.length} instruction file(s)? Existing files with the same path will be overwritten.`,
        { modal: true },
        'Import',
      );
      if (confirm !== 'Import') { done(false, { error: 'Import cancelled.' }); return; }

      let written = 0;
      for (const file of bundle.files) {
        const rel = typeof file.relPath === 'string' ? file.relPath.replace(/\\/g, '/') : '';
        const content = typeof file.content === 'string' ? file.content : '';
        if (!rel || rel.includes('..') || path.isAbsolute(rel)) { continue; }
        const abs = path.resolve(wsRoot, rel);
        const containment = path.relative(wsRoot, abs);
        if (containment.startsWith('..') || path.isAbsolute(containment)) { continue; }
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content, 'utf8');
        written++;
      }
      done(true, { message: `Imported ${written} instruction file${written === 1 ? '' : 's'}.` });
      await this._handleInstructionsOverview(webviewView);
    } catch (err) {
      done(false, { error: err instanceof Error ? err.message : 'Import failed.' });
    }
  }

  /** Select / deselect a single rule by rewriting its line in the source file. */
  private async _handleToggleInstructionRule(
    webviewView: vscode.WebviewView,
    data: { relPath?: string; line?: number; ruleText?: string; enabled?: boolean },
  ): Promise<void> {
    const done = (ok: boolean, extra: Record<string, unknown> = {}): void => {
      webviewView.webview.postMessage({ type: 'instructionsActionDone', ok, ...extra });
    };
    const relPath = data.relPath;
    const ruleText = (data.ruleText ?? '').trim();
    const targetEnabled = data.enabled === true;
    if (!relPath || !ruleText) { done(false, { error: 'Missing rule details.' }); return; }
    // The marker close sequence inside rule text would corrupt the comment.
    if (ruleText.includes('-->')) {
      done(false, { error: 'Rule cannot be toggled because it contains "-->".' });
      return;
    }

    const resolved = this._resolveInstructionPath(relPath);
    if (!resolved) { done(false, { error: 'Invalid instruction path.' }); return; }

    try {
      const original = fs.readFileSync(resolved.abs, 'utf8');
      const eol = original.includes('\r\n') ? '\r\n' : '\n';
      const lines = original.split(/\r?\n/);

      const offRe = /^(\s*)<!--\s*po-off:\s?([\s\S]*?)\s*-->\s*$/;
      const stripped = (s: string): string =>
        s
          .replace(/^\s*<!--\s*po-off:\s?/, '')
          .replace(/\s*-->\s*$/, '')
          .replace(/^>\s?/, '')
          .replace(/^[-*+]\s+/, '')
          .replace(/^\d+[.)]\s+/, '')
          .replace(/^\[[ xX]\]\s+/, '')
          .trim();

      // Locate the target line: prefer the reported index, fall back to a
      // unique content match (line numbers can drift after edits).
      let idx = (typeof data.line === 'number' ? data.line : 0) - 1;
      if (idx < 0 || idx >= lines.length || stripped(lines[idx]) !== ruleText) {
        const matches: number[] = [];
        for (let i = 0; i < lines.length; i++) {
          if (stripped(lines[i]) === ruleText) { matches.push(i); }
        }
        if (matches.length !== 1) {
          done(false, { error: 'Could not locate that rule in the file.' });
          return;
        }
        idx = matches[0];
      }

      // Refuse edits inside an auto-managed block.
      let managed = false;
      for (let i = 0; i <= idx; i++) {
        const t = lines[i].trim();
        if (t.includes('prompt-optimizer:memory:begin')) { managed = true; }
        else if (t.includes('prompt-optimizer:memory:end')) { managed = false; }
      }
      if (managed) {
        done(false, { error: 'This rule is in an auto-managed block and cannot be toggled.' });
        return;
      }

      const line = lines[idx];
      const isOff = offRe.test(line);
      if (targetEnabled) {
        if (isOff) {
          const m = offRe.exec(line)!;
          lines[idx] = m[1] + m[2];
        }
      } else if (!isOff) {
        const indentMatch = /^(\s*)/.exec(line);
        const indent = indentMatch ? indentMatch[1] : '';
        lines[idx] = `${indent}<!-- po-off: ${line.slice(indent.length)} -->`;
      }

      fs.writeFileSync(resolved.abs, lines.join(eol), 'utf8');
      done(true, { message: targetEnabled ? 'Rule enabled.' : 'Rule disabled.' });
      await this._handleInstructionsOverview(webviewView);
    } catch (err) {
      done(false, { error: err instanceof Error ? err.message : 'Could not update the rule.' });
    }
  }

  /** Enable / disable a bundled persona by installing or removing its skill copy. */
  private async _handleTogglePersona(
    webviewView: vscode.WebviewView,
    data: { personaId?: string; sourceFile?: string; enabled?: boolean },
  ): Promise<void> {
    const done = (ok: boolean, extra: Record<string, unknown> = {}): void => {
      webviewView.webview.postMessage({ type: 'instructionsActionDone', ok, ...extra });
    };
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!wsRoot) { done(false, { error: 'Open a workspace folder first.' }); return; }

    const personaId = data.personaId;
    const sourceFile = data.sourceFile;
    if (!personaId || !/^[a-z0-9][a-z0-9-]*$/.test(personaId)) {
      done(false, { error: 'Invalid persona id.' });
      return;
    }

    const targetDir = path.join(wsRoot, '.promptoptimizer', 'skills');
    const targetPath = path.join(targetDir, `${personaId}.md`);
    try {
      if (data.enabled === true) {
        if (!sourceFile || !/^[A-Za-z0-9._-]+\.md$/.test(sourceFile)) {
          done(false, { error: 'Invalid persona source file.' });
          return;
        }
        const libDir = path.join(this._extensionUri.fsPath, 'media', 'skill-library');
        const srcPath = path.join(libDir, sourceFile);
        // Containment: the source must stay inside the bundled library.
        const srcRel = path.relative(libDir, srcPath);
        if (srcRel.startsWith('..') || path.isAbsolute(srcRel) || !fs.existsSync(srcPath)) {
          done(false, { error: 'Bundled persona not found.' });
          return;
        }
        fs.mkdirSync(targetDir, { recursive: true });
        fs.copyFileSync(srcPath, targetPath);
        done(true, { message: 'Persona enabled.' });
      } else {
        if (fs.existsSync(targetPath)) { fs.rmSync(targetPath); }
        done(true, { message: 'Persona disabled.' });
      }
      await this._handleInstructionsOverview(webviewView);
    } catch (err) {
      done(false, { error: err instanceof Error ? err.message : 'Could not update the persona.' });
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
