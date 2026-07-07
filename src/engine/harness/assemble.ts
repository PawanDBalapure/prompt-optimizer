import type { PromptIDEContext } from '../../contracts.js';
import { extractSalientTerms } from '../contextPacker.helpers.js';
import type { HarnessConfig } from './config.js';
import { buildLibraryConstraints } from './libraryCheck.js';
import { extractSignatures, signatureConstraint } from './signatures.js';

/**
 * Assemble every harness injection into a small, capped set of constraint
 * lines appended to the compiled YAML spec's `constraints:` block.  The cap
 * protects the engine's token savings — guardrails must not reintroduce the
 * bloat the optimizer removes.
 */

const MAX_HARNESS_LINES = 6;
const MAX_GUIDELINE_INJECTIONS = 3;
const MUTATING_INTENT = /\b(add|create|fix|implement|refactor|update|change)\b/i;
const NETWORK_INTENT = /\b(fetch|request|api|http|download|upload|network)\b/i;
const CODE_INTENT = /\b(code|function|class|method|bug|test|refactor|implement|fix|type|import)\b/i;

function wordSet(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
}

function overlap(a: Set<string>, b: Set<string>): number {
  let hits = 0;
  for (const w of a) { if (b.has(w)) { hits++; } }
  return hits;
}

/** Rank team guidelines by prompt-word overlap; take the top few relevant. */
function selectGuidelines(rawPrompt: string, guidelines: string[]): string[] {
  if (guidelines.length === 0) { return []; }
  const promptWords = wordSet(rawPrompt);
  return guidelines
    .map((g) => ({ g, score: overlap(promptWords, wordSet(g)) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_GUIDELINE_INJECTIONS)
    .map((x) => `Team rule: ${x.g}`);
}

function boundaryConstraints(config: HarnessConfig): string[] {
  const out: string[] = [];
  if (config.allowedPaths.length > 0) {
    out.push(`Only modify files under: ${config.allowedPaths.join(', ')}.`);
  }
  if (config.forbiddenPaths.length > 0) {
    out.push(`Never modify files under: ${config.forbiddenPaths.join(', ')}.`);
  }
  return out;
}

function intentConstraints(rawPrompt: string): string[] {
  const out: string[] = [];
  if (MUTATING_INTENT.test(rawPrompt)) {
    out.push('Write a failing unit test for the changed behavior before the implementation.');
  }
  if (NETWORK_INTENT.test(rawPrompt)) {
    out.push('Handle 4xx/5xx responses, empty bodies, and add retry with exponential backoff.');
  }
  return out;
}

function signatureLines(ide: PromptIDEContext | undefined, rawPrompt: string): string[] {
  const active = ide?.active_file;
  if (!active?.content) { return []; }
  const signatures = extractSignatures(
    active.content,
    active.language ?? '',
    extractSalientTerms(rawPrompt),
  );
  const line = signatureConstraint(signatures);
  return line ? [line] : [];
}

/**
 * Build the ordered, capped harness constraint lines for one request.
 * Priority: boundaries > diff-only > libraries > signatures > guidelines >
 * intent expansion (most safety-critical first, softest last).
 */
export function buildHarnessInjections(
  rawPrompt: string,
  config: HarnessConfig,
  ide?: PromptIDEContext,
): string[] {
  if (!config.enabled) { return []; }
  const codeLike = CODE_INTENT.test(rawPrompt) || Boolean(ide?.active_file);
  if (!codeLike) { return []; }

  const lines: string[] = [];
  lines.push(...boundaryConstraints(config));
  if (config.diffOnly) {
    lines.push('Output changes as unified diff or search-replace blocks only; never restate whole files.');
  }
  if (config.libraryCheck) {
    lines.push(...buildLibraryConstraints(rawPrompt, ide?.workspace_root));
  }
  if (config.signatureAnchoring) {
    lines.push(...signatureLines(ide, rawPrompt));
  }
  lines.push(...selectGuidelines(rawPrompt, config.guidelines));
  if (config.intentExpansion) {
    lines.push(...intentConstraints(rawPrompt));
  }
  return lines.slice(0, MAX_HARNESS_LINES);
}

/** Quote a scalar exactly like the prompt compiler's yamlInline. */
function yamlInline(value: string): string {
  const one = value.replace(/\s+/g, ' ').trim().replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${one}"`;
}

/**
 * Append harness lines to the compiled YAML.  The `constraints:` block is
 * always the final section of both rich and lean specs, so plain appends
 * keep the document valid.
 */
export function appendHarnessConstraints(compiled: string, lines: string[]): string {
  if (lines.length === 0) { return compiled; }
  const suffix = lines.map((l) => `  - ${yamlInline(l)}`).join('\n');
  if (/^constraints:$/m.test(compiled)) {
    return `${compiled}\n${suffix}`;
  }
  return `${compiled}\nconstraints:\n${suffix}`;
}
