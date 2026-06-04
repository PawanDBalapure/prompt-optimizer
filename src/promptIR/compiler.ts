import { PromptIR, PromptDiagnostic } from '../contracts.js';

export type PromptTargetModel = 'claude' | 'gpt' | 'gemini' | 'deepseek' | 'grok' | 'local';

/** Compiles a PromptIR to model-family-specific prompting guidelines. */
export function compilePromptIR(
  ir: PromptIR,
  targetModel: PromptTargetModel,
  stackSummary?: string,
): string {
  const contextValue = stackSummary?.trim() || '[CONTEXT]';

  switch (targetModel) {
    case 'claude': return compileClaude(ir, contextValue);
    case 'gpt': return compileGpt(ir, contextValue);
    case 'gemini': return compileGemini(ir, contextValue);
    case 'deepseek': return compileDeepSeek(ir, contextValue);
    case 'grok': return compileGrok(ir, contextValue);
    case 'local':
    default: return compileLocal(ir, contextValue);
  }
}

function compileClaude(ir: PromptIR, contextValue: string): string {
  const lines: string[] = [];
  lines.push('Review the variables provided in the XML tags below:');
  lines.push('Before providing the final answer, think step-by-step inside <thinking> tags to plan your response.');
  lines.push('Provide your final output inside <response> tags. Do not include any introductory or concluding text outside the response tags.');
  lines.push('');
  lines.push('Resolved Inputs:');
  lines.push(`You are an expert ${valueOrPlaceholder(ir.role, '[ROLE]')}.`);
  lines.push(`<context>${contextValue}</context>`);
  lines.push(`<data>${buildSpecificData(ir)}</data>`);
  lines.push(`Execute this task: ${buildInstruction(ir)}.`);
  lines.push(`Adhere to these rules: ${buildParameters(ir)}.`);
  return lines.join('\n').trim();
}

function compileGpt(ir: PromptIR, contextValue: string): string {
  const lines: string[] = [];
  lines.push('# SYSTEM PRESET');
  lines.push('Act as directed below.');
  lines.push('');
  lines.push('# CRITICAL RESTRICTIONS');
  lines.push('- DO NOT write conversational pleasantries (e.g., "Sure, I can help").');
  lines.push(`- DO NOT exceed ${buildLengthGuard(ir)}.`);
  lines.push(`- NEVER use ${buildAvoidedStyles(ir)}.`);
  lines.push('');
  lines.push('# RESOLVED INPUTS');
  lines.push('# CONTEXT & BACKGROUND');
  lines.push(contextValue);
  lines.push('');
  lines.push('# CORE OBJECTIVE');
  lines.push(buildInstruction(ir));
  lines.push('');
  lines.push('# INPUT DATA');
  lines.push(`- ${buildSpecificData(ir)}`);
  lines.push('');
  lines.push('# OUTPUT STYLE & FORMAT');
  lines.push(`- Format: ${buildParameters(ir)}`);
  lines.push('');
  lines.push('# ROLE');
  lines.push(`Act as a ${valueOrPlaceholder(ir.role, '[ROLE]')}.`);
  return lines.join('\n').trim();
}

function compileDeepSeek(ir: PromptIR, contextValue: string): string {
  const lines: string[] = [];
  lines.push('Logical Constraints:');
  lines.push('- Your response must strictly solve for [PARAMETER].');
  lines.push('- Ensure your underlying mathematical/logical assumptions account for [CONSTRAINT].');
  lines.push('- Output directly in [FORMAT].');
  lines.push('');
  lines.push('Resolved Inputs:');
  lines.push(`Persona: Expert ${valueOrPlaceholder(ir.role, '[ROLE]')}.`);
  lines.push(`Context: ${contextValue}`);
  lines.push(`Task: ${buildInstruction(ir)} using the following dataset: ${buildSpecificData(ir)}.`);
  lines.push('');
  lines.push('Resolved Constraints:');
  lines.push(`- Parameter: ${buildPrimaryParameter(ir)}`);
  lines.push(`- Constraint: ${buildConstraintAnchor(ir)}`);
  lines.push(`- Format: ${buildFormatTarget(ir)}`);
  return lines.join('\n').trim();
}

function compileGemini(ir: PromptIR, contextValue: string): string {
  const lines: string[] = [];
  lines.push('[EXAMPLE]');
  lines.push('Example of desired output:');
  lines.push('Input: [Sample Input]');
  lines.push('Output: [Sample Perfect Output]');
  lines.push('');
  lines.push('Execution Rules:');
  lines.push('- Deliver the final output matching the example structure exactly.');
  lines.push('- Tone and Constraints: [PARAMETERS].');
  lines.push('');
  lines.push('Resolved Inputs:');
  lines.push(`Context: ${contextValue}`);
  lines.push(`Core Goal: ${buildInstruction(ir)} acting as a ${valueOrPlaceholder(ir.role, '[ROLE]')}.`);
  lines.push(`Data Source: ${buildSpecificData(ir)}`);
  lines.push('');
  lines.push('Resolved Example:');
  lines.push(`Input: ${buildSampleInput(ir)}`);
  lines.push(`Output: ${buildSampleOutput(ir)}`);
  lines.push(`Tone and Constraints: ${buildParameters(ir)}.`);
  return lines.join('\n').trim();
}

