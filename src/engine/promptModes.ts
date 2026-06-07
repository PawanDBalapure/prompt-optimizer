/**
 * SDLC prompt modes — inspired by the multi-agent-sdlc operating system.
 *
 * Two activation paths:
 *   1. Slash command at the start of the prompt (`/code …`, `/review …`).
 *   2. Intent word fallback (build/create/fix/refactor/test/review/audit/deploy).
 *
 * When a mode is detected we:
 *   - strip the slash command from the raw prompt so it never leaks into the
 *     optimized text,
 *   - prepend a compact `# Role` preface that frames the assistant for the
 *     selected agent,
 *   - append a `# Quality checklist` so the assistant self-verifies before
 *     responding,
 *   - surface the mode label as an improvement suggestion so the panel shows
 *     why the optimized prompt grew.
 *
 * Every payload here is short (< 120 tokens) — the goal is targeted framing,
 * not a verbose manifesto.  Read-only modes (review/security/pr) explicitly
 * forbid file mutations in the role preface.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Built-in SDLC mode IDs.  Custom skills loaded from
 * `.promptoptimizer/skills/*.md` may register additional IDs at runtime; the
 * runtime type is therefore `string`, with this union kept for documentation.
 */
export type SdlcModeId =
  | 'plan'
  | 'arch'
  | 'code'
  | 'test'
  | 'review'
  | 'security'
  | 'qa'
  | 'devops'
  | 'docs'
  | 'pr'
  | 'full'
  | 'bug-fix'
  | 'refactor'
  | string;

export interface SdlcModeDescriptor {
  id: SdlcModeId;
  /** Slash command that triggered the mode, if any (e.g. `/code`). */
  trigger: string | null;
  /** Friendly label surfaced to the user in `improvements`. */
  label: string;
  /** Read-only modes MUST NOT change files. */
  readOnly: boolean;
  /** Role preface prepended to the optimized prompt. */
  rolePreface: string;
  /** Quality checklist appended after the optimized request. */
  checklist: string[];
  /** Origin of the spec — built-in vs. user-authored custom skill. */
  source: 'builtin' | 'workspace' | 'global';
}

interface ModeSpec {
  label: string;
  readOnly: boolean;
  rolePreface: string;
  checklist: string[];
  /** Intent regex(es) — when these match the raw prompt the mode is a candidate. */
  intentPatterns?: RegExp[];
  /** Slash aliases this mode answers to. The mode ID is always an alias. */
  slashAliases?: string[];
  /** Plain-word triggers compiled into word-boundary regexes (case-insensitive). */
  keywords?: string[];
  /** Tokens that MUST all be present in the prompt (case-insensitive). AND semantics. */
  requires?: string[];
  /** Active-file glob patterns (e.g. `*.tsx`, `src/**`). When the active file matches, the mode scores higher. */
  filePatterns?: string[];
  /** Free-form tags surfaced in listings; not used for picking. */
  tags?: string[];
  /** Manual priority bias used in scoring. Default 0. Range -10..+10. */
  priority?: number;
  /** Where the spec came from (built-in / workspace / global override). */
  source?: 'builtin' | 'workspace' | 'global';
}

/**
 * Errors collected while parsing a single skill file.  Tracked so the UI and
 * the `--list-modes` CLI flag can surface them to the user instead of
 * silently dropping the skill.
 */
export interface SkillLoadError {
  filePath: string;
  source: 'workspace' | 'global';
  message: string;
}

