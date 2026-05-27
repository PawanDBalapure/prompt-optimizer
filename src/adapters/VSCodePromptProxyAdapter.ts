import {
  IdeContextFile,
  IdeContextLog,
  ProcessingMode,
  PromptOptimizationResponse,
  PromptPricingConfig,
  PromptProxyEngineOptions,
} from '../contracts.js';
import { PromptProxyEngine } from '../PromptProxyEngine.js';

export interface VSCodeEditorSnapshot {
  path: string;
  content: string;
  language_id?: string;
  selection?: string;
  is_active?: boolean;
}

export interface VSCodePromptProxyInput {
  raw_prompt: string;
  mode?: ProcessingMode;
  workspace_root?: string;
  active_editor?: VSCodeEditorSnapshot;
  visible_editors?: VSCodeEditorSnapshot[];
  terminal_output?: string[];
  problems?: string[];
  pricing?: PromptPricingConfig;
}

export class VSCodePromptProxyAdapter {
  constructor(private readonly engine: PromptProxyEngine = new PromptProxyEngine()) {}

  public static createEngine(options?: string | PromptProxyEngineOptions): PromptProxyEngine {
    return new PromptProxyEngine(options);
  }

  public async initialize(): Promise<void> {
    await this.engine.initialize();
  }

  public async process(input: VSCodePromptProxyInput): Promise<PromptOptimizationResponse> {
    const activeFile = input.active_editor ? this.mapEditor(input.active_editor) : undefined;
    const openFiles = (input.visible_editors ?? []).map((editor) => this.mapEditor(editor));
    const logs: IdeContextLog[] = [];

    if ((input.terminal_output ?? []).length > 0) {
      logs.push({
        source: 'Terminal',
        kind: 'terminal',
        content: input.terminal_output!.join('\n'),
      });
    }

    if ((input.problems ?? []).length > 0) {
      logs.push({
        source: 'Problems',
        kind: 'problems',
        content: input.problems!.join('\n'),
      });
    }

    return this.engine.processRequest({
      raw_prompt: input.raw_prompt,
      mode: input.mode,
      pricing: input.pricing,
      ide_context: {
        workspace_root: input.workspace_root,
        active_file: activeFile,
        open_files: openFiles,
        logs,
      },
    });
  }

  public close(): void {
    this.engine.close();
  }

  private mapEditor(editor: VSCodeEditorSnapshot): IdeContextFile {
    return {
      path: editor.path,
      content: editor.content,
      language: editor.language_id,
      selection: editor.selection,
      is_active: editor.is_active,
    };
  }
}