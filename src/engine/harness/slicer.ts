/**
 * Heuristic (regex + brace/indent walking) function slicing and structural
 * skeleton extraction.  Always available — the tree-sitter layer upgrades
 * precision when a grammar is present, and falls back to this module.
 */

export interface FunctionSlice {
  text: string;
  /** 0-based inclusive line range in the original content. */
  startLine: number;
  endLine: number;
}

function isBraceLanguage(language: string): boolean {
  return /^(ts|tsx|typescript|js|jsx|javascript|java|kt|kotlin|c|cpp|cs|go|rust)$/i.test(language);
}

function isPython(language: string): boolean {
  return /^(py|python)$/i.test(language);
}

/** Line index where a function/method named `symbol` is declared, or -1. */
function findDeclarationLine(lines: string[], symbol: string, language: string): number {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = isPython(language)
    ? [new RegExp(`^\\s*(?:async\\s+)?def\\s+${escaped}\\s*\\(`)]
    : [
      new RegExp(`\\bfunction\\s+${escaped}\\s*[(<]`),
      new RegExp(`\\b(?:const|let|var)\\s+${escaped}\\s*(?::[^=]+)?=\\s*(?:async\\s*)?(?:\\(|\\w+\\s*=>)`),
      new RegExp(`^\\s*(?:public\\s+|private\\s+|protected\\s+)?(?:static\\s+)?(?:async\\s+)?${escaped}\\s*[(<]`),
    ];
  for (let i = 0; i < lines.length; i++) {
    if (patterns.some((p) => p.test(lines[i]))) { return i; }
  }
  return -1;
}

/** Walk `{`/`}` depth from the declaration to find the closing line. */
function walkBraces(lines: string[], start: number): number {
  let depth = 0;
  let opened = false;
  for (let i = start; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') { depth++; opened = true; }
      else if (ch === '}') { depth--; }
    }
    if (opened && depth <= 0) { return i; }
    // Arrow function without braces: single-expression body ends same line.
    if (!opened && i > start) { return start; }
  }
  return lines.length - 1;
}

/** Walk indentation from a Python def to the last more-indented line. */
function walkIndent(lines: string[], start: number): number {
  const baseIndent = (/^\s*/.exec(lines[start]) ?? [''])[0].length;
  let end = start;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') { continue; }
    const indent = (/^\s*/.exec(line) ?? [''])[0].length;
    if (indent <= baseIndent) { break; }
    end = i;
  }
  return end;
}

/**
 * Slice the named function (declaration through closing brace / dedent) out
 * of `content`.  Returns null when the symbol has no findable declaration.
 */
export function sliceFunctionHeuristic(
  content: string,
  language: string,
  symbol: string,
): FunctionSlice | null {
  if (!isBraceLanguage(language) && !isPython(language)) { return null; }
  const lines = content.split(/\r?\n/);
  const start = findDeclarationLine(lines, symbol, language);
  if (start === -1) { return null; }
  const end = isPython(language) ? walkIndent(lines, start) : walkBraces(lines, start);
  return {
    text: lines.slice(start, end + 1).join('\n'),
    startLine: start,
    endLine: end,
  };
}

/** One structural element header (function/class/branch/loop), normalized. */
const SKELETON_PATTERNS: Array<{ kind: string; pattern: RegExp }> = [
  { kind: 'function', pattern: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+(\w+)/ },
  { kind: 'function', pattern: /^\s*(?:export\s+)?(?:const|let)\s+(\w+)\s*(?::[^=]+)?=\s*(?:async\s*)?\(/ },
  { kind: 'function', pattern: /^\s*(?:async\s+)?def\s+(\w+)/ },
  { kind: 'class', pattern: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/ },
  { kind: 'method', pattern: /^\s{2,}(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:async\s+)?(\w+)\s*\([^)]*\)\s*(?::\s*[^{;]+)?\{/ },
  { kind: 'if', pattern: /^\s*(?:\}\s*)?(?:else\s+)?if\s*\(/ },
  { kind: 'loop', pattern: /^\s*(?:for|while)\s*[\s(]/ },
  { kind: 'try', pattern: /^\s*try\s*[{:]/ },
];

/**
 * Extract a normalized structural skeleton: one entry per named construct
 * plus counts of anonymous branches/loops.  Used by AST diff validation.
 */
export function extractSkeleton(content: string): Map<string, number> {
  const skeleton = new Map<string, number>();
  for (const line of content.split(/\r?\n/)) {
    for (const { kind, pattern } of SKELETON_PATTERNS) {
      const match = pattern.exec(line);
      if (!match) { continue; }
      const key = match[1] ? `${kind}:${match[1]}` : kind;
      skeleton.set(key, (skeleton.get(key) ?? 0) + 1);
      break;
    }
  }
  return skeleton;
}
