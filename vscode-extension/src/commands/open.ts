import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { PROMPT_PROXY_VIEW_TYPE } from '../panel/view-type';

export async function openPromptProxyPanel(): Promise<void> {
  await vscode.commands.executeCommand(`${PROMPT_PROXY_VIEW_TYPE}.focus`);
}
/**
 * Opens the Copilot Chat view and prefills the input box.
 *
 * Pass `autoSend: true` only when the caller has explicit user intent to
 * submit (e.g. an "Ask Copilot now" action).  The default is `false` so
 * optimize-style flows merely populate the prompt and leave the actual
 * submission to the user pressing Enter / the chat send button.
 */
export async function openChatWithPrompt(
  prompt: string,
  mentionParticipant: boolean,
  autoSend = false,
): Promise<void> {
  const prefix = mentionParticipant ? '@promptoptimizer ' : '';
  const text = `${prefix}${prompt}`.trim();
  await vscode.commands.executeCommand('workbench.action.chat.open', {
    query: text,
    // `isPartialQuery: true` keeps the text in the input box without
    // submitting it; omitting it (or sending false) triggers an immediate
    // send the moment the chat view opens.
    isPartialQuery: !autoSend,
  });
}

export async function openExtensionReadme(
  context: vscode.ExtensionContext,
): Promise<void> {
  const readmePath = path.resolve(context.extensionPath, 'README.md');
  if (!fs.existsSync(readmePath)) {
    vscode.window.showWarningMessage(
      'Prompt Optimizer README.md was not found in the extension package.',
    );
    return;
  }

  // Open the README in Markdown preview mode by default — much friendlier
  // than raw markdown source.  Fall back to the text editor if the
  // built-in markdown extension is somehow unavailable.
  const uri = vscode.Uri.file(readmePath);
  try {
    await vscode.commands.executeCommand('markdown.showPreview', uri);
  } catch {
    const document = await vscode.workspace.openTextDocument(readmePath);
    await vscode.window.showTextDocument(document, { preview: false });
  }
}

/**
 * Opens the interactive HTML onboarding guide in a webview panel.
 *
 * The static asset lives at `media/onboarding.html`.  It contains its own
 * CSS animations and an inline `<script>` block — both of which are stripped
 * by the Marketplace / GitHub Markdown renderer, so we render it ourselves
 * inside a webview where scripts are allowed.
 */
let onboardingPanel: vscode.WebviewPanel | undefined;
export async function openOnboardingGuide(
  context: vscode.ExtensionContext,
): Promise<void> {
  if (onboardingPanel) {
    onboardingPanel.reveal(vscode.ViewColumn.Active);
    return;
  }

  const htmlPath = path.resolve(context.extensionPath, 'media', 'onboarding.html');
  if (!fs.existsSync(htmlPath)) {
    vscode.window.showWarningMessage(
      'Prompt Optimizer onboarding guide is missing (media/onboarding.html).',
    );
    return;
  }

  onboardingPanel = vscode.window.createWebviewPanel(
    'promptOptimizer.onboarding',
    'Prompt Optimizer — Onboarding',
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.file(path.dirname(htmlPath))],
    },
  );

  const renderHtml = (): string => {
    const raw = fs.readFileSync(htmlPath, 'utf8');
    const snapshot = collectMemorySnapshot();
    const injection =
      `<script id="__poMemorySeed">window.__POMemorySeed = ${JSON.stringify(snapshot)};</script>`;
    // Replace placeholder if present, else inject before </body>
    if (raw.includes('<!-- __PO_MEMORY_SNAPSHOT__ -->')) {
      return raw.replace('<!-- __PO_MEMORY_SNAPSHOT__ -->', injection);
    }
    return raw.replace('</body>', `${injection}\n</body>`);
  };

  onboardingPanel.webview.html = renderHtml();

  onboardingPanel.webview.onDidReceiveMessage(async (msg: unknown) => {
    if (!msg || typeof msg !== 'object') { return; }
    const type = (msg as { type?: unknown }).type;
    if (type === 'requestMemorySnapshot' && onboardingPanel) {
      await onboardingPanel.webview.postMessage({
        type: 'memorySnapshot',
        snapshot: collectMemorySnapshot(),
      });
    } else if (type === 'openMemoryFile') {
      await vscode.commands.executeCommand('prompt-proxy.openMemoryFile');
    }
  });

  onboardingPanel.onDidDispose(() => { onboardingPanel = undefined; });
}

/* ── Memory snapshot ───────────────────────────────────────────────────── */

