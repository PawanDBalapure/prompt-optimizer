# Changelog

All notable changes to the Prompt Proxy IntelliJ plugin are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [1.0.0] — 2026-01-01

### Added
- Tool window panel (sidebar) with prompt input, Optimize button, and results display
- Token metrics bar: original tokens, optimized tokens, tokens saved, estimated cost (USD)
- Semantic cache status display (miss / exact / semantic match with confidence %)
- Improvements list from the engine optimizer
- Copy-to-clipboard button for the optimized prompt
- Editor right-click action: "Optimize with Prompt Proxy" (Ctrl+Alt+P)
- Settings page under IDE Settings > Tools > Prompt Proxy
  - Node.js executable path
  - Engine CLI path (path to `dist/cli.js`)
  - SQLite cache path (optional)
  - Enable / disable secret detection
  - Include / exclude active editor file as context
- Bundles the engine dist at build time via `copyEngine` Gradle task
- Compatible with IntelliJ IDEA 2024.1 → 2025.1.*
