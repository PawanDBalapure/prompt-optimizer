import * as vscode from 'vscode';

import type { CustomSecretPatternConfig, SecretMatch } from '../types';
import {
  escapeRegExp,
  matchesExactLiteralAtBoundaries,
  sqlLikeToRegExp,
} from '../util/escape';
import { normalizeSecretPatternMode } from './secret-modes';

/** Patterns that may indicate accidental secret exposure in a prompt. */
export const SECRET_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: 'OpenAI API key', pattern: /\bsk-[a-zA-Z0-9]{20,}\b/ },
  { label: 'Anthropic API key', pattern: /\bsk-ant-[a-zA-Z0-9]{20,}\b/ },
  { label: 'GitHub token', pattern: /\bghp_[a-zA-Z0-9]{36}\b|\bghs_[a-zA-Z0-9]{36}\b/ },
  { label: 'AWS access key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: 'Private key header', pattern: /-----BEGIN (?:RSA|EC|OPENSSH|DSA) PRIVATE KEY-----/ },
  { label: 'Generic secret/token assignment', pattern: /(?:password|secret|token|api_?key)\s*[=:]\s*['"]?[a-zA-Z0-9+\/=_\-]{16,}['"]?/i },
];

const MAX_MATCH_DISPLAY = 60;
function clip(value: string, max = MAX_MATCH_DISPLAY): string {
  return value.length > max ? `${value.slice(0, max)}\u2026` : value;
}

function getPromptLinesForMatching(prompt: string): string[] {
  return prompt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** Returns the first matched text (truncated) for a custom pattern, or null. */
export function extractCustomSecretMatch(
  prompt: string,
  entry: CustomSecretPatternConfig,
): string | null {
  const pattern = entry.pattern?.trim() ?? '';
  if (pattern === '') { return null; }

  const mode = normalizeSecretPatternMode(entry.matchMode);
  const lowerPattern = pattern.toLowerCase();
  const targets = [prompt, ...getPromptLinesForMatching(prompt)];

  switch (mode) {
    case 'contains':
      for (const t of targets) {
        if (t.toLowerCase().includes(lowerPattern)) { return clip(pattern); }
      }
      return null;
    case 'startsWith':
      for (const t of targets) {
        if (t.toLowerCase().startsWith(lowerPattern)) { return clip(pattern); }
      }
      return null;
    case 'endsWith':
      for (const t of targets) {
        if (t.toLowerCase().endsWith(lowerPattern)) { return clip(pattern); }
      }
      return null;
    case 'exact':
      for (const t of targets) {
        if (matchesExactLiteralAtBoundaries(t, pattern)) { return clip(pattern); }
      }
      return null;
    case 'like': {
      const likeRegex = sqlLikeToRegExp(pattern);
      for (const t of targets) {
        const m = likeRegex.exec(t);
        if (m) { return clip(m[0]); }
      }
      return null;
    }
    case 'regex':
    default:
      try {
        const regex = new RegExp(pattern, 'i');
        for (const t of targets) {
          const m = regex.exec(t);
          if (m) { return clip(m[0]); }
        }
      } catch {
        /* invalid user regex — silently ignore */
      }
      return null;
  }
}

export function scanForSecrets(prompt: string): SecretMatch[] {
  const config = vscode.workspace.getConfiguration('promptProxy');
  if (config.get<boolean>('enableSecretDetection') === false) { return []; }

  const custom = config.get<CustomSecretPatternConfig[]>('secretPatterns') ?? [];
  const results: SecretMatch[] = [];
  // Dedup key: label + '::' + matched text — allows same label with different matches.
  const seen = new Set<string>();

  for (const builtIn of SECRET_PATTERNS) {
    const m = builtIn.pattern.exec(prompt);
    if (m) {
      const matched = clip(m[0]);
      const key = `${builtIn.label}::${matched}`;
      if (!seen.has(key)) {
        seen.add(key);
        results.push({ label: builtIn.label, matched });
      }
    }
  }

  for (const entry of custom) {
    const matched = extractCustomSecretMatch(prompt, entry);
    if (matched !== null) {
      const label = entry.label?.trim() || `Custom pattern ${results.length + 1}`;
      const key = `${label}::${matched}`;
      if (!seen.has(key)) {
        seen.add(key);
        results.push({ label, matched });
      }
    }
  }

  // Reference escapeRegExp so tree-shaking does not drop the helper for
  // downstream callers that wish to reuse it via this module's barrel.
  void escapeRegExp;
  return results;
}