const BUILTIN_MODE_SPECS: Record<string, ModeSpec> = {
  plan: {
    label: 'Project Manager (plan)',
    readOnly: false,
    rolePreface:
      'You are the Project Manager. Decompose the request into user stories with explicit, testable acceptance criteria. Call out assumptions and out-of-scope items.',
    checklist: [
      'Every feature is covered by at least one user story.',
      'Every story has at least one objectively verifiable acceptance criterion.',
      'Ambiguous terms are defined or flagged as questions.',
    ],
  },
  arch: {
    label: 'Architect (design)',
    readOnly: false,
    rolePreface:
      'You are the Architect. Produce a minimal viable design: components, interfaces, data model, error handling, and the local/MCP/remote execution boundary. Prefer the simplest design that satisfies the requirements.',
    checklist: [
      'Each requirement maps to a named component.',
      'Data model and public interfaces are explicit.',
      'Trust/execution boundary (local vs MCP vs remote) is stated.',
      'Observability plan (logs/metrics/traces) is mentioned.',
    ],
  },
  code: {
    label: 'Implementer (code)',
    readOnly: false,
    rolePreface:
      'You are the Implementer. Make the smallest change that satisfies the request. No commented-out code, no hardcoded secrets, no unused imports. Follow existing conventions in the workspace.',
    checklist: [
      'Change is minimal and focused on the stated task.',
      'No secrets, dead code, or commented-out blocks remain.',
      'Inputs from untrusted sources are validated.',
      'Build/lint/type checks would pass.',
    ],
  },
  test: {
    label: 'Tester (verify)',
    readOnly: false,
    rolePreface:
      'You are the Tester. Add tests that cover each acceptance criterion, including happy path, edge cases, and at least one regression case. Tests must be deterministic and self-contained.',
    checklist: [
      'Every acceptance criterion has a corresponding test.',
      'Edge cases and at least one regression case are covered.',
      'No tests are skipped without a documented reason.',
      'Tests run deterministically (no time/network/order coupling).',
    ],
  },
  review: {
    label: 'Code Reviewer (read-only)',
    readOnly: true,
    rolePreface:
      'You are the Code Reviewer. READ-ONLY: do not modify files. Report findings only. For each issue, give: severity (critical/major/minor/nit), file:line, impact, and suggested fix.',
    checklist: [
      'Findings are grouped by severity (critical/major/minor/nit).',
      'Each finding cites file and line and proposes a concrete fix.',
      'Architecture drift, if any, is called out explicitly.',
      'Verdict is one of: APPROVE / REQUEST CHANGES / BLOCK.',
    ],
  },
  security: {
    label: 'Security Auditor (read-only)',
    readOnly: true,
    rolePreface:
      'You are the Security Auditor. READ-ONLY: do not modify files. Hunt for OWASP Top 10 risks, secrets, dependency CVEs, untrusted-input handling, and prompt-injection risks in tool outputs.',
    checklist: [
      'OWASP Top 10 categories were considered against the diff.',
      'No hardcoded secrets or credentials remain.',
      'Untrusted inputs (user data, tool outputs) are validated.',
      'Findings are ranked critical/high/medium/low with remediation.',
    ],
  },
  qa: {
    label: 'QA Engineer (validate)',
    readOnly: false,
    rolePreface:
      'You are the QA Engineer. Validate end-to-end against the acceptance criteria. Produce a story-to-scenario matrix and a final verdict: GO, CONDITIONAL GO (with conditions), or NO-GO.',
    checklist: [
      'Every acceptance criterion is mapped to at least one scenario.',
      'Critical user journeys are exercised end-to-end.',
      'Any untested area is labelled with a reason.',
      'Final verdict is GO / CONDITIONAL GO / NO-GO with rationale.',
    ],
  },
  devops: {
    label: 'DevOps (CI/CD)',
    readOnly: false,
    rolePreface:
      'You are the DevOps engineer. Produce CI/CD configuration, container/build files, and deployment scripts appropriate for the detected stack. Prefer least-privilege defaults and reproducible builds.',
    checklist: [
      'Pipeline runs lint, test, and build stages.',
      'Secrets are read from environment / secret store, never committed.',
      'Container/build artifacts are pinned to specific versions.',
      'Failure modes (rollback / retry) are documented.',
    ],
  },
  docs: {
    label: 'Doc Writer',
    readOnly: false,
    rolePreface:
      'You are the Doc Writer. Produce clear, audience-aware documentation. Include purpose, usage examples, configuration, and a "common pitfalls" section. Keep tone factual and concise.',
    checklist: [
      'Purpose and intended audience are stated.',
      'At least one runnable usage example is included.',
      'Configuration options are listed with defaults.',
      'Common pitfalls / FAQ section is present.',
    ],
  },
  pr: {
    label: 'PR Review (read-only: review + security)',
    readOnly: true,
    rolePreface:
      'You are performing a full pull-request review. READ-ONLY: do not modify files. Combine code-review findings (quality, correctness, design) and security-audit findings (vulns, secrets, dependencies) into a single ranked report.',
    checklist: [
      'Code-review findings and security findings are merged and de-duplicated.',
      'Each finding has severity, file:line, impact, and suggested fix.',
      'Final verdict: APPROVE / REQUEST CHANGES / BLOCK with rationale.',
      'High-risk or destructive changes are flagged for human approval.',
    ],
  },
  full: {
    label: 'Full SDLC (PM → Arch → Impl → Test → Review → Security → QA → DevOps → Docs)',
    readOnly: false,
    rolePreface:
      'You are the SDLC Orchestrator. Plan a full delivery: requirements → architecture → implementation → tests → review → security → QA → devops → docs. PAUSE for human approval after architecture and after security. Use compact handoffs: {agent, outcome, files, issues}.',
    checklist: [
      'Plan lists every agent, their output artifact, and the gate type.',
      'Architecture and security gates explicitly pause for human approval.',
      'Each phase ends with a compact handoff summary.',
      'Token budget is respected (~30K total for full SDLC).',
    ],
  },
  'bug-fix': {
    label: 'Bug Fix workflow',
    readOnly: false,
    rolePreface:
      'You are running the bug-fix workflow (PM → Implementer → Tester). First reproduce the bug and identify the root cause. Then apply the minimal fix. Then add a regression test that fails before the fix and passes after.',
    checklist: [
      'Root cause is identified, not just symptoms.',
      'Fix is minimal and scoped to the root cause.',
      'A regression test is added that exercises the bug.',
      'Existing test suite still passes.',
    ],
  },
  refactor: {
    label: 'Refactor workflow',
    readOnly: false,
    rolePreface:
      'You are running the refactor workflow (Arch → Impl → Test → Review). Change structure without changing observable behaviour. Preserve all public APIs and test outcomes. State the motivation and the smallest viable refactor step.',
    checklist: [
      'Public APIs and observable behaviour are preserved.',
      'Existing tests still pass without modification (unless they tested internals).',
      'Refactor is broken into the smallest viable step.',
      'Motivation (readability, performance, decoupling) is stated.',
    ],
  },
};

