import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import Database from 'better-sqlite3';
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

  // Intent words: "fix the bug" â†’ bug-fix mode without explicit trigger.
  const bugResp = await modeEngine.processRequest({
    raw_prompt: 'Please fix the bug where the login button crashes the page',
    workspace_id: 'mode-test',
  });
  assertSchema(bugResp);
  assert.equal(bugResp.sdlc_mode?.id, 'bug-fix');
  assert.equal(bugResp.sdlc_mode?.trigger, null);
  assert.ok(bugResp.optimized_prompt.startsWith('# Role — Bug Fix workflow'));

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


