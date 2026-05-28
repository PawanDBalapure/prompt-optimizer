import assert from 'node:assert/strict';
import * as fs from 'fs';
import { PromptOptimizationRequest } from '../contracts.js';

export const METRIC_KEYS = [
  'raw_input_tokens',
  'optimized_input_tokens',
  'tokens_saved',
  'estimated_output_tokens',
  'estimated_cost_usd',
];

export function resetDatabase(dbFile: string): void {
  if (!fs.existsSync(dbFile)) { return; }
  try { fs.unlinkSync(dbFile); } catch { /* file lock — ignore in harness */ }
}

interface OptimizationResponseShape {
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
}

export function assertSchema(payload: unknown): asserts payload is OptimizationResponseShape {
  assert.equal(typeof payload, 'object');
  assert.notEqual(payload, null);

  const response = payload as OptimizationResponseShape;

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

/** Build the canonical demo request used across multiple test scenarios. */
export function buildDemoRequest(): PromptOptimizationRequest {
  const systemdContent = [
    "import fs from 'node:fs';",
    'export function configureService() {',
    "  const restartPolicy = 'always';",
    "  console.log('debug');",
    '  return restartPolicy;',
    '}',
  ].join('\n');

  const systemdSelection = [
    'export function configureService() {',
    "  const restartPolicy = 'always';",
    '  return restartPolicy;',
    '}',
  ].join('\n');

  return {
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
        selection: systemdSelection,
        content: systemdContent,
      },
      open_files: [
        { path: 'src/systemd.ts', language: 'ts', content: systemdContent },
        {
          path: 'src/weather.ts',
          language: 'ts',
          content: ['export function weather() {', "  return 'sunny';", '}'].join('\n'),
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
}