const BUILTIN_SLASH_ALIASES: Record<string, SdlcModeId> = {
  plan: 'plan',
  arch: 'arch',
  architect: 'arch',
  architecture: 'arch',
  code: 'code',
  impl: 'code',
  implement: 'code',
  test: 'test',
  tests: 'test',
  review: 'review',
  security: 'security',
  audit: 'security',
  qa: 'qa',
  devops: 'devops',
  ci: 'devops',
  docs: 'docs',
  doc: 'docs',
  pr: 'pr',
  full: 'full',
  sdlc: 'full',
  fix: 'bug-fix',
  bug: 'bug-fix',
  bugfix: 'bug-fix',
  refactor: 'refactor',
};

const BUILTIN_INTENT_RULES: Array<{ pattern: RegExp; mode: SdlcModeId }> = [
  { pattern: /\b(bug|defect|broken|crash|stack ?trace|reproduce|regression)\b/i, mode: 'bug-fix' },
  { pattern: /\brefactor(?:ing)?\b/i, mode: 'refactor' },
  { pattern: /\b(security|vulnerab|cve|owasp|exploit|sanitiz|injection)\b/i, mode: 'security' },
  { pattern: /\b(review|critique|inspect)\b/i, mode: 'review' },
  { pattern: /\b(test|unit test|integration test|coverage)\b/i, mode: 'test' },
  { pattern: /\b(architect|architecture|design (?:the|a) (?:system|module|api))\b/i, mode: 'arch' },
  { pattern: /\b(deploy|ci\/cd|pipeline|dockerfile|github actions)\b/i, mode: 'devops' },
  { pattern: /\b(document|documentation|readme|api docs?)\b/i, mode: 'docs' },
  { pattern: /\b(plan|user stor(?:y|ies)|acceptance criteri)/i, mode: 'plan' },
  { pattern: /\b(implement|build|create|add (?:a |an )?(?:feature|endpoint|component|function|class))\b/i, mode: 'code' },
];

// -----------------------------------------------------------------------------
// Custom skills loader
// -----------------------------------------------------------------------------

/**
 * Each loaded skill file is cached by its mtimeMs so edits hot-reload on the
 * next prompt without restarting the engine.  Keyed by absolute file path.
 */
interface CachedSkillFile {
  mtimeMs: number;
  spec: ModeSpec;
  id: string;
}

const SKILL_CACHE = new Map<string, CachedSkillFile>();
const SKILL_ERRORS = new Map<string, SkillLoadError>();
let LAST_RESOLVED_DIR_SIGNATURE = '';
let CACHED_MERGED: {
  specs: Map<string, ModeSpec>;
  slashAliases: Map<string, string>;
  intentRules: Array<{ pattern: RegExp; mode: string }>;
} | null = null;

/**
 * Resolve all skill directories we will scan, in order of precedence
 * (later directories override earlier ones for the same skill id):
 *   1. Built-ins (always present, lowest precedence)
 *   2. Global user dir (`$PROMPT_OPTIMIZER_SKILLS_DIR`)
 *   3. Workspace dir (`<workspace_root>/.promptoptimizer/skills`)
 */
function resolveSkillDirs(workspaceRoot?: string): Array<{ dir: string; source: 'workspace' | 'global' }> {
  const dirs: Array<{ dir: string; source: 'workspace' | 'global' }> = [];
  const global = process.env.PROMPT_OPTIMIZER_SKILLS_DIR;
  if (global && global.trim() !== '') {
    dirs.push({ dir: global, source: 'global' });
  }
  if (workspaceRoot && workspaceRoot.trim() !== '') {
    dirs.push({ dir: path.join(workspaceRoot, '.promptoptimizer', 'skills'), source: 'workspace' });
  }
  return dirs;
}

