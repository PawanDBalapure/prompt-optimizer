/**
 * Type-signature anchoring: extract exported function/method signatures from
 * the code the prompt is about, so the harness can pin them ("preserve these
 * exact signatures").  Pure regex heuristics — no compiler run, no deps.
 */

const MAX_SIGNATURES = 4;
const MAX_SIGNATURE_CHARS = 140;

/** TS/JS: exported functions, class methods with types, arrow consts. */
const TS_PATTERNS: RegExp[] = [
  /^export\s+(?:default\s+)?(?:async\s+)?function\s+\w+\s*(?:<[^>]*>)?\([^)]*\)(?:\s*:\s*[^{;]+)?/gm,
  /^export\s+const\s+\w+\s*(?::\s*[^=]+)?=\s*(?:async\s+)?(?:\([^)]*\)|\w+)\s*(?::\s*[^=]+)?=>/gm,
  /^\s{2,}(?:public\s+|protected\s+)?(?:static\s+)?(?:async\s+)?\w+\s*(?:<[^>]*>)?\([^)]*\)\s*:\s*[^{;]+\{/gm,
];

/** Python: def / async def with optional return annotation. */
const PY_PATTERN = /^(?:async\s+)?def\s+\w+\s*\([^)]*\)(?:\s*->\s*[^:]+)?:/gm;

function clean(signature: string): string {
  const flat = signature
    .replace(/\s+/g, ' ')
    .replace(/\s*\{\s*$/, '')
    .replace(/:\s*$/, '')
    .trim();
  return flat.length > MAX_SIGNATURE_CHARS ? `${flat.slice(0, MAX_SIGNATURE_CHARS - 1)}…` : flat;
}

function isTypeScriptLike(language: string): boolean {
  return /^(ts|tsx|typescript|js|jsx|javascript)$/i.test(language);
}

function isPython(language: string): boolean {
  return /^(py|python)$/i.test(language);
}

/**
 * Extract up to {@link MAX_SIGNATURES} public signatures from a file.  When
 * `mentionedSymbols` is non-empty, signatures containing a mentioned symbol
 * are preferred so the anchor stays on what the prompt is about.
 */
export function extractSignatures(
  content: string,
  language: string,
  mentionedSymbols: Set<string> = new Set(),
): string[] {
  const patterns = isTypeScriptLike(language)
    ? TS_PATTERNS
    : isPython(language) ? [PY_PATTERN] : [];
  if (patterns.length === 0 || content.trim() === '') { return []; }

  const all: string[] = [];
  const seen = new Set<string>();
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    for (const match of content.matchAll(pattern)) {
      const sig = clean(match[0]);
      if (sig.length < 10 || seen.has(sig)) { continue; }
      seen.add(sig);
      all.push(sig);
    }
  }
  if (all.length === 0) { return []; }

  const lowerSymbols = [...mentionedSymbols].map((s) => s.toLowerCase());
  const mentioned = lowerSymbols.length > 0
    ? all.filter((sig) => lowerSymbols.some((sym) => sig.toLowerCase().includes(sym)))
    : [];
  const pick = mentioned.length > 0 ? mentioned : all;
  return pick.slice(0, MAX_SIGNATURES);
}

/** Render extracted signatures as a single YAML-safe constraint line. */
export function signatureConstraint(signatures: string[]): string | null {
  if (signatures.length === 0) { return null; }
  return `Preserve these exact signatures: ${signatures.join(' | ')}`;
}
