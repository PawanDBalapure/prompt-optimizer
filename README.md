# Local Prompt Proxy Engine

Local, zero-network prompt optimization and cost forecasting for IDE integrations. No Ollama, no Docker, and no hosted model calls.

The repository now contains two surfaces:

- A reusable engine in `src/`.
- A VS Code extension in `vscode-extension/` that exposes a native `@promptoptimizer` chat participant and a Chat sidebar control panel.

Current release: 2.8.0.

## What It Does

- Optimizes a raw prompt locally with code-safe compression.
- Shortens English sentences when the meaning stays the same, while preserving code blocks and code-like lines.
- Packs relevant editor context with compact anchors such as `# src/file.ts`.
- Reuses exact and semantic prompt matches from a local SQLite cache.
- Applies SDLC modes through slash commands, built-in intent rules, and custom workspace skill definitions.
- Forecasts token usage with a context-aware heuristic and a pricing breakdown.
- Returns structured analysis metadata for cache hits, selected context, and cost.

## VS Code Extension Behavior

The VS Code extension can read:

- The active editor and other visible editors.
- Workspace diagnostics.
- Prompt Proxy's own buffered prompt history.
- Prompt Proxy's own `@promptoptimizer` chat history.

The public VS Code API does not expose the private transcript of other chat participants. That means the extension can integrate natively into the Chat view and reuse its own conversation history, but it cannot scrape the built-in Copilot transcript from another participant.

## SDLC Modes And Custom Skills

The engine now supports a scored skill registry on top of the optimizer pipeline.

- Built-in SDLC modes include `/plan`, `/arch`, `/code`, `/test`, `/review`, `/security`, `/qa`, `/devops`, `/docs`, `/pr`, `/full`, `/bug-fix`, and `/refactor`.
- Custom skills load from `<workspace>/.promptoptimizer/skills/*.md` and from the optional `PROMPT_OPTIMIZER_SKILLS_DIR` environment variable.
- Skill frontmatter supports `slashAliases`, `intentPatterns`, `keywords`, `requires`, `filePatterns`, `priority`, `tags`, and `rolePreface`, plus checklist items in frontmatter or markdown.
- Skill files hot-reload on the next prompt, and the CLI `--list-modes` surface reports both registered modes and load errors.
- The VS Code extension bundles reusable SDLC agent definitions and exposes an Agents panel action to enable, edit, reset, and disable them per workspace.

## Runtime Dependencies

- `src/SemanticCacheManager.ts`
- `src/PromptProxyEngine.ts`

## JSON Response Contract

```json
{
  "metrics": {
    "raw_input_tokens": 0,
    "optimized_input_tokens": 0,
    "tokens_saved": 0,
    "estimated_output_tokens": 0,
    "estimated_cost_usd": 0.0
  },
  "optimized_prompt": "",
  "improvements": [
    "Specify the exact output format.",
    "Limit the request to the smallest failing snippet."
  ],
  "analysis": {
    "cache": {
      "status": "miss",
      "confidence": 0,
      "candidates": []
    },
    "context": {
      "workspace_root": "",
      "active_file": "",
      "selected_files": [],
      "selected_logs": [],
      "log_sources": [],
      "open_file_count": 0,
      "total_log_count": 0
    },
    "cost": {
      "input_cost_usd": 0.0,
      "output_cost_usd": 0.0,
      "total_cost_usd": 0.0,
      "input_cost_per_1k_tokens": 0.0015,
      "output_cost_per_1k_tokens": 0.002
    }
  }
}
```

## Core API

```ts
import { PromptProxyEngine } from 'prompt-proxy-engine';

const engine = new PromptProxyEngine({ db_path: 'prompt_semantic_cache.db' });
await engine.initialize();

const response = await engine.processRequest({
  raw_prompt: 'Fix the failing restart policy and answer in JSON.',
  ide_context: {
    active_file: {
      path: 'src/systemd.ts',
      language: 'ts',
      selection: 'return restartPolicy;',
      content: 'export function configureService() {\n  return restartPolicy;\n}',
      is_active: true
    },
    logs: [
      {
        source: 'Terminal',
        kind: 'terminal',
        content: 'ERROR restart failed'
      }
    ]
  }
});

console.log(response.analysis.cache.status);
console.log(response.analysis.cost.total_cost_usd);
```

## VS Code Integration

Use the dependency-free adapter from `src/adapters/VSCodePromptProxyAdapter.ts`.

