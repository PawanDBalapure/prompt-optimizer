// import assert from 'node:assert/strict';
// import * as fs from 'node:fs';
// import * as path from 'node:path';
// import * as os from 'node:os';

// /**
//  * Instruction Studio – solid test cases
//  *
//  * These tests exercise the core Instruction Studio logic:
//  *  - graph validation
//  *  - compile (programmatic)
//  *  - conflict detection
//  *  - disabled rules
//  *  - presets
//  *  - custom persona CRUD
//  *  - trace matrix
//  *  - analytics
//  *  - telemetry artifacts
//  *  - insights & replay
//  *  - webview rule model serialization
//  */

// // ---------------------------------------------------------------------------
// // Helpers
// // ---------------------------------------------------------------------------

// function mkTempDir(): string {
//   return fs.mkdtempSync(path.join(os.tmpdir(), 'po-instr-test-'));
// }

// // ---------------------------------------------------------------------------
// // Test 1 – Graph validation
// // ---------------------------------------------------------------------------
// export function testGraphValidation(): void {
//   console.log('  [Instruction Studio] graph validation...');

//   const { compileInstructionStudioGraph } = require('../engine/instructionStudio.js');

//   // Valid graph
//   const validGraph = {
//     workflowName: 'Valid',
//     nodes: [
//       { id: 'p', type: 'persona', label: 'Architect' },
//       { id: 'c', type: 'condition', label: 'Always' },
//       { id: 's', type: 'agentScope', label: 'Review' },
//       { id: 'r', type: 'rule', text: 'Validate inputs.' },
//     ],
//     edges: [
//       { from: 'p', to: 'c' },
//       { from: 'c', to: 's' },
//       { from: 's', to: 'r' },
//     ],
//   };
//   const validResult = compileInstructionStudioGraph(validGraph);
//   assert.ok(validResult.markdown.includes('# Workflow: Valid'), 'valid graph should compile');

//   // Invalid graph – missing node referenced in edge
//   const invalidGraph = {
//     workflowName: 'Broken',
//     nodes: [{ id: 'r1', type: 'rule', text: 'Do thing' }],
//     edges: [{ from: 'r1', to: 'missing' }],
//   };
//   assert.throws(
//     () => compileInstructionStudioGraph(invalidGraph),
//     /Instruction Studio graph:/,
//     'invalid graph must throw validation error',
//   );

//   console.log('  [Instruction Studio] graph validation: PASSED');
// }

// // ---------------------------------------------------------------------------
// // Test 2 – Compile output consistency
// // ---------------------------------------------------------------------------
// export function testCompileOutput(): void {
//   console.log('  [Instruction Studio] compile output...');

//   const { compileInstructionStudioGraph, writeInstructionStudioSnapshot } =
//     require('../engine/instructionStudio.js');

//   const root = mkTempDir();
//   const graph = {
//     workflowName: 'Security Flow',
//     nodes: [
//       { id: 'persona', type: 'persona', label: 'Security Expert' },
//       { id: 'condition', type: 'condition', label: 'If endpoint accepts payload' },
//       { id: 'priority', type: 'priority', label: 'High' },
//       { id: 'scope', type: 'agentScope', label: 'Security Analysis' },
//       { id: 'rule', type: 'rule', text: 'Validate request payloads before writes.' },
//     ],
//     edges: [
//       { from: 'persona', to: 'condition' },
//       { from: 'condition', to: 'priority' },
//       { from: 'priority', to: 'scope' },
//       { from: 'scope', to: 'rule' },
//     ],
//   };

//   const compiled = compileInstructionStudioGraph(graph);
//   assert.ok(compiled.markdown.includes('# Workflow: Security Flow'));
//   assert.ok(compiled.markdown.includes('## Persona: Security Expert'));
//   assert.ok(compiled.markdown.includes('### Condition: If endpoint accepts payload'));
//   assert.ok(compiled.markdown.includes('[High] (Security Analysis) Validate request payloads before writes.'));

//   const snapshot = writeInstructionStudioSnapshot(root, graph);
//   assert.ok(fs.existsSync(snapshot.files.instructions), 'instructions.md must be written');
//   assert.ok(fs.existsSync(snapshot.files.manifest), 'instruction-manifest.json must be written');

//   const instructions = fs.readFileSync(snapshot.files.instructions, 'utf8');
//   assert.ok(instructions.includes('# Workflow: Security Flow'));
//   assert.ok(instructions.includes('## Persona: Security Expert'));
//   assert.ok(instructions.includes('### Condition: If endpoint accepts payload'));
//   assert.ok(instructions.includes('[High] (Security Analysis) Validate request payloads before writes.'));

