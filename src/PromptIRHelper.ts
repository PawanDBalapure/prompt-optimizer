import { PromptIR, PromptDiagnostic } from './contracts.js';

/**
 * Heuristically parses a raw prompt into a Structured Prompt IR
 */
export function parseToPromptIR(rawPrompt: string): PromptIR {
  const lines = rawPrompt.split(/\r?\n/);
  const constraints: string[] = [];
  const examples: string[] = [];
  let role = '';
  let outputSchema = '';
  let reasoningPolicy = '';

  let currentBlock: 'none' | 'example' | 'schema' | 'reasoning' = 'none';
  let exampleLines: string[] = [];

  // 1. Task type inference
  const lowerPrompt = rawPrompt.toLowerCase();
  let inferred_task_type: PromptIR['inferred_task_type'] = 'general';

  if (/\b(debug|fix|bug|crash|error|failing|exception|issue|trace|stack|resolve)\b/.test(lowerPrompt)) {
    inferred_task_type = 'debugging';
  } else if (/\b(spec|specification|rfc|requirements|design document|architecture|use case)\b/.test(lowerPrompt)) {
    inferred_task_type = 'spec-writing';
  } else if (/\b(research|explain|study|compare|difference|what is|how does|why does)\b/.test(lowerPrompt)) {
    inferred_task_type = 'research';
  } else if (/\b(write|implement|build|code|create|refactor|function|class|develop)\b/.test(lowerPrompt)) {
    inferred_task_type = 'coding';
  }

  // 2. Parsers line-by-line
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const trimmed = line.trim();

    if (trimmed === '') {
      if (currentBlock === 'example' && exampleLines.length > 0) {
        examples.push(exampleLines.join('\n').trim());
        exampleLines = [];
        currentBlock = 'none';
      }
      continue;
    }

    // Role detection
    if (!role && /^(you are|act as|as a\b)/i.test(trimmed)) {
      role = trimmed;
      continue;
    }

    // Detect tags/markers to set blocks
    if (trimmed.toLowerCase().includes('example:') || trimmed.toLowerCase().includes('for instance:') || trimmed.startsWith('```') || trimmed.toLowerCase().startsWith('input:') || trimmed.toLowerCase().startsWith('output:')) {
      if (currentBlock === 'example' && exampleLines.length > 0) {
        examples.push(exampleLines.join('\n').trim());
        exampleLines = [];
      }
      currentBlock = 'example';
    }

    if (/\b(schema|json format|output format|return json|use format|yaml format|table format)\b/i.test(trimmed)) {
      currentBlock = 'schema';
    }

    if (/\b(think step|explain reasoning|chain of thought|reason step|think aloud|reasoning policy)\b/i.test(trimmed)) {
      currentBlock = 'reasoning';
    }

    // Accumulate or classify
    if (currentBlock === 'example') {
      exampleLines.push(line);
    } else if (currentBlock === 'schema') {
      outputSchema += (outputSchema ? '\n' : '') + trimmed;
    } else if (currentBlock === 'reasoning') {
      reasoningPolicy += (reasoningPolicy ? '\n' : '') + trimmed;
    } else {
      // Check for constraints
      if (/^(?:must|should|never|only|ensure|limit|do not|don't|require|always|make sure)\b/i.test(trimmed) || trimmed.startsWith('-') || trimmed.startsWith('*') || /^\d+\./.test(trimmed)) {
        constraints.push(trimmed.replace(/^[-*\d.\s]+/, '').trim());
      } else if (trimmed.length > 10) {
        // General instructions could be constraints or text
        constraints.push(trimmed);
      }
    }
  }

  // Flush remaining example buffer
  if (exampleLines.length > 0) {
    examples.push(exampleLines.join('\n').trim());
  }

  // Fallback defaults
  if (role === '') {
    if (inferred_task_type === 'coding') {
      role = 'You are an expert software developer and software architect.';
    } else if (inferred_task_type === 'debugging') {
      role = 'You are an expert systems engineer and elite debugging assistant.';
    } else if (inferred_task_type === 'spec-writing') {
      role = 'You are a principal product manager and systems architect.';
    } else {
      role = 'You are a helpful software engineering assistant.';
    }
  }

  return {
    role,
    constraints: constraints.length > 0 ? constraints : ['Execute user request as accurately as possible.'],
    examples: examples.slice(0, 5),
    output_schema: outputSchema || undefined,
    reasoning_policy: reasoningPolicy || undefined,
    inferred_task_type,
  };
}

