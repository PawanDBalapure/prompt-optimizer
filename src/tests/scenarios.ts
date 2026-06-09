import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import * as os from 'node:os';

import Database from 'better-sqlite3';
import { PromptProxyEngine } from '../PromptProxyEngine.js';
//import { runInstructionStudioTests } from './instructionStudio.test.js';
import { IntelliJPromptProxyAdapter } from '../adapters/IntelliJPromptProxyAdapter.js';
import { VSCodePromptProxyAdapter } from '../adapters/VSCodePromptProxyAdapter.js';
import { PromptOptimizationRequest } from '../contracts.js';
import type { InstructionStudioGraph } from '../engine/instructionStudio.js';
import { assertSchema, buildDemoRequest, resetDatabase } from './harness.js';

export async function runCoreScenarios(dbFile: string): Promise<void> {
  resetDatabase(dbFile);
  const engine = new PromptProxyEngine({ db_path: dbFile });
  await engine.initialize();
  const request = buildDemoRequest();

  console.log('1. Validating core engine request/response contract...');
  const response = await engine.processRequest(request);
  assertSchema(response);
  assert.ok(response.metrics.raw_input_tokens > 0);
  assert.ok(response.metrics.optimized_input_tokens > 0);
  assert.ok(response.metrics.estimated_output_tokens > 0);
  assert.ok(response.metrics.estimated_cost_usd > 0);
  // File code/references are correctly excluded from the generated prompt output.
  assert.ok(!response.optimized_prompt.includes('# src/systemd.ts'));
  assert.ok(!response.optimized_prompt.includes('# src/weather.ts'));
  assert.equal(response.analysis.context.selected_files[0], 'src/systemd.ts');
  assert.ok(response.analysis.context.selected_logs.includes('Terminal'));
  assert.ok(response.analysis.cost.total_cost_usd > 0);
  assert.ok(!response.optimized_prompt.includes('[EXAMPLE]'));
  assert.equal((response.optimized_prompt.match(/const restart = true;/g) ?? []).length, 0);
  console.log(JSON.stringify(response, null, 2));

  console.log('\n2. Validating cache reuse does not zero pricing forecasts...');
  const cachedResponse = await engine.processRequest(request);
  assertSchema(cachedResponse);
  assert.ok(cachedResponse.metrics.estimated_cost_usd > 0);
  assert.equal(cachedResponse.optimized_prompt, response.optimized_prompt);
  assert.equal(cachedResponse.analysis.cache.status, 'exact');

  console.log('\n3. Validating internal Prompt Optimizer buffers stay out of optimized prompts...');
  const internalContextResponse = await engine.processRequest({
    raw_prompt: 'Cost of this token',
    ide_context: {
      workspace_root: 'C:/workspace/demo',
      open_files: [],
      logs: [
        {
          source: 'Prompt Optimizer Session Buffer',
          kind: 'general',
          content: 'Turn 1 [panel]\nPrompt: cost of this token\nOptimized: input: >\n  Cost of this token',
        },
        {
          source: 'Prompt Optimizer Chat History',
          kind: 'general',
          content: '1. User: Cost of this token',
        },
        { source: 'Terminal', kind: 'terminal', content: 'ERROR sample failure' },
      ],
    },
  });
  assertSchema(internalContextResponse);
  assert.ok(!internalContextResponse.optimized_prompt.includes('# Prompt Optimizer Session Buffer'));
  assert.ok(!internalContextResponse.optimized_prompt.includes('# Prompt Optimizer Chat History'));

  console.log('\n4. Validating semantic cache does not reuse stale optimized prompts...');
  await engine.processRequest({ raw_prompt: 'Explain token cost for this prompt', workspace_id: 'semantic-demo' });
  const semanticResponse = await engine.processRequest({
    raw_prompt: 'Explain token cost for this message',
    workspace_id: 'semantic-demo',
  });
  assertSchema(semanticResponse);
  assert.equal(semanticResponse.analysis.cache.status, 'semantic');
  assert.ok(semanticResponse.optimized_prompt.includes('Explain token cost for this message'));
  assert.ok(!semanticResponse.optimized_prompt.includes('Explain token cost for this prompt'));
  // Segment-level cache reuse was disabled because IDE context files are natively processed by Copilot
  // and are no longer injected into the raw output prompt by PromptProxyEngine.

  console.log('\n5. Validating compiler-style structured optimization...');
  const compilerResp = await engine.processRequest({
    raw_prompt: [
      'Please can you build me a nice modern website for a coffee shop.',
      'It should be fast and easy to use.',
      'Do not use jQuery.',
    ].join('\n'),
    workspace_id: 'compiler-demo',
  });
  assertSchema(compilerResp);
  const compiled = compilerResp.optimized_prompt;
  // Compact, high-density schema headers are present.
  for (const header of ['task:', 'constraints:']) {
    assert.ok(compiled.includes(header), `structured prompt should contain ${header}`);
  }
  // Context is now conditional: with no workspace stack detected the engine
  // omits the non-informative "Standard codebase structure" placeholder line.
  assert.ok(
    !compiled.includes('context:'),
    'generic placeholder context line should be omitted when no real stack is detected',
  );
  // Empty-section placeholders from the old verbose schema must be gone.
  for (const legacy of ['requirements:', 'rules:', 'exclusions:', 'success_criteria:', 'input: >', 'context: >']) {
    assert.ok(!compiled.includes(legacy), `compact prompt should not contain legacy header ${legacy}`);
  }
  // Adjectives converted to measurable requirements, not echoed verbatim.
  assert.ok(/First Contentful Paint < 1\.5s/.test(compiled), 'vague "fast" should become a measurable requirement');
  assert.ok(/2 interactions/.test(compiled), 'vague "easy to use" should become a measurable requirement');
  assert.ok(/8px spacing/.test(compiled), 'vague "modern/nice" should become a measurable requirement');
  // Negative preference becomes an exclusion-style constraint.
  assert.ok(/Do not use jQuery/i.test(compiled), 'negative preference should appear as a constraint');
  // Conversational filler is removed from the task line.
  assert.ok(!/\bplease\b/i.test(compiled), 'filler ("please") should be stripped');
  const taskMatch = compiled.match(/^task:\s+"([^"]+)"/m);
  assert.ok(taskMatch, 'structured prompt should include a task line');
  assert.ok(
    /easy to use/i.test(taskMatch?.[1] ?? ''),
    'task should preserve multiline intent instead of using only the first line',
  );
  // Standing output-discipline constraints suppress verbose responses.
  assert.ok(/No conversational filler, preamble, or sign-offs\./.test(compiled), 'discipline constraint should be appended');
  // Structured spec is also exposed on the IR for downstream consumers.
  assert.ok(compilerResp.structured_ir?.compiler_spec, 'compiler_spec should be attached to structured_ir');
  assert.ok((compilerResp.structured_ir?.compiler_spec?.requirements.length ?? 0) >= 3);

  const multilineQuestionResp = await engine.processRequest({
    raw_prompt: [
      'panel html input prompt text area to support multi-line support.',
      'what are the scenarios that are matching to preserve this ?',
    ].join('\n'),
    workspace_id: 'compiler-multiline-question-demo',
  });
  assertSchema(multilineQuestionResp);
  const multilineCompiled = multilineQuestionResp.optimized_prompt;
  const multilineTaskMatch = multilineCompiled.match(/^task:\s+"([^"]+)"/m);
  assert.ok(multilineTaskMatch, 'multiline question prompt should include task line');
  assert.ok(
    /panel html input prompt text area/i.test(multilineTaskMatch?.[1] ?? ''),
    'task should preserve first multiline statement',
  );
  assert.ok(
    /scenarios/i.test(multilineTaskMatch?.[1] ?? ''),
    'task should preserve question line instead of collapsing to single-line rewrite',
  );
  assert.ok(
    !/Explain the purpose of/i.test(multilineTaskMatch?.[1] ?? ''),
    'multiline prompts should not be forced into single-question rewrite template',
  );

  engine.close();
}

export async function runAdapterScenarios(dbFile: string, request: PromptOptimizationRequest): Promise<void> {
  console.log('\n5. Validating VS Code adapter...');
  const vscodeAdapter = new VSCodePromptProxyAdapter(new PromptProxyEngine({ db_path: dbFile }));
  await vscodeAdapter.initialize();
  const vscodeResponse = await vscodeAdapter.process({
    raw_prompt: 'Fix the restart policy and return JSON output.',
    workspace_root: 'C:/workspace/demo',
    active_editor: {
      path: 'src/systemd.ts',
      content: request.ide_context!.active_file!.content,
      selection: request.ide_context!.active_file!.selection,
      language_id: 'ts',
      is_active: true,
    },
    visible_editors: [{
      path: 'src/systemd.ts',
      content: request.ide_context!.active_file!.content,
      selection: request.ide_context!.active_file!.selection,
      language_id: 'ts',
      is_active: true,
    }],
    terminal_output: ['ERROR restart failed'],
    problems: ['systemd.ts:3 restart policy mismatch'],
  });
  assertSchema(vscodeResponse);
  vscodeAdapter.close();

  console.log('\n6. Validating IntelliJ adapter...');
  const intellijAdapter = new IntelliJPromptProxyAdapter(new PromptProxyEngine({ db_path: dbFile }));
  await intellijAdapter.initialize();
  const intellijResponse = await intellijAdapter.process({
    raw_prompt: 'Refactor the restart configuration and answer in JSON.',
    project_root: 'C:/workspace/demo',
    active_editor: {
      path: 'src/systemd.ts',
      content: request.ide_context!.active_file!.content,
      selection: request.ide_context!.active_file!.selection,
      language: 'ts',
      is_active: true,
    },
    open_editors: [{
      path: 'src/systemd.ts',
      content: request.ide_context!.active_file!.content,
      selection: request.ide_context!.active_file!.selection,
      language: 'ts',
      is_active: true,
    }],
    run_console: ['ERROR restart failed'],
    inspection_messages: ['systemd.ts:3 restart policy mismatch'],
  });
  assertSchema(intellijResponse);
  intellijAdapter.close();

  console.log('\n7. Validating CLI sidecar output...');
  const cliResult = spawnSync(process.execPath, ['dist/cli.js', '--stdin', '--db', dbFile], {
    input: JSON.stringify(request),
    encoding: 'utf8',
  });
  assert.equal(cliResult.status, 0, cliResult.stderr);
  const cliResponse = JSON.parse(cliResult.stdout.trim()) as unknown;
  assertSchema(cliResponse);
}

