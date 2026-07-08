/**
 * Agent — the budgeted agentic loop + compact prompt assembly.
 *
 * Flow per user query:
 *   route (0 LLM tokens) → presearch/outline → slice → assemble → callLLM.
 * If the LLM asks for more (FETCH directives), we loop — but never more than
 * MAX_TOOL_ROUNDS times and never past MAX_CONTEXT_TOKENS. Both caps exist
 * because an uncapped loop is an uncapped bill.
 */
import { countTokens } from '../pricing.js';
import { buildRepoIndex, outlineFile, type RepoIndexEntry } from './indexer.js';
import { routeQuery } from './router.js';
import { AgentToolExecutor } from './tools.js';
import {
  MAX_CONTEXT_TOKENS,
  MAX_LINES_PER_READ,
  MAX_TOOL_ROUNDS,
  type ContextSlice,
  type GrepToolInput,
  type PlannedToolCall,
  type ReadSliceToolInput,
  type RouteDecision,
} from './types.js';

export interface AgentRunResult {
  answer: string;
  context: string;
  rounds: number;
  contextTokens: number;
  routing: RouteDecision;
}

/** LLM boundary. Real integrations replace this. The mock "asks for more"
 *  via `FETCH path:start-end` lines so the loop is exercised in tests. */
export type LlmCaller = (context: string, message: string) => Promise<string>;

export const callLLM: LlmCaller = async (_context, message) =>
  `LLM(placeholder): analyzed request "${message.slice(0, 80)}" against provided context.`;

/** Stitch slices into the compact `// file: path:start-end` format. No prose,
 *  no markdown fences per slice — every framing byte is a token spent. */
export function assembleContext(slices: ContextSlice[]): string {
  return slices
    .map((s) => `// file: ${s.filePath}:${s.startLine}-${s.endLine}\n${s.code}`)
    .join('\n\n');
}

export class CodebaseAgent {
  private readonly tools: AgentToolExecutor;

  /** Lazy path/outline index (step 1 of the pipeline). Built at most once per
   *  agent — stores only paths + symbol ranges, never file bodies. */
  private repoIndex: RepoIndexEntry[] | undefined;

  constructor(private readonly workspaceRoot: string, private readonly llm: LlmCaller = callLLM) {
    this.tools = new AgentToolExecutor(workspaceRoot);
  }

  private index(): RepoIndexEntry[] {
    if (this.repoIndex === undefined) { this.repoIndex = buildRepoIndex(this.workspaceRoot); }
    return this.repoIndex;
  }

  /** Resolve a bare filename ("augmentBudget.ts") to its repo-relative path
   *  via the index — prompts rarely spell out full directories. */
  private resolvePathHint(hint: string): string {
    const normalized = hint.replace(/\\/g, '/').toLowerCase();
    for (const entry of this.index()) {
      const rel = entry.relPath.toLowerCase();
      if (rel === normalized || rel.endsWith(`/${normalized}`)) { return entry.relPath; }
    }
    return hint;
  }

  /**
   * Gather context slices for a prompt WITHOUT any LLM round-trip. This is
   * the piece the ContextPacker consumes: deterministic route → cheap search
   * → slice, all under the token budget.
   */
  gatherContext(prompt: string): { slices: ContextSlice[]; routing: RouteDecision; contextTokens: number } {
    const routing = routeQuery(prompt);
    const slices: ContextSlice[] = [];
    const seen = new Set<string>();
    let budget = MAX_CONTEXT_TOKENS;
    for (const call of routing.plannedCalls) {
      if (budget <= 0) { break; } // budget exhausted → stop, do not trim
      budget = this.executeCall(call, slices, seen, budget);
    }
    return { slices, routing, contextTokens: MAX_CONTEXT_TOKENS - budget };
  }

