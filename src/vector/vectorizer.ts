/**
 * Public Vectorizer interface — keeps the cache manager decoupled from any
 * single embedding implementation.  The engine ships `LocalSemanticVectorizer`
 * (lexical TF-IDF) but enterprise deployments can swap in an ONNX MiniLM/BGE
 * runner or a self-hosted embedding endpoint by implementing this contract.
 *
 * Cache rows are keyed by `vectorVersion` (and refused on mismatch) so
 * switching providers does not corrupt stored embeddings — the worst that
 * happens is a one-time cache miss while the new vectors are written.
 */

export interface VectorizedTextFeatures {
  tokens: string[];
  signals: string[];
}

export interface Vectorizer {
  /** Logical dimensionality of vectors returned by `vectorize()`. */
  readonly dimension: number;

  /** Stable identifier of the vector space. Bump when semantics change. */
  readonly vectorVersion: string;

  /** Tokenize / extract surface signals from text. */
  analyze(text: string): VectorizedTextFeatures;

  /** Produce a length-`dimension` Float32Array embedding of `text`. */
  vectorize(text: string): Float32Array;

  /** Cosine similarity between two vectors of identical dimension. */
  cosineSimilarity(left: Float32Array, right: Float32Array): number;

  /** Serialize a vector for SQLite BLOB storage. */
  serialize(vector: Float32Array): Buffer;

  /** Deserialize a SQLite BLOB into a Float32Array. */
  deserialize(buffer: Buffer): Float32Array;
}
