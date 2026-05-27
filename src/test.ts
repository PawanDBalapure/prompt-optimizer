import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'fs';
import { PromptProxyEngine } from './PromptProxyEngine.js';
import { IntelliJPromptProxyAdapter } from './adapters/IntelliJPromptProxyAdapter.js';
import { VSCodePromptProxyAdapter } from './adapters/VSCodePromptProxyAdapter.js';
import { PromptOptimizationRequest } from './contracts.js';

const METRIC_KEYS = [
  'raw_input_tokens',
  'optimized_input_tokens',
  'tokens_saved',
  'estimated_output_tokens',
  'estimated_cost_usd',
];

function resetDatabase(dbFile: string): void {
  if (!fs.existsSync(dbFile)) {
    return;
  }

  try {
    fs.unlinkSync(dbFile);
  } catch {
    // Ignore file lock errors in the demo harness.
  }
}

function assertSchema(payload: unknown): asserts payload is {
  metrics: Record<string, number>;
  optimized_prompt: string;
  improvements: string[];
  analysis: {
    cache: {
      status: string;
      confidence: number;
      candidates: Array<{ raw_prompt: string; confidence: number; timestamp: number }>;
    };
    context: {
      selected_files: string[];
      selected_logs: string[];
      log_sources: string[];
      open_file_count: number;
      total_log_count: number;
    };
    cost: {
      input_cost_usd: number;
      output_cost_usd: number;
      total_cost_usd: number;
      input_cost_per_1k_tokens: number;
      output_cost_per_1k_tokens: number;
    };
  };
} {
  assert.equal(typeof payload, 'object');
  assert.notEqual(payload, null);

  const response = payload as {
    metrics: Record<string, number>;
    optimized_prompt: string;
    improvements: string[];
    analysis: {
      cache: {
        status: string;
        confidence: number;
        candidates: Array<{ raw_prompt: string; confidence: number; timestamp: number }>;
      };
      context: {
        selected_files: string[];
        selected_logs: string[];
        log_sources: string[];
        open_file_count: number;
        total_log_count: number;
      };
      cost: {
        input_cost_usd: number;
        output_cost_usd: number;
        total_cost_usd: number;
        input_cost_per_1k_tokens: number;
        output_cost_per_1k_tokens: number;
      };
    };
  };

  assert.deepEqual(Object.keys(response.metrics), METRIC_KEYS);
  assert.equal(typeof response.optimized_prompt, 'string');
  assert.ok(Array.isArray(response.improvements));
  assert.ok(response.improvements.length >= 1 && response.improvements.length <= 2);
  assert.ok(['exact', 'semantic', 'miss'].includes(response.analysis.cache.status));
  assert.equal(typeof response.analysis.cache.confidence, 'number');
  assert.ok(Array.isArray(response.analysis.cache.candidates));
  assert.ok(Array.isArray(response.analysis.context.selected_files));
  assert.ok(Array.isArray(response.analysis.context.selected_logs));
  assert.ok(Array.isArray(response.analysis.context.log_sources));
  assert.equal(typeof response.analysis.context.open_file_count, 'number');
  assert.equal(typeof response.analysis.context.total_log_count, 'number');
  assert.equal(typeof response.analysis.cost.input_cost_usd, 'number');
  assert.equal(typeof response.analysis.cost.output_cost_usd, 'number');
  assert.equal(typeof response.analysis.cost.total_cost_usd, 'number');
}

async function runDemo(): Promise<void> {
  console.log('========================================================================');
  console.log('LOCAL PROMPT PROXY ENGINE: VERIFICATION HARNESS');
  console.log('========================================================================\n');

  const dbFile = 'prompt_semantic_cache.db';
  resetDatabase(dbFile);

  const engine = new PromptProxyEngine({ db_path: dbFile });
  await engine.initialize();

  const request: PromptOptimizationRequest = {
    raw_prompt: [
      'Please please can you explain how to fix the restart policy issue in this service setup.',
      'Please please can you explain how to fix the restart policy issue in this service setup.',
      'Keep the code syntax unchanged.',
      '```ts',
      'const restart = true;',
      'const restart = true;',
      '```',
    ].join('\n'),
    ide_context: {
      workspace_root: 'C:/workspace/demo',
      active_file: {
        path: 'src/systemd.ts',
        language: 'ts',
        is_active: true,
        selection: [
          'export function configureService() {',
          "  const restartPolicy = 'always';",
          '  return restartPolicy;',
          '}',
        ].join('\n'),
        content: [
          "import fs from 'node:fs';",
          'export function configureService() {',
          "  const restartPolicy = 'always';",
          "  console.log('debug');",
          '  return restartPolicy;',
          '}',
        ].join('\n'),
      },
      open_files: [
        {
          path: 'src/systemd.ts',
          language: 'ts',
          content: [
            "import fs from 'node:fs';",
            'export function configureService() {',
            "  const restartPolicy = 'always';",
            "  console.log('debug');",
            '  return restartPolicy;',
            '}',
          ].join('\n'),
        },
        {
          path: 'src/weather.ts',
          language: 'ts',
          content: [
            'export function weather() {',
            "  return 'sunny';",
            '}',
          ].join('\n'),
        },
      ],
      logs: [
        {
          source: 'Terminal',
          kind: 'terminal',
          content: [
            'INFO booting service',
            'ERROR service restart failed',
            'ERROR service restart failed',
            'stack trace line 1',
          ].join('\n'),
        },
      ],
    },
  };

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
  assert.equal((response.optimized_prompt.match(/const restart = true;/g) ?? []).length, 2);
  console.log(JSON.stringify(response, null, 2));

  console.log('\n2. Validating cache reuse does not zero pricing forecasts...');
  const cachedResponse = await engine.processRequest(request);
  assertSchema(cachedResponse);
  assert.ok(cachedResponse.metrics.estimated_cost_usd > 0);
  assert.equal(cachedResponse.optimized_prompt, response.optimized_prompt);
  assert.equal(cachedResponse.analysis.cache.status, 'exact');

  console.log('\n3. Validating VS Code adapter...');
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
    visible_editors: [
      {
        path: 'src/systemd.ts',
        content: request.ide_context!.active_file!.content,
        selection: request.ide_context!.active_file!.selection,
        language_id: 'ts',
        is_active: true,
      },
    ],
    terminal_output: ['ERROR restart failed'],
    problems: ['systemd.ts:3 restart policy mismatch'],
  });
  assertSchema(vscodeResponse);
  vscodeAdapter.close();

  console.log('\n4. Validating IntelliJ adapter...');
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
    open_editors: [
      {
        path: 'src/systemd.ts',
        content: request.ide_context!.active_file!.content,
        selection: request.ide_context!.active_file!.selection,
        language: 'ts',
        is_active: true,
      },
    ],
    run_console: ['ERROR restart failed'],
    inspection_messages: ['systemd.ts:3 restart policy mismatch'],
  });
  assertSchema(intellijResponse);
  intellijAdapter.close();

  console.log('\n5. Validating CLI sidecar output...');
  const cliResult = spawnSync(process.execPath, ['dist/cli.js', '--stdin', '--db', dbFile], {
    input: JSON.stringify(request),
    encoding: 'utf8',
  });
  assert.equal(cliResult.status, 0, cliResult.stderr);
  const cliResponse = JSON.parse(cliResult.stdout.trim()) as unknown;
  assertSchema(cliResponse);

  engine.close();
  console.log('\nAll validations passed.');
}

runDemo().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});