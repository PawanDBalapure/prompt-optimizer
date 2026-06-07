import { LocalSemanticVectorizer } from '../localSemanticVectorizer.js';

/**
 * Semantic, diversified, intent-aware relevance scoring shared by the two
 * memory selectors (prompt augmentation and cross-tier recall).
 *
 * Goal: get the *right* accumulated knowledge into the model's context while
 * spending the fewest possible tokens/credits.  Three ideas combine here:
 *
 *   A. **Semantic scoring** — blend cheap lexical term-overlap with the
 *      embedding cosine the cache already computes, so ranking reflects
 *      meaning (synonyms, phrasing) rather than literal substring hits.
 *   B. **MMR diversification** — when admitting under a budget, penalise a
 *      candidate by its similarity to what is already admitted, so every
 *      admitted token carries *new* information instead of paraphrase.
 *   C/D. **Tier fairness + intent weighting** — guarantee a slice of each
 *      memory tier and nudge the tiers that match the prompt's intent
 *      (troubleshooting → studied files / past prompts, refactor → graph,
 *      setup → conventions) so the context stays enriched, not monotone.
 *
 * Everything is env-tunable and degrades gracefully: with no vectorizer the
 * callers keep their previous lexical-only behaviour.
 */

export interface SemanticVectorizer {
  vectorize(text: string): Float32Array;
  cosineSimilarity(left: Float32Array, right: Float32Array): number;
  analyze(text: string): { tokens: string[]; signals: string[] };
}

export interface RelevanceContext {
  vectorizer: SemanticVectorizer;
  queryVector: Float32Array;
  queryTerms: Set<string>;
  /** Intent feature flags extracted from the prompt (e.g. troubleshooting). */
  signals: Set<string>;
}

function envFloat(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) { return fallback; }
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

/** Weight given to the embedding cosine when blending with lexical overlap. */
function vectorWeight(): number {
  return envFloat('POMEMORY_SEMANTIC_VECTOR_WEIGHT', 0.4, 0, 1);
}

/** Weight given to literal term overlap when blending with the cosine. */
function lexicalWeight(): number {
  return envFloat('POMEMORY_SEMANTIC_LEXICAL_WEIGHT', 0.6, 0, 1);
}

/** MMR trade-off: 1 = pure relevance, 0 = pure novelty.  Default favours relevance. */
export function mmrLambda(): number {
  return envFloat('POMEMORY_MMR_LAMBDA', 0.72, 0, 1);
}

/**
 * Build the per-request scoring context once.  Vectorising the query a single
 * time keeps re-ranking cheap even across dozens of candidate sections.
 */
export function createRelevanceContext(
  rawPrompt: string,
  vectorizer?: SemanticVectorizer,
): RelevanceContext {
  const vz: SemanticVectorizer = vectorizer ?? new LocalSemanticVectorizer();
  const features = vz.analyze(rawPrompt);
  return {
    vectorizer: vz,
    queryVector: vz.vectorize(rawPrompt),
    queryTerms: new Set(features.tokens),
    signals: new Set(features.signals),
  };
}

/** Fraction of query terms that literally appear in the candidate text. */
export function lexicalOverlap(text: string, ctx: RelevanceContext): number {
  if (ctx.queryTerms.size === 0) { return 0; }
  const candidate = new Set(ctx.vectorizer.analyze(text).tokens);
  let matches = 0;
  for (const term of ctx.queryTerms) {
    if (candidate.has(term)) { matches++; }
  }
  return matches / ctx.queryTerms.size;
}

/**
 * Blended relevance in roughly [0, 1]: lexical overlap fused with embedding
 * cosine.  Used to rank discretionary context against the current prompt.
 */
export function blendedRelevance(text: string, ctx: RelevanceContext): number {
  const lexical = lexicalOverlap(text, ctx);
  const cosine = ctx.vectorizer.cosineSimilarity(ctx.queryVector, ctx.vectorizer.vectorize(text));
  return lexicalWeight() * lexical + vectorWeight() * Math.max(0, cosine);
}

/**
 * Embedding-only relevance contribution, weighted like {@link blendedRelevance}
 * but without the lexical term.  Used to *augment* a score that already counts
 * literal overlap (e.g. recall entries) so semantics are added, not duplicated.
 */
export function semanticComponent(text: string, ctx: RelevanceContext): number {
  const cosine = ctx.vectorizer.cosineSimilarity(ctx.queryVector, ctx.vectorizer.vectorize(text));
  return vectorWeight() * Math.max(0, cosine);
}

/**
 * Enterprise Relevance Scoring Formula (Part 5 of Graph Memory Architecture)
 * 
 * FinalScore = RelevanceScore * EvidenceTrust * FreshnessPenalty * ConflictPenalty
 * RelevanceScore = w_e*ExactMatch + w_s*SymbolMatch + w_f*FileProximity + w_g*GraphDistanceScore + w_u*UsageFrequency + w_r*Recency + w_m*EmbeddingSimilarity
 */
