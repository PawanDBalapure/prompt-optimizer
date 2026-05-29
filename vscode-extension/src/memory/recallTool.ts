import * as vscode from 'vscode';

import { runEngineRaw } from '../engine/runner';
import { getDbPath } from '../state/config';
import { computeWorkspaceId } from '../util/workspace';

/**
 * Registers the `prompt-optimizer_recallMemory` Language Model Tool so the
 * built-in Copilot agent (and any other extension that calls
 * `vscode.lm.invokeTool`) can pull Prompt Optimizer's cross-tier memory on
 * demand.  The tool also surfaces as the chat variable `#pomemory`
 * automatically because the contribution sets `canBeReferencedInPrompt`.
 *
 * All work is delegated to the engine CLI via `runEngineRaw` so the LM
 * tool, the chat variable, and the CLI itself all share one ranking path.
 */

const TOOL_NAME = 'prompt-optimizer_recallMemory';

interface RecallToolInput {
  query?: string;
  scope?: 'workspace' | 'user' | 'all';
  limit?: number;
}

interface RecallToolOutput {
  query: string;
  scope: string;
  formatted: string;
  entries: Array<{ tier: string; source: string; content: string; score: number }>;
}

export function registerRecallMemoryTool(context: vscode.ExtensionContext): void {
  // Older VS Code builds may not expose `vscode.lm.registerTool`; degrade
  // silently rather than blocking activation.
  const lm = vscode.lm as unknown as { registerTool?: typeof vscode.lm.registerTool };
  if (typeof lm.registerTool !== 'function') {
    return;
  }

  const tool: vscode.LanguageModelTool<RecallToolInput> = {
    async prepareInvocation(options, _token) {
      const query = (options.input?.query ?? '').trim();
      const scope = options.input?.scope ?? 'all';
      return {
        invocationMessage: query
          ? `Recalling Prompt Optimizer memory for "${query}" (scope: ${scope})…`
          : `Recalling Prompt Optimizer memory (scope: ${scope})…`,
      };
    },

    async invoke(options, token) {
      const input = options.input ?? {};
      const result = await runRecall(context, input, token);
      const parts: Array<vscode.LanguageModelTextPart> = [
        new vscode.LanguageModelTextPart(result.formatted),
        // Compact JSON payload so downstream tools can parse entries
        // without re-implementing markdown parsing.
        new vscode.LanguageModelTextPart(
          `\n\n<!--prompt-optimizer:recall:json-->\n` +
          JSON.stringify({
            query: result.query, scope: result.scope, entries: result.entries,
          }),
        ),
      ];
      return new vscode.LanguageModelToolResult(parts);
    },
  };

  context.subscriptions.push(lm.registerTool!(TOOL_NAME, tool));
}

async function runRecall(
  context: vscode.ExtensionContext,
  input: RecallToolInput,
  _token: vscode.CancellationToken,
): Promise<RecallToolOutput> {
  const dbPath = getDbPath(context);
  const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const wsId = computeWorkspaceId(wsRoot);
  const scope = input.scope ?? 'all';
  const limit = Math.max(1, Math.min(50, input.limit ?? 8));
  const args = [
    '--recall-memory',
    '--db', dbPath,
    '--scope', scope,
    '--workspace', wsId,
    '--limit', String(limit),
    '--format', 'json',
  ];
  if (wsRoot) { args.push('--workspace-root', wsRoot); }
  const query = (input.query ?? '').trim();
  if (query.length > 0) { args.push('--query', query); }

  try {
    const raw = runEngineRaw(args);
    const parsed = JSON.parse(raw) as RecallToolOutput;
    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      query,
      scope,
      formatted: `_Prompt Optimizer memory recall failed: ${message}_`,
      entries: [],
    };
  }
}
