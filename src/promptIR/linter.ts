import { PromptIR, PromptDiagnostic } from '../contracts.js';
import { evaluateBestPractices, findingsToDiagnostics } from '../engine/bestPractices.js';

/**
 * Lints a raw prompt + PromptIR and emits structured diagnostics.
 *
 * @param targetModel Optional model family — when provided, model-specific
 *   best-practice checks (e.g. Claude XML, GPT delimiters) are appended.
 */
export function lintPrompt(
  rawPrompt: string,
  ir: PromptIR,
  totalContextTokens: number,
  targetModel: 'claude' | 'gpt' | 'gemini' | 'deepseek' | 'grok' | 'local' = 'local',
): PromptDiagnostic[] {
  const diagnostics: PromptDiagnostic[] = [];
  const lowerPrompt = rawPrompt.toLowerCase();

  const hasOutputFormat = /\b(json|yaml|xml|markdown|csv|checklist|format|html|text|schema)\b/.test(lowerPrompt)
    || ir.output_schema !== undefined;
  if (!hasOutputFormat) {
    diagnostics.push({
      severity: 'warning',
      code: 'PROMPT_MISSING_OUTPUT_FORMAT',
      message: 'This task has no output format specified.',
      fix_suggestion: 'Specify the exact desired return layout (e.g. "Return a JSON object with keys \'status\' and \'details\'").',
    });
  }

  const requestsCoT = /\b(think step|reason step|chain of thought|explain reasoning|walk me through|step-by-step)\b/.test(lowerPrompt);
  const isTrivialTask = lowerPrompt.length < 150
    && (lowerPrompt.includes('json') || lowerPrompt.includes('format') || lowerPrompt.includes('translate'));
  if (requestsCoT && isTrivialTask) {
    diagnostics.push({
      severity: 'info',
      code: 'PROMPT_UNnecessary_COT',
      message: 'Prompt requests chain-of-thought unnecessarily.',
      fix_suggestion: 'For trivial formatting or translation queries, avoid requests like "think step-by-step" to save tokens and decrease latency.',
    });
  }

  const indexOfPlease = lowerPrompt.indexOf('please');
  if (indexOfPlease > 0 && indexOfPlease < rawPrompt.length / 2 && ir.constraints.length > 3) {
    diagnostics.push({
      severity: 'warning',
      code: 'PROMPT_SUBOPTIMAL_INSTRUCTION_ORDER',
      message: 'Instruction order may reduce compliance.',
      fix_suggestion: 'Move critical instructions, strict rules, and negative constraints to the very start or the end of the prompt.',
    });
  }

  const placeholderRegex = /([\[<{]{2,3}[a-zA-Z0-9_\-]+[\]>}]{2,3}|\[[a-zA-Z0-9_\-]+\])/g;
  const matches = rawPrompt.match(placeholderRegex) || [];
  for (const match of matches) {
    const varName = match.replace(/[\[\]<>{}]/g, '').toLowerCase();
    const isDefined = lowerPrompt.includes(`define ${varName}`)
      || lowerPrompt.includes(`here is ${varName}`)
      || lowerPrompt.includes(`${varName}:`);
    if (!isDefined && !['ts', 'js', 'py', 'java', 'kt', 'json', 'xml'].includes(varName)) {
      diagnostics.push({
        severity: 'error',
        code: 'PROMPT_UNDEFINED_VARIABLE',
        message: `You reference undefined variable "${match}".`,
        fix_suggestion: `Ensure you actually define the placeholder or append the corresponding file/context for "${match}".`,
      });
      break;
    }
  }

  if (totalContextTokens > 12000) {
    diagnostics.push({
      severity: 'warning',
      code: 'PROMPT_EXCEEDS_CONTEXT_BUDGET',
      message: 'Prompt likely exceeds optimal local context budget.',
      fix_suggestion: 'Remove non-essential files, clear logs session buffer, or use the prompt optimizer compression rules to trim context tokens.',
    });
  }

  const isVague = !/\b(test|assert|verify|criteria|expected|must|should|checklist|acceptance|validation|benchmark)\b/.test(lowerPrompt);
  if (isVague && ir.inferred_task_type !== 'research') {
    diagnostics.push({
      severity: 'warning',
      code: 'PROMPT_VAGUE_CRITERIA',
      message: 'Vague success criteria detected.',
      fix_suggestion: 'Add clear definitions of when the goal is met or the acceptance criteria of the code block.',
    });
  }

  const asksForJson = /\bjson\b/.test(lowerPrompt);
  const asksForXml = /\bxml\b/.test(lowerPrompt);
  if (asksForJson && asksForXml) {
    diagnostics.push({
      severity: 'error',
      code: 'PROMPT_CONFLICTING_FORMATS',
      message: 'Conflicting instruction formats found: asks for both XML and JSON.',
      fix_suggestion: 'Choose a single target serialization schema rather than conflicting requirements.',
    });
  }

  const triesBeConcise = /\b(concise|brief|short|no explanation)\b/.test(lowerPrompt);
  const triesExplainInDetail = /\b(explain in detail|detailed explanation|step-by-step detail|verbose)\b/.test(lowerPrompt);
  if (triesBeConcise && triesExplainInDetail) {
    diagnostics.push({
      severity: 'error',
      code: 'PROMPT_CONFLICTING_VERBOSITY',
      message: 'Conflicting verbosity instructs found: "concise" versus "explain in detail".',
      fix_suggestion: 'Remove one of the instructions to avoid model confusion.',
    });
  }

  const hasBypassPatterns = /\b(ignore prior|ignore all previous|bypass|system prompt|reveal instructions|developer mode|dan mode)\b/.test(lowerPrompt);
  if (hasBypassPatterns) {
    diagnostics.push({
      severity: 'warning',
      code: 'PROMPT_INJECTION_RISK',
      message: 'Prompt contains words associated with prompt-injection risks.',
      fix_suggestion: 'Clean any untrusted instructions. Ensure a system block sets absolute precedence if handling arbitrary text.',
    });
  }

  // Append Anthropic + OpenAI best-practice findings.  These cover persona
  // specificity, XML/markdown delimiters, few-shot examples, reasoning hints,
  // explicit output schemas, success criteria, and negative constraints —
  // areas the original heuristic checks above do not cover.
  diagnostics.push(...findingsToDiagnostics(evaluateBestPractices(rawPrompt, ir, targetModel)));

  return diagnostics;
}