export interface EnterpriseScoringParams {
  exactMatch: number;      // [0, 1]
  symbolMatch: number;     // [0, 1]
  fileProximity: number;   // [0, 1]
  graphDistance: number;   // [0, 1] (e.g., 1 / (1 + hops))
  usageFrequency: number;  // [0, 1]
  recency: number;         // [0, 1]
  embeddingSimilarity: number; // [0, 1]
  evidenceTrust?: number;      // Default 1.0
  freshnessPenalty?: number;   // Default 1.0
  conflictPenalty?: number;    // Default 1.0
}

export function enterpriseRelevanceScore(params: EnterpriseScoringParams): number {
  const W_E = 0.24, W_S = 0.20, W_F = 0.14, W_G = 0.14;
  const W_U = 0.08, W_R = 0.08, W_M = 0.12;
  
  const relevance = 
    (W_E * params.exactMatch) +
    (W_S * params.symbolMatch) +
    (W_F * params.fileProximity) +
    (W_G * params.graphDistance) +
    (W_U * params.usageFrequency) +
    (W_R * params.recency) +
    (W_M * params.embeddingSimilarity);
    
  const evidenceTrust = params.evidenceTrust ?? 1.0;
  const freshnessPenalty = params.freshnessPenalty ?? 1.0;
  const conflictPenalty = params.conflictPenalty ?? 1.0;

  return relevance * evidenceTrust * freshnessPenalty * conflictPenalty;
}

/**
 * Generic memory-tier label used for fairness + intent weighting.  Augmentation
 * sees `memory | kg | digest | peer`; recall additionally sees `cache | user`.
 */
export type RelevanceTier = 'memory' | 'kg' | 'digest' | 'peer' | 'cache' | 'user' | 'other';

/** Classify an augmentation section by its leading `# ...` header. */
export function detectSectionTier(section: string): RelevanceTier {
  const header = (section.split('\n', 1)[0] ?? '').toLowerCase();
  if (header.includes('knowledge graph')) { return 'kg'; }
  if (header.includes('previously studied') || header.includes('studied file')) { return 'digest'; }
  if (header.includes('peer workspace')) { return 'peer'; }
  if (header.includes('workspace memory')) { return 'memory'; }
  return 'other';
}

/**
 * Small additive boost steering the prompt's detected intent toward the tiers
 * most likely to help it.  Kept modest so it nudges ties without overriding a
 * clearly more-relevant block from another tier.
 */
const INTENT_TIER_BOOSTS: Record<string, Partial<Record<RelevanceTier, number>>> = {
  signal_troubleshooting_intent: { digest: 0.12, cache: 0.10, kg: 0.04 },
  signal_transformation_intent:  { kg: 0.12, memory: 0.04 },
  signal_explanation_intent:     { memory: 0.08, kg: 0.06 },
  signal_verification_intent:    { digest: 0.06, cache: 0.06 },
  signal_setup_intent:           { memory: 0.12 },
  signal_ide_context:            { peer: 0.04 },
};

export function intentBoost(tier: RelevanceTier, signals: Set<string>): number {
  let boost = 0;
  for (const signal of signals) {
    boost += INTENT_TIER_BOOSTS[signal]?.[tier] ?? 0;
  }
  return boost;
}

export interface DiverseItem<T> {
  item: T;
  score: number;
  vector: Float32Array;
  tier: RelevanceTier;
}

/**
 * Order items for admission so the result is both relevant and non-redundant.
 *
 *   1. **Tier fairness (C)** — pick the single best item of each distinct tier
 *      first (in descending score), guaranteeing the context is not dominated
 *      by one noisy tier.
 *   2. **MMR fill (B)** — greedily append the remaining items, each time
 *      choosing the candidate that maximises `λ·score − (1−λ)·maxCosToChosen`,
 *      so near-duplicates of already-chosen blocks sink to the bottom.
 *
 * The caller still applies the token/byte budget or count limit to the ordered
 * list; this function only decides *order*, never how many survive.
 */
export function diversifiedOrder<T>(
  items: Array<DiverseItem<T>>,
  vectorizer: SemanticVectorizer,
  options: { tierFairness?: boolean } = {},
): T[] {
  if (items.length <= 1) { return items.map((i) => i.item); }
  const lambda = mmrLambda();
  const pool = [...items];
  const chosen: Array<DiverseItem<T>> = [];

  if (options.tierFairness) {
    const bestByTier = new Map<RelevanceTier, DiverseItem<T>>();
    for (const entry of pool) {
      const prior = bestByTier.get(entry.tier);
      if (!prior || entry.score > prior.score) { bestByTier.set(entry.tier, entry); }
    }
    const leaders = [...bestByTier.values()].sort((a, b) => b.score - a.score);
    for (const leader of leaders) {
      chosen.push(leader);
      pool.splice(pool.indexOf(leader), 1);
    }
  }

  while (pool.length > 0) {
    let bestIndex = 0;
    let bestValue = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      let maxSim = 0;
      for (const sel of chosen) {
        const sim = vectorizer.cosineSimilarity(pool[i].vector, sel.vector);
        if (sim > maxSim) { maxSim = sim; }
      }
      const mmr = lambda * pool[i].score - (1 - lambda) * maxSim;
      if (mmr > bestValue) { bestValue = mmr; bestIndex = i; }
    }
    chosen.push(pool[bestIndex]);
    pool.splice(bestIndex, 1);
  }

  return chosen.map((entry) => entry.item);
}
