import * as child_process from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

const CHAT_PARTICIPANT_ID = 'pawanbalapure.promptoptimizer';
const SESSION_BUFFER_KEY = 'promptProxy.history';
const LAST_ANALYSIS_KEY = 'promptProxy.lastAnalysis';
const MAX_SESSION_ITEMS = 8;
const MAX_CHAT_HISTORY_ITEMS = 6;

/** Patterns that may indicate accidental secret exposure in a prompt. */
const SECRET_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: 'OpenAI API key', pattern: /\bsk-[a-zA-Z0-9]{20,}\b/ },
  { label: 'Anthropic API key', pattern: /\bsk-ant-[a-zA-Z0-9]{20,}\b/ },
  { label: 'GitHub token', pattern: /\bghp_[a-zA-Z0-9]{36}\b|\bghs_[a-zA-Z0-9]{36}\b/ },
  { label: 'AWS access key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: 'Private key header', pattern: /-----BEGIN (?:RSA|EC|OPENSSH|DSA) PRIVATE KEY-----/ },
  { label: 'Generic secret/token assignment', pattern: /(?:password|secret|token|api_?key)\s*[=:]\s*['"]?[a-zA-Z0-9+\/=_\-]{16,}['"]?/i },
];

function scanForSecrets(prompt: string): string[] {
  const config = vscode.workspace.getConfiguration('promptProxy');
  if (!config.get<boolean>('enableSecretDetection')) { return []; }

  const custom = config.get<Array<{ label?: string; pattern: string }>>('secretPatterns') ?? [];
  const allPatterns = [...SECRET_PATTERNS];
  for (const entry of custom) {
    try {
      allPatterns.push({ label: entry.label || 'Custom pattern', pattern: new RegExp(entry.pattern, 'i') });
    } catch { /* invalid regex — skip silently */ }
  }

  return allPatterns.filter((s) => s.pattern.test(prompt)).map((s) => s.label);
}

const SEEDING_DONE_KEY = 'promptProxy.seeded';
/** Re-seed at most once every 24 h to pick up new Copilot history. */
const SEEDING_INTERVAL_MS = 24 * 60 * 60 * 1000;

// ── Conversation memory ───────────────────────────────────────────────────────
const CONVERSATION_KEY = 'promptProxy.conversation';
const MAX_CONVERSATION_TURNS = 12;

// ── Proxy mode ───────────────────────────────────────────────────────────────
const MODE_KEY = 'promptProxy.mode';
type ProxyMode = 'agent' | 'optimize' | 'direct';

function getCurrentMode(context: vscode.ExtensionContext): ProxyMode {
  return context.globalState.get<ProxyMode>(MODE_KEY) ?? 'agent';
}

function updateStatusBarItem(item: vscode.StatusBarItem, mode: ProxyMode): void {
  const labels: Record<ProxyMode, string> = {
    agent: '$(robot) Proxy [Agent]',
    optimize: '$(wand) Proxy [Optimize]',
    direct: '$(comment-discussion) Proxy [Direct]',
  };
  item.text = labels[mode];
  item.tooltip = `Prompt Optimizer: ${mode} mode — click to change`;
  item.command = 'prompt-proxy.selectMode';
}

interface ConversationTurn {
  id: string;
  timestamp: number;
  user_raw: string;
  user_optimized: string;
  assistant: string;
  workspace_id: string;
}

function getConversation(context: vscode.ExtensionContext, workspaceId?: string): ConversationTurn[] {
  const all = context.globalState.get<ConversationTurn[]>(CONVERSATION_KEY) ?? [];
  if (!workspaceId) { return all; }
  return all.filter((t) => t.workspace_id === workspaceId || t.workspace_id === 'global');
}

async function addConversationTurn(
  context: vscode.ExtensionContext,
  workspaceId: string,
  turn: { user_raw: string; user_optimized: string; assistant: string }
): Promise<void> {
  const all = context.globalState.get<ConversationTurn[]>(CONVERSATION_KEY) ?? [];
  all.push({
    id: Date.now().toString(36),
    timestamp: Date.now(),
    workspace_id: workspaceId,
    ...turn,
  });
  // Keep at most MAX_CONVERSATION_TURNS per workspace, overall cap of 3×.
  while (all.length > MAX_CONVERSATION_TURNS * 3) { all.shift(); }
  await context.globalState.update(CONVERSATION_KEY, all);
}

/** True if the prompt is short and uses pronouns that reference prior context. */
function containsBackReference(prompt: string): boolean {
  return (
    prompt.split(/\s+/).length <= 20 &&
    /\b(it|that|this|those|them|the same|the file|the function|the class|the error|the bug|previous|last one|aforementioned)\b/i.test(prompt)
  );
}

/** Prepend the most recent user request as context when the prompt references it. */
function resolveReferences(prompt: string, history: ConversationTurn[]): string {
  if (!containsBackReference(prompt) || history.length === 0) { return prompt; }
  const last = history[history.length - 1];
  const ref = last.user_raw.length > 180 ? last.user_raw.slice(0, 180) + '…' : last.user_raw;
  return `[Continuing from: "${ref}"]\n${prompt}`;
}

/**
 * Build the message array for the VS Code LM API call.
 * Injects a workspace context preamble then replays the conversation history
 * before the current optimized prompt.
 */
function buildLMMessages(
  history: ConversationTurn[],
  currentPrompt: string,
  state: PromptProxyPanelState
): vscode.LanguageModelChatMessage[] {
  const msgs: vscode.LanguageModelChatMessage[] = [];

  // Context preamble (expressed as the first user message since not all
  // LM providers expose a separate system role).
  const ctxLines = ['You are a helpful coding assistant working inside VS Code.'];
  if (state.analysis.context.workspace_root) {
    ctxLines.push(`Workspace: ${state.analysis.context.workspace_root}`);
  }
  if (state.analysis.context.active_file) {
    ctxLines.push(`Active file: ${state.analysis.context.active_file}`);
  }
  msgs.push(vscode.LanguageModelChatMessage.User(ctxLines.join('\n')));
  msgs.push(vscode.LanguageModelChatMessage.Assistant('Understood. Ready to help.'));

  // Replay up to 8 previous turns.
  for (const turn of history.slice(-8)) {
    msgs.push(vscode.LanguageModelChatMessage.User(turn.user_optimized));
    if (turn.assistant) {
      msgs.push(vscode.LanguageModelChatMessage.Assistant(turn.assistant));
    }
  }

  msgs.push(vscode.LanguageModelChatMessage.User(currentPrompt));
  return msgs;
}

/** Simple djb2 hash to derive a stable workspace ID from the folder path. */
function computeWorkspaceId(workspaceRoot?: string): string {
  if (!workspaceRoot) { return 'global'; }
  let hash = 5381;
  for (let i = 0; i < workspaceRoot.length; i++) {
    hash = ((hash << 5) + hash) ^ workspaceRoot.charCodeAt(i);
    hash = hash >>> 0; // keep 32-bit unsigned
  }
  return hash.toString(16);
}

type PromptSource = 'panel' | 'chat' | 'clipboard';

interface PromptProxyMetrics {
  raw_input_tokens: number;
  optimized_input_tokens: number;
  tokens_saved: number;
  estimated_output_tokens: number;
  estimated_cost_usd: number;
}

interface PromptProxyAnalysis {
  cache: {
    status: 'exact' | 'semantic' | 'miss';
    confidence: number;
    candidates: Array<{
      raw_prompt: string;
      confidence: number;
      timestamp: number;
    }>;
  };
  context: {
    workspace_root?: string;
    active_file?: string;
    selected_files: string[];
    selected_logs: string[];
    log_sources: string[];
    open_file_count: number;
    total_log_count: number;
  };
  cost: {
    input_cost_usd: number;
    output_cost_usd: number;
    total_cost_usd: number;
    input_cost_per_1k_tokens: number;
    output_cost_per_1k_tokens: number;
  };
}

interface PromptProxyResponse {
  metrics: PromptProxyMetrics;
  optimized_prompt: string;
  improvements: string[];
  analysis: PromptProxyAnalysis;
}

interface SessionBufferedPrompt {
  prompt: string;
  optimized_prompt: string;
  timestamp: number;
  source: PromptSource;
  estimated_cost_usd: number;
  tokens_saved: number;
  cache_status: PromptProxyAnalysis['cache']['status'];
}

interface PromptProxyPanelState {
  original: string;
  optimized: string;
  source: PromptSource;
  generated_at: number;
  metrics: PromptProxyMetrics;
  improvements: string[];
  analysis: PromptProxyAnalysis;
  warnings?: string[];
}

interface RuntimeSnapshot {
  active_file?: string;
  open_file_count: number;
  log_sources: string[];
  chat_history_turns: number;
  session_buffer: SessionBufferedPrompt[];
  last_analysis?: PromptProxyPanelState;
}

export function activate(context: vscode.ExtensionContext) {
  const provider = new PromptProxyViewProvider(context.extensionUri, context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(PromptProxyViewProvider.viewType, provider, {
      webviewOptions: {
        retainContextWhenHidden: true,
      },
    })
  );

  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  updateStatusBarItem(statusBarItem, getCurrentMode(context));
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  context.subscriptions.push(
    vscode.commands.registerCommand('prompt-proxy.toggleStatusPanel', () => {
      ProxyStatusPanel.toggle(context, provider);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('prompt-proxy.selectMode', async () => {
      type ModeItem = vscode.QuickPickItem & { value: ProxyMode };
      const current = getCurrentMode(context);
      const items: ModeItem[] = [
        {
          label: '$(robot) Agent',
          description: 'Optimize + call Copilot automatically — no @promptoptimizer prefix needed',
          detail: current === 'agent' ? '● Active' : undefined,
          value: 'agent',
        },
        {
          label: '$(wand) Optimize only',
          description: 'Show analysis, copy / send buttons — you control when it goes to Copilot',
          detail: current === 'optimize' ? '● Active' : undefined,
          value: 'optimize',
        },
        {
          label: '$(comment-discussion) Direct send',
          description: 'Pre-fill @promptoptimizer in the Chat panel and press Enter',
          detail: current === 'direct' ? '● Active' : undefined,
          value: 'direct',
        },
      ];
      const picked = await vscode.window.showQuickPick(items as vscode.QuickPickItem[], {
        placeHolder: 'Select default Prompt Optimizer mode',
        matchOnDescription: true,
      }) as ModeItem | undefined;
      if (!picked) { return; }
      await context.globalState.update(MODE_KEY, picked.value);
      updateStatusBarItem(statusBarItem, picked.value);
      provider.notifyModeChange(picked.value);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('prompt-proxy.focusPanel', async () => {
      await openPromptProxyPanel();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('prompt-proxy.startChat', async () => {
      await openChatWithPrompt('', true);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('prompt-proxy.optimizeClipboard', async () => {
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
          `Prompt Optimizer saved ${state.metrics.tokens_saved} tokens. Estimated cost ${formatCurrency(state.metrics.estimated_cost_usd)}.`
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Prompt Optimizer failed to optimize the clipboard prompt: ${message}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('prompt-proxy.copyPrompt', async (prompt?: string) => {
      const text = prompt ?? getLastAnalysis(context)?.optimized;
      if (!text) {
        vscode.window.showWarningMessage('No optimized prompt is available yet.');
        return;
      }

      await vscode.env.clipboard.writeText(text);
      vscode.window.showInformationMessage('Prompt Optimizer copied the optimized prompt to the clipboard.');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('prompt-proxy.sendPromptToChat', async (prompt?: string) => {
      const text = prompt ?? getLastAnalysis(context)?.optimized;
      if (!text) {
        vscode.window.showWarningMessage('No optimized prompt is available yet.');
        return;
      }

      await openChatWithPrompt(text, false);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('prompt-proxy.openReadme', async () => {
      await openExtensionReadme(context);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('prompt-proxy.cacheStats', async () => {
      const dbPath = getDbPath(context);
      try {
        const result = runEngineRaw(['--cache-stats', '--db', dbPath]);
        const stats = JSON.parse(result) as { total_entries?: number; avg_confidence?: number; total_hits?: number };
        vscode.window.showInformationMessage(
          `Cache: ${stats.total_entries ?? 0} entries | avg confidence ${((stats.avg_confidence ?? 0) * 100).toFixed(1)}% | ${stats.total_hits ?? 0} total hits`
        );
      } catch (err) {
        vscode.window.showErrorMessage(`Cache stats failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('prompt-proxy.clearCache', async () => {
      const confirm = await vscode.window.showWarningMessage(
        'Clear the Prompt Optimizer semantic cache? This cannot be undone.',
        { modal: true },
        'Clear'
      );
      if (confirm !== 'Clear') { return; }
      const dbPath = getDbPath(context);
      try {
        runEngineRaw(['--clear-cache', '--db', dbPath]);
        vscode.window.showInformationMessage('Prompt Optimizer cache cleared.');
      } catch (err) {
        vscode.window.showErrorMessage(`Cache clear failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('prompt-proxy.clearMemory', async () => {
      const workspaceRoot2 = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const wsId = computeWorkspaceId(workspaceRoot2);
      const all = context.globalState.get<ConversationTurn[]>(CONVERSATION_KEY) ?? [];
      const kept = all.filter((t) => t.workspace_id !== wsId);
      await context.globalState.update(CONVERSATION_KEY, kept);
      vscode.window.showInformationMessage('Prompt Optimizer conversation memory cleared.');
    })
  );

  // Passive event hooks — silently enrich the session context.
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      addPassiveEvent(context, 'file_saved', doc.fileName);
    })
  );

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor?.document.uri.scheme === 'file') {
        addPassiveEvent(context, 'editor_switch', editor.document.fileName);
      }
    })
  );

  const participant = vscode.chat.createChatParticipant(
    CHAT_PARTICIPANT_ID,
    async (request, chatContext, stream, token) => handleChatRequest(context, provider, statusBarItem, request, chatContext, stream, token)
  );
  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'images', 'icon.png');
  participant.followupProvider = {
    provideFollowups: (_result, _chatContext, _token) => {
      const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const wsId = computeWorkspaceId(wsRoot);
      const hist = getConversation(context, wsId);
      const followups: vscode.ChatFollowup[] = [];
      if (hist.length > 0) {
        followups.push({ prompt: '/memory', label: `View memory (${hist.length} turn${hist.length === 1 ? '' : 's'})` });
        followups.push({ prompt: '/clear', label: 'Clear conversation memory' });
      }
      followups.push({ prompt: '/context Show what local context Prompt Optimizer can read right now.', label: 'Show workspace context' });
      return followups;
    },
  };
  context.subscriptions.push(participant);

  // Seed the cache in the background 3 s after activation so startup is not blocked.
  setTimeout(() => { seedCacheFromWorkspace(context).catch(() => {}); }, 3000);
}

export function deactivate() {}

async function handleChatRequest(
  context: vscode.ExtensionContext,
  provider: PromptProxyViewProvider,
  statusBarItem: vscode.StatusBarItem,
  request: vscode.ChatRequest,
  chatContext: vscode.ChatContext,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken
): Promise<vscode.ChatResult> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const workspaceId = computeWorkspaceId(workspaceRoot);

  // ── /context command ────────────────────────────────────────────────────────
  if (request.command === 'context') {
    const runtime = buildRuntimeSnapshot(context, chatContext);
    stream.markdown(renderContextReportMarkdown(runtime));
    stream.button({ command: 'prompt-proxy.focusPanel', title: 'Open control panel' });
    stream.button({ command: 'prompt-proxy.openReadme', title: 'Open README' });
    return { metadata: { command: 'context' } };
  }

  // ── /memory command ─────────────────────────────────────────────────────────
  if (request.command === 'memory') {
    const history = getConversation(context, workspaceId);
    if (history.length === 0) {
      stream.markdown('No conversation memory yet. Start chatting with `@promptoptimizer` to build context across turns.');
    } else {
      stream.markdown(`**Conversation memory** — ${history.length} turn${history.length === 1 ? '' : 's'} remembered\n\n`);
      for (const [i, turn] of history.entries()) {
        const ago = Math.round((Date.now() - turn.timestamp) / 60000);
        stream.markdown(`**Turn ${i + 1}** *(${ago < 2 ? 'just now' : `${ago} min ago`})*\n\n`);
        stream.markdown(`> You: ${turn.user_raw.slice(0, 200)}\n\n`);
        stream.markdown(`> Assistant: ${turn.assistant.slice(0, 300)}${turn.assistant.length > 300 ? '…' : ''}\n\n---\n\n`);
      }
    }
    stream.button({ command: 'prompt-proxy.clearMemory', title: 'Clear memory' });
    return { metadata: { command: 'memory' } };
  }

  // ── /clear command ───────────────────────────────────────────────────────────
  if (request.command === 'clear') {
    const all = context.globalState.get<ConversationTurn[]>(CONVERSATION_KEY) ?? [];
    const kept = all.filter((t) => t.workspace_id !== workspaceId);
    await context.globalState.update(CONVERSATION_KEY, kept);
    stream.markdown('Conversation memory for this workspace has been cleared.');
    return { metadata: { command: 'clear' } };
  }

  // ── /mode command ────────────────────────────────────────────────────────────
  if (request.command === 'mode') {
    const arg = request.prompt.trim().toLowerCase() as ProxyMode;
    if (arg === 'agent' || arg === 'optimize' || arg === 'direct') {
      await context.globalState.update(MODE_KEY, arg);
      updateStatusBarItem(statusBarItem, arg);
      provider.notifyModeChange(arg);
      const modeDescriptions: Record<ProxyMode, string> = {
        agent: 'optimize + call Copilot automatically (no `@promptoptimizer` prefix needed in the sidebar)',
        optimize: 'show analysis only — you control when it goes to Copilot',
        direct: 'pre-fill `@promptoptimizer` in Chat and press Enter',
      };
      stream.markdown(`Mode set to **${arg}** — ${modeDescriptions[arg]}.\n\nThis applies to the sidebar panel. In the Chat panel, any message to \`@promptoptimizer\` still follows the same mode.`);
    } else {
      const current = getCurrentMode(context);
      stream.markdown(
        `**Current mode: ${current}**\n\n` +
        'Available modes:\n' +
        '- `agent` — optimize + call Copilot automatically\n' +
        '- `optimize` — show optimization analysis only\n' +
        '- `direct` — open @promptoptimizer chat with prompt pre-filled\n\n' +
        'Usage: `@promptoptimizer /mode agent`'
      );
    }
    return { metadata: { command: 'mode' } };
  }

  // ── Prompt optimization + LM agent ──────────────────────────────────────────
  const prompt = request.prompt.trim();
  if (!prompt) {
    stream.markdown(
      'Enter a prompt or use `/context` to inspect your workspace context, `/memory` to review conversation history, or `/clear` to reset it.'
    );
    return { metadata: { command: request.command ?? 'optimize' } };
  }

  stream.progress('Checking the local semantic cache and packing workspace context…');
  const state = await analyzePrompt(context, prompt, 'chat', chatContext);

  if (token.isCancellationRequested) {
    return { metadata: { command: request.command ?? 'optimize' } };
  }

  provider.publishAnalysis(state);

  // Brief optimization summary header.
  const savedPct = state.metrics.raw_input_tokens > 0
    ? Math.round((state.metrics.tokens_saved / state.metrics.raw_input_tokens) * 100)
    : 0;
  if (state.metrics.tokens_saved > 0) {
    stream.markdown(
      `> ✦ *Prompt optimized — ${state.metrics.tokens_saved} tokens saved (${savedPct}%), estimated cost ${formatCurrency(state.metrics.estimated_cost_usd)}*\n\n`
    );
  }

  // Resolve any back-references ("do the same for it", "fix that bug") using memory.
  const history = getConversation(context, workspaceId);
  const enrichedPrompt = resolveReferences(state.optimized, history);

  // ── Attempt LM API call ─────────────────────────────────────────────────────
  let lmSucceeded = false;
  try {
    const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    if (models.length > 0 && !token.isCancellationRequested) {
      const messages = buildLMMessages(history, enrichedPrompt, state);
      const lmResponse = await models[0].sendRequest(messages, {}, token);

      let fullResponse = '';
      for await (const chunk of lmResponse.text) {
        stream.markdown(chunk);
        fullResponse += chunk;
      }
      fullResponse = fullResponse.trim();

      if (fullResponse) {
        await addConversationTurn(context, workspaceId, {
          user_raw: prompt,
          user_optimized: enrichedPrompt,
          assistant: fullResponse,
        });
        lmSucceeded = true;

        // If the assistant ended with a question, surface a quick reply button.
        const lastLines = fullResponse.split('\n').slice(-4).join(' ');
        if (/\?\s*$/.test(lastLines)) {
          stream.button({ command: 'prompt-proxy.startChat', title: 'Reply ↵' });
        }
      }
    }
  } catch { /* LM not available or cancelled — fall through to buttons */ }

  // ── Fallback when no LM available ──────────────────────────────────────────
  if (!lmSucceeded) {
    stream.markdown(renderChatAnalysisMarkdown(state, request.command ?? 'optimize'));
    addContextReferences(stream, state.analysis.context);
    stream.button({
      command: 'prompt-proxy.copyPrompt',
      title: 'Copy optimized prompt',
      arguments: [state.optimized],
    });
    stream.button({
      command: 'prompt-proxy.sendPromptToChat',
      title: 'Open optimized prompt in chat',
      arguments: [state.optimized],
    });
  }

  stream.button({ command: 'prompt-proxy.focusPanel', title: 'Open control panel' });

  return {
    metadata: {
      command: request.command ?? 'optimize',
      cache: state.analysis.cache.status,
      estimatedCostUSD: state.metrics.estimated_cost_usd,
    },
  };
}

async function analyzePrompt(
  context: vscode.ExtensionContext,
  rawPrompt: string,
  source: PromptSource,
  chatContext?: vscode.ChatContext
): Promise<PromptProxyPanelState> {
  // Secret detection — warn in UI (non-blocking).
  const secrets = scanForSecrets(rawPrompt);
  if (secrets.length > 0) {
    vscode.window.showWarningMessage(
      `Prompt Optimizer detected possible secrets in your prompt: ${secrets.join(', ')}. Review before sending to any AI service.`
    );
  }

  const dbPath = getDbPath(context);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const request = {
    raw_prompt: rawPrompt,
    mode: getProcessingMode(),
    pricing: getPricingConfig(),
    ide_context: getIdeContext(context, chatContext),
    workspace_id: computeWorkspaceId(workspaceRoot),
  };

  const response = runEngine(request, dbPath);

  // Belt-and-suspenders: strip any # Problems / diagnostics block that may
  // have survived via a stale cache entry or been carried in the raw input.
  const optimizedClean = response.optimized_prompt
    .replace(/(?:^|\n\n)# Problems\n[\s\S]*?(?=\n\n#|\s*$)/g, '')
    .trim();

  const state: PromptProxyPanelState = {
    original: rawPrompt,
    optimized: optimizedClean,
    source,
    generated_at: Date.now(),
    metrics: response.metrics,
    improvements: response.improvements,
    analysis: response.analysis,
    warnings: secrets.map((s) => `Possible secret detected: ${s}. Review before sending.`),
  };

  await addToSessionBuffer(context, state);

  ProxyStatusPanel.current?.publishAnalysis(state);

  return state;
}

function buildRuntimeSnapshot(context: vscode.ExtensionContext, chatContext?: vscode.ChatContext): RuntimeSnapshot {
  const ideContext = getIdeContext(context, chatContext);
  return {
    active_file: ideContext.active_file?.path,
    open_file_count: ideContext.active_file ? ideContext.open_files.length + 1 : ideContext.open_files.length,
    log_sources: ideContext.logs.map((log: { source: string }) => log.source),
    chat_history_turns: chatContext?.history.length ?? 0,
    session_buffer: getSessionBuffer(context),
    last_analysis: getLastAnalysis(context),
  };
}

function getDbPath(context: vscode.ExtensionContext): string {
  const config = vscode.workspace.getConfiguration('promptProxy');
  const configuredPath = config.get<string>('dbPath');
  if (configuredPath && configuredPath.trim() !== '') {
    return path.resolve(configuredPath);
  }

  return path.resolve(context.globalStorageUri.fsPath, 'prompt_semantic_cache.db');
}

function getPricingConfig(): { input_cost_per_1k_tokens: number; output_cost_per_1k_tokens: number } {
  const config = vscode.workspace.getConfiguration('promptProxy');
  return {
    input_cost_per_1k_tokens: config.get<number>('pricingInput') ?? 0.0015,
    output_cost_per_1k_tokens: config.get<number>('pricingOutput') ?? 0.002,
  };
}

function getProcessingMode(): string {
  const config = vscode.workspace.getConfiguration('promptProxy');
  return config.get<string>('processingMode') ?? 'blocking';
}

function getSessionBuffer(context: vscode.ExtensionContext): SessionBufferedPrompt[] {
  // globalState persists across workspace switches and restarts.
  return context.globalState.get<SessionBufferedPrompt[]>(SESSION_BUFFER_KEY) ?? [];
}

function getLastAnalysis(context: vscode.ExtensionContext): PromptProxyPanelState | undefined {
  return context.globalState.get<PromptProxyPanelState>(LAST_ANALYSIS_KEY);
}

async function addToSessionBuffer(context: vscode.ExtensionContext, state: PromptProxyPanelState): Promise<void> {
  const config = vscode.workspace.getConfiguration('promptProxy');
  if (!config.get<boolean>('enableSessionContext')) {
    return;
  }

  const history = getSessionBuffer(context);
  history.push({
    prompt: state.original,
    optimized_prompt: state.optimized,
    timestamp: state.generated_at,
    source: state.source,
    estimated_cost_usd: state.metrics.estimated_cost_usd,
    tokens_saved: state.metrics.tokens_saved,
    cache_status: state.analysis.cache.status,
  });

  while (history.length > MAX_SESSION_ITEMS) {
    history.shift();
  }

  await Promise.all([
    context.globalState.update(SESSION_BUFFER_KEY, history),
    context.globalState.update(LAST_ANALYSIS_KEY, state),
  ]);
}

function addPassiveEvent(context: vscode.ExtensionContext, eventType: string, detail: string): void {
  const PASSIVE_KEY = 'promptProxy.passiveEvents';
  const MAX_PASSIVE = 20;
  const events = context.globalState.get<Array<{ type: string; detail: string; ts: number }>>(PASSIVE_KEY) ?? [];
  events.push({ type: eventType, detail: path.basename(detail), ts: Date.now() });
  while (events.length > MAX_PASSIVE) { events.shift(); }
  context.globalState.update(PASSIVE_KEY, events);
}

function getSessionHistoryLogs(context: vscode.ExtensionContext): Array<{ source: string; kind: string; content: string }> {
  const config = vscode.workspace.getConfiguration('promptProxy');
  if (!config.get<boolean>('enableSessionContext')) {
    return [];
  }

  const history = getSessionBuffer(context);
  if (history.length === 0) {
    return [];
  }

  const content = history
    .map((item, index) => {
      const turnNumber = index + 1;
      return [
        `Turn ${turnNumber} [${item.source}]`,
        `Prompt: ${trimForDisplay(item.prompt, 180)}`,
        `Optimized: ${trimForDisplay(item.optimized_prompt, 180)}`,
        `Cache: ${item.cache_status}; Saved: ${item.tokens_saved} tokens; Cost: ${formatCurrency(item.estimated_cost_usd)}`,
      ].join('\n');
    })
    .join('\n\n');

  return [
    {
      source: 'Prompt Optimizer Session Buffer',
      kind: 'general',
      content,
    },
  ];
}

function getChatHistoryLogs(chatContext?: vscode.ChatContext): Array<{ source: string; kind: string; content: string }> {
  if (!chatContext || chatContext.history.length === 0) {
    return [];
  }

  const content = chatContext.history
    .slice(-MAX_CHAT_HISTORY_ITEMS)
    .map((turn, index) => `${index + 1}. ${extractChatTurnText(turn)}`)
    .filter((value) => value.trim() !== '')
    .join('\n');

  if (content.trim() === '') {
    return [];
  }

  return [
    {
      source: 'Prompt Optimizer Chat History',
      kind: 'general',
      content,
    },
  ];
}

function extractChatTurnText(turn: vscode.ChatRequestTurn | vscode.ChatResponseTurn): string {
  if (turn instanceof vscode.ChatRequestTurn) {
    return `User: ${trimForDisplay(turn.prompt, 240)}`;
  }

  const parts = turn.response.map((part) => {
    if (part instanceof vscode.ChatResponseMarkdownPart) {
      return part.value.value;
    }

    if (part instanceof vscode.ChatResponseAnchorPart) {
      return part.title ?? locationToText(part.value);
    }

    if (part instanceof vscode.ChatResponseFileTreePart) {
      return `[file tree: ${part.value.map((node) => node.name).join(', ')}]`;
    }

    if (part instanceof vscode.ChatResponseCommandButtonPart) {
      return `[button: ${part.value.title}]`;
    }

    return '';
  });

  return `Assistant: ${trimForDisplay(parts.join(' '), 320)}`;
}

function getIdeContext(context: vscode.ExtensionContext, chatContext?: vscode.ChatContext): {
  workspace_root?: string;
  active_file?: {
    path: string;
    content: string;
    is_active: boolean;
    selection: string;
    language: string;
  };
  open_files: Array<{
    path: string;
    content: string;
    selection: string;
    language: string;
    is_active: boolean;
  }>;
  logs: Array<{ source: string; kind: string; content: string }>;
} {
  const ideContext = {
    workspace_root: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    active_file: undefined as {
      path: string;
      content: string;
      is_active: boolean;
      selection: string;
      language: string;
    } | undefined,
    open_files: [] as Array<{
      path: string;
      content: string;
      selection: string;
      language: string;
      is_active: boolean;
    }>,
    logs: [] as Array<{ source: string; kind: string; content: string }>,
  };

  const activeEditor = vscode.window.activeTextEditor;
  if (activeEditor) {
    ideContext.active_file = {
      path: activeEditor.document.uri.fsPath,
      content: activeEditor.document.getText(),
      is_active: true,
      selection: activeEditor.document.getText(activeEditor.selection),
      language: activeEditor.document.languageId,
    };
  }

  for (const editor of vscode.window.visibleTextEditors) {
    if (editor === activeEditor) {
      continue;
    }

    ideContext.open_files.push({
      path: editor.document.uri.fsPath,
      content: editor.document.getText(),
      selection: editor.document.getText(editor.selection),
      language: editor.document.languageId,
      is_active: false,
    });
  }

  ideContext.logs.push(...getSessionHistoryLogs(context));
  ideContext.logs.push(...getChatHistoryLogs(chatContext));

  return ideContext;
}

function findSystemNode(): string {
  // VS Code's process.execPath is the Electron binary whose embedded Node ABI
  // (NODE_MODULE_VERSION) differs from the ABI system Node was compiled with.
  // better-sqlite3 is a native module compiled for system Node, so we must
  // find the system node executable and use that to run the CLI sidecar.
  const probe = (exe: string): boolean => {
    try {
      const r = child_process.spawnSync(exe, ['--version'], { encoding: 'utf8', shell: false, env: process.env });
      return r.status === 0 && typeof r.stdout === 'string' && r.stdout.trim().startsWith('v');
    } catch {
      return false;
    }
  };

  const name = process.platform === 'win32' ? 'node.exe' : 'node';
  if (probe(name)) {
    return name;
  }

  // Explicit common Windows install paths when node is not on PATH
  if (process.platform === 'win32') {
    const candidates = [
      'C:\\Program Files\\nodejs\\node.exe',
      'C:\\Program Files (x86)\\nodejs\\node.exe',
    ];
    for (const p of candidates) {
      if (fs.existsSync(p) && probe(p)) {
        return p;
      }
    }
  }

  // Last resort: the Electron binary itself; will fail for native modules
  // compiled against a different ABI but is better than throwing here.
  return process.execPath;
}

function runEngine(request: unknown, dbPath: string): PromptProxyResponse {
  const cliPath = path.resolve(__dirname, '../engine/dist/cli.js');
  const nodeExe = findSystemNode();
  const child = child_process.spawnSync(nodeExe, [cliPath, '--stdin', '--db', dbPath], {
    input: JSON.stringify(request),
    encoding: 'utf8',
    env: process.env,
  });

  if (child.status !== 0) {
    const stderr = child.stderr ? child.stderr.trim() : '';
    const hint = stderr.includes('NODE_MODULE_VERSION')
      ? ' (native module ABI mismatch – ensure "node" on PATH is the same version used to install the extension)'
      : '';
    throw new Error((stderr || 'CLI subprocess exited with an error.') + hint);
  }

  try {
    return JSON.parse(child.stdout.trim()) as PromptProxyResponse;
  } catch {
    throw new Error(`Invalid JSON returned from the engine CLI: ${child.stdout}`);
  }
}

/** Run CLI with arbitrary flags. Pass `input` for modes that read stdin. */
function runEngineRaw(args: string[], input?: string): string {
  const cliPath = path.resolve(__dirname, '../engine/dist/cli.js');
  const nodeExe = findSystemNode();
  const child = child_process.spawnSync(nodeExe, [cliPath, ...args], {
    input,
    encoding: 'utf8',
    env: process.env,
  });

  if (child.status !== 0) {
    throw new Error(child.stderr?.trim() || 'CLI subprocess exited with an error.');
  }

  return child.stdout.trim();
}

/**
 * On activation, harvest prompts from multiple sources (git log, Copilot Chat
 * history, README, package.json, AI instruction files) and batch-seed the local
 * semantic cache so the very first user prompt benefits from prior context.
 * Runs in the background; errors are silently swallowed.
 */
async function seedCacheFromWorkspace(context: vscode.ExtensionContext): Promise<void> {
  try {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const workspaceId = computeWorkspaceId(workspaceRoot);
    const seededKey = `${SEEDING_DONE_KEY}.${workspaceId}`;
    const lastSeeded = context.globalState.get<number>(seededKey) ?? 0;
    if (Date.now() - lastSeeded < SEEDING_INTERVAL_MS) { return; }

    const seeds: string[] = [];

    // 1. Existing Copilot / VS Code chat history stored in state.vscdb.
    try {
      // globalStorageUri is like …/globalStorage/<extensionId>;
      // state.vscdb sits one level up inside globalStorage/.
      const vscodePath = path.dirname(context.globalStorageUri.fsPath);
      const raw = runEngineRaw(['--read-chat-history', '--vscode-path', vscodePath]);
      const chatPrompts = JSON.parse(raw) as string[];
      seeds.push(...chatPrompts);
    } catch { /* not available or DB locked */ }

    if (workspaceRoot) {
      // 2. Git commit messages — reflect what the developer works on daily.
      try {
        const git = child_process.spawnSync('git', ['log', '--pretty=format:%s%n%b', '-n', '80'], {
          cwd: workspaceRoot, encoding: 'utf8', timeout: 5000,
        });
        if (git.status === 0) {
          seeds.push(
            ...git.stdout.split('\n')
              .map((l) => l.trim())
              .filter((l) => l.length >= 15 && l.length <= 300)
          );
        }
      } catch { /* git not available */ }

      // 3. AI / Copilot instruction files.
      for (const rel of [
        '.github/copilot-instructions.md', 'AGENTS.md', 'CLAUDE.md',
        '.cursorrules', '.copilot-instructions.md', 'copilot-instructions.md',
      ]) {
        try {
          const full = path.join(workspaceRoot, rel);
          if (fs.existsSync(full)) {
            const lines = fs.readFileSync(full, 'utf8').split('\n');
            seeds.push(
              ...lines
                .map((l) => l.replace(/^[-*#>\s]+/, '').trim())
                .filter((l) => l.length >= 20 && l.length <= 300)
            );
          }
        } catch { /* missing or unreadable */ }
      }

      // 4. package.json — project description and script names.
      try {
        const pkgPath = path.join(workspaceRoot, 'package.json');
        if (fs.existsSync(pkgPath)) {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as Record<string, unknown>;
          if (typeof pkg.description === 'string' && pkg.description.length > 10) {
            seeds.push(`Explain ${pkg.name ?? 'this project'}: ${pkg.description}`);
          }
          for (const name of Object.keys((pkg.scripts ?? {}) as Record<string, unknown>)) {
            seeds.push(`What does the npm ${name} script do and when should I run it?`);
          }
        }
      } catch { /* invalid JSON */ }

      // 5. README.md — project-specific natural-language fragments.
      try {
        const readmePath = path.join(workspaceRoot, 'README.md');
        if (fs.existsSync(readmePath)) {
          const lines = fs.readFileSync(readmePath, 'utf8').slice(0, 5000).split('\n');
          seeds.push(
            ...lines
              .map((l) => l.replace(/^[#*\->|\s]+/, '').trim())
              .filter((l) => l.length >= 30 && l.length <= 300 && !l.startsWith('!'))
          );
        }
      } catch { /* missing */ }
    }

    const unique = [...new Set(
      seeds.map((s) => s.trim()).filter((s) => s.length >= 15 && s.length <= 400)
    )].slice(0, 200);

    if (unique.length === 0) {
      await context.globalState.update(seededKey, Date.now());
      return;
    }

    const dbPath = getDbPath(context);
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    runEngineRaw(
      ['--seed-batch', '--db', dbPath, '--workspace-id', workspaceId],
      JSON.stringify(unique)
    );

    await context.globalState.update(seededKey, Date.now());
  } catch { /* never surface seeding errors to the user */ }
}

async function openPromptProxyPanel(): Promise<void> {
  await vscode.commands.executeCommand(`${PromptProxyViewProvider.viewType}.focus`);
}

async function openChatWithPrompt(prompt: string, mentionParticipant: boolean): Promise<void> {
  const prefix = mentionParticipant ? '@promptoptimizer ' : '';
  await vscode.commands.executeCommand('workbench.action.chat.open', {
    query: `${prefix}${prompt}`.trim(),
  });
}

async function openExtensionReadme(context: vscode.ExtensionContext): Promise<void> {
  const readmePath = path.resolve(context.extensionPath, 'README.md');
  if (!fs.existsSync(readmePath)) {
    vscode.window.showWarningMessage('Prompt Optimizer README.md was not found in the extension package.');
    return;
  }

  const document = await vscode.workspace.openTextDocument(readmePath);
  await vscode.window.showTextDocument(document, { preview: false });
}

function renderChatAnalysisMarkdown(state: PromptProxyPanelState, command: string): string {
  const savingsPercent = state.metrics.raw_input_tokens > 0
    ? Math.round((state.metrics.tokens_saved / state.metrics.raw_input_tokens) * 100)
    : 0;
  const lines = [
    '### Prompt Optimizer report',
    '',
    `- Mode: **${command}**`,
    `- Cache: **${formatCacheStatus(state.analysis.cache.status, state.analysis.cache.confidence)}**`,
    `- Tokens: **${state.metrics.raw_input_tokens} -> ${state.metrics.optimized_input_tokens}** input, saved **${state.metrics.tokens_saved} (${savingsPercent}%)**`,
    `- Estimated output: **${state.metrics.estimated_output_tokens}** tokens`,
    `- Cost: **${formatCurrency(state.analysis.cost.total_cost_usd)}** total (${formatCurrency(state.analysis.cost.input_cost_usd)} input + ${formatCurrency(state.analysis.cost.output_cost_usd)} output)`,
    `- Context: **${state.analysis.context.selected_files.length}** file(s), **${state.analysis.context.selected_logs.length}** log source(s), **${state.analysis.context.open_file_count}** open editor(s)`,
  ];

  if (state.improvements.length > 0) {
    lines.push('', '#### Suggested prompt refinements');
    for (const improvement of state.improvements) {
      lines.push(`- ${improvement}`);
    }
  }

  if (state.analysis.cache.candidates.length > 0) {
    lines.push('', '#### Similar cached prompts');
    for (const candidate of state.analysis.cache.candidates.slice(0, 3)) {
      lines.push(`- ${Math.round(candidate.confidence * 100)}%: ${trimForDisplay(candidate.raw_prompt, 120)}`);
    }
  }

  lines.push('', '#### Optimized prompt', '```text', state.optimized, '```');
  lines.push('', '_Prompt Optimizer can use its own chat history, the local session buffer, editor context, and diagnostics. The public VS Code API does not expose Copilot\'s private transcript for other chat participants._');

  return lines.join('\n');
}

function renderContextReportMarkdown(snapshot: RuntimeSnapshot): string {
  const lines = [
    '### Prompt Optimizer context snapshot',
    '',
    `- Active file: **${snapshot.active_file ?? 'none'}**`,
    `- Open editor count: **${snapshot.open_file_count}**`,
    `- Chat history turns for @promptoptimizer: **${snapshot.chat_history_turns}**`,
    `- Context log sources: **${snapshot.log_sources.length > 0 ? snapshot.log_sources.join(', ') : 'none'}**`,
    `- Buffered session turns: **${snapshot.session_buffer.length}**`,
    '',
    '_Prompt Optimizer can read its own chat history, the local session buffer, open editors, active selection, and diagnostics. It cannot read the private transcript of other chat participants through the public VS Code API._',
  ];

  if (snapshot.session_buffer.length > 0) {
    lines.push('', '#### Buffered turns');
    for (const item of snapshot.session_buffer.slice(-3).reverse()) {
      lines.push(`- [${item.source}] ${trimForDisplay(item.prompt, 110)} (${item.cache_status}, ${formatCurrency(item.estimated_cost_usd)})`);
    }
  }

  if (snapshot.last_analysis) {
    lines.push('', '#### Last analysis');
    lines.push(`- Cache: **${formatCacheStatus(snapshot.last_analysis.analysis.cache.status, snapshot.last_analysis.analysis.cache.confidence)}**`);
    lines.push(`- Cost: **${formatCurrency(snapshot.last_analysis.analysis.cost.total_cost_usd)}**`);
    lines.push(`- Selected files: **${snapshot.last_analysis.analysis.context.selected_files.length}**`);
  }

  return lines.join('\n');
}

function addContextReferences(stream: vscode.ChatResponseStream, context: PromptProxyAnalysis['context']): void {
  for (const filePath of context.selected_files.slice(0, 3)) {
    const uri = toFileUri(filePath, context.workspace_root);
    if (uri) {
      stream.reference(uri);
    }
  }
}

function toFileUri(filePath: string, workspaceRoot?: string): vscode.Uri | undefined {
  if (!filePath) {
    return undefined;
  }

  if (path.isAbsolute(filePath)) {
    return vscode.Uri.file(filePath);
  }

  if (workspaceRoot) {
    return vscode.Uri.file(path.resolve(workspaceRoot, filePath));
  }

  return undefined;
}

function locationToText(location: vscode.Uri | vscode.Location): string {
  if (location instanceof vscode.Uri) {
    return location.toString();
  }

  return location.uri.toString();
}

function formatCurrency(value: number): string {
  return `$${value.toFixed(5)}`;
}

function trimForDisplay(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function formatCacheStatus(status: PromptProxyAnalysis['cache']['status'], confidence: number): string {
  if (status === 'exact') {
    return 'exact cache hit';
  }

  if (status === 'semantic') {
    return `semantic match (${Math.round(confidence * 100)}%)`;
  }

  return 'cache miss';
}

/** Generate a cryptographically random nonce for use in webview CSP headers. */
function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}

class PromptProxyViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'prompt-proxy-panel';

  private _view?: vscode.WebviewView;
  private _agentCts?: vscode.CancellationTokenSource;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _context: vscode.ExtensionContext
  ) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };
    webviewView.webview.html = this._getHtmlForWebview();

    webviewView.webview.onDidReceiveMessage(async (data: { type?: string; prompt?: string; mode?: string }) => {
      switch (data.type) {
        case 'ready': {
          const state = getLastAnalysis(this._context);
          if (state) {
            this.publishAnalysis(state);
          }
          // Send the current mode so the selector initialises correctly.
          webviewView.webview.postMessage({ type: 'modeState', mode: getCurrentMode(this._context) });
          break;
        }
        case 'setMode': {
          const mode = (data.mode ?? 'agent') as ProxyMode;
          await this._context.globalState.update(MODE_KEY, mode);
          break;
        }
        case 'agentRun': {
          const prompt = data.prompt?.trim() ?? '';
          if (!prompt) {
            webviewView.webview.postMessage({ type: 'error', message: 'Enter a prompt.' });
            break;
          }
          // Cancel any in-flight request.
          if (this._agentCts) { this._agentCts.cancel(); this._agentCts.dispose(); }
          this._agentCts = new vscode.CancellationTokenSource();
          const agentToken = this._agentCts.token;

          webviewView.webview.postMessage({ type: 'responseStart' });
          try {
            const state = await analyzePrompt(this._context, prompt, 'panel');
            this.publishAnalysis(state);

            const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            const wsId = computeWorkspaceId(wsRoot);
            const history = getConversation(this._context, wsId);
            const enriched = resolveReferences(state.optimized, history);

            const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
            if (models.length === 0 || agentToken.isCancellationRequested) {
              webviewView.webview.postMessage({
                type: 'responseError',
                message: 'No Copilot model available. Switch to \'Optimize only\' mode or ensure GitHub Copilot is active.',
              });
              break;
            }
            const messages = buildLMMessages(history, enriched, state);
            const lmResponse = await models[0].sendRequest(messages, {}, agentToken);

            let fullResponse = '';
            for await (const chunk of lmResponse.text) {
              if (agentToken.isCancellationRequested) { break; }
              webviewView.webview.postMessage({ type: 'responseChunk', chunk });
              fullResponse += chunk;
            }
            if (fullResponse.trim()) {
              await addConversationTurn(this._context, wsId, {
                user_raw: prompt,
                user_optimized: enriched,
                assistant: fullResponse.trim(),
              });
            }
            webviewView.webview.postMessage({ type: 'responseDone' });
          } catch (err) {
            webviewView.webview.postMessage({
              type: 'responseError',
              message: err instanceof Error ? err.message : 'Agent call failed.',
            });
          }
          break;
        }
        case 'analyze': {
          try {
            const prompt = data.prompt?.trim() ?? '';
            if (!prompt) {
              webviewView.webview.postMessage({
                type: 'error',
                message: 'Enter a prompt to analyze.',
              });
              return;
            }

            const state = await analyzePrompt(this._context, prompt, 'panel');
            this.publishAnalysis(state);
          } catch (error) {
            webviewView.webview.postMessage({
              type: 'error',
              message: error instanceof Error ? error.message : String(error),
            });
          }
          break;
        }
        case 'sendPrompt': {
          await openChatWithPrompt(data.prompt ?? '', false);
          break;
        }
        case 'openChatWithPrompt': {
          await openChatWithPrompt(data.prompt ?? '', true);
          break;
        }
        case 'copyPrompt': {
          if (data.prompt) {
            await vscode.env.clipboard.writeText(data.prompt);
          }
          break;
        }
        case 'openChat': {
          await openChatWithPrompt('', true);
          break;
        }
        case 'openReadme': {
          await openExtensionReadme(this._context);
          break;
        }
        case 'openSecretSettings': {
          const cfg = vscode.workspace.getConfiguration('promptProxy');
          webviewView.webview.postMessage({
            type: 'secretSettingsState',
            enabled: cfg.get<boolean>('enableSecretDetection') ?? true,
            customPatterns: cfg.get<Array<{ label?: string; pattern: string }>>('secretPatterns') ?? [],
            builtinLabels: SECRET_PATTERNS.map((s) => s.label),
          });
          break;
        }
        case 'saveSecretSettings': {
          const saveData = data as unknown as { enabled: boolean; customPatterns: Array<{ label?: string; pattern: string }> };
          const saveCfg = vscode.workspace.getConfiguration('promptProxy');
          await saveCfg.update('enableSecretDetection', saveData.enabled, vscode.ConfigurationTarget.Global);
          await saveCfg.update('secretPatterns', saveData.customPatterns, vscode.ConfigurationTarget.Global);
          webviewView.webview.postMessage({ type: 'secretSettingsSaved' });
          break;
        }
      }
    });
  }

  public publishAnalysis(state: PromptProxyPanelState): void {
    this._view?.webview.postMessage({
      type: 'analysisState',
      payload: state,
    });
  }

  public notifyModeChange(mode: ProxyMode): void {
    this._view?.webview.postMessage({ type: 'modeState', mode });
  }

  private _getHtmlForWebview(): string {
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'.">
  <title>Prompt Optimizer</title>
  <style>
    :root {
      color-scheme: light dark;
    }
    body {
      margin: 0;
      padding: 12px;
      font-family: var(--vscode-font-family, system-ui, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-editor-foreground);
      background: linear-gradient(180deg, rgba(127, 90, 240, 0.08), transparent 120px), var(--vscode-sideBar-background);
    }
    .stack {
      display: grid;
      gap: 10px;
    }
    .hero,
    .card {
      border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.25));
      border-radius: 12px;
      background: color-mix(in srgb, var(--vscode-editor-background) 88%, transparent);
      padding: 12px;
      box-shadow: 0 6px 16px rgba(0, 0, 0, 0.08);
    }
    .hero-title {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;
    }
    .hero-title strong {
      font-size: 14px;
    }
    .badge {
      padding: 3px 8px;
      border-radius: 999px;
      font-size: 10px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--vscode-badge-foreground, #fff);
      background: var(--vscode-badge-background, #4d4d4d);
    }
    .hero p,
    .subtle {
      margin: 0;
      line-height: 1.45;
      color: var(--vscode-descriptionForeground);
    }
    textarea {
      width: 100%;
      min-height: 86px;
      resize: vertical;
      box-sizing: border-box;
      border-radius: 10px;
      border: 1px solid var(--vscode-input-border, rgba(128, 128, 128, 0.35));
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      padding: 10px 44px 38px 10px;
      font: inherit;
      line-height: 1.45;
    }
    textarea:focus {
      outline: 1px solid var(--vscode-focusBorder);
    }
    .input-wrap {
      position: relative;
    }
    .send-btn {
      position: absolute;
      bottom: 8px;
      right: 8px;
      width: 30px;
      height: 30px;
      border-radius: 8px;
      padding: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: transform 0.1s, opacity 0.15s;
      box-shadow: 0 1px 5px rgba(0,0,0,0.28);
      cursor: pointer;
    }
    .send-btn:hover { transform: scale(1.1); }
    .send-btn:active { transform: scale(0.95); }
    .actions {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
    }
    .actions.compact {
      grid-template-columns: 1fr 1fr 1fr;
    }
    button {
      border: none;
      border-radius: 10px;
      padding: 8px 10px;
      font: inherit;
      cursor: pointer;
    }
    .primary {
      background: linear-gradient(135deg, var(--vscode-button-background), color-mix(in srgb, var(--vscode-button-background) 70%, white));
      color: var(--vscode-button-foreground);
    }
    .secondary {
      background: var(--vscode-button-secondaryBackground, rgba(128, 128, 128, 0.2));
      color: var(--vscode-button-secondaryForeground, var(--vscode-editor-foreground));
    }
    .ghost {
      background: transparent;
      color: var(--vscode-textLink-foreground);
      border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.25));
    }
    .compact {
      padding: 4px 8px;
      font-size: 11px;
      border-radius: 6px;
    }
    .readme-icon-btn {
      background: transparent;
      border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.25));
      border-radius: 6px;
      width: 22px;
      height: 22px;
      padding: 0;
      font-size: 12px;
      font-weight: 700;
      line-height: 1;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      transition: background 0.15s, color 0.15s;
    }
    .readme-icon-btn:hover {
      background: var(--vscode-button-secondaryBackground, rgba(128,128,128,0.2));
      color: var(--vscode-textLink-foreground);
    }
    .result-actions {
      display: grid;
      grid-template-columns: 1fr 1fr 1fr;
      gap: 6px;
      margin-top: 10px;
    }
    .secret-cfg {
      display: flex;
      justify-content: flex-end;
      margin-top: -4px;
    }
    /* ── Secret Manager overlay ───────────────────── */
    .secret-mgr-overlay {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.52);
      z-index: 200;
      padding: 12px;
      box-sizing: border-box;
      overflow-y: auto;
    }
    .secret-mgr {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.35));
      border-radius: 12px;
      padding: 14px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.32);
    }
    .secret-mgr-hdr {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 12px;
    }
    .secret-mgr-hdr strong { font-size: 13px; }
    .icon-close-btn {
      background: transparent;
      border: none;
      border-radius: 6px;
      width: 24px;
      height: 24px;
      padding: 0;
      font-size: 15px;
      line-height: 1;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .icon-close-btn:hover { background: var(--vscode-button-secondaryBackground, rgba(128,128,128,0.2)); }
    .toggle-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 0;
      border-bottom: 1px solid rgba(127,127,127,0.15);
      margin-bottom: 10px;
    }
    .toggle-row label { font-size: 12px; cursor: pointer; }
    .sub-hdr {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--vscode-descriptionForeground);
      margin: 10px 0 4px;
    }
    .builtin-list {
      list-style: none;
      margin: 0 0 10px;
      padding: 0;
    }
    .builtin-list li {
      font-size: 11px;
      padding: 3px 6px;
      color: var(--vscode-descriptionForeground);
      background: rgba(127,127,127,0.07);
      border-radius: 4px;
      margin-bottom: 3px;
    }
    .custom-item {
      display: flex;
      align-items: flex-start;
      gap: 6px;
      margin-bottom: 6px;
      background: rgba(127,127,127,0.07);
      border-radius: 6px;
      padding: 6px 8px;
    }
    .custom-item .ci-info { flex: 1; min-width: 0; }
    .custom-item .ci-label { font-size: 11px; font-weight: 600; }
    .custom-item .ci-regex {
      font-size: 10px;
      font-family: var(--vscode-editor-font-family, monospace);
      color: var(--vscode-descriptionForeground);
      word-break: break-all;
    }
    .del-btn {
      background: transparent;
      border: none;
      border-radius: 4px;
      padding: 2px 5px;
      font-size: 13px;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      flex-shrink: 0;
      line-height: 1;
    }
    .del-btn:hover { color: #f87171; background: rgba(200,50,50,0.15); }
    .add-form {
      display: none;
      flex-direction: column;
      gap: 6px;
      margin-top: 8px;
    }
    .add-form input {
      width: 100%;
      box-sizing: border-box;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.35));
      border-radius: 6px;
      padding: 5px 8px;
      font: inherit;
      font-size: 12px;
    }
    .add-form input:focus { outline: 1px solid var(--vscode-focusBorder); }
    .form-row { display: flex; gap: 6px; }
    .save-bar {
      display: flex;
      gap: 8px;
      margin-top: 12px;
      padding-top: 10px;
      border-top: 1px solid rgba(127,127,127,0.15);
    }
    .save-bar button { flex: 1; }
    .saved-notice {
      display: none;
      font-size: 11px;
      color: var(--vscode-terminal-ansiGreen, #4ec94e);
      text-align: center;
      margin-top: 6px;
    }
    .notice {
      display: none;
      border-radius: 10px;
      padding: 8px 10px;
      background: color-mix(in srgb, var(--vscode-inputValidation-errorBackground, #5a1d1d) 80%, transparent);
      color: var(--vscode-inputValidation-errorForeground, #fff);
    }
    .alerts { display: flex; flex-direction: column; gap: 6px; }
    .alerts:empty { display: none; }
    .alert-item {
      border-radius: 8px;
      padding: 8px 10px;
      font-size: 12px;
      line-height: 1.4;
    }
    .alert-warning {
      background: color-mix(in srgb, var(--vscode-inputValidation-warningBackground, #6f4f00) 70%, transparent);
      color: var(--vscode-inputValidation-warningForeground, #f8d775);
      border-left: 3px solid var(--vscode-inputValidation-warningBorder, #b89500);
    }
    .alert-error {
      background: color-mix(in srgb, var(--vscode-inputValidation-errorBackground, #5a1d1d) 80%, transparent);
      color: var(--vscode-inputValidation-errorForeground, #fff);
      border-left: 3px solid var(--vscode-inputValidation-errorBorder, #be1100);
    }
    .mode-row {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .mode-label {
      font-size: 11px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--vscode-descriptionForeground);
      flex-shrink: 0;
    }
    select {
      flex: 1;
      background: var(--vscode-dropdown-background, var(--vscode-input-background));
      color: var(--vscode-dropdown-foreground, var(--vscode-editor-foreground));
      border: 1px solid var(--vscode-dropdown-border, rgba(128,128,128,0.35));
      border-radius: 8px;
      padding: 6px 8px;
      font: inherit;
      font-size: 12px;
      cursor: pointer;
    }
    select:focus { outline: 1px solid var(--vscode-focusBorder); }
    .response-card { display: none; }
    .response-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 8px;
    }
    .stream-badge {
      font-size: 10px;
      padding: 2px 7px;
      border-radius: 999px;
      background: color-mix(in srgb, var(--vscode-badge-background, #4d4d4d) 60%, transparent);
      color: var(--vscode-badge-foreground, #fff);
      animation: pulse 1.4s ease-in-out infinite;
    }
    @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:0.4; } }
    .response-text {
      white-space: pre-wrap;
      word-break: break-word;
      line-height: 1.55;
      font-size: 12px;
      max-height: 420px;
      overflow-y: auto;
      padding: 4px 2px;
    }
    .loading {
      display: none;
      color: var(--vscode-descriptionForeground);
      font-style: italic;
    }
    .card {
      display: none;
    }
    .section-title {
      margin: 0 0 8px;
      font-size: 11px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--vscode-descriptionForeground);
    }
    .summary-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }
    .summary-table td {
      padding: 4px 5px;
      border-bottom: 1px solid rgba(127,127,127,0.1);
      line-height: 1.35;
      vertical-align: middle;
    }
    .summary-table tr:last-child td { border-bottom: none; }
    .summary-table .lbl {
      color: var(--vscode-descriptionForeground);
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      white-space: nowrap;
      width: 1%;
      padding-right: 3px;
    }
    .summary-table .val {
      font-weight: 500;
      font-size: 12px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .prompt-refine-row {
      display: grid;
      grid-template-columns: minmax(80px, 34%) 1fr;
      gap: 8px;
      align-items: start;
    }
    .list-sm {
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .list-sm li {
      font-size: 11px;
      padding: 3px 0;
      border-bottom: 1px solid rgba(127,127,127,0.08);
      line-height: 1.35;
      color: var(--vscode-descriptionForeground);
      word-break: break-word;
    }
    .list-sm li:last-child { border-bottom: none; }
    /* keep chips hidden but accessible to JS */
    .chips { display: none; }
    .chip { display: none; }
    pre {
      white-space: pre-wrap;
      word-break: break-word;
      margin: 0;
      border-radius: 8px;
      padding: 8px;
      background: rgba(0, 0, 0, 0.16);
      border: 1px solid rgba(127, 127, 127, 0.14);
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
      max-height: 160px;
      overflow: auto;
    }
  </style>
</head>
<body>
  <div class="stack">
    <section class="hero">
      <div class="hero-title">
        <strong>Prompt Optimizer</strong>
        <div style="display:flex;align-items:center;gap:6px">
          <span class="badge">Local cache + chat</span>
          <button class="readme-icon-btn" id="btnReadme" title="Open README — extension documentation">?</button>
        </div>
      </div>
      <p>Use <strong>@promptoptimizer</strong> in Chat or paste a draft prompt here. Prompt Optimizer can pack editor state, diagnostics, its own chat history, and the local session buffer before estimating tokens and cost.</p>
    </section>

    <div class="notice" id="notice"></div>

    <div class="mode-row">
      <span class="mode-label">Mode</span>
      <select id="modeSelect">
        <option value="agent">Agent — optimize + ask Copilot</option>
        <option value="optimize">Optimize only — show analysis</option>
        <option value="direct">Direct — send to @promptoptimizer chat</option>
      </select>
    </div>

    <div class="input-wrap">
    <textarea id="promptInput" placeholder="Type a prompt — Agent mode answers directly, Optimize shows analysis, Direct pre-fills chat."></textarea>
      <button class="send-btn primary" id="btnPrimary" title="Run Agent">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M7 2.414V13h2V2.414l3.293 3.293 1.414-1.414L8 .586 2.293 4.293l1.414 1.414z"/></svg>
      </button>
    </div>

    <div id="alerts" class="alerts"></div>
    <section class="card" id="optimizedCard" style="display:none">
      <h2 class="section-title" style="margin-bottom:6px">Optimized</h2>
      <pre id="optimizedPrompt"></pre>
    </section>

    <div class="secret-cfg">
      <button class="ghost compact" id="btnSecretSettings" title="Manage secret detection — add or remove scanning patterns">
        🔒 Secret detection
      </button>
    </div>

    <div class="loading" id="loading">Packing local context and consulting the semantic cache...</div>

    <section class="card response-card" id="responseCard">
      <div class="response-header">
        <h2 class="section-title" style="margin:0">Copilot response</h2>
        <span class="stream-badge" id="streamBadge" style="display:none">streaming</span>
      </div>
      <div id="responseContent" class="response-text"></div>
    </section>

    <section class="card" id="resultCard">
      <!-- Compact summary table: analysis + pricing in one place -->
      <table class="summary-table">
        <tbody>
          <tr>
            <td class="lbl">Cost</td>
            <td class="val" id="totalCost">$0.00000</td>
            <td class="lbl">Saved</td>
            <td class="val" id="tokenSavings">&mdash;</td>
          </tr>
          <tr>
            <td class="lbl">Tokens</td>
            <td class="val" id="tokenDelta">&mdash;</td>
            <td class="lbl">Est. out</td>
            <td class="val" id="outputTokens">&mdash;</td>
          </tr>
          <tr>
            <td class="lbl">Cache</td>
            <td class="val" id="cacheStatus" colspan="3">&mdash;</td>
          </tr>
          <tr>
            <td class="lbl">Pricing</td>
            <td class="val" id="pricingBreakdown" colspan="3">&mdash;</td>
          </tr>
        </tbody>
      </table>

      <!-- Context chips: hidden from view, kept for backend JS -->
      <ul class="chips" id="contextChips" aria-hidden="true"></ul>

      <!-- Action buttons below cost table -->
      <div class="result-actions" style="margin-top:10px">
        <button class="secondary compact" id="btnOpenChat" title="Open the @promptoptimizer chat participant">@promptoptimizer</button>
        <button class="secondary compact" id="btnUseOptimized" title="Send the optimized prompt to @promptoptimizer chat">Use optimized</button>
        <button class="secondary compact" id="btnCopyOptimized" title="Copy the optimized prompt to clipboard">Copy optimized</button>
      </div>

      <!-- Refinements -->
      <div style="margin-top:10px">
        <h2 class="section-title">Refinements</h2>
        <ul class="list-sm" id="improvements"></ul>
      </div>
    </section>
  </div>

  <div class="secret-mgr-overlay" id="secretMgrOverlay">
    <div class="secret-mgr">
      <div class="secret-mgr-hdr">
        <strong>🔒 Secret Detection</strong>
        <button class="icon-close-btn" id="btnSecretClose" title="Close">×</button>
      </div>
      <div class="toggle-row">
        <input type="checkbox" id="secretEnabled" />
        <label for="secretEnabled">Enable secret scanning in prompts</label>
      </div>
      <div class="sub-hdr">Built-in patterns (read-only)</div>
      <ul class="builtin-list" id="builtinPatternList"></ul>
      <div class="sub-hdr">Custom patterns</div>
      <ul class="list-sm" id="customPatternList" style="margin-bottom:8px"></ul>
      <button class="secondary compact" id="btnAddPattern" title="Add a custom regex pattern">+ Add pattern</button>
      <div class="add-form" id="addPatternForm">
        <input id="patternLabel" placeholder="Label, e.g. My internal token (optional)" />
        <input id="patternRegex" placeholder="Regex source, e.g. mytoken-[a-z0-9]{32}" />
        <div class="form-row">
          <button class="primary compact" id="btnSavePattern" title="Save this pattern">Save</button>
          <button class="secondary compact" id="btnCancelPattern" title="Cancel">Cancel</button>
        </div>
        <div id="regexError" style="display:none;font-size:11px;color:var(--vscode-inputValidation-errorForeground,#f88)"></div>
      </div>
      <div class="save-bar">
        <button class="primary compact" id="btnSaveSecretSettings" title="Save all settings">Save settings</button>
        <button class="secondary compact" id="btnCancelSecretSettings" title="Close without saving">Cancel</button>
      </div>
      <div class="saved-notice" id="savedNotice">✓ Settings saved</div>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const promptInput = document.getElementById('promptInput');
    const notice = document.getElementById('notice');
    const alertsEl = document.getElementById('alerts');
    const loading = document.getElementById('loading');
    const resultCard = document.getElementById('resultCard');
    const responseCard = document.getElementById('responseCard');
    const responseContent = document.getElementById('responseContent');
    const streamBadge = document.getElementById('streamBadge');
    const modeSelect = document.getElementById('modeSelect');
    const btnPrimary = document.getElementById('btnPrimary');
    const totalCost = document.getElementById('totalCost');
    const tokenSavings = document.getElementById('tokenSavings');
    const outputTokens = document.getElementById('outputTokens');
    const cacheStatus = document.getElementById('cacheStatus');
    const pricingBreakdown = document.getElementById('pricingBreakdown');
    const tokenDelta = document.getElementById('tokenDelta');
    const contextChips = document.getElementById('contextChips');
    const improvements = document.getElementById('improvements');
    const optimizedPrompt = document.getElementById('optimizedPrompt');
    const optimizedCard = document.getElementById('optimizedCard');
    let currentState;
    let currentMode = 'agent';

    const MODE_TITLES = {
      agent: 'Run Agent — optimize + call Copilot',
      optimize: 'Analyze locally — optimize only',
      direct: 'Send to @promptoptimizer chat'
    };

    function applyMode(mode) {
      currentMode = mode;
      modeSelect.value = mode;
      btnPrimary.title = MODE_TITLES[mode] || 'Run';
    }

    modeSelect.addEventListener('change', function() {
      applyMode(modeSelect.value);
      vscode.postMessage({ type: 'setMode', mode: modeSelect.value });
    });

    function formatCurrency(value) {
      return '$' + Number(value || 0).toFixed(5);
    }

    function cacheLabel(status, confidence) {
      if (status === 'exact') {
        return 'exact cache hit';
      }
      if (status === 'semantic') {
        return 'semantic match (' + Math.round((confidence || 0) * 100) + '%)';
      }
      return 'cache miss';
    }

    function clearChildren(node) {
      while (node.firstChild) {
        node.removeChild(node.firstChild);
      }
    }

    function appendListItems(node, items, emptyLabel) {
      clearChildren(node);
      if (!items || items.length === 0) {
        const li = document.createElement('li');
        li.textContent = emptyLabel;
        node.appendChild(li);
        return;
      }
      items.forEach(function(item) {
        const li = document.createElement('li');
        li.textContent = item;
        node.appendChild(li);
      });
    }

    function appendChips(node, items) {
      clearChildren(node);
      items.forEach(function(item) {
        const li = document.createElement('li');
        li.className = 'chip';
        li.textContent = item;
        node.appendChild(li);
      });
      if (items.length === 0) {
        const li = document.createElement('li');
        li.className = 'chip';
        li.textContent = 'No extra context selected';
        node.appendChild(li);
      }
    }

    function showNotice(message) {
      notice.style.display = message ? 'block' : 'none';
      notice.textContent = message || '';
    }

    function clearAlerts() { alertsEl.innerHTML = ''; }
    function addAlert(kind, message) {
      const div = document.createElement('div');
      div.className = 'alert-item alert-' + kind;
      div.textContent = (kind === 'warning' ? '\u26a0\ufe0f  ' : '\u2715  ') + message;
      alertsEl.appendChild(div);
    }

    function renderState(state) {
      currentState = state;
      promptInput.value = state.original;
      resultCard.style.display = 'block';
      loading.style.display = 'none';
      showNotice('');

      clearAlerts();
      (state.warnings || []).forEach(function(w) { addAlert('warning', w); });

      const metrics = state.metrics;
      const analysis = state.analysis;
      const savingsPct = metrics.raw_input_tokens > 0 ? Math.round((metrics.tokens_saved / metrics.raw_input_tokens) * 100) : 0;
      totalCost.textContent = formatCurrency(analysis.cost.total_cost_usd);
      tokenSavings.textContent = metrics.tokens_saved + ' tokens (' + savingsPct + '%)';
      outputTokens.textContent = String(metrics.estimated_output_tokens);
      cacheStatus.textContent = cacheLabel(analysis.cache.status, analysis.cache.confidence);
      pricingBreakdown.textContent = 'Input ' + formatCurrency(analysis.cost.input_cost_usd) + ' + output ' + formatCurrency(analysis.cost.output_cost_usd);
      tokenDelta.textContent = metrics.raw_input_tokens + ' -> ' + metrics.optimized_input_tokens + ' input tokens';
      optimizedPrompt.textContent = state.optimized;
      optimizedCard.style.display = state.optimized ? 'block' : 'none';

      const chipItems = [];
      if (analysis.context.active_file) {
        chipItems.push('Active: ' + analysis.context.active_file);
      }
      analysis.context.selected_files.forEach(function(item) {
        chipItems.push('File: ' + item);
      });
      analysis.context.selected_logs.forEach(function(item) {
        chipItems.push('Log: ' + item);
      });
      chipItems.push('Open editors: ' + analysis.context.open_file_count);
      appendChips(contextChips, chipItems);

      appendListItems(improvements, state.improvements, 'No extra refinements suggested.');
    }

    btnPrimary.addEventListener('click', function() {
      const text = promptInput.value.trim();
      if (!text) {
        clearAlerts();
        addAlert('error', 'Enter a prompt.');
        return;
      }
      clearAlerts();
      if (currentMode === 'agent') {
        responseContent.textContent = '';
        streamBadge.style.display = 'inline';
        responseCard.style.display = 'block';
        loading.style.display = 'block';
        vscode.postMessage({ type: 'agentRun', prompt: text });
      } else if (currentMode === 'direct') {
        vscode.postMessage({ type: 'openChatWithPrompt', prompt: text });
      } else {
        optimizedCard.style.display = 'none';
        loading.style.display = 'block';
        vscode.postMessage({ type: 'analyze', prompt: text });
      }
    });

    document.getElementById('btnOpenChat').addEventListener('click', function() {
      vscode.postMessage({ type: 'openChat' });
    });

    document.getElementById('btnUseOptimized').addEventListener('click', function() {
      if (currentState && currentState.optimized) {
        vscode.postMessage({ type: 'sendPrompt', prompt: currentState.optimized });
      }
    });

    document.getElementById('btnCopyOptimized').addEventListener('click', function() {
      if (currentState && currentState.optimized) {
        vscode.postMessage({ type: 'copyPrompt', prompt: currentState.optimized });
      }
    });

    document.getElementById('btnSecretSettings').addEventListener('click', function() {
      vscode.postMessage({ type: 'openSecretSettings' });
    });

    document.getElementById('btnReadme').addEventListener('click', function() {
      vscode.postMessage({ type: 'openReadme' });
    });

    // ── Secret Manager ────────────────────────────────
    var secretMgrOverlay = document.getElementById('secretMgrOverlay');
    var secretEnabledChk = document.getElementById('secretEnabled');
    var builtinPatternList = document.getElementById('builtinPatternList');
    var customPatternList = document.getElementById('customPatternList');
    var addPatternForm = document.getElementById('addPatternForm');
    var patternLabelInput = document.getElementById('patternLabel');
    var patternRegexInput = document.getElementById('patternRegex');
    var regexError = document.getElementById('regexError');
    var savedNotice = document.getElementById('savedNotice');
    var currentCustomPatterns = [];

    function renderCustomPatterns() {
      customPatternList.innerHTML = '';
      if (currentCustomPatterns.length === 0) {
        var empty = document.createElement('li');
        empty.style.cssText = 'font-size:11px;color:var(--vscode-descriptionForeground);padding:4px 0;';
        empty.textContent = 'No custom patterns yet.';
        customPatternList.appendChild(empty);
        return;
      }
      currentCustomPatterns.forEach(function(p, idx) {
        var div = document.createElement('div');
        div.className = 'custom-item';
        var info = document.createElement('div');
        info.className = 'ci-info';
        var lbl = document.createElement('div');
        lbl.className = 'ci-label';
        lbl.textContent = p.label || 'Pattern ' + (idx + 1);
        var rx = document.createElement('div');
        rx.className = 'ci-regex';
        rx.textContent = p.pattern;
        info.appendChild(lbl);
        info.appendChild(rx);
        div.appendChild(info);
        var delBtn = document.createElement('button');
        delBtn.className = 'del-btn';
        delBtn.title = 'Remove this pattern';
        delBtn.textContent = '\u00D7';
        delBtn.addEventListener('click', function() {
          currentCustomPatterns.splice(idx, 1);
          renderCustomPatterns();
        });
        div.appendChild(delBtn);
        customPatternList.appendChild(div);
      });
    }

    document.getElementById('btnSecretClose').addEventListener('click', function() {
      secretMgrOverlay.style.display = 'none';
    });
    secretMgrOverlay.addEventListener('click', function(e) {
      if (e.target === secretMgrOverlay) { secretMgrOverlay.style.display = 'none'; }
    });
    document.getElementById('btnAddPattern').addEventListener('click', function() {
      addPatternForm.style.display = 'flex';
      patternLabelInput.value = '';
      patternRegexInput.value = '';
      regexError.style.display = 'none';
      patternLabelInput.focus();
    });
    document.getElementById('btnCancelPattern').addEventListener('click', function() {
      addPatternForm.style.display = 'none';
    });
    document.getElementById('btnSavePattern').addEventListener('click', function() {
      var rx = patternRegexInput.value.trim();
      if (!rx) { regexError.textContent = 'Regex is required.'; regexError.style.display = 'block'; return; }
      try { new RegExp(rx); } catch(e) { regexError.textContent = 'Invalid regex: ' + e.message; regexError.style.display = 'block'; return; }
      regexError.style.display = 'none';
      var lbl = patternLabelInput.value.trim();
      currentCustomPatterns.push({ label: lbl || undefined, pattern: rx });
      renderCustomPatterns();
      addPatternForm.style.display = 'none';
    });
    document.getElementById('btnSaveSecretSettings').addEventListener('click', function() {
      vscode.postMessage({
        type: 'saveSecretSettings',
        enabled: secretEnabledChk.checked,
        customPatterns: currentCustomPatterns
      });
    });
    document.getElementById('btnCancelSecretSettings').addEventListener('click', function() {
      secretMgrOverlay.style.display = 'none';
    });
    // ── End Secret Manager ──────────────────────────────

    window.addEventListener('message', function(event) {
      const message = event.data;
      if (message.type === 'modeState') {
        applyMode(message.mode);
      } else if (message.type === 'analysisState') {
        renderState(message.payload);
      } else if (message.type === 'responseStart') {
        responseContent.textContent = '';
        streamBadge.style.display = 'inline';
        responseCard.style.display = 'block';
        loading.style.display = 'none';
      } else if (message.type === 'responseChunk') {
        responseContent.textContent += message.chunk;
        responseContent.scrollTop = responseContent.scrollHeight;
      } else if (message.type === 'responseDone') {
        streamBadge.style.display = 'none';
        loading.style.display = 'none';
      } else if (message.type === 'responseError') {
        streamBadge.style.display = 'none';
        loading.style.display = 'none';
        clearAlerts();
        addAlert('error', message.message || 'Agent call failed.');
      } else if (message.type === 'error') {
        loading.style.display = 'none';
        clearAlerts();
        addAlert('error', message.message || 'Prompt Optimizer failed to analyze the prompt.');
      } else if (message.type === 'secretSettingsState') {
        currentCustomPatterns = (message.customPatterns || []).slice();
        secretEnabledChk.checked = !!message.enabled;
        builtinPatternList.innerHTML = '';
        (message.builtinLabels || []).forEach(function(lbl) {
          var li = document.createElement('li');
          li.textContent = lbl;
          builtinPatternList.appendChild(li);
        });
        renderCustomPatterns();
        addPatternForm.style.display = 'none';
        savedNotice.style.display = 'none';
        secretMgrOverlay.style.display = 'block';
      } else if (message.type === 'secretSettingsSaved') {
        savedNotice.style.display = 'block';
        setTimeout(function() {
          savedNotice.style.display = 'none';
          secretMgrOverlay.style.display = 'none';
        }, 1200);
      }
    });

    vscode.postMessage({ type: 'ready' });
  </script>
  <div style="margin:12px 0 2px;padding:5px 8px;border-radius:4px;background:rgba(0,200,100,0.06);border:1px solid rgba(0,200,100,0.15);font-size:10.5px;color:var(--vscode-descriptionForeground);display:flex;align-items:center;gap:5px;">
    <span>&#x1F512;</span><span><strong>Fully local</strong> &mdash; your prompts and code never leave this machine</span>
  </div>
</body>
</html>`;
  }
}

// ── ProxyStatusPanel ─────────────────────────────────────────────────────────
// Compact popup panel opened by clicking the "Proxy" status-bar item.
// Styled to match the Copilot Pro panel: header, savings metric + progress bar,
// info rows, inline analyse input, and closable footer link rows.
class ProxyStatusPanel {
  static current: ProxyStatusPanel | undefined;

  private readonly _panel: vscode.WebviewPanel;
  private readonly _disposables: vscode.Disposable[] = [];

  private constructor(
    private readonly _context: vscode.ExtensionContext,
    private readonly _provider: PromptProxyViewProvider
  ) {
    this._panel = vscode.window.createWebviewPanel(
      'promptProxyStatus',
      'Prompt Optimizer',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [_context.extensionUri],
      }
    );
    this._panel.iconPath = vscode.Uri.joinPath(_context.extensionUri, 'images', 'icon.png');
    this._panel.webview.html = this._getHtml();
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    this._panel.webview.onDidReceiveMessage(
      async (data: { type?: string; prompt?: string }) => this._handleMessage(data),
      null,
      this._disposables
    );
  }

  static toggle(context: vscode.ExtensionContext, provider: PromptProxyViewProvider): void {
    if (ProxyStatusPanel.current) {
      ProxyStatusPanel.current._panel.reveal(vscode.ViewColumn.Beside, true);
      return;
    }
    ProxyStatusPanel.current = new ProxyStatusPanel(context, provider);
    const last = getLastAnalysis(context);
    if (last) {
      ProxyStatusPanel.current.publishAnalysis(last);
    }
  }

  publishAnalysis(state: PromptProxyPanelState): void {
    this._panel.webview.postMessage({ type: 'analysisState', payload: state });
  }

  dispose(): void {
    ProxyStatusPanel.current = undefined;
    this._panel.dispose();
    for (const d of this._disposables) { d.dispose(); }
    this._disposables.length = 0;
  }

  private async _handleMessage(data: { type?: string; prompt?: string }): Promise<void> {
    switch (data.type) {
      case 'ready': {
        const state = getLastAnalysis(this._context);
        if (state) { this.publishAnalysis(state); }
        break;
      }
      case 'analyze': {
        try {
          const prompt = data.prompt?.trim() ?? '';
          if (!prompt) {
            this._panel.webview.postMessage({ type: 'error', message: 'Enter a prompt to analyze.' });
            return;
          }
          const state = await analyzePrompt(this._context, prompt, 'panel');
          this.publishAnalysis(state);
          this._provider.publishAnalysis(state);
        } catch (error) {
          this._panel.webview.postMessage({
            type: 'error',
            message: error instanceof Error ? error.message : String(error),
          });
        }
        break;
      }
      case 'sendPrompt': { await openChatWithPrompt(data.prompt ?? '', false); break; }
      case 'copyPrompt': {
        if (data.prompt) { await vscode.env.clipboard.writeText(data.prompt); }
        break;
      }
      case 'openChat': { await openChatWithPrompt('', true); break; }
      case 'openSettings': {
        await vscode.commands.executeCommand('workbench.action.openSettings', 'promptProxy');
        break;
      }
      case 'close': { this._panel.dispose(); break; }
    }
  }

  private _getHtml(): string {
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'.">
  <title>Prompt Optimizer</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family, system-ui, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background, #252526);
      min-height: 100vh;
    }
    /* ── Header ─────────────────────────────────────────────────────────── */
    .hdr {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 16px 11px;
      border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,.2));
    }
    .hdr-title {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 15px;
      font-weight: 600;
    }
    .hdr-icon {
      width: 20px; height: 20px;
      border-radius: 5px;
      background: linear-gradient(135deg,#7c3aed,#a855f7);
      display: flex; align-items: center; justify-content: center;
      font-size: 11px; font-weight: 700; color: #fff;
      flex-shrink: 0;
    }
    .hdr-actions { display: flex; gap: 2px; }
    .icon-btn {
      background: none; border: none;
      color: var(--vscode-descriptionForeground);
      cursor: pointer; padding: 4px 6px;
      border-radius: 4px; font-size: 15px; line-height: 1; opacity: .7;
    }
    .icon-btn:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.15)); }
    /* ── Savings section ─────────────────────────────────────────────────── */
    .savings {
      padding: 14px 16px 14px;
      border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,.15));
    }
    .savings-lbl { font-weight: 600; font-size: 13px; margin-bottom: 8px; }
    .savings-row { display: flex; justify-content: space-between; align-items: flex-end; margin-bottom: 10px; }
    .savings-big { font-size: 32px; font-weight: 700; line-height: 1; }
    .savings-unit { font-size: 14px; font-weight: 400; color: var(--vscode-descriptionForeground); margin-left: 3px; }
    .savings-meta { font-size: 11px; color: var(--vscode-descriptionForeground); text-align: right; line-height: 1.4; }
    .track { height: 4px; background: rgba(128,128,128,.2); border-radius: 2px; overflow: hidden; }
    .fill  { height: 100%; background: #0e8a7a; border-radius: 2px; width: 0%; transition: width .6s ease; }
    /* ── Info rows ───────────────────────────────────────────────────────── */
    .rows { border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,.15)); }
    .row {
      display: flex; justify-content: space-between; align-items: center;
      padding: 9px 16px;
      border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,.1));
    }
    .row:last-child { border-bottom: none; }
    .row .lbl { color: var(--vscode-foreground); }
    .row .val  { color: var(--vscode-descriptionForeground); font-size: 12px; display: flex; align-items: center; gap: 5px; }
    .dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
    .dot-hit { background: #4ec9b0; } .dot-miss { background: #f48771; } .dot-sem { background: #dcdcaa; }
    /* ── Analyze section ─────────────────────────────────────────────────── */
    .analyze {
      padding: 12px 16px;
      display: flex; flex-direction: column; gap: 7px;
      border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,.15));
    }
    .alerts { display: flex; flex-direction: column; gap: 5px; }
    .alerts:empty { display: none; }
    .alert-item { border-radius: 6px; padding: 7px 10px; font-size: 11px; line-height: 1.4; }
    .alert-warning {
      background: color-mix(in srgb, var(--vscode-inputValidation-warningBackground, #6f4f00) 60%, transparent);
      color: var(--vscode-inputValidation-warningForeground, #f8d775);
      border-left: 3px solid var(--vscode-inputValidation-warningBorder, #b89500);
    }
    .alert-error {
      background: color-mix(in srgb, var(--vscode-inputValidation-errorBackground, #5a1d1d) 80%, transparent);
      color: var(--vscode-inputValidation-errorForeground, #fff);
      border-left: 3px solid var(--vscode-inputValidation-errorBorder, #be1100);
    }
    textarea {
      width: 100%; min-height: 66px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, rgba(128,128,128,.35));
      border-radius: 6px; padding: 8px 10px;
      font: inherit; resize: vertical; line-height: 1.4;
    }
    textarea:focus { outline: 1px solid var(--vscode-focusBorder); border-color: var(--vscode-focusBorder); }
    .btn-analyze {
      width: 100%; padding: 7px 12px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none; border-radius: 6px;
      cursor: pointer; font: inherit; font-size: 13px;
    }
    .btn-analyze:hover { background: var(--vscode-button-hoverBackground); }
    .notice { display: none; font-size: 12px; color: var(--vscode-inputValidation-errorForeground, #f48771); padding: 2px 0; }
    .loading { display: none; font-size: 12px; color: var(--vscode-descriptionForeground); font-style: italic; text-align: center; }
    /* ── Link rows ───────────────────────────────────────────────────────── */
    .link-row {
      display: flex; justify-content: space-between; align-items: center;
      padding: 10px 16px;
      border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,.1));
      cursor: pointer;
      color: var(--vscode-textLink-foreground, #3794ff);
      background: none; border-left: none; border-right: none; border-top: none;
      font: inherit; font-size: 13px; text-align: left; width: 100%;
    }
    .link-row:last-child { border-bottom: none; }
    .link-row:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,.1)); }
    .chevron { opacity: .55; }
    /* ── Optimized prompt output ─────────────────────────────────────────── */
    .opt-section {
      display: none;
      padding: 12px 16px;
      border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,.15));
    }
    .opt-lbl {
      font-size: 11px; letter-spacing: .06em; text-transform: uppercase;
      color: var(--vscode-descriptionForeground); margin-bottom: 6px;
    }
    .opt-pre {
      white-space: pre-wrap; word-break: break-word;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px; line-height: 1.45;
      background: rgba(0,0,0,.16);
      border: 1px solid rgba(128,128,128,.15);
      border-radius: 6px; padding: 8px 10px;
      max-height: 180px; overflow-y: auto; margin: 0;
    }
  </style>
</head>
<body>
  <!-- Header -->
  <div class="hdr">
    <div class="hdr-title">
      <div class="hdr-icon">P</div>
      Prompt Optimizer
    </div>
    <div class="hdr-actions">
      <button class="icon-btn" id="btnSettings" title="Settings">&#9881;</button>
      <button class="icon-btn" id="btnClose"    title="Close">&#10005;</button>
    </div>
  </div>

  <!-- Token savings -->
  <div class="savings">
    <div class="savings-lbl">Token savings</div>
    <div class="savings-row">
      <div>
        <span class="savings-big" id="savingsPct">&mdash;</span>
        <span class="savings-unit">optimized</span>
      </div>
      <div class="savings-meta" id="savingsMeta">Analyze a prompt to begin</div>
    </div>
    <div class="track"><div class="fill" id="progressFill"></div></div>
  </div>

  <!-- Info rows -->
  <div class="rows">
    <div class="row"><span class="lbl">Cache status</span><span class="val" id="infoCache"><span class="dot dot-miss"></span>cache miss</span></div>
    <div class="row"><span class="lbl">Input tokens</span><span class="val" id="infoTokens">&mdash; &rarr; &mdash;</span></div>
    <div class="row"><span class="lbl">Est. output</span><span class="val" id="infoOutput">&mdash; tokens</span></div>
    <div class="row"><span class="lbl">Total cost</span><span class="val" id="infoCost">$&mdash;</span></div>
  </div>

  <!-- Analyze -->
  <div class="analyze">
    <textarea id="promptInput" placeholder="Paste a prompt to analyze&hellip;"></textarea>
    <div id="alerts" class="alerts"></div>
    <div class="loading" id="loading">Analyzing with local semantic cache&hellip;</div>
    <button class="btn-analyze" id="btnAnalyze">Analyze &rarr;</button>
  </div>

  <!-- Optimized prompt output -->
  <div class="opt-section" id="optSection">
    <div class="opt-lbl">Optimized prompt</div>
    <pre id="optimizedText" class="opt-pre"></pre>
  </div>

  <!-- Link rows -->
  <div>
    <button class="link-row" id="btnOpenChat">Open @promptoptimizer in Chat <span class="chevron">&#8250;</span></button>
    <button class="link-row" id="btnCopyOptimized">Copy optimized prompt <span class="chevron">&#8250;</span></button>
    <button class="link-row" id="btnSendToChat">Send optimized to Chat <span class="chevron">&#8250;</span></button>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let currentState = null;

    const el = id => document.getElementById(id);
    const fmt = v => '$' + Number(v || 0).toFixed(5);

    function cacheInfo(status, confidence) {
      if (status === 'exact')    return { cls: 'dot-hit', label: 'exact cache hit' };
      if (status === 'semantic') return { cls: 'dot-sem', label: 'semantic (' + Math.round((confidence || 0) * 100) + '%)' };
      return { cls: 'dot-miss', label: 'cache miss' };
    }

    function renderState(state) {
      currentState = state;
      const m = state.metrics, a = state.analysis;
      const pct = m.raw_input_tokens > 0 ? Math.round(m.tokens_saved / m.raw_input_tokens * 100) : 0;

      el('savingsPct').textContent = pct + '%';
      el('progressFill').style.width = Math.min(pct, 100) + '%';
      el('savingsMeta').textContent = m.tokens_saved + ' tokens saved \xb7 ' + fmt(a.cost.total_cost_usd);

      const ci = cacheInfo(a.cache.status, a.cache.confidence);
      const dot = document.createElement('span');
      dot.className = 'dot ' + ci.cls;
      const cacheEl = el('infoCache');
      cacheEl.textContent = '';
      cacheEl.appendChild(dot);
      cacheEl.appendChild(document.createTextNode(' ' + ci.label));

      el('infoTokens').textContent = m.raw_input_tokens + ' \u2192 ' + m.optimized_input_tokens;
      el('infoOutput').textContent = m.estimated_output_tokens + ' tokens';
      el('infoCost').textContent = fmt(a.cost.total_cost_usd);

      el('optimizedText').textContent = state.optimized;
      el('optSection').style.display = 'block';

      el('promptInput').value = state.original;
      el('loading').style.display = 'none';
      el('alerts').innerHTML = '';
      (state.warnings || []).forEach(function(w) {
        const d = document.createElement('div');
        d.className = 'alert-item alert-warning';
        d.textContent = '\u26a0\ufe0f  ' + w;
        el('alerts').appendChild(d);
      });
    }

    el('btnAnalyze').addEventListener('click', function() {
      const text = el('promptInput').value.trim();
      if (!text) {
        el('alerts').innerHTML = '';
        const d = document.createElement('div');
        d.className = 'alert-item alert-error';
        d.textContent = '\u2715  Enter a prompt to analyze.';
        el('alerts').appendChild(d);
        return;
      }
      el('alerts').innerHTML = '';
      el('loading').style.display = 'block';
      vscode.postMessage({ type: 'analyze', prompt: text });
    });

    el('btnOpenChat').addEventListener('click',     () => vscode.postMessage({ type: 'openChat' }));
    el('btnSettings').addEventListener('click',     () => vscode.postMessage({ type: 'openSettings' }));
    el('btnClose').addEventListener('click',        () => vscode.postMessage({ type: 'close' }));
    el('btnCopyOptimized').addEventListener('click', function() {
      if (currentState && currentState.optimized) vscode.postMessage({ type: 'copyPrompt', prompt: currentState.optimized });
    });
    el('btnSendToChat').addEventListener('click', function() {
      if (currentState && currentState.optimized) vscode.postMessage({ type: 'sendPrompt', prompt: currentState.optimized });
    });

    window.addEventListener('message', function(event) {
      const msg = event.data;
      if (msg.type === 'analysisState') {
        renderState(msg.payload);
      } else if (msg.type === 'error') {
        el('loading').style.display = 'none';
        el('alerts').innerHTML = '';
        const d = document.createElement('div');
        d.className = 'alert-item alert-error';
        d.textContent = '\u2715  ' + (msg.message || 'Failed to analyze.');
        el('alerts').appendChild(d);
      }
    });

    vscode.postMessage({ type: 'ready' });
  </script>
  <div style="margin:12px 0 2px;padding:5px 8px;border-radius:4px;background:rgba(0,200,100,0.06);border:1px solid rgba(0,200,100,0.15);font-size:10.5px;color:var(--vscode-descriptionForeground);display:flex;align-items:center;gap:5px;">
    <span>&#x1F512;</span><span><strong>Fully local</strong> &mdash; your prompts and code never leave this machine</span>
  </div>
</body>
</html>`;
  }
}

