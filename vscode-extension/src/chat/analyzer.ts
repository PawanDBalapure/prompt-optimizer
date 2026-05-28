import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { scanForSecrets } from '../security/secret-patterns';
import { getDbPath, getPricingConfig, getProcessingMode, getTargetModel } from '../state/config';
import { getLastAnalysis, addToSessionBuffer, getSessionBuffer } from '../state/session';
import { runEngine } from '../engine/runner';
import { getIdeContext } from '../engine/context';
import { computeWorkspaceId } from '../util/workspace';
import type {
  PromptProxyPanelState,
  PromptSource,
  RuntimeSnapshot,
} from '../types';

export interface AnalyzedPromptListener {
  onAnalyzed?: (state: PromptProxyPanelState) => void;
}

const STRIP_DIAGNOSTICS_RE = /(?:^|\n\n)# Problems\n[\s\S]*?(?=\n\n#|\s*$)/g;
const STRIP_PROMPT_BLOCK_RE = /(?:^|\n\n)# Prompt (?:Proxy|Optimizer)[^\n]*\n[\s\S]*?(?=\n\n#|\s*$)/gi;
// Defensive sweeper: a cached row may still contain the legacy session-buffer
// or chat-history sections that older builds wrote into the optimized prompt.
// Both formats start with a deterministic header we can match.
const STRIP_LEGACY_HISTORY_RE = /(?:^|\n\n)# (?:Prompt Optimizer Session Buffer|Prompt Optimizer Chat History|Knowledge graph \u2014|Peer workspace \()[\s\S]*?(?=\n\n#|\s*$)/gi;

export async function analyzePrompt(
  context: vscode.ExtensionContext,
  rawPrompt: string,
  source: PromptSource,
  chatContext?: vscode.ChatContext,
  observer?: AnalyzedPromptListener,
): Promise<PromptProxyPanelState> {
  // Secret detection — warn in UI (non-blocking).
  const secretDetectionEnabled =
    vscode.workspace.getConfiguration('promptProxy')
      .get<boolean>('enableSecretDetection') !== false;
  const secrets = scanForSecrets(rawPrompt);
  if (secrets.length > 0) {
    void vscode.window.showWarningMessage(
      `Prompt Optimizer detected possible secrets: ${secrets.map((s) => s.label).join(', ')}. Review before sending to any AI service.`,
    );
  }

  const dbPath = getDbPath(context);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const request = {
    raw_prompt: rawPrompt,
    mode: getProcessingMode(),
    pricing: getPricingConfig(),
    ide_context: getIdeContext(context, chatContext),
    workspace_id: computeWorkspaceId(workspaceRoot),
    target_model: getTargetModel(context),
  };

  const response = runEngine(request, dbPath);

  // Belt-and-suspenders: strip diagnostics/prompt-optimizer blocks that may
  // have leaked back into the optimized prompt via a stale cache row.
  const optimizedClean = response.optimized_prompt
    .replace(STRIP_DIAGNOSTICS_RE, '')
    .replace(STRIP_PROMPT_BLOCK_RE, '')
    .replace(STRIP_LEGACY_HISTORY_RE, '')
    .trim();

  const state: PromptProxyPanelState = {
    original: rawPrompt,
    optimized: optimizedClean,
    source,
    generated_at: Date.now(),
    metrics: response.metrics,
    improvements: response.improvements,
    analysis: response.analysis,
    warnings: secrets.map((s) =>
      `Possible secret detected: ${s.label}${s.matched ? ` \u2014 matched text: "${s.matched}"` : ''}. Review before sending.`,
    ),
    diagnostics: response.diagnostics,
    secretDetectionEnabled,
    secretMatches: secrets
      .filter((s) => s.matched !== undefined)
      .map((s) => ({ label: s.label, matched: s.matched as string })),
  };

  await addToSessionBuffer(context, state);
  observer?.onAnalyzed?.(state);
  return state;
}

export function buildRuntimeSnapshot(
  context: vscode.ExtensionContext,
  chatContext?: vscode.ChatContext,
): RuntimeSnapshot {
  const ideContext = getIdeContext(context, chatContext);
  return {
    active_file: ideContext.active_file?.path,
    open_file_count: ideContext.active_file
      ? ideContext.open_files.length + 1
      : ideContext.open_files.length,
    log_sources: ideContext.logs.map((log) => log.source),
    chat_history_turns: chatContext?.history.length ?? 0,
    session_buffer: getSessionBuffer(context),
    last_analysis: getLastAnalysis(context),
  };
}
