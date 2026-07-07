import * as fs from 'node:fs';
import * as path from 'node:path';

import { sliceFunctionHeuristic, type FunctionSlice } from './slicer.js';

/**
 * Optional tree-sitter upgrade for function slicing.  Grammar `.wasm` files
 * are probed from `PROMPT_OPT_GRAMMAR_DIR` or `<ws>/.promptoptimizer/grammars`
 * (`tree-sitter-<lang>.wasm`).  When the `web-tree-sitter` package or the
 * grammar is unavailable the heuristic slicer answers instead, so this module
 * never throws and never blocks optimization.
 */

type Parser = {
  parse(input: string): { rootNode: SyntaxNode };
  setLanguage(lang: unknown): void;
};
interface SyntaxNode {
  type: string;
  text: string;
  startPosition: { row: number };
  endPosition: { row: number };
  namedChildren: SyntaxNode[];
  childForFieldName(name: string): SyntaxNode | null;
}

const GRAMMAR_LANGS: Record<string, string> = {
  ts: 'typescript', tsx: 'tsx', typescript: 'typescript',
  js: 'javascript', jsx: 'javascript', javascript: 'javascript',
  py: 'python', python: 'python',
};
const FUNCTION_NODE_TYPES = new Set([
  'function_declaration', 'function_definition', 'method_definition',
  'generator_function_declaration', 'lexical_declaration', 'variable_declaration',
]);

const parsers = new Map<string, Parser>();
let initAttempted = false;

function grammarDirs(workspaceRoot?: string): string[] {
  const dirs: string[] = [];
  if (process.env.PROMPT_OPT_GRAMMAR_DIR) { dirs.push(process.env.PROMPT_OPT_GRAMMAR_DIR); }
  if (workspaceRoot) { dirs.push(path.join(workspaceRoot, '.promptoptimizer', 'grammars')); }
  return dirs;
}

/**
 * Best-effort async init — call once from engine initialize().  Loads the
 * web-tree-sitter runtime and any grammar wasm files found on disk.
 */
export async function initAstSlicer(workspaceRoot?: string): Promise<void> {
  if (initAttempted) { return; }
  initAttempted = true;
  const candidates = grammarDirs(workspaceRoot).filter((d) => {
    try { return fs.existsSync(d); } catch { return false; }
  });
  if (candidates.length === 0) { return; }

  let TreeSitter: { init(): Promise<void>; Language: { load(p: string): Promise<unknown> } };
  let ParserCtor: new () => Parser;
  try {
    const mod = await import('web-tree-sitter');
    const anyMod = mod as unknown as Record<string, unknown>;
    ParserCtor = (anyMod.default ?? anyMod.Parser ?? anyMod) as new () => Parser;
    TreeSitter = ParserCtor as unknown as typeof TreeSitter;
    await TreeSitter.init();
  } catch {
    return; // package not installed / wasm runtime failed — heuristics only
  }

  for (const dir of candidates) {
    for (const [alias, grammar] of Object.entries(GRAMMAR_LANGS)) {
      if (parsers.has(alias)) { continue; }
      const wasmPath = path.join(dir, `tree-sitter-${grammar}.wasm`);
      if (!fs.existsSync(wasmPath)) { continue; }
      try {
        const language = await TreeSitter.Language.load(wasmPath);
        const parser = new ParserCtor();
        parser.setLanguage(language);
        parsers.set(alias, parser);
      } catch { /* bad grammar — skip */ }
    }
  }
}

function findFunctionNode(node: SyntaxNode, symbol: string): SyntaxNode | null {
  if (FUNCTION_NODE_TYPES.has(node.type)) {
    const nameNode = node.childForFieldName('name');
    if (nameNode?.text === symbol || node.text.slice(0, 200).includes(symbol)) {
      return node;
    }
  }
  for (const child of node.namedChildren) {
    const hit = findFunctionNode(child, symbol);
    if (hit) { return hit; }
  }
  return null;
}

/**
 * Slice the named function out of `content` — tree-sitter when a parser is
 * loaded for the language, heuristic brace/indent walking otherwise.
 */
export function sliceFunction(
  content: string,
  language: string,
  symbol: string,
): FunctionSlice | null {
  const parser = parsers.get(language.toLowerCase());
  if (parser) {
    try {
      const tree = parser.parse(content);
      const node = findFunctionNode(tree.rootNode, symbol);
      if (node) {
        return {
          text: node.text,
          startLine: node.startPosition.row,
          endLine: node.endPosition.row,
        };
      }
    } catch { /* parse failure — fall through */ }
  }
  return sliceFunctionHeuristic(content, language, symbol);
}

/** Test seam: report whether any tree-sitter parser actually loaded. */
export function astParserCount(): number {
  return parsers.size;
}
