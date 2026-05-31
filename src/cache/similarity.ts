import type { Vectorizer } from '../vector/vectorizer.js';

export const SEMANTIC_HIT_THRESHOLD = 0.68;
// Confidence-aware threshold tuning: well-used entries match more readily.
export const CONFIDENCE_THRESHOLD_BUMP = 0.06; // added when confidence < 0.4
export const CONFIDENCE_THRESHOLD_EASE = 0.04; // subtracted when confidence > 0.8

function calculateOverlapCoefficient(left: string[], right: string[]): number {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  if (leftSet.size === 0 || rightSet.size === 0) { return 0; }

  let sharedCount = 0;
  for (const token of leftSet) {
    if (rightSet.has(token)) { sharedCount++; }
  }
  return sharedCount / Math.min(leftSet.size, rightSet.size);
}

function buildComparisonFeatures(features: { tokens: string[]; signals: string[] }): string[] {
  const comparisonFeatures = new Set<string>();
  for (const token of features.tokens) { comparisonFeatures.add(`tok:${token}`); }
  for (const signal of features.signals) { comparisonFeatures.add(`sig:${signal}`); }
  for (let i = 0; i < features.tokens.length - 1; i++) {
    comparisonFeatures.add(`bi:${features.tokens[i]}__${features.tokens[i + 1]}`);
  }
  for (let i = 0; i < features.tokens.length - 2; i++) {
    comparisonFeatures.add(`tri:${features.tokens[i]}__${features.tokens[i + 1]}__${features.tokens[i + 2]}`);
  }
  return Array.from(comparisonFeatures);
}

export function calculateSimilarityScore(
  vectorizer: Vectorizer,
  queryText: string,
  queryVector: Float32Array,
  candidateText: string,
  candidateVector: Float32Array,
): number {
  const queryFeatures = vectorizer.analyze(queryText);
  const candidateFeatures = vectorizer.analyze(candidateText);

  const lexicalFeatures = buildComparisonFeatures(queryFeatures);
  const candidateLexicalFeatures = buildComparisonFeatures(candidateFeatures);
  const overlapCoefficient = calculateOverlapCoefficient(lexicalFeatures, candidateLexicalFeatures);
  const vectorSimilarity = vectorizer.cosineSimilarity(queryVector, candidateVector);

  const score = (overlapCoefficient * 0.95) + (vectorSimilarity * 0.05);
  return Math.max(0, Math.min(1, score));
}

/** Adjust the semantic hit threshold based on the candidate's tracked confidence. */
export function effectiveThreshold(rowConfidence: number): number {
  let threshold = SEMANTIC_HIT_THRESHOLD;
  if (rowConfidence < 0.4) { threshold += CONFIDENCE_THRESHOLD_BUMP; }
  if (rowConfidence > 0.8) { threshold -= CONFIDENCE_THRESHOLD_EASE; }
  return threshold;
}
