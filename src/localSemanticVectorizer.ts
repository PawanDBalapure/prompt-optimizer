export interface VectorizedTextFeatures {
  tokens: string[];
  signals: string[];
}

import { STOP_WORDS, SYNONYM_MAP } from './vector/lexicon.js';

const DEFAULT_DIMENSION = 512;
const DEFAULT_VECTOR_VERSION = 'local-hashed-rag-v1';

const SIGNAL_RULES: Array<{ test: (lower: string, raw: string) => boolean; signal: string }> = [
  { test: (_l, r) => /```/.test(r), signal: 'signal_code_block' },
  { test: (_l, r) => /^#{1,6}\s|\n#{1,6}\s/m.test(r), signal: 'signal_markdown_headers' },
  { test: (l) => /\b(function|class|interface|const|let|var|import|export|return|async|await)\b/.test(l), signal: 'signal_code_context' },
  { test: (l) => /\b(fix|bug|error|crash|exception|debug|troubleshoot|diagnose)\b/.test(l), signal: 'signal_troubleshooting_intent' },
  { test: (l) => /\b(refactor|rewrite|optimize|restructure|simplify)\b/.test(l), signal: 'signal_transformation_intent' },
  { test: (l) => /\b(explain|describe|documentation|docs)\b/.test(l), signal: 'signal_explanation_intent' },
  { test: (l) => /\b(test|validate|verify|assert)\b/.test(l), signal: 'signal_verification_intent' },
  { test: (l) => /\b(configure|setup|install|deploy|bootstrap|provision)\b/.test(l), signal: 'signal_setup_intent' },
  { test: (l) => /\b(vs code|vscode|intellij|plugin|extension)\b/.test(l), signal: 'signal_ide_context' },
  { test: (l) => /node_modules/.test(l), signal: 'signal_dependency_path' },
  { test: (_l, r) => r.length > 1000, signal: 'signal_long_prompt' },
  { test: (_l, r) => r.split(/\r?\n/).length > 3, signal: 'signal_multiline_prompt' },
];

export class LocalSemanticVectorizer {
  public readonly dimension = DEFAULT_DIMENSION;
  public readonly vectorVersion = DEFAULT_VECTOR_VERSION;

  public analyze(text: string): VectorizedTextFeatures {
    return this.extractFeatures(text);
  }

  public vectorize(text: string): Float32Array {
    const vector = new Float32Array(this.dimension);
    const features = this.extractFeatures(text);

    for (let i = 0; i < features.tokens.length; i++) {
      this.addFeature(vector, features.tokens[i], 1.0);
      if (i < features.tokens.length - 1) {
        this.addFeature(vector, `${features.tokens[i]}__${features.tokens[i + 1]}`, 1.45);
      }
      if (i < features.tokens.length - 2) {
        this.addFeature(vector, `${features.tokens[i]}__${features.tokens[i + 1]}__${features.tokens[i + 2]}`, 1.1);
      }
    }
    for (const signal of features.signals) {
      this.addFeature(vector, signal, 1.8);
    }
    return this.normalizeVector(vector);
  }

  public cosineSimilarity(left: Float32Array, right: Float32Array): number {
    if (left.length !== right.length || left.length === 0) { return 0; }
    let dotProduct = 0;
    let leftMagnitude = 0;
    let rightMagnitude = 0;
    for (let i = 0; i < left.length; i++) {
      dotProduct += left[i] * right[i];
      leftMagnitude += left[i] * left[i];
      rightMagnitude += right[i] * right[i];
    }
    if (leftMagnitude === 0 || rightMagnitude === 0) { return 0; }
    return dotProduct / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
  }

  public serialize(vector: Float32Array): Buffer {
    const copy = vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength);
    return Buffer.from(copy);
  }

  public deserialize(buffer: Buffer): Float32Array {
    if (buffer.byteLength % 4 !== 0) { return new Float32Array(0); }
    const copy = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    return new Float32Array(copy);
  }

  private extractFeatures(text: string): VectorizedTextFeatures {
    const normalizedText = this.normalizeText(text);
    const rawTokens = normalizedText.match(/[a-z0-9]+/g) ?? [];
    const tokens: string[] = [];

    for (const rawToken of rawTokens) {
      const canonicalToken = this.canonicalizeToken(rawToken);
      if (!canonicalToken || STOP_WORDS.has(canonicalToken)) { continue; }
      tokens.push(canonicalToken);
    }

    const signals: string[] = [];
    const lowerText = text.toLowerCase();
    for (const rule of SIGNAL_RULES) {
      if (rule.test(lowerText, text)) { signals.push(rule.signal); }
    }
    return { tokens, signals };
  }

  private normalizeText(text: string): string {
    return text
      .replace(/```/g, ' codeblock ')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/[_/\\-]+/g, ' ')
      .replace(/[^a-zA-Z0-9\s]+/g, ' ')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  }

  private canonicalizeToken(token: string): string {
    const stemmedToken = this.stemToken(token);
    return SYNONYM_MAP.get(stemmedToken) ?? stemmedToken;
  }

  private stemToken(token: string): string {
    if (token.length > 5 && token.endsWith('ing')) { return token.slice(0, -3); }
    if (token.length > 4 && token.endsWith('ed')) { return token.slice(0, -2); }
    if (token.length > 4 && token.endsWith('es')) { return token.slice(0, -2); }
    if (token.length > 3 && token.endsWith('s')) { return token.slice(0, -1); }
    return token;
  }

  private addFeature(vector: Float32Array, feature: string, weight: number): void {
    const hash = this.hashFeature(feature);
    const index = hash % this.dimension;
    const sign = (hash & 1) === 0 ? 1 : -1;
    vector[index] += sign * weight;
  }

  private normalizeVector(vector: Float32Array): Float32Array {
    let magnitude = 0;
    for (let i = 0; i < vector.length; i++) { magnitude += vector[i] * vector[i]; }
    if (magnitude === 0) { return vector; }
    const inverseMagnitude = 1 / Math.sqrt(magnitude);
    for (let i = 0; i < vector.length; i++) { vector[i] *= inverseMagnitude; }
    return vector;
  }

  private hashFeature(feature: string): number {
    let hash = 2166136261;
    for (let i = 0; i < feature.length; i++) {
      hash ^= feature.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }
}
