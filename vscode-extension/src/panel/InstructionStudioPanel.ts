import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

import { runEngineRaw } from '../engine/runner';
import { renderWebviewHtml } from '../webview/loader';

type StudioMessage = {
  type?: string;
  graph?: unknown;
  persona?: unknown;
  id?: string;
  mode?: string;
  text?: string;
  sessionId?: string;
  traceMode?: string;
  action?: string;
  relPath?: string;
  line?: number;
  ruleText?: string;
  enabled?: boolean;
  personaId?: string;
  sourceFile?: string;
  repo?: string;
};

interface InstructionStudioPreset {
  id: string;
  category: string;
  label: string;
  workflowName: string;
  persona: string;
  condition: string;
  priority: string;
  agentScope: string;
  ruleText: string;
}

interface InstructionStudioConflict {
  code: string;
  severity: 'warning' | 'error';
  message: string;
  nodeIds: string[];
}

interface InstructionStudioReplaySession {
  sessionId: string;
  workflowName: string;
  timestamp: string;
  steps: Array<{ type: string; timestamp: string; title: string; detail: string }>;
}

const STUDIO_DIR = '.instruction_studio';
const AGENT_DIR = '.agent';

import { parseCopilotInstructionsCanvas } from './canvasGraphParser';

export class InstructionStudioPanel {
  private static current: InstructionStudioPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  private constructor(private readonly context: vscode.ExtensionContext) {
    this.panel = vscode.window.createWebviewPanel(
      'promptProxyInstructionStudio',
      'Instruction Studio',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
      },
    );

    this.panel.webview.html = renderWebviewHtml(this.panel.webview, context.extensionUri, {
      name: 'instruction-studio',
    });

    this.panel.webview.onDidReceiveMessage(
      async (raw: unknown) => {
        const msg = raw as StudioMessage;
        await this.handleMessage(msg);
      },
      null,
      this.disposables,
    );

