import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { PromptProxyEngine } from '../PromptProxyEngine.js';
import { IntelliJPromptProxyAdapter } from '../adapters/IntelliJPromptProxyAdapter.js';
import { VSCodePromptProxyAdapter } from '../adapters/VSCodePromptProxyAdapter.js';
import { PromptOptimizationRequest } from '../contracts.js';
import { assertSchema, buildDemoRequest, resetDatabase } from './harness.js';

export async function runCoreScenarios(dbFile: string): Promise<void> {
  resetDatabase(dbFile);
  const engine = new PromptProxyEngine({ db_path: dbFile });
  await engine.initialize();
  const request = buildDemoRequest();

  console.log('1. Validating core engine request/response contract...');
  const response = await engine.processRequest(request);
  assertSchema(response);
  assert.ok(response.metrics.raw_input_tokens > response.metrics.optimized_input_tokens);
  assert.ok(response.metrics.estimated_output_tokens > 0);
  assert.ok(response.metrics.estimated_cost_usd > 0);
  assert.ok(response.optimized_prompt.includes('# Request'));
  assert.ok(response.optimized_prompt.includes('# src/systemd.ts'));
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
          content: 'Turn 1 [panel]\nPrompt: cost of this token\nOptimized: # Request Cost of this token',
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
  assert.ok(
    memResult.optimized_prompt.includes('Workspace memory — AGENTS.md'),
    `Expected AGENTS.md memory section in optimized prompt. Got:\n${memResult.optimized_prompt}`,
  );
  assert.ok(memResult.optimized_prompt.includes('Always handle errors'), 'Memory content should be inlined');
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
  assert.ok(
    fedResult.optimized_prompt.includes('Peer workspace (peer one)'),
    `Expected peer workspace section in optimized prompt. Got:\n${fedResult.optimized_prompt}`,
  );

  const kg = mainEngine.getKnowledgeGraph();
  assert.ok(kg, 'KG should be available');
  const kgStats = kg!.stats('main-ws');
  assert.ok(kgStats.nodes > 0, 'KG should have harvested nodes after a prompt');
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
  assert.ok(reviewResp.optimized_prompt.startsWith('# Role — Code Reviewer'));
  assert.ok(reviewResp.optimized_prompt.includes('READ-ONLY'));
  assert.ok(reviewResp.optimized_prompt.includes('# Quality checklist'));
  assert.ok(!reviewResp.optimized_prompt.includes('/review'), 'slash trigger must not leak into output');
  assert.ok(
    reviewResp.improvements.some((m) => m.startsWith('Applied SDLC mode')),
    'mode should be surfaced in improvements',
  );

  // Intent words: "fix the bug" → bug-fix mode without explicit trigger.
  const bugResp = await modeEngine.processRequest({
    raw_prompt: 'Please fix the bug where the login button crashes the page',
    workspace_id: 'mode-test',
  });
  assertSchema(bugResp);
  assert.equal(bugResp.sdlc_mode?.id, 'bug-fix');
  assert.equal(bugResp.sdlc_mode?.trigger, null);
  assert.ok(bugResp.optimized_prompt.startsWith('# Role — Bug Fix workflow'));

  // Neutral prompt: no slash, no intent words → no mode applied.
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
  assert.ok(a11yResp.optimized_prompt.startsWith('# Role — Accessibility Auditor'));
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

  // Session 2: brand new engine reading the same DB; without re-injecting the
  // file content we should still get a "previously analyzed" recall section.
  const sess2 = new PromptProxyEngine({ db_path: digestDbFile });
  await sess2.initialize();
  const recallResp = await sess2.processRequest({
    raw_prompt: 'What did we change in auth recently?',
    workspace_id: 'digest-test',
    ide_context: { workspace_root: '/virtual/digest-test' },
  });
  assertSchema(recallResp);
  assert.ok(
    recallResp.optimized_prompt.includes('previously analyzed file: src/api/auth.ts'),
    `Expected cross-session recall hint for studied file. Got:\n${recallResp.optimized_prompt}`,
  );
  assert.ok(
    recallResp.optimized_prompt.includes('verifyJwt'),
    'recall section should include the captured summary',
  );

  // When the file IS re-injected as full content, we must NOT also duplicate
  // it as a recall hint.
  const liveResp = await sess2.processRequest({
    raw_prompt: 'Refactor verifyJwt to accept an options bag',
    workspace_id: 'digest-test',
    ide_context: { workspace_root: '/virtual/digest-test', active_file: studiedFile },
  });
  assertSchema(liveResp);
  assert.ok(
    !liveResp.optimized_prompt.includes('previously analyzed file: src/api/auth.ts'),
    'recall hint must be suppressed when the file is provided as live content',
  );

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
}
