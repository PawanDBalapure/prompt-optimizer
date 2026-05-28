import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

import {
  CHAT_PARTICIPANT_ID,
  ENRICH_INTERVAL_MS,
} from './constants';
import { handleChatRequest } from './chat/handler';
import { analyzePrompt } from './chat/analyzer';
import {
  openChatWithPrompt,
  openExtensionReadme,
  openPromptProxyPanel,
} from './commands/open';
import { seedCacheFromWorkspace, enrichFromChatHistory, ingestMemoryFiles } from './engine/seeder';
import { runEngineRaw } from './engine/runner';
import { PromptProxyViewProvider } from './panel/PromptProxyViewProvider';
import { ProxyStatusPanel } from './panel/ProxyStatusPanel';
import {
  clearConversationForWorkspace,
  getConversation,
} from './state/conversation';
import { getDbPath } from './state/config';
import {
  addPassiveEvent,
  getLastAnalysis,
} from './state/session';
import {
  getCurrentMode,
  setCurrentMode,
  updateStatusBarItem,
} from './state/mode';
import type { ProxyMode } from './types';
import { formatCurrency } from './util/format';
import { computeWorkspaceId } from './util/workspace';

interface ModeQuickPickItem extends vscode.QuickPickItem {
  value: ProxyMode;
}

function buildModeItems(current: ProxyMode): ModeQuickPickItem[] {
  return [
    {
      label: '$(robot) Agent',
      description: 'Optimize + call Copilot automatically — no @promptoptimizer prefix needed',
      detail: current === 'agent' ? '\u25CF Active' : undefined,
      value: 'agent',
    },
    {
      label: '$(wand) Optimize only',
      description: 'Show analysis, copy / send buttons — you control when it goes to Copilot',
      detail: current === 'optimize' ? '\u25CF Active' : undefined,
      value: 'optimize',
    },
    {
      label: '$(comment-discussion) Direct send',
      description: 'Pre-fill @promptoptimizer in the Chat panel and press Enter',
      detail: current === 'direct' ? '\u25CF Active' : undefined,
      value: 'direct',
    },
  ];
}

