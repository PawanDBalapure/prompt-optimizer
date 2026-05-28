import { buildDemoRequest, resetDatabase } from './tests/harness.js';
import {
  runAdapterScenarios,
  runCoreScenarios,
  runRegressionScenarios,
} from './tests/scenarios.js';

async function runDemo(): Promise<void> {
  console.log('========================================================================');
  console.log('LOCAL PROMPT PROXY ENGINE: VERIFICATION HARNESS');
  console.log('========================================================================\n');

  const dbFile = 'prompt_semantic_cache.db';
  const request = buildDemoRequest();

  await runCoreScenarios(dbFile);
  await runAdapterScenarios(dbFile, request);
  await runRegressionScenarios();

  resetDatabase(dbFile);
  console.log('\nAll validations passed.');
}

runDemo().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
