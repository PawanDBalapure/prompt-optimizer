import * as vscode from 'vscode';

/**
 * Single-entrypoint "User Guide" QuickPick.  Surfaces the 10 actions most
 * users need without forcing them to memorise the full command palette.
 * Each entry carries a rich description shown inline so the picker doubles
 * as a discoverability guide.
 */

interface GuideItem extends vscode.QuickPickItem {
  /** Command id to execute when picked. */
  command?: string;
  /** Optional URL to open externally. */
  url?: string;
}

const ITEMS: GuideItem[] = [
  {
    label: '$(sparkle) Optimize prompt now',
    description: 'Ctrl+Alt+O',
    detail: 'Optimize the current editor selection (or clipboard) and send it to Copilot Chat.',
    command: 'prompt-proxy.optimizeChatPrompt',
  },
  {
    label: '$(window) Open the Prompt Optimizer panel',
    description: 'Ctrl+Alt+P',
    detail: 'Side panel with mode selector, prompt input, analysis, refinements, and quick chips.',
    command: 'prompt-proxy.focusPanel',
  },
  {
    label: '$(arrow-swap) Switch mode (Agent / Optimize / Direct)',
    detail: 'Agent = optimize + ask Copilot · Optimize = analysis only · Direct = pre-fill chat.',
    command: 'prompt-proxy.selectMode',
  },
  {
    label: '$(comment-discussion) Open @promptoptimizer chat',
    detail: 'Opens the chat participant. Type a prompt, or use /optimize, /estimate, /memory, /clear.',
    command: 'prompt-proxy.startChat',
  },
  {
    label: '$(book) Open workspace memory file',
    detail: 'Edit AGENTS.md / CLAUDE.md / .promptoptimizer/memory.md — auto-injected into every optimized prompt.',
    command: 'prompt-proxy.openMemoryFile',
  },
  {
    label: '$(history) Show prompt history (side-by-side diff)',
    detail: 'Browse prior prompts with relative timestamps; open any prompt as an original ↔ optimized diff view.',
    command: 'prompt-proxy.showHistory',
  },
  {
    label: '$(git-commit) Commit current prompt (versioning)',
    detail: 'Snapshot the current prompt + optimized output as a Git-style commit on the current branch.',
    command: 'prompt-proxy.commitPrompt',
  },
  {
    label: '$(git-branch) Show prompt log (versions)',
    detail: 'Git-style log of prompt commits with diff, tag, checkout, branch, and delete actions.',
    command: 'prompt-proxy.showPromptLog',
  },
  {
    label: '$(git-pull-request) Switch prompt branch',
    detail: 'Switch between, create or delete branches in the per-workspace prompt version graph.',
    command: 'prompt-proxy.switchPromptBranch',
  },
  {
    label: '$(refresh) Sync memory → .github/copilot-instructions.md',
    detail: 'Writes a managed block so the built-in Copilot agent also sees your workspace memory.',
    command: 'prompt-proxy.syncCopilotInstructions',
  },
  {
    label: '$(link) Manage peer workspaces',
    detail: 'Federate this workspace\u2019s cache with peers so similar prompts hit the local cache across repos.',
    command: 'prompt-proxy.peerWorkspaces',
  },
  {
    label: '$(robot) Manage SDLC agent skills',
    detail: 'Enable / disable bundled skills (planner, reviewer, security-auditor, \u2026) for this workspace.',
    command: 'prompt-proxy.manageAgentSkills',
  },
  {
    label: '$(graph) Show cache & memory stats',
    detail: 'Counts of cached entries, knowledge-graph nodes, studied files, and peer hits.',
    command: 'prompt-proxy.cacheStats',
  },
  {
    label: '$(shield) Configure secret detection',
    detail: 'Add custom regex / LIKE / substring rules to scan prompts for secrets before sending.',
    command: 'prompt-proxy.focusPanel',
  },
  {
    label: '$(question) Open extension README',
    detail: 'Full documentation, screenshots, settings reference, privacy guarantees.',
    command: 'prompt-proxy.openReadme',
  },
  {
    label: '$(pulse) Health check & diagnostics',
    detail: 'Verifies engine sidecar, database, settings, and reports any issues with one click.',
    command: 'prompt-proxy.healthCheck',
  },
];

export function registerUserGuide(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('prompt-proxy.userGuide', async () => {
      const picked = await vscode.window.showQuickPick(ITEMS, {
        placeHolder: 'Prompt Optimizer — what would you like to do?',
        matchOnDescription: true,
        matchOnDetail: true,
      });
      if (!picked) { return; }
      if (picked.command) {
        await vscode.commands.executeCommand(picked.command);
      } else if (picked.url) {
        await vscode.env.openExternal(vscode.Uri.parse(picked.url));
      }
    }),
  );
}
