import * as path from 'path';
import * as vscode from 'vscode';

import { openChatWithPrompt } from '../commands/open';
import {
  computeBudget,
  formatBytes,
  isGuardedFile,
  progressBar,
  statusIcon,
  type MemoryBudget,
} from './budget';

/**
 * CodeLens + commands for memory files.  Provides two clickable buttons
 * pinned to the top of every guarded file:
 *
 *   ┌─────────────────────────────────────────────────────────────────────┐
 *   │ $(check) Prompt Optimizer · ████░░░░░░ 42% (5.1 KB / 12 KB)         │
 *   │ ✨ Suggest improvements   📊 Show budget                            │
 *   └─────────────────────────────────────────────────────────────────────┘
 *
 * The lens re-renders 1.2 s after the user stops typing, so the budget
 * stays current without flashing on every keystroke.
 *
 * `prompt-proxy.suggestMemoryImprovements` opens Copilot Chat with a
 * structured review request that includes the live file content, the
 * project's caps, and a clear acceptance checklist.  No engine call is
 * needed — the existing chat participant takes over from there.
 */

const RERENDER_DEBOUNCE_MS = 1200;

export function registerMemoryCodeLens(context: vscode.ExtensionContext): void {
  const provider = new MemoryCodeLensProvider();

  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      [
        { scheme: 'file', language: 'markdown' },
        { scheme: 'file', pattern: '**/.cursorrules' },
        { scheme: 'file', pattern: '**/.clinerules' },
      ],
      provider,
    ),
    vscode.commands.registerCommand(
      'prompt-proxy.suggestMemoryImprovements',
      () => suggestImprovementsForActive(),
    ),
    vscode.commands.registerCommand(
      'prompt-proxy.showMemoryBudget',
      () => showBudgetForActive(),
    ),
    provider,
  );
}

// ---------------------------------------------------------------------------
// CodeLens provider (debounced)
// ---------------------------------------------------------------------------

class MemoryCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  private readonly debounce = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly subscription: vscode.Disposable;

  readonly onDidChangeCodeLenses = this.emitter.event;

  constructor() {
    this.subscription = vscode.workspace.onDidChangeTextDocument((e) => {
      if (!isGuardedFile(e.document.fileName)) { return; }
      const key = e.document.uri.toString();
      const prior = this.debounce.get(key);
      if (prior) { clearTimeout(prior); }
      this.debounce.set(key, setTimeout(() => {
        this.debounce.delete(key);
        this.emitter.fire();
      }, RERENDER_DEBOUNCE_MS));
    });
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    if (!isGuardedFile(doc.fileName)) { return []; }
    const budget = computeBudget(doc);
    const topRange = new vscode.Range(0, 0, 0, 0);
    const bar = progressBar(budget.usedRatio);
    const statusTitle =
      `${statusIcon(budget.status)} Prompt Optimizer · ${bar} ${budget.usedPct}% ` +
      `(${formatBytes(budget.totalBytes)} / ${formatBytes(budget.capBytes)}` +
      ` · ~${budget.estimatedTokens.toLocaleString()} tokens)`;
    return [
      new vscode.CodeLens(topRange, {
        title: statusTitle,
        command: 'prompt-proxy.showMemoryBudget',
        tooltip: 'Show detailed memory budget for this file',
      }),
      new vscode.CodeLens(topRange, {
        title: '$(sparkle) Suggest improvements',
        command: 'prompt-proxy.suggestMemoryImprovements',
        tooltip: 'Ask Copilot to review this memory file for clarity, redundancy, and token efficiency',
      }),
      new vscode.CodeLens(topRange, {
        title: '$(refresh) Sync to Copilot',
        command: 'prompt-proxy.syncCopilotInstructions',
        tooltip: 'Regenerate .github/copilot-instructions.md from this workspace memory',
      }),
    ];
  }

  dispose(): void {
    for (const t of this.debounce.values()) { clearTimeout(t); }
    this.debounce.clear();
    this.subscription.dispose();
    this.emitter.dispose();
  }
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

