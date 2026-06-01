

## 2.9.2 - 2026-06-01

- _Describe changes here._

## 2.9.1 - 2026-06-01

- _Describe changes here._

﻿# Changelog

## 2.9.0 — Forecast cost details + enterprise hardening

### Added

- **Forecast cost details accordion** under Refinements — clear tabular breakdown of optimized input tokens, estimated output tokens, per‑1K rates, and estimated subtotals, with an explicit notice that the figures are **estimates**, not actual billed amounts.
- **Tamper‑evident audit log** (`audit_log` table, schema v4) — chained `row_hash` records cache writes, clears, and redaction events. Hash‑only by default; opt into raw bodies with `PROMPT_OPT_AUDIT_RAW=1`. New CLI flags `--audit-log [--limit N | --verify]`.
- **Correlation IDs** — every `PromptOptimizationResponse` now carries a 32‑hex `request_id`. Callers can supply their own via `request.correlation_id`.
- **Per‑augment‑source circuit breaker** — token bucket + failure threshold protects optimizer latency when memory / KG / digest / peer ingestion misbehaves.
- **OpenTelemetry export** — new `--metrics-otlp [--otlp-endpoint URL]` CLI flag emits OTLP/JSON line‑protocol metrics for any OTel Collector / Vector / Fluent Bit sidecar (no SDK dependency).
- **JSON Schema for the wire contract** — `schemas/contracts.schema.json`, exposed via `--schema` CLI flag.
- **Engine config file** — `~/.promptoptimizer/config.json` and `<workspace>/.promptoptimizer/config.json` merge with env vars at startup.

### Changed

- **Schema version bumped to 5** — migrations refactored into a `MIGRATIONS[]` array (`src/cache/migrations.ts`); `peer_workspaces` gains `kind` / `endpoint` / `auth_token` columns (transport not yet wired).
- **Cache similarity scan is now bounded** — `loadRows()` honours `PROMPT_OPT_MAX_CANDIDATES` (default 2000), ordered by `usage_count DESC, timestamp DESC`. Avoids O(n) full‑table scans on large workspaces.
- **`Vectorizer` interface** decouples `SemanticCacheManager` from the concrete `LocalSemanticVectorizer`, paving the way for ONNX/MiniLM swaps without cache invalidation surprises.

### Tests

- New scenario 19: deterministic property‑based fuzz over the redactor and IR parser/compiler round‑trip (200 iterations × 5 known secret families). All 19 scenarios pass.

## 2.8.0 — Local model bundle + Optimize-first defaults

### Added

- **Bundled local model runtime** powered by `@xenova/transformers` and `onnxruntime-web` (offline ONNX inference). The extension can now ship a quantized seq2seq model under `models/` and use it without any network access. Phase 1 fallback: `flan-t5-small-q4`. Phase 2: a custom distilled rewriter under `models/distilled-rewriter/` is auto-preferred when present.
- **Distillation pipeline** under `scripts/distill/` (`train.py`, `export_onnx.py`, `run-pipeline.cjs`) plus npm scripts `distill` and `distill:setup` to fine-tune a small base on collected prompt-rewriting pairs and export an INT8-quantized ONNX bundle for packaging.
- **Opt-in training-data collector** (`promptProxy.collectTrainingData`, default `false`). When enabled, prompt → optimized pairs are appended to `<globalStorage>/training-pairs.jsonl`. Data never leaves the machine.
- **Sentence-shortening compressor**: the directive-line rewriter in `src/engine/textOptimizer.ts` now applies an ordered table of meaning-preserving rewrites (e.g. `in order to` → `to`, `due to the fact that` → `because`, `has the ability to` → `can`). Code blocks, imports, and code-like lines remain untouched.
- **Onboarding & README**: new “Meaning-preserving sentence shortening” section in the onboarding guide and matching bullets in both READMEs.

### Changed

- **Default run mode is now `Optimize only`** — new installs land on the analysis-first flow. The mode dropdown is reordered to surface Optimize first.
- **Agent mode no longer streams Copilot's answer into the panel.** It now optimizes locally and then opens VS Code's native Copilot Chat with the optimized prompt auto-submitted (no `@promptoptimizer` participant prefix). The panel still shows the analysis card; the response is rendered in the Chat view.
- Mode QuickPick, status bar tooltip, panel labels, and the chat participant `/mode` help text refreshed to match the new Agent semantics.
- Dependency security: added a `package.json` `overrides` block to force the nested `onnxruntime-web` under `@xenova/transformers` to the patched `1.26.0`. `npm audit --omit=dev` reports **0 vulnerabilities**.

### Notes

- Phase-1 fallback model **Flan-T5-Small (INT8 ONNX, ~93 MB)** is bundled under `models/flan-t5-small-q4/` so the local rewriter works fully offline immediately after install. Re-fetch with `npm run fetch-model`. Run `npm run distill` after collecting pairs to produce a smaller, task-specific distilled model under `models/distilled-rewriter/` (auto-preferred when present).

## 2.7.2 — Release sync

### Changed

- Version bump to 2.7.2 for Marketplace packaging and documentation alignment.

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