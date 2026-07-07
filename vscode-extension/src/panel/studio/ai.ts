import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { workspaceRoot } from '../../instructions/paths';

/** Deterministic local "AI" rewrite of a rule, per refinement mode. */
export async function postRuleRefinement(
  webview: vscode.Webview,
  mode?: string,
  text?: string,
): Promise<void> {
  const original = String(text || '').trim();
  if (!original) {
    await webview.postMessage({
      type: 'aiSuggestion',
      suggestion: null,
      error: 'Select a rule and provide text before refinement.',
    });
    return;
  }

  const normalized = original.replace(/\s+/g, ' ').trim();
  let proposed = normalized;
  const op = String(mode || 'improve').trim();
  if (op === 'simplify') {
    proposed = normalized
      .replace(/\bexplicitly\b|\bcarefully\b|\bthoroughly\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!/[.!?]$/.test(proposed)) { proposed += '.'; }
  } else if (op === 'expand') {
    proposed = `${normalized} Include assumptions, risks, and concrete verification steps before completion.`;
  } else if (op === 'find-conflicts') {
    proposed = `${normalized} Potential conflict check: compare against rules forbidding edits in the same domain.`;
  } else if (op === 'find-duplicates') {
    proposed = `${normalized} Duplicate check key: ${normalized.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()}`;
  } else {
    const sentence = normalized.charAt(0).toLowerCase() + normalized.slice(1);
    proposed = `Ensure ${sentence}`;
    if (!/[.!?]$/.test(proposed)) { proposed += '.'; }
  }

  await webview.postMessage({
    type: 'aiSuggestion',
    suggestion: { mode: op, original, proposed },
  });
}

/** Suggest a persona by scanning workspace file names for domain signals. */
export async function postPersonaSuggestion(webview: vscode.Webview): Promise<void> {
  const wsRoot = workspaceRoot();
  if (!wsRoot) {
    await webview.postMessage({ type: 'personaSuggestion', suggestion: null });
    return;
  }
  const files: string[] = [];
  const scan = (dir: string, depth: number): void => {
    if (depth > 3) { return; }
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) { continue; }
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scan(abs, depth + 1);
      } else if (/\.(ts|tsx|js|jsx|py|java|kt|md)$/i.test(entry.name)) {
        files.push(path.relative(wsRoot, abs).replace(/\\/g, '/'));
      }
    }
  };
  scan(wsRoot, 0);

  const corpus = files.join(' ').toLowerCase();
  const label = /security|auth|token|credential/.test(corpus)
    ? 'Security Reviewer'
    : /test|spec|assert/.test(corpus)
      ? 'Testing Strategist'
      : 'Architecture Reviewer';
  const ruleText = label === 'Security Reviewer'
    ? 'Validate user inputs and summarize security risks before completion.'
    : label === 'Testing Strategist'
      ? 'Require tests for behavior changes and call out missing coverage explicitly.'
      : 'Preserve architecture consistency and highlight coupling risks before completion.';

  await webview.postMessage({
    type: 'personaSuggestion',
    suggestion: {
      label,
      persona: label,
      condition: 'Always',
      priority: 'High',
      agentScope: 'Review',
      ruleText,
    },
  });
}
