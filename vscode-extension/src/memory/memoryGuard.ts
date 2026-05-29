import * as vscode from 'vscode';

import {
  computeBudget,
  formatBytes,
  isGuardedFile,
  type MemoryBudget,
} from './budget';

/**
 * Diagnostic-collection driven guardrail.  Surfaces a yellow squiggle and a
 * Problems-panel entry on the exact line where memory-file content crosses
 * the per-file byte cap and will be silently truncated by the engine.
 *
 * Live-updates on every keystroke (350 ms debounce) and clears immediately
 * when the user trims the file under the cap.  Never modifies the file.
 */

const DIAGNOSTIC_SOURCE = 'Prompt Optimizer';
const DIAGNOSTIC_CODE   = 'MEMORY_FILE_TOO_LARGE';
const DEBOUNCE_MS       = 350;

export function registerMemoryGuard(context: vscode.ExtensionContext): void {
  const diagnostics = vscode.languages.createDiagnosticCollection(DIAGNOSTIC_SOURCE);
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  context.subscriptions.push(
    diagnostics,
    { dispose: () => { for (const t of debounceTimers.values()) { clearTimeout(t); } } },
  );

  const refresh = (doc: vscode.TextDocument) => {
    if (doc.uri.scheme !== 'file') { return; }
    if (!isGuardedFile(doc.fileName)) {
      diagnostics.delete(doc.uri);
      return;
    }
    diagnostics.set(doc.uri, buildDiagnostics(doc));
  };

  const debounce = (doc: vscode.TextDocument) => {
    const key = doc.uri.toString();
    const prior = debounceTimers.get(key);
    if (prior) { clearTimeout(prior); }
    debounceTimers.set(key, setTimeout(() => {
      debounceTimers.delete(key);
      refresh(doc);
    }, DEBOUNCE_MS));
  };

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => debounce(e.document)),
    vscode.workspace.onDidSaveTextDocument(refresh),
    vscode.workspace.onDidOpenTextDocument(refresh),
    vscode.workspace.onDidCloseTextDocument((doc) => { diagnostics.delete(doc.uri); }),
  );

  for (const doc of vscode.workspace.textDocuments) { refresh(doc); }
}

function buildDiagnostics(doc: vscode.TextDocument): vscode.Diagnostic[] {
  const budget = computeBudget(doc);
  if (budget.status !== 'over') { return []; }
  return [overCapDiagnostic(doc, budget)];
}

function overCapDiagnostic(doc: vscode.TextDocument, budget: MemoryBudget): vscode.Diagnostic {
  const lastLine = doc.lineCount - 1;
  const range = new vscode.Range(
    budget.truncLine, 0,
    lastLine, doc.lineAt(lastLine).text.length,
  );
  const usedPct = Math.round((budget.capBytes / budget.totalBytes) * 100);
  const message =
    `Prompt Optimizer will truncate here — ${formatBytes(budget.overBytes)} over the ` +
    `${formatBytes(budget.capBytes)} per-file cap. ` +
    `Only the first ${usedPct}% of this file feeds AI memory. ` +
    `Move lower-priority rules to the end, or split them into a separate file ` +
    `(e.g. .promptoptimizer/knowledge.md). ` +
    `Use the "Suggest improvements" CodeLens at the top to ask Copilot for a rewrite.`;
  const diag = new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Warning);
  diag.source = DIAGNOSTIC_SOURCE;
  diag.code   = DIAGNOSTIC_CODE;
  diag.tags   = [vscode.DiagnosticTag.Unnecessary];
  return diag;
}
