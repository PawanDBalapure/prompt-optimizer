import { PromptIR, PromptDiagnostic } from '../contracts.js';

export type PromptTargetModel = 'claude' | 'gpt' | 'gemini' | 'local';

/** Compiles a PromptIR to model-family-specific prompting guidelines. */
export function compilePromptIR(
  ir: PromptIR,
  targetModel: PromptTargetModel,
  stackSummary?: string,
): string {
  const lines: string[] = [];

  if (stackSummary) {
    lines.push('System Context / Repository Architecture:', stackSummary, '');
  }

  switch (targetModel) {
    case 'claude': return compileClaude(ir, lines);
    case 'gpt': return compileGpt(ir, lines);
    case 'gemini': return compileGemini(ir, lines);
    case 'local':
    default: return compileLocal(ir, lines);
  }
}

function compileClaude(ir: PromptIR, lines: string[]): string {
  lines.push('<instructions>');
  if (ir.role) { lines.push(`  <role>${ir.role}</role>`); }
  lines.push(`  <task_type>${ir.inferred_task_type}</task_type>`);
  lines.push('  <directives>');
  for (const rule of ir.constraints) { lines.push(`    <rule>${rule}</rule>`); }
  lines.push('  </directives>');
  if (ir.output_schema) {
    lines.push(`  <output_format>\n    ${ir.output_schema.split('\n').join('\n    ')}\n  </output_format>`);
  }
  if (ir.reasoning_policy) {
    lines.push(`  <reasoning_guideline>\n    ${ir.reasoning_policy.split('\n').join('\n    ')}\n  </reasoning_guideline>`);
  }
  lines.push('</instructions>');
  return lines.join('\n').trim();
}

function compileGpt(ir: PromptIR, lines: string[]): string {
  lines.push(`### ROLE\n${ir.role}\n`);
  lines.push(`### TASK TYPE\n${ir.inferred_task_type}\n`);
  lines.push('### CONSTRAINTS & DIRECTIVES');
  for (const rule of ir.constraints) { lines.push(`* ${rule}`); }
  lines.push('');
  if (ir.output_schema) { lines.push(`### OUTPUT SCHEMA / FORMAT\n${ir.output_schema}\n`); }
  if (ir.reasoning_policy) { lines.push(`### REASONING\n${ir.reasoning_policy}\n`); }
  return lines.join('\n').trim();
}

function compileGemini(ir: PromptIR, lines: string[]): string {
  lines.push(`**ROLE & OBJECTIVE**\n> ${ir.role}\n`);
  lines.push(`*Task Category: ${(ir.inferred_task_type ?? 'general').toUpperCase()}*\n`);
  lines.push('**CRITICAL REQUIREMENTS**');
  for (const rule of ir.constraints) { lines.push(`- **MUST**: ${rule}`); }
  lines.push('');
  if (ir.output_schema) {
    lines.push(`**CHOSEN RESPONSE FORMAT/STRUCTURE**\n\`\`\`\n${ir.output_schema}\n\`\`\`\n`);
  }
  if (ir.reasoning_policy) { lines.push(`**THINKING STRATEGY**\n${ir.reasoning_policy}\n`); }
  return lines.join('\n').trim();
}

function compileLocal(ir: PromptIR, lines: string[]): string {
  // Tuned for smaller local models (Qwen / DeepSeek): radical instruction
  // compression, explicit delineators, no deep nesting.  We keep every
  // distinct rule the user supplied — silently dropping rules truncated the
  // optimized prompt and lost intent; brevity is achieved by compression
  // upstream (textOptimizer) and de-duplication, not by clipping content.
  lines.push(`[ROLE]: ${ir.role}`);
  lines.push(`[TASK]: ${ir.inferred_task_type}`);
  lines.push('[RULES]:');
  for (const rule of ir.constraints) { lines.push(`- ${rule}`); }
  if (ir.output_schema) {
    lines.push(`[FORMAT]: Return ONLY output complying with: ${ir.output_schema.replace(/\s+/g, ' ')}`);
  }
  if (ir.reasoning_policy) { lines.push(`[THINK]: ${ir.reasoning_policy}`); }
  return lines.join('\n').trim();
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
    parts.push('   - Formatted into concise instructions, placing imperative constraints at primacy/recency hotzones.');
  } else if (targetModel === 'gemini') {
    parts.push('   - Highlighted key constraints clearly to assist cross-modal grounding compliance.');
  } else {
    parts.push('   - Compressed abstraction layers and simplified rules mapping to support bounded local reasoning windows (e.g. DeepSeek/Qwen).');
  }

  return parts.join('\n');
}
