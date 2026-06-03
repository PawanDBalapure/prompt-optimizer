<!-- markdownlint-disable MD024 -->

# Changelog

All notable changes to the Prompt Proxy IntelliJ plugin are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [2.9.8] - 2026-06-04

### Changed

- Memory augmentations (workspace memory, knowledge graph, file recall, peer
  workspaces) are now relevance-ranked with curated durable memory pinned
  first, combating "lost-in-the-middle" context drift.
- Augmentations that duplicate a file already inlined in the IDE context are
  removed before the prompt is built.
- The combined augmentation context is bounded by a precise token budget
  (tunable via `POMEMORY_MAX_AUGMENTED_TOKENS`) instead of a byte cap only,
  reducing token bloat.

### Added

- Stale file-digest summaries are tagged as possibly outdated
  (threshold tunable via `POMEMORY_DIGEST_STALE_DAYS`).

---

## [2.9.6] - 2026-06-03

### Added

- VS Code parity-oriented tool window tabs for optimization, context/memory, admin tools, and onboarding.
- Mode controls for `optimize`, `agent`, and `direct`, plus target model selection for GPT, Claude, Gemini, and local workflows.
- Workspace memory, memory recall, peer workspace management, knowledge graph stats, studied-file digests, cache stats, health checks, metrics, maintenance, and database export actions.
- Expanded settings for source picker, context packing, processing mode, pricing, monthly credit forecast, auto-copy behavior, and custom secret regex rules.

### Changed

- Bundles the prepared shared engine runtime from the VS Code extension packaging path for closer runtime parity.
- Uses the modern shared engine JSON contract with `raw_prompt`, `workspace_id`, `target_model`, `pricing`, and `ide_context`.
- Updates plugin docs and in-plugin onboarding to match the current Prompt Optimizer feature set.

## [2.7.2] - 2026-05-30

### Changed

- Version bump to 2.7.2 for IntelliJ plugin release alignment.

## [1.0.0] — 2026-01-01

### Added

- First release of the Prompt Proxy IntelliJ plugin.
- Sidebar tool window with prompt input, one-click optimization, and results.
- Token and estimated-cost metrics, plus semantic cache status.
- Editor right-click action to optimize the current selection (Ctrl+Alt+P).
- Settings page under IDE Settings > Tools > Prompt Proxy.
- Compatible with IntelliJ IDEA 2024.1 → 2025.1.*.
