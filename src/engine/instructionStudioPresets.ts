export interface InstructionStudioPreset {
  id: string;
  category: 'Security' | 'Testing' | 'Performance' | 'Git & Review';
  label: string;
  workflowName: string;
  persona: string;
  condition: string;
  priority: 'Critical' | 'High' | 'Medium' | 'Low';
  agentScope: 'Code Generation' | 'Review' | 'Testing' | 'Security Analysis';
  ruleText: string;
}

export const INSTRUCTION_STUDIO_PRESETS: InstructionStudioPreset[] = [
  {
    id: 'security-input-validation',
    category: 'Security',
    label: 'Validate Inputs',
    workflowName: 'Security Hardening',
    persona: 'Security Expert',
    condition: 'If endpoint accepts user payload',
    priority: 'High',
    agentScope: 'Security Analysis',
    ruleText: 'Validate request payloads before database writes and return explicit error details.',
  },
  {
    id: 'testing-refactor-coverage',
    category: 'Testing',
    label: 'Refactor Test Gate',
    workflowName: 'Refactor Safeguard',
    persona: 'Architect',
    condition: 'If Task=Refactor',
    priority: 'Critical',
    agentScope: 'Testing',
    ruleText: 'Always run unit tests before completing changes and add tests for modified behavior.',
  },
  {
    id: 'performance-hotpath-budget',
    category: 'Performance',
    label: 'Hot Path Budget',
    workflowName: 'Performance Budget',
    persona: 'Performance Engineer',
    condition: 'If touching request hot path',
    priority: 'High',
    agentScope: 'Review',
    ruleText: 'Prefer O(n) approaches, avoid unnecessary allocations, and call out latency impact explicitly.',
  },
  {
    id: 'git-review-risk-summary',
    category: 'Git & Review',
    label: 'Review Risk Summary',
    workflowName: 'Review Readiness',
    persona: 'Code Reviewer',
    condition: 'Before final output',
    priority: 'Medium',
    agentScope: 'Review',
    ruleText: 'Summarize behavioral risks and list affected files before marking work complete.',
  },
];
