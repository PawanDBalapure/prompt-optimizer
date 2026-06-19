import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { scanForSecrets } from '../security/secret-patterns';
import { getDbPath, getPricingConfig, getProcessingMode, getTargetModel, getDensity } from '../state/config';
import { getLastAnalysis, addToSessionBuffer, getSessionBuffer } from '../state/session';
import { runEngine } from '../engine/runner';
import { augmentContextWithReferencedFiles, getIdeContext } from '../engine/context';
import { computeWorkspaceId } from '../util/workspace';
import { isLocalModelAvailable, optimizeLocally } from '../local/localOptimizer';
import { refineOptimizedPrompt } from '../local/grammarRefiner';
import type {
  PromptProxyPanelState,
  PromptSource,
  PromptProxyResponse,
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

function isSqliteNativeLoadFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /better_sqlite3\.node/i.test(message)
    && /(not a valid win32 application|NODE_MODULE_VERSION|was compiled against|invalid ELF header|wrong architecture)/i.test(message);
}

function estimateTokens(text: string): number {
  // Stable, dependency-free heuristic used only for degraded fallback metrics.
  return Math.max(1, Math.ceil((text ?? '').length / 4));
}

function buildDegradedResponse(rawPrompt: string, optimizedPrompt: string, reason: string): PromptProxyResponse {
  const rawTokens = estimateTokens(rawPrompt);
  const optimizedTokens = estimateTokens(optimizedPrompt);
  return {
    metrics: {
      raw_input_tokens: rawTokens,
      optimized_input_tokens: optimizedTokens,
      tokens_saved: Math.max(0, rawTokens - optimizedTokens),
      estimated_output_tokens: Math.ceil(optimizedTokens * 1.8),
      estimated_cost_usd: 0,
    },
    optimized_prompt: optimizedPrompt,
    improvements: [
      `[DEGRADED_MODE]: ${reason}`,
      '[DEGRADED_MODE]: Semantic cache and graph augmentation were temporarily disabled for this run.',
    ],
    analysis: {
      cache: {
        status: 'miss',
        confidence: 0,
        candidates: [],
      },
      context: {
        selected_files: [],
        selected_logs: [],
        log_sources: [],
        open_file_count: 0,
        total_log_count: 0,
      },
      cost: {
        input_cost_usd: 0,
        output_cost_usd: 0,
        total_cost_usd: 0,
        input_cost_per_1k_tokens: 0,
        output_cost_per_1k_tokens: 0,
      },
    },
    diagnostics: [
      {
        id: 'engine.sqlite_native_load_failed',
        severity: 'warning',
        message: reason,
      },
    ],
  };
}

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
  const ideContext = getIdeContext(context, chatContext);
  // Pull in files the prompt names but that aren't open, so the engine can
  // route to and re-open them with the exact referenced region selected.
  await augmentContextWithReferencedFiles(ideContext, rawPrompt);
  const request = {
    raw_prompt: rawPrompt,
    mode: getProcessingMode(),
    pricing: getPricingConfig(),
    ide_context: ideContext,
    workspace_id: computeWorkspaceId(workspaceRoot),
    target_model: getTargetModel(context),
    density: getDensity(context),
  };

  let response: PromptProxyResponse;
  try {
    response = runEngine(request, dbPath);
  } catch (error) {
    if (!isSqliteNativeLoadFailure(error)) { throw error; }

    const reason = 'SQLite native binding failed to load; using local degraded analyzer fallback.';
    let optimized = rawPrompt;
    try {
      if (isLocalModelAvailable(context)) {
        optimized = await optimizeLocally(context, rawPrompt);
      }
    } catch {
      // Keep passthrough prompt fallback if the local model is unavailable.
      optimized = rawPrompt;
    }
    response = buildDegradedResponse(rawPrompt, optimized, reason);
  }

  // Belt-and-suspenders: strip diagnostics/prompt-optimizer blocks that may
  // have leaked back into the optimized prompt via a stale cache row.
  const optimizedClean = response.optimized_prompt
    .replace(STRIP_DIAGNOSTICS_RE, '')
    .replace(STRIP_PROMPT_BLOCK_RE, '')
    .replace(STRIP_LEGACY_HISTORY_RE, '')
    .trim();

  // Optional model-based grammar polish. No-op unless a grammar model is
  // bundled AND enabled; every rewrite is meaning-guarded, so the worst case
  // is the deterministic output is returned unchanged.
  const optimizedFinal = await refineOptimizedPrompt(context, optimizedClean);

  const state: PromptProxyPanelState = {
    original: rawPrompt,
    optimized: optimizedFinal,
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
