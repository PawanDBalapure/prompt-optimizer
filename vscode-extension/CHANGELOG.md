# Changelog

## 1.0.0

### New features

- **Mode selector** - choose between Agent (optimize + call Copilot directly), Optimize only (show analysis first), and Direct send (pre-fill the Chat panel). Switch via the sidebar dropdown, the status bar item, or `@promptproxy /mode <mode>`.
- **Agent mode** - type a prompt in the sidebar, press the send button, and Copilot's answer streams directly into the panel with no `@promptproxy` prefix needed.
- **Conversation memory** - up to 12 turns per workspace are persisted in `globalState`. Back-references ("fix it", "add tests for that") are resolved automatically from the prior turn.
- **Compact analysis table** - analysis and pricing are combined into a single space-efficient table. Suggested refinements and the optimized prompt sit side by side.
- **Secret detection settings** - enable/disable scanning and add custom regex patterns via `promptProxy.enableSecretDetection` and `promptProxy.secretPatterns`.
- **Semantic cache** - local SQLite cache with cosine similarity scoring, confidence tracking, and workspace scoping. Seeded on activation from git log, Copilot chat history, README, and AI instruction files.
- **Workspace context** - active file, visible editors, diagnostics, and recent saves are packed into every optimization request.
- **Chat commands** - `@promptproxy /mode`, `/memory`, `/clear`, `/context` for full in-chat control.
- **Cache management** - `Prompt Proxy: Show Cache Statistics` and `Prompt Proxy: Clear Semantic Cache` commands.
- **Secret detection alerts** - warnings appear in the panel when a prompt looks like it contains an API key, token, or private key.