  /** Full agentic loop with the (mock) LLM in the seat. */
  async run(prompt: string): Promise<AgentRunResult> {
    const gathered = this.gatherContext(prompt);
    const slices = gathered.slices;
    const seen = new Set(slices.map((s) => `${s.filePath}:${s.startLine}`));
    let budget = MAX_CONTEXT_TOKENS - gathered.contextTokens;
    let answer = '';
    let rounds = 0;
    while (rounds < MAX_TOOL_ROUNDS) {
      rounds++;
      answer = await this.llm(assembleContext(slices), prompt);
      // Convention: the LLM requests more context with `FETCH path:start-end`
      // lines. No directives → done. Each round re-enters the SAME budget.
      const fetches = Array.from(answer.matchAll(/FETCH\s+([^\s:]+):(\d+)-(\d+)/g));
      if (fetches.length === 0) { break; }
      let added = false;
      for (const match of fetches) {
        if (budget <= 0) { break; }
        const next = budget;
        budget = this.executeCall(
          { tool: 'read_file_slice', input: { filePath: match[1], startLine: Number(match[2]), endLine: Number(match[3]) } },
          slices, seen, budget,
        );
        if (budget < next) { added = true; }
      }
      if (!added) { break; } // nothing new admitted → looping again is pure cost
    }
    return { answer, context: assembleContext(slices), rounds, contextTokens: MAX_CONTEXT_TOKENS - budget, routing: gathered.routing };
  }

  /** Execute one planned call, admitting slices while budget remains.
   *  Returns the remaining budget. All failures are swallowed — context
   *  enrichment must never crash the caller. */
  private executeCall(call: PlannedToolCall, slices: ContextSlice[], seen: Set<string>, budget: number): number {
    try {
      if (call.tool === 'grep') {
        const hits = this.tools.grep(call.input as GrepToolInput);
        for (const hit of hits) {
          budget = this.admit(slices, seen, budget, {
            filePath: hit.filePath, startLine: hit.startLine, endLine: hit.endLine, code: hit.snippet,
          });
        }
        // ripgrep missing or zero hits → index-backed SYMBOL search: scan the
        // outline index (names + ranges only — no file bodies) for a defining
        // declaration and admit just that slice.
        if (hits.length === 0) { budget = this.symbolSearch((call.input as GrepToolInput).pattern, slices, seen, budget); }
        return budget;
      }
      if (call.tool === 'read_file_slice') {
        const input = call.input as ReadSliceToolInput;
        const filePath = this.resolvePathHint(input.filePath);
        const result = this.tools.readFileSlice({ ...input, filePath });
        return this.admit(slices, seen, budget, {
          filePath, startLine: result.startLine, endLine: result.endLine, code: result.slice,
        });
      }
      // get_file_outline: convert the outline into a header comment slice —
      // symbol map costs ~10 tokens/symbol vs thousands for the file body.
      const outline = this.tools.getFileOutline({ filePath: this.resolvePathHint((call.input as { filePath: string }).filePath) });
      if (outline.symbols.length === 0) { return budget; }
      const map = outline.symbols
        .slice(0, 40)
        .map((s) => `// ${s.type} ${s.name} @ ${s.startLine}-${s.endLine}`)
        .join('\n');
      budget = this.admit(slices, seen, budget, {
        filePath: outline.filePath, startLine: 1, endLine: Math.min(outline.totalLines, MAX_LINES_PER_READ), code: map,
      });
      return budget;
    } catch {
      return budget; // tool failure ≠ agent failure
    }
  }

  /** Index-backed symbol definition lookup. The grep pattern arrives as
   *  `\bName\b` — strip the anchors and match outline symbol names exactly.
   *  Admits ONE defining slice (clamped to MAX_LINES_PER_READ), not usages. */
  private symbolSearch(pattern: string, slices: ContextSlice[], seen: Set<string>, budget: number): number {
    const name = pattern.replace(/\\b/g, '').replace(/\\([.*+?^${}()|[\]])/g, '$1');
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) { return budget; }
    for (const entry of this.index()) {
      if (budget <= 0) { break; }
      const symbol = outlineFile(entry.absPath).symbols.find((s) => s.name === name);
      if (!symbol) { continue; }
      const result = this.tools.readFileSlice({ filePath: entry.relPath, startLine: symbol.startLine, endLine: symbol.endLine });
      return this.admit(slices, seen, budget, {
        filePath: entry.relPath, startLine: result.startLine, endLine: result.endLine, code: result.slice,
      });
    }
    return budget;
  }

  /** Budget gate: a slice is admitted whole or not at all. */
  private admit(slices: ContextSlice[], seen: Set<string>, budget: number, slice: ContextSlice): number {
    const key = `${slice.filePath}:${slice.startLine}`;
    if (seen.has(key) || slice.code.trim() === '') { return budget; }
    const cost = countTokens(slice.code) + 12; // +12 ≈ the header line
    if (cost > budget) { return budget; }
    seen.add(key);
    slices.push(slice);
    return budget - cost;
  }
}
