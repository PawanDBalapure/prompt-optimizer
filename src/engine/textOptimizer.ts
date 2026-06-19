import type { TextSegment } from './types.js';

const CODE_LIKE_KEYWORDS = /^(?:import|export|const|let|var|function|class|interface|type|enum|async|await|return|if|else|switch|case|for|while|try|catch)\b/;
const CODE_LIKE_SUFFIXES = /=>|[{}();]$/;
const CODE_LIKE_CALL = /^\s*[\w$.]+\(/;

function splitTextSegments(text: string): TextSegment[] {
  return text
    .split(/(```[\s\S]*?```)/g)
    .filter((segment) => segment !== '')
    .map((segment) => ({
      content: segment,
      is_code: segment.startsWith('```') && segment.endsWith('```'),
    }));
}

function isBlankCommentLine(line: string): boolean {
  return /^\/\/+$/.test(line)
    || /^#+$/.test(line)
    || /^\/\*+$/.test(line)
    || /^\*+$/.test(line)
    || /^\*\/+$/.test(line);
}

function isStandaloneImportLine(line: string): boolean {
  return /^(?:import\s+.*\s+from\s+['"].*['"];?|require\s*\(\s*['"].*['"]\s*\);?)$/i.test(line);
}

export function looksLikeCodeLine(line: string): boolean {
  return CODE_LIKE_KEYWORDS.test(line) || CODE_LIKE_SUFFIXES.test(line) || CODE_LIKE_CALL.test(line);
}

/**
 * Ordered list of safe, meaning-preserving rewrites applied to natural-language
 * directive lines. Each entry is [pattern, replacement]. Order matters: longer
 * / more specific phrases come before their shorter overlaps so they win.
 *
 * Style rule for "drop" patterns that may swallow a trailing comma: place the
 * `,?` *outside* the closing word boundary (e.g. `\bBasically\b,?`).  Putting
 * `,?` inside two `\b` anchors causes the engine to backtrack out of the
 * comma (since `\b` doesn't match between two non-word chars), leaving stray
 * commas behind.  See unit case `P3-fluff` in scripts/qa-text-optimizer.mjs.
 */
const DIRECTIVE_REWRITES: ReadonlyArray<readonly [RegExp, string]> = [
  // Politeness / filler openers (drop entirely).
  [/\b(?:please|kindly)\b\s*,?/gi, ''],
  [/\b(?:can|could|would)\s+you\b\s*,?/gi, ''],
  [/\bI (?:need|want) you to\b\s*,?/gi, ''],
  [/\bI would like(?: you)? to\b\s*,?/gi, ''],
  [/\bI'd like(?: you)? to\b\s*,?/gi, ''],
  [/\bhow (?:do|can) I\b\s*,?/gi, ''],
  [/\bhelp me(?: to)?\b\s*,?/gi, ''],
  [/\bassist me(?: with| in)?\b\s*,?/gi, ''],
  [/\btell me(?: how to| about)?\b\s*,?/gi, ''],
  [/\bshow me how to\b\s*,?/gi, ''],
  [/\bgo ahead and\b\s*,?/gi, ''],
  [/\bfeel free to\b\s*,?/gi, ''],
  [/\blet(?:'s| us)\b\s*,?/gi, ''],
  [/\bYour (?:task|job) is to\b\s*,?/gi, ''],
  [/\bIt is important to(?: note that)?\b\s*,?/gi, ''],
  [/\bIt should be noted that\b\s*,?/gi, ''],
  [/\bAs a matter of fact\b,?/gi, ''],
  [/\bNeedless to say\b,?/gi, ''],
  [/\bPlease note that\b\s*,?/gi, ''],
  [/\bBasically\b,?/gi, ''],
  [/\bjust\b/gi, ''],

  // Verbose phrasings → concise verbs / prepositions (apply before single-word
  // swaps so multi-word patterns are not partially rewritten).
  [/\bwalk me through\b/gi, 'explain'],
  [/\bmake sure\b/gi, 'ensure'],
  // Relative-clause tightening: "the tests that are failing" → "failing tests",
  // "the file that is missing" → "missing file". Grammar-preserving reorder.
  [/\bthe (\w+) that are (\w+)\b/gi, '$2 $1'],
  [/\bthe (\w+) that is (\w+)\b/gi, '$2 $1'],
  // "a list of integers" → "integer list", "an array of strings" → "string array".
  [/\b(?:a |an )?(?:list|array|set|collection) of (\w+?)s\b/gi, '$1 list'],
  [/\bin order to\b/gi, 'to'],
  [/\bin order for\b/gi, 'for'],
  [/\bfor the purpose of\b/gi, 'for'],
  [/\bwith the aim of\b/gi, 'to'],
  [/\bwith regard to\b/gi, 'about'],
  [/\bwith respect to\b/gi, 'about'],
  [/\bin terms of\b/gi, 'for'],
  [/\bin the event that\b/gi, 'if'],
  [/\bin the case (?:that|of)\b/gi, 'if'],
  [/\bin (?:light|view) of the fact that\b/gi, 'because'],
  [/\bdue to the fact that\b/gi, 'because'],
  [/\bowing to the fact that\b/gi, 'because'],
  [/\bon the grounds that\b/gi, 'because'],
  [/\bin spite of the fact that\b/gi, 'although'],
  [/\bdespite the fact that\b/gi, 'although'],
  [/\bregardless of the fact that\b/gi, 'although'],
  [/\bdespite of\b/gi, 'despite'],
  [/\bduring the course of\b/gi, 'during'],
  [/\bin the process of\b/gi, ''],
  [/\bat (?:this|the) (?:point|moment) in time\b/gi, 'now'],
  [/\bat the present time\b/gi, 'now'],
  [/\bin the near future\b/gi, 'soon'],
  [/\bon a regular basis\b/gi, 'regularly'],
  [/\bin close proximity to\b/gi, 'near'],
  [/\bin the vicinity of\b/gi, 'near'],
  [/\ba (?:large|great) number of\b/gi, 'many'],
  [/\bthe (?:vast )?majority of\b/gi, 'most'],
  [/\ba number of\b/gi, 'several'],
  [/\bgive consideration to\b/gi, 'consider'],
  [/\btake into consideration\b/gi, 'consider'],
  [/\bmake (?:a )?(?:decision|determination)\b/gi, 'decide'],
  [/\bcome to (?:a|the) conclusion\b/gi, 'conclude'],
  [/\bcarry out\b/gi, 'do'],
  [/\bperform an analysis of\b/gi, 'analyze'],
  [/\bprovide (?:a |an )?(?:explanation|description) (?:of|for)\b/gi, 'explain'],
  [/\bprior to\b/gi, 'before'],
  [/\bsubsequent to\b/gi, 'after'],
  [/\bin addition to\b/gi, 'besides'],
  [/\bas well as\b/gi, 'and'],
  [/\bhas the ability to\b/gi, 'can'],
  [/\bis able to\b/gi, 'can'],
  [/\bare able to\b/gi, 'can'],
  [/\bin the absence of\b/gi, 'without'],
  [/\bsurrounding IDE context\b/gi, 'IDE context'],

  // Hedge adjectives add no instruction value in a directive: drop them
  // (with a leading article if present). "write a quick function" →
  // "write function"; "a simple REST API" → "REST API".
  [/\b(?:a |an )?(?:quick|simple|basic|trivial|small|short)\s+(?=\w)/gi, ''],

  // Single-word substitutions (kept last to avoid breaking phrase rewrites).
  [/\butili[sz]e(s|d)?\b/gi, 'use$1'],
  [/\bdemonstrate(s|d)?\b/gi, 'show$1'],
  [/\bapproximately\b/gi, 'about'],
  [/\bnumerous\b/gi, 'many'],
  [/\badditional\b/gi, 'more'],
  [/\bcommence(s|d)?\b/gi, 'start$1'],
  [/\bterminate(s|d)?\b/gi, 'end$1'],
  [/\bsufficient\b/gi, 'enough'],
  [/\bobtain\b/gi, 'get'],
  [/\bregarding\b/gi, 'about'],
  [/\bconcerning\b/gi, 'about'],
];

/**
 * Single combined alternation of every DIRECTIVE_REWRITES left-hand side.
 * A line that matches none of these phrases cannot be rewritten, so we can
 * skip the full ~120-pattern loop entirely after one O(n) scan. This is a
 * pure performance gate — it does not change output, since the rewrite loop
 * over a non-matching line is a no-op anyway. All source patterns are
 * `\b`-anchored word phrases with no `^`/`$` anchors, so unioning them with
 * `|` is a safe membership test.
 */
const DIRECTIVE_GATE = new RegExp(
  DIRECTIVE_REWRITES.map(([pattern]) => `(?:${pattern.source})`).join('|'),
  'i',
);

/**
 * Recapitalise the first alphabetical character after sentence-ending
 * punctuation (".", "!", "?").  Removed phrases mid-sentence frequently
 * leave a lowercase word stranded after a period, e.g.
 *   "Refactor X. add Y."  →  "Refactor X. Add Y."
 */
function recapitaliseSentences(text: string): string {
  return text.replace(/([.!?])\s+([a-z])/g, (_match, punct, ch) => `${punct} ${ch.toUpperCase()}`);
}

/**
 * High-confidence misspelling → correct-word map. Every entry is a strict
 * 1-token-for-1-token substitution (single word in, single word out) so a
 * correction can never *increase* the token count — a misspelling usually
 * costs the same or MORE sub-word tokens than its correct form, so fixing it
 * is token-neutral or token-saving. Keys are lowercase; original capitalisation
 * is preserved by {@link correctSpelling}. Only unambiguous typos are listed —
 * never a real word that some prompts might intend literally (those go through
 * {@link CONTEXTUAL_CORRECTIONS} with a disambiguating anchor instead).
 */
const SPELLING_CORRECTIONS: ReadonlyMap<string, string> = new Map([
  // ── Function words & articles ──────────────────────────────────────────
  ['teh', 'the'], ['hte', 'the'], ['thsi', 'this'], ['tihs', 'this'],
  ['taht', 'that'], ['htat', 'that'], ['adn', 'and'], ['nad', 'and'], ['anf', 'and'],
  ['wiht', 'with'], ['wtih', 'with'], ['nto', 'not'],
  // ── Interrogatives / common short words ────────────────────────────────
  ['wht', 'what'], ['waht', 'what'], ['whta', 'what'], ['whatt', 'what'],
  ['wen', 'when'], ['whne', 'when'], ['wehn', 'when'], ['wher', 'where'],
  ['wheer', 'where'], ['hwere', 'where'],
  ['wich', 'which'], ['whcih', 'which'], ['wihch', 'which'], ['wether', 'whether'],
  ['wy', 'why'], ['hwo', 'how'],
  ['exctly', 'exactly'], ['exacly', 'exactly'], ['exatly', 'exactly'],
  ['excatly', 'exactly'], ['exactlly', 'exactly'], ['exactley', 'exactly'],
  // ── Modal / auxiliary verbs ────────────────────────────────────────────
  ['shoud', 'should'], ['shoudl', 'should'], ['sould', 'should'], ['shuold', 'should'],
  ['woud', 'would'], ['woudl', 'would'], ['wuld', 'would'], ['owuld', 'would'],
  ['coud', 'could'], ['coudl', 'could'], ['culd', 'could'],
  ['ahve', 'have'], ['hvae', 'have'],
  ['cna', 'can'], ['acn', 'can'], ['wil', 'will'], ['iwll', 'will'],
  // ── High-frequency words ───────────────────────────────────────────────
  ['alos', 'also'], ['aslo', 'also'], ['jsut', 'just'], ['jstu', 'just'],
  ['liek', 'like'], ['mke', 'make'], ['amke', 'make'],
  ['abou', 'about'], ['abut', 'about'], ['aobut', 'about'], ['abotu', 'about'],
  ['agian', 'again'], ['agin', 'again'], ['alwasy', 'always'], ['alwyas', 'always'],
  ['anohter', 'another'], ['antoher', 'another'], ['befoer', 'before'], ['bofore', 'before'],
  ['betwen', 'between'], ['bewteen', 'between'], ['diffrent', 'different'],
  ['diferent', 'different'], ['differnt', 'different'], ['durring', 'during'],
  ['folowing', 'following'], ['followign', 'following'], ['mesage', 'message'],
  ['messge', 'message'], ['messsage', 'message'], ['peopel', 'people'], ['poeple', 'people'],
  ['problme', 'problem'], ['porblem', 'problem'],
  ['recomend', 'recommend'], ['reccomend', 'recommend'], ['remeber', 'remember'],
  ['somthing', 'something'], ['somethign', 'something'], ['togeter', 'together'],
  ['usualy', 'usually'], ['writting', 'writing'], ['everytihng', 'everything'],
  ['everythign', 'everything'], ['anyhting', 'anything'], ['anythign', 'anything'],
  ['becuase', 'because'], ['becasue', 'because'], ['becuse', 'because'], ['bcause', 'because'],
  // ── Spelling-rule classics ─────────────────────────────────────────────
  ['recieve', 'receive'], ['recieved', 'received'], ['recieves', 'receives'],
  ['seperate', 'separate'], ['seperated', 'separated'], ['seperates', 'separates'],
  ['definately', 'definitely'], ['definatly', 'definitely'], ['definetly', 'definitely'],
  ['defintely', 'definitely'], ['occured', 'occurred'], ['occuring', 'occurring'],
  ['occurence', 'occurrence'], ['neccessary', 'necessary'], ['necesary', 'necessary'],
  ['neccesary', 'necessary'], ['accross', 'across'], ['untill', 'until'],
  ['thier', 'their'], ['enviroment', 'environment'], ['enviornment', 'environment'],
  ['persistant', 'persistent'], ['existance', 'existence'], ['refered', 'referred'],
  ['prefered', 'preferred'], ['begining', 'beginning'], ['commited', 'committed'],
  ['sucessful', 'successful'], ['succesful', 'successful'], ['succesfully', 'successfully'],
  ['sucess', 'success'], ['compatability', 'compatibility'], ['cancelled', 'canceled'],
  ['behaviour', 'behavior'], ['optimise', 'optimize'], ['initialise', 'initialize'],
  // ── Programming vocabulary ─────────────────────────────────────────────
  ['paramter', 'parameter'], ['paramters', 'parameters'], ['paremeter', 'parameter'],
  ['lenght', 'length'], ['widht', 'width'], ['heigth', 'height'],
  ['fucntion', 'function'], ['funtion', 'function'], ['fuction', 'function'],
  ['funcion', 'function'], ['functino', 'function'], ['retrun', 'return'],
  ['reutrn', 'return'], ['reponse', 'response'], ['responce', 'response'],
  ['repsonse', 'response'], ['respose', 'response'], ['dependancy', 'dependency'],
  ['dependancies', 'dependencies'], ['depenency', 'dependency'], ['arguement', 'argument'],
  ['arguements', 'arguments'], ['promt', 'prompt'], ['promts', 'prompts'],
  ['optimze', 'optimize'], ['varaible', 'variable'], ['varible', 'variable'],
  ['variabel', 'variable'], ['vaule', 'value'], ['valeu', 'value'], ['vlaue', 'value'],
  ['ojbect', 'object'], ['arrya', 'array'],
  ['stirng', 'string'], ['strign', 'string'], ['nubmer', 'number'], ['numbr', 'number'],
  ['boolena', 'boolean'], ['boolian', 'boolean'], ['mehtod', 'method'], ['methdo', 'method'],
  ['imoprt', 'import'], ['improt', 'import'], ['exoprt', 'export'], ['exprot', 'export'],
  ['consoel', 'console'], ['conosle', 'console'], ['defualt', 'default'], ['defalut', 'default'],
  ['asyncronous', 'asynchronous'], ['asynchronus', 'asynchronous'], ['promse', 'promise'],
  ['callbak', 'callback'], ['calback', 'callback'], ['requst', 'request'], ['reqeust', 'request'],
  ['requets', 'request'], ['databse', 'database'], ['datbase', 'database'], ['queyr', 'query'],
  ['qeury', 'query'], ['serach', 'search'], ['saerch', 'search'], ['updaet', 'update'],
  ['udpate', 'update'], ['delte', 'delete'], ['dlete', 'delete'], ['creaet', 'create'],
  ['craete', 'create'], ['intialize', 'initialize'], ['initialze', 'initialize'],
  ['confgi', 'config'], ['conifg', 'config'], ['cofnig', 'config'], ['pakage', 'package'],
  ['packge', 'package'], ['pacakge', 'package'], ['versoin', 'version'], ['verison', 'version'],
  ['compoent', 'component'], ['componnet', 'component'], ['compnent', 'component'],
  ['chekc', 'check'], ['chcek', 'check'], ['chnage', 'change'], ['chagne', 'change'],
  ['chnge', 'change'], ['workign', 'working'], ['wroking', 'working'], ['runing', 'running'],
  ['runnig', 'running'], ['usign', 'using'], ['uisng', 'using'], ['geting', 'getting'],
  ['gettign', 'getting'], ['seting', 'setting'], ['settign', 'setting'],
]);

const SPELLING_GATE = new RegExp(
  `\\b(?:${[...SPELLING_CORRECTIONS.keys()].join('|')})\\b`,
  'i',
);

/**
 * Context-sensitive corrections for words that are spelled correctly in the
 * dictionary (or are ambiguous fragments) but are near-certain typos in a
 * software-instruction context. Each entry is `[pattern, replacement]` where
 * the pattern is anchored to the disambiguating context so a legitimate use is
 * never rewritten (e.g. `fond` → `found` everywhere except the idiom "fond
 * of"; `doe` → `does` only before a pronoun/article). Every replacement is a
 * strict 1-word-for-1-word swap, so the token count cannot grow. `$1`/`$2`
 * back-references preserve surrounding words.
 */
const CONTEXTUAL_CORRECTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  // "fond" → "found" (skip the idiom "fond of").
  [/\bfond\b(?!\s+of\b)/gi, 'found'],
  // "doe" → "does" before a subject pronoun / determiner ("doe it do" →
  // "does it do"); leaves the animal "doe" untouched elsewhere.
  [/\bdoe\b(?=\s+(?:it|this|that|the|they|we|i|you|he|she|each)\b)/gi, 'does'],
  // "fi" → "fix" when used as an imperative before a conditional/object
  // ("fi if any issues" → "fix if any issues"); never touches hi-fi/sci-fi
  // because those are hyphenated and the \b before "fi" excludes the hyphen.
  [/\bfi\b(?=\s+(?:if|any|the|this|it|bug|bugs|issue|issues|error|errors|problem|problems)\b)/gi, 'fix'],
  // "fis" / "fixs" → "fixes"; "fixe" → "fix".
  [/\bfixs\b/gi, 'fixes'], [/\bfixe\b/gi, 'fix'],
  // "wha" / "wat" → "what" only when starting a question clause.
  [/\bwha\b(?=\s+(?:is|are|does|do|did|exactly|happens?)\b)/gi, 'what'],
  [/\bwat\b(?=\s+(?:is|are|does|do|did|exactly|happens?)\b)/gi, 'what'],
  // "issue's" used as plural → "issues" (in "any issue's").
  [/\b(any|some|the|all|no)\s+issue's\b/gi, '$1 issues'],
  // Common missing-apostrophe contractions.
  [/\bwont\b/gi, "won't"],
  [/\bcant\b/gi, "can't"],
  [/\bdont\b/gi, "don't"],
  [/\bdoesnt\b/gi, "doesn't"],
  [/\bisnt\b/gi, "isn't"],
  [/\bdidnt\b/gi, "didn't"],
  [/\bwasnt\b/gi, "wasn't"],
  [/\bwerent\b/gi, "weren't"],
  [/\bhasnt\b/gi, "hasn't"],
  [/\bhavent\b/gi, "haven't"],
  [/\bwouldnt\b/gi, "wouldn't"],
  [/\bshouldnt\b/gi, "shouldn't"],
  [/\bcouldnt\b/gi, "couldn't"],
  // "alot" → "a lot" would ADD a token, so it is intentionally excluded to
  // keep this layer strictly token-neutral.
];

/** Re-apply the casing of `original` to a lowercase `replacement`. */
function preserveCase(original: string, replacement: string): string {
  if (original === original.toUpperCase()) { return replacement.toUpperCase(); }
  if (original.charAt(0) === original.charAt(0).toUpperCase()) {
    return replacement.charAt(0).toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

/**
 * Apply the context-sensitive corrections. Replacements containing a `$`
 * back-reference are applied verbatim; bare-word replacements go through
 * {@link preserveCase} so the original capitalisation is retained.
 */
function applyContextualCorrections(line: string): string {
  let out = line;
  for (const [pattern, replacement] of CONTEXTUAL_CORRECTIONS) {
    out = replacement.includes('$')
      ? out.replace(pattern, replacement)
      : out.replace(pattern, (match) => preserveCase(match, replacement));
  }
  return out;
}

/**
 * Fix unambiguous typos on a natural-language line. Strictly 1:1 word swaps —
 * never adds, splits, or merges words — so the line's token count cannot grow.
 * Runs the context-sensitive layer first (real words that are typos in
 * context), then the dictionary of always-wrong misspellings.
 */
export function correctSpelling(line: string): string {
  let out = applyContextualCorrections(line);
  if (SPELLING_GATE.test(out)) {
    out = out.replace(/\b[A-Za-z]+\b/g, (word) => {
      const fix = SPELLING_CORRECTIONS.get(word.toLowerCase());
      return fix ? preserveCase(word, fix) : word;
    });
  }
  return out;
}

/**
 * Collapse a stranded duplicated word ("the the file" → "the file") and an
 * immediately repeated sentence ("Do X. Do X." → "Do X."). Both are pure
 * deletions, so they only ever *reduce* tokens — the bloat the user flagged
 * where a doubled instruction inflates the optimized prompt.
 */
function dedupeRepeats(text: string): string {
  let out = text.replace(/\b(\w+)(\s+\1\b)+/gi, '$1');
  const sentences = out.match(/[^.!?]+[.!?]+|\S[^.!?]*$/g);
  if (sentences && sentences.length > 1) {
    const seen = new Set<string>();
    const kept: string[] = [];
    for (const raw of sentences) {
      const piece = raw.trim();
      const key = piece.toLowerCase().replace(/\s+/g, ' ').replace(/[.!?]+$/, '');
      if (key !== '' && seen.has(key)) { continue; }
      seen.add(key);
      kept.push(piece);
    }
    out = kept.join(' ');
  }
  return out;
}

function compressDirectiveLine(line: string): string {
  let normalized = line;
  if (DIRECTIVE_GATE.test(line)) {
    for (const [pattern, replacement] of DIRECTIVE_REWRITES) {
      normalized = normalized.replace(pattern, replacement);
    }
  }

  // Token-safe sentence correction: typo fixes are strict 1:1 word swaps and
  // repeat-collapsing only deletes, so neither can grow the line's token count.
  normalized = correctSpelling(normalized);
  normalized = dedupeRepeats(normalized);

  normalized = normalized
    // Collapse whitespace.
    .replace(/\s+/g, ' ')
    // Pull stray spaces away from punctuation: "word ," → "word,".
    .replace(/\s+([,.;:!?])/g, '$1')
    // Collapse repeated punctuation introduced by phrase removal:
    // ",,"  →  ",", " . . " → ".", "!." → "!", etc.
    .replace(/([,.;:!?])(?:\s*[,.;:!?])+/g, '$1')
    .trim()
    // Strip leftover leading punctuation / dashes left by an opener removal.
    .replace(/^[,:;\-\s]+/, '')
    .trim();

  if (normalized === '') { return ''; }
  normalized = recapitaliseSentences(normalized);
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function optimizePlainTextSegment(text: string): string {
  const lines = text.split(/\r?\n/);
  const optimizedLines: string[] = [];
  const seenLines = new Set<string>();

  for (const rawLine of lines) {
    const trimmedLine = rawLine.trim();

    if (trimmedLine === '') {
      if (optimizedLines.length > 0 && optimizedLines[optimizedLines.length - 1] !== '') {
        optimizedLines.push('');
      }
      continue;
    }

    if (isBlankCommentLine(trimmedLine) || isStandaloneImportLine(trimmedLine)) {
      continue;
    }

    if (looksLikeCodeLine(trimmedLine)) {
      optimizedLines.push(rawLine);
      continue;
    }

    const compressedLine = compressDirectiveLine(trimmedLine);
    if (compressedLine === '') { continue; }

    const normalizedLine = compressedLine.toLowerCase().replace(/\s+/g, ' ').trim();
    if (seenLines.has(normalizedLine)) { continue; }
    seenLines.add(normalizedLine);
    optimizedLines.push(compressedLine);
  }

  return optimizedLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function optimizePromptText(prompt: string): string {
  const segments = splitTextSegments(prompt);
  const optimizedSegments: string[] = [];
  const seenCodeBlocks = new Set<string>();

  for (const segment of segments) {
    if (segment.is_code) {
      const normalizedCode = segment.content.trim();
      if (seenCodeBlocks.has(normalizedCode)) { continue; }
      seenCodeBlocks.add(normalizedCode);
      optimizedSegments.push(normalizedCode);
      continue;
    }

    const optimizedText = optimizePlainTextSegment(segment.content);
    if (optimizedText !== '') {
      optimizedSegments.push(optimizedText);
    }
  }

  return optimizedSegments.join('\n\n').trim();
}

/** Exported for unit-level testing of the line classifier. */
export const __testables = {
  isBlankCommentLine,
  isStandaloneImportLine,
  looksLikeCodeLine,
  compressDirectiveLine,
  correctSpelling,
  dedupeRepeats,
};