    this.panel.onDidDispose(() => {
      InstructionStudioPanel.current = undefined;
      while (this.disposables.length > 0) {
        this.disposables.pop()?.dispose();
      }
    });
  }

  static show(context: vscode.ExtensionContext): void {
    if (InstructionStudioPanel.current) {
      InstructionStudioPanel.current.panel.webview.html = renderWebviewHtml(
        InstructionStudioPanel.current.panel.webview,
        InstructionStudioPanel.current.context.extensionUri,
        {
          name: 'instruction-studio',
        },
      );
      InstructionStudioPanel.current.panel.reveal(vscode.ViewColumn.Beside);
      return;
    }
    InstructionStudioPanel.current = new InstructionStudioPanel(context);
  }

  private async handleMessage(msg: StudioMessage): Promise<void> {
    switch (msg.type) {
      case 'ready':
        await this.postPresets();
        await this.postCustomPersonas();
        await this.postTraceRows();
        await this.postInsights();
        await this.postReplay();
        await this.postInstructionsOverview();
        this.postCopilotInstructionsCanvas();
        return;
      case 'loadCopilotInstructions':
        this.postCopilotInstructionsCanvas();
        return;
      case 'openMemoryFile':
        await vscode.commands.executeCommand('prompt-proxy.openMemoryFile');
        return;
      case 'openSkillManager':
        await vscode.commands.executeCommand('prompt-proxy.manageAgentSkills');
        return;
      case 'openPanel':
        await vscode.commands.executeCommand('prompt-proxy.focusPanel');
        return;
      case 'createStarterScaffold':
        await this.createStarterScaffold(msg.graph);
        return;
      case 'compileFormGraph':
        await this.createStarterScaffold(msg.graph);
        return;
      case 'saveCustomPersona':
        await this.saveCustomPersona(msg.persona);
        return;
      case 'deleteCustomPersona':
        await this.deleteCustomPersona(msg.id);
        return;
      case 'aiRefineRule':
        await this.refineRule(msg.mode, msg.text);
        return;
      case 'aiGeneratePersona':
        await this.generatePersonaSuggestion();
        return;
      case 'refreshInsights':
        await this.postInsights();
        return;
      case 'loadReplay':
        await this.postReplay(msg.sessionId);
        return;
      case 'requestInstructionsOverview':
        await this.postInstructionsOverview();
        return;
      case 'instructionsHistory':
        await this.postInstructionsHistory(msg.relPath ?? '');
        return;
      case 'openInstructionFile':
        await this.openInstructionFile(msg.relPath ?? '');
        return;
      case 'exportInstructions':
        await this.exportInstructions();
        return;
      case 'importInstructions':
        await this.importInstructions();
        return;
      case 'toggleInstructionRule':
        await this.toggleInstructionRule({ relPath: msg.relPath, line: msg.line, ruleText: msg.ruleText, enabled: msg.enabled });
        return;
      case 'togglePersona':
        await this.togglePersona({ personaId: msg.personaId, sourceFile: msg.sourceFile, enabled: msg.enabled });
        return;
      case 'stageTrace':
        await this.stageTrace(msg.traceMode);
        return;
      case 'ribbonAction':
        vscode.window.showInformationMessage(`Instruction Studio: ${msg.action} requested.`);
        return;
      case 'fetchRulesFromUrl':
        vscode.window.showInformationMessage(`Instruction Studio: Simulating fetch from ${msg.graph || msg.id || 'URL'}...`);
        setTimeout(() => {
          this.panel.webview.postMessage({
            type: 'presets',
            append: true,
            presets: [{
              id: 'url-import-' + Date.now(),
              category: 'Imported',
              label: 'Imported Rule',
              ruleText: 'Downloaded external rule via API.',
              workflowName: 'URL Flow',
              persona: 'External Expert',
              condition: 'Always',
              priority: 'High',
              agentScope: 'Review'
            }]
          });
        }, 800);
        return;
      case 'loadPopularRepo':
        const repo = (msg as any).repo || '';
        let repoPresets: any[] = [];
        if (repo === 'react') {
           repoPresets.push({ id: 'react-1', category: 'React', label: 'Hooks Rules', ruleText: 'Rules of Hooks MUST be followed. No conditional hooks.', workflowName: 'React Flow', persona: 'React Core', condition: 'If file is a component', priority: 'High', agentScope: 'Review' });
        } else if (repo === 'nextjs') {
           repoPresets.push({ id: 'next-1', category: 'Next.js', label: 'Server Components', ruleText: 'Use "use server" by default. Only use "use client" when reactivity is needed.', workflowName: 'Next.js Flow', persona: 'Vercel Expert', condition: 'Always', priority: 'High', agentScope: 'Code Generation' });
        } else if (repo === 'linux') {
           repoPresets.push({ id: 'linux-1', category: 'Linux', label: 'Kernel Style', ruleText: 'Indent with tabs, 8 characters. Maximum line length is 80 columns.', workflowName: 'Linux Flow', persona: 'Kernel Hacker', condition: 'Always', priority: 'Critical', agentScope: 'Review' });
        }
        if (repoPresets.length > 0) {
          vscode.window.showInformationMessage(`Loaded presets for: ${repo}`);
          this.panel.webview.postMessage({ type: 'presets', append: true, presets: repoPresets });
        }
        return;
      default:
        return;
    }
  }

  private workspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  private async postPresets(): Promise<void> {
    try {
      const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const raw = runEngineRaw(['--instruction-studio-presets']);
      const payload = JSON.parse(raw) as { presets?: InstructionStudioPreset[] };
      let merged = payload.presets ?? [];
      if (wsRoot) {
        const customRaw = runEngineRaw(['--instruction-studio-personas-list', '--workspace-root', wsRoot]);
        const customPayload = JSON.parse(customRaw) as { personas?: InstructionStudioPreset[] };
        merged = [...merged, ...(customPayload.personas ?? [])];
      }
      await this.panel.webview.postMessage({ type: 'presets', presets: merged });
    } catch {
      await this.panel.webview.postMessage({ type: 'presets', presets: [] });
    }
  }

  private async postCustomPersonas(): Promise<void> {
    const wsRoot = this.workspaceRoot();
    if (!wsRoot) {
      await this.panel.webview.postMessage({ type: 'customPersonas', personas: [] });
      return;
    }
    try {
      const raw = runEngineRaw(['--instruction-studio-personas-list', '--workspace-root', wsRoot]);
      const payload = JSON.parse(raw) as { personas?: InstructionStudioPreset[] };
      await this.panel.webview.postMessage({ type: 'customPersonas', personas: payload.personas ?? [] });
    } catch {
      await this.panel.webview.postMessage({ type: 'customPersonas', personas: [] });
    }
  }

  private async postInstructionsOverview(): Promise<void> {
    const wsRoot = this.workspaceRoot();
    if (!wsRoot) {
      await this.panel.webview.postMessage({ type: 'instructionsOverview', ok: false, error: 'Open a workspace folder to manage instructions.' });
      return;
    }
    try {
      const personaDir = path.join(this.context.extensionUri.fsPath, 'media', 'skill-library');
      const raw = runEngineRaw(['--instructions-overview', '--workspace-root', wsRoot, '--persona-dir', personaDir]);
      const overview = JSON.parse(raw);
      await this.panel.webview.postMessage({ type: 'instructionsOverview', ok: true, payload: overview });
    } catch (err) {
      await this.panel.webview.postMessage({
        type: 'instructionsOverview',
        ok: false,
        error: err instanceof Error ? err.message : 'Could not read instructions.',
      });
    }
  }

  /**
   * Reads the workspace copilot-instructions.md (or variants), strips the
   * auto-managed block, parses headings/bullets/sentences into canvas nodes
   * and edges, then posts a `canvasGraph` message to the webview.
   */
  private postCopilotInstructionsCanvas(): void {
    const wsRoot = this.workspaceRoot();
    const result = parseCopilotInstructionsCanvas(wsRoot);
    void this.panel.webview.postMessage({
      type: 'canvasGraph',
      nodes: result.nodes,
      edges: result.edges,
      notice: result.notice,
    });
  }

  private resolveInstructionPath(relPath: string): { wsRoot: string; abs: string } | null {
    const wsRoot = this.workspaceRoot();
    if (!wsRoot) { return null; }
    const normalized = relPath.replace(/\\/g, '/');
    if (!normalized || normalized.includes('..') || path.isAbsolute(normalized)) { return null; }
    const abs = path.resolve(wsRoot, normalized);
    const rel = path.relative(wsRoot, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) { return null; }
    return { wsRoot, abs };
  }

  private async postInstructionsHistory(relPath: string): Promise<void> {
    const resolved = this.resolveInstructionPath(relPath);
    const reply = async (ok: boolean, extra: Record<string, unknown> = {}): Promise<void> => {
      await this.panel.webview.postMessage({ type: 'instructionsHistory', ok, relPath, ...extra });
    };
    if (!resolved) {
      await reply(false, { error: 'Invalid instruction path.' });
      return;
    }
    try {
      const result = spawnSync(
        'git',
        ['-C', resolved.wsRoot, 'log', '--max-count=25', '--follow', '--pretty=format:%h\u001f%an\u001f%ad\u001f%ar\u001f%s', '--date=short', '--', relPath],
        { encoding: 'utf8', timeout: 8000 },
      );
      if (result.status !== 0 && result.error) {
        throw result.error;
      }
      const commits = String(result.stdout || '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [sha, author, date, relative, subject] = line.split('\u001f');
          return { sha, author, date, relative, subject };
        });
      await reply(true, { commits });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await reply(false, { error: /not a git repository|ENOENT/i.test(msg) ? 'No git history available.' : 'Could not read git history for this file.' });
    }
  }

  private async openInstructionFile(relPath: string): Promise<void> {
    const resolved = this.resolveInstructionPath(relPath);
    if (!resolved) {
      await this.panel.webview.postMessage({ type: 'instructionsActionDone', ok: false, error: 'Invalid instruction path.' });
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
      await this.panel.webview.postMessage({ type: 'instructionsActionDone', ok: false, error: err instanceof Error ? err.message : 'Could not open the instruction file.' });
    }
  }

  private async exportInstructions(): Promise<void> {
    const wsRoot = this.workspaceRoot();
    if (!wsRoot) {
      await this.panel.webview.postMessage({ type: 'instructionsActionDone', ok: false, error: 'Open a workspace folder first.' });
      return;
    }
    try {
      const raw = runEngineRaw(['--instructions-overview', '--workspace-root', wsRoot]);
      const overview = JSON.parse(raw) as { sources: Array<{ relPath: string; label: string; exists: boolean }> };
      const files = overview.sources
        .filter((src) => src.exists)
        .map((src) => {
          const abs = path.resolve(wsRoot, src.relPath);
          return fs.existsSync(abs) ? { relPath: src.relPath, label: src.label, content: fs.readFileSync(abs, 'utf8') } : null;
        })
        .filter(Boolean);
      const target = await vscode.window.showSaveDialog({
        title: 'Export instruction sources',
        defaultUri: vscode.Uri.file(path.join(wsRoot, 'instructions-bundle.json')),
        filters: { JSON: ['json'] },
      });
      if (!target) {
        await this.panel.webview.postMessage({ type: 'instructionsActionDone', ok: false, error: 'Export cancelled.' });
        return;
      }
      fs.writeFileSync(target.fsPath, JSON.stringify({ kind: 'prompt-optimizer.instructions-bundle', version: 1, exportedAt: new Date().toISOString(), files }, null, 2), 'utf8');
      await this.panel.webview.postMessage({ type: 'instructionsActionDone', ok: true, message: `Exported ${files.length} instruction file${files.length === 1 ? '' : 's'}.` });
    } catch (err) {
      await this.panel.webview.postMessage({ type: 'instructionsActionDone', ok: false, error: err instanceof Error ? err.message : 'Export failed.' });
    }
  }

  private async importInstructions(): Promise<void> {
    const wsRoot = this.workspaceRoot();
    if (!wsRoot) {
      await this.panel.webview.postMessage({ type: 'instructionsActionDone', ok: false, error: 'Open a workspace folder first.' });
      return;
    }
    try {
      const picked = await vscode.window.showOpenDialog({ title: 'Import instruction bundle', canSelectMany: false, filters: { JSON: ['json'] } });
      if (!picked || picked.length === 0) {
        await this.panel.webview.postMessage({ type: 'instructionsActionDone', ok: false, error: 'Import cancelled.' });
        return;
      }
      const bundle = JSON.parse(fs.readFileSync(picked[0].fsPath, 'utf8')) as { kind?: string; files?: Array<{ relPath?: string; content?: string }> };
      if (bundle.kind !== 'prompt-optimizer.instructions-bundle' || !Array.isArray(bundle.files)) {
        await this.panel.webview.postMessage({ type: 'instructionsActionDone', ok: false, error: 'Not a valid instructions bundle file.' });
        return;
      }
      const confirm = await vscode.window.showWarningMessage(
        `Import ${bundle.files.length} instruction file(s)? Existing files with the same path will be overwritten (copilot-instructions files are appended).`,
        { modal: true },
        'Import',
      );
      if (confirm !== 'Import') {
        await this.panel.webview.postMessage({ type: 'instructionsActionDone', ok: false, error: 'Import cancelled.' });
        return;
      }
      const shouldAppend = (relPath: string): boolean => ['.github/copilot-instructions.md', '.copilot-instructions.md', 'copilot-instructions.md'].includes(relPath.replace(/\\/g, '/').toLowerCase());
      let written = 0;
      for (const file of bundle.files) {
        const rel = typeof file.relPath === 'string' ? file.relPath.replace(/\\/g, '/') : '';
        const content = typeof file.content === 'string' ? file.content : '';
        if (!rel || rel.includes('..') || path.isAbsolute(rel)) { continue; }
        const abs = path.resolve(wsRoot, rel);
        const containment = path.relative(wsRoot, abs);
        if (containment.startsWith('..') || path.isAbsolute(containment)) { continue; }
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        if (shouldAppend(rel) && fs.existsSync(abs)) {
          const existing = fs.readFileSync(abs, 'utf8').replace(/\s+$/g, '');
          const incoming = content.trim();
          const eol = existing.includes('\r\n') ? '\r\n' : '\n';
          fs.writeFileSync(abs, existing.includes(incoming) ? existing + eol : [existing, '', '<!-- prompt-optimizer:import:append -->', incoming, ''].join(eol), 'utf8');
        } else {
          fs.writeFileSync(abs, content, 'utf8');
        }
        written += 1;
      }
      await this.panel.webview.postMessage({ type: 'instructionsActionDone', ok: true, message: `Imported ${written} instruction file${written === 1 ? '' : 's'}.` });
      await this.postInstructionsOverview();
    } catch (err) {
      await this.panel.webview.postMessage({ type: 'instructionsActionDone', ok: false, error: err instanceof Error ? err.message : 'Import failed.' });
    }
  }

  private async toggleInstructionRule(data: { relPath?: string; line?: number; ruleText?: string; enabled?: boolean }): Promise<void> {
    const relPath = data.relPath;
    const ruleText = String(data.ruleText || '').trim();
    const targetEnabled = data.enabled === true;
    if (!relPath || !ruleText || ruleText.includes('-->')) {
      await this.panel.webview.postMessage({ type: 'instructionsActionDone', ok: false, error: 'Missing or invalid rule details.' });
      return;
    }
    const resolved = this.resolveInstructionPath(relPath);
    if (!resolved) {
      await this.panel.webview.postMessage({ type: 'instructionsActionDone', ok: false, error: 'Invalid instruction path.' });
      return;
    }
    try {
      if (!fs.existsSync(resolved.abs)) {
        const normalized = relPath.replace(/\\/g, '/');
        const isSkillTarget = /^\.promptoptimizer\/skills\/[A-Za-z0-9._-]+\.md$/i.test(normalized);
        if (isSkillTarget) {
          const libDir = path.join(this.context.extensionUri.fsPath, 'media', 'skill-library');
          const fileName = path.basename(normalized);
          const srcPath = path.join(libDir, fileName);
          const srcRel = path.relative(libDir, srcPath);
          if (!srcRel.startsWith('..') && !path.isAbsolute(srcRel) && fs.existsSync(srcPath)) {
            fs.mkdirSync(path.dirname(resolved.abs), { recursive: true });
            fs.copyFileSync(srcPath, resolved.abs);
          }
        }
      }
      const original = fs.readFileSync(resolved.abs, 'utf8');
      const eol = original.includes('\r\n') ? '\r\n' : '\n';
      const lines = original.split(/\r?\n/);
      const offRe = /^(\s*)<!--\s*po-off:\s?([\s\S]*?)\s*-->\s*$/;
      const stripped = (s: string): string => s.replace(/^\s*<!--\s*po-off:\s?/, '').replace(/\s*-->\s*$/, '').replace(/^>\s?/, '').replace(/^[-*+]\s+/, '').replace(/^\d+[.)]\s+/, '').replace(/^\[[ xX]\]\s+/, '').trim();
      let idx = (typeof data.line === 'number' ? data.line : 0) - 1;
      if (idx < 0 || idx >= lines.length || stripped(lines[idx]) !== ruleText) {
        const matches: number[] = [];
        for (let i = 0; i < lines.length; i += 1) {
          if (stripped(lines[i]) === ruleText) { matches.push(i); }
        }
        if (matches.length !== 1) {
          await this.panel.webview.postMessage({ type: 'instructionsActionDone', ok: false, error: 'Could not locate that rule in the file.' });
          return;
        }
        idx = matches[0];
      }
      let managed = false;
      for (let i = 0; i <= idx; i += 1) {
        const t = lines[i].trim();
        if (t.includes('prompt-optimizer:memory:begin')) { managed = true; }
        else if (t.includes('prompt-optimizer:memory:end')) { managed = false; }
      }
      if (managed) {
        await this.panel.webview.postMessage({ type: 'instructionsActionDone', ok: false, error: 'This rule is in an auto-managed block and cannot be toggled.' });
        return;
      }
      const line = lines[idx];
      const isOff = offRe.test(line);
      if (targetEnabled) {
        if (isOff) {
          const match = offRe.exec(line);
          if (match) { lines[idx] = match[1] + match[2]; }
        }
      } else if (!isOff) {
        const indent = (/^(\s*)/.exec(line) || ['',''])[1];
        lines[idx] = `${indent}<!-- po-off: ${line.slice(indent.length)} -->`;
      }
      fs.writeFileSync(resolved.abs, lines.join(eol), 'utf8');
      await this.panel.webview.postMessage({ type: 'instructionsActionDone', ok: true, message: targetEnabled ? 'Rule enabled.' : 'Rule disabled.' });
      await this.postInstructionsOverview();
    } catch (err) {
      await this.panel.webview.postMessage({ type: 'instructionsActionDone', ok: false, error: err instanceof Error ? err.message : 'Could not update the rule.' });
    }
  }

  private async togglePersona(data: { personaId?: string; sourceFile?: string; enabled?: boolean }): Promise<void> {
    const wsRoot = this.workspaceRoot();
    const personaId = data.personaId;
    if (!wsRoot || !personaId || !/^[a-z0-9][a-z0-9-]*$/.test(personaId)) {
      await this.panel.webview.postMessage({ type: 'instructionsActionDone', ok: false, error: 'Invalid persona details.' });
      return;
    }
    const targetDir = path.join(wsRoot, '.promptoptimizer', 'skills');
    const targetPath = path.join(targetDir, `${personaId}.md`);
    try {
      if (data.enabled === true) {
        const sourceFile = data.sourceFile;
        if (!sourceFile || !/^[A-Za-z0-9._-]+\.md$/.test(sourceFile)) {
          await this.panel.webview.postMessage({ type: 'instructionsActionDone', ok: false, error: 'Invalid persona source file.' });
          return;
        }
        const libDir = path.join(this.context.extensionUri.fsPath, 'media', 'skill-library');
        const srcPath = path.join(libDir, sourceFile);
        const srcRel = path.relative(libDir, srcPath);
        if (srcRel.startsWith('..') || path.isAbsolute(srcRel) || !fs.existsSync(srcPath)) {
          await this.panel.webview.postMessage({ type: 'instructionsActionDone', ok: false, error: 'Bundled persona not found.' });
          return;
        }
        fs.mkdirSync(targetDir, { recursive: true });
        fs.copyFileSync(srcPath, targetPath);
        await this.panel.webview.postMessage({ type: 'instructionsActionDone', ok: true, message: 'Persona enabled.' });
      } else {
        if (fs.existsSync(targetPath)) { fs.rmSync(targetPath); }
        await this.panel.webview.postMessage({ type: 'instructionsActionDone', ok: true, message: 'Persona disabled.' });
      }
      await this.postInstructionsOverview();
    } catch (err) {
      await this.panel.webview.postMessage({ type: 'instructionsActionDone', ok: false, error: err instanceof Error ? err.message : 'Could not update the persona.' });
    }
  }

  private async postTraceRows(): Promise<void> {
    const wsRoot = this.workspaceRoot();
    if (!wsRoot) {
      await this.panel.webview.postMessage({ type: 'traceRows', rows: [] });
      return;
    }
    try {
      const raw = runEngineRaw([
        '--instruction-studio-trace-list',
        '--workspace-root',
        wsRoot,
        '--limit',
        '20',
      ]);
      const payload = JSON.parse(raw) as { rows?: unknown[] };
      await this.panel.webview.postMessage({ type: 'traceRows', rows: payload.rows ?? [] });
      await this.postTraceAnalytics();
    } catch {
      await this.panel.webview.postMessage({ type: 'traceRows', rows: [] });
      await this.panel.webview.postMessage({ type: 'traceAnalytics', analytics: null });
    }
  }

  private async postTraceAnalytics(): Promise<void> {
    const wsRoot = this.workspaceRoot();
    if (!wsRoot) {
      await this.panel.webview.postMessage({ type: 'traceAnalytics', analytics: null });
      return;
    }
    try {
      const raw = runEngineRaw([
        '--instruction-studio-trace-analytics',
        '--workspace-root',
        wsRoot,
      ]);
      const payload = JSON.parse(raw) as { analytics?: unknown };
      await this.panel.webview.postMessage({ type: 'traceAnalytics', analytics: payload.analytics ?? null });
    } catch {
      await this.panel.webview.postMessage({ type: 'traceAnalytics', analytics: null });
    }
  }

  private async saveCustomPersona(persona: unknown): Promise<void> {
    const wsRoot = this.workspaceRoot();
    if (!wsRoot) {
      vscode.window.showWarningMessage('Open a workspace folder first.');
      return;
    }
    try {
      runEngineRaw(
        ['--instruction-studio-persona-save', '--workspace-root', wsRoot],
        JSON.stringify(persona ?? {}),
      );
      await this.postCustomPersonas();
      await this.postPresets();
      await this.postTraceRows();
      await this.postInsights();
      vscode.window.showInformationMessage('Custom Instruction Studio persona saved.');
    } catch (error) {
      vscode.window.showErrorMessage(
        `Could not save custom persona: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async deleteCustomPersona(id?: string): Promise<void> {
    const wsRoot = this.workspaceRoot();
    if (!wsRoot) {
      vscode.window.showWarningMessage('Open a workspace folder first.');
      return;
    }
    if (!id || !id.trim()) {
      vscode.window.showWarningMessage('Select a custom persona first.');
      return;
    }
    try {
      runEngineRaw([
        '--instruction-studio-persona-delete',
        '--workspace-root',
        wsRoot,
        '--id',
        id.trim(),
      ]);
      await this.postCustomPersonas();
      await this.postPresets();
      await this.postTraceRows();
      await this.postInsights();
      vscode.window.showInformationMessage('Custom Instruction Studio persona deleted.');
    } catch (error) {
      vscode.window.showErrorMessage(
        `Could not delete custom persona: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async createStarterScaffold(graphFromWebview?: unknown): Promise<void> {
    const wsRoot = this.workspaceRoot();
    if (!wsRoot) {
      vscode.window.showWarningMessage('Open a workspace folder first.');
      return;
    }

    const fallbackGraph = {
      workflowName: 'Copilot Instructions Starter',
      nodes: [
        { id: 'persona-architect', type: 'persona', label: 'SDLC Architect' },
        { id: 'condition-code', type: 'condition', label: 'If writing code' },
        { id: 'priority-critical', type: 'priority', label: 'Critical' },
        { id: 'scope-generation', type: 'agentScope', label: 'Code Generation' },
        { id: 'rule-architect', type: 'rule', text: 'Read .promptoptimizer/skills/sdlc-architect.md. Follow everything written there. Do not write any code until you have read and understood the entire file.' },
      ],
      edges: [
        { from: 'persona-architect', to: 'condition-code' },
        { from: 'condition-code', to: 'priority-critical' },
        { from: 'priority-critical', to: 'scope-generation' },
        { from: 'scope-generation', to: 'rule-architect' },
      ],
    };
    const graph = graphFromWebview ?? fallbackGraph;

    try {
      const conflictRaw = runEngineRaw(['--instruction-studio-conflicts'], JSON.stringify(graph));
      const conflictPayload = JSON.parse(conflictRaw) as { conflicts?: InstructionStudioConflict[] };
      const conflicts = conflictPayload.conflicts ?? [];
      await this.panel.webview.postMessage({ type: 'conflicts', conflicts });
      if (conflicts.some((c) => c.severity === 'error')) {
        vscode.window.showWarningMessage('Instruction Studio compile blocked due to error-level conflicts.');
        return;
      }

      const raw = runEngineRaw(
        ['--instruction-studio-compile', '--workspace-root', wsRoot],
        JSON.stringify(graph),
      );
      const result = JSON.parse(raw) as {
        ok: boolean;
        versionIndex: number;
        files: { instructions: string };
      };
      if (!result.ok) {
        throw new Error('Engine CLI returned a failed studio compile result.');
      }
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(result.files.instructions));
      await vscode.window.showTextDocument(doc, { preview: false });
      await this.postTraceRows();
      await this.postInsights();
      await this.postReplay();
      vscode.window.showInformationMessage(
        `Instruction Studio scaffold saved to ${STUDIO_DIR}/ (history v${result.versionIndex}).`,
      );
    } catch (error) {
      vscode.window.showErrorMessage(
        `Instruction Studio scaffold failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async postInsights(): Promise<void> {
    const wsRoot = this.workspaceRoot();
    if (!wsRoot) {
      await this.panel.webview.postMessage({ type: 'insights', insights: null });
      return;
    }
    try {
      const raw = runEngineRaw(['--instruction-studio-insights', '--workspace-root', wsRoot]);
      const payload = JSON.parse(raw) as { insights?: unknown };
      await this.panel.webview.postMessage({ type: 'insights', insights: payload.insights ?? null });
    } catch {
      await this.panel.webview.postMessage({ type: 'insights', insights: null });
    }
  }

  private async postReplay(sessionId?: string): Promise<void> {
    const wsRoot = this.workspaceRoot();
    if (!wsRoot) {
      await this.panel.webview.postMessage({ type: 'replay', sessions: [], activeSessionId: null });
      return;
    }
    try {
      const args = ['--instruction-studio-replay', '--workspace-root', wsRoot];
      if (sessionId) {
        args.push('--session-id', sessionId);
      }
      const raw = runEngineRaw(args);
      const payload = JSON.parse(raw) as { sessions?: InstructionStudioReplaySession[]; activeSessionId?: string | null };
      await this.panel.webview.postMessage({
        type: 'replay',
        sessions: payload.sessions ?? [],
        activeSessionId: payload.activeSessionId ?? null,
      });
    } catch {
      await this.panel.webview.postMessage({ type: 'replay', sessions: [], activeSessionId: null });
    }
  }

  private async refineRule(mode?: string, text?: string): Promise<void> {
    const original = String(text || '').trim();
    if (!original) {
      await this.panel.webview.postMessage({
        type: 'aiSuggestion',
        suggestion: null,
        error: 'Select a rule and provide text before refinement.',
      });
      return;
    }

    const normalized = original.replace(/\s+/g, ' ').trim();
    let proposed = normalized;
    const op = String(mode || 'improve').trim();
    if (op === 'simplify') {
      proposed = normalized
        .replace(/\bexplicitly\b|\bcarefully\b|\bthoroughly\b/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (!/[.!?]$/.test(proposed)) { proposed += '.'; }
    } else if (op === 'expand') {
      proposed = `${normalized} Include assumptions, risks, and concrete verification steps before completion.`;
    } else if (op === 'find-conflicts') {
      proposed = `${normalized} Potential conflict check: compare against rules forbidding edits in the same domain.`;
    } else if (op === 'find-duplicates') {
      proposed = `${normalized} Duplicate check key: ${normalized.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()}`;
    } else {
      const sentence = normalized.charAt(0).toLowerCase() + normalized.slice(1);
      proposed = `Ensure ${sentence}`;
      if (!/[.!?]$/.test(proposed)) { proposed += '.'; }
    }

    await this.panel.webview.postMessage({
      type: 'aiSuggestion',
      suggestion: {
        mode: op,
        original,
        proposed,
      },
    });
  }

  private async generatePersonaSuggestion(): Promise<void> {
    const wsRoot = this.workspaceRoot();
    if (!wsRoot) {
      await this.panel.webview.postMessage({ type: 'personaSuggestion', suggestion: null });
      return;
    }
    const files: string[] = [];
    const scan = (dir: string, depth: number): void => {
      if (depth > 3) { return; }
      let entries: fs.Dirent[] = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) { continue; }
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          scan(abs, depth + 1);
        } else if (/\.(ts|tsx|js|jsx|py|java|kt|md)$/i.test(entry.name)) {
          files.push(path.relative(wsRoot, abs).replace(/\\/g, '/'));
        }
      }
    };
    scan(wsRoot, 0);

    const corpus = files.join(' ').toLowerCase();
    const label = /security|auth|token|credential/.test(corpus)
      ? 'Security Reviewer'
      : /test|spec|assert/.test(corpus)
        ? 'Testing Strategist'
        : 'Architecture Reviewer';
    const ruleText = label === 'Security Reviewer'
      ? 'Validate user inputs and summarize security risks before completion.'
      : label === 'Testing Strategist'
        ? 'Require tests for behavior changes and call out missing coverage explicitly.'
        : 'Preserve architecture consistency and highlight coupling risks before completion.';

    await this.panel.webview.postMessage({
      type: 'personaSuggestion',
      suggestion: {
        label,
        persona: label,
        condition: 'Always',
        priority: 'High',
        agentScope: 'Review',
        ruleText,
      },
    });
  }

  private writeTraceSummary(workspaceRoot: string): string {
    const summaryPath = path.join(workspaceRoot, AGENT_DIR, 'trace-summary.md');
    const execPath = path.join(workspaceRoot, AGENT_DIR, 'execution-log.json');
    const lineagePath = path.join(workspaceRoot, AGENT_DIR, 'lineage.json');
    const execution = fs.existsSync(execPath)
      ? (JSON.parse(fs.readFileSync(execPath, 'utf8')) as Array<Record<string, unknown>>)
      : [];
    const lineage = fs.existsSync(lineagePath)
      ? (JSON.parse(fs.readFileSync(lineagePath, 'utf8')) as Array<Record<string, unknown>>)
      : [];
    const last = execution[execution.length - 1] ?? {};
    const lines = lineage.slice(-5).map((row) => `- ${(row.modifiedBy as string) || 'Persona'} -> ${(row.file as string) || 'file'} :: ${(row.rule as string) || ''}`);
    const body = [
      '# Instruction Studio Trace Summary',
      '',
      `Workflow: ${String(last.workflowName || 'n/a')}`,
      `Version: v${String(last.versionIndex || 'n/a')}`,
      `Timestamp: ${String(last.timestamp || 'n/a')}`,
      `Rules: ${String(last.activeRuleCount || 0)} active / ${String(last.inactiveRuleCount || 0)} disabled`,
      '',
      '## Recent lineage',
      ...(lines.length > 0 ? lines : ['- n/a']),
      '',
    ].join('\n');
    fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
    fs.writeFileSync(summaryPath, body, 'utf8');
    return summaryPath;
  }

  private async stageTrace(traceMode?: string): Promise<void> {
    const wsRoot = this.workspaceRoot();
    if (!wsRoot) {
      await this.panel.webview.postMessage({ type: 'gitTraceResult', ok: false, message: 'Open a workspace folder first.' });
      return;
    }
    const mode = String(traceMode || 'exclude').trim();
    try {
      if (mode === 'full') {
        const files = [
          path.join(AGENT_DIR, 'execution-log.json'),
          path.join(AGENT_DIR, 'lineage.json'),
          path.join(AGENT_DIR, 'rule-usage.json'),
        ];
        spawnSync('git', ['add', ...files], { cwd: wsRoot, encoding: 'utf8' });
        await this.panel.webview.postMessage({ type: 'gitTraceResult', ok: true, message: 'Staged full trace artifacts.' });
        return;
      }
      if (mode === 'summary') {
        const summaryPath = this.writeTraceSummary(wsRoot);
        spawnSync('git', ['add', path.relative(wsRoot, summaryPath).replace(/\\/g, '/')], { cwd: wsRoot, encoding: 'utf8' });
        await this.panel.webview.postMessage({ type: 'gitTraceResult', ok: true, message: 'Staged trace summary.' });
        return;
      }
      await this.panel.webview.postMessage({ type: 'gitTraceResult', ok: true, message: 'Trace staging skipped (exclude).' });
    } catch (err) {
      await this.panel.webview.postMessage({
        type: 'gitTraceResult',
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
