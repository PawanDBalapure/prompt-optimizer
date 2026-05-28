/**
 * Stop-words removed during text feature extraction.  Words that carry no
 * semantic signal for prompt matching (articles, modal verbs, politeness).
 */
export const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'be', 'by', 'can', 'do', 'for', 'from', 'get',
  'how', 'i', 'if', 'in', 'is', 'it', 'its', 'me', 'my', 'of', 'on', 'or',
  'our', 'please', 'should', 'show', 'that', 'the', 'this', 'to', 'us', 'was',
  'we', 'what', 'when', 'where', 'which', 'who', 'why', 'with', 'you', 'your',
]);

/**
 * Map of related verbs/nouns to canonical synonyms so that prompts about
 * "fix the bug" and "debug the crash" share feature buckets.
 */
export const SYNONYM_MAP = new Map<string, string>([
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
