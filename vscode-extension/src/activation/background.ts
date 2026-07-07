import * as vscode from 'vscode';

import { CHAT_PARTICIPANT_ID, ENRICH_INTERVAL_MS } from '../constants';
import { handleChatRequest } from '../chat/handler';
import { openOnboardingGuide } from '../commands/open';
import {
  enrichFromChatHistory,
  ingestMemoryFiles,
  seedCacheFromWorkspace,
  syncCopilotChatsToConversationMemory,
} from '../engine/seeder';
import type { PromptProxyViewProvider } from '../panel/PromptProxyViewProvider';
import { getConversation } from '../state/conversation';
import { addPassiveEvent } from '../state/session';
import { computeWorkspaceId } from '../util/workspace';

const ONBOARDING_LAST_VERSION_KEY = 'promptProxy.onboarding.lastShownVersion';

/** File basenames that, when saved, trigger an immediate memory re-ingest. */
const MEMORY_FILE_NAMES = new Set([
  'memory.md', 'knowledge.md', 'AGENTS.md', 'CLAUDE.md', 'CLAUDE.local.md',
  'copilot-instructions.md', '.cursorrules', '.clinerules',
]);

/** Register the @promptoptimizer chat participant with its followups. */
export function registerChatParticipant(
  context: vscode.ExtensionContext,
  provider: PromptProxyViewProvider,
  statusBarItem: vscode.StatusBarItem,
): void {
  const participant = vscode.chat.createChatParticipant(
    CHAT_PARTICIPANT_ID,
    async (request, chatContext, stream, token) =>
      handleChatRequest(context, provider, statusBarItem, request, chatContext, stream, token),
  );
  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'images', 'icon.png');
  participant.followupProvider = {
    provideFollowups: () => {
      try {
        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const hist = getConversation(context, computeWorkspaceId(wsRoot));
        const historyCount = Array.isArray(hist) ? hist.length : 0;
        const followups: vscode.ChatFollowup[] = [];
        if (historyCount > 0) {
          followups.push({
            prompt: '/memory',
            label: `View memory (${historyCount} turn${historyCount === 1 ? '' : 's'})`,
          });
          followups.push({ prompt: '/clear', label: 'Clear conversation memory' });
        }
        followups.push({
          prompt: '/context Show what local context Prompt Optimizer can read right now.',
          label: 'Show workspace context',
        });
        return followups;
      } catch (error) {
        // Never let followup-provider failures bubble into the Copilot host.
        console.debug('[Prompt Optimizer] followupProvider failed (non-critical)', error);
        return [{
          prompt: '/context Show what local context Prompt Optimizer can read right now.',
          label: 'Show workspace context',
        }];
      }
    },
  };
  context.subscriptions.push(participant);
}

/** Initial seeding pass + recurring chat-history enrichment timer. */
export function startBackgroundIndexing(
  context: vscode.ExtensionContext,
  provider: PromptProxyViewProvider,
): void {
  // Initial bootstrap: harvests workspace conventions, git log, Copilot chat
  // history, README, etc. On a fresh install this runs unconditionally so the
  // memory is primed before the very first user prompt.
  setTimeout(() => {
    void (async () => {
      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Window, title: 'Prompt Optimizer: indexing workspace…' },
          async () => { await seedCacheFromWorkspace(context); },
        );
        await syncCopilotChatsToConversationMemory(context);
        provider.refreshStatusOverview();
      } catch (error) {
        // Seeding failures are non-critical and must not block activation.
        console.debug('[Prompt Optimizer] Workspace seeding failed (non-critical)', error);
      }
    })();
  }, 3000);

  // Continuous enrichment: pull new Copilot prompts into the knowledge graph.
  const enrichTimer = setInterval(() => {
    void (async () => {
      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Window, title: 'Prompt Optimizer: refreshing index…' },
          async () => {
            await enrichFromChatHistory(context);
            await syncCopilotChatsToConversationMemory(context);
          },
        );
        provider.refreshStatusOverview();
      } catch (error) {
        console.debug('[Prompt Optimizer] Chat history enrichment failed (non-critical)', error);
      }
    })();
  }, ENRICH_INTERVAL_MS);
  context.subscriptions.push({ dispose: () => clearInterval(enrichTimer) });
}

/** Passive listeners: session telemetry + reactive memory-file ingestion. */
export function registerPassiveListeners(
  context: vscode.ExtensionContext,
  provider: PromptProxyViewProvider,
): void {
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      addPassiveEvent(context, 'file_saved', doc.fileName);
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

/** Auto-open the onboarding guide on first install and after updates. */
export async function maybeAutoOpenOnboarding(context: vscode.ExtensionContext): Promise<void> {
  try {
    const enabled = vscode.workspace
      .getConfiguration('promptProxy')
      .get<boolean>('onboarding.autoOpen', true);
    if (!enabled) { return; }

    const currentVersion = String(
      (context.extension.packageJSON as { version?: string } | undefined)?.version ?? '0.0.0',
    );
    if (context.globalState.get<string>(ONBOARDING_LAST_VERSION_KEY) === currentVersion) { return; }

    // Defer slightly so VS Code finishes restoring editors first.
    setTimeout(() => {
      void openOnboardingGuide(context).then(
        () => context.globalState.update(ONBOARDING_LAST_VERSION_KEY, currentVersion),
      ).catch((error) => {
        console.debug('[Prompt Optimizer] Onboarding guide failed to open (non-critical)', error);
      });
    }, 1200);
  } catch (error) {
    console.debug('[Prompt Optimizer] Onboarding initialization failed (non-critical)', error);
  }
}
