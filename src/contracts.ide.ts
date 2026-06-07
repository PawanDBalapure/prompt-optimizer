/** IDE context input shapes shared between the engine and its adapters. */

export interface IdeContextFile {
  path: string;
  content: string;
  language?: string;
  is_active?: boolean;
  selection?: string;
}

export interface IdeContextLog {
  source: string;
  content: string;
  kind?: 'terminal' | 'debug' | 'problems' | 'general';
}

export interface PromptIDEContext {
  workspace_root?: string;
  active_file?: IdeContextFile;
  open_files?: IdeContextFile[];
  logs?: IdeContextLog[];
}
