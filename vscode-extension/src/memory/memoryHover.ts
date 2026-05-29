import * as path from 'path';
import * as vscode from 'vscode';

import {
  computeBudget,
  estimateTokens,
  formatBytes,
  isGuardedFile,
  progressBar,
  type MemoryBudget,
} from './budget';

/**
 * HoverProvider for memory files.  When the user mouses over *any* line in
 * `AGENTS.md` / `CLAUDE.md` / etc. a tooltip appears summarising:
 *
 *   - bytes used vs. the per-file cap (with a text progress bar)
 *   - approximate token count
 *   - whether the *current* hovered line falls inside the truncation tail
 *   - a quick-action link that triggers "Suggest improvements"
 *
 * Stateless and side-effect-free: builds the hover from the live document
 * on every request so it always reflects unsaved edits.
 */

export function registerMemoryHover(context: vscode.ExtensionContext): void {
  const selector: vscode.DocumentSelector = [
    { scheme: 'file', language: 'markdown' },
    { scheme: 'file', pattern: '**/.cursorrules' },
    { scheme: 'file', pattern: '**/.clinerules' },
  ];

  context.subscriptions.push(
    vscode.languages.registerHoverProvider(selector, {
      provideHover(doc, position) {
        if (!isGuardedFile(doc.fileName)) { return undefined; }
        const budget = computeBudget(doc);
        const md = buildHover(doc, position, budget);
        return new vscode.Hover(md);
      },
    }),
  );
}

function buildHover(
  doc: vscode.TextDocument,
  position: vscode.Position,
  budget: MemoryBudget,
): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = true;
  md.supportThemeIcons = true;

  const fileName = path.basename(doc.fileName);
  const bar = progressBar(budget.usedRatio);
  const headerIcon =
      budget.status === 'over' ? '$(error)'
    : budget.status === 'warn' ? '$(warning)'
    : '$(check)';

  md.appendMarkdown(`### ${headerIcon} Prompt Optimizer — \`${fileName}\`\n\n`);
  md.appendMarkdown(
    `\`${bar}\` **${budget.usedPct}%** of the ${formatBytes(budget.capBytes)} per-file cap` +
    ` (${formatBytes(budget.totalBytes)} used, ~${budget.estimatedTokens.toLocaleString()} tokens)\n\n`,
  );

  if (budget.status === 'over') {
    const inTail = position.line >= budget.truncLine;
    md.appendMarkdown(
      inTail
        ? `> $(circle-slash) **This line is in the truncated tail** — ` +
          `${formatBytes(budget.overBytes)} past the cap will not reach AI memory.\n\n`
        : `> $(warning) File is ${formatBytes(budget.overBytes)} over the cap. ` +
          `Lines from ${budget.truncLine + 1} onward will be silently truncated.\n\n`,
    );
  } else if (budget.status === 'warn') {
    md.appendMarkdown(
      `> $(info) Approaching the cap (${budget.usedPct}%). ` +
      `Consider trimming repetition before adding more rules.\n\n`,
    );
  } else {
    const lineText = doc.lineAt(position.line).text;
    const approxTokens = Math.max(1, estimateTokens(lineText));
    md.appendMarkdown(`> $(check) Within budget. This line ≈ ${approxTokens} token(s).\n\n`);
  }

  md.appendMarkdown(`---\n`);
  md.appendMarkdown(
    `[$(sparkle) Suggest improvements](command:prompt-proxy.suggestMemoryImprovements) · ` +
    `[$(graph) Show full budget](command:prompt-proxy.showMemoryBudget) · ` +
    `[$(refresh) Sync to Copilot](command:prompt-proxy.syncCopilotInstructions)`,
  );

  return md;
}
