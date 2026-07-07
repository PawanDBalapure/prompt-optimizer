import * as vscode from 'vscode';

import { exportInstructionsBundle, importInstructionsBundle } from './bundle';
import { fetchInstructionsOverview, openInstructionFile, readInstructionHistory } from './overview';
import { personaLibraryDir, workspaceRoot, type ActionResult } from './paths';
import { toggleInstructionRule, togglePersona } from './toggles';

export interface InstructionsMessage {
  type?: string;
  relPath?: string;
  line?: number;
  ruleText?: string;
  enabled?: boolean;
  personaId?: string;
  sourceFile?: string;
}

const INSTRUCTION_MESSAGE_TYPES = new Set([
  'requestInstructionsOverview', 'instructionsHistory', 'openInstructionFile',
  'exportInstructions', 'importInstructions', 'toggleInstructionRule', 'togglePersona',
]);

/** Post the engine's instructions overview (or an explanatory error). */
export async function postInstructionsOverview(
  webview: vscode.Webview,
  extensionFsPath: string,
): Promise<void> {
  const wsRoot = workspaceRoot();
  if (!wsRoot) {
    await webview.postMessage({
      type: 'instructionsOverview',
      ok: false,
      error: 'Open a workspace folder to manage instructions.',
    });
    return;
  }
  const result = fetchInstructionsOverview(wsRoot, personaLibraryDir(extensionFsPath));
  await webview.postMessage(
    result.ok
      ? { type: 'instructionsOverview', ok: true, payload: result.payload }
      : { type: 'instructionsOverview', ok: false, error: result.error },
  );
}

async function postActionDone(webview: vscode.Webview, result: ActionResult): Promise<void> {
  await webview.postMessage({ type: 'instructionsActionDone', ...result });
}

/**
 * Handle every Instructions-Manager message shared by the sidebar panel and
 * the Instruction Studio. Returns false when the message is not an
 * instructions message so callers can fall through to their own handlers.
 */
export async function handleInstructionsMessage(
  webview: vscode.Webview,
  extensionFsPath: string,
  msg: InstructionsMessage,
): Promise<boolean> {
  if (!msg.type || !INSTRUCTION_MESSAGE_TYPES.has(msg.type)) { return false; }
  const libDir = personaLibraryDir(extensionFsPath);

  switch (msg.type) {
    case 'requestInstructionsOverview':
      await postInstructionsOverview(webview, extensionFsPath);
      return true;
    case 'instructionsHistory': {
      const relPath = msg.relPath ?? '';
      const result = readInstructionHistory(relPath);
      await webview.postMessage({ type: 'instructionsHistory', relPath, ...result });
      return true;
    }
    case 'openInstructionFile': {
      const result = await openInstructionFile(msg.relPath ?? '');
      if (!result.ok) { await postActionDone(webview, result); }
      return true;
    }
    case 'exportInstructions': {
      const wsRoot = workspaceRoot();
      await postActionDone(
        webview,
        wsRoot ? await exportInstructionsBundle(wsRoot) : { ok: false, error: 'Open a workspace folder first.' },
      );
      return true;
    }
    case 'importInstructions': {
      const wsRoot = workspaceRoot();
      const result = wsRoot
        ? await importInstructionsBundle(wsRoot)
        : { ok: false, error: 'Open a workspace folder first.' } as ActionResult;
      await postActionDone(webview, result);
      if (result.ok) { await postInstructionsOverview(webview, extensionFsPath); }
      return true;
    }
    case 'toggleInstructionRule': {
      const result = await toggleInstructionRule(
        { relPath: msg.relPath, line: msg.line, ruleText: msg.ruleText, enabled: msg.enabled },
        { skillLibraryDir: libDir },
      );
      await postActionDone(webview, result);
      if (result.ok) { await postInstructionsOverview(webview, extensionFsPath); }
      return true;
    }
    case 'togglePersona': {
      const result = await togglePersona(
        { personaId: msg.personaId, sourceFile: msg.sourceFile, enabled: msg.enabled },
        libDir,
      );
      await postActionDone(webview, result);
      if (result.ok) { await postInstructionsOverview(webview, extensionFsPath); }
      return true;
    }
    default:
      return false;
  }
}
