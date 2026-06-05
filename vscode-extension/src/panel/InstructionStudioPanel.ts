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
      workflowName: 'Instruction Studio Starter',
      nodes: [
        { id: 'persona-architect', type: 'persona', label: 'Architect' },
        { id: 'condition-refactor', type: 'condition', label: 'If Task=Refactor' },
        { id: 'priority-critical', type: 'priority', label: 'Critical' },
        { id: 'scope-testing', type: 'agentScope', label: 'Testing' },
        { id: 'rule-tests', type: 'rule', text: 'Always run unit tests before completing changes.' },
      ],
      edges: [
        { from: 'persona-architect', to: 'condition-refactor' },
        { from: 'condition-refactor', to: 'priority-critical' },
        { from: 'priority-critical', to: 'scope-testing' },
        { from: 'scope-testing', to: 'rule-tests' },
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