```ts
import { VSCodePromptProxyAdapter } from 'prompt-proxy-engine';

const adapter = new VSCodePromptProxyAdapter();
await adapter.initialize();

const result = await adapter.process({
  raw_prompt: userPrompt,
  workspace_root: context.globalStorageUri.fsPath,
  active_editor: {
    path: editor.document.uri.fsPath,
    content: editor.document.getText(),
    selection: editor.document.getText(editor.selection),
    language_id: editor.document.languageId,
    is_active: true,
  },
  visible_editors: vscode.window.visibleTextEditors.map((item) => ({
    path: item.document.uri.fsPath,
    content: item.document.getText(),
    selection: item.document.getText(item.selection),
    language_id: item.document.languageId,
    is_active: item === editor,
  })),
  problems: ['src/systemd.ts:3 restart policy mismatch'],
});
```

## IntelliJ Integration

Use the dependency-free adapter from `src/adapters/IntelliJPromptProxyAdapter.ts`, or call the CLI sidecar from a JetBrains plugin process.

```ts
import { IntelliJPromptProxyAdapter } from 'prompt-proxy-engine';

const adapter = new IntelliJPromptProxyAdapter();
await adapter.initialize();

const result = await adapter.process({
  raw_prompt: userPrompt,
  project_root: projectPath,
  active_editor: {
    path: filePath,
    content: fileText,
    selection: selectedText,
    language: fileLanguage,
    is_active: true,
  },
  inspection_messages: problems,
  run_console: consoleLines,
});
```

## CLI Sidecar

The CLI prints a single JSON object to stdout and is suitable for plugin sidecar execution.

```bash
echo "{\"raw_prompt\":\"Fix the restart policy\"}" | node dist/cli.js --stdin
```

You can also pass a request file:

```bash
node dist/cli.js --file request.json --db prompt_semantic_cache.db
```

To inspect the active mode/skill registry for a workspace:

```bash
node dist/cli.js --list-modes --workspace-root .
```

## Enterprise Operations

The engine ships production-grade operability for self-hosted deployments. All commands write a single JSON object to stdout.

```bash
# Run integrity + schema + table checks (PRAGMA quick_check + required tables + pragmas + sizes)
node dist/cli.js --health-check --db prompt_semantic_cache.db

# Inspect persisted counters (requests, cache hits/writes, redaction hits, maintenance)
node dist/cli.js --metrics --db prompt_semantic_cache.db
node dist/cli.js --metrics --reset --db prompt_semantic_cache.db

# Retention / eviction with overridable caps and optional VACUUM
node dist/cli.js --db-prune --max-cache 10000 --max-digests 5000 --max-kg 20000 \
  --older-than-days 90 --vacuum --db prompt_semantic_cache.db

# Online backup (uses better-sqlite3 db.backup() with a WAL checkpoint+copy fallback)
node dist/cli.js --export-db ./backup.db --db prompt_semantic_cache.db

# Validate that the redactor catches representative secrets
node dist/cli.js --redact-test
```

### Environment knobs

| Variable | Default | Effect |
| --- | --- | --- |
| `PROMPT_OPT_LOG_LEVEL` | `warn` | `debug` / `info` / `warn` / `error` / `silent` — controls stderr logging |
| `PROMPT_OPT_LOG_FORMAT` | `text` | Set to `json` for structured logs in shipping pipelines |
| `PROMPT_OPT_REDACT` | `1` | Set to `0` to disable persistence-time secret redaction (not recommended) |
| `PROMPT_OPT_REDACT_PII` | `0` | Set to `1` to additionally redact email / phone / SSN / credit card |
| `POMEMORY_MAX_BYTES_PER_FILE` | `12000` | Per-file byte cap when ingesting workspace memory (AGENTS.md / CLAUDE.md / etc.) |
| `POMEMORY_MAX_TOTAL_BYTES` | `24000` | Aggregate byte cap across all workspace memory files |
| `POMEMORY_MAX_AUGMENTED_BYTES` | `18000` | Hard ceiling on the combined memory + KG + digests + peer context the engine prepends |
| `PROMPT_OPT_MAX_CANDIDATES` | `2000` | Cap on rows scanned per semantic similarity query (highest `usage_count` first) |
| `PROMPT_OPT_AUDIT_ENABLED` | `1` | Set to `0` to disable the tamper-evident `audit_log` table entirely |
| `PROMPT_OPT_AUDIT_RAW` | `0` | Set to `1` to persist raw prompt text in the audit log (default: hash-only) |
| `PROMPT_OPT_OTLP_ENDPOINT` | _unset_ | Default OTLP/HTTP endpoint used by `--metrics-otlp` when no `--otlp-endpoint` is given |
| `PROMPT_OPT_AUGMENT_RPS` | `4` | Per-augment-source rate limit (memory / kg / digest / peers) |
| `PROMPT_OPT_AUGMENT_BREAKER` | `5` | Consecutive-failure threshold before an augment source is tripped |
| `PROMPT_OPT_AUGMENT_COOLDOWN` | `30000` | Cool-down (ms) after the breaker trips before retrying |

