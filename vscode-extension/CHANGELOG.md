# Changelog

All notable changes to Prompt Optimizer are summarized here. Entries are kept
brief and high-level on purpose.

## 2.9.8

- Smarter memory context: workspace memory, knowledge-graph hints, file-recall
  summaries, and peer-workspace suggestions are now **relevance-ranked** so the
  most useful context appears first (your curated durable memory stays pinned
  at the top).
- **De-duplication**: hints that merely point at a file already shown in full
  are dropped, so the same context is no longer sent twice.
- **Token-aware budget**: the combined memory context is now capped by tokens
  (not just bytes), keeping prompts lean and leaving more room for your actual
  request. Tunable via `POMEMORY_MAX_AUGMENTED_TOKENS`.
- Recalled file summaries that haven't been refreshed in a while are now
  flagged as possibly outdated.

## 2.9.6

- Your settings, cache, conversation memory, and custom agents are now always
  preserved across marketplace updates — nothing you set up is overwritten.
- Added **Reset to Defaults**: choose exactly what to restore (settings, cache,
  memory, or custom agents). Available as a command and from the panel menu.
- Panel improvements: remove a custom agent in one click and refresh the
  overview without reloading.
- Better handling of very large prompts so optimized output is never truncated.

## 2.9.4

- Stability and reliability improvements.

## 2.9.3

- Minor fixes and polish.

## 2.9.2

- Minor fixes and polish.

## 2.9.1

- Minor fixes and polish.

## 2.9.0

- Added a credit/cost forecast breakdown so you can see estimated token usage
  before sending (figures are estimates, not actual billed amounts).
- Enterprise hardening: tamper-evident audit logging, request correlation IDs,
  and improved resilience under load.
- Performance improvements for large workspaces.

## 2.8.0

- Added a bundled offline model so optimization works without any network access.
- Optional, fully local training-data collection to improve future models.
- Meaning-preserving sentence shortening for cleaner, more concise prompts.
- New installs now default to the analysis-first "Optimize only" flow.

## 2.7.2

- Release packaging and documentation updates.

## 2.1.0

- Enterprise hardening: secret/PII redaction, structured logging, usage metrics,
  database maintenance and backup, and a built-in health check.
- Added matching commands for metrics, maintenance, backup, and health check.

## 2.0.0

- Added built-in SDLC workflow modes (plan, code, test, review, security, and more).
- Added custom agent/skill support loaded from your workspace.
- Added an Agents sidebar for enabling, editing, resetting, and creating agents.
- Smarter skill selection and improved diagnostics.
- Secret detection stays on by default and now highlights matched text.

## 1.0.0

- First release.
- Mode selector: Agent, Optimize only, and Direct send, switchable from the
  sidebar, status bar, or chat.
- Conversation memory per workspace with automatic back-reference resolution.
- Local semantic cache seeded from your project's history and context.
- Workspace-aware optimization that includes active files and diagnostics.
- Secret detection with configurable scanning and custom patterns.
- Chat commands and cache-management commands.
