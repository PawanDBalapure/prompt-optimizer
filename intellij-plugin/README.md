# Prompt Proxy — IntelliJ Plugin

Local prompt optimization, semantic cache reuse, and token cost forecasting for all JetBrains IDEs.

---

## Requirements

| Dependency | Version |
|---|---|
| JetBrains IDE (IC/IU/GO/PY…) | 2024.1+ |
| JDK (for building) | 17+ |
| Node.js (for running) | 18+ |

---

## Quick Start (development)

```bash
# 1. Build the Node.js engine first (repo root)
cd ..
npm install
npm run build           # produces dist/cli.js

# 2. Open the plugin project in IntelliJ
cd intellij-plugin
./gradlew runIde        # launches a sandboxed IDE with the plugin installed
```

After launching the sandbox IDE:
1. Open **Settings > Tools > Prompt Proxy**
2. Set **Engine CLI path** to the absolute path of `<repo>/dist/cli.js`
3. Node.js path is `node` by default — change it if your binary is elsewhere

---

## Build & Package

```bash
./gradlew buildPlugin       # produces build/distributions/prompt-proxy-intellij-1.0.0.zip
```

---

## Publish to JetBrains Marketplace

### One-time setup

1. Create an account at <https://plugins.jetbrains.com>
2. Generate a **permanent token** in your profile → **Tokens**
3. Obtain a **code-signing certificate** from the JetBrains [plugin signing docs](https://plugins.jetbrains.com/docs/intellij/plugin-signing.html)

### CI publish (GitHub Actions example)

```yaml
- name: Publish Plugin
  env:
    PUBLISH_TOKEN: ${{ secrets.PUBLISH_TOKEN }}
    CERTIFICATE_CHAIN: ${{ secrets.CERTIFICATE_CHAIN }}
    PRIVATE_KEY: ${{ secrets.PRIVATE_KEY }}
    PRIVATE_KEY_PASSWORD: ${{ secrets.PRIVATE_KEY_PASSWORD }}
  run: ./gradlew signPlugin publishPlugin
```

### Manual publish

```bash
export PUBLISH_TOKEN=<your-token>
export CERTIFICATE_CHAIN=$(cat chain.crt)
export PRIVATE_KEY=$(cat private.pem)
export PRIVATE_KEY_PASSWORD=<key-password>
./gradlew signPlugin publishPlugin
```

---

## Architecture

```
intellij-plugin/
├── build.gradle.kts             # IntelliJ Platform Plugin Gradle Plugin v2
├── gradle.properties            # versions & plugin metadata
├── src/main/
│   ├── kotlin/com/promptproxy/intellij/
│   │   ├── PromptProxyToolWindowFactory.kt  — registers the sidebar panel
│   │   ├── PromptProxyPanel.kt              — Swing UI (input/output/metrics)
│   │   ├── PromptProxyService.kt            — calls Node.js engine subprocess
│   │   ├── PromptProxyAppSettings.kt        — persistent settings (Kotlin data class)
│   │   ├── PromptProxyConfigurable.kt       — settings page UI
│   │   └── OptimizeSelectionAction.kt       — right-click "Optimize with Prompt Proxy"
│   └── resources/
│       ├── META-INF/plugin.xml              — plugin descriptor
│       └── icons/promptproxy.svg
└── gradle/wrapper/
    └── gradle-wrapper.properties
```

The plugin shells out to the same `dist/cli.js` used by the VS Code extension:
```
node <engineCliPath> --stdin   (input: JSON, output: JSON)
```

---

## Engine JSON contract

**Input** (sent to stdin):
```json
{
  "prompt": "string",
  "enableSecretDetection": true,
  "dbPath": "/optional/path/to/cache.db",
  "editorSnapshots": [{ "path": "active-file", "content": "..." }]
}
```

**Output** (read from stdout):
```json
{
  "optimized_prompt": "string",
  "metrics": {
    "original_tokens": 120,
    "optimized_tokens": 84,
    "tokens_saved": 36,
    "estimated_cost_usd": 0.00017
  },
  "cache": { "status": "miss" },
  "improvements": ["Removed filler words", "Collapsed redundant context"]
}
```