//   const manifest = JSON.parse(fs.readFileSync(snapshot.files.manifest, 'utf8')) as {
//     workflowName: string;
//     entries: Array<{ text: string; persona: string; condition: string }>;
//   };
//   assert.equal(manifest.workflowName, 'Security Flow');
//   assert.equal(manifest.entries[0].persona, 'Security Expert');
//   assert.equal(manifest.entries[0].condition, 'If endpoint accepts payload');

//   console.log('  [Instruction Studio] compile output: PASSED');
// }

// // ---------------------------------------------------------------------------
// // Test 3 – Conflict detection
// // ---------------------------------------------------------------------------
// export function testConflictDetection(): void {
//   console.log('  [Instruction Studio] conflict detection...');

//   const { detectInstructionStudioConflicts } = require('../engine/instructionStudio.js');

//   const graph = {
//     workflowName: 'Conflict Workflow',
//     nodes: [
//       { id: 'r1', type: 'rule', text: 'Never edit package.json dependencies.' },
//       { id: 'r2', type: 'rule', text: 'Update package.json dependencies to latest versions.' },
//       { id: 'r3', type: 'rule', text: 'Update package.json dependencies to latest versions.' },
//     ],
//     edges: [],
//   };

//   const conflicts = detectInstructionStudioConflicts(graph);
//   assert.ok(
//     conflicts.some((c) => c.code === 'duplicate-rule'),
//     'expected duplicate-rule warning',
//   );
//   assert.ok(
//     conflicts.some((c) => c.code === 'opposing-edit-intent'),
//     'expected opposing-edit-intent warning',
//   );
//   assert.ok(
//     conflicts.every((c) => c.severity === 'warning' || c.severity === 'error'),
//     'severity should be warning or error',
//   );

//   console.log('  [Instruction Studio] conflict detection: PASSED');
// }

// // ---------------------------------------------------------------------------
// // Test 4 – Disabled rules excluded from compile & conflicts
// // ---------------------------------------------------------------------------
// export function testDisabledRules(): void {
//   console.log('  [Instruction Studio] disabled rules...');

//   const {
//     compileInstructionStudioGraph,
//     writeInstructionStudioSnapshot,
//     detectInstructionStudioConflicts,
//   } = require('../engine/instructionStudio.js');

//   const root = mkTempDir();
//   const graph = {
//     workflowName: 'Disabled Rule Workflow',
//     nodes: [
//       { id: 'persona', type: 'persona', label: 'Architect' },
//       { id: 'condition', type: 'condition', label: 'Always' },
//       { id: 'scope', type: 'agentScope', label: 'Testing' },
//       { id: 'rule-on', type: 'rule', text: 'Add regression tests for modified code.', active: true },
//       { id: 'rule-off', type: 'rule', text: 'Add regression tests for modified code.', active: false },
//     ],
//     edges: [
//       { from: 'persona', to: 'condition' },
//       { from: 'condition', to: 'scope' },
//       { from: 'scope', to: 'rule-on' },
//       { from: 'scope', to: 'rule-off' },
//     ],
//   };

//   // Compile
//   const compiled = compileInstructionStudioGraph(graph);
//   assert.equal(compiled.manifest.entries.length, 1, 'only active rule should be compiled');
//   assert.equal(compiled.manifest.entries[0].nodeId, 'rule-on');

//   const snapshot = writeInstructionStudioSnapshot(root, graph);
//   const manifest = JSON.parse(fs.readFileSync(snapshot.files.manifest, 'utf8')) as {
//     entries: Array<{ nodeId: string; text: string }>;
//   };
//   assert.equal(manifest.entries.length, 1, 'only active rule should be compiled');
//   assert.equal(manifest.entries[0].nodeId, 'rule-on');

//   // Conflicts
//   const conflicts = detectInstructionStudioConflicts(graph);
//   assert.ok(
//     !conflicts.some((c) => c.code === 'duplicate-rule'),
//     'disabled duplicate rule should not trigger duplicate-rule conflict',
//   );

