import * as vscode from 'vscode';

import { registerRecallMemoryTool } from './recallTool';
import { registerCopilotInstructionsSync } from './instructionsSync';

/**
 * One-stop bootstrap for Phase A memory features.  Each capability lives
 * in its own small file and can be disabled independently — if any one
 * registration throws, the others still register.
 *
 * Add a new Phase A surface by adding a single `safeRegister(...)` call
 * here; `extension.ts` never needs to change again.
 */
export function registerMemoryFeatures(context: vscode.ExtensionContext): void {
  safeRegister(context, 'recall LM tool',            registerRecallMemoryTool);
  safeRegister(context, 'copilot-instructions sync', registerCopilotInstructionsSync);
}

function safeRegister(
  context: vscode.ExtensionContext,
  label: string,
  register: (context: vscode.ExtensionContext) => void,
): void {
  try {
    register(context);
  } catch (error) {
    console.warn(`[prompt-optimizer] failed to register ${label}:`, error);
  }
}
