import { countTokens } from './pricing.js';
import {
  blendedRelevance,
  detectSectionTier,
  diversifiedOrder,
  intentBoost,
  type DiverseItem,
  type RelevanceContext,
} from './relevanceScoring.js';

/**
 * Augmentation ranking + budgeting.
 *
 * The engine harvests four kinds of discretionary context — workspace memory,
 * knowledge-graph neighbours, per-file recall digests, and peer-workspace
 * matches — and prepends them to every optimized prompt.  Left unchecked these
 * blocks cause two failure modes:
 *
 *   1. **Token bloat** — the combined size grows with the number of memory
 *      files / KG nodes / peers, pushing the user's actual request toward the
 *      edge of the model's context window.
 *   2. **Context rot** — blocks arrive in a fixed source order (memory → KG →
 *      digest → peers) regardless of how relevant each is to *this* prompt, so
 *      weakly-related material can sit above highly-relevant material and get
 *      lost in the middle.
 *
 * This module is the single choke point that fixes both: it filters low-value
 * boilerplate, de-duplicates blocks already represented by the inlined IDE
 * context, ranks the survivors (curated durable memory pinned first, the rest
 * by descending relevance), and admits them under a precise **token** budget
 * (with a legacy byte cap honoured for back-compat).
 */

export type RelevanceScorer = (text: string, queryTerms: Set<string>) => number;

/** Optional out-param capturing what the budget admitted vs dropped. */
export interface AugmentSelectionStats {
  admittedCount: number;
  droppedCount: number;
  admittedTokens: number;
  droppedTokens: number;
}

export interface AugmentSelectionOptions {
  /**
   * Normalised file paths already inlined verbatim in the IDE context pack.
   * Any non-curated augmentation that merely points at one of these files is
   * redundant and dropped (the full content is already present).
   */
  contextPaths?: Iterable<string>;
  /**
   * When provided, enables semantic relevance, MMR de-duplication, tier
   * fairness, and intent weighting.  Absent (e.g. unit tests) the selector
   * falls back to the supplied lexical `scoreRelevance` callback.
   */
  relevance?: RelevanceContext;
  /**
   * Target model's context window in tokens, if known.  Used to scale the
   * augmentation cap down for small-context models so memory never crowds out
   * the user's own prompt.
   */
  modelContextTokens?: number;
  /** Mutated in place with admission telemetry when supplied. */
  stats?: AugmentSelectionStats;
}

