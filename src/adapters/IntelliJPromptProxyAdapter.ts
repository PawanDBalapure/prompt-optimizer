import {
  IdeContextFile,
  IdeContextLog,
  ProcessingMode,
  PromptOptimizationResponse,
  PromptPricingConfig,
  PromptProxyEngineOptions,
} from '../contracts.js';
import { PromptProxyEngine } from '../PromptProxyEngine.js';

export interface IntelliJEditorSnapshot {
  path: string;
  content: string;
  language?: string;
  selection?: string;
  is_active?: boolean;
}

export interface IntelliJPromptProxyInput {
  raw_prompt: string;
  mode?: ProcessingMode;
  project_root?: string;
  active_editor?: IntelliJEditorSnapshot;
  open_editors?: IntelliJEditorSnapshot[];
  run_console?: string[];
  inspection_messages?: string[];
  pricing?: PromptPricingConfig;
}

export class IntelliJPromptProxyAdapter {
  constructor(private readonly engine: PromptProxyEngine = new PromptProxyEngine()) {}

  public static createEngine(options?: string | PromptProxyEngineOptions): PromptProxyEngine {
    return new PromptProxyEngine(options);
  }

  public async initialize(): Promise<void> {
    await this.engine.initialize();
  }

  public async process(input: IntelliJPromptProxyInput): Promise<PromptOptimizationResponse> {
    const activeFile = input.active_editor ? this.mapEditor(input.active_editor) : undefined;
    const openFiles = (input.open_editors ?? []).map((editor) => this.mapEditor(editor));
    const logs: IdeContextLog[] = [];

    if ((input.run_console ?? []).length > 0) {
      logs.push({
        source: 'Run Console',
        kind: 'terminal',
        content: input.run_console!.join('\n'),
      });
    }

    if ((input.inspection_messages ?? []).length > 0) {
      logs.push({
        source: 'Inspections',
        kind: 'problems',
        content: input.inspection_messages!.join('\n'),
      });
    }

    return this.engine.processRequest({
      raw_prompt: input.raw_prompt,
      mode: input.mode,
      pricing: input.pricing,
      ide_context: {
        workspace_root: input.project_root,
        active_file: activeFile,
        open_files: openFiles,
        logs,
      },
    });
  }

  public close(): void {
    this.engine.close();
  }

  private mapEditor(editor: IntelliJEditorSnapshot): IdeContextFile {
    return {
      path: editor.path,
      content: editor.content,
      language: editor.language,
      selection: editor.selection,
      is_active: editor.is_active,
    };
  }
}