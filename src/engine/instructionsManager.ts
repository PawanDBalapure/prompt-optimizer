import * as fs from 'node:fs';
import * as path from 'node:path';

import { MANAGED_BEGIN, MANAGED_END } from './copilotInstructions.js';

/**
 * Instructions Manager — reads every instruction source a workspace exposes to
 * the AI, flattens them into discrete directive "units", ranks them by a
 * priority hierarchy, and detects contradictions between them.
 *
 * This powers the panel's Instructions Manager tab:
 *   - Active instruction viewer  → `sources` + `units`
 *   - Priority hierarchy         → `priorityOrder` + per-source `priority`
 *   - Conflict detection         → `conflicts`
 *   - Project-specific view      → per-source grouping
 *   - Test playground            → client filters `units`/`conflicts` by a prompt
 *
 * Version history, import/export and git authorship are handled in the
 * extension host (they need git + file dialogs); this module is pure file IO
 * so it stays deterministic and unit-testable.
 */

export type InstructionSourceKind = 'copilot' | 'agent' | 'memory';

export interface InstructionUnit {
  /** Stable id: `${sourceId}#${index}`. */
  id: string;
  sourceId: string;
  sourceLabel: string;
  kind: InstructionSourceKind;
  /** Priority of the owning source (1 = highest authority). */
  priority: number;
  /** Original directive text (list marker stripped). */
  text: string;
  /** Lower-cased, punctuation-trimmed form used for conflict matching. */
  normalized: string;
  /** 1-based line number within the source file. */
  line: number;
  /** True when the unit lives inside an auto-managed marker block. */
  managed: boolean;
  /** True when the rule is commented out (deselected) via a po-off marker. */
  disabled: boolean;
}

/**
 * A bundled SDLC "persona" (formerly an agent skill). Personas are whole agent
 * definitions, not directive units, so they live alongside the instruction
 * units. "Enabled" means a workspace copy exists under
 * `.promptoptimizer/skills/<id>.md`.
 */
export interface InstructionPersona {
  id: string;
  label: string;
  description: string;
  tags: string[];
  readOnly: boolean;
  /** Bundled source file name (basename) inside the persona library. */
  sourceFile: string;
  /** Workspace-relative path of the enabled copy (forward slashes). */
  relPath: string;
  enabled: boolean;
}

export interface InstructionSource {
  id: string;
  label: string;
  kind: InstructionSourceKind;
  /** Absolute path on disk. */
  path: string;
  /** Workspace-relative path (forward slashes). */
  relPath: string;
  exists: boolean;
  priority: number;
  bytes: number;
  unitCount: number;
  /** Short reason explaining why this source has the authority it does. */
  authority: string;
}

export type ConflictKind = 'directive' | 'style' | 'verbosity';

export interface InstructionConflict {
  aId: string;
  bId: string;
  aSourceLabel: string;
  bSourceLabel: string;
  aText: string;
  bText: string;
  kind: ConflictKind;
  reason: string;
  /** Which unit wins under the priority hierarchy, and why. */
  resolution: string;
  suggestion: string;
}

export interface InstructionsOverview {
  workspaceRoot: string;
  sources: InstructionSource[];
  units: InstructionUnit[];
  conflicts: InstructionConflict[];
  personas: InstructionPersona[];
  /** Source ids ordered highest → lowest authority. */
  priorityOrder: string[];
  totalUnits: number;
  totalBytes: number;
  generatedAt: number;
}

interface SourceSpec {
  kind: InstructionSourceKind;
  label: string;
  relPath: string;
  priority: number;
  authority: string;
}

/**
 * Priority hierarchy (1 = highest). copilot-instructions.md is loaded by
 * Copilot on EVERY chat turn, so it has the most consistent reach; project
 * agents are next; broad memory files last.
 */
