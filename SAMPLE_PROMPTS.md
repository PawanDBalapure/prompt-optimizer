# Sample Prompts For Prompt Optimizer

This file contains ready-to-use prompts tailored to this project.
Use these in the Prompt Optimizer input area to test optimization, context packing,
cache reuse, SDLC modes, and graph-aware retrieval.

## 1) Architecture And System Understanding

### Prompt 1: Map core architecture
Explain the architecture of this repository with a focus on runtime flow.
Include engine, VS Code extension, and IntelliJ plugin boundaries.
Show which modules are shared versus surface-specific.
Output as:
1) high-level components
2) request lifecycle
3) extension points

### Prompt 2: End-to-end optimization path
Trace how a prompt entered in the VS Code panel becomes an optimized prompt.
Start from the webview input handler and end at the engine response.
List exact functions and files involved in order.

### Prompt 3: Data flow with state
Describe how analysis state is stored, restored, and reused between runs.
Cover cache status, session buffer, and last analysis handling.

## 2) Graph And Retrieval Focused

### Prompt 4: Blast-radius analysis plan
Given a planned change to repository intelligence traversal logic,
identify all impacted modules, contracts, and command surfaces.
Include likely regression areas and test priorities.

### Prompt 5: Graph quality audit
Audit knowledge graph edge quality in this repository.
Flag edges that are likely noisy and suggest ranking or filtering improvements.
Provide concrete heuristics and where to implement them.

### Prompt 6: Hybrid retrieval tuning
Propose improvements to keyword plus vector plus graph fusion scoring.
Include a weighted formula, normalization approach, and tie-break rules.

### Prompt 7: Cross-language linking strategy
Design a practical approach to improve cross-file links for TypeScript, Java, and Python.
Start with lightweight heuristics available now, then phase into AST and LSP exact linking.

## 3) SDLC Mode Style Prompts

### Prompt 8: /plan style
Create a phased implementation plan to add Tree-sitter based parsing for TypeScript first,
then Java and Python.
Include milestones, risk controls, and acceptance criteria per phase.

### Prompt 9: /arch style
Design a local repository intelligence subsystem with:
- parser adapters
- graph storage adapter
- vector index adapter
- retrieval router
Provide interfaces and dependency boundaries.

### Prompt 10: /code style
Implement a minimal adjacency index for graph traversal to reduce repeated edge scans.
Keep changes scoped, add unit-level validation, and document complexity impact.

### Prompt 11: /review style
Review the repository intelligence module for algorithmic complexity,
memory growth risk, and data quality concerns.
Prioritize findings by severity with precise remediation.

### Prompt 12: /security style
Review ingestion and file scanning code for local security risks:
path traversal, oversized file handling, unsafe shelling, and data leakage.
Suggest hardening patches.

## 4) Prompt Optimization Behavior Checks

### Prompt 13: Multiline preservation check
panel html input prompt text area to support multi-line support.
what are the scenarios that are matching to preserve this?

### Prompt 14: Constraint extraction check
Build a VS Code extension command to export graph diagnostics.
It must be fast, avoid blocking the UI thread, and include error telemetry.
Do not use external APIs.

### Prompt 15: Noise removal check
Please can you maybe help me quickly kind of add a command that lists graph stats,
if possible, and also maybe keep it super readable?

### Prompt 16: Output discipline check
Refactor graph traversal ranking.
Return only:
1) changed files
2) exact code snippets
3) brief rationale per snippet
No narrative preamble.

## 5) Testing And Quality

### Prompt 17: Test matrix generation
Create a test matrix for repository intelligence ingestion.
Cover TS, Java, Python, markdown docs, git history presence/absence,
coverage file presence/absence, and large file cutoffs.

### Prompt 18: Edge-case suite
List edge cases for hybrid impact analysis, including:
- empty graph
- no keyword matches
- vector-only hits
- disconnected subgraphs
- heavy churn metadata
Provide expected behavior for each.

### Prompt 19: Performance benchmark prompt
Create a benchmark plan for ingestion and impact analysis.
Include dataset sizes, metrics, warm/cold runs, and pass/fail thresholds.

### Prompt 20: Regression guard prompt
Generate regression tests for multi-line task synthesis and question-style rewrite behavior.
Ensure prompts do not collapse into last-line-only task text.

## 6) Maintenance And Operations

### Prompt 21: Local observability
Design local metrics and logs for repository intelligence.
Include ingestion timing, parsed file counts, edge density, and traversal latency.
Output a minimal instrumentation checklist.

### Prompt 22: Backward compatibility plan
Propose a versioning and migration strategy for graph schema upgrades.
Cover storage compatibility, re-index triggers, and rollback behavior.

### Prompt 23: Cleanup strategy
Design a retention policy for local graph/index artifacts.
Include pruning triggers and safety checks.

## 7) Ready-To-Paste Quick Set

Use this quick set for demos:

1. Explain end-to-end prompt optimization flow from webview input to optimized output with exact file/function order.
2. Audit repository intelligence traversal quality and propose top 5 improvements with code-level insertion points.
3. Build a phased plan to move from regex parsing to Tree-sitter plus LSP semantic linking for TS/Java/Python.
4. Create a regression test plan for multiline prompt preservation and question rewrite safety.
5. Provide a performance benchmark matrix for ingestion and blast-radius query latency at small, medium, and large repository sizes.