/**
 * Lints a raw prompt + PromptIR and generates structured diagnostics
 */
export function lintPrompt(rawPrompt: string, ir: PromptIR, totalContextTokens: number): PromptDiagnostic[] {
  const diagnostics: PromptDiagnostic[] = [];
  const lowerPrompt = rawPrompt.toLowerCase();
  
  // 1. Missing output format
  const hasOutputFormat = /\b(json|yaml|xml|markdown|csv|checklist|format|html|text|schema)\b/.test(lowerPrompt) || ir.output_schema !== undefined;
  if (!hasOutputFormat) {
    diagnostics.push({
      severity: 'warning',
      code: 'PROMPT_MISSING_OUTPUT_FORMAT',
      message: 'This task has no output format specified.',
      fix_suggestion: 'Specify the exact desired return layout (e.g. "Return a JSON object with keys \'status\' and \'details\'").'
    });
  }

  // 2. Unnecessary Chain of Thought (for simple constraints / quick lookups)
  const requestsCoT = /\b(think step|reason step|chain of thought|explain reasoning|walk me through|step-by-step)\b/.test(lowerPrompt);
  const isTrivialTask = lowerPrompt.length < 150 && (lowerPrompt.includes('json') || lowerPrompt.includes('format') || lowerPrompt.includes('translate'));
  if (requestsCoT && isTrivialTask) {
    diagnostics.push({
      severity: 'info',
      code: 'PROMPT_UNnecessary_COT',
      message: 'Prompt requests chain-of-thought unnecessarily.',
      fix_suggestion: 'For trivial formatting or translation queries, avoid requests like "think step-by-step" to save tokens and decrease latency.'
    });
  }

  // 3. Instruction order / reduction of compliance
  // Instructions/constraints located near the middle can be neglected by the model (Recency/Primacy effect)
  const indexOfPlease = lowerPrompt.indexOf('please');
  if (indexOfPlease > 0 && indexOfPlease < rawPrompt.length / 2 && ir.constraints.length > 3) {
    diagnostics.push({
      severity: 'warning',
      code: 'PROMPT_SUBOPTIMAL_INSTRUCTION_ORDER',
      message: 'Instruction order may reduce compliance.',
      fix_suggestion: 'Move critical instructions, strict rules, and negative constraints to the very start or the end of the prompt.'
    });
  }

  // 4. Reference undefined variables
  // Matches e.g. [file], {{name}}, <variable>
  const placeholderRegex = /([\[<{]{2,3}[a-zA-Z0-9_\-]+[\]>}]{2,3}|\[[a-zA-Z0-9_\-]+\])/g;
  const matches = rawPrompt.match(placeholderRegex) || [];
  for (const match of matches) {
    const varName = match.replace(/[\[\]<>{}]/g, '').toLowerCase();
    const isDefined = lowerPrompt.includes(`define ${varName}`) || lowerPrompt.includes(`here is ${varName}`) || lowerPrompt.includes(`${varName}:`);
    if (!isDefined && !['ts', 'js', 'py', 'java', 'kt', 'json', 'xml'].includes(varName)) {
      diagnostics.push({
        severity: 'error',
        code: 'PROMPT_UNDEFINED_VARIABLE',
        message: `You reference undefined variable "${match}".`,
        fix_suggestion: `Ensure you actually define the placeholder or append the corresponding file/context for "${match}".`
      });
      break; // trigger once
    }
  }

  // 5. Context budget analysis
  if (totalContextTokens > 12000) {
    diagnostics.push({
      severity: 'warning',
      code: 'PROMPT_EXCEEDS_CONTEXT_BUDGET',
      message: 'Prompt likely exceeds optimal local context budget.',
      fix_suggestion: 'Remove non-essential files, clear logs session buffer, or use the prompt optimizer compression rules to trim context tokens.'
    });
  }

  // 6. Ambiguity/vague success criteria
  const isVague = !/\b(test|assert|verify|criteria|expected|must|should|checklist|acceptance|validation|benchmark)\b/.test(lowerPrompt);
  if (isVague && ir.inferred_task_type !== 'research') {
    diagnostics.push({
      severity: 'warning',
      code: 'PROMPT_VAGUE_CRITERIA',
      message: 'Vague success criteria detected.',
      fix_suggestion: 'Add clear definitions of when the goal is met or the acceptance criteria of the code block.'
    });
  }

  // 7. Conflicting Instructions
  const asksForJson = /\bjson\b/.test(lowerPrompt);
  const asksForXml = /\bxml\b/.test(lowerPrompt);
  if (asksForJson && asksForXml) {
    diagnostics.push({
      severity: 'error',
      code: 'PROMPT_CONFLICTING_FORMATS',
      message: 'Conflicting instruction formats found: asks for both XML and JSON.',
      fix_suggestion: 'Choose a single target serialization schema rather than conflicting requirements.'
    });
  }

  const triesBeConcise = /\b(concise|brief|short|no explanation)\b/.test(lowerPrompt);
  const triesExplainInDetail = /\b(explain in detail|detailed explanation|step-by-step detail|verbose)\b/.test(lowerPrompt);
  if (triesBeConcise && triesExplainInDetail) {
    diagnostics.push({
      severity: 'error',
      code: 'PROMPT_CONFLICTING_VERBOSITY',
      message: 'Conflicting verbosity instructs found: "concise" versus "explain in detail".',
      fix_suggestion: 'Remove one of the instructions to avoid model confusion.'
    });
  }

  // 8. Injection vulnerability checking
  const hasBypassPatterns = /\b(ignore prior|ignore all previous|bypass|system prompt|reveal instructions|developer mode|dan mode)\b/.test(lowerPrompt);
  if (hasBypassPatterns) {
    diagnostics.push({
      severity: 'warning',
      code: 'PROMPT_INJECTION_RISK',
      message: 'Prompt contains words associated with prompt-injection risks.',
      fix_suggestion: 'Clean any untrusted instructions. Ensure a system block sets absolute precedence if handling arbitrary text.'
    });
  }

  return diagnostics;
}