export function activate(context: vscode.ExtensionContext) {
  const provider = new PromptProxyViewProvider(context.extensionUri, context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(PromptProxyViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  updateStatusBarItem(statusBarItem, getCurrentMode(context));
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // Dedicated "Optimize prompt" status bar button — always visible so the
  // optimize action is one click away from the chat surface.
  const optimizeBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  optimizeBarItem.text = '$(sparkle) Optimize';
  optimizeBarItem.tooltip = 'Prompt Optimizer: optimize the current selection or clipboard, then send to Copilot Chat (Ctrl+Alt+O)';
  optimizeBarItem.command = 'prompt-proxy.optimizeChatPrompt';
  optimizeBarItem.show();
  context.subscriptions.push(optimizeBarItem);

  registerCommands(context, provider, statusBarItem);
  registerPassiveListeners(context, provider);

  const participant = vscode.chat.createChatParticipant(
    CHAT_PARTICIPANT_ID,
    async (request, chatContext, stream, token) =>
      handleChatRequest(context, provider, statusBarItem, request, chatContext, stream, token),
  );
  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'images', 'icon.png');
  participant.followupProvider = {
    provideFollowups: () => {
      const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const wsId = computeWorkspaceId(wsRoot);
      const hist = getConversation(context, wsId);
      const followups: vscode.ChatFollowup[] = [];
      if (hist.length > 0) {
        followups.push({
          prompt: '/memory',
          label: `View memory (${hist.length} turn${hist.length === 1 ? '' : 's'})`,
        });
        followups.push({ prompt: '/clear', label: 'Clear conversation memory' });
      }
      followups.push({
        prompt: '/context Show what local context Prompt Optimizer can read right now.',
        label: 'Show workspace context',
      });
      return followups;
    },
  };
  context.subscriptions.push(participant);

  // Initial bootstrap: harvests workspace conventions, git log, Copilot chat
  // history, README, etc. and seeds the semantic cache + knowledge graph +
  // workspace memory.  On a fresh install this runs unconditionally so the
  // memory is primed before the very first user prompt.
  setTimeout(() => {
    void (async () => {
      await seedCacheFromWorkspace(context);
      provider.refreshStatusOverview();
    })();
  }, 3000);

  // Continuous enrichment: every 15 min while VS Code stays open, pull any
  // new prompts from the Copilot chat database into the knowledge graph.
  const enrichTimer = setInterval(() => {
    void (async () => {
      await enrichFromChatHistory(context);
      provider.refreshStatusOverview();
    })();
  }, ENRICH_INTERVAL_MS);
  context.subscriptions.push({ dispose: () => clearInterval(enrichTimer) });
}

export function deactivate() {}

function registerCommands(
  context: vscode.ExtensionContext,
  provider: PromptProxyViewProvider,
  statusBarItem: vscode.StatusBarItem,
): void {
  const push = (d: vscode.Disposable) => context.subscriptions.push(d);

  push(vscode.commands.registerCommand('prompt-proxy.toggleStatusPanel', () => {
    ProxyStatusPanel.toggle(context, provider);
  }));

  push(vscode.commands.registerCommand('prompt-proxy.selectMode', async () => {
    const current = getCurrentMode(context);
    const items = buildModeItems(current);
    const picked = await vscode.window.showQuickPick(
      items as vscode.QuickPickItem[],
      { placeHolder: 'Select default Prompt Optimizer mode', matchOnDescription: true },
    ) as ModeQuickPickItem | undefined;
    if (!picked) { return; }
    await setCurrentMode(context, picked.value);
    updateStatusBarItem(statusBarItem, picked.value);
    provider.notifyModeChange(picked.value);
  }));

  push(vscode.commands.registerCommand('prompt-proxy.focusPanel', async () => {
    await openPromptProxyPanel();
  }));

  push(vscode.commands.registerCommand('prompt-proxy.startChat', async () => {
    await openChatWithPrompt('', true);
  }));

  push(vscode.commands.registerCommand('prompt-proxy.optimizeClipboard', async () => {
    const clipboardText = (await vscode.env.clipboard.readText()).trim();
    if (!clipboardText) {
      vscode.window.showWarningMessage('Clipboard is empty.');
      return;
    }
    try {
      const state = await analyzePrompt(context, clipboardText, 'clipboard');
      provider.publishAnalysis(state);
      await openPromptProxyPanel();
      await vscode.env.clipboard.writeText(state.optimized);
      vscode.window.showInformationMessage(
        `Prompt Optimizer saved ${state.metrics.tokens_saved} tokens. Estimated cost ${formatCurrency(state.metrics.estimated_cost_usd)}.`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Prompt Optimizer failed to optimize the clipboard prompt: ${message}`);
    }
  }));

  // Reads the active editor's selection (or full doc, or clipboard) and runs
  // it through the optimizer, then opens Copilot Chat with the optimized
  // prompt prefilled.  Bound to a keybinding and a dedicated status-bar
  // button so users can optimize whatever is in their editor with one click.
  push(vscode.commands.registerCommand('prompt-proxy.optimizeChatPrompt', async () => {
    let source = '';
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      const sel = editor.selection;
      source = sel.isEmpty ? editor.document.getText() : editor.document.getText(sel);
    }
    if (!source.trim()) {
      source = (await vscode.env.clipboard.readText()) || '';
    }
    source = source.trim();
    if (!source) {
      const typed = await vscode.window.showInputBox({
        title: 'Optimize prompt',
        prompt: 'Paste or type the prompt you want to optimize before sending to Copilot Chat',
        ignoreFocusOut: true,
      });
      if (!typed || !typed.trim()) { return; }
      source = typed.trim();
    }
    try {
      const state = await analyzePrompt(context, source, 'clipboard');
      provider.publishAnalysis(state);
      await vscode.env.clipboard.writeText(state.optimized);
      await openChatWithPrompt(state.optimized, false);
      vscode.window.showInformationMessage(
        `Prompt optimized \u2014 saved ${state.metrics.tokens_saved} tokens (~${formatCurrency(state.metrics.estimated_cost_usd)}). Copied to clipboard.`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Prompt Optimizer could not optimize: ${message}`);
    }
  }));

  push(vscode.commands.registerCommand('prompt-proxy.copyPrompt', async (prompt?: string) => {
    const text = prompt ?? getLastAnalysis(context)?.optimized;
    if (!text) {
      vscode.window.showWarningMessage('No optimized prompt is available yet.');
      return;
    }
    await vscode.env.clipboard.writeText(text);
    vscode.window.showInformationMessage('Prompt Optimizer copied the optimized prompt to the clipboard.');
  }));

  push(vscode.commands.registerCommand('prompt-proxy.sendPromptToChat', async (prompt?: string) => {
    const text = prompt ?? getLastAnalysis(context)?.optimized;
    if (!text) {
      vscode.window.showWarningMessage('No optimized prompt is available yet.');
      return;
    }
    await openChatWithPrompt(text, false);
  }));

  push(vscode.commands.registerCommand('prompt-proxy.openReadme', async () => {
    await openExtensionReadme(context);
  }));

  push(vscode.commands.registerCommand('prompt-proxy.cacheStats', async () => {
    const dbPath = getDbPath(context);
    try {
      const result = runEngineRaw(['--cache-stats', '--db', dbPath]);
      const stats = JSON.parse(result) as {
        total_entries?: number;
        avg_confidence?: number;
        total_hits?: number;
      };
      vscode.window.showInformationMessage(
        `Cache: ${stats.total_entries ?? 0} entries | avg confidence ${((stats.avg_confidence ?? 0) * 100).toFixed(1)}% | ${stats.total_hits ?? 0} total hits`,
      );
    } catch (err) {
      vscode.window.showErrorMessage(`Cache stats failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }));

  push(vscode.commands.registerCommand('prompt-proxy.clearCache', async () => {
    const confirm = await vscode.window.showWarningMessage(
      'Clear the Prompt Optimizer semantic cache? This cannot be undone.',
      { modal: true },
      'Clear',
    );
    if (confirm !== 'Clear') { return; }
    const dbPath = getDbPath(context);
    try {
      runEngineRaw(['--clear-cache', '--db', dbPath]);
      vscode.window.showInformationMessage('Prompt Optimizer cache cleared.');
    } catch (err) {
      vscode.window.showErrorMessage(`Cache clear failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }));

  push(vscode.commands.registerCommand('prompt-proxy.clearMemory', async () => {
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const wsId = computeWorkspaceId(wsRoot);
    await clearConversationForWorkspace(context, wsId);
    vscode.window.showInformationMessage('Prompt Optimizer conversation memory cleared.');
  }));

  push(vscode.commands.registerCommand('prompt-proxy.openMemoryFile', async () => {
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!wsRoot) {
      vscode.window.showWarningMessage('Open a workspace folder first.');
      return;
    }
    const memoryUri = vscode.Uri.joinPath(vscode.Uri.file(wsRoot), '.promptoptimizer', 'memory.md');
    try {
      await vscode.workspace.fs.stat(memoryUri);
    } catch {
      const seed = new TextEncoder().encode(
        '# Prompt Optimizer workspace memory\n\n' +
          'Notes here are automatically included as long-lived context for every optimization.\n' +
          'Keep it concise — bullet points and short paragraphs work best.\n\n' +
          '- Stack: \n- Conventions: \n- Things to avoid: \n',
      );
      try {
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(vscode.Uri.file(wsRoot), '.promptoptimizer'));
        await vscode.workspace.fs.writeFile(memoryUri, seed);
      } catch (err) {
        vscode.window.showErrorMessage(`Could not create memory file: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
    }
    const doc = await vscode.workspace.openTextDocument(memoryUri);
    await vscode.window.showTextDocument(doc);
  }));

  push(vscode.commands.registerCommand('prompt-proxy.peerWorkspaces', async () => {
    const dbPath = getDbPath(context);
    const action = await vscode.window.showQuickPick(
      [
        { label: '$(list-unordered) List peer workspaces', value: 'list' },
        { label: '$(add) Add peer workspace', value: 'add' },
        { label: '$(trash) Remove peer workspace', value: 'remove' },
      ],
      { placeHolder: 'Peer workspaces — federate semantic cache across workspaces' },
    );
    if (!action) { return; }

    try {
      if (action.value === 'list') {
        const raw = runEngineRaw(['--peer-list', '--db', dbPath]);
        const parsed = JSON.parse(raw) as { ok: boolean; peers?: Array<{ label: string; dbPath: string; enabled: boolean }> };
        const peers = parsed.peers ?? [];
        if (peers.length === 0) {
          vscode.window.showInformationMessage('No peer workspaces registered.');
          return;
        }
        const lines = peers.map((p) => `${p.enabled ? '$(check)' : '$(circle-slash)'} ${p.label} — ${p.dbPath}`);
        await vscode.window.showQuickPick(lines, { placeHolder: `${peers.length} peer(s) registered` });
        return;
      }

      if (action.value === 'add') {
        const label = await vscode.window.showInputBox({
          prompt: 'Label for peer workspace',
          validateInput: (v) => (v.trim().length === 0 ? 'Label is required' : null),
        });
        if (!label) { return; }
        const picked = await vscode.window.showOpenDialog({
          canSelectFiles: true,
          canSelectFolders: false,
          canSelectMany: false,
          filters: { 'SQLite database': ['db', 'sqlite', 'sqlite3'] },
          openLabel: 'Select peer cache database',
        });
        if (!picked || picked.length === 0) { return; }
        const peerDb = picked[0].fsPath;
        const raw = runEngineRaw(['--peer-add', '--label', label, '--peer-db', peerDb, '--db', dbPath]);
        const result = JSON.parse(raw) as { ok: boolean; error?: string };
        if (result.ok) {
          vscode.window.showInformationMessage(`Peer "${label}" added.`);
        } else {
          vscode.window.showErrorMessage(`Add failed: ${result.error}`);
        }
        return;
      }

      if (action.value === 'remove') {
        const raw = runEngineRaw(['--peer-list', '--db', dbPath]);
        const parsed = JSON.parse(raw) as { peers?: Array<{ label: string; dbPath: string }> };
        const peers = parsed.peers ?? [];
        if (peers.length === 0) {
          vscode.window.showInformationMessage('No peer workspaces to remove.');
          return;
        }
        const choice = await vscode.window.showQuickPick(
          peers.map((p) => ({ label: p.label, description: p.dbPath, value: p.dbPath })),
          { placeHolder: 'Pick peer to remove' },
        );
        if (!choice) { return; }
        runEngineRaw(['--peer-remove', '--peer-db', choice.value, '--db', dbPath]);
        vscode.window.showInformationMessage(`Removed peer "${choice.label}".`);
      }
    } catch (err) {
      vscode.window.showErrorMessage(`Peer command failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }));

  push(vscode.commands.registerCommand('prompt-proxy.knowledgeGraphStats', async () => {
    const dbPath = getDbPath(context);
    try {
      const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const wsId = computeWorkspaceId(wsRoot);
      const raw = runEngineRaw(['--kg-stats', '--workspace', wsId, '--db', dbPath]);
      const stats = JSON.parse(raw) as { nodes: number; edges: number };
      vscode.window.showInformationMessage(
        `Knowledge graph (workspace ${wsId}): ${stats.nodes} node(s), ${stats.edges} edge(s).`,
      );
    } catch (err) {
      vscode.window.showErrorMessage(`KG stats failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }));

  push(vscode.commands.registerCommand('prompt-proxy.fileDigests', async () => {
    const dbPath = getDbPath(context);
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const wsId = computeWorkspaceId(wsRoot);
    try {
      const statsRaw = runEngineRaw(['--digest-stats', '--workspace', wsId, '--db', dbPath]);
      const stats = JSON.parse(statsRaw) as { files: number; total_visits: number; last_updated: number | null };
      const listRaw = runEngineRaw(['--digest-list', '--workspace', wsId, '--limit', '50', '--db', dbPath]);
      const rows = JSON.parse(listRaw) as Array<{ path: string; language: string; visitCount: number; summary: string; updatedAt: number }>;

      if (rows.length === 0) {
        const action = await vscode.window.showInformationMessage(
          `Studied files (workspace ${wsId}): 0. The optimizer records files the moment they appear in an optimization context.`,
          'Clear all',
        );
        if (action === 'Clear all') {
          runEngineRaw(['--digest-clear', '--workspace', wsId, '--db', dbPath]);
        }
        return;
      }

      const items = rows.map((row) => ({
        label: `$(file-code) ${row.path}`,
        description: `${row.language || '—'} · seen ${row.visitCount}x`,
        detail: row.summary?.trim() ? row.summary.slice(0, 160) : '(no summary)',
        path: row.path,
      }));
      items.push({
        label: '$(trash) Clear all studied-file digests for this workspace',
        description: `${stats.files} file(s) · ${stats.total_visits} visit(s)`,
        detail: 'Removes the cross-session "I have studied this file" memory. Cache and knowledge graph are not touched.',
        path: '__clear__',
      });

      const pick = await vscode.window.showQuickPick(items, {
        placeHolder: `${stats.files} studied file(s) — ${stats.total_visits} total visits`,
        matchOnDescription: true,
        matchOnDetail: true,
      });
      if (!pick) { return; }
      if (pick.path === '__clear__') {
        const confirm = await vscode.window.showWarningMessage(
          `Clear all ${stats.files} studied-file digest(s) for workspace ${wsId}?`,
          { modal: true },
          'Clear',
        );
        if (confirm !== 'Clear') { return; }
        runEngineRaw(['--digest-clear', '--workspace', wsId, '--db', dbPath]);
        vscode.window.showInformationMessage('Studied-file digests cleared for this workspace.');
        return;
      }
      if (wsRoot) {
        try {
          const fileUri = vscode.Uri.joinPath(vscode.Uri.file(wsRoot), pick.path);
          const doc = await vscode.workspace.openTextDocument(fileUri);
          await vscode.window.showTextDocument(doc);
        } catch {
          vscode.window.showWarningMessage(`Could not open ${pick.path} — it may have moved or been deleted.`);
        }
      }
    } catch (err) {
      vscode.window.showErrorMessage(`Studied files command failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }));

  // -- Agent skills (SDLC modes) ------------------------------------------
  push(vscode.commands.registerCommand('prompt-proxy.listSkills', async () => {
    try {
      const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
      const raw = runEngineRaw(['--list-modes', '--workspace-root', wsRoot]);
      const { modes, errors } = JSON.parse(raw) as {
        modes: Array<{ id: string; label: string; readOnly: boolean; source: string; slashAliases: string[]; keywords?: string[]; filePatterns?: string[]; tags?: string[]; priority?: number }>;
        errors?: Array<{ filePath: string; source: string; message: string }>;
      };
      if (errors && errors.length > 0) {
        const view = await vscode.window.showWarningMessage(
          `${errors.length} skill file(s) failed to load.`,
          'Show errors', 'Dismiss',
        );
        if (view === 'Show errors') {
          await vscode.commands.executeCommand('prompt-proxy.diagnoseSkills');
          return;
        }
      }
      const items = modes.map((m) => {
        const extras: string[] = [];
        if (m.keywords && m.keywords.length) { extras.push(`keywords: ${m.keywords.join(', ')}`); }
        if (m.filePatterns && m.filePatterns.length) { extras.push(`files: ${m.filePatterns.join(', ')}`); }
        if (typeof m.priority === 'number' && m.priority !== 0) { extras.push(`priority: ${m.priority}`); }
        if (m.tags && m.tags.length) { extras.push(`tags: ${m.tags.join(', ')}`); }
        return {
          label: `${m.source === 'builtin' ? '$(symbol-class)' : '$(extensions)'} /${m.id}`,
          description: `${m.label}${m.readOnly ? ' (read-only)' : ''}`,
          detail: [
            `source: ${m.source}`,
            `triggers: ${m.slashAliases.map((a) => `/${a}`).join(', ')}`,
            ...extras,
          ].join(' • '),
          value: m,
        };
      });
      const pick = await vscode.window.showQuickPick(items, {
        placeHolder: 'Agent skills (modes) registered for this workspace',
        matchOnDescription: true,
        matchOnDetail: true,
      });
      if (!pick) { return; }
      // Offer to open the override file if it lives in the workspace.
      const skillPath = path.join(
        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd(),
        '.promptoptimizer', 'skills', `${pick.value.id}.md`,
      );
      if (fs.existsSync(skillPath)) {
        const doc = await vscode.workspace.openTextDocument(skillPath);
        await vscode.window.showTextDocument(doc);
      } else {
        const open = await vscode.window.showInformationMessage(
          `Mode "${pick.value.id}" is a built-in. Create a workspace override?`,
          'Create override', 'Cancel',
        );
        if (open === 'Create override') {
          await vscode.commands.executeCommand('prompt-proxy.createSkill', pick.value.id);
        }
      }
    } catch (err) {
      vscode.window.showErrorMessage(`List skills failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }));

  push(vscode.commands.registerCommand('prompt-proxy.createSkill', async (presetId?: string) => {
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!wsRoot) {
      vscode.window.showWarningMessage('Open a workspace folder first.');
      return;
    }
    const id = presetId ?? await vscode.window.showInputBox({
      prompt: 'Skill id (lowercase, e.g. "a11y", "perf", "data-migration")',
      validateInput: (v) => /^[a-z][a-z0-9-]*$/.test(v) ? null : 'Lowercase letters, digits and dashes only.',
    });
    if (!id) { return; }
    const dir = path.join(wsRoot, '.promptoptimizer', 'skills');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${id}.md`);
    if (!fs.existsSync(file)) {
      const label = id.split(/[-_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      fs.writeFileSync(file, [
        '---',
        `id: ${id}`,
        `label: ${label}`,
        'readOnly: false',
        'priority: 0',
        `slashAliases: [${id}]`,
        `keywords: [${id.replace(/-/g, ' ')}]`,
        '# requires: [tokenA, tokenB]   # uncomment to AND-gate this skill',
        '# filePatterns:                 # uncomment to auto-trigger on file types',
        '#   - "*.ts"',
        '# intentPatterns:',
        `#   - "\\b${id.replace(/-/g, ' ')}\\b"`,
        '---',
        `You are operating as ${label}. Describe the role in 2-3 sentences.`,
        '',
        '## Checklist',
        '- First quality criterion this agent must satisfy.',
        '- Second quality criterion.',
        '',
      ].join('\n'));
    }
    const doc = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(doc);
    vscode.window.showInformationMessage(
      `Skill "${id}" ready. Edits hot-reload on the next prompt — trigger with /${id}.`,
    );
  }));

  push(vscode.commands.registerCommand('prompt-proxy.diagnoseSkills', async () => {
    try {
      const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
      const raw = runEngineRaw(['--list-modes', '--workspace-root', wsRoot]);
      const { errors } = JSON.parse(raw) as {
        errors?: Array<{ filePath: string; source: string; message: string }>;
      };
      if (!errors || errors.length === 0) {
        vscode.window.showInformationMessage('All skill files parse cleanly.');
        return;
      }
      const items = errors.map((e) => ({
        label: `$(error) ${path.basename(e.filePath)}`,
        description: e.message,
        detail: `${e.source} \u2022 ${e.filePath}`,
        value: e,
      }));
      const pick = await vscode.window.showQuickPick(items, {
        placeHolder: `${errors.length} skill file(s) failed to load — select to open`,
        matchOnDescription: true,
        matchOnDetail: true,
      });
      if (!pick) { return; }
      const doc = await vscode.workspace.openTextDocument(pick.value.filePath);
      await vscode.window.showTextDocument(doc);
    } catch (err) {
      vscode.window.showErrorMessage(`Diagnose skills failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }));

  push(vscode.commands.registerCommand('prompt-proxy.manageAgentSkills', async () => {
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!wsRoot) {
      vscode.window.showWarningMessage('Open a workspace folder first to enable agent skills.');
      return;
    }
    const libDir = path.join(context.extensionPath, 'media', 'skill-library');
    if (!fs.existsSync(libDir)) {
      vscode.window.showErrorMessage('Bundled skill library is missing from the extension package.');
      return;
    }
    const targetDir = path.join(wsRoot, '.promptoptimizer', 'skills');
    fs.mkdirSync(targetDir, { recursive: true });

    type LibEntry = {
      id: string;
      label: string;
      readOnly: boolean;
      tags: string[];
      libPath: string;
      targetPath: string;
      installed: boolean;
    };
    const libFiles = fs.readdirSync(libDir).filter((f) => /\.md$/i.test(f));
    const entries: LibEntry[] = libFiles.map((f) => {
      const libPath = path.join(libDir, f);
      const raw = fs.readFileSync(libPath, 'utf8');
      const idMatch = /^id:\s*(.+)$/m.exec(raw);
      const labelMatch = /^label:\s*(.+)$/m.exec(raw);
      const roMatch = /^readOnly:\s*(true|false)$/im.exec(raw);
      const tagsMatch = /^tags:\s*\[([^\]]*)\]/m.exec(raw);
      const id = (idMatch?.[1] ?? path.basename(f, '.md')).trim();
      const targetPath = path.join(targetDir, `${id}.md`);
      return {
        id,
        label: (labelMatch?.[1] ?? id).trim(),
        readOnly: /^true$/i.test(roMatch?.[1] ?? ''),
        tags: (tagsMatch?.[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean),
        libPath,
        targetPath,
        installed: fs.existsSync(targetPath),
      };
    }).sort((a, b) => a.id.localeCompare(b.id));

    type AgentItem = vscode.QuickPickItem & { entry: LibEntry };
    const editButton: vscode.QuickInputButton = {
      iconPath: new vscode.ThemeIcon('edit'),
      tooltip: 'Edit this agent definition (enables it first if needed)',
    };
    const resetButton: vscode.QuickInputButton = {
      iconPath: new vscode.ThemeIcon('discard'),
      tooltip: 'Reset to the bundled default (overwrites local edits)',
    };
    const buildItem = (e: LibEntry): AgentItem => ({
      label: `${e.installed ? '$(check)' : '$(circle-outline)'} /${e.id}`,
      description: `${e.label}${e.readOnly ? ' (read-only)' : ''}`,
      detail: e.tags.length ? `tags: ${e.tags.join(', ')}` : undefined,
      picked: e.installed,
      entry: e,
      buttons: e.installed ? [editButton, resetButton] : [editButton],
    });

    const qp = vscode.window.createQuickPick<AgentItem>();
    qp.canSelectMany = true;
    qp.matchOnDescription = true;
    qp.matchOnDetail = true;
    qp.placeholder = 'Tick agents to enable. Click the pencil icon to edit a definition.';
    qp.title = 'Manage SDLC Agent Skills';
    qp.items = entries.map(buildItem);
    qp.selectedItems = qp.items.filter((i) => i.entry.installed);

    const refresh = (): void => {
      // Re-stat to pick up files that were just created by an edit action.
      for (const e of entries) { e.installed = fs.existsSync(e.targetPath); }
      const newItems = entries.map(buildItem);
      const stillSelectedIds = new Set(qp.selectedItems.map((i) => i.entry.id));
      // Preserve user's tick state where possible; newly-installed entries
      // become ticked automatically because the edit action implies "enable".
      for (const e of entries) { if (e.installed) { stillSelectedIds.add(e.id); } }
      qp.items = newItems;
      qp.selectedItems = newItems.filter((i) => stillSelectedIds.has(i.entry.id));
    };

    qp.onDidTriggerItemButton(async (ev) => {
      const e = ev.item.entry;
      if (ev.button === resetButton && e.installed) {
        const choice = await vscode.window.showWarningMessage(
          `Reset "${e.id}.md" to the bundled default? Local edits will be lost.`,
          { modal: true }, 'Reset',
        );
        if (choice !== 'Reset') { return; }
        try {
          fs.copyFileSync(e.libPath, e.targetPath);
          vscode.window.showInformationMessage(`Reset ${e.id}.md to bundled default.`);
        } catch (err) {
          vscode.window.showErrorMessage(
            `Reset failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        refresh();
        return;
      }
      // Edit: ensure a workspace copy exists, then open it.
      if (!e.installed) {
        try { fs.copyFileSync(e.libPath, e.targetPath); }
        catch (err) {
          vscode.window.showErrorMessage(
            `Could not enable "${e.id}" for editing: ${err instanceof Error ? err.message : String(err)}`,
          );
          return;
        }
      }
      try {
        const doc = await vscode.workspace.openTextDocument(e.targetPath);
        await vscode.window.showTextDocument(doc, { preview: false });
      } catch (err) {
        vscode.window.showErrorMessage(
          `Open failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      refresh();
    });

    const picks = await new Promise<readonly AgentItem[] | undefined>((resolve) => {
      qp.onDidAccept(() => { resolve(qp.selectedItems); qp.hide(); });
      qp.onDidHide(() => { resolve(undefined); qp.dispose(); });
      qp.show();
    });
    if (!picks) { return; }

    // Re-stat once more in case an edit action just created a file.
    for (const e of entries) { e.installed = fs.existsSync(e.targetPath); }
    const wantEnabled = new Set(picks.map((p) => p.entry.id));
    let added = 0;
    let removed = 0;
    for (const e of entries) {
      const shouldEnable = wantEnabled.has(e.id);
      if (shouldEnable && !e.installed) {
        try {
          fs.copyFileSync(e.libPath, e.targetPath);
          added++;
        } catch (err) {
          vscode.window.showWarningMessage(
            `Failed to enable "${e.id}": ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      } else if (!shouldEnable && e.installed) {
        try {
          // Only auto-remove files that match the bundled library content to
          // avoid clobbering user customisations of the same id.
          const existing = fs.readFileSync(e.targetPath, 'utf8');
          const bundled = fs.readFileSync(e.libPath, 'utf8');
          if (existing === bundled) {
            fs.unlinkSync(e.targetPath);
            removed++;
          } else {
            const choice = await vscode.window.showWarningMessage(
              `"${e.id}.md" has local edits. Remove anyway?`,
              { modal: true },
              'Remove', 'Keep',
            );
            if (choice === 'Remove') {
              fs.unlinkSync(e.targetPath);
              removed++;
            }
          }
        } catch (err) {
          vscode.window.showWarningMessage(
            `Failed to disable "${e.id}": ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
    if (added + removed === 0) {
      vscode.window.showInformationMessage('Agent skills: no changes.');
    } else {
      vscode.window.showInformationMessage(
        `Agent skills updated: +${added} enabled, -${removed} disabled. Skills hot-reload on the next prompt.`,
      );
    }
  }));

  // --- Enterprise hardening commands ---------------------------------------
  push(vscode.commands.registerCommand('prompt-proxy.healthCheck', async () => {
    const dbPath = getDbPath(context);
    try {
      const raw = runEngineRaw(['--health-check', '--db', dbPath]);
      const report = JSON.parse(raw) as {
        ok: boolean;
        schema_version: { on_disk: number; expected: number };
        sqlite: { integrity: string };
        tables: Record<string, number>;
        pragmas: Record<string, unknown>;
        size_bytes: { db: number; wal: number };
        redaction: { enabled: boolean; redact_pii: boolean };
        log_level: string;
      };
      const status = report.ok ? '$(pass) Healthy' : '$(error) Issues detected';
      const doc = await vscode.workspace.openTextDocument({
        language: 'json',
        content: `// Prompt Optimizer health report\n// ${status}\n${JSON.stringify(report, null, 2)}\n`,
      });
      await vscode.window.showTextDocument(doc, { preview: true });
    } catch (err) {
      vscode.window.showErrorMessage(
        `Health check failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }));

  push(vscode.commands.registerCommand('prompt-proxy.showMetrics', async () => {
    const dbPath = getDbPath(context);
    try {
      const raw = runEngineRaw(['--metrics', '--db', dbPath]);
      const rows = JSON.parse(raw) as Array<{ metric: string; count: number; last_at: number }>;
      if (rows.length === 0) {
        vscode.window.showInformationMessage('No metrics recorded yet. Optimize a prompt to populate counters.');
        return;
      }
      const lines = rows
        .sort((a, b) => b.count - a.count)
        .map((r) => `${r.metric.padEnd(36)} ${String(r.count).padStart(8)}  (last: ${new Date(r.last_at).toISOString()})`);
      const doc = await vscode.workspace.openTextDocument({
        language: 'plaintext',
        content: `Prompt Optimizer metrics\n${'='.repeat(72)}\n${lines.join('\n')}\n`,
      });
      await vscode.window.showTextDocument(doc, { preview: true });
    } catch (err) {
      vscode.window.showErrorMessage(
        `Show metrics failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }));

  push(vscode.commands.registerCommand('prompt-proxy.runMaintenance', async () => {
    const confirm = await vscode.window.showWarningMessage(
      'Run retention/eviction maintenance on the prompt-optimizer database?',
      { modal: true, detail: 'Default caps: 10k cache rows, 5k digests/workspace, 20k KG nodes/workspace. Stale entries older than 90 days (cache) / 180 days (digests) are pruned.' },
      'Run',
      'Run + VACUUM',
    );
    if (!confirm) return;
    const dbPath = getDbPath(context);
    try {
      const args = ['--db-prune', '--db', dbPath];
      if (confirm === 'Run + VACUUM') args.push('--vacuum');
      const raw = runEngineRaw(args);
      const report = JSON.parse(raw) as {
        evicted: Record<string, number>;
        scanned: Record<string, number>;
        vacuumed: boolean;
        duration_ms: number;
      };
      const total = Object.values(report.evicted).reduce((a, b) => a + b, 0);
      vscode.window.showInformationMessage(
        `Maintenance complete: ${total} entries evicted in ${report.duration_ms}ms${report.vacuumed ? ' (VACUUM run)' : ''}.`,
      );
    } catch (err) {
      vscode.window.showErrorMessage(
        `Maintenance failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }));

  push(vscode.commands.registerCommand('prompt-proxy.exportDatabase', async () => {
    const dbPath = getDbPath(context);
    const defaultName = `prompt-optimizer-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.db`;
    const target = await vscode.window.showSaveDialog({
      title: 'Export prompt-optimizer database',
      defaultUri: vscode.Uri.file(path.join(process.env.USERPROFILE || process.env.HOME || '.', defaultName)),
      filters: { 'SQLite database': ['db', 'sqlite'] },
    });
    if (!target) return;
    try {
      const raw = runEngineRaw(['--export-db', target.fsPath, '--db', dbPath]);
      const report = JSON.parse(raw) as { ok: boolean; bytes: number; duration_ms: number; error?: string };
      if (report.ok) {
        const open = await vscode.window.showInformationMessage(
          `Database exported (${report.bytes} bytes, ${report.duration_ms}ms).`,
          'Reveal in Explorer',
        );
        if (open) {
          await vscode.commands.executeCommand('revealFileInOS', target);
        }
      } else {
        vscode.window.showErrorMessage(`Export failed: ${report.error}`);
      }
    } catch (err) {
      vscode.window.showErrorMessage(
        `Export failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }));
}

function registerPassiveListeners(
  context: vscode.ExtensionContext,
  provider: PromptProxyViewProvider,
): void {
  /** File basenames that, when saved, trigger an immediate memory re-ingest. */
  const MEMORY_FILE_NAMES = new Set([
    'memory.md', 'knowledge.md', 'AGENTS.md', 'CLAUDE.md', 'CLAUDE.local.md',
    'copilot-instructions.md', '.cursorrules', '.clinerules',
  ]);

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      addPassiveEvent(context, 'file_saved', doc.fileName);
      // Reactive memory ingestion: refresh the workspace_memory table when
      // the user edits any well-known instruction / memory file.
      const base = doc.fileName.split(/[\\/]/).pop() ?? '';
      if (MEMORY_FILE_NAMES.has(base)) {
        void (async () => {
          await ingestMemoryFiles(context);
          provider.refreshStatusOverview();
        })();
      }
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor?.document.uri.scheme === 'file') {
        addPassiveEvent(context, 'editor_switch', editor.document.fileName);
      }
    }),
  );
}
