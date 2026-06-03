# Prompt Optimizer

Local prompt optimization engine plus IDE integrations for VS Code and JetBrains IDEs. It rewrites prompts, packs workspace context, forecasts token/credit use, and keeps all processing on your machine until you choose to send a prompt to Copilot.

Current release: 2.9.6.

## Surfaces

- `src/` - reusable TypeScript engine and CLI.
- `vscode-extension/` - VS Code extension with sidebar, `@promptoptimizer`, prompt history, versions, agents, cache, and onboarding.
- `intellij-plugin/` - JetBrains plugin that calls the same local engine.

## What It Does

- Compresses filler, hedging, repeated context, and long English phrases.
- Preserves code blocks, imports, paths, stack traces, and code-like lines.
- Packs active file, visible editors, diagnostics, recent saves, memory files, git history, knowledge graph links, and optional peer-workspace cache hits.
- Reuses exact and semantic matches from a local SQLite cache.
- Applies built-in SDLC modes: `/plan`, `/arch`, `/code`, `/test`, `/review`, `/security`, `/qa`, `/devops`, `/docs`, `/pr`, `/full`, `/bug-fix`, `/refactor`.
- Loads custom skills from `.promptoptimizer/skills/*.md` or `PROMPT_OPTIMIZER_SKILLS_DIR`.
- Detects secrets before sending and supports custom secret patterns.
- Tracks conversation memory, prompt history, prompt branches, prompt commits, and tags per workspace.
- Forecasts token cost and monthly credit overage by selected plan/model.
- Preserves user settings, memory, cache, and custom agents across marketplace updates.
- Provides an opt-in reset command for settings, cache, conversation memory, and custom agents.

## VS Code Quick Start

1. Open the Prompt Optimizer sidebar from the Chat view or command palette.
2. Choose a mode: `Optimize only`, `Agent`, or `Direct send`.
3. Type a prompt, press `Ctrl+Enter`, review the optimized prompt and forecast, then send when ready.
4. Use the gear menu for secret detection and reset-to-defaults options.

Useful commands:

```text
Prompt Optimizer: Focus Control Panel
Prompt Optimizer: Open Chat Participant
Prompt Optimizer: Open Prompt Optimizer Guide
Prompt Optimizer: Select Mode (Agent / Optimize / Direct)
Prompt Optimizer: Optimize Clipboard & Cost Forecast
Prompt Optimizer: Reset to Defaults
```

## Engine API

```ts
import { PromptProxyEngine } from 'prompt-proxy-engine';

const engine = new PromptProxyEngine({ db_path: 'prompt_semantic_cache.db' });
await engine.initialize();

const response = await engine.processRequest({
  raw_prompt: 'Fix the restart policy and answer in JSON.',
  ide_context: {
    workspace_root: process.cwd(),
    active_file: {
      path: 'src/service.ts',
      language: 'ts',
      selection: 'return restartPolicy;',
      content: 'export function configureService() { return restartPolicy; }',
      is_active: true
    },
    logs: [{ source: 'Terminal', kind: 'terminal', content: 'ERROR restart failed' }]
  }
});

console.log(response.optimized_prompt);
console.log(response.analysis.cache.status);
```

## CLI

```bash
npm run build
echo "{\"raw_prompt\":\"Fix the restart policy\"}" | node dist/cli.js --stdin
node dist/cli.js --file request.json --db prompt_semantic_cache.db
node dist/cli.js --list-modes --workspace-root .
```

Operations:

```bash
node dist/cli.js --health-check --db prompt_semantic_cache.db
node dist/cli.js --metrics --db prompt_semantic_cache.db
node dist/cli.js --db-prune --older-than-days 90 --db prompt_semantic_cache.db
node dist/cli.js --export-db ./backup.db --db prompt_semantic_cache.db
node dist/cli.js --audit-log --verify --db prompt_semantic_cache.db
node dist/cli.js --schema
```

## Privacy

- No telemetry.
- No hosted optimizer backend.
- Cache, memory, knowledge graph, prompt versions, and agents stay local.
- The only network request is the Copilot request you explicitly trigger from VS Code.
- Audit logging stores hashes by default; raw prompt bodies are opt-in with `PROMPT_OPT_AUDIT_RAW=1`.

## Configuration

The engine reads settings from environment variables and optional config files:

- `~/.promptoptimizer/config.json`
- `<workspace>/.promptoptimizer/config.json`

Common environment knobs:

| Variable | Purpose |
| --- | --- |
| `PROMPT_OPT_LOG_LEVEL` | `debug`, `info`, `warn`, `error`, or `silent` |
| `PROMPT_OPT_REDACT` | Set `0` to disable persistence-time secret redaction |
| `PROMPT_OPT_REDACT_PII` | Set `1` to also redact email, phone, SSN, and card-like values |
| `PROMPT_OPT_MAX_CANDIDATES` | Max cache rows scanned for semantic similarity |
| `PROMPT_OPT_AUDIT_ENABLED` | Set `0` to disable audit logging |
| `PROMPT_OPT_OTLP_ENDPOINT` | Default endpoint for OTLP metrics export |
| `POMEMORY_MAX_TOTAL_BYTES` | Total workspace-memory context budget |

## Build

```bash
npm install
npm run build
npm test
npm --prefix vscode-extension run compile
```

Known local packaging commands:

```bash
cd vscode-extension && npx @vscode/vsce package
cd intellij-plugin && ./gradlew buildPlugin
```

## Reset And Update Behavior

Marketplace updates replace only packaged extension files. User settings, `.promptoptimizer/` files, cache databases, memory, prompt versions, and custom agents are outside the package and are preserved. To intentionally restore defaults, run `Prompt Optimizer: Reset to Defaults` and pick the exact surfaces to reset.