/**
 * Compiles a PromptIR to model family specific prompting guidelines
 */
export function compilePromptIR(
  ir: PromptIR,
  targetModel: 'claude' | 'gpt' | 'gemini' | 'local',
  stackSummary?: string
): string {
  const lines: string[] = [];

  // Inject repository/stack summaries if present
  if (stackSummary) {
    lines.push(`System Context / Repository Architecture:`, stackSummary, '');
  }

  switch (targetModel) {
    case 'claude':
      lines.push('<instructions>');
      if (ir.role) {
        lines.push(`  <role>${ir.role}</role>`);
      }
      lines.push(`  <task_type>${ir.inferred_task_type}</task_type>`);
      lines.push('  <directives>');
      for (const rule of ir.constraints) {
        lines.push(`    <rule>${rule}</rule>`);
      }
      lines.push('  </directives>');

      if (ir.output_schema) {
        lines.push(`  <output_format>\n    ${ir.output_schema.split('\n').join('\n    ')}\n  </output_format>`);
      }
      if (ir.reasoning_policy) {
        lines.push(`  <reasoning_guideline>\n    ${ir.reasoning_policy.split('\n').join('\n    ')}\n  </reasoning_guideline>`);
      }
      lines.push('</instructions>');

      break;

    case 'gpt':
      lines.push(`### ROLE\n${ir.role}\n`);
      lines.push(`### TASK TYPE\n${ir.inferred_task_type}\n`);
      lines.push(`### CONSTRAINTS & DIRECTIVES`);
      for (const rule of ir.constraints) {
        lines.push(`* ${rule}`);
      }
      lines.push('');

      if (ir.output_schema) {
        lines.push(`### OUTPUT SCHEMA / FORMAT\n${ir.output_schema}\n`);
      }
      if (ir.reasoning_policy) {
        lines.push(`### REASONING\n${ir.reasoning_policy}\n`);
      }
      break;

    case 'gemini':
      lines.push(`**ROLE & OBJECTIVE**\n> ${ir.role}\n`);
      lines.push(`*Task Category: ${(ir.inferred_task_type ?? 'general').toUpperCase()}*\n`);
      lines.push(`**CRITICAL REQUIREMENTS**`);
      for (const rule of ir.constraints) {
        lines.push(`- **MUST**: ${rule}`);
      }
      lines.push('');

      if (ir.output_schema) {
        lines.push(`**CHOSEN RESPONSE FORMAT/STRUCTURE**\n\`\`\`\n${ir.output_schema}\n\`\`\`\n`);
      }
      if (ir.reasoning_policy) {
        lines.push(`**THINKING STRATEGY**\n${ir.reasoning_policy}\n`);
      }
      break;

    case 'local':
    default:
      // Local tuning optimized for smaller sizes, e.g. Qwen / DeepSeek.
      // radical instruction compression, explicit delineators, no deep nesting.
      lines.push(`[ROLE]: ${ir.role}`);
      lines.push(`[TASK]: ${ir.inferred_task_type}`);
      lines.push(`[RULES]:`);
      // Keep it compressed
      const limitRules = ir.constraints.slice(0, 4);
      for (const rule of limitRules) {
        lines.push(`- ${rule}`);
      }
      if (ir.output_schema) {
        lines.push(`[FORMAT]: Return ONLY output complying with: ${ir.output_schema.replace(/\s+/g, ' ')}`);
      }
      if (ir.reasoning_policy) {
        lines.push(`[THINK]: ${ir.reasoning_policy}`);
      }
      break;
  }

  return lines.join('\n').trim();
}

