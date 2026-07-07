import * as vscode from 'vscode';

export type SourceLabel = 'selection' | 'editor' | 'clipboard' | 'typed';
export interface PromptSource { label: SourceLabel; text: string; }

/** Gather selection / full-editor / clipboard candidates, deduped. */
async function collectCandidates(): Promise<PromptSource[]> {
  const candidates: PromptSource[] = [];
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    const sel = editor.selection;
    if (!sel.isEmpty) {
      const t = editor.document.getText(sel).trim();
      if (t) { candidates.push({ label: 'selection', text: t }); }
    }
    const full = editor.document.getText().trim();
    if (full && !candidates.some((c) => c.text === full)) {
      candidates.push({ label: 'editor', text: full });
    }
  }
  const clip = ((await vscode.env.clipboard.readText()) || '').trim();
  if (clip && !candidates.some((c) => c.text === clip)) {
    candidates.push({ label: 'clipboard', text: clip });
  }
  return candidates;
}

/**
 * Resolve the optimize input source according to the configured strategy
 * ('ask' shows a QuickPick; other strategies use a preference order).
 */
export async function pickPromptSource(strategy: string): Promise<PromptSource | undefined> {
  const candidates = await collectCandidates();
  if (candidates.length === 0) {
    const typed = await vscode.window.showInputBox({
      title: 'Optimize prompt',
      prompt: 'Paste or type the prompt you want to optimize before sending to Copilot Chat',
      placeHolder: 'e.g. Refactor the auth middleware to async/await and add unit tests',
      ignoreFocusOut: true,
    });
    if (!typed || !typed.trim()) { return undefined; }
    return { label: 'typed', text: typed.trim() };
  }
  if (candidates.length === 1) { return candidates[0]; }

  if (strategy === 'ask') {
    const icons: Record<SourceLabel, string> = {
      selection: '$(selection) Editor selection',
      editor: '$(file) Full editor file',
      clipboard: '$(clippy) Clipboard',
      typed: '$(edit) Typed',
    };
    const items = candidates.map<vscode.QuickPickItem & { c: PromptSource }>((c) => ({
      label: icons[c.label],
      description: `${c.text.length} chars`,
      detail: c.text.replace(/\s+/g, ' ').slice(0, 120) + (c.text.length > 120 ? '…' : ''),
      c,
    }));
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Multiple prompt sources detected — pick one to optimize',
      matchOnDetail: true,
    });
    return picked?.c;
  }

  const order: Record<string, SourceLabel[]> = {
    'selection-first': ['selection', 'editor', 'clipboard'],
    'clipboard-first': ['clipboard', 'selection', 'editor'],
    'auto': ['selection', 'editor', 'clipboard'],
  };
  const preferred = order[strategy] ?? order.auto;
  for (const lbl of preferred) {
    const hit = candidates.find((c) => c.label === lbl);
    if (hit) { return hit; }
  }
  return candidates[0];
}

/** Human-readable description of a chosen source for progress titles. */
export function describeSource(source: PromptSource): string {
  const names: Record<SourceLabel, string> = {
    selection: 'editor selection',
    editor: 'full editor file',
    clipboard: 'clipboard',
    typed: 'typed prompt',
  };
  return `${names[source.label]} (${source.text.length} chars)`;
}
