export interface VectorizedTextFeatures {
  tokens: string[];
  signals: string[];
}

const DEFAULT_DIMENSION = 512;
const DEFAULT_VECTOR_VERSION = 'local-hashed-rag-v1';

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'be',
  'by',
  'can',
  'do',
  'for',
  'from',
  'get',
  'how',
  'i',
  'if',
  'in',
  'is',
  'it',
  'its',
  'me',
  'my',
  'of',
  'on',
  'or',
  'our',
  'please',
  'should',
  'show',
  'that',
  'the',
  'this',
  'to',
  'us',
  'was',
  'we',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'with',
  'you',
  'your',
]);

const SYNONYM_MAP = new Map<string, string>([
  ['bootstrap', 'setup'],
  ['build', 'create'],
  ['bug', 'fix'],
  ['configure', 'setup'],
  ['crash', 'fix'],
  ['debug', 'fix'],
  ['delete', 'remove'],
  ['describe', 'explain'],
  ['diagnose', 'fix'],
  ['docs', 'explain'],
  ['documentation', 'explain'],
  ['error', 'fix'],
  ['exception', 'fix'],
  ['explain', 'explain'],
  ['failure', 'fix'],
  ['fix', 'fix'],
  ['generate', 'create'],
  ['include', 'add'],
  ['install', 'setup'],
  ['issue', 'fix'],
  ['optimize', 'refactor'],
  ['perf', 'performance'],
  ['performance', 'performance'],
  ['publish', 'deploy'],
  ['refactor', 'refactor'],
  ['repair', 'fix'],
  ['remove', 'remove'],
  ['restructure', 'refactor'],
  ['rewrite', 'refactor'],
  ['setup', 'setup'],
  ['simplify', 'refactor'],
  ['speed', 'performance'],
  ['test', 'test'],
  ['troubleshoot', 'fix'],
  ['validate', 'test'],
  ['verify', 'test'],
]);

export class LocalSemanticVectorizer {
  public readonly dimension = DEFAULT_DIMENSION;
  public readonly vectorVersion = DEFAULT_VECTOR_VERSION;

  public analyze(text: string): VectorizedTextFeatures {
    return this.extractFeatures(text);
  }

  public vectorize(text: string): Float32Array {
    const vector = new Float32Array(this.dimension);
    const features = this.extractFeatures(text);

    for (let index = 0; index < features.tokens.length; index++) {
      this.addFeature(vector, features.tokens[index], 1.0);

      if (index < features.tokens.length - 1) {
        this.addFeature(vector, `${features.tokens[index]}__${features.tokens[index + 1]}`, 1.45);
      }

      if (index < features.tokens.length - 2) {
        this.addFeature(
          vector,
          `${features.tokens[index]}__${features.tokens[index + 1]}__${features.tokens[index + 2]}`,
          1.1
        );
      }
    }

    for (const signal of features.signals) {
      this.addFeature(vector, signal, 1.8);
    }

    return this.normalizeVector(vector);
  }

  public cosineSimilarity(left: Float32Array, right: Float32Array): number {
    if (left.length !== right.length || left.length === 0) {
      return 0;
    }

    let dotProduct = 0;
    let leftMagnitude = 0;
    let rightMagnitude = 0;

    for (let index = 0; index < left.length; index++) {
      const leftValue = left[index];
      const rightValue = right[index];

      dotProduct += leftValue * rightValue;
      leftMagnitude += leftValue * leftValue;
      rightMagnitude += rightValue * rightValue;
    }

    if (leftMagnitude === 0 || rightMagnitude === 0) {
      return 0;
    }

    return dotProduct / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
  }

  public serialize(vector: Float32Array): Buffer {
    const copy = vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength);
    return Buffer.from(copy);
  }

  public deserialize(buffer: Buffer): Float32Array {
    if (buffer.byteLength % 4 !== 0) {
      return new Float32Array(0);
    }

    const copy = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    return new Float32Array(copy);
  }

  private extractFeatures(text: string): VectorizedTextFeatures {
    const normalizedText = this.normalizeText(text);
    const rawTokens = normalizedText.match(/[a-z0-9]+/g) ?? [];
    const tokens: string[] = [];

    for (const rawToken of rawTokens) {
      const canonicalToken = this.canonicalizeToken(rawToken);
      if (!canonicalToken || STOP_WORDS.has(canonicalToken)) {
        continue;
      }

      tokens.push(canonicalToken);
    }

    const signals: string[] = [];
    const lowerText = text.toLowerCase();

    if (/```/.test(text)) {
      signals.push('signal_code_block');
    }

    if (/^#{1,6}\s|\n#{1,6}\s/m.test(text)) {
      signals.push('signal_markdown_headers');
    }

    if (/\b(function|class|interface|const|let|var|import|export|return|async|await)\b/.test(lowerText)) {
      signals.push('signal_code_context');
    }

    if (/\b(fix|bug|error|crash|exception|debug|troubleshoot|diagnose)\b/.test(lowerText)) {
      signals.push('signal_troubleshooting_intent');
    }

    if (/\b(refactor|rewrite|optimize|restructure|simplify)\b/.test(lowerText)) {
      signals.push('signal_transformation_intent');
    }

    if (/\b(explain|describe|documentation|docs)\b/.test(lowerText)) {
      signals.push('signal_explanation_intent');
    }

    if (/\b(test|validate|verify|assert)\b/.test(lowerText)) {
      signals.push('signal_verification_intent');
    }

    if (/\b(configure|setup|install|deploy|bootstrap|provision)\b/.test(lowerText)) {
      signals.push('signal_setup_intent');
    }

    if (/\b(vs code|vscode|intellij|plugin|extension)\b/.test(lowerText)) {
      signals.push('signal_ide_context');
    }

    if (/node_modules/.test(lowerText)) {
      signals.push('signal_dependency_path');
    }

    if (text.length > 1000) {
      signals.push('signal_long_prompt');
    }

    if (text.split(/\r?\n/).length > 3) {
      signals.push('signal_multiline_prompt');
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
    if (token.length > 5 && token.endsWith('ing')) {
      return token.slice(0, -3);
    }

    if (token.length > 4 && token.endsWith('ed')) {
      return token.slice(0, -2);
    }

    if (token.length > 4 && token.endsWith('es')) {
      return token.slice(0, -2);
    }

    if (token.length > 3 && token.endsWith('s')) {
      return token.slice(0, -1);
    }

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

    for (let index = 0; index < vector.length; index++) {
      magnitude += vector[index] * vector[index];
    }

    if (magnitude === 0) {
      return vector;
    }

    const inverseMagnitude = 1 / Math.sqrt(magnitude);
    for (let index = 0; index < vector.length; index++) {
      vector[index] *= inverseMagnitude;
    }

    return vector;
  }

  private hashFeature(feature: string): number {
    let hash = 2166136261;

    for (let index = 0; index < feature.length; index++) {
      hash ^= feature.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }

    return hash >>> 0;
  }
}