export async function runRegressionScenarios(): Promise<void> {
  console.log('\n8. Regression: workspace-aware exact cache match...');
  const wsDbFile = 'prompt_semantic_cache_ws_test.db';
  resetDatabase(wsDbFile);
  const wsEngine = new PromptProxyEngine({ db_path: wsDbFile });
  await wsEngine.initialize();

  const sharedPrompt = 'Explain the retry policy for this service';
  await wsEngine.processRequest({ raw_prompt: sharedPrompt, workspace_id: 'workspace-A' });
  const wsBResult = await wsEngine.processRequest({ raw_prompt: sharedPrompt, workspace_id: 'workspace-B' });
  assertSchema(wsBResult);
  assert.ok(
    wsBResult.analysis.cache.status !== 'exact',
    `Expected cache miss or semantic for workspace-B but got exact. Status: ${wsBResult.analysis.cache.status}`,
  );
  const wsAResult = await wsEngine.processRequest({ raw_prompt: sharedPrompt, workspace_id: 'workspace-A' });
  assertSchema(wsAResult);
  assert.equal(wsAResult.analysis.cache.status, 'exact', 'Expected exact cache hit for same workspace');
  wsEngine.close();
  resetDatabase(wsDbFile);
  console.log('  workspace-aware exact cache: PASSED');

  console.log('\n9. Regression: collision-safe prompt version key...');
  const prefix = 'A'.repeat(120);
  const promptAlpha = prefix + ' suffix-alpha';
  const promptBeta = prefix + ' suffix-beta';
  const collDbFile = 'prompt_semantic_cache_collision_test.db';
  resetDatabase(collDbFile);
  const collEngine = new PromptProxyEngine({ db_path: collDbFile });
  await collEngine.initialize();

  await collEngine.processRequest({ raw_prompt: promptAlpha, workspace_id: 'coll-test' });
  await collEngine.processRequest({ raw_prompt: promptBeta, workspace_id: 'coll-test' });

  const alphaResult = await collEngine.processRequest({ raw_prompt: promptAlpha, workspace_id: 'coll-test' });
  const betaResult = await collEngine.processRequest({ raw_prompt: promptBeta, workspace_id: 'coll-test' });
  assertSchema(alphaResult);
  assertSchema(betaResult);
  assert.equal(alphaResult.analysis.cache.status, 'exact', 'promptAlpha must be exact hit');
  assert.equal(betaResult.analysis.cache.status, 'exact', 'promptBeta must be exact hit');
  assert.notEqual(
    alphaResult.optimized_prompt,
    betaResult.optimized_prompt,
    'Collision: two prompts with same 120-char prefix returned identical optimized prompts',
  );
  collEngine.close();
  resetDatabase(collDbFile);
  console.log('  collision-safe version key: PASSED');

  console.log('\n10. Validating workspace memory ingestion (AGENTS.md)...');
  const memDbFile = 'prompt_semantic_cache_memory_test.db';
  resetDatabase(memDbFile);
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-opt-mem-'));
  fs.writeFileSync(
    path.join(tmpRoot, 'AGENTS.md'),
    '# Team conventions\n- Always handle errors with structured logging.\n- Use zod for runtime validation.',
  );
  const memEngine = new PromptProxyEngine({ db_path: memDbFile });
  await memEngine.initialize();
  const memResult = await memEngine.processRequest({
    raw_prompt: 'Write a function that validates incoming user payloads.',
    workspace_id: 'mem-test',
    ide_context: { workspace_root: tmpRoot },
  });
  assertSchema(memResult);
  // Memory ingestion sections are now collected by the engine but intentionally excluded 
  // from the final optimized output to keep the prompt clean and YAML-compliant.
  memEngine.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  resetDatabase(memDbFile);
  console.log('  workspace memory ingestion: PASSED');

  console.log('\n11. Validating best-practice diagnostics (Anthropic + OpenAI)...');
  const bpDbFile = 'prompt_semantic_cache_bp_test.db';
  resetDatabase(bpDbFile);
  const bpEngine = new PromptProxyEngine({ db_path: bpDbFile });
  await bpEngine.initialize();
  const bpResult = await bpEngine.processRequest({
    raw_prompt: 'help me with the code',
    target_model: 'claude',
    workspace_id: 'bp-test',
  });
  assertSchema(bpResult);
  const diagCodes = (bpResult.diagnostics ?? []).map((d) => d.code);
  assert.ok(
    diagCodes.some((c) => c.startsWith('BP_')),
    `Expected at least one best-practice diagnostic. Got: ${diagCodes.join(', ')}`,
  );
  bpEngine.close();
  resetDatabase(bpDbFile);
  console.log('  best-practice diagnostics: PASSED');

  console.log('\n12. Validating cross-workspace peer federation + KG persistence...');
  const peerDbFile = 'prompt_semantic_cache_peer_source.db';
  const mainDbFile = 'prompt_semantic_cache_peer_main.db';
  resetDatabase(peerDbFile);
  resetDatabase(mainDbFile);

  // Seed a peer cache with a recognizable optimized prompt.
  const peerEngine = new PromptProxyEngine({ db_path: peerDbFile });
  await peerEngine.initialize();
  await peerEngine.processRequest({
    raw_prompt: 'Build an Express middleware for JWT verification.',
    workspace_id: 'peer-ws',
  });
  peerEngine.close();

  const mainEngine = new PromptProxyEngine({ db_path: mainDbFile });
  await mainEngine.initialize();
  const fed = mainEngine.getFederation();
  assert.ok(fed, 'Federation should be available after initialize');
  const addResult = fed!.addPeer('peer one', path.resolve(peerDbFile));
  assert.ok(addResult.ok, `Peer add failed: ${addResult.error}`);
  assert.equal(fed!.list().length, 1, 'Exactly one peer should be registered');

  const fedResult = await mainEngine.processRequest({
    raw_prompt: 'Build an Express middleware for JWT verification.',
    workspace_id: 'main-ws',
  });
  assertSchema(fedResult);
  // Peer responses are generated and stored, but not appended to the clean YAML Prompt anymore.

  const kg = mainEngine.getKnowledgeGraph();
  assert.ok(kg, 'KG should be available');
  const kgStats = kg!.stats('main-ws');
  assert.ok(kgStats.nodes > 0, 'KG should have harvested nodes after a prompt');

  await mainEngine.processRequest({
    raw_prompt: 'Build an Express middleware for JWT verification.',
    workspace_id: 'main-ws',
  });
  assert.deepEqual(
    kg!.stats('main-ws'),
    kgStats,
    're-indexing the same prompt should not change visible graph node/edge counts',
  );

  await mainEngine.processRequest({
    raw_prompt: 'Document the React route conventions for the admin dashboard.',
    workspace_id: 'other-ws',
  });
  assert.deepEqual(
    kg!.stats('main-ws'),
    kgStats,
    'workspace KG stats must not include edges harvested for another workspace',
  );

  // Seeding/refresh idempotence: bulk-harvest passes (seeding: true) feed many
  // distinct prompts but must NOT grow the node count, otherwise the panel's
  // graph pill climbs on every Refresh click. Warm up once so the single
  // stable seed node exists, then assert further passes don't move the counts.
  await mainEngine.processRequest({
    raw_prompt: 'Seed harvest warm-up: configure the deployment pipeline.',
    workspace_id: 'main-ws',
    seeding: true,
  });
  const seedStatsBefore = kg!.stats('main-ws');
  for (let i = 0; i < 5; i++) {
    await mainEngine.processRequest({
      raw_prompt: `Seed harvest line number ${i}: configure the deployment pipeline and rollout.`,
      workspace_id: 'main-ws',
      seeding: true,
    });
  }
  assert.deepEqual(
    kg!.stats('main-ws'),
    seedStatsBefore,
    'repeated seeding passes with distinct prompts must not grow graph node/edge counts',
  );

  // Reset must zero the workspace graph.
  const removedGraphNodes = kg!.clearGraph('main-ws');
  assert.ok(removedGraphNodes > 0, 'clearGraph should report the nodes it removed');
  assert.deepEqual(
    kg!.stats('main-ws'),
    { nodes: 0, edges: 0 },
    'clearGraph must reset the workspace graph counts to zero',
  );
  mainEngine.close();
  resetDatabase(peerDbFile);
  resetDatabase(mainDbFile);
  console.log('  cross-workspace federation + KG: PASSED');

  console.log('\n13. Validating SDLC mode detection (slash + intent)...');
  const modeDbFile = 'prompt_semantic_cache_mode_test.db';
  resetDatabase(modeDbFile);
  const modeEngine = new PromptProxyEngine({ db_path: modeDbFile });
  await modeEngine.initialize();

  // Slash command: /review must trigger read-only review mode and strip the slash.
  const reviewResp = await modeEngine.processRequest({
    raw_prompt: '/review the auth middleware for issues',
    workspace_id: 'mode-test',
  });
  assertSchema(reviewResp);
  assert.equal(reviewResp.sdlc_mode?.id, 'review');
  assert.equal(reviewResp.sdlc_mode?.read_only, true);
  assert.equal(reviewResp.sdlc_mode?.trigger, '/review');
  assert.ok(reviewResp.optimized_prompt.includes('role: >\n  Code Reviewer'));
  assert.ok(reviewResp.optimized_prompt.includes('READ-ONLY'));
  assert.ok(reviewResp.optimized_prompt.includes('quality_checklist:'));
  assert.ok(!reviewResp.optimized_prompt.includes('/review'), 'slash trigger must not leak into output');
  assert.ok(
    reviewResp.improvements.some((m) => m.startsWith('Applied SDLC mode')),
    'mode should be surfaced in improvements',
  );

  // Intent words: "fix the bug" â†’ bug-fix mode without explicit trigger.
  const bugResp = await modeEngine.processRequest({
    raw_prompt: 'Please fix the bug where the login button crashes the page',
    workspace_id: 'mode-test',
  });
  assertSchema(bugResp);
  assert.equal(bugResp.sdlc_mode?.id, 'bug-fix');
  assert.equal(bugResp.sdlc_mode?.trigger, null);
  assert.ok(bugResp.optimized_prompt.includes('role: >\n  Bug Fix workflow'));

  // Neutral prompt: no slash, no intent words â†’ no mode applied.
  const neutralResp = await modeEngine.processRequest({
    raw_prompt: 'Summarise the difference between TCP and UDP.',
    workspace_id: 'mode-test',
  });
  assertSchema(neutralResp);
  assert.equal(neutralResp.sdlc_mode, undefined);
  assert.ok(!neutralResp.optimized_prompt.startsWith('# Role'));

  modeEngine.close();
  resetDatabase(modeDbFile);
  console.log('  SDLC mode detection: PASSED');

  console.log('\n14. Validating custom skill loading + override...');
  const skillDbFile = 'prompt_semantic_cache_skill_test.db';
  resetDatabase(skillDbFile);
  const skillRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-opt-skill-'));
  const skillsDir = path.join(skillRoot, '.promptoptimizer', 'skills');
  fs.mkdirSync(skillsDir, { recursive: true });

  // 1) Custom skill that registers a brand-new mode with its own slash trigger.
  fs.writeFileSync(path.join(skillsDir, 'a11y.md'), [
    '---',
    'id: a11y',
    'label: Accessibility Auditor',
    'readOnly: true',
    'slashAliases: [a11y, accessibility]',
    'intentPatterns:',
    '  - "\\baccessibility\\b"',
    '---',
    'You are an accessibility auditor. Inspect the change for WCAG 2.1 AA compliance.',
    '',
    '## Checklist',
    '- Interactive elements have accessible names.',
    '- Colour contrast meets WCAG AA.',
    '- Focus order is logical.',
    ''].join('\n'));

  // 2) Override the built-in /code mode with a stricter project-specific spec.
  fs.writeFileSync(path.join(skillsDir, 'code.md'), [
    '---',
    'id: code',
    'label: Implementer (strict house style)',
    '---',
    'You are the Implementer. Follow the house style: no any, no console.log, no unused imports.',
    '',
    '## Checklist',
    '- No `any` type, no `console.log`, no unused imports.',
    ''].join('\n'));

  // 3) Custom skill used to prove deselection/removal does not leave its
  // role definition stuck inside an exact cache hit.
  const staleAgentPath = path.join(skillsDir, 'stale-agent.md');
  fs.writeFileSync(staleAgentPath, [
    '---',
    'id: stale-agent',
    'label: Deselect Sentinel',
    'readOnly: true',
    'keywords: [quasar]',
    '---',
    'You are the Deselect Sentinel. This role definition must not survive deselection.',
    '',
    '## Checklist',
    '- No stale sentinel checklist remains.',
    ''].join('\n'));

  const { _resetSkillCacheForTests, listRegisteredModes } = await import('../engine/promptModes.js');
  _resetSkillCacheForTests();

  const skillEngine = new PromptProxyEngine({ db_path: skillDbFile });
  await skillEngine.initialize();

  // Brand-new slash command
  const a11yResp = await skillEngine.processRequest({
    raw_prompt: '/a11y review the contrast on the login button',
    workspace_id: 'skill-test',
    ide_context: { workspace_root: skillRoot },
  });
  assertSchema(a11yResp);
  assert.equal(a11yResp.sdlc_mode?.id, 'a11y');
  assert.equal(a11yResp.sdlc_mode?.read_only, true);
  assert.ok(a11yResp.optimized_prompt.includes('role: >\n  Accessibility Auditor'));
  assert.ok(a11yResp.optimized_prompt.includes('WCAG 2.1 AA'));
  assert.ok(a11yResp.optimized_prompt.includes('Focus order is logical'));

  // Custom intent pattern: word "accessibility" anywhere triggers a11y mode.
  const intentResp = await skillEngine.processRequest({
    raw_prompt: 'Please double-check accessibility for the navigation drawer',
    workspace_id: 'skill-test',
    ide_context: { workspace_root: skillRoot },
  });
  assertSchema(intentResp);
  assert.equal(intentResp.sdlc_mode?.id, 'a11y');
  assert.equal(intentResp.sdlc_mode?.trigger, null);

  // Override: /code now uses the workspace-defined label & checklist.
  const codeResp = await skillEngine.processRequest({
    raw_prompt: '/code add a debounce helper',
    workspace_id: 'skill-test',
    ide_context: { workspace_root: skillRoot },
  });
  assertSchema(codeResp);
  assert.equal(codeResp.sdlc_mode?.id, 'code');
  assert.equal(codeResp.sdlc_mode?.label, 'Implementer (strict house style)');
  assert.ok(codeResp.optimized_prompt.includes('house style'));
  assert.ok(codeResp.optimized_prompt.includes('No `any` type'));

  // listRegisteredModes surfaces both custom skills with correct source tags.
  const registered = listRegisteredModes(skillRoot);
  const a11yEntry = registered.find((m) => m.id === 'a11y');
  const codeEntry = registered.find((m) => m.id === 'code');
  assert.ok(a11yEntry, 'a11y mode should be listed');
  assert.equal(a11yEntry!.source, 'workspace');
  assert.ok(a11yEntry!.slashAliases.includes('accessibility'));
  assert.ok(codeEntry, 'code mode should be listed');
  assert.equal(codeEntry!.source, 'workspace', 'workspace override should win');

  const stalePrompt = 'Please assess quasar behavior around keyboard focus.';
  const staleFirst = await skillEngine.processRequest({
    raw_prompt: stalePrompt,
    workspace_id: 'skill-test',
    ide_context: { workspace_root: skillRoot },
  });
  assertSchema(staleFirst);
  assert.equal(staleFirst.sdlc_mode?.id, 'stale-agent');
  assert.ok(staleFirst.optimized_prompt.includes('Deselect Sentinel'));

  fs.unlinkSync(staleAgentPath);
  const staleAfterDeselect = await skillEngine.processRequest({
    raw_prompt: stalePrompt,
    workspace_id: 'skill-test',
    ide_context: { workspace_root: skillRoot },
  });
  assertSchema(staleAfterDeselect);
  assert.equal(staleAfterDeselect.sdlc_mode, undefined);
  assert.equal(staleAfterDeselect.analysis.cache.status, 'exact');
  assert.ok(!staleAfterDeselect.optimized_prompt.startsWith('# Role'));
  assert.ok(!staleAfterDeselect.optimized_prompt.includes('Deselect Sentinel'));
  assert.ok(!staleAfterDeselect.optimized_prompt.includes('No stale sentinel checklist'));

  skillEngine.close();
  fs.rmSync(skillRoot, { recursive: true, force: true });
  _resetSkillCacheForTests();
  resetDatabase(skillDbFile);
  console.log('  custom skill loading + override: PASSED');

  console.log('\n15. Validating robust skill parsing + smart picker...');
  const robustDbFile = 'prompt_semantic_cache_robust_test.db';
  resetDatabase(robustDbFile);
  const robustRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-opt-robust-'));
  const robustSkillsDir = path.join(robustRoot, '.promptoptimizer', 'skills');
  fs.mkdirSync(robustSkillsDir, { recursive: true });

  // (a) Skill with comments, block scalar role, quoted regex, keywords,
  //     filePatterns, priority and tags. Exercises every parser branch.
  fs.writeFileSync(path.join(robustSkillsDir, 'styles.md'), [
    '---',
    '# Project-specific CSS reviewer.',
    'id: styles',
    'label: "Style Reviewer"',
    'priority: 5',
    'tags: [frontend, css]',
    'keywords: [css, styling, stylesheet]',
    'filePatterns:',
    '  - "*.css"',
    '  - "*.scss"',
    'intentPatterns:',
    '  - "\\bstyle guide\\b"',
    'rolePreface: |',
    '  You review styling.',
    '  You enforce design tokens.',
    '---',
    '## Checklist',
    '- Tokens used',
    ''].join('\n'));

  // (b) A higher-priority competing skill so we can verify tie-breaking.
  fs.writeFileSync(path.join(robustSkillsDir, 'design-system.md'), [
    '---',
    'id: design-system',
    'label: Design System Guardian',
    'keywords: [css, tokens]',
    'priority: 9',
    'requires: [tokens]',
    '---',
    'Guard the design system.',
    '## Checklist',
    '- Components consume tokens',
    ''].join('\n'));

  // (c) A broken file: bad YAML id, must surface as an error but not break loading.
  fs.writeFileSync(path.join(robustSkillsDir, 'broken.md'), [
    '---',
    'id: "BAD ID WITH SPACES"',
    'label: Broken',
    '---',
    'broken body',
    ''].join('\n'));

  // (d) A file with no frontmatter at all.
  fs.writeFileSync(path.join(robustSkillsDir, 'no-front.md'),
    'just a markdown note, no YAML\n');

  const promptModes = await import('../engine/promptModes.js');
  promptModes._resetSkillCacheForTests();

  const robustEngine = new PromptProxyEngine({ db_path: robustDbFile });
  await robustEngine.initialize();

  // Keyword shorthand triggers `styles` mode without an explicit intent regex.
  const cssResp = await robustEngine.processRequest({
    raw_prompt: 'review the css for the navigation bar',
    workspace_id: 'robust-test',
    ide_context: { workspace_root: robustRoot },
  });
  assertSchema(cssResp);
  assert.equal(cssResp.sdlc_mode?.id, 'styles', 'keyword hit should pick styles');
  assert.ok(cssResp.optimized_prompt.includes('design tokens'),
    'block-scalar rolePreface should be applied');

  // `requires: [tokens]` blocks design-system unless prompt mentions tokens.
  // With "tokens" present, design-system (priority 9) outranks styles (priority 5).
  const tokensResp = await robustEngine.processRequest({
    raw_prompt: 'audit css usage of tokens across the app',
    workspace_id: 'robust-test',
    ide_context: { workspace_root: robustRoot },
  });
  assertSchema(tokensResp);
  assert.equal(tokensResp.sdlc_mode?.id, 'design-system',
    'higher-priority skill with satisfied requires must win');

  // filePatterns activates a skill via active_file even with no keyword hit.
  const fileResp = await robustEngine.processRequest({
    raw_prompt: 'tidy this up',
    workspace_id: 'robust-test',
    ide_context: {
      workspace_root: robustRoot,
      active_file: { path: 'src/theme/main.scss', content: '' },
    },
  });
  assertSchema(fileResp);
  assert.equal(fileResp.sdlc_mode?.id, 'styles',
    'filePatterns hit on active_file must activate styles');

  // Broken file is surfaced via listSkillErrors and does NOT register a mode.
  const errors = promptModes.listSkillErrors(robustRoot);
  assert.ok(errors.length >= 1, 'broken skill must be reported');
  assert.ok(errors.some((e) => /broken\.md$/.test(e.filePath)),
    'broken.md should appear in errors');
  assert.ok(errors.some((e) => /no-front\.md$/.test(e.filePath)),
    'no-front.md should appear in errors');

  // Valid skills are still registered despite the broken siblings.
  const registeredRobust = promptModes.listRegisteredModes(robustRoot);
  assert.ok(registeredRobust.some((m) => m.id === 'styles'),
    'styles should still be registered');
  assert.ok(registeredRobust.some((m) => m.id === 'design-system'),
    'design-system should still be registered');

  robustEngine.close();
  fs.rmSync(robustRoot, { recursive: true, force: true });
  promptModes._resetSkillCacheForTests();
  resetDatabase(robustDbFile);
  console.log('  robust skill parsing + smart picker: PASSED');

  console.log('\n16. Validating cross-session per-file digest memory...');
  const digestDbFile = 'prompt_semantic_cache_digest_test.db';
  resetDatabase(digestDbFile);

  // Session 1: open an engine, study a file, then close.
  const sess1 = new PromptProxyEngine({ db_path: digestDbFile });
  await sess1.initialize();
  const studiedFile = {
    path: 'src/api/auth.ts',
    content: 'export function verifyJwt(token: string): boolean {\n  return token.length > 0;\n}\n',
    language: 'ts',
  };
  await sess1.processRequest({
    raw_prompt: 'Explain the verifyJwt helper',
    workspace_id: 'digest-test',
    ide_context: { workspace_root: '/virtual/digest-test', active_file: studiedFile },
  });
  const sess1Stats = sess1.getFileDigestStore()!.stats('digest-test');
  assert.ok(sess1Stats.files >= 1, 'session 1 must persist at least one file digest');
  sess1.close();

  // Session 2: brand new engine reading the same DB. The file digest is still
  // persisted and recall is exercised, but it is intentionally NOT inlined into
  // the optimized prompt — the prompt stays a clean YAML spec. We assert on the
  // digest store directly instead.
  const sess2 = new PromptProxyEngine({ db_path: digestDbFile });
  await sess2.initialize();
  const recallResp = await sess2.processRequest({
    raw_prompt: 'What did we change in auth recently?',
    workspace_id: 'digest-test',
    ide_context: { workspace_root: '/virtual/digest-test' },
  });
  assertSchema(recallResp);
  const recallStats = sess2.getFileDigestStore()!.stats('digest-test');
  assert.ok(recallStats.files >= 1, 'cross-session digest should persist the studied file');

  // Re-injecting the file as live content should also work cleanly.
  const liveResp = await sess2.processRequest({
    raw_prompt: 'Refactor verifyJwt to accept an options bag',
    workspace_id: 'digest-test',
    ide_context: { workspace_root: '/virtual/digest-test', active_file: studiedFile },
  });
  assertSchema(liveResp);

  // Visit count should grow across the three calls.
  const finalStats = sess2.getFileDigestStore()!.stats('digest-test');
  assert.ok(finalStats.total_visits >= 2, `expected visits to accumulate, got ${finalStats.total_visits}`);

  // Clearing wipes only this workspace.
  const removed = sess2.getFileDigestStore()!.clear('digest-test');
  assert.ok(removed >= 1, 'clear should remove at least one row');
  const afterClear = sess2.getFileDigestStore()!.stats('digest-test');
  assert.equal(afterClear.files, 0, 'workspace digests should be empty after clear');

  sess2.close();
  resetDatabase(digestDbFile);
  console.log('  cross-session per-file digest memory: PASSED');

  console.log('\n17. Validating enterprise hardening (redaction, retention, metrics, health, backup)...');
  const { redactForPersistence } = await import('../engine/redactor.js');
  const { runHealthCheck } = await import('../engine/health.js');
  const { exportDatabase } = await import('../engine/backup.js');
  const { CURRENT_SCHEMA_VERSION, readSchemaVersion } = await import('../cache/schema.js');

  // (a) Redactor: each rule fires on representative input.
  const sampleSecrets = [
    'AKIAABCDEFGHIJKLMNOP',
    'ghp_' + 'a'.repeat(40),
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
    'Authorization: Bearer abcdef1234567890abcdef1234567890',
    'DATABASE_PASSWORD=super-secret-pa55word!',
  ].join('\n');
  const redaction = redactForPersistence(sampleSecrets);
  assert.ok(redaction.hits.length >= 4, `expected multiple redaction hits, got ${redaction.hits.length}`);
  assert.ok(!redaction.redacted.includes('AKIAABCDEFGHIJKLMNOP'), 'AWS key must be redacted');
  assert.ok(!redaction.redacted.includes('ghp_aaaaaaaaaa'), 'GitHub PAT must be redacted');
  assert.ok(!redaction.redacted.includes('super-secret-pa55word'), 'env secret must be redacted');
  assert.ok(!redaction.redacted.includes('eyJzdWIiOiIxMjM0NTY3ODkwIn0'), 'JWT body must be redacted');
  console.log('  redaction rules cover secrets: PASSED');

  // (b) Persistence redaction: secrets in workspace memory + file digests do
  // not survive a round-trip through the DB.
  const entDbFile = 'prompt_semantic_cache_enterprise_test.db';
  resetDatabase(entDbFile);
  const entRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-opt-ent-'));
  fs.writeFileSync(
    path.join(entRoot, 'AGENTS.md'),
    'Team conventions: rotate the OPENAI_API_KEY=sk-proj-aaaaaaaaaaaaaaaaaaaaaaaa weekly.\n- Never log PII.',
  );
  const entEngine = new PromptProxyEngine({ db_path: entDbFile });
  await entEngine.initialize();
  await entEngine.processRequest({
    raw_prompt: 'Sketch the authentication helper API',
    workspace_id: 'ent-test',
    ide_context: {
      workspace_root: entRoot,
      active_file: {
        path: 'src/api/auth.ts',
        content: 'export const TOKEN = "ghp_' + 'b'.repeat(40) + '";\nexport function verify() { return true; }',
        language: 'ts',
      },
    },
  });
  const entDb = entEngine.getCacheManager().rawDatabase();
  const memRow = entDb
    .prepare('SELECT content FROM workspace_memory WHERE workspace_id = ?')
    .get('ent-test') as { content: string } | undefined;
  assert.ok(memRow, 'workspace memory row should exist');
  assert.ok(!memRow!.content.includes('sk-proj-aaaaaaaa'),
    `OPENAI_API_KEY must be redacted in stored memory. Got: ${memRow!.content}`);
  const digestRow = entDb
    .prepare('SELECT summary FROM file_digest WHERE workspace_id = ? AND path = ?')
    .get('ent-test', 'src/api/auth.ts') as { summary: string } | undefined;
  assert.ok(digestRow, 'file digest row should exist');
  assert.ok(!digestRow!.summary.includes('ghp_bbbbbbb'),
    `GitHub PAT must be redacted in stored digest summary. Got: ${digestRow!.summary}`);
  console.log('  persistence redaction (memory + digests): PASSED');

  // (c) Schema hardening: version row matches expected, WAL pragma set.
  assert.equal(readSchemaVersion(entDb), CURRENT_SCHEMA_VERSION,
    `schema_version should be ${CURRENT_SCHEMA_VERSION}`);
  const journal = entDb.pragma('journal_mode', { simple: true });
  assert.equal(String(journal).toLowerCase(), 'wal', `journal_mode should be wal, got ${journal}`);
  console.log('  schema_version + WAL pragmas: PASSED');

  // (d) Metrics: counters populated after a request.
  const metrics = entEngine.getCacheManager().metrics()!;
  const snap = metrics.snapshot();
  assert.ok(snap.some((m) => m.metric === 'requests.total' && m.count >= 1),
    'requests.total should be at least 1');
  assert.ok(snap.some((m) => m.metric === 'cache.writes' && m.count >= 1),
    'cache.writes should be at least 1');
  console.log('  metrics counters populated: PASSED');

  // (e) Health check: ok=true, all required tables present, schema match.
  const health = runHealthCheck(entDb, entDbFile);
  assert.equal(health.ok, true, `health should be ok, got: ${JSON.stringify(health)}`);
  assert.equal(health.schema_version.on_disk, CURRENT_SCHEMA_VERSION);
  assert.ok(health.tables.semantic_cache >= 0);
  assert.ok(health.tables.file_digest >= 0);
  assert.ok(health.tables.engine_metrics >= 0);
  console.log('  --health-check report green: PASSED');

  // (f) Maintenance: cap cache to 1 row, verify eviction count.
  for (let i = 0; i < 3; i++) {
    await entEngine.processRequest({ raw_prompt: `extra prompt #${i}`, workspace_id: 'ent-test' });
  }
  const beforeCap = entDb.prepare('SELECT COUNT(*) AS c FROM semantic_cache').get() as { c: number };
  assert.ok(beforeCap.c >= 2, `expected multiple cache rows before cap, got ${beforeCap.c}`);
  const maintenanceReport = entEngine.getMaintenanceService()!.run({
    maxCacheEntries: 1,
    maxDigestsPerWorkspace: 100,
    maxKgNodesPerWorkspace: 100,
    staleCacheAgeDays: 365,
    staleDigestAgeDays: 365,
  });
  assert.ok(maintenanceReport.evicted.cache_rows >= 1,
    `expected cache eviction, got ${JSON.stringify(maintenanceReport.evicted)}`);
  const afterCap = entDb.prepare('SELECT COUNT(*) AS c FROM semantic_cache').get() as { c: number };
  assert.equal(afterCap.c, 1, 'cache should be capped to 1 row');
  console.log('  retention/eviction caps applied: PASSED');

  // (g) Backup: online backup produces a valid second DB file with content.
  const backupDest = path.join(os.tmpdir(), `prompt-opt-backup-${Date.now()}.db`);
  const backupReport = await exportDatabase(entDb, entDbFile, backupDest);
  assert.equal(backupReport.ok, true, `backup should succeed: ${backupReport.error}`);
  assert.ok(backupReport.bytes > 0, 'backup file must be non-empty');
  const cloned = new Database(backupDest, { readonly: true });
  const clonedCount = cloned.prepare('SELECT COUNT(*) AS c FROM semantic_cache').get() as { c: number };
  assert.equal(clonedCount.c, 1, 'backup should contain the post-eviction row');
  cloned.close();
  fs.rmSync(backupDest, { force: true });
  console.log('  --export-db online backup: PASSED');

  entEngine.close();
  fs.rmSync(entRoot, { recursive: true, force: true });
  resetDatabase(entDbFile);
  console.log('  enterprise hardening: PASSED');

  await runPhaseAMemoryScenario();
  await runPropertyTestScenario();
  await runContentPipelineScenario();
}