//   // Opposing edit intent with disabled rule
//   const opposingGraph = {
//     workflowName: 'Disabled Opposing',
//     nodes: [
//       { id: 'persona', type: 'persona', label: 'Architect' },
//       { id: 'condition', type: 'condition', label: 'Always' },
//       { id: 'scope', type: 'agentScope', label: 'Code Generation' },
//       { id: 'rule-edit', type: 'rule', text: 'Update package json dependencies for security patches.' },
//       { id: 'rule-no-edit', type: 'rule', text: 'Never edit package json dependencies.', active: false },
//     ],
//     edges: [
//       { from: 'persona', to: 'condition' },
//       { from: 'condition', to: 'scope' },
//       { from: 'scope', to: 'rule-edit' },
//       { from: 'scope', to: 'rule-no-edit' },
//     ],
//   };
//   const opposingConflicts = detectInstructionStudioConflicts(opposingGraph);
//   assert.ok(
//     !opposingConflicts.some((c) => c.code === 'opposing-edit-intent'),
//     'disabled opposing rule should not trigger opposing-edit-intent conflict',
//   );

//   console.log('  [Instruction Studio] disabled rules: PASSED');
// }

// // ---------------------------------------------------------------------------
// // Test 5 – Presets endpoint
// // ---------------------------------------------------------------------------
// export function testPresets(): void {
//   console.log('  [Instruction Studio] presets...');

//   const { getInstructionStudioPresets } = require('../engine/instructionStudio.js');

//   const presets = getInstructionStudioPresets();
//   assert.ok(Array.isArray(presets) && presets.length >= 4, 'expected preset catalog');
//   assert.ok(
//     presets.some((p) => p.category === 'Security'),
//     'preset catalog should include Security category',
//   );

//   // Compile a preset
//   const preset = presets.find((p) => p.id === 'security-input-validation') ?? presets[0];
//   const { compileInstructionStudioGraph, writeInstructionStudioSnapshot } =
//     require('../engine/instructionStudio.js');

//   const root = mkTempDir();
//   const graph = {
//     workflowName: preset.workflowName,
//     nodes: [
//       { id: 'persona', type: 'persona', label: preset.persona },
//       { id: 'condition', type: 'condition', label: preset.condition },
//       { id: 'priority', type: 'priority', label: preset.priority },
//       { id: 'scope', type: 'agentScope', label: preset.agentScope },
//       { id: 'rule', type: 'rule', text: preset.ruleText },
//     ],
//     edges: [
//       { from: 'persona', to: 'condition' },
//       { from: 'condition', to: 'priority' },
//       { from: 'priority', to: 'scope' },
//       { from: 'scope', to: 'rule' },
//     ],
//   };

//   const compiled = compileInstructionStudioGraph(graph);
//   assert.ok(compiled.markdown.includes(`# Workflow: ${preset.workflowName}`));
//   assert.ok(compiled.markdown.includes(`## Persona: ${preset.persona}`));
//   assert.ok(compiled.markdown.includes(`### Condition: ${preset.condition}`));
//   assert.ok(compiled.markdown.includes(`[${preset.priority}] (${preset.agentScope}) ${preset.ruleText}`));

//   const snapshot = writeInstructionStudioSnapshot(root, graph);
//   const instructions = fs.readFileSync(snapshot.files.instructions, 'utf8');
//   assert.ok(instructions.includes(`# Workflow: ${preset.workflowName}`));
//   assert.ok(instructions.includes(`## Persona: ${preset.persona}`));
//   assert.ok(instructions.includes(`### Condition: ${preset.condition}`));
//   assert.ok(instructions.includes(`[${preset.priority}] (${preset.agentScope}) ${preset.ruleText}`));

//   console.log('  [Instruction Studio] presets: PASSED');
// }

// // ---------------------------------------------------------------------------
// // Test 6 – Custom persona CRUD
// // ---------------------------------------------------------------------------
// export function testCustomPersonaCRUD(): void {
//   console.log('  [Instruction Studio] custom persona CRUD...');

//   const {
//     saveCustomPersona,
//     listCustomPersonas,
//     deleteCustomPersona,
//   } = require('../engine/instructionStudio.js');

//   const root = mkTempDir();
//   const savePayload = {
//     label: 'Payments Security Reviewer',
//     workflowName: 'Payments Security Flow',
//     persona: 'Payments Security Reviewer',
//     condition: 'If file touches payment handlers',
//     priority: 'High',
//     agentScope: 'Security Analysis',
//     ruleText: 'Validate inputs and summarize security risks before completion.',
//   };

//   // Save
//   const saved = saveCustomPersona(root, savePayload);
//   assert.equal(saved.ok, true, 'persona save should succeed');
//   assert.ok(saved.persona.id.startsWith('custom-'), 'saved persona id should be namespaced');

