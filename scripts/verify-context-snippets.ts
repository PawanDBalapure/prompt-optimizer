import { PromptProxyEngine } from '../src/PromptProxyEngine.js';
import fs from 'node:fs';
import path from 'node:path';

type Case = {
  name: string;
  prompt: string;
  activeRelPath: string;
  openRelPaths: string[];
};

type IdeFile = { path: string; content: string; language: string };

const ROOT = process.cwd();

function languageFromPath(relPath: string): string {
  const ext = path.extname(relPath).toLowerCase();
  switch (ext) {
    case '.ts':
      return 'ts';
    case '.tsx':
      return 'tsx';
    case '.js':
      return 'js';
    case '.json':
      return 'json';
    case '.md':
      return 'md';
    case '.css':
      return 'css';
    default:
      return '';
  }
}

function readWorkspaceFile(relPath: string): IdeFile {
  const abs = path.join(ROOT, relPath);
  const content = fs.readFileSync(abs, 'utf8');
  return {
    path: relPath.replace(/\\/g, '/'),
    content,
    language: languageFromPath(relPath),
  };
}

function fileExists(relPath: string): boolean {
  return fs.existsSync(path.join(ROOT, relPath));
}

function requireFiles(paths: string[]): void {
  const missing = paths.filter((p) => !fileExists(p));
  if (missing.length > 0) {
    throw new Error(`Missing workspace files required by this test: ${missing.join(', ')}`);
  }
}

const cases: Case[] = [
  {
    name: 'Engine orchestration review',
    prompt: 'Review processRequest orchestration for cache lookup, mode detection, and context packing order. Identify concrete bug risks and propose minimal fixes plus tests.',
    activeRelPath: 'src/PromptProxyEngine.ts',
    openRelPaths: ['src/engine/contextPacker.ts', 'src/engine/promptModes.ts'],
  },
  {
    name: 'Context snippets contract sync',
    prompt: 'Verify context_snippets contract threading between engine and extension, and suggest safe refactors for any mismatch edge cases.',
    activeRelPath: 'src/engine/contextPacker.ts',
    openRelPaths: ['src/contracts.ts', 'vscode-extension/src/commands/openContextFiles.ts'],
  },
  {
    name: 'Mode framing behavior audit',
    prompt: 'Audit explicit slash mode versus intent-detected mode framing behavior, ensuring compact role output for inferred mode and full checklist for explicit review mode.',
    activeRelPath: 'src/engine/promptModes.ts',
    openRelPaths: ['src/PromptProxyEngine.ts', 'src/tests/scenarios.ts'],
  },
  {
    name: 'Schema parity check',
    prompt: 'Check parity between contracts TypeScript and JSON schema for request and response fields and propose exact additions needed for context_snippets compatibility.',
    activeRelPath: 'schemas/contracts.schema.json',
    openRelPaths: ['src/contracts.ts', 'vscode-extension/src/types.ts'],
  },
];

function section(title: string): void {
  console.log(`\n${'='.repeat(88)}`);
  console.log(title);
  console.log('='.repeat(88));
}

async function run(): Promise<void> {
  const required = new Set<string>();
  for (const c of cases) {
    required.add(c.activeRelPath);
    for (const p of c.openRelPaths) { required.add(p); }
  }
  requireFiles(Array.from(required));

  const engine = new PromptProxyEngine({ db_path: ':memory:' });
  await engine.initialize();

  for (const c of cases) {
    section(`CASE: ${c.name}`);
    console.log('PROMPT SENT:');
    console.log(c.prompt);

    const response = await engine.processRequest({
      raw_prompt: c.prompt,
      workspace_id: 'verify-context-snippets',
      ide_context: {
        workspace_root: ROOT.replace(/\\/g, '/'),
        active_file: readWorkspaceFile(c.activeRelPath),
        open_files: c.openRelPaths.map((p) => readWorkspaceFile(p)),
        logs: [
          {
            source: 'Terminal',
            kind: 'terminal',
            content: 'Error: context snippet mismatch in extension highlight flow\nWarning: schema contract drift for response context',
          },
        ],
      },
    });

    console.log('\nSELECTED FILES:');
    console.log(JSON.stringify(response.analysis.context.selected_files, null, 2));

    console.log('\nFILE SELECTION RANGES (context_snippets):');
    console.log(JSON.stringify(response.analysis.context.context_snippets ?? [], null, 2));

    console.log('\nOPTIMIZED OUTPUT:');
    console.log(response.optimized_prompt);

    const hasRanges = (response.analysis.context.context_snippets ?? []).some((s) => s.ranges.length > 0);
    console.log('\nEXPECTATION CHECKS:');
    console.log(`- has selected files: ${response.analysis.context.selected_files.length > 0}`);
    console.log(`- has at least one exact range: ${hasRanges}`);
    console.log(`- output non-empty: ${response.optimized_prompt.trim().length > 0}`);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