const FIXED_SOURCES: SourceSpec[] = [
  {
    kind: 'copilot',
    label: '.github/copilot-instructions.md',
    relPath: '.github/copilot-instructions.md',
    priority: 1,
    authority: 'Loaded by Copilot on every chat turn — highest, always-on reach.',
  },
  {
    kind: 'memory',
    label: '.promptoptimizer/memory.md',
    relPath: '.promptoptimizer/memory.md',
    priority: 3,
    authority: 'Workspace memory — injected into optimized prompts.',
  },
  {
    kind: 'memory',
    label: '.promptoptimizer/knowledge.md',
    relPath: '.promptoptimizer/knowledge.md',
    priority: 3,
    authority: 'Workspace knowledge notes — injected into optimized prompts.',
  },
  {
    kind: 'memory',
    label: 'AGENTS.md',
    relPath: 'AGENTS.md',
    priority: 4,
    authority: 'Repo-level agent guide — injected when present.',
  },
  {
    kind: 'memory',
    label: 'CLAUDE.md',
    relPath: 'CLAUDE.md',
    priority: 4,
    authority: 'Repo-level assistant guide — injected when present.',
  },
  {
    kind: 'memory',
    label: 'CLAUDE.local.md',
    relPath: 'CLAUDE.local.md',
    priority: 4,
    authority: 'Local assistant overrides — injected when present.',
  },
  {
    kind: 'memory',
    label: '.cursorrules',
    relPath: '.cursorrules',
    priority: 5,
    authority: 'Cursor rules — injected when present.',
  },
  {
    kind: 'memory',
    label: '.clinerules',
    relPath: '.clinerules',
    priority: 5,
    authority: 'Cline rules — injected when present.',
  },
];

/** Project agents live under `.promptoptimizer/skills/*.md`. */
const AGENT_DIR = path.join('.promptoptimizer', 'skills');
const AGENT_PRIORITY = 2;

function toRel(p: string): string {
  return p.split(path.sep).join('/');
}

/**
 * Split a markdown body into directive units. Headings, blank lines, code
 * fences and HTML markers are skipped; list items and standalone sentences
 * become units. Frontmatter (--- … ---) is dropped.
 */
/** Marker that brackets a deselected (commented-out) rule on disk. */
export const PO_OFF_OPEN = '<!-- po-off:';
export const PO_OFF_CLOSE = '-->';
const PO_OFF_RE = /^<!--\s*po-off:\s?([\s\S]*?)\s*-->$/;

function stripMarkers(text: string): string {
  return text
    .replace(/^>\s?/, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/^\d+[.)]\s+/, '')
    .replace(/^\[[ xX]\]\s+/, '')
    .trim();
}