// ---------------------------------------------------------------------------
// Tolerant frontmatter parser
// ---------------------------------------------------------------------------
//
// Accepts a YAML-ish subset that covers the realistic shapes a skill file
// uses, while staying small and dependency-free:
//   - `# comments` and blank lines anywhere in the frontmatter
//   - `key: value` scalars (quoted or unquoted, with embedded `#` allowed
//     when quoted)
//   - inline arrays `key: [a, "b, c", 'd']`
//   - block lists:
//         key:
//           - one
//           - "two"
//   - block scalars: `key: |` followed by indented lines
//   - quoted strings supporting `\n`, `\t`, `\"`, `\'`, `\\` escapes
//   - BOM tolerance, CRLF tolerance
//
// Returns `{ scalars, lists, blocks }` where blocks are multi-line strings.
interface ParsedFrontmatter {
  scalars: Record<string, string>;
  lists: Record<string, string[]>;
  blocks: Record<string, string>;
}

function parseFrontmatter(front: string): ParsedFrontmatter {
  const scalars: Record<string, string> = {};
  const lists: Record<string, string[]> = {};
  const blocks: Record<string, string> = {};
  const lines = front.replace(/^\uFEFF/, '').split(/\r?\n/);

  let i = 0;
  let currentList: string | null = null;
  let currentListIndent = -1;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    // Skip pure-comment / blank lines (but they end an open list).
    if (trimmed === '' || trimmed.startsWith('#')) {
      currentList = null;
      currentListIndent = -1;
      i++;
      continue;
    }

    const indent = line.length - line.trimStart().length;

    // Block-list item continuation.
    if (currentList) {
      const item = /^\s*-\s+(.*)$/.exec(line);
      if (item && indent > currentListIndent) {
        lists[currentList].push(parseScalarValue(item[1]));
        i++;
        continue;
      }
      currentList = null;
      currentListIndent = -1;
    }

    const kv = /^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) { i++; continue; }
    const key = kv[1];
    let value = kv[2];
    // Strip trailing comment on unquoted values.
    if (!/^["'[|]/.test(value)) {
      const hash = value.indexOf(' #');
      if (hash >= 0) { value = value.slice(0, hash).trimEnd(); }
    }

    // Block scalar: `key: |`
    if (value === '|' || value === '|-' || value === '>') {
      const blockLines: string[] = [];
      let j = i + 1;
      let blockIndent = -1;
      while (j < lines.length) {
        const bl = lines[j];
        if (bl.trim() === '') { blockLines.push(''); j++; continue; }
        const bi = bl.length - bl.trimStart().length;
        if (blockIndent === -1) { blockIndent = bi; }
        if (bi < blockIndent) { break; }
        blockLines.push(bl.slice(blockIndent));
        j++;
      }
      blocks[key] = blockLines.join(value === '>' ? ' ' : '\n').replace(/\n+$/, '');
      i = j;
      continue;
    }

    if (value === '') {
      // Opens a block list on the following lines.
      lists[key] = [];
      currentList = key;
      currentListIndent = indent;
      i++;
      continue;
    }

    if (value.startsWith('[') && value.endsWith(']')) {
      lists[key] = splitInlineArray(value.slice(1, -1));
      i++;
      continue;
    }

    scalars[key] = parseScalarValue(value);
    i++;
  }

  return { scalars, lists, blocks };
}

function splitInlineArray(body: string): string[] {
  const out: string[] = [];
  let buf = '';
  let inSingle = false;
  let inDouble = false;
  let escape = false;
  for (const ch of body) {
    if (escape) { buf += ch; escape = false; continue; }
    if (ch === '\\' && (inSingle || inDouble)) { buf += ch; escape = true; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; buf += ch; continue; }
    if (ch === "'" && !inDouble) { inSingle = !inSingle; buf += ch; continue; }
    if (ch === ',' && !inSingle && !inDouble) {
      const v = parseScalarValue(buf.trim());
      if (v !== '') { out.push(v); }
      buf = '';
      continue;
    }
    buf += ch;
  }
  const tail = parseScalarValue(buf.trim());
  if (tail !== '') { out.push(tail); }
  return out;
}

function parseScalarValue(raw: string): string {
  const v = raw.trim();
  if (v === '') { return ''; }
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
    return unescapeDoubleQuoted(v.slice(1, -1));
  }
  if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) {
    // single-quoted: only '' is an escape for ', no backslash escapes.
    return v.slice(1, -1).replace(/''/g, "'");
  }
  return v;
}

function unescapeDoubleQuoted(s: string): string {
  return s.replace(/\\(.)/g, (_, ch: string) => {
    switch (ch) {
      case 'n': return '\n';
      case 't': return '\t';
      case 'r': return '\r';
      case '"': return '"';
      case "'": return "'";
      case '\\': return '\\';
      // Preserve unknown escapes (e.g. regex tokens \b, \d, \w, \s) so users
      // can paste regex source straight into a quoted frontmatter string.
      default: return '\\' + ch;
    }
  });
}

// ---------------------------------------------------------------------------
// Skill file parser
// ---------------------------------------------------------------------------

class SkillParseError extends Error {}