//   // List
//   const listed = listCustomPersonas(root);
//   assert.ok(listed.personas.some((p) => p.id === saved.persona.id), 'saved persona must be listed');

//   // Delete
//   const deleted = deleteCustomPersona(root, saved.persona.id);
//   assert.equal(deleted.ok, true);
//   assert.equal(deleted.removed, true, 'persona should be removed');

//   // List after delete
//   const listedAfter = listCustomPersonas(root);
//   assert.ok(
//     !listedAfter.personas.some((p) => p.id === saved.persona.id),
//     'deleted persona must not be listed',
//   );

//   console.log('  [Instruction Studio] custom persona CRUD: PASSED');
// }

// // ---------------------------------------------------------------------------
// // Test 7 – Trace matrix logging
// // ---------------------------------------------------------------------------
// export function testTraceMatrix(): void {
//   console.log('  [Instruction Studio] trace matrix...');

//   const {
//     compileInstructionStudioGraph,
//     writeInstructionStudioSnapshot,
//     listInstructionStudioTraces,
//     appendInstructionStudioTrace,
//   } = require('../engine/instructionStudio.js');

//   const root = mkTempDir();
//   const graph = {
//     workflowName: 'Trace Workflow',
//     nodes: [
//       { id: 'persona', type: 'persona', label: 'Security Expert' },
//       { id: 'condition', type: 'condition', label: 'If endpoint accepts user payload' },
//       { id: 'priority', type: 'priority', label: 'High' },
//       { id: 'scope', type: 'agentScope', label: 'Security Analysis' },
//       { id: 'rule', type: 'rule', text: 'Validate request payloads before writes.' },
//     ],
//     edges: [
//       { from: 'persona', to: 'condition' },
//       { from: 'condition', to: 'priority' },
//       { from: 'priority', to: 'scope' },
//       { from: 'scope', to: 'rule' },
//     ],
//   };

//   // Compile to generate a trace row
//   writeInstructionStudioSnapshot(root, graph);

//   // List traces
//   const rows = listInstructionStudioTraces(root, 5);
//   assert.ok(rows.rows.length >= 1, 'compile should append at least one trace row');
//   assert.equal(rows.rows[0].workflowName, 'Trace Workflow');
//   assert.equal(rows.rows[0].persona, 'Security Expert');

//   // Manual append
//   appendInstructionStudioTrace(root, {
//     workflowName: 'Manual Trace',
//     persona: 'Architect',
//     condition: 'Always',
//     priority: 'Medium',
//     agentScope: 'Code Generation',
//     ruleText: 'Manual trace append for debugger.',
//     versionIndex: 99,
//   });

//   const finalRows = listInstructionStudioTraces(root, 10);
//   assert.ok(finalRows.rows.some((r) => r.workflowName === 'Manual Trace' && r.versionIndex === 99));

//   console.log('  [Instruction Studio] trace matrix: PASSED');
// }

// // ---------------------------------------------------------------------------
// // Test 8 – Trace analytics summary
// // ---------------------------------------------------------------------------
// export function testTraceAnalytics(): void {
//   console.log('  [Instruction Studio] trace analytics...');

//   const {
//     appendInstructionStudioTrace,
//     getInstructionStudioTraceAnalytics,
//   } = require('../engine/instructionStudio.js');

//   const root = mkTempDir();
//   const append = (payload: Record<string, unknown>) =>
//     appendInstructionStudioTrace(root, payload);

//   append({
//     workflowName: 'W1',
//     persona: 'Architect',
//     condition: 'Always',
//     priority: 'High',
//     agentScope: 'Review',
//     ruleText: 'Validate inputs before writes',
//     versionIndex: 1,
//   });
//   append({
//     workflowName: 'W2',
//     persona: 'Architect',
//     condition: 'Always',
//     priority: 'High',
//     agentScope: 'Review',
//     ruleText: 'Validate inputs for services',
//     versionIndex: 2,
//   });
//   append({
//     workflowName: 'W3',
//     persona: 'Security Expert',
//     condition: 'Always',
//     priority: 'Medium',
//     agentScope: 'Security Analysis',
//     ruleText: 'Summarize risks before merge',
//     versionIndex: 3,
//   });

//   const analytics = getInstructionStudioTraceAnalytics(root);
//   assert.equal(analytics.analytics.compileCount, 3);
//   assert.equal(analytics.analytics.topPersona?.name, 'Architect');
//   assert.equal(analytics.analytics.topPersona?.count, 2);
//   assert.ok(
//     (analytics.analytics.topRulePrefix?.prefix ?? '').includes('validate inputs'),
//     'expected top rule prefix to include validate inputs',
//   );

