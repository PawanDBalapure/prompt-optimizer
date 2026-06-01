# Prompt Optimizer for VS Code

A local prompt optimizer, semantic cache, and conversational AI agent � all running inside VS Code without leaving your editor.

![Prompt Optimizer Control Panel](https://raw.githubusercontent.com/PawanDBalapure/prompt-optimizer/main/vscode-extension/images/screenshot-panel.png)

[![Fully local](https://img.shields.io/badge/data-fully_local-brightgreen?logo=lock)](https://github.com/PawanDBalapure/prompt-optimizer#privacy--security)
[![No telemetry](https://img.shields.io/badge/telemetry-none-brightgreen)](https://github.com/PawanDBalapure/prompt-optimizer#privacy--security)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/PawanDBalapure/prompt-optimizer/blob/main/vscode-extension/LICENSE)

> **?? Fully local � zero telemetry.**
> All prompt processing, token counting, semantic caching, and secret scanning run entirely on your machine.
> **No prompts, code, file contents, or metrics are ever sent to any external server.**
> The only network request is the final Copilot call you explicitly trigger.

---

## 🚀 Interactive Visual Onboarding Guide

Markdown renderers (GitHub, Marketplace, VS Code preview) **strip `<script>` and most `<style>` blocks for security**, so an animated HTML walkthrough cannot run inside README.md itself. The extension ships the full interactive guide as a webview instead:

> **Command Palette → `Prompt Optimizer: Open Guide`**
>
> (or run `prompt-proxy.openOnboarding` from the keyboard shortcut editor)

What the live guide gives you that this static page cannot:

- A **3-frame animated simulator** — workspace indexing → prompt typed in Copilot Chat → optimized prompt + cache hit, with neon node-graph filtering down to just the files your prompt actually touched.
- An **interactive knowledge graph** of 10 sample files with edges that light up and dim based on the active context.
- A **memory pipeline** with three conveyor belts (Ingestion → Storage → Retrieval) and a lane-flow diagram showing how the optimized prompt reaches Copilot.
- Keyboard shortcuts: <kbd>Space</kbd> play/pause, <kbd>R</kbd> reset.
- Full **Catppuccin Mocha** palette with neon glow, cyberpunk grid, animated cursor, ripple effects, and typing carets — all rendered as real DOM, not source code.

The static file lives at [vscode-extension/media/onboarding.html](vscode-extension/media/onboarding.html) — you can also open it directly in any browser if you want to share it.

### What you'll see (static preview)

```text
┌─────────────────────────────────────────────────────────────────┐
│ Prompt Optimizer · Onboarding                          [P spin] │
├─────────────────────────────────────────────────────────────────┤
│ [How it works] [Memory & storage] [Privacy & commands]          │
├──────────────────┬──────────────────────────────────────────────┤
│ ① Index          │   ●─────●        app.ts                      │
│   workspace      │  /│     │\                                   │
│ ② Type a prompt  │ ● │     │ ●     auth.ts ✦ (lit up)           │
│ ③ Optimized +    │  \│     │/                                   │
│   cache hit      │   ●─────●        token.ts ✦ (lit up)         │
│                  │   others dimmed                              │
│ [ ▶ Play ]       │   ⚡ +71.5× Token Savings · cache hit         │
└──────────────────┴──────────────────────────────────────────────┘
```


---

## What it does

Prompt Optimizer sits between you and Copilot. Before your prompt reaches the model it:

1. **Compresses** filler words, softeners, and redundant phrasing
2. **Shortens English sentences** when the meaning stays the same, while leaving code blocks and code-like lines untouched
3. **Checks the local semantic cache** — reuses a prior result if a similar prompt was already answered
4. **Packs workspace context** — active file, open editors, diagnostics, recent saves
5. **Estimates token cost** before the request is sent
6. **Hands the optimized prompt to Copilot** — Optimize mode shows the analysis card; Agent mode opens Copilot Chat with the optimized prompt auto-submitted; Direct mode pre-fills `@promptoptimizer` in the Chat panel.
7. **Detects SDLC workflow intent** from slash commands, built-in rules, custom skills, and file context
8. **Remembers the conversation** across turns per workspace so follow-up pronouns ("fix it", "add tests for that") resolve correctly
9. **Lets you enable and edit bundled SDLC agents** directly from the Agents button in the sidebar

---

## Modes

Select the mode from the **Mode** dropdown in the sidebar or via the status bar item (`$(robot) Proxy [Agent]`).

| Mode | Status bar label | Behaviour |
|---|---|---|
| **Optimize only** *(default)* | `$(wand) Proxy [Optimize]` | Shows analysis table (cost, tokens saved, cache status) and the optimized prompt. You decide when to send. |
| **Agent** | `$(robot) Proxy [Agent]` | Optimize the prompt locally, then open Copilot Chat with the optimized prompt and submit it directly to Copilot's native agent. No `@promptoptimizer` prefix. |
| **Direct send** | `$(comment-discussion) Proxy [Direct]` | Opens the Chat panel with `@promptoptimizer <your prompt>` pre-filled. |

Switch mode any time by:
- Clicking the status bar label (`$(robot) Proxy [Agent]`) ? QuickPick
- Changing the **Mode** dropdown in the sidebar
- Typing `@promptoptimizer /mode agent` (or `optimize` / `direct`) in Chat

---

## SDLC modes and agent skills

Prompt Optimizer 2.9.4 includes a built-in SDLC mode layer that can frame the optimized prompt with a role and checklist before it is sent.

### Built-in modes

Slash-triggered modes available out of the box:

- `/plan`
- `/arch`
- `/code`
- `/test`
- `/review`
- `/security`
- `/qa`
- `/devops`
- `/docs`
- `/pr`
- `/full`
- `/bug-fix`
- `/refactor`

If you do not type a slash command, the picker can still activate a mode by scoring prompt intent, keywords, `requires` tokens, `filePatterns`, and `priority` from the registered skills.

### Custom skills

Workspace skills live in `.promptoptimizer/skills/*.md`. User-global skills can also be loaded from `PROMPT_OPTIMIZER_SKILLS_DIR`.

Supported frontmatter fields include:

- `id`, `label`, `readOnly`
- `slashAliases`, `intentPatterns`, `keywords`
- `requires`, `filePatterns`, `priority`, `tags`
- `rolePreface` as a scalar or block (`|`)
- `checklist` as frontmatter items or markdown bullets under `## Checklist`

Skill files hot-reload on the next prompt. The parser tolerates comments, block scalars, quoted regex strings, and inline or block arrays. If a skill fails to load, diagnostics are available from the command palette.

### Agents button in the sidebar

The `Agents` quick action opens a multi-select picker for the bundled SDLC agent library.

- Tick an agent to enable it for the current workspace.
- Untick an agent to disable it.
- Click the pencil icon to enable-and-open the workspace copy for editing.
- Click reset to restore the bundled definition over local edits.

Enabled agents are copied into `.promptoptimizer/skills/` so you can customize them like any other workspace skill.

---

## Sidebar panel � Prompt Optimizer Control

Open it from the Chat sidebar or press the status bar item.

```
+----------------------------------+
�  Prompt Optimizer       Local cache  �
�  Mode  [ Agent ? ]               �
� +------------------------------+ �
� � Type your prompt here�      ?� �  ? send button (icon, like Copilot)
� +------------------------------+ �
�  ? Alerts (secrets, errors)      �
�  [ Open @promptoptimizer ]           �
�  [ Use optimized ] [Copy] [Docs] �
�                                  �
�  +-- Analysis table ----------+  �
�  � Cost � $x  � Saved � n tok �  �
�  � Tok  � n?m � Est.  � n out �  �
�  � Cache� semantic 82%        �  �
�  � Price� in $x + out $y      �  �
�  +-----------------------------+ �
�  Refinements � Optimized prompt  �
�  � use nouns � [compressed text] �
�                                  �
�  +-- Copilot response --------+  �
�  � streaming�                  �  �
�  +-----------------------------+ �
+----------------------------------+
```

### Send button

The circular **?** button inside the textarea behaves like the Copilot send button — hover shows the current mode action ("Run Agent — optimize + send to Copilot Chat").

---

## Chat participant � `@promptoptimizer`

Type in the VS Code Chat panel:

```text
@promptoptimizer refactor the auth middleware to use async/await
```

Every message is automatically optimized. Copilot's answer streams back in chat.

### Commands

| Command | Effect |
|---|---|
| `@promptoptimizer /mode agent` | Switch to Agent mode |
| `@promptoptimizer /mode optimize` | Switch to Optimize mode |
| `@promptoptimizer /mode direct` | Switch to Direct send mode |
| `@promptoptimizer /memory` | Show stored conversation turns for this workspace |
| `@promptoptimizer /clear` | Clear conversation memory for this workspace |
| `@promptoptimizer /context` | Show what local context (files, logs, cache) is available |

### Conversation memory

Up to **12 turns per workspace** are remembered. Back-references resolve automatically:

```
Turn 1: "refactor the auth middleware to async/await"
Turn 2: "now add unit tests for it"
         ? proxy injects "[Continuing from: 'refactor�']" before sending
```

---

## Analysis table (Optimize mode)

After analyzing a prompt, the result card shows a compact table:

| Row | Values |
|---|---|
| Cost / Saved | Total estimated USD cost � tokens saved |
| Tokens | Raw ? optimized token count � estimated output |
| Cache | exact hit / semantic match (%) / miss |
| Pricing | Input + output cost breakdown |

Below the table, **Refinements** and the **Optimized prompt** sit side by side.

---

## Secret detection

If your prompt contains what looks like an API key, token, or private key header, a ?? alert appears in the panel before anything is sent. Patterns detected:

- OpenAI keys (`sk-�`)
- Anthropic keys (`sk-ant-�`)
- GitHub tokens (`ghp_�`, `ghs_�`)
- AWS access keys (`AKIA�`)
- PEM private key headers
- Generic `password=`, `token=`, `api_key=` assignments

---

## Semantic cache

The local SQLite cache stores every prompt you send and builds embeddings for semantic similarity. On future prompts it checks for:

- **Exact match** � returns the cached optimized version instantly
- **Semantic match** (= 68% cosine similarity) � returns and boosts confidence score
- **Miss** � optimizes fresh, writes to cache

The cache is seeded on activation from your git log, Copilot chat history, README, package.json, and AI instruction files (`.github/copilot-instructions.md`, `AGENTS.md`, etc.).

Manage via command palette:
- `Prompt Optimizer: Show Cache Statistics`
- `Prompt Optimizer: Clear Semantic Cache`

---

## Privacy & Security

| What | Detail |
|---|---|
| **Data processing** | 100% on your machine � no cloud backend, no remote API except the Copilot request you approve |
| **Prompt storage** | Cached locally in a SQLite file on your own disk (`promptProxy.dbPath`). Never uploaded. |
| **Secret scanning** | API keys and tokens are detected **before** any network call and blocked with a warning |
| **Telemetry** | None. The extension collects zero usage or diagnostic data. |
| **Network calls** | Only the GitHub Copilot inference request you explicitly send via the VS Code Chat API |
| **Open source** | Full source available at [github.com/PawanDBalapure/prompt-optimizer](https://github.com/PawanDBalapure/prompt-optimizer) � audit it yourself |

> To verify: open the extension source (`out/extension.js`) or the engine source (`engine/dist/`). Search for `http`, `fetch`, `axios`, `request` � you will find zero outbound calls outside of the Copilot API.

---

## Command palette

| Command | Description |
|---|---|
| `Prompt Optimizer: Select Mode (Agent / Optimize / Direct)` | Open mode QuickPick |
| `Prompt Optimizer: Open Chat Participant` | Jump to `@promptoptimizer` in Chat |
| `Prompt Optimizer: Focus Control Panel` | Focus the sidebar panel |
| `Prompt Optimizer: Optimize Clipboard & Cost Forecast` | Optimize whatever is on the clipboard |
| `Prompt Optimizer: Copy Last Optimized Prompt` | Copy the last result to clipboard |
| `Prompt Optimizer: Send Last Optimized Prompt To Chat` | Open Chat with last result |
| `Prompt Optimizer: Show Cache Statistics` | Show entry count, avg confidence, total hits |
| `Prompt Optimizer: Clear Semantic Cache` | Wipe the local SQLite cache |
| `Prompt Optimizer: Clear Conversation Memory` | Clear this workspace's conversation history |
| `Prompt Optimizer: List Agent Skills (Modes)` | Show every registered built-in and custom mode |
| `Prompt Optimizer: Create / Edit Agent Skill` | Create a workspace skill file or override an existing mode |
| `Prompt Optimizer: Diagnose Skill Loading Errors` | Open the files that failed skill parsing/loading |
| `Prompt Optimizer: Manage SDLC Agent Skills` | Enable, disable, edit, or reset the bundled SDLC agent library |

---

## Configuration

| Setting | Default | Description |
|---|---|---|
| `promptProxy.dbPath` | *(global storage)* | Custom path for the SQLite cache file |
| `promptProxy.processingMode` | `blocking` | `blocking` or `non-blocking` cache lookup |
| `promptProxy.enableSessionContext` | `true` | Feed recent turns back as session history |
| `promptProxy.pricingInput` | `0.0015` | Input cost per 1K tokens (USD) |
| `promptProxy.pricingOutput` | `0.002` | Output cost per 1K tokens (USD) |