/**
 * Parse a single skill file.  Tolerant of formatting; throws SkillParseError
 * only for fatal problems (no frontmatter, no id resolvable).  Soft issues
 * (bad regex, empty checklist) are silently dropped so the rest of the file
 * still works.
 */
function parseSkillFile(filePath: string, source: 'workspace' | 'global'): CachedSkillFile {
  let raw = fs.readFileSync(filePath, 'utf8');
  if (raw.charCodeAt(0) === 0xFEFF) { raw = raw.slice(1); }

  const frontmatterMatch = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!frontmatterMatch) {
    throw new SkillParseError('missing or malformed YAML frontmatter (expected `---` fences)');
  }
  const { scalars, lists, blocks } = parseFrontmatter(frontmatterMatch[1]);
  const body = frontmatterMatch[2];

  const fallbackId = path
    .basename(filePath)
    .replace(/\.(md|markdown)$/i, '')
    .replace(/\.(example|template|sample)$/i, '')
    .toLowerCase();
  const id = (scalars.id ?? fallbackId).trim();
  if (!id) {
    throw new SkillParseError('cannot derive a skill id (set `id:` in frontmatter)');
  }
  if (!/^[a-z][a-z0-9_-]*$/.test(id)) {
    throw new SkillParseError(`invalid id "${id}" (lowercase letters, digits, _ or - only)`);
  }

  const label = (scalars.label ?? id).trim();

  // Role preface: frontmatter `rolePreface:` (or `role:`) wins over body prose.
  const checklistHeaderRe = /(^|\n)##\s+(Checklist|Quality Checklist|Quality checklist)\s*\n([\s\S]*?)(\n##\s+|$)/i;
  const checklistMatch = checklistHeaderRe.exec(body);
  const bodyPreface = (checklistMatch ? body.slice(0, checklistMatch.index) : body).trim();
  const rolePreface = (blocks.rolePreface ?? blocks.role ?? scalars.rolePreface ?? scalars.role ?? bodyPreface ?? '').trim()
    || `You are operating in the ${label} role.`;

  // Checklist: frontmatter array wins over body bullets.
  const frontChecklist = lists.checklist ?? [];
  const bodyChecklist = (checklistMatch ? checklistMatch[3] : '')
    .split(/\r?\n/)
    .map((l) => /^\s*-\s+(.*)$/.exec(l)?.[1].trim())
    .filter((l): l is string => !!l && l !== '');
  const checklist = dedupePreserveOrder(
    (frontChecklist.length > 0 ? frontChecklist : bodyChecklist).slice(0, 20),
  );

  // Regex lists: drop invalid entries silently.
  const compileRegexList = (src: string[] | undefined): RegExp[] =>
    (src ?? []).flatMap((p) => {
      try { return [new RegExp(p, 'i')]; } catch { return []; }
    });

  // Keywords -> word-boundary regexes.
  const keywords = (lists.keywords ?? []).map((k) => k.trim()).filter((k) => k !== '');
  const keywordRegexes = keywords.map((k) => {
    const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\b`, 'i');
  });

  // requires: AND-tokens (lowercased presence check).
  const requires = (lists.requires ?? []).map((r) => r.trim().toLowerCase()).filter((r) => r !== '');

  // filePatterns: keep raw glob strings; matched at picking time.
  const filePatterns = (lists.filePatterns ?? lists.activeFilePatterns ?? [])
    .map((p) => p.trim()).filter((p) => p !== '');

  const tags = (lists.tags ?? []).map((t) => t.trim()).filter((t) => t !== '');

  const priorityRaw = parseInt(scalars.priority ?? '', 10);
  const priority = Number.isFinite(priorityRaw) ? clamp(priorityRaw, -10, 10) : 0;

  const slashAliases = (lists.slashAliases ?? lists.aliases ?? [])
    .map((s) => s.toLowerCase().replace(/^\//, '').trim())
    .filter((s) => /^[a-z][a-z0-9_-]*$/.test(s));

  const intentPatterns = [
    ...compileRegexList(lists.intentPatterns),
    ...keywordRegexes,
  ];
  // Stash requires + filePatterns inside the spec via separate fields below.
  const spec: ModeSpec = {
    label,
    readOnly: parseBool(scalars.readOnly ?? scalars.readonly),
    rolePreface,
    checklist,
    intentPatterns: intentPatterns.length > 0 ? intentPatterns : undefined,
    slashAliases,
    keywords,
    requires: requires.length > 0 ? requires : undefined,
    filePatterns: filePatterns.length > 0 ? filePatterns : undefined,
    tags: tags.length > 0 ? tags : undefined,
    priority,
    source,
  };

  return { id, spec, mtimeMs: fs.statSync(filePath).mtimeMs };
}

function parseBool(value: string | undefined): boolean {
  return /^(true|yes|on|1)$/i.test((value ?? '').trim());
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function dedupePreserveOrder(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const key = item.trim();
    if (key === '' || seen.has(key.toLowerCase())) { continue; }
    seen.add(key.toLowerCase());
    out.push(key);
  }
  return out;
}

/**
 * Convert a shell-style glob (e.g. `*.tsx`, `src/**`, `?at`) to a RegExp.
 * Forward + back slashes match either separator so Windows paths work
 * without the caller having to normalize.
 */
function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++; }
      else { re += '[^/\\\\]*'; }
    } else if (c === '?') { re += '[^/\\\\]'; }
    else if (c === '/' || c === '\\') { re += '[\\\\/]'; }
    else if ('.+^${}()|[]'.includes(c)) { re += '\\' + c; }
    else { re += c; }
  }
  return new RegExp(`(^|[\\\\/])${re}$`, 'i');
}

