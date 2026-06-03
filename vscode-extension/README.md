# Prompt Optimizer for VS Code

Local prompt optimization, semantic cache, credit forecasting, memory, and SDLC agents inside VS Code.

![Prompt Optimizer Control Panel](https://raw.githubusercontent.com/PawanDBalapure/prompt-optimizer/main/vscode-extension/images/screenshot-panel.png)

[![Fully local](https://img.shields.io/badge/data-fully_local-brightgreen?logo=lock)](https://github.com/PawanDBalapure/prompt-optimizer#privacy)
[![No telemetry](https://img.shields.io/badge/telemetry-none-brightgreen)](https://github.com/PawanDBalapure/prompt-optimizer#privacy)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/PawanDBalapure/prompt-optimizer/blob/main/vscode-extension/LICENSE)

Processing is local. The extension reads your workspace, optimizes the prompt, warns about secrets, and sends data only when you explicitly send to Copilot.

## Quick Start

1. Run `Prompt Optimizer: Open Prompt Optimizer Guide`.
2. Open the Prompt Optimizer sidebar in the Chat view.
3. Pick a mode: `Optimize only`, `Agent`, or `Direct send`.
4. Type a prompt and press `Ctrl+Enter`.
5. Review tokens, cache status, credit forecast, and the optimized prompt.

## Modes

| Mode | What happens |
| --- | --- |
| `Optimize only` | Default. Shows analysis and optimized prompt. You choose when to send. |
| `Agent` | Optimizes locally, opens Copilot Chat, and submits the optimized prompt. |
| `Direct send` | Opens Chat with `@promptoptimizer <prompt>` prefilled. |

Switch from the sidebar, status bar, or `@promptoptimizer /mode agent|optimize|direct`.

## What Runs Locally

- Prompt compression and meaning-preserving sentence shortening.
- Secret detection before send.
- Exact and semantic cache lookup.
- Context packing from active file, visible editors, diagnostics, recent saves, memory files, knowledge graph, and optional peer workspaces.
- SDLC mode/agent selection.
- Token, cost, and monthly credit forecast.
- Prompt history and Git-style prompt versions.

## Sidebar Controls

- `Visual Tour` - opens the interactive onboarding guide.
- `Guide` - shows common actions.
- `History` - restores, diffs, re-optimizes, or sends prior prompts.
- `Versions` - commit, log, branch, switch, and tag prompts.
- `Try example` - inserts a sample prompt.
- `Memory` - opens workspace memory files.
- `Peers` - connects local peer-workspace caches.
- `Agents` - enables bundled SDLC agents or creates custom agents.
- Refresh button - re-indexes the overview on demand.
- Gear menu - secret detection settings and reset-to-defaults.

## Agents And Skills

Built-in slash modes: `/plan`, `/arch`, `/code`, `/test`, `/review`, `/security`, `/qa`, `/devops`, `/docs`, `/pr`, `/full`, `/bug-fix`, `/refactor`.

Custom skills live in `.promptoptimizer/skills/*.md`. Global skills can be loaded from `PROMPT_OPTIMIZER_SKILLS_DIR`. Skill files hot-reload on the next prompt.

The Agents picker can enable, disable, edit, reset, remove, or create workspace agents. Enabled bundled agents are copied into `.promptoptimizer/skills/` so your edits survive extension updates.

## Memory And Cache

Prompt Optimizer indexes:

- `AGENTS.md`, `CLAUDE.md`, `.github/copilot-instructions.md`
- `.promptoptimizer/memory.md`, `.promptoptimizer/knowledge.md`
- `.cursorrules`, `.clinerules`
- git log, README/package metadata, active editors, diagnostics, and recent saves

The semantic cache is SQLite on your disk. Exact matches return immediately. Semantic matches at 68% or higher can reuse prior optimized prompts.

## Privacy

| Surface | Behavior |
| --- | --- |
| Processing | Runs on your machine. |
| Telemetry | None. |
| Cache | Local SQLite file from `promptProxy.dbPath`. |
| Secrets | Warned before any send. Custom patterns supported. |
| Network | Only the Copilot request you explicitly trigger. |
| Updates | Preserve settings, memory, cache, prompt versions, and custom agents. |

## Commands

| Command | Purpose |
| --- | --- |
| `Focus Control Panel` | Open the sidebar. |
| `Open Chat Participant` | Jump to `@promptoptimizer`. |
| `Open Prompt Optimizer Guide` | Reopen onboarding. |
| `Select Mode (Agent / Optimize / Direct)` | Change run mode. |
| `Optimize Clipboard & Cost Forecast` | Optimize clipboard text. |
| `Copy Last Optimized Prompt` | Copy the latest result. |
| `Send Last Optimized Prompt To Chat` | Open Chat with latest result. |
| `Confirm and Send Pending Optimized Prompt` | Send the reviewed prompt. |
| `Cancel Pending Optimized Prompt` | Discard pending send. |
| `Show Cache Statistics` | Inspect local cache. |
| `Clear Semantic Cache` | Clear cache only. |
| `Clear Conversation Memory` | Clear this workspace's memory. |
| `Reset to Defaults` | Choose settings, cache, memory, or custom agents to reset. |
| `Open Workspace Memory File` | Edit long-lived workspace notes. |
| `Manage Peer Workspaces` | Add/remove peer caches. |
| `Show Knowledge Graph Stats` | Inspect graph counts. |
| `Show File Digest Summary` | Inspect indexed file digests. |
| `List Agent Skills (Modes)` | Show loaded skills. |
| `Create / Edit Agent Skill` | Create or edit a workspace skill. |
| `Diagnose Skill Loading Errors` | Open broken skills. |
| `Manage SDLC Agent Skills` | Enable, edit, reset, remove, or create agents. |
| `Health Check` | Check engine/database health. |
| `Show Engine Metrics` | View request/cache counters. |
| `Run Database Maintenance` | Prune old local data. |
| `Export Database` | Back up the SQLite database. |
| `Sync Copilot Instructions Memory` | Update the managed memory block in Copilot instructions. |
| `Suggest Workspace Memory Improvements` | Get memory-file improvement ideas. |
| `Show Memory Budget` | Inspect memory packing limits. |
| `Show Prompt History` | Browse prior prompts. |
| `Commit Prompt`, `Prompt Log`, `Create Prompt Branch`, `Switch Prompt Branch` | Version prompts. |

## Settings

Important settings under `Extensions > Prompt Optimizer`:

| Setting | Default | Purpose |
| --- | --- | --- |
| `promptProxy.targetModel` | `gpt-4.1` | Forecast/model pattern target. |
| `promptProxy.processingMode` | `blocking` | Cache lookup behavior. |
| `promptProxy.enableSessionContext` | `true` | Include recent turns. |
| `promptProxy.subscriptionPlan` | `pro` | Monthly credit allowance. |
| `promptProxy.forecastRequestsPerDay` | `20` | Credit forecast volume. |
| `promptProxy.enableSecretDetection` | `true` | Secret scanner. |
| `promptProxy.secretPatterns` | `[]` | Custom scanner rules. |
| `promptProxy.optimize.autoOpenChat` | `true` | Open Chat after optimization where applicable. |
| `promptProxy.dbPath` | global storage | SQLite cache path. |

## Onboarding

The interactive guide ships as a webview because Markdown strips scripts and styles.

Open it with:

```text
Prompt Optimizer: Open Prompt Optimizer Guide
```

It covers the pipeline, modes, sidebar controls, memory, cache, secrets, commands, and reset behavior.