//   console.log('  [Instruction Studio] trace analytics: PASSED');
// }

// // ---------------------------------------------------------------------------
// // Test 9 – Telemetry artifact export (.agent)
// // ---------------------------------------------------------------------------
// export function testTelemetryArtifacts(): void {
//   console.log('  [Instruction Studio] telemetry artifacts...');

//   const { writeInstructionStudioSnapshot } = require('../engine/instructionStudio.js');

//   const root = mkTempDir();
//   const graph = {
//     workflowName: 'Telemetry Workflow',
//     nodes: [
//       { id: 'persona', type: 'persona', label: 'Security Expert' },
//       { id: 'condition', type: 'condition', label: 'If endpoint accepts payload' },
//       { id: 'scope', type: 'agentScope', label: 'Security Analysis' },
//       { id: 'rule-active', type: 'rule', text: 'Validate inputs before writes.', active: true },
//       { id: 'rule-disabled', type: 'rule', text: 'Never edit package json dependencies.', active: false },
//     ],
//     edges: [
//       { from: 'persona', to: 'condition' },
//       { from: 'condition', to: 'scope' },
//       { from: 'scope', to: 'rule-active' },
//       { from: 'scope', to: 'rule-disabled' },
//     ],
//   };

//   writeInstructionStudioSnapshot(root, graph);

//   const executionPath = path.join(root, '.agent', 'execution-log.json');
//   const lineagePath = path.join(root, '.agent', 'lineage.json');
//   const ruleUsagePath = path.join(root, '.agent', 'rule-usage.json');
//   assert.ok(fs.existsSync(executionPath), 'execution-log.json should be created');
//   assert.ok(fs.existsSync(lineagePath), 'lineage.json should be created');
//   assert.ok(fs.existsSync(ruleUsagePath), 'rule-usage.json should be created');

//   const executionRows = JSON.parse(fs.readFileSync(executionPath, 'utf8')) as Array<{
//     workflowName: string;
//     activeRuleCount: number;
//     inactiveRuleCount: number;
//     ruleUsageCount: number;
//   }>;
//   const lastExecution = executionRows[executionRows.length - 1];
//   assert.equal(lastExecution.workflowName, 'Telemetry Workflow');
//   assert.equal(lastExecution.activeRuleCount, 1);
//   assert.equal(lastExecution.inactiveRuleCount, 1);
//   assert.equal(lastExecution.ruleUsageCount, 1, 'only active rules should produce rule-usage rows');

//   const lineageRows = JSON.parse(fs.readFileSync(lineagePath, 'utf8')) as Array<{
//     modifiedBy: string;
//     file: string;
//   }>;
//   const lastLineage = lineageRows[lineageRows.length - 1];
//   assert.equal(lastLineage.modifiedBy, 'Security Expert');
//   assert.equal(lastLineage.file, '.instruction_studio/instructions.md');

//   const ruleUsageRows = JSON.parse(fs.readFileSync(ruleUsagePath, 'utf8')) as Array<{
//     ruleId: string;
//     filesAffected: string[];
//   }>;
//   const lastRuleUsage = ruleUsageRows[ruleUsageRows.length - 1];
//   assert.equal(lastRuleUsage.ruleId, 'rule-active');
//   assert.ok(
//     lastRuleUsage.filesAffected.includes('.instruction_studio/instructions.md'),
//     'rule usage should capture generated instructions artifact',
//   );

//   console.log('  [Instruction Studio] telemetry artifacts: PASSED');
// }

// // ---------------------------------------------------------------------------
// // Test 10 – Insights & replay endpoints
// // ---------------------------------------------------------------------------
// export function testInsightsAndReplay(): void {
//   console.log('  [Instruction Studio] insights & replay...');

//   const {
//     writeInstructionStudioSnapshot,
//     getInstructionStudioInsights,
//     getInstructionStudioReplay,
//   } = require('../engine/instructionStudio.js');

//   const root = mkTempDir();
//   const graph = {
//     workflowName: 'Replay Workflow',
//     nodes: [
//       { id: 'persona', type: 'persona', label: 'Architect' },
//       { id: 'condition', type: 'condition', label: 'Always' },
//       { id: 'scope', type: 'agentScope', label: 'Review' },
//       { id: 'rule-active', type: 'rule', text: 'Summarize risks before merge.', active: true },
//       { id: 'rule-disabled', type: 'rule', text: 'Never edit package json dependencies.', active: false },
//     ],
//     edges: [
//       { from: 'persona', to: 'condition' },
//       { from: 'condition', to: 'scope' },
//       { from: 'scope', to: 'rule-active' },
//       { from: 'scope', to: 'rule-disabled' },
//     ],
//   };