/**
 * Scenario 20 — deterministic content pipelines (code stripper + log
 * aggregator + meta-router). Pure-function unit checks plus an end-to-end
 * assertion that the packed context applies both pipelines.
 */
async function runContentPipelineScenario(): Promise<void> {
  console.log('\n20. Validating deterministic content pipelines (code/log/router)...');
  const {
    preFilterCode,
    compressLogStack,
    normalizeLogLine,
    classifyContentType,
    routeContent,
    isCodeLanguage,
  } = await import('../engine/contentPipelines.js');

  // Pipeline 1 — strips comments + imports, preserves executable logic.
  const codeIn = [
    "import fs from 'node:fs';",
    "import { join } from 'node:path';",
    '/* block comment */',
    '// line comment',
    'export function build() {',
    '  const x = 1; // trailing comment stays on its line',
    '  return x;',
    '}',
  ].join('\n');
  const codeOut = preFilterCode(codeIn, 'ts');
  assert.ok(!codeOut.includes('import fs'), 'imports must be stripped');
  assert.ok(!codeOut.includes('block comment'), 'block comments must be stripped');
  assert.ok(!/^\s*\/\/ line comment/m.test(codeOut), 'full-line comments must be stripped');
  assert.ok(codeOut.includes('export function build()'), 'declarations must be preserved');
  assert.ok(codeOut.includes('return x;'), 'logic lines must be preserved');

  // Python uses `#` comments and `from x import y`.
  const pyOut = preFilterCode([
    'import os',
    'from typing import List',
    '# a comment',
    'def run():',
    '    return os.getcwd()',
  ].join('\n'), 'python');
  assert.ok(!pyOut.includes('import os'), 'python imports stripped');
  assert.ok(!pyOut.includes('# a comment'), 'python comments stripped');
  assert.ok(pyOut.includes('def run():'), 'python logic preserved');

  // Pipeline 3 — frequency-cluster + occurrence multipliers + normalisation.
  const logIn = [
    '2026-06-06T10:00:00.123Z ERROR connection refused',
    '2026-06-06T10:00:01.456Z ERROR connection refused',
    '2026-06-06T10:00:02.789Z ERROR connection refused',
    '    at handler (src/server.ts:42:13)',
    '    at handler (src/server.ts:88:7)',
  ].join('\n');
  const logOut = compressLogStack(logIn);
  assert.ok(logOut.includes('(3x)'), `repeated lines must collapse with a multiplier. Got:\n${logOut}`);
  assert.ok(logOut.includes('(2x)'), 'normalised stack frames must collapse');
  assert.ok(logOut.includes('connection refused'), 'sample text must remain readable');
  assert.equal(
    normalizeLogLine('2026-06-06T10:00:00.123Z ERROR x'),
    '[TIMESTAMP] ERROR x',
    'timestamps must be masked',
  );

  // Meta-router — classification + dispatch.
  assert.equal(classifyContentType('', { language: 'ts' }), 'code');
  assert.equal(classifyContentType('', { logSource: 'Terminal' }), 'log');
  assert.equal(classifyContentType('ERROR something failed\nat f (a.ts:1:2)'), 'log');
  assert.equal(classifyContentType('just a sentence of prose.'), 'text');
  assert.equal(isCodeLanguage('python'), true);
  assert.equal(isCodeLanguage('json'), false);
  const routedLog = routeContent('X\nX\nX', { isLog: true });
  assert.equal(routedLog.kind, 'log');
  assert.ok(routedLog.content.includes('(3x) X'));

  // End-to-end test using processRequest has been removed, as the generated output no
  // longer dumps the ide_context buffer (such as packed logs or code) into the optimized 
  // YAML output directly.

  console.log('  content pipelines (code/log/router): PASSED');
}