async function suggestImprovementsForActive(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const doc = editor?.document;
  if (!doc || !isGuardedFile(doc.fileName)) {
    await vscode.window.showWarningMessage(
      'Open a Prompt Optimizer memory file (AGENTS.md, CLAUDE.md, memory.md, …) to use this action.',
    );
    return;
  }
  const budget = computeBudget(doc);
  const prompt = buildReviewPrompt(doc, budget);
  await openChatWithPrompt(prompt, /* mentionParticipant */ true, /* autoSend */ false);
}

async function showBudgetForActive(): Promise<void> {
  const doc = vscode.window.activeTextEditor?.document;
  if (!doc || !isGuardedFile(doc.fileName)) {
    await vscode.window.showInformationMessage(
      'Open a Prompt Optimizer memory file to see its budget.',
    );
    return;
  }
  const budget = computeBudget(doc);
  const detail =
    `${formatBytes(budget.totalBytes)} / ${formatBytes(budget.capBytes)} ` +
    `(${budget.usedPct}%, ~${budget.estimatedTokens.toLocaleString()} tokens)`;
  const action = budget.status === 'over'
    ? `Truncated from line ${budget.truncLine + 1}. ${formatBytes(budget.overBytes)} will not reach AI memory.`
    : budget.status === 'warn'
    ? `Within cap but approaching it — consider trimming before adding more rules.`
    : `Well within the per-file budget.`;
  const picked = await vscode.window.showInformationMessage(
    `Prompt Optimizer memory budget — ${detail}`,
    { modal: false, detail: action } as vscode.MessageOptions,
    'Suggest improvements', 'Sync to Copilot',
  );
  if (picked === 'Suggest improvements') {
    await suggestImprovementsForActive();
  } else if (picked === 'Sync to Copilot') {
    await vscode.commands.executeCommand('prompt-proxy.syncCopilotInstructions');
  }
}

// ---------------------------------------------------------------------------
// Review-prompt builder
// ---------------------------------------------------------------------------

function buildReviewPrompt(doc: vscode.TextDocument, budget: MemoryBudget): string {
  const fileName = path.basename(doc.fileName);
  const content = doc.getText();
  const overNote = budget.status === 'over'
    ? `\n\n**Warning:** the file is ${formatBytes(budget.overBytes)} over the ${formatBytes(budget.capBytes)} per-file cap. ` +
      `Aim to fit a rewritten version comfortably under the cap (target ≤ ${formatBytes(Math.round(budget.capBytes * 0.85))}).`
    : `\n\nCurrent size: ${formatBytes(budget.totalBytes)} of ${formatBytes(budget.capBytes)} cap (${budget.usedPct}%).`;

  return [
    `Review the following Prompt Optimizer memory file (\`${fileName}\`) and propose a rewritten version.${overNote}`,
    '',
    'Focus on:',
    '1. **Redundancy** — collapse overlapping bullets and remove duplicate rules.',
    '2. **Token efficiency** — prefer terse imperative bullets over prose; drop filler words.',
    '3. **Specificity** — replace vague guidance ("write clean code") with concrete, testable rules.',
    '4. **Structure** — group rules under clear `##` headings (Conventions, Build, Testing, Don\'ts).',
    '5. **Highest-signal first** — put the most important rules in the first 50% of the file so they survive truncation.',
    '6. **Best-practice gaps** — call out any missing sections (test commands, lint commands, forbidden patterns, glossary).',
    '',
    'Return:',
    '- A short numbered list of concrete change recommendations.',
    '- A complete drop-in replacement fenced as a markdown code block.',
    '- An estimated new byte size for the rewrite.',
    '',
    `---`,
    `\`\`\`markdown`,
    content,
    `\`\`\``,
  ].join('\n');
}
