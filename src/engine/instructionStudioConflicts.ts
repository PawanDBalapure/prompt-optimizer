import type { InstructionStudioGraph } from './instructionStudio.js';

export interface InstructionStudioConflict {
  code: string;
  severity: 'warning' | 'error';
  message: string;
  nodeIds: string[];
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

type IntentDomain = 'package-dependencies' | 'tests' | 'security' | 'files' | 'general';
type IntentVerb = 'edit' | 'update' | 'add' | 'remove' | 'validate' | 'review' | 'none';

interface RuleIntentAst {
  domain: IntentDomain;
  verb: IntentVerb;
  allowsMutation: boolean;
  forbidsMutation: boolean;
}

function parseIntentAst(normalizedRuleText: string): RuleIntentAst {
  const hasPackage = /\bpackage json\b|\bdependencies\b/.test(normalizedRuleText);
  const hasTests = /\btest\b|\bunit tests\b|\bregression\b/.test(normalizedRuleText);
  const hasSecurity = /\bsecurity\b|\bvalidate\b|\brisk\b/.test(normalizedRuleText);
  const hasFiles = /\bfile\b|\bfiles\b|\bpath\b/.test(normalizedRuleText);

  const domain: IntentDomain = hasPackage
    ? 'package-dependencies'
    : hasTests
      ? 'tests'
      : hasSecurity
        ? 'security'
        : hasFiles
          ? 'files'
          : 'general';

  const forbidsMutation = /\bnever edit\b|\bdo not edit\b|\bdon t edit\b|\bavoid editing\b/.test(normalizedRuleText);
  const allowsMutation = /\bedit\b|\bupdate\b|\badd\b|\bremove\b/.test(normalizedRuleText);

  const verb: IntentVerb = /\bupdate\b/.test(normalizedRuleText)
    ? 'update'
    : /\badd\b/.test(normalizedRuleText)
      ? 'add'
      : /\bremove\b/.test(normalizedRuleText)
        ? 'remove'
        : /\bvalidate\b/.test(normalizedRuleText)
          ? 'validate'
          : /\breview\b/.test(normalizedRuleText)
            ? 'review'
            : /\bedit\b/.test(normalizedRuleText)
              ? 'edit'
              : 'none';

  return { domain, verb, allowsMutation, forbidsMutation };
}

export function detectInstructionStudioConflicts(graph: InstructionStudioGraph): InstructionStudioConflict[] {
  const conflicts: InstructionStudioConflict[] = [];
  const ruleNodes = graph.nodes.filter((n) => n.type === 'rule' && n.active !== false);
  const rules = ruleNodes
    .map((n) => {
      const norm = normalize(n.text ?? n.label ?? '');
      return { id: n.id, text: (n.text ?? n.label ?? '').trim(), norm, ast: parseIntentAst(norm) };
    })
    .filter((r) => r.text.length > 0);

  const seen = new Map<string, string>();
  for (const r of rules) {
    const existing = seen.get(r.norm);
    if (existing) {
      conflicts.push({
        code: 'duplicate-rule',
        severity: 'warning',
        message: 'Duplicate rule text detected in active graph.',
        nodeIds: [existing, r.id],
      });
    } else {
      seen.set(r.norm, r.id);
    }
  }

  for (let i = 0; i < rules.length; i++) {
    for (let j = i + 1; j < rules.length; j++) {
      const a = rules[i];
      const b = rules[j];
      const sameDomain = a.ast.domain === b.ast.domain;
      const opposingMutation =
        (a.ast.forbidsMutation && b.ast.allowsMutation)
        || (b.ast.forbidsMutation && a.ast.allowsMutation);

      if (sameDomain && opposingMutation) {
        conflicts.push({
          code: 'opposing-edit-intent',
          severity: 'warning',
          message: `Potential opposing intent in ${a.ast.domain}: one rule forbids edits while another requests mutation.`,
          nodeIds: [a.id, b.id],
        });
      }
    }
  }

  if (graph.nodes.length === 0) {
    conflicts.push({
      code: 'empty-graph',
      severity: 'error',
      message: 'Graph has no nodes.',
      nodeIds: [],
    });
  }

  if (ruleNodes.length === 0) {
    conflicts.push({
      code: 'no-active-rules',
      severity: 'warning',
      message: 'No active rule nodes found.',
      nodeIds: [],
    });
  }

  return conflicts;
}
