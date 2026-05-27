# Local Prompt Proxy Engine

Local, zero-network prompt optimization and cost forecasting for IDE integrations. No Ollama, no Docker, and no hosted model calls.

The repository now contains two surfaces:

- A reusable engine in `src/`.
- A VS Code extension in `vscode-extension/` that exposes a native `@promptproxy` chat participant and a Chat sidebar control panel.

## What It Does

- Optimizes a raw prompt locally with code-safe compression.
- Packs relevant editor context with compact anchors such as `# src/file.ts`.
- Reuses exact and semantic prompt matches from a local SQLite cache.
- Forecasts token usage with a context-aware heuristic and a pricing breakdown.
- Returns structured analysis metadata for cache hits, selected context, and cost.

## VS Code Extension Behavior

The VS Code extension can read:

- The active editor and other visible editors.
- Workspace diagnostics.
- Prompt Proxy's own buffered prompt history.
- Prompt Proxy's own `@promptproxy` chat history.

The public VS Code API does not expose the private transcript of other chat participants. That means the extension can integrate natively into the Chat view and reuse its own conversation history, but it cannot scrape the built-in Copilot transcript from another participant.

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