/**
 * Walk all configured skill directories, refresh the per-file cache by
 * mtime, and return the merged registry (built-ins overlaid with custom).
 *
 * Cheap fast-path: if no skill directories changed since the last call and
 * every cached file's mtime is unchanged, return the memoised merged map.
 */
function loadMergedRegistry(workspaceRoot?: string): {
  specs: Map<string, ModeSpec>;
  slashAliases: Map<string, string>;
  intentRules: Array<{ pattern: RegExp; mode: string }>;
} {
  const dirs = resolveSkillDirs(workspaceRoot);
  const dirSignature = dirs.map((d) => `${d.source}:${d.dir}`).join('|');

  // Detect new/removed files by listing the dirs every call (cheap) and
  // re-parsing only files whose mtime changed.
  const discovered: Array<{ filePath: string; source: 'workspace' | 'global' }> = [];
  for (const { dir, source } of dirs) {
    let entries: string[] = [];
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      if (!/\.(md|markdown)$/i.test(name)) { continue; }
      if (/\.(example|template|sample)\.(md|markdown)$/i.test(name)) { continue; }
      discovered.push({ filePath: path.join(dir, name), source });
    }
  }

  let changed = dirSignature !== LAST_RESOLVED_DIR_SIGNATURE;
  const seen = new Set<string>();
  for (const { filePath, source } of discovered) {
    seen.add(filePath);
    let stat: fs.Stats;
    try { stat = fs.statSync(filePath); } catch { continue; }
    const cached = SKILL_CACHE.get(filePath);
    const prevError = SKILL_ERRORS.get(filePath);
    if (cached && cached.mtimeMs === stat.mtimeMs && !prevError) { continue; }
    try {
      const parsed = parseSkillFile(filePath, source);
      SKILL_CACHE.set(filePath, parsed);
      if (SKILL_ERRORS.delete(filePath)) { changed = true; }
      changed = true;
    } catch (err) {
      // Drop any previously cached version of this file and remember the error.
      if (SKILL_CACHE.delete(filePath)) { changed = true; }
      const message = err instanceof Error ? err.message : String(err);
      SKILL_ERRORS.set(filePath, { filePath, source, message });
      changed = true;
    }
  }
  // Evict cache entries for files that disappeared.
  for (const key of Array.from(SKILL_CACHE.keys())) {
    if (!seen.has(key)) { SKILL_CACHE.delete(key); changed = true; }
  }
  for (const key of Array.from(SKILL_ERRORS.keys())) {
    if (!seen.has(key)) { SKILL_ERRORS.delete(key); changed = true; }
  }
  LAST_RESOLVED_DIR_SIGNATURE = dirSignature;

  if (!changed && CACHED_MERGED) { return CACHED_MERGED; }

  // Build merged registry: built-ins first, then global, then workspace
  // (later overrides earlier for matching ids).
  const specs = new Map<string, ModeSpec>();
  for (const [id, spec] of Object.entries(BUILTIN_MODE_SPECS)) {
    // Attach matching built-in intent rules as the spec's intentPatterns so
    // the scoring picker can evaluate built-in modes uniformly with custom skills.
    const builtinIntents = BUILTIN_INTENT_RULES
      .filter((r) => r.mode === id)
      .map((r) => r.pattern);
    specs.set(id, {
      ...spec,
      intentPatterns: builtinIntents.length > 0 ? builtinIntents : spec.intentPatterns,
      source: 'builtin',
    });
  }
  const byPrecedence: Array<'global' | 'workspace'> = ['global', 'workspace'];
  for (const source of byPrecedence) {
    for (const file of SKILL_CACHE.values()) {
      if (file.spec.source !== source) { continue; }
      specs.set(file.id, file.spec);
    }
  }

  // Build slash alias and intent maps from the merged spec set.
  const slashAliases = new Map<string, string>();
  for (const [alias, id] of Object.entries(BUILTIN_SLASH_ALIASES)) {
    slashAliases.set(alias.toLowerCase(), id);
  }
  for (const [id, spec] of specs) {
    slashAliases.set(id.toLowerCase(), id);
    for (const alias of spec.slashAliases ?? []) {
      slashAliases.set(alias.toLowerCase(), id);
    }
  }

  const intentRules: Array<{ pattern: RegExp; mode: string }> = [];
  for (const [id, spec] of specs) {
    for (const pattern of spec.intentPatterns ?? []) {
      intentRules.push({ pattern, mode: id });
    }
  }
  // Built-in intent rules come last so user-defined intents win on overlap.
  for (const rule of BUILTIN_INTENT_RULES) {
    if (specs.has(rule.mode)) { intentRules.push(rule); }
  }

  CACHED_MERGED = { specs, slashAliases, intentRules };
  return CACHED_MERGED;
}