function splitUnits(
  body: string,
): Array<{ text: string; line: number; managed: boolean; disabled: boolean }> {
  const out: Array<{ text: string; line: number; managed: boolean; disabled: boolean }> = [];
  const lines = body.split(/\r?\n/);
  let inFence = false;
  let inFrontmatter = false;
  let managed = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();

    // YAML frontmatter only when it opens on the very first line.
    if (i === 0 && trimmed === '---') { inFrontmatter = true; continue; }
    if (inFrontmatter) {
      if (trimmed === '---') { inFrontmatter = false; }
      continue;
    }

    if (trimmed.startsWith(MANAGED_BEGIN)) { managed = true; continue; }
    if (trimmed.startsWith(MANAGED_END)) { managed = false; continue; }

    if (/^(```|~~~)/.test(trimmed)) { inFence = !inFence; continue; }
    if (inFence) { continue; }

    if (trimmed === '') { continue; }

    // Deselected rule: <!-- po-off: <original line> -->. Surface it as a
    // disabled unit so the UI can re-enable it.
    const offMatch = PO_OFF_RE.exec(trimmed);
    if (offMatch) {
      const inner = stripMarkers(offMatch[1].trim());
      if (inner.length >= 3) {
        out.push({ text: inner, line: i + 1, managed, disabled: true });
      }
      continue;
    }

    if (trimmed.startsWith('#')) { continue; }        // markdown heading
    if (/^<!--/.test(trimmed)) { continue; }          // other HTML comment
    if (/^[-*_]{3,}$/.test(trimmed)) { continue; }     // horizontal rule

    const text = stripMarkers(trimmed);
    if (text.length < 3) { continue; }
    out.push({ text, line: i + 1, managed, disabled: false });
  }
  return out;
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/`[^`]*`/g, ' ')      // drop inline code
    .replace(/[^a-z0-9\s]/g, ' ')  // drop punctuation
    .replace(/\s+/g, ' ')
    .trim();
}

function readSourceUnits(
  spec: { id: string; label: string; kind: InstructionSourceKind; priority: number },
  absPath: string,
): InstructionUnit[] {
  let body: string;
  try {
    body = fs.readFileSync(absPath, 'utf8');
  } catch {
    return [];
  }
  return splitUnits(body).map((u, index) => ({
    id: `${spec.id}#${index}`,
    sourceId: spec.id,
    sourceLabel: spec.label,
    kind: spec.kind,
    priority: spec.priority,
    text: u.text,
    normalized: normalize(u.text),
    line: u.line,
    managed: u.managed,
    disabled: u.disabled,
  }));
}

// ── Conflict detection ───────────────────────────────────────────────────────

/**
 * Curated pairs of mutually-exclusive directive concepts. When two units each
 * match opposite sides of a pair they are flagged as contradictory.
 */
const OPPOSED_PAIRS: Array<{
  kind: ConflictKind;
  a: RegExp;
  b: RegExp;
  reason: string;
  suggestion: string;
}> = [
  {
    kind: 'verbosity',
    a: /\b(concise|brief|terse|short|succinct|minimal|to the point)\b/,
    b: /\b(detailed|verbose|comprehensive|thorough|in depth|exhaustive|elaborate|extensive)\b/,
    reason: 'One rule asks for concise output while another asks for detailed/verbose output.',
    suggestion: 'Pick one default (e.g. "concise by default, expand on request") and remove the other.',
  },
  {
    kind: 'style',
    a: /\b(use tabs|tabs for indentation|indent with tabs)\b/,
    b: /\b(use spaces|spaces for indentation|indent with spaces)\b/,
    reason: 'Indentation style is specified two contradictory ways (tabs vs spaces).',
    suggestion: 'Keep a single indentation rule and let the formatter enforce it.',
  },
  {
    kind: 'style',
    a: /\b(single quotes|use single quote)\b/,
    b: /\b(double quotes|use double quote)\b/,
    reason: 'Quote style is specified two contradictory ways (single vs double).',
    suggestion: 'Keep one quote-style rule (ideally deferred to the linter/formatter).',
  },
  {
    kind: 'style',
    a: /\b(use semicolons|require semicolons|always semicolons)\b/,
    b: /\b(no semicolons|omit semicolons|without semicolons)\b/,
    reason: 'Semicolon policy is specified two contradictory ways.',
    suggestion: 'Keep one semicolon rule and enforce it via the formatter.',
  },
  {
    kind: 'directive',
    a: /\b(add|write|include)\b.*\bcomments?\b/,
    b: /\b(no comments|avoid comments|without comments|do not (add|write|include) comments|don.?t (add|write|include) comments)\b/,
    reason: 'One rule asks to add comments while another forbids comments.',
    suggestion: 'Clarify when comments are wanted (e.g. only for non-obvious logic).',
  },
  {
    kind: 'directive',
    a: /\b(write|add|include)\b.*\b(tests?|unit tests?)\b/,
    b: /\b(no tests|skip tests|without tests|do not (write|add) tests|don.?t (write|add) tests)\b/,
    reason: 'One rule asks to write tests while another says to skip tests.',
    suggestion: 'State the testing expectation once and remove the contradiction.',
  },
];

/** Tokens that flip a directive's polarity (negation/prohibition). */
const NEGATORS = /\b(never|no|not|avoid|don.?t|do not|without|skip|forbid|forbidden|disallow)\b/;
const AFFIRMERS = /\b(always|must|require|enforce|ensure)\b/;

/** Salient verbs/nouns shared between two opposed directives. */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'to', 'of', 'and', 'or', 'for', 'in', 'on', 'with', 'be',
  'is', 'are', 'this', 'that', 'it', 'as', 'at', 'by', 'all', 'any', 'when',
  'should', 'always', 'never', 'must', 'do', 'not', 'no', 'avoid', 'use',
  'using', 'please', 'you', 'your', 'we', 'our', 'them', 'they', 'if', 'then',
]);