function envInt(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (!raw) { return fallback; }
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

function envFloat(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) { return fallback; }
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

/**
 * Minimum relevance score a discretionary augmentation must reach to be kept.
 * Curated durable memory bypasses this gate; empty/boilerplate sections are
 * dropped regardless of score.  Tunable via `POMEMORY_AUGMENT_RELEVANCE_MIN`.
 */
function relevanceThreshold(): number {
  return envFloat('POMEMORY_AUGMENT_RELEVANCE_MIN', 0.04, 0, 1);
}

/**
 * Token budget for the combined augmented context.  ~4.5K tokens is generous
 * for serious projects yet well below the point where it crowds out the user's
 * own prompt.  Tunable via `POMEMORY_MAX_AUGMENTED_TOKENS`.
 */
function tokenBudget(modelContextTokens?: number): number {
  const base = envInt('POMEMORY_MAX_AUGMENTED_TOKENS', 4_500, 16);
  if (modelContextTokens && modelContextTokens > 0) {
    const fraction = envFloat('POMEMORY_AUGMENT_CONTEXT_FRACTION', 0.25, 0.01, 0.9);
    return Math.max(16, Math.min(base, Math.floor(modelContextTokens * fraction)));
  }
  return base;
}

/**
 * Legacy byte ceiling, retained so the existing VS Code/CLI knob keeps working.
 * Enforced alongside the token budget — whichever binds first wins.
 */
function byteBudget(): number {
  return envInt('POMEMORY_MAX_AUGMENTED_BYTES', 18_000, 1_024);
}

/**
 * Sections sourced from user-curated durable instruction files are always
 * kept (when non-empty) and pinned to the top: they encode standing
 * conventions that should apply to every request, not just topical matches.
 */
const CURATED_MEMORY_HEADER =
  /^#\s+Workspace memory — (?:project memory|project knowledge|AGENTS\.md|CLAUDE)/i;
const ARCHITECTURE_MAP_HEADER = /^\[PROJECT ARCHITECTURE SUMMARY\]/i;

export function isCuratedMemorySection(section: string): boolean {
  return CURATED_MEMORY_HEADER.test(section);
}

function isPinnedArchitectureSection(section: string): boolean {
  return ARCHITECTURE_MAP_HEADER.test(section.trimStart());
}

function sectionBody(section: string): string {
  const newlineIndex = section.indexOf('\n');
  return newlineIndex === -1 ? '' : section.slice(newlineIndex + 1);
}

/**
 * True when a section carries no usable signal: an empty body, a placeholder
 * marker such as "(no summary captured)", or a template skeleton whose lines
 * are only unfilled "Label:" headings (e.g. a generated memory.md stub with
 * bare "Stack:" / "Conventions:" lines).  These add tokens but no information.
 */
export function isLowValueAugmentedSection(section: string): boolean {
  const meaningful = sectionBody(section)
    .split(/\r?\n/)
    .map((line) => line.replace(/^[#>\-*\s]+/, '').trim())
    .filter((line) => line !== '')
    .filter((line) => !/^[A-Za-z][\w ./-]{0,40}:\s*$/.test(line)) // unfilled "Label:"
    .filter((line) => !/^\(.*\)$/.test(line))                     // "(no summary captured)"
    .filter((line) => !/^todo\b/i.test(line));
  const compact = meaningful.join(' ').replace(/[^a-z0-9]/gi, '');
  return compact.length < 12;
}

function normalisePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').trim().toLowerCase();
}

/**
 * A non-curated section is redundant when it merely references a file whose
 * full content is already inlined in the IDE context pack.  Curated memory is
 * never treated as redundant.
 */
function duplicatesInlinedContext(section: string, contextPaths: Set<string>): boolean {
  if (contextPaths.size === 0) { return false; }
  const haystack = normalisePath(section);
  for (const path of contextPaths) {
    if (path !== '' && haystack.includes(path)) { return true; }
  }
  return false;
}

/**
 * Select, de-duplicate, rank, and token-budget the augmentation sections.
 *
 * Ordering guarantee: curated durable-memory sections appear first in their
 * original order, followed by the remaining sections sorted by descending
 * relevance to the prompt.  The result never exceeds the token or byte budget.
 */
export function selectAndRankAugmentedSections(
  sections: string[],
  queryTerms: Set<string>,
  scoreRelevance: RelevanceScorer,
  options: AugmentSelectionOptions = {},
): string[] {
  const contextPaths = new Set<string>();
  for (const p of options.contextPaths ?? []) {
    const norm = normalisePath(p);
    if (norm !== '') { contextPaths.add(norm); }
  }

  const relevance = options.relevance;
  const minScore = relevanceThreshold();
  const pinned: string[] = [];
  const curated: string[] = [];
  const scored: Array<DiverseItem<string>> = [];

  const scoreOf = (section: string): number => {
    if (relevance) {
      const base = relevance.queryTerms.size === 0 ? 1 : blendedRelevance(section, relevance);
      return base + intentBoost(detectSectionTier(section), relevance.signals);
    }
    return queryTerms.size === 0 ? 1 : scoreRelevance(section, queryTerms);
  };

  for (const section of sections) {
    if (isLowValueAugmentedSection(section)) { continue; }
    if (isPinnedArchitectureSection(section)) {
      pinned.push(section);
      continue;
    }
    if (isCuratedMemorySection(section)) {
      curated.push(section);
      continue;
    }
    if (duplicatesInlinedContext(section, contextPaths)) { continue; }
    const hasTerms = relevance ? relevance.queryTerms.size > 0 : queryTerms.size > 0;
    const score = scoreOf(section);
    if (hasTerms && score < minScore) { continue; }
    scored.push({
      item: section,
      score,
      tier: detectSectionTier(section),
      vector: relevance ? relevance.vectorizer.vectorize(section) : new Float32Array(0),
    });
  }

  // Order the non-curated survivors.  With a relevance context this applies
  // tier fairness + MMR diversification; otherwise a plain score sort.
  let orderedNonCurated: string[];
  if (relevance) {
    orderedNonCurated = diversifiedOrder(scored, relevance.vectorizer, { tierFairness: true });
  } else {
    orderedNonCurated = [...scored].sort((a, b) => b.score - a.score).map((entry) => entry.item);
  }
  const ranked = [...pinned, ...curated, ...orderedNonCurated];

  const maxTokens = tokenBudget(options.modelContextTokens);
  const maxBytes = byteBudget();
  const out: string[] = [];
  let usedTokens = 0;
  let usedBytes = 0;
  let droppedCount = 0;
  let droppedTokens = 0;
  for (const section of ranked) {
    const tokens = countTokens(section);
    const bytes = Buffer.byteLength(section, 'utf8') + 2;
    if (usedTokens + tokens > maxTokens || usedBytes + bytes > maxBytes) {
      droppedCount++;
      droppedTokens += tokens;
      continue;
    }
    out.push(section);
    usedTokens += tokens;
    usedBytes += bytes;
  }

  if (options.stats) {
    options.stats.admittedCount = out.length;
    options.stats.admittedTokens = usedTokens;
    options.stats.droppedCount = droppedCount;
    options.stats.droppedTokens = droppedTokens;
  }
  return out;
}