/**
 * List every mode currently registered, including custom skills.  Useful for
 * UI surfaces (panel, command palette) that want to render available modes.
 */
export interface RegisteredMode {
  id: string;
  label: string;
  readOnly: boolean;
  source: 'builtin' | 'workspace' | 'global';
  slashAliases: string[];
  keywords: string[];
  filePatterns: string[];
  tags: string[];
  priority: number;
}
export function listRegisteredModes(workspaceRoot?: string): RegisteredMode[] {
  const reg = loadMergedRegistry(workspaceRoot);
  const result: RegisteredMode[] = [];
  for (const [id, spec] of reg.specs) {
    const aliases = new Set<string>();
    aliases.add(id);
    for (const [alias, target] of reg.slashAliases) {
      if (target === id) { aliases.add(alias); }
    }
    result.push({
      id,
      label: spec.label,
      readOnly: spec.readOnly,
      source: spec.source ?? 'builtin',
      slashAliases: Array.from(aliases).sort(),
      keywords: spec.keywords ?? [],
      filePatterns: spec.filePatterns ?? [],
      tags: spec.tags ?? [],
      priority: spec.priority ?? 0,
    });
  }
  return result.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Errors collected the last time the registry was refreshed.  Call after
 * `listRegisteredModes` / `detectMode` to surface them in the UI.
 */
export function listSkillErrors(workspaceRoot?: string): SkillLoadError[] {
  loadMergedRegistry(workspaceRoot);
  return Array.from(SKILL_ERRORS.values())
    .sort((a, b) => a.filePath.localeCompare(b.filePath));
}

/** Test-only: drop the in-memory caches so tests can reload from disk. */
export function _resetSkillCacheForTests(): void {
  SKILL_CACHE.clear();
  SKILL_ERRORS.clear();
  CACHED_MERGED = null;
  LAST_RESOLVED_DIR_SIGNATURE = '';
}

export interface DetectModeOptions {
  workspaceRoot?: string;
  /** Active file path used for `filePatterns` matching. */
  activeFilePath?: string;
  /** Open file paths used as a weaker signal for `filePatterns` matching. */
  openFilePaths?: string[];
}

export interface DetectModeResult {
  mode: SdlcModeDescriptor | null;
  /** Raw prompt with slash command (if any) stripped from the front. */
  cleanedPrompt: string;
  /** Top-N scored candidates (excluding slash short-circuits). For diagnostics. */
  candidates?: Array<{ id: string; score: number; reasons: string[] }>;
}

/**
 * Detect the SDLC mode from a raw user prompt.
 *
 * Decision order:
 *   1. Slash command at the start of the prompt always wins.
 *   2. Otherwise score every candidate spec and pick the highest non-zero
 *      score.  Scoring inputs:
 *        - intent pattern hits           × 3
 *        - keyword hits                   × 2
 *        - active-file `filePatterns` hit × 4
 *        - open-file  `filePatterns` hit  × 1
 *        - `priority` bias                + raw value
 *      A spec is disqualified if any `requires` token is missing.
 *      Built-in priority bias of +1 keeps built-ins above otherwise-tied
 *      no-op custom skills, but a single hit on a custom skill outscores it.
 *   3. When no spec scores above 0 we return `null` so the engine falls back
 *      to its normal optimisation path.
 */
export function detectMode(rawPrompt: string, options: DetectModeOptions = {}): DetectModeResult {
  const reg = loadMergedRegistry(options.workspaceRoot);
  const trimmed = rawPrompt.trimStart();

  const slashMatch = /^\/([a-zA-Z][a-zA-Z0-9_-]*)\b\s*/.exec(trimmed);
  if (slashMatch) {
    const alias = slashMatch[1].toLowerCase();
    const id = reg.slashAliases.get(alias);
    if (id && reg.specs.has(id)) {
      const cleaned = trimmed.slice(slashMatch[0].length).trimStart();
      return {
        mode: buildDescriptor(id, reg.specs.get(id)!, `/${alias}`),
        cleanedPrompt: cleaned === '' ? rawPrompt : cleaned,
      };
    }
  }

  const lowerPrompt = rawPrompt.toLowerCase();
  const activePath = options.activeFilePath ?? '';
  const openPaths = options.openFilePaths ?? [];

  type Scored = { id: string; score: number; reasons: string[]; spec: ModeSpec };
  const scored: Scored[] = [];

  for (const [id, spec] of reg.specs) {
    // requires gate.
    if (spec.requires && spec.requires.length > 0) {
      const missing = spec.requires.find((tok) => !lowerPrompt.includes(tok));
      if (missing) { continue; }
    }

    let score = 0;
    const reasons: string[] = [];

    // intent + keyword hits.
    let intentHits = 0;
    let keywordHits = 0;
    const keywordCount = (spec.keywords ?? []).length;
    for (const pattern of spec.intentPatterns ?? []) {
      if (pattern.test(rawPrompt)) {
        // The keyword regexes appended last share order with `keywords`; we
        // count keyword vs intent by index so weights stay correct.
        const idx = (spec.intentPatterns ?? []).indexOf(pattern);
        const total = (spec.intentPatterns ?? []).length;
        if (idx >= total - keywordCount) { keywordHits++; }
        else { intentHits++; }
      }
    }
    if (intentHits > 0) { score += intentHits * 3; reasons.push(`intent×${intentHits}`); }
    if (keywordHits > 0) { score += keywordHits * 2; reasons.push(`keyword×${keywordHits}`); }

    // file pattern hits.
    if (spec.filePatterns && spec.filePatterns.length > 0) {
      const compiled = spec.filePatterns.map(globToRegExp);
      if (activePath && compiled.some((r) => r.test(activePath))) {
        score += 4;
        reasons.push('activeFile');
      } else {
        const openHit = openPaths.some((p) => compiled.some((r) => r.test(p)));
        if (openHit) { score += 1; reasons.push('openFile'); }
      }
    }

    // priority bias.
    const bias = spec.priority ?? 0;
    if (bias !== 0) { score += bias; reasons.push(`priority${bias > 0 ? '+' : ''}${bias}`); }

    if (score > 0) { scored.push({ id, score, reasons, spec }); }
  }

  if (scored.length === 0) {
    return { mode: null, cleanedPrompt: rawPrompt, candidates: [] };
  }

  // Tie-break: higher score > higher priority > workspace > global > builtin.
  const sourceRank: Record<string, number> = { workspace: 3, global: 2, builtin: 1 };
  scored.sort((a, b) => {
    if (b.score !== a.score) { return b.score - a.score; }
    const pa = a.spec.priority ?? 0;
    const pb = b.spec.priority ?? 0;
    if (pb !== pa) { return pb - pa; }
    return (sourceRank[b.spec.source ?? 'builtin'] ?? 0)
      - (sourceRank[a.spec.source ?? 'builtin'] ?? 0);
  });

  const top = scored[0];
  return {
    mode: buildDescriptor(top.id, top.spec, null),
    cleanedPrompt: rawPrompt,
    candidates: scored.slice(0, 5).map(({ id, score, reasons }) => ({ id, score, reasons })),
  };
}

function buildDescriptor(id: string, spec: ModeSpec, trigger: string | null): SdlcModeDescriptor {
  return {
    id,
    trigger,
    label: spec.label,
    readOnly: spec.readOnly,
    rolePreface: spec.rolePreface,
    checklist: spec.checklist.slice(),
    source: spec.source ?? 'builtin',
  };
}

/**
 * Render the role preface block (`# Role`) prepended to the optimized prompt.
 *
 * @param compact When true, emit only the single role-label line and omit the
 *   verbose role-preface paragraph. Used for intent-detected modes, where the
 *   user has not explicitly opted into a heavyweight workflow persona, so the
 *   repeated boilerplate paragraph would just inflate tokens.
 */
export function renderRoleSection(mode: SdlcModeDescriptor, compact = false): string {
  const readOnlyLine = mode.readOnly ? ' (READ-ONLY — do not modify files)' : '';
  if (compact) {
    return `role: >\n  ${mode.label}${readOnlyLine}`;
  }
  return `role: >\n  ${mode.label}${readOnlyLine}\n  ${mode.rolePreface.replace(/\n/g, '\n  ')}`;
}

/**
 * Render the quality checklist appended to the optimized prompt.
 */
export function renderChecklistSection(mode: SdlcModeDescriptor): string {
  const bullets = mode.checklist.map((item) => `  - "${item.replace(/"/g, '\\"')}"`).join('\n');
  return `quality_checklist:\n${bullets}`;
}


/**
 * Friendly improvement-line label so the panel surfaces why the optimized
 * prompt grew (e.g. "Applied SDLC mode: Implementer (code) [/code].").
 */
export function describeMode(mode: SdlcModeDescriptor): string {
  const suffix = mode.trigger ? ` [${mode.trigger}]` : ' (intent-detected)';
  return `Applied SDLC mode: ${mode.label}${suffix}.`;
}
