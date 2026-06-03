# Prompt Optimizer for IntelliJ

Local prompt optimization, semantic cache, credit forecasting, workspace memory, and SDLC agent skills inside JetBrains IDEs.

Processing is local. The plugin reads your workspace, optimizes prompts, warns about secrets, and sends data only when you explicitly paste or send the final prompt to an external AI chat surface.

## Quick Start

1. Open `View > Tool Windows > Prompt Optimizer`.
2. Pick a mode: `optimize`, `agent`, or `direct`.
3. Pick a target model: `gpt`, `claude`, `gemini`, or `local`.
4. Paste a prompt, load the clipboard, or use the editor action `Optimize with Prompt Optimizer` (`Ctrl+Alt+P`).
5. Review tokens, cache status, credit forecast, diagnostics, warnings, and the optimized prompt.

## Modes

| Mode | What happens |
| --- | --- |
| `optimize` | Default. Runs local analysis and shows the optimized prompt in the tool window. |
| `agent` | Optimizes locally and copies the optimized prompt for your AI chat surface. |
| `direct` | Prepares an `@promptoptimizer <prompt>` handoff and copies it when auto-copy is enabled. |

The VS Code extension can submit to Copilot Chat because VS Code exposes a chat participant API. JetBrains IDEs do not expose the same Copilot Chat submission surface, so IntelliJ Agent/Direct modes prepare and copy prompts for manual handoff.

## What Runs Locally

- Prompt compression and model-aware formatting through the shared Prompt Optimizer engine.
- Secret detection before send, including custom regex patterns.
- Exact and semantic cache lookup in SQLite.
- Context packing from active editor files, open editors, workspace memory, knowledge graph, file digests, README/package metadata, and git history.
- SDLC mode and agent skill listing.
- Token, cost, and monthly credit forecast.
- Peer workspace cache management.
- Health checks, metrics, database maintenance, and database export.

## Tool Window

Tabs in the Prompt Optimizer tool window:

| Tab | Purpose |
| --- | --- |
| `Optimize` | Prompt input, mode/model controls, optimized output, diagnostics, warnings, and metrics. |
| `Context` | Status overview, workspace indexing, memory file editing, memory recall, peers, knowledge graph, studied files, and memory refresh. |
| `Admin` | Cache stats/clear, health check, metrics, maintenance, export database, agent skills, digest stats, and digest cleanup. |
| `Guide` | Built-in onboarding for modes, memory, privacy, and daily workflow. |

## Memory And Cache

Prompt Optimizer indexes local project context from:

- `AGENTS.md`, `CLAUDE.md`, `.github/copilot-instructions.md`
- `.promptoptimizer/memory.md`, `.promptoptimizer/knowledge.md`
- `.cursorrules`, `.clinerules`
- git log, README/package metadata, open editors, and file digest memory

The semantic cache is SQLite on your disk. Exact matches return immediately. Semantic matches can reuse prior optimized prompts where the shared engine marks the result confident enough.

## Settings

Open `Settings > Tools > Prompt Optimizer`.

| Setting | Default | Purpose |
| --- | --- | --- |
| Node.js executable path | `node` | Runtime used to launch the bundled/shared engine CLI. |
| Engine CLI path | bundled runtime | Optional manual `dist/cli.js` path for development. |
| SQLite cache path | IDE system directory | Local semantic cache and memory database. |
| Default mode | `optimize` | Tool window/editor action behavior. |
| Target model | `gpt` | Optimization and forecast target. |
| Processing mode | `blocking` | Shared engine processing behavior. |
| Editor action source picker | `ask` | Choose selection, document, clipboard, or automatic source order. |
| Context packing | active file on, open files on | Include editor context with requests. |
| Pricing / plan forecast | Pro-style defaults | Estimate request cost and monthly credit use. |
| Secret detection | enabled | Warn about API keys, tokens, passwords, and custom patterns. |

Custom secret patterns use one rule per line:

```text
Label::regex
Internal token::it_[A-Za-z0-9]{24,}
```

## Requirements

| Dependency | Version |
| --- | --- |
| JetBrains IDE | 2024.1+ |
| Node.js | 18+ at runtime |
| JDK | 17+ for build, sign, and publish |

## Develop

```bash
# repo root
npm install
npm run build
npm --prefix vscode-extension run compile

# plugin project
cd intellij-plugin
./gradlew runIde
```

The Gradle build copies the prepared runtime from `../vscode-extension/engine` into plugin resources. During engine development you can set `Engine CLI path` to `<repo>/dist/cli.js`.

## Package

```bash
cd intellij-plugin
./gradlew buildPlugin verifyPlugin
```

Output: `build/distributions/prompt-proxy-intellij-2.9.6.zip`.

## Publish

The first JetBrains Marketplace upload is manual. After the plugin is accepted, CI or local publishing can use:

- `PUBLISH_TOKEN`
- `CERTIFICATE_CHAIN`
- `PRIVATE_KEY`
- `PRIVATE_KEY_PASSWORD`

```bash
./gradlew signPlugin publishPlugin
```

## Architecture

```text
PromptProxyToolWindowFactory.kt  - tool window registration
PromptProxyPanel.kt              - Swing UI, modes, context/admin tabs, onboarding
PromptProxyService.kt            - Node.js engine subprocess and CLI helpers
PromptProxyAppSettings.kt        - persisted settings
PromptProxyConfigurable.kt       - Settings > Tools page
OptimizeSelectionAction.kt       - editor action and source picker
```

The plugin shells out to the same engine CLI used by VS Code:

```text
node <cli.js> --stdin --db <prompt_semantic_cache.db>
```

Input and output use the shared JSON contract with `raw_prompt`, `mode`, `workspace_id`, `target_model`, `pricing`, and `ide_context`.