function contentTokens(normalized: string): Set<string> {
  const out = new Set<string>();
  for (const tok of normalized.split(' ')) {
    if (tok.length >= 4 && !STOPWORDS.has(tok)) { out.add(tok); }
  }
  return out;
}

function sharesContent(a: Set<string>, b: Set<string>): boolean {
  for (const tok of a) { if (b.has(tok)) { return true; } }
  return false;
}

function detectConflicts(units: InstructionUnit[]): InstructionConflict[] {
  // Conflict detection ignores auto-managed (echoed) units and deselected
  // (commented-out) rules — only rules the model will actually see can clash.
  const active = units.filter((u) => !u.managed && !u.disabled);
  const conflicts: InstructionConflict[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i];
      const b = active[j];
      const conflict = pairConflict(a, b);
      if (!conflict) { continue; }
      const key = `${a.id}|${b.id}`;
      if (seen.has(key)) { continue; }
      seen.add(key);
      conflicts.push(conflict);
    }
  }
  return conflicts;
}

function pairConflict(a: InstructionUnit, b: InstructionUnit): InstructionConflict | null {
  let matched: { kind: ConflictKind; reason: string; suggestion: string } | null = null;

  // 1. Curated opposed concept pairs.
  for (const pair of OPPOSED_PAIRS) {
    const aHasA = pair.a.test(a.normalized);
    const aHasB = pair.b.test(a.normalized);
    const bHasA = pair.a.test(b.normalized);
    const bHasB = pair.b.test(b.normalized);
    if ((aHasA && bHasB) || (aHasB && bHasA)) {
      matched = { kind: pair.kind, reason: pair.reason, suggestion: pair.suggestion };
      break;
    }
  }

  // 2. Polarity flip on shared content (always X vs never X).
  if (!matched) {
    const aNeg = NEGATORS.test(a.normalized);
    const bNeg = NEGATORS.test(b.normalized);
    const aAff = AFFIRMERS.test(a.normalized) || !aNeg;
    const bAff = AFFIRMERS.test(b.normalized) || !bNeg;
    const oppositePolarity = (aNeg && bAff && !bNeg) || (bNeg && aAff && !aNeg);
    if (oppositePolarity && (NEGATORS.test(a.normalized) || NEGATORS.test(b.normalized))) {
      const shared = sharesContent(contentTokens(a.normalized), contentTokens(b.normalized));
      if (shared) {
        matched = {
          kind: 'directive',
          reason: 'These rules give opposite directions about the same thing (one requires it, the other forbids it).',
          suggestion: 'Keep the higher-priority rule and delete or qualify the other.',
        };
      }
    }
  }

  if (!matched) { return null; }

  const winner = a.priority <= b.priority ? a : b;
  const loser = winner === a ? b : a;
  const resolution = winner.priority === loser.priority
    ? `Same priority (${winner.sourceLabel}) — resolve manually; the model may follow either.`
    : `"${winner.sourceLabel}" wins (priority ${winner.priority}) over "${loser.sourceLabel}" (priority ${loser.priority}).`;

  return {
    aId: a.id,
    bId: b.id,
    aSourceLabel: a.sourceLabel,
    bSourceLabel: b.sourceLabel,
    aText: a.text,
    bText: b.text,
    kind: matched.kind,
    reason: matched.reason,
    resolution,
    suggestion: matched.suggestion,
  };
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface BuildOverviewOptions {
  workspaceRoot: string;
  /**
   * Absolute path to the bundled persona (SDLC agent) library. When supplied,
   * each `*.md` becomes a persona whose `enabled` state reflects whether a copy
   * exists under the workspace's `.promptoptimizer/skills/`.
   */
  personaDir?: string;
}

/** Workspace folder where enabled personas are installed as skills. */
const PERSONA_TARGET_DIR = path.join('.promptoptimizer', 'skills');

function parsePersona(libPath: string, fileName: string, workspaceRoot: string): InstructionPersona | null {
  let raw: string;
  try {
    raw = fs.readFileSync(libPath, 'utf8');
  } catch {
    return null;
  }
  const idMatch = /^id:\s*(.+)$/m.exec(raw);
  const labelMatch = /^label:\s*(.+)$/m.exec(raw);
  const roMatch = /^readOnly:\s*(true|false)\s*$/im.exec(raw);
  const tagsMatch = /^tags:\s*\[([^\]]*)\]/m.exec(raw);
  const id = (idMatch?.[1] ?? path.basename(fileName, '.md')).trim();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) { return null; }

  // First non-heading, non-frontmatter paragraph becomes the description.
  let description = '';
  const body = raw.replace(/^---[\s\S]*?\n---\s*/m, '');
  for (const line of body.split(/\r?\n/)) {
    const t = line.trim();
    if (t === '' || t.startsWith('#') || t.startsWith('---')) { continue; }
    description = stripMarkers(t).replace(/\*\*/g, '');
    break;
  }

  const tags = (tagsMatch?.[1] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const rel = path.join(PERSONA_TARGET_DIR, `${id}.md`);
  const enabled = fs.existsSync(path.join(workspaceRoot, rel));

  return {
    id,
    label: (labelMatch?.[1] ?? id).trim(),
    description: description.slice(0, 240),
    tags,
    readOnly: /^true$/i.test(roMatch?.[1] ?? ''),
    sourceFile: fileName,
    relPath: toRel(rel),
    enabled,
  };
}

