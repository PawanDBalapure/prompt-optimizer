import { PromptIR, PromptDiagnostic, PromptCompilerSpec } from '../contracts.js';
import { buildCompilerSpec, renderStructuredSpec } from './promptCompiler.js';

export type PromptTargetModel = 'claude' | 'gpt' | 'gemini' | 'deepseek' | 'grok' | 'local';

/** Compiles a PromptIR to model-family-specific prompting guidelines. */
export function compilePromptIR(
  ir: PromptIR,
  targetModel: PromptTargetModel,
  stackSummary?: string,
  density: 'rich' | 'lean' = 'rich',
): string {
  const contextValue = stackSummary?.trim() || '[CONTEXT]';
  const spec = ir.compiler_spec ?? buildCompilerSpec('', ir);

  // We now always output YAML format, ignoring target model preamble wrapper.
  return renderStructuredSpec(spec, contextValue, density);
}

function valueOrPlaceholder(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : fallback;
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
