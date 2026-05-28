import type { PromptDiagnostic, PromptIR } from '../contracts.js';

/**
 * Encodes prompt-engineering best practices distilled from public guidance
 * published by Anthropic (Claude) and OpenAI (GPT) engineering teams.
 *
 * Sources (Anthropic): "Anthropic — Prompt engineering overview", "Use
 * XML tags", "Chain of thought", "Multishot prompting", "Prefill Claude's
 * response", "System prompts", "Long-context tips".
 *
 * Sources (OpenAI): "GPT best practices — Six strategies for getting
 * better results", "Function calling and structured outputs", "Use
 * delimiters", "Ask the model to adopt a persona", "Few-shot exemplars".
 *
 * The rules below are kept deliberately conservative — they only fire on
 * unambiguous omissions so the user receives actionable, low-noise
 * recommendations alongside the lint diagnostics in
 * `src/promptIR/linter.ts`.
 */

export interface BestPracticeFinding {
  /** Stable identifier used for tests + downstream UI grouping. */
  code: string;
  /** Origin label — "Anthropic" / "OpenAI" / "Both" — for transparency. */
  origin: 'Anthropic' | 'OpenAI' | 'Both';
  /** Short user-facing summary of the missing technique. */
  message: string;
  /** Concrete, copy-pasteable recommendation. */
  suggestion: string;
  /** Severity mirrors PromptDiagnostic semantics. */
  severity: 'info' | 'warning' | 'error';
}

/** Apply all best-practice checks and return the union of findings. */
export function evaluateBestPractices(
  rawPrompt: string,
  ir: PromptIR,
  targetModel: 'claude' | 'gpt' | 'gemini' | 'local',
): BestPracticeFinding[] {
  const lower = rawPrompt.toLowerCase();
  const wordCount = rawPrompt.trim().split(/\s+/).length;
  const isComplex = wordCount >= 80 || ir.constraints.length >= 4;
  const findings: BestPracticeFinding[] = [];

  if (!isPersonaSpecific(ir.role)) {
    findings.push({
      code: 'BP_GENERIC_ROLE',
      origin: 'Both',
      severity: 'warning',
      message: 'Role/persona is generic — both Anthropic and OpenAI recommend a specific expert persona.',
      suggestion: 'Replace the default role with a specific expert persona, e.g. "You are a senior TypeScript architect specialising in Node.js microservices."',
    });
  }

  if (targetModel === 'claude' && !hasXmlScaffolding(rawPrompt)) {
    findings.push({
      code: 'BP_CLAUDE_MISSING_XML',
      origin: 'Anthropic',
      severity: 'info',
      message: 'Claude responds best when instructions are wrapped in XML tags.',
      suggestion: 'Wrap each section with tags such as <task>, <context>, <rules>, <output_format> — see Anthropic\'s "Use XML tags" guidance.',
    });
  }

  if ((targetModel === 'gpt' || targetModel === 'gemini') && !hasMarkdownDelimiters(rawPrompt)) {
    findings.push({
      code: 'BP_MISSING_DELIMITERS',
      origin: 'OpenAI',
      severity: 'info',
      message: 'OpenAI recommends explicit delimiters (### headings, triple backticks, or """ quotes).',
      suggestion: 'Separate role, task, examples, and output sections with markdown headings (### Task, ### Output) or triple backticks around source code.',
    });
  }

  if (isComplex && ir.examples.length === 0) {
    findings.push({
      code: 'BP_MISSING_FEW_SHOT',
      origin: 'Both',
      severity: 'warning',
      message: 'Complex tasks benefit from 1–3 worked input→output examples (multishot prompting).',
      suggestion: 'Add a `### Examples` block (or `<examples>` for Claude) with at least one fully-worked input/output pair.',
    });
  }

  if (isComplex && !mentionsReasoningHint(lower) && !ir.reasoning_policy) {
    findings.push({
      code: 'BP_MISSING_REASONING_HINT',
      origin: 'Both',
      severity: 'info',
      message: 'Long or multi-step tasks improve when the model is told to think before answering.',
      suggestion: 'Add: "Before answering, think step-by-step inside a <thinking> block and only then produce the final answer." (Anthropic prefills work well here.)',
    });
  }

  if (!hasExplicitOutputSchema(rawPrompt, ir)) {
    findings.push({
      code: 'BP_MISSING_OUTPUT_SCHEMA',
      origin: 'OpenAI',
      severity: 'warning',
      message: 'Output format is not pinned to a schema — answers will be hard to parse programmatically.',
      suggestion: 'Specify a precise JSON schema or shape, e.g. "Return ONLY a JSON object: { \\"status\\": \\"ok\\"|\\"error\\", \\"details\\": string }".',
    });
  }

  if (!mentionsSuccessCriteria(lower)) {
    findings.push({
      code: 'BP_NO_SUCCESS_CRITERIA',
      origin: 'Both',
      severity: 'info',
      message: 'No explicit acceptance criteria — the model cannot self-verify.',
      suggestion: 'Add a checklist of acceptance criteria: "The answer is correct if (a) all tests pass, (b) the function returns a Promise<Result>, (c) no global state is mutated."',
    });
  }

  if (isComplex && !mentionsNegativeConstraints(lower)) {
    findings.push({
      code: 'BP_NO_NEGATIVE_CONSTRAINTS',
      origin: 'Anthropic',
      severity: 'info',
      message: 'No explicit "do not" instructions — Anthropic recommends pairing positive and negative constraints.',
      suggestion: 'Add what the model should NOT do, e.g. "Do not invent APIs that are not in the provided files. Do not include explanatory prose outside the JSON output."',
    });
  }

  return findings;
}

/** Convert findings to PromptDiagnostic for the standard surface. */
export function findingsToDiagnostics(findings: BestPracticeFinding[]): PromptDiagnostic[] {
  return findings.map((f) => ({
    severity: f.severity,
    code: f.code,
    message: `[${f.origin}] ${f.message}`,
    fix_suggestion: f.suggestion,
  }));
}

// ── Predicate helpers ─────────────────────────────────────────────────────────

function isPersonaSpecific(role?: string): boolean {
  if (!role) { return false; }
  const lower = role.toLowerCase();
  const genericPhrases = [
    'helpful software engineering assistant',
    'expert software developer and software architect',
    'expert systems engineer and elite debugging assistant',
    'principal product manager and systems architect',
  ];
  return !genericPhrases.some((phrase) => lower.includes(phrase));
}

function hasXmlScaffolding(text: string): boolean {
  return /<\s*[a-zA-Z][\w-]*\s*>/.test(text);
}

function hasMarkdownDelimiters(text: string): boolean {
  return /(^|\n)#{2,}\s+\S/.test(text) || /```/.test(text) || /"""/.test(text);
}

function hasExplicitOutputSchema(text: string, ir: PromptIR): boolean {
  if (ir.output_schema && ir.output_schema.trim().length > 0) { return true; }
  return /\b(return|respond|output|reply)\b[^.]*\b(json|yaml|xml|markdown|csv|schema|object|array|table)\b/i.test(text);
}

function mentionsReasoningHint(lower: string): boolean {
  return /\b(think (step|aloud)|step[- ]by[- ]step|chain[- ]of[- ]thought|reason through|<thinking>)\b/.test(lower);
}

function mentionsSuccessCriteria(lower: string): boolean {
  return /\b(acceptance criteria|success criteria|definition of done|the answer is correct|all tests pass|expected output|the result must)\b/.test(lower);
}

function mentionsNegativeConstraints(lower: string): boolean {
  return /\b(do not|don't|never|must not|avoid|refrain from)\b/.test(lower);
}
