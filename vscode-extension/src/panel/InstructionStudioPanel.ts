import * as vscode from 'vscode';

import { handleInstructionsMessage } from '../instructions/messageRouter';
import { renderWebviewHtml } from '../webview/loader';
import { parseCopilotInstructionsCanvas } from './canvasGraphParser';
import { postPersonaSuggestion, postRuleRefinement } from './studio/ai';
import {
  deleteCustomPersona,
  popularRepoPresets,
  postCustomPersonas,
  postPresets,
  saveCustomPersona,
} from './studio/personas';
import { compileStudioGraph, postInsights, postReplay } from './studio/scaffold';
import { postTraceRows, stageTrace } from './studio/trace';
import { workspaceRoot } from '../instructions/paths';

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
      async (raw: unknown) => { await this.handleMessage(raw as StudioMessage); },
      null,
      this.disposables,
    );
    this.panel.onDidDispose(() => {
      InstructionStudioPanel.current = undefined;
      while (this.disposables.length > 0) { this.disposables.pop()?.dispose(); }
    });
  }

  static show(context: vscode.ExtensionContext): void {
    if (InstructionStudioPanel.current) {
      const existing = InstructionStudioPanel.current;
      existing.panel.webview.html = renderWebviewHtml(existing.panel.webview, context.extensionUri, {
        name: 'instruction-studio',
      });
      existing.panel.reveal(vscode.ViewColumn.Beside);
      return;
    }
    InstructionStudioPanel.current = new InstructionStudioPanel(context);
  }

  private get webview(): vscode.Webview { return this.panel.webview; }

  private async refreshCompileViews(): Promise<void> {
    await postTraceRows(this.webview);
    await postInsights(this.webview);
    await postReplay(this.webview);
  }

  private async handleMessage(msg: StudioMessage): Promise<void> {
    if (await handleInstructionsMessage(this.webview, this.context.extensionUri.fsPath, msg)) { return; }

    switch (msg.type) {
      case 'ready':
        await postPresets(this.webview);
        await postCustomPersonas(this.webview);
        await this.refreshCompileViews();
        this.postCanvas();
        return;
      case 'loadCopilotInstructions': this.postCanvas(); return;
      case 'openMemoryFile': await vscode.commands.executeCommand('prompt-proxy.openMemoryFile'); return;
      case 'openSkillManager': await vscode.commands.executeCommand('prompt-proxy.manageAgentSkills'); return;
      case 'openPanel': await vscode.commands.executeCommand('prompt-proxy.focusPanel'); return;
      case 'createStarterScaffold':
      case 'compileFormGraph':
        if (await compileStudioGraph(this.webview, msg.graph)) { await this.refreshCompileViews(); }
        return;
      case 'saveCustomPersona': await this.savePersona(msg.persona); return;
      case 'deleteCustomPersona': await this.deletePersona(msg.id); return;
      case 'aiRefineRule': await postRuleRefinement(this.webview, msg.mode, msg.text); return;
      case 'aiGeneratePersona': await postPersonaSuggestion(this.webview); return;
      case 'refreshInsights': await postInsights(this.webview); return;
      case 'loadReplay': await postReplay(this.webview, msg.sessionId); return;
      case 'stageTrace': await stageTrace(this.webview, msg.traceMode); return;
      case 'ribbonAction':
        vscode.window.showInformationMessage(`Instruction Studio: ${msg.action} requested.`);
        return;
      case 'fetchRulesFromUrl':
        vscode.window.showInformationMessage(`Instruction Studio: Simulating fetch from ${msg.graph || msg.id || 'URL'}...`);
        setTimeout(() => {
          void this.webview.postMessage({
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
              agentScope: 'Review',
            }],
          });
        }, 800);
        return;
      case 'loadPopularRepo': {
        const presets = popularRepoPresets(msg.repo ?? '');
        if (presets.length > 0) {
          vscode.window.showInformationMessage(`Loaded presets for: ${msg.repo}`);
          await this.webview.postMessage({ type: 'presets', append: true, presets });
        }
        return;
      }
      default:
        return;
    }
  }

  /** Parse copilot-instructions into canvas nodes/edges and post the graph. */
  private postCanvas(): void {
    const result = parseCopilotInstructionsCanvas(workspaceRoot());
    void this.webview.postMessage({
      type: 'canvasGraph',
      nodes: result.nodes,
      edges: result.edges,
      notice: result.notice,
    });
  }

  private async savePersona(persona: unknown): Promise<void> {
    try {
      saveCustomPersona(persona);
      await postCustomPersonas(this.webview);
      await postPresets(this.webview);
      await this.refreshCompileViews();
      vscode.window.showInformationMessage('Custom Instruction Studio persona saved.');
    } catch (error) {
      vscode.window.showErrorMessage(
        `Could not save custom persona: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async deletePersona(id?: string): Promise<void> {
    if (!id || !id.trim()) {
      vscode.window.showWarningMessage('Select a custom persona first.');
      return;
    }
    try {
      deleteCustomPersona(id);
      await postCustomPersonas(this.webview);
      await postPresets(this.webview);
      await this.refreshCompileViews();
      vscode.window.showInformationMessage('Custom Instruction Studio persona deleted.');
    } catch (error) {
      vscode.window.showErrorMessage(
        `Could not delete custom persona: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
