import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Opt-in collector for prompt-rewriting training pairs.
 *
 * Pairs are appended to <globalStorage>/training-pairs.jsonl as one
 * JSON object per line. The file never leaves the user's machine — the
 * distillation pipeline (scripts/distill) consumes it offline.
 */
export interface PromptPair {
  readonly input: string;
  readonly output: string;
  readonly model?: string;
  readonly source?: string;
  readonly ts: number;
}

const SETTING_KEY = 'promptProxy.collectTrainingData';
const FILE_NAME = 'training-pairs.jsonl';
const MAX_FIELD_CHARS = 8000;

export class DatasetCollector {
  private readonly file: string;

  constructor(ctx: vscode.ExtensionContext) {
    this.file = path.join(ctx.globalStorageUri.fsPath, FILE_NAME);
  }

  /** Resolved path of the JSONL log file. */
  getFilePath(): string {
    return this.file;
  }

  /** True when the user has explicitly opted in via settings. */
  isEnabled(): boolean {
    return vscode.workspace.getConfiguration().get<boolean>(SETTING_KEY, false);
  }

  /**
   * Append one prompt → optimized pair. No-ops when collection is disabled
   * or when either side is empty / oversized.
   */
  async record(pair: Omit<PromptPair, 'ts'>): Promise<void> {
    if (!this.isEnabled()) { return; }

    const input = (pair.input ?? '').trim();
    const output = (pair.output ?? '').trim();
    if (input === '' || output === '') { return; }
    if (input.length > MAX_FIELD_CHARS || output.length > MAX_FIELD_CHARS) { return; }
    if (input === output) { return; }

    const row: PromptPair = {
      input,
      output,
      model: pair.model,
      source: pair.source,
      ts: Date.now(),
    };

    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.appendFile(this.file, JSON.stringify(row) + '\n', 'utf8');
  }
}