function readPersonas(personaDir: string | undefined, workspaceRoot: string): InstructionPersona[] {
  if (!personaDir) { return []; }
  let files: string[] = [];
  try {
    files = fs.readdirSync(personaDir).filter((f) => /\.md$/i.test(f)).sort();
  } catch {
    return [];
  }
  const personas: InstructionPersona[] = [];
  for (const file of files) {
    const persona = parsePersona(path.join(personaDir, file), file, workspaceRoot);
    if (persona) { personas.push(persona); }
  }
  return personas;
}

export function buildInstructionsOverview(options: BuildOverviewOptions): InstructionsOverview {
  const root = options.workspaceRoot;
  const sources: InstructionSource[] = [];
  const units: InstructionUnit[] = [];

  const pushSource = (
    id: string,
    label: string,
    kind: InstructionSourceKind,
    priority: number,
    authority: string,
    relPath: string,
  ): void => {
    const absPath = path.join(root, relPath);
    let exists = false;
    let bytes = 0;
    try {
      const stat = fs.statSync(absPath);
      exists = stat.isFile();
      bytes = stat.size;
    } catch {
      exists = false;
    }
    const sourceUnits = exists
      ? readSourceUnits({ id, label, kind, priority }, absPath)
      : [];
    for (const u of sourceUnits) { units.push(u); }
    sources.push({
      id,
      label,
      kind,
      path: absPath,
      relPath: toRel(relPath),
      exists,
      priority,
      bytes,
      unitCount: sourceUnits.length,
      authority,
    });
  };

  // Fixed sources (copilot + memory files).
  for (const spec of FIXED_SOURCES) {
    pushSource(spec.relPath, spec.label, spec.kind, spec.priority, spec.authority, spec.relPath);
  }

  // Project agents: every *.md under .promptoptimizer/skills/.
  const agentDirAbs = path.join(root, AGENT_DIR);
  let agentFiles: string[] = [];
  try {
    agentFiles = fs.readdirSync(agentDirAbs)
      .filter((f) => f.toLowerCase().endsWith('.md'))
      .sort();
  } catch {
    agentFiles = [];
  }
  for (const file of agentFiles) {
    const rel = path.join(AGENT_DIR, file);
    pushSource(
      toRel(rel),
      `agent: ${file.replace(/\.md$/i, '')}`,
      'agent',
      AGENT_PRIORITY,
      'Project agent skill — applied when its mode is selected.',
      rel,
    );
  }

  const conflicts = detectConflicts(units);

  const priorityOrder = [...sources]
    .filter((s) => s.exists && s.unitCount > 0)
    .sort((a, b) => (a.priority - b.priority) || a.label.localeCompare(b.label))
    .map((s) => s.id);

  const totalBytes = sources.reduce((sum, s) => sum + s.bytes, 0);

  return {
    workspaceRoot: root,
    sources,
    units,
    conflicts,
    personas: readPersonas(options.personaDir, root),
    priorityOrder,
    totalUnits: units.length,
    totalBytes,
    generatedAt: Date.now(),
  };
}