//   writeInstructionStudioSnapshot(root, graph);

//   // Insights
//   const insights = getInstructionStudioInsights(root);
//   assert.ok(insights.insights.compileCount >= 1, 'insights should report compile count');
//   assert.equal(insights.insights.activeRules, 1);
//   assert.equal(insights.insights.inactiveRules, 1);
//   assert.ok(
//     insights.insights.effectiveness.score >= 0 && insights.insights.effectiveness.score <= 100,
//   );

//   // Replay
//   const replay = getInstructionStudioReplay(root);
//   assert.ok(Array.isArray(replay.sessions) && replay.sessions.length >= 1, 'expected replay sessions');
//   assert.ok(replay.activeSessionId, 'expected active replay session id');
//   const first = replay.sessions[0];
//   assert.ok(first.steps.some((s) => s.type === 'execution'), 'replay should include execution step');
//   assert.ok(first.steps.some((s) => s.type === 'rule'), 'replay should include rule step');

//   console.log('  [Instruction Studio] insights & replay: PASSED');
// }

// // ---------------------------------------------------------------------------
// // Test 11 – Webview rule model serialization
// // ---------------------------------------------------------------------------
// export async function testWebviewRuleModel(): Promise<void> {
//   console.log('  [Instruction Studio] webview rule model...');

//   const { createRequire } = await import('node:module');
//   const requireFromScenarios = createRequire(import.meta.url);
//   const ruleModelPath = path.resolve(
//     process.cwd(),
//     'vscode-extension',
//     'media',
//     'instruction-studio.rules.js',
//   );
//   const ruleModel = requireFromScenarios(ruleModelPath) as {
//     normalizeRuleItems: (input: unknown, fallbackText: string) => Array<{ text: string; enabled: boolean }>;
//     fromGraphNodes: (nodes: unknown, fallbackText: string) => Array<{ text: string; enabled: boolean }>;
//     toGraphRuleSpecs: (items: unknown, fallbackText: string) => Array<{ text: string; active: boolean }>;
//   };

//   const fallback = 'Always run unit tests before completing changes.';

//   // fromGraphNodes
//   const fromGraph = ruleModel.fromGraphNodes(
//     [
//       { id: 'rule-1', type: 'rule', text: 'Keep API contracts stable.', active: true },
//       { id: 'rule-2', type: 'rule', text: 'Never edit package json dependencies.', active: false },
//     ],
//     fallback,
//   );
//   assert.equal(fromGraph.length, 2, 'expected two rules from graph nodes');
//   assert.equal(fromGraph[0].enabled, true);
//   assert.equal(fromGraph[1].enabled, false);

//   // toGraphRuleSpecs
//   const serialized = ruleModel.toGraphRuleSpecs(fromGraph, fallback);
//   assert.equal(serialized.length, 2, 'serialized rules should keep row count');
//   assert.equal(serialized[0].active, true, 'active rule should remain active in graph payload');
//   assert.equal(serialized[1].active, false, 'disabled rule should remain inactive in graph payload');

//   // normalizeRuleItems (empty input)
//   const normalizedEmpty = ruleModel.normalizeRuleItems([], fallback);
//   assert.equal(normalizedEmpty.length, 1, 'empty rule input should receive fallback row');
//   assert.equal(normalizedEmpty[0].text, fallback);
//   assert.equal(normalizedEmpty[0].enabled, true);

//   console.log('  [Instruction Studio] webview rule model: PASSED');
// }

// // ---------------------------------------------------------------------------
// // Run all tests
// // ---------------------------------------------------------------------------
// export async function runInstructionStudioTests(): Promise<void> {
//   console.log('\n--- Instruction Studio solid test cases ---\n');

//   testGraphValidation();
//   testCompileOutput();
//   testConflictDetection();
//   testDisabledRules();
//   testPresets();
//   testCustomPersonaCRUD();
//   testTraceMatrix();
//   testTraceAnalytics();
//   testTelemetryArtifacts();
//   testInsightsAndReplay();
//   await testWebviewRuleModel();

//   console.log('\n--- All Instruction Studio tests passed ---\n');
// }