const MEMORY_FILE_NAMES = [
  'AGENTS.md', 'CLAUDE.md', 'CLAUDE.local.md',
  '.promptoptimizer/memory.md', '.promptoptimizer/knowledge.md',
  'memory.md', 'knowledge.md',
];

interface MemoryFileSnapshot {
  name: string;
  relPath: string;
  bytes: number;
  lines: number;
  tokens: number;
  mtime: number;
  /** Abstract preview: alphanumerics replaced with bullets so contents are not leaked. */
  silhouette: string;
}

interface MemorySnapshot {
  generatedAt: number;
  workspace: string | null;
  files: MemoryFileSnapshot[];
  totals: { files: number; bytes: number; tokens: number };
  versions: { commits: number; head: string | null; recentTimestamps: number[] };
  cacheDir: { exists: boolean; entries: number; bytes: number };
  tokenBudget: { used: number; max: number };
}

function silhouetteOf(content: string, maxChars = 160): string {
  // Abstract preview — preserve whitespace + structure but redact letters/digits
  // with a Unicode bullet so we never expose secrets or real text.
  const trimmed = content.replace(/\s+/g, ' ').trim().slice(0, maxChars);
  return trimmed.replace(/[A-Za-z0-9]/g, '•');
}

function estimateTokensApprox(bytes: number): number {
  return Math.max(1, Math.round(bytes / 4));
}

export function collectMemorySnapshot(): MemorySnapshot {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const root = folders[0]?.uri.fsPath ?? null;
  const files: MemoryFileSnapshot[] = [];
  let totalBytes = 0;

  if (root) {
    for (const rel of MEMORY_FILE_NAMES) {
      const abs = path.join(root, rel);
      try {
        const st = fs.statSync(abs);
        if (!st.isFile()) { continue; }
        const content = fs.readFileSync(abs, 'utf8');
        const bytes = Buffer.byteLength(content, 'utf8');
        const lines = content.split(/\r?\n/).length;
        totalBytes += bytes;
        files.push({
          name: path.basename(rel),
          relPath: rel,
          bytes,
          lines,
          tokens: estimateTokensApprox(bytes),
          mtime: st.mtimeMs,
          silhouette: silhouetteOf(content),
        });
      } catch { /* file absent — skip silently */ }
    }
  }

  // Prompt-version log (.promptoptimizer/versions.jsonl) — opportunistic.
  let commits = 0;
  let head: string | null = null;
  const recentTimestamps: number[] = [];
  if (root) {
    const vp = path.join(root, '.promptoptimizer', 'versions.jsonl');
    try {
      const text = fs.readFileSync(vp, 'utf8');
      const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
      commits = lines.length;
      if (lines.length > 0) {
        try {
          const last = JSON.parse(lines[lines.length - 1]) as { id?: string };
          head = (last.id ?? '').slice(0, 7) || null;
        } catch { /* malformed line */ }
      }
      // Pull up to last 40 timestamps for a sparkline.
      const slice = lines.slice(-40);
      for (const ln of slice) {
        try {
          const obj = JSON.parse(ln) as { ts?: number; time?: number; createdAt?: number };
          const t = obj.ts ?? obj.time ?? obj.createdAt;
          if (typeof t === 'number' && isFinite(t)) { recentTimestamps.push(t); }
        } catch { /* skip */ }
      }
    } catch { /* no version log yet */ }
  }

  // Cache dir entry count + total bytes (.promptoptimizer/cache/*)
  let cacheEntries = 0;
  let cacheBytes = 0;
  let cacheExists = false;
  if (root) {
    const cd = path.join(root, '.promptoptimizer', 'cache');
    try {
      const entries = fs.readdirSync(cd);
      cacheExists = true;
      cacheEntries = entries.length;
      for (const e of entries) {
        try {
          const st = fs.statSync(path.join(cd, e));
          if (st.isFile()) { cacheBytes += st.size; }
        } catch { /* skip */ }
      }
    } catch { /* no cache dir yet */ }
  }

  const TOKEN_BUDGET_MAX = 24_000; // matches MAX_TOTAL_BYTES default in memory/budget.ts
  return {
    generatedAt: Date.now(),
    workspace: root ? path.basename(root) : null,
    files,
    totals: {
      files: files.length,
      bytes: totalBytes,
      tokens: estimateTokensApprox(totalBytes),
    },
    versions: { commits, head, recentTimestamps },
    cacheDir: { exists: cacheExists, entries: cacheEntries, bytes: cacheBytes },
    tokenBudget: { used: totalBytes, max: TOKEN_BUDGET_MAX },
  };
}
