# Changelog

## 2.1.0 — Enterprise hardening

### Added

- **SQLite hardening**: WAL journaling, 5s busy timeout, `synchronous=NORMAL`, `foreign_keys=ON`, and a `schema_version` row (current: 3) for forward-compatible migrations.
- **Structured leveled logger** controlled by `PROMPT_OPT_LOG_LEVEL` (`debug|info|warn|error|silent`, default `warn`) and `PROMPT_OPT_LOG_FORMAT` (`text|json`). All `console.error` calls in persistence code replaced.
- **Secret / PII redaction** at every persistence boundary (semantic cache writes, workspace memory snapshots, file digest summaries). Covers PEM keys, AWS/GCP/Slack/Stripe/GitHub PATs, JWT, Bearer/Token headers, env-style secret assignments, and (opt-in) email/phone/SSN/credit-card PII. Toggle with `PROMPT_OPT_REDACT=0` (disable) or `PROMPT_OPT_REDACT_PII=1` (enable PII).
- **`engine_metrics` table + `MetricsRegistry`**: counters for `requests.total`, `requests.cache_exact|semantic|miss`, `cache.writes`, `cache.redaction_hits`, and `maintenance.runs|entries_evicted`.
- **Retention / eviction service** (`MaintenanceService`) with per-workspace caps for cache rows, file digests, and KG nodes, plus stale-age pruning and optional `VACUUM`.
- **Online backup** via better-sqlite3 `db.backup()` with a checkpoint+copy fallback.
- **Health check** that runs `PRAGMA quick_check`, verifies all 9 required tables, reports pragmas, file sizes, redaction status, and log level.
- New CLI commands: `--health-check`, `--metrics [--reset]`, `--db-prune [--max-cache --max-digests --max-kg --older-than-days --vacuum]`, `--export-db <dest>`, `--redact-test`.
- New VS Code commands:
  - **Prompt Optimizer: Health Check**
  - **Prompt Optimizer: Show Engine Metrics**
  - **Prompt Optimizer: Run Database Maintenance (Retention / Eviction)**
  - **Prompt Optimizer: Export Database (Online Backup)**

### Validation

- Scenario 17 (`enterprise hardening`) added to the test harness, covering redactor coverage, persisted-data redaction round-trips, schema/WAL pragmas, metrics counters, health-check report, retention eviction caps, and online backup integrity. All 17 scenarios pass.

## 2.0.0

### Added

- Built-in SDLC workflow modes for `/plan`, `/arch`, `/code`, `/test`, `/review`, `/security`, `/qa`, `/devops`, `/docs`, `/pr`, `/full`, `/bug-fix`, and `/refactor`.
- Custom skill loading from workspace `.promptoptimizer/skills/*.md` and the optional `PROMPT_OPTIMIZER_SKILLS_DIR` directory.
- Robust skill parsing for comments, block scalars, frontmatter checklists, quoted regex strings, `keywords`, `requires`, `filePatterns`, `priority`, and `tags`.
- Bundled SDLC agent definitions exposed through the new `Agents` sidebar action.
- Agent management flows for enabling, disabling, editing, resetting, listing, creating, and diagnosing skills.

### Changed

- Skill selection now uses a score-based picker instead of first-match intent detection.
- `--list-modes` now returns both registered modes and load errors for diagnostics.
- The sidebar Agents picker can open workspace copies for direct editing and can reset them back to the bundled defaults.
- VSIX packaging continues to include required runtime dependencies for `better-sqlite3` loading.

### Fixed

- Historical prompt and chat log buffers are no longer injected into optimized output by default.
- Secret detection remains enabled by default unless explicitly disabled in settings.
- Secret warnings now include matched text for faster review.
- Each detected secret warning includes a Remove from output action when that text exists in optimized output.
- Clicking remove on highlighted secret text now also removes the corresponding warning alert.
- When a secret exists in input but not in optimized output, the panel shows an informational alert and hides the remove button.
- Secret dedup now keys by label + matched text so multiple patterns are shown correctly.

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