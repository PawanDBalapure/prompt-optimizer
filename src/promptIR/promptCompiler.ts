import { PromptIR, PromptCompilerSpec } from '../contracts.js';
import { correctSpelling } from '../engine/textOptimizer.js';

/**
 * Compiler-style prompt pipeline.
 *
 *   Raw Prompt → Intent Extraction → Requirement Extraction → Rule Generation
 *   → Ambiguity Detection → Noise Removal → Compression → Structured Output
 *
 * The goal is to behave like a compiler rather than a paraphraser: subjective
 * adjectives become measurable requirements, soft preferences become hard
 * rules, conversational filler is removed, duplicate concepts are collapsed,
 * and the result is emitted into a fixed, deterministic schema.
 *
 * Model-family-specific framing rules live in compiler.ts and are left
 * untouched — this module only produces the shared structured body.
 */

/* ------------------------------------------------------------------ */
/* Lexicons                                                            */
/* ------------------------------------------------------------------ */

/**
 * The non-informative stack summary `inferRepoStack` returns when no workspace
 * (or no recognised stack) is present. It carries zero signal, so it is never
 * emitted as a `context:` line — doing so only wastes tokens and misleads.
 */
const GENERIC_CONTEXT = 'Standard codebase structure';

/** Subjective adjective → measurable requirement (ambiguity resolution). */
const REQUIREMENT_LEXICON: Array<{ test: RegExp; requirement: string }> = [
  { test: /\bmodern\b/i, requirement: 'Use a current, consistent design system: system font stack, an 8px spacing scale, and responsive breakpoints' },
  { test: /\b(nice|beautiful|pretty|good[- ]looking|stylish|elegant|sleek|clean)\b/i, requirement: 'Apply a clear visual hierarchy: at most 2 font families, a defined color palette, and a consistent 8px spacing grid' },
  { test: /\b(fast|quick|snappy|performant|speedy)\b/i, requirement: 'Meet a performance budget: First Contentful Paint < 1.5s and total JS payload < 200KB gzipped' },
  { test: /\bresponsive\b/i, requirement: 'Layout adapts at 360px, 768px, and 1280px breakpoints with no horizontal scroll' },
  { test: /\b(easy to use|user[- ]friendly|intuitive|simple to use)\b/i, requirement: 'Primary action reachable within 2 interactions; all interactive controls carry visible labels' },
  { test: /\b(secure|safe)\b/i, requirement: 'Validate and sanitize all inputs, keep secrets out of client code, and use parameterized queries' },
  { test: /\b(accessible|a11y)\b/i, requirement: 'Meet WCAG 2.1 AA: contrast >= 4.5:1, full keyboard navigation, and alt text on all images' },
  { test: /\bscalable\b/i, requirement: 'Keep handlers stateless and avoid per-request global mutation' },
  { test: /\b(robust|reliable|stable)\b/i, requirement: 'Handle and surface all error states; no unhandled exceptions or promise rejections' },
  { test: /\b(efficient|optimi[sz]ed|performance[- ]critical)\b/i, requirement: 'Avoid O(n^2) work on user-sized data and memoize repeated computations' },
  { test: /\b(professional|polished)\b/i, requirement: 'Ship consistent typography and an aligned layout grid with no placeholder/lorem content' },
  { test: /\b(minimal|lightweight|barebones)\b/i, requirement: 'Avoid extra dependencies; use the smallest viable implementation' },
  { test: /\b(maintainable|clean code|well[- ]structured|readable)\b/i, requirement: 'Keep functions <= 40 lines, no dead code, and named constants instead of magic numbers' },
];

/** Vague terms with no measurable mapping — surfaced for clarification. */
const VAGUE_UNMAPPED = /\b(good|great|better|best|cool|awesome|powerful|smart|flexible|seamless|amazing|perfect|premium|high[- ]quality|next[- ]gen|cutting[- ]edge|state[- ]of[- ]the[- ]art)\b/gi;