function compileGrok(ir: PromptIR, contextValue: string): string {
  const lines: string[] = [];
  lines.push('Output Requirements:');
  lines.push('- Be brutally direct and concise.');
  lines.push('- Format as [PARAMETERS].');
  lines.push('- Skip all pleasantries and deliver the answer immediately.');
  lines.push('');
  lines.push('Resolved Inputs:');
  lines.push(`Act as a sharp, highly efficient ${valueOrPlaceholder(ir.role, '[ROLE]')}.`);
  lines.push(`Current Context: ${contextValue}`);
  lines.push(`Task: Process ${buildSpecificData(ir)} and execute ${buildInstruction(ir)}.`);
  lines.push(`Resolved Format: ${buildParameters(ir)}.`);
  return lines.join('\n').trim();
}

function compileLocal(ir: PromptIR, contextValue: string): string {
  const lines: string[] = [];
  lines.push('[RULES]:');
  lines.push('- Follow role/context/task/data fields exactly as provided below.');
  lines.push('- Return output only in the requested format.');
  lines.push('');
  lines.push('Resolved Inputs:');
  lines.push(`[ROLE]: ${valueOrPlaceholder(ir.role, '[ROLE]')}`);
  lines.push(`[CONTEXT]: ${contextValue}`);
  lines.push(`[TASK]: ${buildInstruction(ir)}`);
  lines.push(`[DATA]: ${buildSpecificData(ir)}`);
  for (const rule of ir.constraints) { lines.push(`- ${rule}`); }
  if (ir.output_schema) {
    lines.push(`[FORMAT]: ${ir.output_schema.replace(/\s+/g, ' ')}`);
  }
  if (ir.reasoning_policy) { lines.push(`[THINK]: ${ir.reasoning_policy}`); }
  return lines.join('\n').trim();
}

function valueOrPlaceholder(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : fallback;
}

function buildInstruction(ir: PromptIR): string {
  return ir.inferred_task_type ? `${ir.inferred_task_type} task` : '[INSTRUCTION]';
}

function buildSpecificData(ir: PromptIR): string {
  void ir;
  return '[SPECIFIC DATA]';
}

function buildParameters(ir: PromptIR): string {
  if (ir.constraints.length > 0) {
    return ir.constraints.join('; ');
  }
  return '[PARAMETERS]';
}

function buildLengthGuard(ir: PromptIR): string {
  if (ir.output_schema && /\bbrief|concise|short|summary\b/i.test(ir.output_schema)) {
    return 'a concise length limit implied by the required format';
  }
  return '[LENGTH]';
}

function buildAvoidedStyles(ir: PromptIR): string {
  if (ir.reasoning_policy && ir.reasoning_policy.trim() !== '') {
    return `styles that violate: ${ir.reasoning_policy.trim()}`;
  }
  return '[WORDS/STYLES TO AVOID]';
}

function buildPrimaryParameter(ir: PromptIR): string {
  return ir.constraints[0] ?? '[PARAMETER]';
}

function buildConstraintAnchor(ir: PromptIR): string {
  return ir.constraints[1] ?? '[CONSTRAINT]';
}

function buildFormatTarget(ir: PromptIR): string {
  return ir.output_schema ? ir.output_schema.replace(/\s+/g, ' ') : '[FORMAT]';
}

function buildSampleInput(ir: PromptIR): string {
  return ir.examples[0] ?? '[Sample Input]';
}

function buildSampleOutput(ir: PromptIR): string {
  return ir.examples[1] ?? '[Sample Perfect Output]';
}

/** Explains the rewrite to humans/agents — used by the chat report. */
export function explainRewrite(
  ir: PromptIR,
  diagnostics: PromptDiagnostic[],
  targetModel: PromptTargetModel,
): string {
  const parts: string[] = [];
  parts.push(`### Why this rewrite? (Model: ${targetModel.toUpperCase()})`);
  parts.push(`1. **Inferred Task**: Detected task type as \`${ir.inferred_task_type}\`. Reorganized layout structures tailored to this goal.`);

  if (diagnostics.length > 0) {
    parts.push('2. **Resolved Diagnostics & Issues**:');
    for (const d of diagnostics) {
      parts.push(`   - *${d.code}*: ${d.message} (Mitigated by: ${d.fix_suggestion})`);
    }
  } else {
    parts.push('2. **Refinements**: Streamlined directive formatting, cleared redundancy/pleasantry words to maximize contextual efficiency.');
  }

  parts.push('3. **Compilation Tuning**: Compiled to model-optimal IR format:');
  if (targetModel === 'claude') {
    parts.push('   - Embedded instructions using XML structure tags to optimize Sonnet instruction-compliance.');
  } else if (targetModel === 'gpt') {
    parts.push('   - Formatted into SYSTEM/CONTEXT/OBJECTIVE markdown blocks with strict restriction clauses.');
  } else if (targetModel === 'gemini') {
    parts.push('   - Structured around explicit context-goal-data-example and execution-rule sections.');
  } else if (targetModel === 'deepseek') {
    parts.push('   - Applied logic-first Persona/Context/Task framing with explicit constraint bullets.');
  } else if (targetModel === 'grok') {
    parts.push('   - Applied terse direct-response framing with explicit no-pleasantries output requirements.');
  } else {
    parts.push('   - Compressed abstraction layers and simplified rules mapping to support bounded local reasoning windows (e.g. DeepSeek/Qwen).');
  }

  return parts.join('\n');
}