/**
 * Explains "Why this rewrite?"
 */
export function explainRewrite(
  ir: PromptIR,
  diagnostics: PromptDiagnostic[],
  targetModel: 'claude' | 'gpt' | 'gemini' | 'local'
): string {
  const parts: string[] = [];
  parts.push(`### Why this rewrite? (Model: ${targetModel.toUpperCase()})`);
  parts.push(`1. **Inferred Task**: Detected task type as \`${ir.inferred_task_type}\`. Reorganized layout structures tailored to this goal.`);
  
  if (diagnostics.length > 0) {
    parts.push(`2. **Resolved Diagnostics & Issues**:`);
    for (const d of diagnostics) {
      parts.push(`   - *${d.code}*: ${d.message} (Mitigated by: ${d.fix_suggestion})`);
    }
  } else {
    parts.push(`2. **Refinements**: Streamlined directive formatting, cleared redundancy/pleasantry words to maximize contextual efficiency.`);
  }

  parts.push(`3. **Compilation Tuning**: Compiled to model-optimal IR format:`);
  if (targetModel === 'claude') {
    parts.push(`   - Embedded instructions using XML structure tags to optimize Sonnet instruction-compliance.`);
  } else if (targetModel === 'gpt') {
    parts.push(`   - Formatted into concise instructions, placing imperative constraints at primacy/recency hotzones.`);
  } else if (targetModel === 'gemini') {
    parts.push(`   - Highlighted key constraints clearly to assist cross-modal grounding compliance.`);
  } else {
    parts.push(`   - Compressed abstraction layers and simplified rules mapping to support bounded local reasoning windows (e.g. DeepSeek/Qwen).`);
  }

  return parts.join('\n');
}