/** Conversational filler removed during noise removal. */
const NOISE_PATTERNS: RegExp[] = [
  /\b(please|kindly|thanks|thank you|cheers)\b/gi,
  /\b(i (?:want|need|would like|was wondering if you (?:could|can))|can you|could you|would you|will you|i'?d like you to|i'?m trying to|help me|let'?s|let me)\b/gi,
  /\b(just|basically|simply|actually|really|kind of|sort of|you know|i guess|i think|maybe|perhaps)\b/gi,
  /\b(for me|if possible|when you get a chance|at your convenience|as soon as possible|asap)\b/gi,
];

const NEGATIVE_MARKER = /\b(never|no longer|do not|don'?t|avoid|without|exclude|must not|should not|shouldn'?t|cannot|can'?t|not use)\b/i;
const RULE_MARKER = /\b(must|always|only|require|ensure|make sure|need to|has to|have to|shall)\b/i;
const PREFERENCE_MARKER = /\b(should|prefer|preferably|ideally|would like|i'?d like|try to|nice to have|would be (?:nice|good)|hopefully)\b/i;
const MEASURABLE_MARKER = /(\b\d+(?:\.\d+)?\s*(?:px|ms|s|kb|mb|gb|%|x|seconds?|minutes?|hours?|chars?|characters?|words?|tokens?|lines?|columns?|rows?|items?|files?)?\b|[<>]=?|\b(?:at least|at most|no more than|no fewer than|up to|within|exactly|maximum|minimum|max|min)\b)/i;

/* ------------------------------------------------------------------ */
/* Public API                                                         */
/* ------------------------------------------------------------------ */

/** Runs the full compiler pipeline over a raw prompt + base IR. */
export function buildCompilerSpec(rawPrompt: string, ir: PromptIR): PromptCompilerSpec {
  const seen = new Set<string>();
  const requirements: string[] = [];
  const rules: string[] = [];
  const exclusions: string[] = [];

  // 1. Intent extraction.
  const intent = extractIntent(rawPrompt, ir);

  // 2 + 4. Requirement extraction (adjective → metric) and ambiguity detection.
  for (const entry of REQUIREMENT_LEXICON) {
    if (entry.test.test(rawPrompt)) {
      pushUnique(requirements, entry.requirement, seen);
    }
  }
  const vague = collectUnmappedVagueTerms(rawPrompt);
  if (vague.length > 0) {
    pushUnique(
      requirements,
      `Replace the subjective term${vague.length === 1 ? '' : 's'} ${vague.map((t) => `"${t}"`).join(', ')} with concrete, measurable targets`,
      seen,
    );
  }

  // 3 + 5 + 6. Classify directives into rules / exclusions / measurable
  // requirements, hardening preferences and collapsing duplicate concepts.
  const candidates = [...ir.constraints, ...splitSentences(rawPrompt)];
  for (const candidate of candidates) {
    const cleaned = stripNoise(candidate);
    if (cleaned.length < 4) { continue; }
    if (NEGATIVE_MARKER.test(cleaned)) {
      pushUnique(exclusions, toExclusion(cleaned), seen);
    } else if (RULE_MARKER.test(cleaned) || PREFERENCE_MARKER.test(cleaned)) {
      pushUnique(rules, hardenRule(cleaned), seen);
    } else if (MEASURABLE_MARKER.test(cleaned)) {
      pushUnique(requirements, cleaned, seen);
    }
  }

  // Noise removal for the canonical input statement, then condense it into a
  // short imperative task line (questions → "Locate/Explain …", verbs kept).
  const input = synthesizeTask(rawPrompt, ir, intent);

  // Output format + success criteria.
  const output_format = inferOutputFormat(ir, intent.output);
  const success_criteria = buildSuccessCriteria(ir);

  return {
    intent,
    input,
    requirements,
    rules,
    exclusions,
    output_format,
    success_criteria,
    task_kind: ir.inferred_task_type ?? 'general',
  };
}

/**
 * Renders a spec into a high-density, credit-optimized YAML block.
 *
 * The schema is intentionally minimal — `context`, `task`, `constraints` —
 * with no empty-section placeholders, no folded scalars, and no boilerplate
 * success-criteria. Every line carries signal; empty sections are omitted
 * entirely. Standing output-discipline constraints are appended so the model
 * suppresses preamble/sign-offs (the real credit cost lives in the response).
 */
export function renderStructuredSpec(
  spec: PromptCompilerSpec,
  contextValue: string,
  density: 'rich' | 'lean' = 'rich',
): string {
  const lines: string[] = [];
  const task = (spec.input || spec.intent.task || 'Execute the user request.').trim();
  const kind = spec.task_kind ?? 'general';

  if (density === 'lean') {
    // Minimal: task + one combined output-discipline constraint. The context
    // line and metric expansions are dropped for maximum token savings.
    lines.push(`task: ${yamlInline(task)}`);
    lines.push('constraints:');
    lines.push(`  - ${yamlInline(leanDiscipline(kind))}`);
    return lines.join('\n').trim();
  }

  const ctx = (contextValue ?? '').trim();
  if (ctx !== '' && ctx !== '[CONTEXT]' && ctx !== GENERIC_CONTEXT) {
    lines.push(`context: ${yamlInline(ctx)}`);
  }

  lines.push(`task: ${yamlInline(task)}`);

  const constraints = buildConstraints(spec, task);
  lines.push('constraints:');
  for (const c of constraints) { lines.push(`  - ${yamlInline(c)}`); }

  return lines.join('\n').trim();
}

/** Single combined output-discipline line used by lean mode. */
function leanDiscipline(kind: NonNullable<PromptCompilerSpec['task_kind']>): string {
  switch (kind) {
    case 'coding': return 'Output: code/diff only; no preamble or sign-offs.';
    case 'debugging': return 'Output: root cause + minimal diff only; no preamble.';
    case 'research': return 'Output: code/path deliverables only; no preamble or sign-offs.';
    case 'spec-writing': return 'Output: structured spec only; no preamble.';
    default: return 'Output: deliverable only; no preamble or sign-offs.';
  }
}

/** Quote a scalar on one line, collapsing whitespace and escaping quotes. */
function yamlInline(value: string): string {
  const one = (value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
  return `"${one}"`;
}

/** Normalised comparison key for de-duplication / containment checks. */
function constraintKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Significant-word token set (drops short stop-ish words). */
function tokenSet(value: string): Set<string> {
  return new Set(constraintKey(value).split(' ').filter((w) => w.length > 2));
}

/** Jaccard overlap between two token sets (0 = disjoint, 1 = identical). */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) { return 0; }
  let inter = 0;
  for (const w of a) { if (b.has(w)) { inter++; } }
  return inter / (a.size + b.size - inter);
}

/**
 * Merge requirements + rules + exclusions into one deduped, grammar-cleaned
 * list, drop items that merely restate the task or each other, cap the
 * user-derived items, and append the standing output-discipline constraints.
 */
function buildConstraints(spec: PromptCompilerSpec, task: string): string[] {
  const items: string[] = [];
  const seen = new Set<string>();
  const taskKey = constraintKey(task);
  const taskTokens = tokenSet(task);
  const acceptedTokens: Array<Set<string>> = [];

  const add = (raw: string): void => {
    const cleaned = cleanConstraint(raw);
    if (cleaned === '') { return; }
    const key = constraintKey(cleaned);
    if (key.length < 4 || seen.has(key)) { return; }
    // Drop anything that just restates the task (substring or heavy overlap).
    const tokens = tokenSet(cleaned);
    if (taskKey.length > 4 && (taskKey.includes(key) || key.includes(taskKey))) { return; }
    if (jaccard(tokens, taskTokens) >= 0.6) { return; }
    // Drop near-duplicates of an already-accepted constraint.
    if (acceptedTokens.some((t) => jaccard(tokens, t) >= 0.7)) { return; }
    seen.add(key);
    acceptedTokens.push(tokens);
    items.push(cleaned);
  };

  for (const r of spec.requirements) { add(r); }
  for (const r of spec.rules) { add(r); }
  for (const r of spec.exclusions) { add(r); }

  const capped = items.slice(0, 6);
  capped.push(outputDiscipline(spec.task_kind ?? 'general'));
  capped.push('No conversational filler, preamble, or sign-offs.');
  return capped;
}

/** Light grammar cleanup so merged directives read as standalone rules. */
function cleanConstraint(value: string): string {
  let t = (value ?? '').trim();
  if (t === '') { return ''; }
  // Strip stranded pronoun fragments left by noise removal ("you to …").
  t = t.replace(/^(?:you|me|us|i|we)\s+to\s+/i, '');
  t = t.replace(/^(?:you|me|us|i|we)\s+/i, '');
  // "MUST the pipeline is fast" → "Ensure the pipeline is fast".
  t = t.replace(/\bMUST\s+the\b/g, 'Ensure the');
  t = t.replace(/\s{2,}/g, ' ').replace(/[.;,\s]+$/, '').trim();
  if (t === '') { return ''; }
  return capitalize(t) + '.';
}

/** Task-family-specific output discipline (suppresses verbose responses). */
function outputDiscipline(kind: NonNullable<PromptCompilerSpec['task_kind']>): string {
  switch (kind) {
    case 'coding': return 'Output: code/diff deliverables only.';
    case 'debugging': return 'Output: root cause + minimal diff fix only.';
    case 'research': return 'Output: code/path deliverables only.';
    case 'spec-writing': return 'Output: structured spec only, every item testable.';
    default: return 'Output: deliverable only — no restating the request.';
  }
}

/* ------------------------------------------------------------------ */
/* Pipeline stages                                                    */
/* ------------------------------------------------------------------ */

function extractIntent(rawPrompt: string, ir: PromptIR): PromptCompilerSpec['intent'] {
  const lower = rawPrompt.toLowerCase();
  const taskLabel = ir.inferred_task_type ? ir.inferred_task_type.replace(/-/g, ' ') : 'general';

  const verbMatch = lower.match(
    /\b(build|create|make|write|implement|develop|design|fix|debug|refactor|add|generate|optimi[sz]e|review|explain|compare|analy[sz]e|set up|configure|update|migrate)\b\s+([a-z0-9][\w \-/]{2,60})/,
  );
  const action = verbMatch ? `${verbMatch[1]} ${verbMatch[2]}`.replace(/[.,;].*$/, '').trim() : '';

  let domain = '';
  const forMatch = rawPrompt.match(/\bfor (?:a|an|my|the)\s+([A-Za-z0-9][\w \-]{2,40})/i);
  if (forMatch) { domain = forMatch[1].replace(/[.,;].*$/, '').trim(); }

  const output = detectDeliverable(lower);
  const task = capitalize(action || `${taskLabel} task`);
  return { task, domain, output };
}

/**
 * Condense the raw prompt into a single imperative task line. Questions about
 * where/what a symbol is become "Locate/Explain …"; everything else uses the
 * first few normalized sentences (newlines merged to spaces) with filler,
 * pronouns, and politeness stripped (original case preserved so identifiers
 * like `CI` survive), then clamped on a word boundary.
 */
function synthesizeTask(rawPrompt: string, ir: PromptIR, intent: PromptCompilerSpec['intent']): string {
  const lower = rawPrompt.toLowerCase();
  const subj = detectSubject(rawPrompt);
  const subject = subj.text;
  const normalizedPrompt = rawPrompt.replace(/\r?\n+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  const leadingSentences = dedupeSentences(splitSentences(normalizedPrompt)).slice(0, 3);

  const asksWhere = /\b(where (?:is|are|can i find)|located|location of)\b/.test(lower);
  const asksWhat = /\b(what (?:does|is|are|do)|purpose of|what's)\b/.test(lower);
  const asksHow = /\bhow (?:does|do|is|are)\b/.test(lower);
  const asksWhy = /\bwhy (?:does|do|is|are|did)\b/.test(lower);
  const isQuestionOnlyPrompt = leadingSentences.length <= 1;

  if (isQuestionOnlyPrompt && subject !== '' && (asksWhere || asksWhat || asksHow || asksWhy)) {
    const scopeFile = detectScopeFile(rawPrompt, subject);
    const inScope = scopeFile === '' ? ' within the repository' : ` in ${scopeFile}`;
    // Backtick genuine code identifiers; describe plain phrases in prose.
    const label = subj.code ? `\`${subject}\`` : `the ${subject}`;
    if (asksWhere && (asksWhat || asksHow || asksWhy)) {
      return `Locate and explain the purpose of ${label}${inScope}.`;
    }
    if (asksWhere) { return `Locate ${label}${inScope}.`; }
    return `Explain the purpose of ${label}${inScope}.`;
  }

  // Normalize multiline prompts to one flow so task synthesis preserves
  // combined intent instead of collapsing to a single question line.
  const leadingSentencesText = leadingSentences.join(' ');
  let t = stripLeadingFiller(stripNoise(leadingSentencesText || normalizedPrompt));
  if (t.length < 4) { t = stripLeadingFiller(stripNoise(normalizedPrompt)); }
  if (t.length < 4) { t = ensureSentence(intent.task); }
  // Drop a stranded "<verb> me/us" object ("Build me a page" → "Build a page").
  t = t.replace(/^(\w+)\s+(?:me|us)\s+/i, '$1 ');
  t = correctSpelling(t);
  t = clampWords(t, 160);
  return ensureSentence(capitalize(t));
}

/** Remove leading politeness/indirection so the task reads as an imperative. */
function stripLeadingFiller(text: string): string {
  let t = text.trim();
  let prev: string;
  do {
    prev = t;
    t = t.replace(/^(?:you|me|us|i|we)\s+to\s+/i, '');
    t = t.replace(/^(?:you|me|us|i|we)\s+/i, '');
    t = t.replace(
      /^(?:walk me through how to|walk me through|tell me how to|show me how to|help me to|help me|let me|let's|how to|to)\s+/i,
      '',
    );
    t = t.replace(/^(?:please|kindly|so|then|now)\s+/i, '');
    t = t.replace(/^[\s,.;:-]+/, '');
  } while (t !== prev);
  return t.trim();
}

/** Clamp to a maximum length without cutting a word in half. */
function clampWords(text: string, max: number): string {
  if (text.length <= max) { return text; }
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trim();
}

/** A question's subject: either a concrete code identifier (`code: true`,
 *  rendered in backticks) or a natural-language noun phrase (`code: false`). */
interface SubjectMatch { text: string; code: boolean; }

/** Best-effort extraction of the subject a question is about. */
function detectSubject(raw: string): SubjectMatch {
  const backticked = raw.match(/`([^`]+)`/);
  if (backticked) { return { text: backticked[1].trim(), code: true }; }

  // Everything after the interrogative verb is the subject region, e.g.
  // "what does X do in Y" → "X do in Y". We first look for a concrete code
  // symbol there (so "buildModeItems" wins over the containing file); only
  // when none exists do we fall back to the plain noun phrase the user typed
  // (so "the promt proxy engine file" is described, not reduced to `promt`).
  const region =
    raw.match(/\b(?:what|how|why)\s+(?:does|do|did|is|are|can|should|would)\s+(.+)/i)?.[1]
    ?? raw.match(/\bwhere\s+(?:is|are|can i find)\s+(.+)/i)?.[1]
    ?? raw.match(/\bpurpose of\s+(.+)/i)?.[1];

  if (region) {
    const codeToken =
      region.match(/\b([A-Za-z0-9]+(?:_[A-Za-z0-9]+)+)\b/)?.[1]          // snake_case
      ?? region.match(/\b([a-z]+[A-Z][A-Za-z0-9]*)\b/)?.[1]             // camelCase
      ?? region.match(/\b([A-Z][a-z]+[A-Z][A-Za-z0-9]*)\b/)?.[1]        // PascalCase
      ?? region.match(/\b([A-Za-z0-9_\-/]+\.[A-Za-z0-9]{1,6})\b/)?.[1]; // filename
    if (codeToken && !GENERIC_SUBJECT.test(codeToken)) {
      return { text: codeToken, code: true };
    }

    let phrase = region
      .replace(/^(?:the|a|an)\s+/i, '')
      .replace(/\s+(?:does|do|did|work|works|working|is|are|in|inside|within|from|of|for)\b.*$/i, '')
      .replace(/[.,;:?!]+$/, '')
      .trim();
    phrase = phrase.split(/\s+/).slice(0, 6).join(' ');
    if (phrase !== '' && !GENERIC_SUBJECT.test(phrase)) {
      return { text: phrase, code: false };
    }
  }

  const camel = raw.match(/\b([a-z]+[A-Z][A-Za-z0-9]+|[A-Z][a-z]+[A-Z][A-Za-z0-9]+)\b/);
  if (camel) { return { text: camel[1], code: true }; }
  const file = raw.match(/\b([A-Za-z0-9_\-/]+\.[A-Za-z0-9]{1,6})\b/);
  if (file) { return { text: file[1], code: true }; }
  return { text: '', code: false };
}

/** Low-signal nouns that should never be treated as a question's subject. */
const GENERIC_SUBJECT = /^(this|that|it|the|code|file|files|function|method|thing|stuff|part|line|lines|here|there)$/i;

/** A filename the prompt scopes the subject to, e.g. the `extension.ts` in
 *  "...in extension.ts". Returns '' when absent or identical to the subject. */
function detectScopeFile(raw: string, subject: string): string {
  const inFile = raw.match(/\b(?:in|inside|within|from|of)\s+(?:the\s+|file\s+)?([A-Za-z0-9_\-/]+\.[A-Za-z0-9]{1,6})\b/i);
  const file = inFile?.[1] ?? raw.match(/\b([A-Za-z0-9_\-/]+\.[A-Za-z0-9]{1,6})\b/)?.[1] ?? '';
  if (file === '' || file.toLowerCase() === subject.toLowerCase()) { return ''; }
  return file;
}

/** Trim trailing question/terminal punctuation and end with a period. */
function ensureSentence(text: string): string {
  const t = text.replace(/[\s?!.;,]+$/, '').trim();
  return t === '' ? t : `${t}.`;
}

function detectDeliverable(lower: string): string {
  if (/\b(website|web ?site|landing page|web app|web ?page)\b/.test(lower)) { return 'website'; }
  if (/\b(api|endpoint|rest|graphql)\b/.test(lower)) { return 'API'; }
  if (/\b(cli|command[- ]line)\b/.test(lower)) { return 'CLI tool'; }
  if (/\bcomponent\b/.test(lower)) { return 'UI component'; }
  if (/\b(function|method)\b/.test(lower)) { return 'function'; }
  if (/\bclass\b/.test(lower)) { return 'class/module'; }
  if (/\bscript\b/.test(lower)) { return 'script'; }
  if (/\b(report|summary|analysis)\b/.test(lower)) { return 'written analysis'; }
  return '';
}

function inferOutputFormat(ir: PromptIR, deliverable: string): string {
  if (ir.output_schema && ir.output_schema.trim() !== '') {
    return ir.output_schema.replace(/\s+/g, ' ').trim();
  }
  switch (deliverable) {
    case 'website': return 'Complete, runnable HTML/CSS/JS (single file unless told otherwise).';
    case 'API': return 'Endpoint definitions with method, path, and example request/response.';
    case 'CLI tool': return 'Runnable script with a usage example.';
    case 'UI component': return 'Self-contained component code with a prop/usage example.';
    case 'function': return 'Single function with signature, body, and one usage example.';
    case 'class/module': return 'Module code with its public API and a usage example.';
    case 'script': return 'Runnable script with inline run instructions.';
    case 'written analysis': return 'Structured markdown with headings and bullet points.';
    default: return 'Deliverable only — no preamble, restating, or sign-off.';
  }
}

function buildSuccessCriteria(ir: PromptIR): string[] {
  const out: string[] = [];
  switch (ir.inferred_task_type) {
    case 'coding': out.push('Code runs without errors and satisfies every item in [REQUIREMENTS].'); break;
    case 'debugging': out.push('Root cause is identified and the fix is verified against the failing case.'); break;
    case 'spec-writing': out.push('Every requirement is testable and free of ambiguity.'); break;
    case 'research': out.push('Answer is accurate, sourced where relevant, and directly addresses [INPUT].'); break;
    default: out.push('Output fully satisfies [INPUT] and every item in [REQUIREMENTS].');
  }
  out.push('No item listed in [EXCLUSIONS] appears in the output.');
  return out;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

function collectUnmappedVagueTerms(rawPrompt: string): string[] {
  const found = new Set<string>();
  let match: RegExpExecArray | null;
  VAGUE_UNMAPPED.lastIndex = 0;
  while ((match = VAGUE_UNMAPPED.exec(rawPrompt)) !== null) {
    found.add(match[0].toLowerCase());
    if (found.size >= 3) { break; }
  }
  return [...found];
}

function splitSentences(text: string): string[] {
  return text
    .replace(/\r/g, '')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.replace(/^[-*\d.\s]+/, '').trim())
    .filter((s) => s.length > 0 && !s.startsWith('```'));
}

/**
 * Drop repeated sentences (case/whitespace-insensitive) so a doubled
 * instruction does not inflate the synthesized task line. Pure deletion —
 * order of first occurrence is preserved and tokens can only decrease.
 */
function dedupeSentences(sentences: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const sentence of sentences) {
    const key = sentence.toLowerCase().replace(/\s+/g, ' ').replace(/[.!?]+$/, '').trim();
    if (key === '' || seen.has(key)) { continue; }
    seen.add(key);
    out.push(sentence);
  }
  return out;
}

function stripNoise(text: string): string {
  let out = text;
  for (const pattern of NOISE_PATTERNS) { out = out.replace(pattern, ' '); }
  return out
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/^[\s,.;:-]+/, '')
    .replace(/[\s,]+$/, '')
    .trim();
}

function hardenRule(text: string): string {
  let t = text.replace(/^\W+/, '');
  t = t.replace(/\b(you should|you must|you need to)\b/gi, '');
  t = t.replace(
    /\b(should(?:n'?t)?|prefer(?:ably)?|ideally|try to|would like to|i'?d like to|need to|has to|have to|nice to have|hopefully|make sure to|make sure)\b/gi,
    'MUST',
  );
  t = t.replace(/\bMUST\b(?:\s+\bMUST\b)+/g, 'MUST');
  t = t.replace(/\s{2,}/g, ' ').trim();
  if (!/\b(MUST|NEVER|ALWAYS|ONLY)\b/.test(t)) { t = `MUST ${t}`; }
  return capitalize(t);
}

function toExclusion(text: string): string {
  let t = text.replace(/^\W+/, '');
  t = t.replace(/\b(you should not|you must not|please don'?t|please do not)\b/gi, 'Do not');
  t = t.replace(/\b(should not|shouldn'?t|must not|cannot|can'?t)\b/gi, 'Do not');
  t = t.replace(/\bwithout\b/gi, 'Do not use');
  t = t.replace(/\s{2,}/g, ' ').trim();
  if (!/^(do not|never|no )/i.test(t)) {
    if (/^don'?t\b/i.test(t)) {
      t = t.replace(/^don'?t\b/i, 'Do not');
    } else {
      t = `Do not: ${t}`;
    }
  }
  return capitalize(t);
}

function pushUnique(target: string[], value: string, seen: Set<string>): void {
  const v = value.replace(/\s{2,}/g, ' ').replace(/[.;]+$/, '').trim();
  if (v.length < 3) { return; }
  const key = v.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (key === '' || seen.has(key)) { return; }
  seen.add(key);
  target.push(v);
}

function pushBullets(lines: string[], items: string[], emptyLabel = 'None specified.'): void {
  if (items.length === 0) {
    lines.push(`- ${emptyLabel}`);
    return;
  }
  for (const item of items) { lines.push(`- ${item}`); }
}

function capitalize(text: string): string {
  if (text.length === 0) { return text; }
  return text.charAt(0).toUpperCase() + text.slice(1);
}