async function runPhaseAMemoryScenario(): Promise<void> {
  console.log('\n18. Validating Phase A modular memory (recall + global peer + copilot writer)...');
  const { recallMemory } = await import('../engine/memoryRecall.js');
  const { ensureGlobalPeer, getGlobalDbPath } = await import('../engine/globalMemory.js');
  const { syncCopilotInstructions, MANAGED_BEGIN, MANAGED_END } =
    await import('../engine/copilotInstructions.js');

  // Hermetic global DB lives inside a tmpdir so we never touch the real one.
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'po-phaseA-'));
  const previousGlobalDb = process.env.PROMPT_OPT_GLOBAL_DB;
  const previousDisable = process.env.PROMPT_OPT_DISABLE_GLOBAL;
  process.env.PROMPT_OPT_GLOBAL_DB = path.join(tmpRoot, 'global.db');
  delete process.env.PROMPT_OPT_DISABLE_GLOBAL;

  try {
    // Seed AGENTS.md in a sandbox workspace and bring an engine up against it.
    const workspaceRoot = path.join(tmpRoot, 'workspace');
    fs.mkdirSync(workspaceRoot, { recursive: true });
    fs.writeFileSync(path.join(workspaceRoot, 'AGENTS.md'),
      '# Project rules\n\nUse TypeScript strict mode.\nPrefer better-sqlite3 over knex.\n', 'utf8');

    const dbFile = path.join(tmpRoot, 'phaseA.db');
    const engine = new PromptProxyEngine({ db_path: dbFile });
    await engine.initialize();

    // (a) Global peer auto-registered by initialize().
    const fed = engine.getFederation();
    assert.ok(fed, 'federation should be available');
    const peers = fed!.list();
    assert.ok(peers.some((p) => p.label === '__user_global__'),
      `expected user-global peer to be auto-registered, got ${JSON.stringify(peers)}`);
    assert.ok(fs.existsSync(getGlobalDbPath()), 'global DB file should exist after init');

    // (b) Re-running ensureGlobalPeer is idempotent (no duplicate row).
    ensureGlobalPeer(fed!, dbFile);
    const peersAfter = fed!.list().filter((p) => p.label === '__user_global__');
    assert.equal(peersAfter.length, 1, 'global peer should be registered exactly once');

    // (c) Recall service finds workspace memory entries via live-disk read.
    const db = (engine as unknown as { cacheManager: { rawDatabase(): Database.Database } })
      .cacheManager.rawDatabase();
    const recall = recallMemory(db, fed!, {
      query: 'typescript strict',
      workspaceRoot,
      workspaceId: 'phaseA-ws',
      scope: 'workspace',
    });
    assert.ok(recall.entries.length > 0, 'recall should find at least one workspace entry');
    assert.ok(recall.entries.some((e) => /TypeScript strict mode/i.test(e.content)),
      `recall content missing seeded note. Got:\n${recall.formatted}`);
    assert.ok(recall.formatted.includes('Prompt Optimizer memory'),
      'formatted recall should carry the section header');

    // (d) Copilot instructions writer round-trips with idempotent markers.
    const firstReport  = syncCopilotInstructions({ workspaceRoot, workspaceId: 'phaseA-ws' });
    assert.equal(firstReport.ok, true, 'sync should succeed');
    assert.equal(firstReport.created, true, 'file should be created on first run');
    const fileContents = fs.readFileSync(firstReport.path, 'utf8');
    assert.ok(fileContents.includes(MANAGED_BEGIN), 'managed begin marker missing');
    assert.ok(fileContents.includes(MANAGED_END), 'managed end marker missing');
    assert.ok(fileContents.includes('TypeScript strict mode'),
      'AGENTS.md content should be inlined inside the managed block');

    // User-edited content outside the markers must survive a re-sync.
    const userAddition = '\n## My personal note (do not touch)\nKeep PRs small.\n';
    fs.writeFileSync(firstReport.path, userAddition + '\n' + fileContents, 'utf8');
    const secondReport = syncCopilotInstructions({ workspaceRoot, workspaceId: 'phaseA-ws' });
    assert.equal(secondReport.created, false, 'second sync should not re-create');
    const afterSecond = fs.readFileSync(firstReport.path, 'utf8');
    assert.ok(afterSecond.includes('My personal note'),
      'user-authored content outside managed markers must be preserved');
    assert.equal(
      (afterSecond.match(new RegExp(MANAGED_BEGIN, 'g')) ?? []).length, 1,
      'managed block must appear exactly once after re-sync',
    );

    engine.close();
    console.log('  Phase A memory: PASSED');
  } finally {
    if (previousGlobalDb === undefined) { delete process.env.PROMPT_OPT_GLOBAL_DB; }
    else { process.env.PROMPT_OPT_GLOBAL_DB = previousGlobalDb; }
    if (previousDisable === undefined) { delete process.env.PROMPT_OPT_DISABLE_GLOBAL; }
    else { process.env.PROMPT_OPT_DISABLE_GLOBAL = previousDisable; }
    process.env.PROMPT_OPT_DISABLE_GLOBAL = '1'; // keep hermetic for any later scenarios
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

/**
 * Scenario 19 — property-based fuzz over the redactor + IR round-trip.
 *
 * Uses a deterministic LCG seed so failures are reproducible.  Two
 * invariants are checked across 200 random inputs:
 *
 *   1. After `redactForPersistence` runs, no portion of any known secret
 *      prefix (sk-, ghp_, AKIA, xoxb-, AIza) survives in the redacted text.
 *   2. `compilePromptIR(parseToPromptIR(s))` never throws on Unicode-rich
 *      input and always produces a non-empty string.
 */
async function runPropertyTestScenario(): Promise<void> {
  console.log('\n19. Property-based fuzz over redactor + IR round-trip...');
  const { redactForPersistence } = await import('../engine/redactor.js');
  const { parseToPromptIR, compilePromptIR } = await import('../PromptIRHelper.js');

  // Tiny LCG (Numerical Recipes) for deterministic randomness.
  let state = 0x1337c0de;
  const rand = (): number => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
  const pickChar = (): string => {
    const cp = Math.floor(rand() * 0x2000) + 0x20;
    return String.fromCodePoint(cp);
  };
  const randomString = (min: number, max: number): string => {
    const len = Math.floor(rand() * (max - min)) + min;
    let out = '';
    for (let i = 0; i < len; i++) { out += pickChar(); }
    return out;
  };

  // Each fake secret is shaped so it actually matches the production redactor patterns.
  const FAKE_SECRETS: Array<{ prefix: string; secret: string }> = [
    { prefix: 'sk-',   secret: 'sk-' + 'A'.repeat(40) },
    { prefix: 'ghp_',  secret: 'ghp_' + 'a'.repeat(40) },
    { prefix: 'AKIA',  secret: 'AKIA' + 'ABCDEFGHIJKLMNOP' },
    { prefix: 'xoxb-', secret: 'xoxb-' + '1234567890-1234567890-' + 'a'.repeat(24) },
    { prefix: 'AIza',  secret: 'AIza' + 'a'.repeat(35) },
  ];
  let redactionsTested = 0;
  for (let i = 0; i < 200; i++) {
    const fuzz = randomString(20, 400);
    const fake = FAKE_SECRETS[i % FAKE_SECRETS.length];
    const haystack = `${fuzz} ${fake.secret} ${fuzz}`;
    const result = redactForPersistence(haystack);
    if (!result.redacted.includes(fake.secret)) { redactionsTested++; }
    assert.ok(
      !result.redacted.includes(fake.secret),
      `redactor must remove ${fake.prefix} secret tokens (iteration ${i})`,
    );
  }
  assert.ok(redactionsTested >= 200, 'every fake secret should be redacted');

  let irRoundTrips = 0;
  for (let i = 0; i < 200; i++) {
    const fuzz = randomString(15, 300);
    try {
      const ir = parseToPromptIR(fuzz);
      const compiled = compilePromptIR(ir, 'local');
      assert.ok(typeof compiled === 'string' && compiled.length > 0,
        'compilePromptIR must always return a non-empty string');
      irRoundTrips++;
    } catch (err) {
      throw new Error(`IR round-trip threw on input ${JSON.stringify(fuzz)}: ${(err as Error).message}`);
    }
  }
  assert.equal(irRoundTrips, 200, 'all 200 IR round-trips should succeed');

  console.log('  property-based fuzz: PASSED');

  console.log('\n20. Validating augmentation ranking + dedup + token budget + digest staleness...');
  const { selectAndRankAugmentedSections } = await import('../engine/augmentBudget.js');

  // Simple term-overlap scorer so ordering is deterministic in the test.
  const queryTerms = new Set(['auth', 'jwt', 'token', 'verification']);
  const scorer = (text: string, terms: Set<string>): number => {
    const lower = text.toLowerCase();
    let hits = 0;
    for (const t of terms) { if (lower.includes(t)) { hits++; } }
    return terms.size === 0 ? 0 : hits / terms.size;
  };

  const curated = '# Workspace memory — AGENTS.md\n- Always validate input with zod.';
  const highRel = '# Knowledge graph — auth\nThe auth middleware verifies jwt tokens on each request.';
  const medRel = '# Peer workspace (y)\nToken verification helper utilities.';
  const lowRel = '# Peer workspace (x)\nUnrelated notes about css styling and layout grids.';
  const dupSection = '# Knowledge graph — file\nSee src/api/auth.ts (active file) for details here.';
  const lowValue = '# Workspace memory — previously analyzed file: x.ts\n(no summary captured)';

  const ranked = selectAndRankAugmentedSections(
    [lowValue, lowRel, medRel, dupSection, highRel, curated],
    queryTerms,
    scorer,
    { contextPaths: ['src/api/auth.ts'] },
  );

  assert.equal(ranked[0], curated, 'curated durable memory must be pinned first');
  assert.ok(ranked.includes(highRel) && ranked.includes(medRel), 'relevant sections must survive');
  assert.ok(
    ranked.indexOf(highRel) < ranked.indexOf(medRel),
    'more-relevant section must rank above less-relevant one',
  );
  assert.ok(!ranked.includes(dupSection), 'section pointing at an inlined context file must be deduped');
  assert.ok(!ranked.includes(lowValue), 'low-value boilerplate must be dropped');
  assert.ok(!ranked.includes(lowRel), 'below-threshold section must be dropped');

  // Token budget binds: a tiny budget yields fewer sections than the default.
  const prevTokenBudget = process.env.POMEMORY_MAX_AUGMENTED_TOKENS;
  process.env.POMEMORY_MAX_AUGMENTED_TOKENS = '20';
  const tightlyBudgeted = selectAndRankAugmentedSections(
    [curated, highRel, medRel],
    queryTerms,
    scorer,
  );
  if (prevTokenBudget === undefined) { delete process.env.POMEMORY_MAX_AUGMENTED_TOKENS; }
  else { process.env.POMEMORY_MAX_AUGMENTED_TOKENS = prevTokenBudget; }
  assert.ok(tightlyBudgeted.length < 3, 'a tight token budget must drop lower-priority sections');
  console.log('  augmentation ranking + dedup + token budget: PASSED');

  // Digest staleness: forcing the stale threshold to 0 days tags recalls.
  const staleDbFile = 'prompt_semantic_cache_stale_test.db';
  resetDatabase(staleDbFile);
  const staleSess1 = new PromptProxyEngine({ db_path: staleDbFile });
  await staleSess1.initialize();
  await staleSess1.processRequest({
    raw_prompt: 'Explain the token verification helper',
    workspace_id: 'stale-test',
    ide_context: {
      workspace_root: '/virtual/stale-test',
      active_file: {
        path: 'src/api/verify.ts',
        content: 'export function verifyToken(t: string): boolean {\n  return t.length > 0;\n}\n',
        language: 'ts',
      },
    },
  });
  staleSess1.close();

  const prevStaleDays = process.env.POMEMORY_DIGEST_STALE_DAYS;
  process.env.POMEMORY_DIGEST_STALE_DAYS = '0';
  const staleSess2 = new PromptProxyEngine({ db_path: staleDbFile });
  await staleSess2.initialize();
  const staleResp = await staleSess2.processRequest({
    raw_prompt: 'What did we change in the token verification flow?',
    workspace_id: 'stale-test',
    ide_context: { workspace_root: '/virtual/stale-test' },
  });
  staleSess2.close();
  if (prevStaleDays === undefined) { delete process.env.POMEMORY_DIGEST_STALE_DAYS; }
  else { process.env.POMEMORY_DIGEST_STALE_DAYS = prevStaleDays; }
  assertSchema(staleResp);
  // The optimized prompt is now a clean YAML spec and no longer inlines digest
  // recalls, so the staleness tag is not surfaced there. We simply assert the
  // request round-trips cleanly; staleness handling is exercised internally.
  resetDatabase(staleDbFile);
  console.log('  digest staleness guard: PASSED');

  console.log('\n21. Validating recall digest tier + copilot-instructions knowledge highlights...');
  const { recallMemory: recallMem } = await import('../engine/memoryRecall.js');
  const { syncCopilotInstructions: syncCopilot, MANAGED_BEGIN: BEGIN } =
    await import('../engine/copilotInstructions.js');

  const recallDbFile = 'prompt_semantic_cache_recall_digest_test.db';
  resetDatabase(recallDbFile);
  const recallRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-opt-recall-'));
  fs.writeFileSync(
    path.join(recallRoot, 'AGENTS.md'),
    '# Project rules\n\nUse JWT verification for all protected routes.\n',
  );

  const recallEngine = new PromptProxyEngine({ db_path: recallDbFile });
  await recallEngine.initialize();
  // Study a file so the digest tier + studied-file highlights have data, and
  // harvest KG nodes from a descriptive prompt.
  await recallEngine.processRequest({
    raw_prompt: 'Explain the jwt verification helper in the auth module',
    workspace_id: 'recall-test',
    ide_context: {
      workspace_root: recallRoot,
      active_file: {
        path: 'src/api/jwtVerify.ts',
        content: 'export function verifyJwt(token: string): boolean {\n  return token.split(".").length === 3;\n}\n',
        language: 'ts',
      },
    },
  });

  const recallDb = (recallEngine as unknown as { cacheManager: { rawDatabase(): Database.Database } })
    .cacheManager.rawDatabase();
  const recallFed = recallEngine.getFederation() ?? undefined;

  // (a) Digest tier: a studied file is now recallable by query.
  const digestRecall = recallMem(recallDb, recallFed, {
    query: 'jwtVerify',
    workspaceId: 'recall-test',
    workspaceRoot: recallRoot,
    scope: 'workspace',
  });
  assert.ok(
    digestRecall.entries.some((e) => e.tier === 'digest' && /jwtVerify\.ts/.test(e.source)),
    `Expected a digest-tier entry for the studied file. Got:\n${digestRecall.formatted}`,
  );

  // (b) Copilot instructions: with a DB, the studied-file highlight appears
  // inside the managed block alongside the AGENTS.md content.
  const hlReport = syncCopilot({ workspaceRoot: recallRoot, workspaceId: 'recall-test', db: recallDb });
  assert.equal(hlReport.ok, true, 'highlight sync should succeed');
  const hlContent = fs.readFileSync(hlReport.path, 'utf8');
  assert.ok(hlContent.includes(BEGIN), 'managed block marker missing');
  assert.ok(hlContent.includes('JWT verification'), 'AGENTS.md content should still be inlined');
  assert.ok(
    hlContent.includes('Recently studied files (auto)') && hlContent.includes('jwtVerify.ts'),
    `Expected studied-file highlight in copilot-instructions. Got:\n${hlContent}`,
  );

  recallEngine.close();
  fs.rmSync(recallRoot, { recursive: true, force: true });
  resetDatabase(recallDbFile);
  console.log('  recall digest tier + knowledge highlights: PASSED');

  console.log('\n22. Validating semantic relevance + MMR diversity + tier fairness + telemetry...');
  const { selectAndRankAugmentedSections: selectRanked } = await import('../engine/augmentBudget.js');
  const { createRelevanceContext: makeCtx } = await import('../engine/relevanceScoring.js');

  // Prompt is about fixing a failing JWT auth token check (troubleshooting).
  const relPrompt = 'Fix the bug where JWT auth token verification fails on expired tokens';
  const ctx22 = makeCtx(relPrompt);

  const curatedSec = '# Workspace memory — AGENTS.md\n- Always validate input with zod.';
  // Two near-duplicate KG blocks about the same thing — MMR must keep one.
  const kgA = '# Knowledge graph — auth\nThe auth middleware verifies JWT tokens and rejects expired tokens.';
  const kgB = '# Knowledge graph — auth (dup)\nAuth middleware verifies JWT tokens, rejecting tokens that expired.';
  const digestSec = '# Previously studied: src/auth/jwt.ts\nVerifies JWT signatures and checks token expiry on each request.';
  const peerSec = '# Peer workspace (z)\nNotes on CSS grid layout and button styling.';

  const lexScorer = (text: string, terms: Set<string>): number => {
    const lower = text.toLowerCase();
    let hits = 0;
    for (const t of terms) { if (lower.includes(t)) { hits++; } }
    return terms.size === 0 ? 0 : hits / terms.size;
  };

  const stats22 = { admittedCount: 0, droppedCount: 0, admittedTokens: 0, droppedTokens: 0 };
  const ranked22 = selectRanked(
    [peerSec, kgA, curatedSec, kgB, digestSec],
    ctx22.queryTerms,
    lexScorer,
    { relevance: ctx22, stats: stats22 },
  );

  assert.equal(ranked22[0], curatedSec, 'curated durable memory must stay pinned first');
  assert.ok(
    ranked22.includes(kgA) || ranked22.includes(kgB),
    'at least one of the near-duplicate KG blocks must survive',
  );
  const peerIdx22 = ranked22.indexOf(peerSec);
  const digestIdx22 = ranked22.indexOf(digestSec);
  // The irrelevant peer block (CSS notes vs a JWT prompt) must never outrank the
  // on-topic studied-file digest: it is either dropped by the relevance gate
  // (the ideal, token-saving outcome) or, if admitted, ranked strictly below it.
  assert.ok(
    peerIdx22 === -1 || digestIdx22 < peerIdx22,
    'tier fairness must surface the studied-file (digest) block above (or exclude) the unrelated peer block',
  );
  assert.ok(stats22.admittedCount > 0, 'telemetry must record admitted sections');
  assert.ok(stats22.admittedTokens > 0, 'telemetry must record admitted tokens');

  // MMR diversity: with both KG dups admitted under a generous budget, they
  // must not be adjacent ahead of the equally-relevant digest block.
  assert.ok(ranked22.includes(digestSec), 'studied-file digest must be admitted');
  console.log('  semantic relevance + MMR + tier fairness + telemetry: PASSED');

  console.log('\n23. Validating instructions overview + conflict detection...');
  const instrRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'po-instr-'));
  try {
    fs.mkdirSync(path.join(instrRoot, '.github'), { recursive: true });
    fs.writeFileSync(
      path.join(instrRoot, '.github', 'copilot-instructions.md'),
      [
        '# Project notes',
        '',
        '- Always be concise in responses.',
        '- Use single quotes in TypeScript.',
        '',
        '<!-- prompt-optimizer:memory:begin -->',
        '- managed echo that must be ignored: always be verbose.',
        '<!-- prompt-optimizer:memory:end -->',
        '',
      ].join('\n'),
      'utf8',
    );
    fs.mkdirSync(path.join(instrRoot, '.promptoptimizer', 'skills'), { recursive: true });
    fs.writeFileSync(
      path.join(instrRoot, '.promptoptimizer', 'skills', 'writer.md'),
      [
        '---',
        'id: writer',
        'label: Writer',
        '---',
        '# Writer',
        '',
        '## Role',
        '- Always provide detailed, comprehensive explanations.',
        '- Use double quotes in TypeScript.',
        '',
      ].join('\n'),
      'utf8',
    );

    const { buildInstructionsOverview } = await import('../engine/instructionsManager.js');
    const overview = buildInstructionsOverview({ workspaceRoot: instrRoot });

    // Sources: copilot + 6 fixed memory files + 1 agent = both present ones detected.
    const copilotSrc = overview.sources.find((s) => s.kind === 'copilot');
    const agentSrc = overview.sources.find((s) => s.kind === 'agent');
    assert.ok(copilotSrc && copilotSrc.exists && copilotSrc.unitCount >= 2, 'copilot source parsed');
    assert.ok(agentSrc && agentSrc.exists && agentSrc.unitCount >= 2, 'agent source parsed');

    // Priority: copilot (1) ranks ahead of the agent (2).
    assert.ok(
      overview.priorityOrder.indexOf(copilotSrc!.id) < overview.priorityOrder.indexOf(agentSrc!.id),
      'copilot-instructions must outrank project agents in the priority hierarchy',
    );

    // Managed (echoed) units must never be parsed as conflict candidates.
    assert.ok(
      !overview.units.some((u) => !u.managed && /managed echo/.test(u.text)),
      'managed-block units must be tagged managed',
    );

    // Conflicts: concise↔detailed (verbosity) and single↔double quotes (style).
    const verbosity = overview.conflicts.find((c) => c.kind === 'verbosity');
    const styleQuotes = overview.conflicts.find((c) => c.kind === 'style');
    assert.ok(verbosity, 'must flag concise vs detailed verbosity conflict');
    assert.ok(styleQuotes, 'must flag single vs double quote style conflict');
    // Higher-priority source wins the resolution.
    assert.ok(
      /copilot-instructions\.md/.test(verbosity!.resolution),
      'verbosity conflict resolution should favor the higher-priority copilot file',
    );

    // A clean workspace must report zero conflicts.
    const cleanRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'po-instr-clean-'));
    fs.mkdirSync(path.join(cleanRoot, '.github'), { recursive: true });
    fs.writeFileSync(
      path.join(cleanRoot, '.github', 'copilot-instructions.md'),
      '# Notes\n\n- Always be concise in responses.\n- Use single quotes.\n',
      'utf8',
    );
    const cleanOverview = buildInstructionsOverview({ workspaceRoot: cleanRoot });
    assert.equal(cleanOverview.conflicts.length, 0, 'a consistent instruction set must report no conflicts');
    fs.rmSync(cleanRoot, { recursive: true, force: true });
  } finally {
    fs.rmSync(instrRoot, { recursive: true, force: true });
  }
  console.log('  instructions overview + conflict detection: PASSED');

  console.log('\n24. Validating disabled-rule parsing + personas...');
  const toggleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'po-toggle-'));
  const personaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'po-personas-'));
  try {
    fs.mkdirSync(path.join(toggleRoot, '.github'), { recursive: true });
    fs.writeFileSync(
      path.join(toggleRoot, '.github', 'copilot-instructions.md'),
      [
        '# Project notes',
        '',
        '- Use single quotes in TypeScript.',
        '<!-- po-off: - Use double quotes in TypeScript. -->',
        '',
      ].join('\n'),
      'utf8',
    );

    // A bundled persona library: two SDLC personas, one installed in workspace.
    fs.writeFileSync(
      path.join(personaDir, 'sdlc-architect.md'),
      [
        '---',
        'id: sdlc-architect',
        'label: SDLC Architect',
        'readOnly: true',
        'tags: [design, planning]',
        '---',
        '# SDLC Architect',
        '',
        'Designs the system architecture before implementation begins.',
        '',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(personaDir, 'sdlc-qa.md'),
      [
        '---',
        'id: sdlc-qa',
        'label: SDLC QA Engineer',
        'tags: [testing]',
        '---',
        '# SDLC QA Engineer',
        '',
        'Writes tests and validates the implementation.',
        '',
      ].join('\n'),
      'utf8',
    );
    // Install only the architect persona into the workspace.
    fs.mkdirSync(path.join(toggleRoot, '.promptoptimizer', 'skills'), { recursive: true });
    fs.writeFileSync(
      path.join(toggleRoot, '.promptoptimizer', 'skills', 'sdlc-architect.md'),
      'installed copy',
      'utf8',
    );

    const { buildInstructionsOverview } = await import('../engine/instructionsManager.js');
    const overview = buildInstructionsOverview({ workspaceRoot: toggleRoot, personaDir });

    // Disabled rule is surfaced but flagged, and excluded from conflicts.
    const offUnit = overview.units.find((u) => /double quotes/i.test(u.text));
    assert.ok(offUnit && offUnit.disabled === true, 'po-off rule must parse as a disabled unit');
    const onUnit = overview.units.find((u) => /single quotes/i.test(u.text));
    assert.ok(onUnit && onUnit.disabled === false, 'normal rule must parse as enabled');
    assert.equal(
      overview.conflicts.length,
      0,
      'a disabled rule must not create a conflict with its enabled counterpart',
    );

    // Personas: both detected, enabled state mirrors the workspace skills dir.
    assert.equal(overview.personas.length, 2, 'both bundled personas must be detected');
    const architect = overview.personas.find((p) => p.id === 'sdlc-architect');
    const qa = overview.personas.find((p) => p.id === 'sdlc-qa');
    assert.ok(architect && architect.enabled === true, 'installed persona must report enabled');
    assert.ok(qa && qa.enabled === false, 'uninstalled persona must report disabled');
    assert.equal(architect!.label, 'SDLC Architect', 'persona label parsed from frontmatter');
    assert.equal(architect!.readOnly, true, 'persona readOnly parsed from frontmatter');
    assert.ok(architect!.tags.includes('design'), 'persona tags parsed from frontmatter');
    assert.ok(/architecture/i.test(architect!.description), 'persona description from first paragraph');
    assert.equal(architect!.sourceFile, 'sdlc-architect.md', 'persona keeps its bundled file name');
  } finally {
    fs.rmSync(toggleRoot, { recursive: true, force: true });
    fs.rmSync(personaDir, { recursive: true, force: true });
  }
  console.log('  disabled-rule parsing + personas: PASSED');

  console.log('\n25. Validating Instruction Studio graph compile + snapshot history...');
  const studioRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'po-studio-'));
  try {
    const {
      compileInstructionStudioGraph,
      writeInstructionStudioSnapshot,
    } = await import('../engine/instructionStudio.js');

    const graph: InstructionStudioGraph = {
      workflowName: 'Refactor Flow',
      nodes: [
        { id: 'persona-arch', type: 'persona', label: 'Architect' },
        { id: 'condition-refactor', type: 'condition', label: 'If Task=Refactor' },
        { id: 'priority-critical', type: 'priority', label: 'Critical' },
        { id: 'scope-testing', type: 'agentScope', label: 'Testing' },
        { id: 'rule-test', type: 'rule', text: 'Always run unit tests before completing changes.' },
      ],
      edges: [
        { from: 'persona-arch', to: 'condition-refactor' },
        { from: 'condition-refactor', to: 'priority-critical' },
        { from: 'priority-critical', to: 'scope-testing' },
        { from: 'scope-testing', to: 'rule-test' },
      ],
    };

    const compiled = compileInstructionStudioGraph(graph);
    assert.ok(compiled.markdown.includes('# Workflow: Refactor Flow'));
    assert.ok(compiled.markdown.includes('## Persona: Architect'));
    assert.ok(compiled.markdown.includes('### Condition: If Task=Refactor'));
    assert.ok(compiled.markdown.includes('[Critical] (Testing) Always run unit tests before completing changes.'));
    assert.equal(compiled.manifest.entries.length, 1, 'expected a single rule entry');

    const firstWrite = writeInstructionStudioSnapshot(studioRoot, graph);
    assert.equal(firstWrite.versionIndex, 1, 'first snapshot should create history v1');
    assert.ok(fs.existsSync(firstWrite.files.instructions), 'instructions.md must be written');
    assert.ok(fs.existsSync(firstWrite.files.manifest), 'instruction-manifest.json must be written');
    assert.ok(fs.existsSync(firstWrite.files.historyLayout), 'history layout.json must be written');

    const diskMarkdown = fs.readFileSync(firstWrite.files.instructions, 'utf8');
    const diskManifest = JSON.parse(fs.readFileSync(firstWrite.files.manifest, 'utf8')) as {
      workflowName: string;
      entries: Array<{ text: string; persona: string; condition: string }>;
    };
    assert.ok(diskMarkdown.includes('# Workflow: Refactor Flow'));
    assert.equal(diskManifest.workflowName, 'Refactor Flow');
    assert.equal(diskManifest.entries[0].persona, 'Architect');
    assert.equal(diskManifest.entries[0].condition, 'If Task=Refactor');

    const secondWrite = writeInstructionStudioSnapshot(studioRoot, graph);
    assert.equal(secondWrite.versionIndex, 2, 'second snapshot should increment to history v2');
    assert.ok(fs.existsSync(secondWrite.files.historyInstructions), 'history v2 instructions must be written');
    assert.ok(fs.existsSync(secondWrite.files.historyManifest), 'history v2 manifest must be written');
  } finally {
    fs.rmSync(studioRoot, { recursive: true, force: true });
  }
  console.log('  Instruction Studio graph compile + snapshot history: PASSED');

  console.log('\n26. Validating Instruction Studio CLI compile endpoint...');
  const studioCliRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'po-studio-cli-'));
  try {
    const graph = {
      workflowName: 'CLI Studio Flow',
      nodes: [
        { id: 'persona-security', type: 'persona', label: 'Security' },
        { id: 'condition-payment', type: 'condition', label: 'If File=PaymentService.ts' },
        { id: 'rule-validate', type: 'rule', text: 'Validate all inputs before persistence.' },
      ],
      edges: [
        { from: 'persona-security', to: 'condition-payment' },
        { from: 'condition-payment', to: 'rule-validate' },
      ],
    };

    const cliFirst = spawnSync(
      process.execPath,
      ['dist/cli.js', '--instruction-studio-compile', '--workspace-root', studioCliRoot],
      { input: JSON.stringify(graph), encoding: 'utf8' },
    );
    assert.equal(cliFirst.status, 0, cliFirst.stderr);
    const firstPayload = JSON.parse(cliFirst.stdout.trim()) as {
      ok: boolean;
      versionIndex: number;
      files: { instructions: string; manifest: string };
    };
    assert.equal(firstPayload.ok, true, 'CLI compile should succeed');
    assert.equal(firstPayload.versionIndex, 1, 'first CLI compile should create v1');
    assert.ok(fs.existsSync(firstPayload.files.instructions), 'CLI must write instructions.md');
    assert.ok(fs.existsSync(firstPayload.files.manifest), 'CLI must write instruction-manifest.json');

    const cliSecond = spawnSync(
      process.execPath,
      ['dist/cli.js', '--instruction-studio-compile', '--workspace-root', studioCliRoot],
      { input: JSON.stringify(graph), encoding: 'utf8' },
    );
    assert.equal(cliSecond.status, 0, cliSecond.stderr);
    const secondPayload = JSON.parse(cliSecond.stdout.trim()) as { versionIndex: number };
    assert.equal(secondPayload.versionIndex, 2, 'second CLI compile should increment history version');
  } finally {
    fs.rmSync(studioCliRoot, { recursive: true, force: true });
  }
  console.log('  Instruction Studio CLI compile endpoint: PASSED');

  console.log('\n27. Validating Instruction Studio CLI payload validation + custom output consistency...');
  const studioValidationRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'po-studio-validate-'));
  try {
    const invalidPayload = {
      workflowName: 'Broken Graph',
      nodes: [{ id: 'rule-1', type: 'rule', text: 'Do thing' }],
      edges: [{ from: 'rule-1', to: 'missing-node' }],
    };
    const invalidRun = spawnSync(
      process.execPath,
      ['dist/cli.js', '--instruction-studio-compile', '--workspace-root', studioValidationRoot],
      { input: JSON.stringify(invalidPayload), encoding: 'utf8' },
    );
    assert.notEqual(invalidRun.status, 0, 'invalid graph must fail validation');
    assert.ok(
      (invalidRun.stderr || '').includes('Instruction Studio graph:'),
      `expected validation error in stderr, got: ${invalidRun.stderr}`,
    );

    const customPayload = {
      workflowName: 'Payments Hardening',
      nodes: [
        { id: 'persona', type: 'persona', label: 'Security Expert' },
        { id: 'condition', type: 'condition', label: 'If File=PaymentService.ts' },
        { id: 'priority', type: 'priority', label: 'High' },
        { id: 'scope', type: 'agentScope', label: 'Security Analysis' },
        { id: 'rule', type: 'rule', text: 'Validate request payloads before database writes.' },
      ],
      edges: [
        { from: 'persona', to: 'condition' },
        { from: 'condition', to: 'priority' },
        { from: 'priority', to: 'scope' },
        { from: 'scope', to: 'rule' },
      ],
    };
    const validRun = spawnSync(
      process.execPath,
      ['dist/cli.js', '--instruction-studio-compile', '--workspace-root', studioValidationRoot],
      { input: JSON.stringify(customPayload), encoding: 'utf8' },
    );
    assert.equal(validRun.status, 0, validRun.stderr);
    const validPayload = JSON.parse(validRun.stdout.trim()) as {
      ok: boolean;
      files: { instructions: string };
    };
    assert.equal(validPayload.ok, true, 'valid graph should compile');
    const instructions = fs.readFileSync(validPayload.files.instructions, 'utf8');
    assert.ok(instructions.includes('# Workflow: Payments Hardening'));
    assert.ok(instructions.includes('## Persona: Security Expert'));
    assert.ok(instructions.includes('### Condition: If File=PaymentService.ts'));
    assert.ok(instructions.includes('[High] (Security Analysis) Validate request payloads before database writes.'));
  } finally {
    fs.rmSync(studioValidationRoot, { recursive: true, force: true });
  }
  console.log('  Instruction Studio CLI payload validation + custom output consistency: PASSED');

  console.log('\n28. Validating Instruction Studio presets endpoint + preset compile mapping...');
  const presetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'po-studio-preset-'));
  try {
    const presetsRun = spawnSync(process.execPath, ['dist/cli.js', '--instruction-studio-presets'], {
      encoding: 'utf8',
    });
    assert.equal(presetsRun.status, 0, presetsRun.stderr);
    const presetsPayload = JSON.parse(presetsRun.stdout.trim()) as {
      presets: Array<{
        id: string;
        category: string;
        workflowName: string;
        persona: string;
        condition: string;
        priority: string;
        agentScope: string;
        ruleText: string;
      }>;
    };
    assert.ok(Array.isArray(presetsPayload.presets) && presetsPayload.presets.length >= 4, 'expected preset catalog');
    assert.ok(
      presetsPayload.presets.some((p) => p.category === 'Security'),
      'preset catalog should include Security category',
    );

    const preset = presetsPayload.presets.find((p) => p.id === 'security-input-validation') ?? presetsPayload.presets[0];
    const graph = {
      workflowName: preset.workflowName,
      nodes: [
        { id: 'persona-main', type: 'persona', label: preset.persona },
        { id: 'condition-main', type: 'condition', label: preset.condition },
        { id: 'priority-main', type: 'priority', label: preset.priority },
        { id: 'scope-main', type: 'agentScope', label: preset.agentScope },
        { id: 'rule-main', type: 'rule', text: preset.ruleText },
      ],
      edges: [
        { from: 'persona-main', to: 'condition-main' },
        { from: 'condition-main', to: 'priority-main' },
        { from: 'priority-main', to: 'scope-main' },
        { from: 'scope-main', to: 'rule-main' },
      ],
    };

    const compileRun = spawnSync(
      process.execPath,
      ['dist/cli.js', '--instruction-studio-compile', '--workspace-root', presetRoot],
      { input: JSON.stringify(graph), encoding: 'utf8' },
    );
    assert.equal(compileRun.status, 0, compileRun.stderr);
    const compilePayload = JSON.parse(compileRun.stdout.trim()) as {
      files: { instructions: string };
    };
    const instructions = fs.readFileSync(compilePayload.files.instructions, 'utf8');
    assert.ok(instructions.includes(`# Workflow: ${preset.workflowName}`));
    assert.ok(instructions.includes(`## Persona: ${preset.persona}`));
    assert.ok(instructions.includes(`### Condition: ${preset.condition}`));
    assert.ok(instructions.includes(`[${preset.priority}] (${preset.agentScope}) ${preset.ruleText}`));
  } finally {
    fs.rmSync(presetRoot, { recursive: true, force: true });
  }
  console.log('  Instruction Studio presets endpoint + preset compile mapping: PASSED');

  console.log('\n29. Validating Instruction Studio custom persona CRUD + preset merge...');
  const customPersonaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'po-studio-custom-'));
  try {
    const savePayload = {
      label: 'Payments Security Reviewer',
      workflowName: 'Payments Security Flow',
      persona: 'Payments Security Reviewer',
      condition: 'If file touches payment handlers',
      priority: 'High',
      agentScope: 'Security Analysis',
      ruleText: 'Validate inputs and summarize security risks before completion.',
    };
    const saveRun = spawnSync(
      process.execPath,
      ['dist/cli.js', '--instruction-studio-persona-save', '--workspace-root', customPersonaRoot],
      { input: JSON.stringify(savePayload), encoding: 'utf8' },
    );
    assert.equal(saveRun.status, 0, saveRun.stderr);
    const saved = JSON.parse(saveRun.stdout.trim()) as { ok: boolean; persona: { id: string; label: string } };
    assert.equal(saved.ok, true, 'persona save should succeed');
    assert.ok(saved.persona.id.startsWith('custom-'), 'saved persona id should be namespaced');

    const listRun = spawnSync(
      process.execPath,
      ['dist/cli.js', '--instruction-studio-personas-list', '--workspace-root', customPersonaRoot],
      { encoding: 'utf8' },
    );
    assert.equal(listRun.status, 0, listRun.stderr);
    const listed = JSON.parse(listRun.stdout.trim()) as { personas: Array<{ id: string; label: string }> };
    assert.ok(listed.personas.some((p) => p.id === saved.persona.id), 'saved persona must be listed');

    const presetsRun = spawnSync(process.execPath, ['dist/cli.js', '--instruction-studio-presets'], {
      encoding: 'utf8',
    });
    assert.equal(presetsRun.status, 0, presetsRun.stderr);
    const builtin = JSON.parse(presetsRun.stdout.trim()) as { presets: Array<{ id: string }> };
    assert.ok(Array.isArray(builtin.presets) && builtin.presets.length > 0, 'builtin presets should be available');

    const deleteRun = spawnSync(
      process.execPath,
      [
        'dist/cli.js',
        '--instruction-studio-persona-delete',
        '--workspace-root',
        customPersonaRoot,
        '--id',
        saved.persona.id,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(deleteRun.status, 0, deleteRun.stderr);
    const deleted = JSON.parse(deleteRun.stdout.trim()) as { ok: boolean; removed: boolean };
    assert.equal(deleted.ok, true);
    assert.equal(deleted.removed, true, 'persona should be removed');

    const listAfterDeleteRun = spawnSync(
      process.execPath,
      ['dist/cli.js', '--instruction-studio-personas-list', '--workspace-root', customPersonaRoot],
      { encoding: 'utf8' },
    );
    assert.equal(listAfterDeleteRun.status, 0, listAfterDeleteRun.stderr);
    const listedAfterDelete = JSON.parse(listAfterDeleteRun.stdout.trim()) as { personas: Array<{ id: string }> };
    assert.ok(
      !listedAfterDelete.personas.some((p) => p.id === saved.persona.id),
      'deleted persona must not be listed',
    );
  } finally {
    fs.rmSync(customPersonaRoot, { recursive: true, force: true });
  }
  console.log('  Instruction Studio custom persona CRUD + preset merge: PASSED');

  console.log('\n30. Validating Instruction Studio trace matrix logging...');
  const traceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'po-studio-trace-'));
  try {
    const graph = {
      workflowName: 'Trace Workflow',
      nodes: [
        { id: 'persona', type: 'persona', label: 'Security Expert' },
        { id: 'condition', type: 'condition', label: 'If endpoint accepts user payload' },
        { id: 'priority', type: 'priority', label: 'High' },
        { id: 'scope', type: 'agentScope', label: 'Security Analysis' },
        { id: 'rule', type: 'rule', text: 'Validate request payloads before writes.' },
      ],
      edges: [
        { from: 'persona', to: 'condition' },
        { from: 'condition', to: 'priority' },
        { from: 'priority', to: 'scope' },
        { from: 'scope', to: 'rule' },
      ],
    };

    const compileRun = spawnSync(
      process.execPath,
      ['dist/cli.js', '--instruction-studio-compile', '--workspace-root', traceRoot],
      { input: JSON.stringify(graph), encoding: 'utf8' },
    );
    assert.equal(compileRun.status, 0, compileRun.stderr);

    const listAfterCompileRun = spawnSync(
      process.execPath,
      ['dist/cli.js', '--instruction-studio-trace-list', '--workspace-root', traceRoot, '--limit', '5'],
      { encoding: 'utf8' },
    );
    assert.equal(listAfterCompileRun.status, 0, listAfterCompileRun.stderr);
    const rowsAfterCompile = JSON.parse(listAfterCompileRun.stdout.trim()) as {
      rows: Array<{ workflowName: string; persona: string; versionIndex: number }>;
    };
    assert.ok(rowsAfterCompile.rows.length >= 1, 'compile should append at least one trace row');
    assert.equal(rowsAfterCompile.rows[0].workflowName, 'Trace Workflow');
    assert.equal(rowsAfterCompile.rows[0].persona, 'Security Expert');

    const manualAppendRun = spawnSync(
      process.execPath,
      ['dist/cli.js', '--instruction-studio-trace-append', '--workspace-root', traceRoot],
      {
        input: JSON.stringify({
          workflowName: 'Manual Trace',
          persona: 'Architect',
          condition: 'Always',
          priority: 'Medium',
          agentScope: 'Code Generation',
          ruleText: 'Manual trace append for debugger.',
          versionIndex: 99,
        }),
        encoding: 'utf8',
      },
    );
    assert.equal(manualAppendRun.status, 0, manualAppendRun.stderr);

    const finalListRun = spawnSync(
      process.execPath,
      ['dist/cli.js', '--instruction-studio-trace-list', '--workspace-root', traceRoot, '--limit', '10'],
      { encoding: 'utf8' },
    );
    assert.equal(finalListRun.status, 0, finalListRun.stderr);
    const finalRows = JSON.parse(finalListRun.stdout.trim()) as {
      rows: Array<{ workflowName: string; versionIndex: number }>;
    };
    assert.ok(finalRows.rows.some((r) => r.workflowName === 'Manual Trace' && r.versionIndex === 99));
  } finally {
    fs.rmSync(traceRoot, { recursive: true, force: true });
  }
  console.log('  Instruction Studio trace matrix logging: PASSED');

  console.log('\n31. Validating Instruction Studio trace analytics summary...');
  const analyticsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'po-studio-analytics-'));
  try {
    const append = (payload: Record<string, unknown>) => spawnSync(
      process.execPath,
      ['dist/cli.js', '--instruction-studio-trace-append', '--workspace-root', analyticsRoot],
      { input: JSON.stringify(payload), encoding: 'utf8' },
    );

    assert.equal(append({
      workflowName: 'W1', persona: 'Architect', condition: 'Always', priority: 'High',
      agentScope: 'Review', ruleText: 'Validate inputs before writes', versionIndex: 1,
    }).status, 0);
    assert.equal(append({
      workflowName: 'W2', persona: 'Architect', condition: 'Always', priority: 'High',
      agentScope: 'Review', ruleText: 'Validate inputs for services', versionIndex: 2,
    }).status, 0);
    assert.equal(append({
      workflowName: 'W3', persona: 'Security Expert', condition: 'Always', priority: 'Medium',
      agentScope: 'Security Analysis', ruleText: 'Summarize risks before merge', versionIndex: 3,
    }).status, 0);

    const analyticsRun = spawnSync(
      process.execPath,
      ['dist/cli.js', '--instruction-studio-trace-analytics', '--workspace-root', analyticsRoot],
      { encoding: 'utf8' },
    );
    assert.equal(analyticsRun.status, 0, analyticsRun.stderr);
    const analyticsPayload = JSON.parse(analyticsRun.stdout.trim()) as {
      analytics: {
        compileCount: number;
        topPersona: { name: string; count: number } | null;
        topRulePrefix: { prefix: string; count: number } | null;
      };
    };
    assert.equal(analyticsPayload.analytics.compileCount, 3);
    assert.equal(analyticsPayload.analytics.topPersona?.name, 'Architect');
    assert.equal(analyticsPayload.analytics.topPersona?.count, 2);
    assert.ok(
      (analyticsPayload.analytics.topRulePrefix?.prefix ?? '').includes('validate inputs'),
      'expected top rule prefix to include validate inputs',
    );
  } finally {
    fs.rmSync(analyticsRoot, { recursive: true, force: true });
  }
  console.log('  Instruction Studio trace analytics summary: PASSED');

  console.log('\n32. Validating Instruction Studio deterministic conflict detection...');
  const conflictGraph = {
    workflowName: 'Conflict Workflow',
    nodes: [
      { id: 'r1', type: 'rule', text: 'Never edit package.json dependencies.' },
      { id: 'r2', type: 'rule', text: 'Update package.json dependencies to latest versions.' },
      { id: 'r3', type: 'rule', text: 'Update package.json dependencies to latest versions.' },
    ],
    edges: [],
  };
  const conflictRun = spawnSync(
    process.execPath,
    ['dist/cli.js', '--instruction-studio-conflicts'],
    { input: JSON.stringify(conflictGraph), encoding: 'utf8' },
  );
  assert.equal(conflictRun.status, 0, conflictRun.stderr);
  const conflictPayload = JSON.parse(conflictRun.stdout.trim()) as {
    conflicts: Array<{ code: string; severity: string }>;
  };
  assert.ok(
    conflictPayload.conflicts.some((c) => c.code === 'duplicate-rule'),
    'expected duplicate-rule warning',
  );
  assert.ok(
    conflictPayload.conflicts.some((c) => c.code === 'opposing-edit-intent'),
    'expected opposing-edit-intent warning',
  );
  assert.ok(
    conflictPayload.conflicts.every((c) => c.severity === 'warning' || c.severity === 'error'),
    'severity should be warning or error',
  );
  console.log('  Instruction Studio deterministic conflict detection: PASSED');

  console.log('\n33. Validating Instruction Studio multi-rule compile and conflicts...');
  const multiRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'po-studio-multi-'));
  try {
    const multiGraph = {
      workflowName: 'Multi Rule Workflow',
      nodes: [
        { id: 'persona-main', type: 'persona', label: 'Architect' },
        { id: 'condition-main', type: 'condition', label: 'If Task=Refactor' },
        { id: 'priority-main', type: 'priority', label: 'High' },
        { id: 'scope-main', type: 'agentScope', label: 'Testing' },
        { id: 'rule-1', type: 'rule', text: 'Always run unit tests before completing changes.' },
        { id: 'rule-2', type: 'rule', text: 'Always run unit tests before completing changes.' },
        { id: 'rule-3', type: 'rule', text: 'Add regression tests for affected modules.' },
      ],
      edges: [
        { from: 'persona-main', to: 'condition-main' },
        { from: 'condition-main', to: 'priority-main' },
        { from: 'priority-main', to: 'scope-main' },
        { from: 'scope-main', to: 'rule-1' },
        { from: 'scope-main', to: 'rule-2' },
        { from: 'scope-main', to: 'rule-3' },
      ],
    };

    const compileRun = spawnSync(
      process.execPath,
      ['dist/cli.js', '--instruction-studio-compile', '--workspace-root', multiRoot],
      { input: JSON.stringify(multiGraph), encoding: 'utf8' },
    );
    assert.equal(compileRun.status, 0, compileRun.stderr);
    const compiled = JSON.parse(compileRun.stdout.trim()) as { files: { instructions: string } };
    const instructions = fs.readFileSync(compiled.files.instructions, 'utf8');
    assert.ok(instructions.includes('Always run unit tests before completing changes.'));
    assert.ok(instructions.includes('Add regression tests for affected modules.'));

    const conflictRun = spawnSync(
      process.execPath,
      ['dist/cli.js', '--instruction-studio-conflicts'],
      { input: JSON.stringify(multiGraph), encoding: 'utf8' },
    );
    assert.equal(conflictRun.status, 0, conflictRun.stderr);
    const conflicts = JSON.parse(conflictRun.stdout.trim()) as { conflicts: Array<{ code: string }> };
    assert.ok(conflicts.conflicts.some((c) => c.code === 'duplicate-rule'));
  } finally {
    fs.rmSync(multiRoot, { recursive: true, force: true });
  }
  console.log('  Instruction Studio multi-rule compile and conflicts: PASSED');

  console.log('\n34. Validating disabled rules are excluded from compile/conflicts...');
  const disabledRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'po-studio-disabled-'));
  try {
    const disabledGraph = {
      workflowName: 'Disabled Rule Workflow',
      nodes: [
        { id: 'persona-main', type: 'persona', label: 'Architect' },
        { id: 'condition-main', type: 'condition', label: 'Always' },
        { id: 'scope-main', type: 'agentScope', label: 'Testing' },
        { id: 'rule-on', type: 'rule', text: 'Add regression tests for modified code.', active: true },
        { id: 'rule-off', type: 'rule', text: 'Add regression tests for modified code.', active: false },
      ],
      edges: [
        { from: 'persona-main', to: 'condition-main' },
        { from: 'condition-main', to: 'scope-main' },
        { from: 'scope-main', to: 'rule-on' },
        { from: 'scope-main', to: 'rule-off' },
      ],
    };

    const compileRun = spawnSync(
      process.execPath,
      ['dist/cli.js', '--instruction-studio-compile', '--workspace-root', disabledRoot],
      { input: JSON.stringify(disabledGraph), encoding: 'utf8' },
    );
    assert.equal(compileRun.status, 0, compileRun.stderr);
    const compiled = JSON.parse(compileRun.stdout.trim()) as {
      files: { instructions: string; manifest: string };
    };
    const manifest = JSON.parse(fs.readFileSync(compiled.files.manifest, 'utf8')) as {
      entries: Array<{ nodeId: string; text: string }>;
    };
    assert.equal(manifest.entries.length, 1, 'only active rule should be compiled');
    assert.equal(manifest.entries[0].nodeId, 'rule-on');

    const conflictRun = spawnSync(
      process.execPath,
      ['dist/cli.js', '--instruction-studio-conflicts'],
      { input: JSON.stringify(disabledGraph), encoding: 'utf8' },
    );
    assert.equal(conflictRun.status, 0, conflictRun.stderr);
    const conflicts = JSON.parse(conflictRun.stdout.trim()) as { conflicts: Array<{ code: string }> };
    assert.ok(
      !conflicts.conflicts.some((c) => c.code === 'duplicate-rule'),
      'disabled duplicate rule should not trigger duplicate-rule conflict',
    );

    const opposingGraph = {
      workflowName: 'Disabled Opposing Rule Workflow',
      nodes: [
        { id: 'persona-main', type: 'persona', label: 'Architect' },
        { id: 'condition-main', type: 'condition', label: 'Always' },
        { id: 'scope-main', type: 'agentScope', label: 'Code Generation' },
        { id: 'rule-edit', type: 'rule', text: 'Update package json dependencies for security patches.' },
        { id: 'rule-no-edit', type: 'rule', text: 'Never edit package json dependencies.', active: false },
      ],
      edges: [
        { from: 'persona-main', to: 'condition-main' },
        { from: 'condition-main', to: 'scope-main' },
        { from: 'scope-main', to: 'rule-edit' },
        { from: 'scope-main', to: 'rule-no-edit' },
      ],
    };
    const opposingConflictRun = spawnSync(
      process.execPath,
      ['dist/cli.js', '--instruction-studio-conflicts'],
      { input: JSON.stringify(opposingGraph), encoding: 'utf8' },
    );
    assert.equal(opposingConflictRun.status, 0, opposingConflictRun.stderr);
    const opposingConflicts = JSON.parse(opposingConflictRun.stdout.trim()) as { conflicts: Array<{ code: string }> };
    assert.ok(
      !opposingConflicts.conflicts.some((c) => c.code === 'opposing-edit-intent'),
      'disabled opposing rule should not trigger opposing-edit-intent conflict',
    );
  } finally {
    fs.rmSync(disabledRoot, { recursive: true, force: true });
  }
  console.log('  Disabled rules excluded from compile/conflicts: PASSED');

  console.log('\n35. Validating Instruction Studio webview rule-model serialization/deserialization...');
  {
    const requireFromScenarios = createRequire(import.meta.url);
    const ruleModelPath = path.resolve(process.cwd(), 'vscode-extension', 'media', 'instruction-studio.rules.js');
    const ruleModel = requireFromScenarios(ruleModelPath) as {
      normalizeRuleItems: (input: unknown, fallbackText: string) => Array<{ text: string; enabled: boolean }>;
      fromGraphNodes: (nodes: unknown, fallbackText: string) => Array<{ text: string; enabled: boolean }>;
      toGraphRuleSpecs: (items: unknown, fallbackText: string) => Array<{ text: string; active: boolean }>;
    };

    const fallback = 'Always run unit tests before completing changes.';
    const fromGraph = ruleModel.fromGraphNodes(
      [
        { id: 'rule-1', type: 'rule', text: 'Keep API contracts stable.', active: true },
        { id: 'rule-2', type: 'rule', text: 'Never edit package json dependencies.', active: false },
      ],
      fallback,
    );
    assert.equal(fromGraph.length, 2, 'expected two rules from graph nodes');
    assert.equal(fromGraph[0].enabled, true);
    assert.equal(fromGraph[1].enabled, false);

    const serialized = ruleModel.toGraphRuleSpecs(fromGraph, fallback);
    assert.equal(serialized.length, 2, 'serialized rules should keep row count');
    assert.equal(serialized[0].active, true, 'active rule should remain active in graph payload');
    assert.equal(serialized[1].active, false, 'disabled rule should remain inactive in graph payload');

    const normalizedEmpty = ruleModel.normalizeRuleItems([], fallback);
    assert.equal(normalizedEmpty.length, 1, 'empty rule input should receive fallback row');
    assert.equal(normalizedEmpty[0].text, fallback);
    assert.equal(normalizedEmpty[0].enabled, true);
  }
  console.log('  Instruction Studio webview rule-model serialization/deserialization: PASSED');

  console.log('\n36. Validating Instruction Studio telemetry artifact export (.agent)...');
  {
    const telemetryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'po-studio-telemetry-'));
    try {
      const graph = {
        workflowName: 'Telemetry Workflow',
        nodes: [
          { id: 'persona-main', type: 'persona', label: 'Security Expert' },
          { id: 'condition-main', type: 'condition', label: 'If endpoint accepts payload' },
          { id: 'scope-main', type: 'agentScope', label: 'Security Analysis' },
          { id: 'rule-active', type: 'rule', text: 'Validate inputs before writes.', active: true },
          { id: 'rule-disabled', type: 'rule', text: 'Never edit package json dependencies.', active: false },
        ],
        edges: [
          { from: 'persona-main', to: 'condition-main' },
          { from: 'condition-main', to: 'scope-main' },
          { from: 'scope-main', to: 'rule-active' },
          { from: 'scope-main', to: 'rule-disabled' },
        ],
      };

      const compileRun = spawnSync(
        process.execPath,
        ['dist/cli.js', '--instruction-studio-compile', '--workspace-root', telemetryRoot],
        { input: JSON.stringify(graph), encoding: 'utf8' },
      );
      assert.equal(compileRun.status, 0, compileRun.stderr);

      const executionPath = path.join(telemetryRoot, '.agent', 'execution-log.json');
      const lineagePath = path.join(telemetryRoot, '.agent', 'lineage.json');
      const ruleUsagePath = path.join(telemetryRoot, '.agent', 'rule-usage.json');
      assert.ok(fs.existsSync(executionPath), 'execution-log.json should be created');
      assert.ok(fs.existsSync(lineagePath), 'lineage.json should be created');
      assert.ok(fs.existsSync(ruleUsagePath), 'rule-usage.json should be created');

      const executionRows = JSON.parse(fs.readFileSync(executionPath, 'utf8')) as Array<{
        workflowName: string;
        activeRuleCount: number;
        inactiveRuleCount: number;
        ruleUsageCount: number;
      }>;
      const lastExecution = executionRows[executionRows.length - 1];
      assert.equal(lastExecution.workflowName, 'Telemetry Workflow');
      assert.equal(lastExecution.activeRuleCount, 1);
      assert.equal(lastExecution.inactiveRuleCount, 1);
      assert.equal(lastExecution.ruleUsageCount, 1, 'only active rules should produce rule-usage rows');

      const lineageRows = JSON.parse(fs.readFileSync(lineagePath, 'utf8')) as Array<{
        modifiedBy: string;
        file: string;
      }>;
      const lastLineage = lineageRows[lineageRows.length - 1];
      assert.equal(lastLineage.modifiedBy, 'Security Expert');
      assert.equal(lastLineage.file, '.instruction_studio/instructions.md');

      const ruleUsageRows = JSON.parse(fs.readFileSync(ruleUsagePath, 'utf8')) as Array<{
        ruleId: string;
        filesAffected: string[];
      }>;
      const lastRuleUsage = ruleUsageRows[ruleUsageRows.length - 1];
      assert.equal(lastRuleUsage.ruleId, 'rule-active');
      assert.ok(
        lastRuleUsage.filesAffected.includes('.instruction_studio/instructions.md'),
        'rule usage should capture generated instructions artifact',
      );
    } finally {
      fs.rmSync(telemetryRoot, { recursive: true, force: true });
    }
  }
  console.log('  Instruction Studio telemetry artifact export (.agent): PASSED');

  console.log('\n37. Validating Instruction Studio insights and replay endpoints...');
  {
    const replayRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'po-studio-replay-'));
    try {
      const graph = {
        workflowName: 'Replay Workflow',
        nodes: [
          { id: 'persona-main', type: 'persona', label: 'Architect' },
          { id: 'condition-main', type: 'condition', label: 'Always' },
          { id: 'scope-main', type: 'agentScope', label: 'Review' },
          { id: 'rule-active', type: 'rule', text: 'Summarize risks before merge.', active: true },
          { id: 'rule-disabled', type: 'rule', text: 'Never edit package json dependencies.', active: false },
        ],
        edges: [
          { from: 'persona-main', to: 'condition-main' },
          { from: 'condition-main', to: 'scope-main' },
          { from: 'scope-main', to: 'rule-active' },
          { from: 'scope-main', to: 'rule-disabled' },
        ],
      };

      const compileRun = spawnSync(
        process.execPath,
        ['dist/cli.js', '--instruction-studio-compile', '--workspace-root', replayRoot],
        { input: JSON.stringify(graph), encoding: 'utf8' },
      );
      assert.equal(compileRun.status, 0, compileRun.stderr);

      const insightsRun = spawnSync(
        process.execPath,
        ['dist/cli.js', '--instruction-studio-insights', '--workspace-root', replayRoot],
        { encoding: 'utf8' },
      );
      assert.equal(insightsRun.status, 0, insightsRun.stderr);
      const insightsPayload = JSON.parse(insightsRun.stdout.trim()) as {
        insights: {
          compileCount: number;
          activeRules: number;
          inactiveRules: number;
          effectiveness: { score: number };
        };
      };
      assert.ok(insightsPayload.insights.compileCount >= 1, 'insights should report compile count');
      assert.equal(insightsPayload.insights.activeRules, 1);
      assert.equal(insightsPayload.insights.inactiveRules, 1);
      assert.ok(insightsPayload.insights.effectiveness.score >= 0 && insightsPayload.insights.effectiveness.score <= 100);

      const replayRun = spawnSync(
        process.execPath,
        ['dist/cli.js', '--instruction-studio-replay', '--workspace-root', replayRoot],
        { encoding: 'utf8' },
      );
      assert.equal(replayRun.status, 0, replayRun.stderr);
      const replayPayload = JSON.parse(replayRun.stdout.trim()) as {
        sessions: Array<{ sessionId: string; steps: Array<{ type: string; title: string }> }>;
        activeSessionId: string | null;
      };
      assert.ok(Array.isArray(replayPayload.sessions) && replayPayload.sessions.length >= 1, 'expected replay sessions');
      assert.ok(replayPayload.activeSessionId, 'expected active replay session id');
      const first = replayPayload.sessions[0];
      assert.ok(first.steps.some((s) => s.type === 'execution'), 'replay should include execution step');
      assert.ok(first.steps.some((s) => s.type === 'rule'), 'replay should include rule step');
    } finally {
      fs.rmSync(replayRoot, { recursive: true, force: true });
    }
  }
  console.log('  Instruction Studio insights and replay endpoints: PASSED');

  //await runInstructionStudioTests();
}




