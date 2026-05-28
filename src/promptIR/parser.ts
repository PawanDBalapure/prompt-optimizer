import { PromptIR } from '../contracts.js';

/** Heuristically parses a raw prompt into a Structured Prompt IR. */
export function parseToPromptIR(rawPrompt: string): PromptIR {
  const lines = rawPrompt.split(/\r?\n/);
  const constraints: string[] = [];
  const examples: string[] = [];
  let role = '';
  let outputSchema = '';
  let reasoningPolicy = '';

  let currentBlock: 'none' | 'example' | 'schema' | 'reasoning' = 'none';
  let exampleLines: string[] = [];

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

    if (!role && /^(you are|act as|as a\b)/i.test(trimmed)) {
      role = trimmed;
      continue;
    }

    if (trimmed.toLowerCase().includes('example:')
      || trimmed.toLowerCase().includes('for instance:')
      || trimmed.startsWith('```')
      || trimmed.toLowerCase().startsWith('input:')
      || trimmed.toLowerCase().startsWith('output:')) {
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

    if (currentBlock === 'example') {
      exampleLines.push(line);
    } else if (currentBlock === 'schema') {
      outputSchema += (outputSchema ? '\n' : '') + trimmed;
    } else if (currentBlock === 'reasoning') {
      reasoningPolicy += (reasoningPolicy ? '\n' : '') + trimmed;
    } else {
      if (/^(?:must|should|never|only|ensure|limit|do not|don't|require|always|make sure)\b/i.test(trimmed)
        || trimmed.startsWith('-') || trimmed.startsWith('*') || /^\d+\./.test(trimmed)) {
        constraints.push(trimmed.replace(/^[-*\d.\s]+/, '').trim());
      } else if (trimmed.length > 10) {
        constraints.push(trimmed);
      }
    }
  }

  if (exampleLines.length > 0) {
    examples.push(exampleLines.join('\n').trim());
  }

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
