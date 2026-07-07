import * as vscode from 'vscode';

import type { IdeContextBundle } from './context';

/** Workspace globs never worth searching for prompt-referenced files. */
const DISCOVERY_EXCLUDE =
  '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/build/**,**/.next/**,**/coverage/**,**/*.min.*}';
const MAX_DISCOVERED_FILES = 5;
const MAX_DISCOVERED_BYTES = 200_000;

const PHRASE_STOP_WORDS = new Set<string>([
  'a', 'an', 'the', 'this', 'that', 'these', 'those',
  'what', 'where', 'how', 'why', 'is', 'are', 'do', 'does', 'did',
  'can', 'could', 'should', 'would',
  'there', 'it', 'i', 'we', 'you', 'my', 'our', 'your',
  'in', 'inside', 'within', 'from', 'of', 'for', 'to', 'on', 'at', 'with',
  'and', 'or', 'please', 'find', 'locate', 'purpose',
]);

const PHRASE_TRAILING_WORDS = new Set<string>([
  'doing', 'do', 'does', 'did',
  'work', 'works', 'working',
  'function', 'functions', 'functioning',
]);

/**
 * Pull file/symbol references out of a prompt: explicit `name.ext` paths plus
 * camelCase / PascalCase / snake_case identifiers (>= 4 chars) that commonly
 * name a file by its class/module symbol (e.g. `promptProxyEngine`).
 */
function extractReferenceNames(rawPrompt: string): { files: Set<string>; symbols: Set<string> } {
  const files = new Set<string>();
  const symbols = new Set<string>();
  for (const match of rawPrompt.matchAll(/\b([A-Za-z0-9_\-]+\.[A-Za-z0-9]{1,6})\b/g)) {
    files.add(match[1]);
  }
  for (const match of rawPrompt.matchAll(/\b[A-Za-z_$][A-Za-z0-9_$]*\b/g)) {
    const token = match[0];
    if (token.length < 4) { continue; }
    const isCamel = /[a-z]/.test(token) && /[A-Z]/.test(token);
    const isSnake = token.includes('_');
    if (isCamel || isSnake) { symbols.add(token); }
  }

  // Fallback for plain-English file mentions, e.g. "prompt ir helper".
  if (files.size === 0 && symbols.size === 0) {
    for (const phraseSymbol of extractPhraseSymbolCandidates(rawPrompt)) {
      symbols.add(phraseSymbol);
    }
  }
  return { files, symbols };
}

function titleWord(word: string): string {
  if (word.length <= 2) { return word.toUpperCase(); }
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function extractPhraseSymbolCandidates(rawPrompt: string): Set<string> {
  if (!/\b(what|where|how|why|is there|are there|find|locate|purpose)\b/i.test(rawPrompt)) {
    return new Set<string>();
  }

  const region =
    rawPrompt.match(/\b(?:what|how|why)\s+(?:does|do|did|is|are|can|should|would)\s+(.+)/i)?.[1]
    ?? rawPrompt.match(/\bwhere\s+(?:is|are|can i find)\s+(.+)/i)?.[1]
    ?? rawPrompt.match(/\b(?:is there|are there)\s+(.+)/i)?.[1]
    ?? rawPrompt;

  const words = (region.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter((word) => !PHRASE_STOP_WORDS.has(word));

  while (words.length > 0 && PHRASE_TRAILING_WORDS.has(words[words.length - 1])) {
    words.pop();
  }

  if (words.length < 2 || words.length > 5) { return new Set<string>(); }

  const merged = words.join('');
  if (merged.length < 6) { return new Set<string>(); }

  const pascal = words.map((word) => titleWord(word)).join('');
  const camel = words.map((word, index) => index === 0 ? word : titleWord(word)).join('');

  return new Set<string>([pascal, camel, merged, words.join('_'), words.join('-')]);
}

/** Brace-expanded case variants so a Windows/macOS glob still matches a symbol. */
function caseVariants(name: string): string {
  const lower = name.charAt(0).toLowerCase() + name.slice(1);
  const upper = name.charAt(0).toUpperCase() + name.slice(1);
  const set = new Set([name, lower, upper]);
  return set.size === 1 ? name : `{${[...set].join(',')}}`;
}

/**
 * Discover files the prompt references by name but that are NOT currently open,
 * and append them to `open_files` so the engine can route to and open them.
 * Best-effort and bounded: it caps the number of files, skips heavy/binary
 * trees, and silently ignores unreadable matches so it can never block or throw.
 */
export async function augmentContextWithReferencedFiles(
  ideContext: IdeContextBundle,
  rawPrompt: string,
): Promise<void> {
  if (!vscode.workspace.workspaceFolders?.length) { return; }

  const alreadyKnown = new Set<string>(
    [ideContext.active_file?.path, ...ideContext.open_files.map((f) => f.path)]
      .filter((p): p is string => Boolean(p))
      .map((p) => p.toLowerCase()),
  );

  const { files, symbols } = extractReferenceNames(rawPrompt);
  const globs: string[] = [];
  for (const file of files) { globs.push(`**/${file}`); }
  for (const symbol of symbols) { globs.push(`**/${caseVariants(symbol)}.*`); }
  if (globs.length === 0) { return; }

  const found = new Map<string, vscode.Uri>();
  for (const glob of globs) {
    if (found.size >= MAX_DISCOVERED_FILES) { break; }
    let uris: vscode.Uri[] = [];
    try {
      uris = await vscode.workspace.findFiles(glob, DISCOVERY_EXCLUDE, MAX_DISCOVERED_FILES);
    } catch {
      continue;
    }
    for (const uri of uris) {
      const key = uri.fsPath.toLowerCase();
      if (alreadyKnown.has(key) || found.has(key)) { continue; }
      found.set(key, uri);
      if (found.size >= MAX_DISCOVERED_FILES) { break; }
    }
  }

  for (const uri of found.values()) {
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > MAX_DISCOVERED_BYTES) { continue; }
      const doc = await vscode.workspace.openTextDocument(uri);
      ideContext.open_files.push({
        path: uri.fsPath,
        content: doc.getText(),
        selection: '',
        language: doc.languageId,
        is_active: false,
      });
    } catch {
      // Unreadable/binary file — skip silently.
    }
  }
}