The same keys are also accepted from a JSON config file.  At engine
startup we read, in priority order (later wins): `~/.promptoptimizer/config.json`,
`<workspace_root>/.promptoptimizer/config.json`, and finally the
environment variables above.  Use the file form for fleet rollouts and the
env vars for ad-hoc local overrides.

### Correlation IDs

Every `PromptOptimizationResponse` now carries a 32-char hex `request_id`.
Callers can supply their own via `request.correlation_id` (must be 32 hex
chars) — the engine echoes it back so distributed traces line up across
the IDE and the optimizer sidecar.

### Compliance: tamper-evident audit log

Cache writes, cache clears, peer changes, and redaction events are
appended to an `audit_log` table.  Each row stores a SHA-256 prompt hash
(raw bodies are off by default) and a chained `row_hash` so a missing or
mutated row breaks the chain.  Inspect with:

```bash
node dist/cli.js --audit-log --limit 50          # last 50 events
node dist/cli.js --audit-log --verify            # walk the chain
```

### What is hardened

- **SQLite**: WAL journaling, 5s busy timeout, `synchronous=NORMAL`, `foreign_keys=ON`, schema-version row (currently 5) for forward-compatible migrations.
- **Secret / PII redaction** at every persistence boundary (semantic cache writes, workspace memory snapshots, file digest summaries).
- **Metrics** persisted in an `engine_metrics` table; counters are incremented on every request, cache outcome, write, redaction hit, and maintenance run.
- **Retention** caps the database row growth per workspace and prunes stale entries.
- **Health check** validates integrity, schema version, and that all 9 required tables exist.
- **Online backup** produces a consistent point-in-time copy without stopping the engine.

### Error reporting

Engine subsystems funnel their failures through a single helper
(`reportEngineError` in `src/engine/logger.ts`).  The helper:

1. emits a structured log line on stderr respecting `PROMPT_OPT_LOG_LEVEL` and `PROMPT_OPT_LOG_FORMAT`;
2. increments an `errors.<scope>` counter in the `engine_metrics` table whenever a `MetricsRegistry` is supplied (which `PromptProxyEngine` and `SemanticCacheManager` both do).

Inspect failures with:

```bash
node dist/cli.js --metrics --db prompt_semantic_cache.db | jq '.[] | select(.metric | startswith("errors."))'
```

Recognised counter scopes include `errors.cache_lookup`, `errors.cache_search`, `errors.cache_write`, `errors.cache_check`, `errors.cache_clear`, `errors.cache_prune`, `errors.cache_semantic_search`, `errors.versioning_record`, `errors.augment_memory`, `errors.augment_kg`, `errors.augment_digest`, `errors.augment_peers`, and `errors.augment_global_peer`.  The augment-* scopes log at `warn` level because the optimizer always recovers; cache-* scopes log at `error`.  The VS Code extension wires its own `reportError()` (in `vscode-extension/src/util/errorReporter.ts`) for user-facing toasts with a one-click "📧 Email author" recovery action.

### Metrics export (OpenTelemetry)

Counters can be exported in OTLP/JSON line-protocol shape so any
OpenTelemetry Collector / Fluent Bit / Vector sidecar can ingest them
without a custom plug-in:

```bash
# Print to stdout (pipe into a sidecar):
node dist/cli.js --metrics-otlp

# Or POST directly to an OTLP/HTTP collector:
node dist/cli.js --metrics-otlp --otlp-endpoint https://otel.example.com/v1/metrics
```

### Validating requests against the contract

The CLI ships the JSON Schema that mirrors `src/contracts.ts`:

```bash
node dist/cli.js --schema > contracts.schema.json
```

Use it from CI / IntelliJ / curl pipelines to validate request shapes
without taking a TypeScript dependency.

## VS Code Extension Package

The extension-specific README that shows up in VS Code now lives in `vscode-extension/README.md`.

Build it from the repository root like this:

```bash
npm install
npm run build
cd vscode-extension
npm install
npm run compile
```

After that you can run the extension in VS Code with an Extension Development Host, or package it into a VSIX from `vscode-extension/`.

## Validation

- Build: `npm run build`
- End-to-end verification: `npm run test`
- Extension compile: `cd vscode-extension && npm run compile`