/**
 * Strip injected context blocks and example sections from an already-optimized
 * prompt before returning it.  Belt-and-suspenders against stale cache entries
 * that may have been seeded by older versions of the engine.
 */
export function sanitizeOptimizedPrompt(prompt: string): string {
  return prompt
    .replace(/(?:^|\n\n)# Problems\n[\s\S]*?(?=\n\n# |$)/g, '')
    .replace(/(?:^|\n\n)# Prompt (?:Proxy|Optimizer)[^\n]*\n[\s\S]*?(?=\n\n# |$)/gi, '')
    .replace(/(?:^|\n\n)<examples>[\s\S]*?<\/examples>(?=\n\n# |$)/gi, '')
    .replace(/(?:^|\n\n)### EXAMPLES[\s\S]*?(?=\n\n# |$)/g, '')
    .replace(/(?:^|\n\n)\*\*REFERENCE EXAMPLES\*\*[\s\S]*?(?=\n\n# |$)/g, '')
    .replace(/(?:^|\n\n)\[EXAMPLE\]:[\s\S]*?(?=\n\n# |$)/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function isInternalPromptSection(section: string): boolean {
  const trimmed = section.trimStart();
  return /^# Problems\b/i.test(trimmed) || /^# Prompt (?:Proxy|Optimizer)\b/i.test(trimmed);
}

export function containsLegacyExampleSection(prompt: string): boolean {
  return /<examples>|### EXAMPLES|\*\*REFERENCE EXAMPLES\*\*|\[EXAMPLE\]:/i.test(prompt);
}
