import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  buildInstructionsOverview,
  BuildOverviewOptions,
  InstructionUnit,
  InstructionConflict,
  InstructionPersona,
  PO_OFF_OPEN,
  PO_OFF_CLOSE,
} from '../instructionsManager';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instructions-test-'));
});

afterEach(() => {
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

function writeFile(relPath: string, content: string): string {
  const abs = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return abs;
}

function overview(opts: Partial<BuildOverviewOptions> = {}) {
  return buildInstructionsOverview({
    workspaceRoot: tmpDir,
    ...opts,
  });
}

// ---------------------------------------------------------------------------
// Unit splitting
// ---------------------------------------------------------------------------

describe('unit splitting', () => {
  it('extracts list items and standalone sentences', () => {
    writeFile('.github/copilot-instructions.md', [
      '- Use TypeScript strict mode',
      '  * Prefer const over let',
      '1. Write tests for every public API',
      'Always add JSDoc comments',
      '',
      '# Heading (ignored)',
      '---',
      '```ts',
      'const x = 1;',
      '```',
      '<!-- po-off: Do not use any -->',
    ].join('\n'));

    const o = overview();
    const texts = o.units.map((u) => u.text);
    expect(texts).toContain('Use TypeScript strict mode');
    expect(texts).toContain('Prefer const over let');
    expect(texts).toContain('Write tests for every public API');
    expect(texts).toContain('Always add JSDoc comments');
    // po-off line becomes a disabled unit
    const disabled = o.units.find((u) => u.text === 'Do not use any');
    expect(disabled).toBeDefined();
    expect(disabled!.disabled).toBe(true);
  });

  it('ignores frontmatter', () => {
    writeFile('.github/copilot-instructions.md', [
      '---',
      'title: test',
      '---',
      '- Keep it simple',
    ].join('\n'));

    const o = overview();
    expect(o.units).toHaveLength(1);
    expect(o.units[0].text).toBe('Keep it simple');
  });

  it('skips headings, horizontal rules, and HTML comments', () => {
    writeFile('.github/copilot-instructions.md', [
      '# Section',
      '<!-- regular comment -->',
      '---',
      '- Real rule',
    ].join('\n'));

    const o = overview();
    expect(o.units).toHaveLength(1);
    expect(o.units[0].text).toBe('Real rule');
  });

  it('marks managed units', () => {
    writeFile('.github/copilot-instructions.md', [
      '<!-- BEGIN MANAGED SECTION -->',
      '- Managed rule',
      '<!-- END MANAGED SECTION -->',
      '- Unmanaged rule',
    ].join('\n'));

    const o = overview();
    const managed = o.units.find((u) => u.text === 'Managed rule');
    const unmanaged = o.units.find((u) => u.text === 'Unmanaged rule');
    expect(managed).toBeDefined();
    expect(managed!.managed).toBe(true);
    expect(unmanaged).toBeDefined();
    expect(unmanaged!.managed).toBe(false);
  });

  it('assigns correct line numbers', () => {
    writeFile('.github/copilot-instructions.md', [
      '',
      '- First',
      '',
      '- Second',
    ].join('\n'));

    const o = overview();
    const first = o.units.find((u) => u.text === 'First');
    const second = o.units.find((u) => u.text === 'Second');
    expect(first!.line).toBe(2);
    expect(second!.line).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

describe('normalization', () => {
  it('lowercases and strips punctuation', () => {
    writeFile('.github/copilot-instructions.md', '- Use `const` for variables!');
    const o = overview();
    expect(o.units[0].normalized).toBe('use for variables');
  });

  it('drops inline code', () => {
    writeFile('.github/copilot-instructions.md', '- Prefer `interface` over `type`');
    const o = overview();
    expect(o.units[0].normalized).toBe('prefer over');
  });
});

// ---------------------------------------------------------------------------
// Conflict detection – curated pairs
// ---------------------------------------------------------------------------

describe('conflict detection – curated pairs', () => {
  it('detects verbosity conflict', () => {
    writeFile('.github/copilot-instructions.md', '- Be concise');
    writeFile('.promptoptimizer/memory.md', '- Provide detailed explanations');

    const o = overview();
    expect(o.conflicts).toHaveLength(1);
    const c = o.conflicts[0];
    expect(c.kind).toBe('verbosity');
    expect(c.aText).toContain('concise');
    expect(c.bText).toContain('detailed');
  });

  it('detects indentation style conflict', () => {
    writeFile('.github/copilot-instructions.md', '- Use tabs for indentation');
    writeFile('AGENTS.md', '- Indent with spaces');

    const o = overview();
    expect(o.conflicts).toHaveLength(1);
    expect(o.conflicts[0].kind).toBe('style');
  });

  it('detects quote style conflict', () => {
    writeFile('.github/copilot-instructions.md', '- Use single quotes');
    writeFile('CLAUDE.md', '- Use double quotes');

    const o = overview();
    expect(o.conflicts).toHaveLength(1);
    expect(o.conflicts[0].kind).toBe('style');
  });

  it('detects semicolon policy conflict', () => {
    writeFile('.github/copilot-instructions.md', '- Always semicolons');
    writeFile('.cursorrules', '- No semicolons');

    const o = overview();
    expect(o.conflicts).toHaveLength(1);
    expect(o.conflicts[0].kind).toBe('style');
  });

  it('detects comment directive conflict', () => {
    writeFile('.github/copilot-instructions.md', '- Add comments for complex logic');
    writeFile('AGENTS.md', '- Do not add comments');

    const o = overview();
    expect(o.conflicts).toHaveLength(1);
    expect(o.conflicts[0].kind).toBe('directive');
  });

  it('detects test directive conflict', () => {
    writeFile('.github/copilot-instructions.md', '- Write unit tests');
    writeFile('CLAUDE.md', '- Skip tests');

    const o = overview();
    expect(o.conflicts).toHaveLength(1);
    expect(o.conflicts[0].kind).toBe('directive');
  });
});

// ---------------------------------------------------------------------------
// Conflict detection – polarity flip
// ---------------------------------------------------------------------------

describe('conflict detection – polarity flip', () => {
  it('flags opposite directions on shared content', () => {
    writeFile('.github/copilot-instructions.md', '- Always use TypeScript');
    writeFile('AGENTS.md', '- Never use TypeScript');

    const o = overview();
    expect(o.conflicts).toHaveLength(1);
    expect(o.conflicts[0].kind).toBe('directive');
    expect(o.conflicts[0].reason).toContain('opposite directions');
  });

  it('does not flag unrelated rules', () => {
    writeFile('.github/copilot-instructions.md', '- Always use TypeScript');
    writeFile('AGENTS.md', '- Never commit secrets');

    const o = overview();
    expect(o.conflicts).toHaveLength(0);
  });

  it('ignores managed and disabled units', () => {
    writeFile('.github/copilot-instructions.md', [
      '<!-- BEGIN MANAGED SECTION -->',
      '- Always use TypeScript',
      '<!-- END MANAGED SECTION -->',
    ].join('\n'));
    writeFile('AGENTS.md', '- Never use TypeScript');

    const o = overview();
    // managed unit is excluded from conflict detection
    expect(o.conflicts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Conflict resolution
// ---------------------------------------------------------------------------

describe('conflict resolution', () => {
  it('higher priority source wins', () => {
    writeFile('.github/copilot-instructions.md', '- Be concise');          // priority 1
    writeFile('.promptoptimizer/memory.md', '- Provide detailed output'); // priority 3

    const o = overview();
    expect(o.conflicts).toHaveLength(1);
    const c = o.conflicts[0];
    expect(c.resolution).toContain('wins');
    expect(c.resolution).toContain('copilot-instructions.md');
  });

  it('same priority suggests manual resolution', () => {
    writeFile('AGENTS.md', '- Be concise');
    writeFile('CLAUDE.md', '- Provide detailed output');

    const o = overview();
    expect(o.conflicts).toHaveLength(1);
    expect(o.conflicts[0].resolution).toContain('resolve manually');
  });
});

// ---------------------------------------------------------------------------
// Source collection
// ---------------------------------------------------------------------------

describe('source collection', () => {
  it('includes all fixed sources even when files are missing', () => {
    const o = overview();
    expect(o.sources.length).toBeGreaterThanOrEqual(8);
    const missing = o.sources.filter((s) => !s.exists);
    expect(missing.length).toBeGreaterThan(0);
  });

  it('reports file size and unit count for existing sources', () => {
    writeFile('.github/copilot-instructions.md', '- Rule A\n- Rule B');
    const o = overview();
    const src = o.sources.find((s) => s.id === '.github/copilot-instructions.md');
    expect(src).toBeDefined();
    expect(src!.exists).toBe(true);
    expect(src!.bytes).toBeGreaterThan(0);
    expect(src!.unitCount).toBe(2);
  });

  it('discovers project agent skills', () => {
    writeFile('.promptoptimizer/skills/reviewer.md', '- Review PRs');
    writeFile('.promptoptimizer/skills/tester.md', '- Write tests');

    const o = overview();
    const agentSources = o.sources.filter((s) => s.kind === 'agent');
    expect(agentSources).toHaveLength(2);
    expect(agentSources.map((s) => s.label)).toContain('agent: reviewer');
    expect(agentSources.map((s) => s.label)).toContain('agent: tester');
  });

  it('assigns agent priority 2', () => {
    writeFile('.promptoptimizer/skills/reviewer.md', '- Review PRs');
    const o = overview();
    const agent = o.sources.find((s) => s.kind === 'agent');
    expect(agent!.priority).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Priority order
// ---------------------------------------------------------------------------

describe('priority order', () => {
  it('orders sources by priority then label', () => {
    writeFile('.github/copilot-instructions.md', '- Rule'); // priority 1
    writeFile('.promptoptimizer/skills/reviewer.md', '- Rule'); // priority 2
    writeFile('.promptoptimizer/memory.md', '- Rule'); // priority 3

    const o = overview();
    const ids = o.priorityOrder;
    expect(ids[0]).toBe('.github/copilot-instructions.md');
    // agent and memory both exist; agent has higher priority (2 < 3)
    expect(ids).toContain('.promptoptimizer/skills/reviewer.md');
    expect(ids).toContain('.promptoptimizer/memory.md');
    const agentIdx = ids.indexOf('.promptoptimizer/skills/reviewer.md');
    const memIdx = ids.indexOf('.promptoptimizer/memory.md');
    expect(agentIdx).toBeLessThan(memIdx);
  });

  it('excludes sources with zero units', () => {
    // no files written → all sources have 0 units
    const o = overview();
    expect(o.priorityOrder).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Persona parsing
// ---------------------------------------------------------------------------

describe('persona parsing', () => {
  const personaDir = path.join(tmpDir, 'personas');

  beforeEach(() => {
    fs.mkdirSync(personaDir, { recursive: true });
  });

  function writePersona(fileName: string, content: string) {
    fs.writeFileSync(path.join(personaDir, fileName), content, 'utf8');
  }

  it('parses a valid persona', () => {
    writePersona('code-reviewer.md', [
      '---',
      'id: code-reviewer',
      'label: Code Reviewer',
      'readOnly: false',
      'tags: [review, quality]',
      '---',
      '',
      '# Code Reviewer',
      '',
      'Reviews pull requests for correctness and style.',
    ].join('\n'));

    const o = overview({ personaDir });
    expect(o.personas).toHaveLength(1);
    const p = o.personas[0];
    expect(p.id).toBe('code-reviewer');
    expect(p.label).toBe('Code Reviewer');
    expect(p.description).toContain('Reviews pull requests');
    expect(p.tags).toEqual(['review', 'quality']);
    expect(p.readOnly).toBe(false);
    expect(p.sourceFile).toBe('code-reviewer.md');
    expect(p.relPath).toBe('.promptoptimizer/skills/code-reviewer.md');
    expect(p.enabled).toBe(false);
  });

  it('marks persona as enabled when workspace copy exists', () => {
    writePersona('code-reviewer.md', [
      '---',
      'id: code-reviewer',
      'label: Code Reviewer',
      '---',
      '',
      'Reviews pull requests.',
    ].join('\n'));
    writeFile('.promptoptimizer/skills/code-reviewer.md', 'enabled copy');

    const o = overview({ personaDir });
    expect(o.personas).toHaveLength(1);
    expect(o.personas[0].enabled).toBe(true);
  });

  it('skips personas with invalid id', () => {
    writePersona('bad-id.md', [
      '---',
      'id: Invalid ID!',
      'label: Bad',
      '---',
      '',
      'Should be skipped.',
    ].join('\n'));

    const o = overview({ personaDir });
    expect(o.personas).toHaveLength(0);
  });

  it('handles missing personaDir gracefully', () => {
    const o = overview({ personaDir: '/nonexistent/path' });
    expect(o.personas).toEqual([]);
  });

  it('handles empty personaDir', () => {
    const o = overview({ personaDir });
    expect(o.personas).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Overview metadata
// ---------------------------------------------------------------------------

describe('overview metadata', () => {
  it('computes totalUnits and totalBytes', () => {
    writeFile('.github/copilot-instructions.md', '- Rule A\n- Rule B');
    writeFile('.promptoptimizer/memory.md', '- Rule C');

    const o = overview();
    expect(o.totalUnits).toBe(3);
    expect(o.totalBytes).toBeGreaterThan(0);
  });

  it('sets generatedAt to a recent timestamp', () => {
    const before = Date.now();
    const o = overview();
    const after = Date.now();
    expect(o.generatedAt).toBeGreaterThanOrEqual(before);
    expect(o.generatedAt).toBeLessThanOrEqual(after);
  });

  it('includes workspaceRoot', () => {
    const o = overview();
    expect(o.workspaceRoot).toBe(tmpDir);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('edge cases', () => {
  it('handles empty files', () => {
    writeFile('.github/copilot-instructions.md', '');
    const o = overview();
    const src = o.sources.find((s) => s.id === '.github/copilot-instructions.md');
    expect(src!.unitCount).toBe(0);
    expect(o.units).toHaveLength(0);
  });

  it('handles files with only ignored lines', () => {
    writeFile('.github/copilot-instructions.md', [
      '# Heading',
      '---',
      '```',
      'code',
      '```',
      '<!-- comment -->',
    ].join('\n'));

    const o = overview();
    expect(o.units).toHaveLength(0);
  });

  it('handles po-off with short text (less than 3 chars)', () => {
    writeFile('.github/copilot-instructions.md', '<!-- po-off: ab -->');
    const o = overview();
    expect(o.units).toHaveLength(0);
  });

  it('handles multiple po-off markers', () => {
    writeFile('.github/copilot-instructions.md', [
      '<!-- po-off: Disabled rule one -->',
      '<!-- po-off: Disabled rule two -->',
    ].join('\n'));

    const o = overview();
    const disabled = o.units.filter((u) => u.disabled);
    expect(disabled).toHaveLength(2);
    expect(disabled[0].text).toBe('Disabled rule one');
    expect(disabled[1].text).toBe('Disabled rule two');
  });

  it('does not duplicate conflicts', () => {
    writeFile('.github/copilot-instructions.md', '- Be concise');
    writeFile('.promptoptimizer/memory.md', '- Provide detailed output');
    writeFile('AGENTS.md', '- Provide detailed output');

    const o = overview();
    // Only one conflict pair (copilot vs memory) because copilot vs agents
    // also matches but the pair is already seen.
    expect(o.conflicts.length).toBeGreaterThanOrEqual(1);
    const pairKeys = o.conflicts.map((c) => `${c.aId}|${c.bId}`);
    const unique = new Set(pairKeys);
    expect(unique.size).toBe(pairKeys.length);
  });
});
