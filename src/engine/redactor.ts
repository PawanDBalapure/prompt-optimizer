/**
 * Centralised secret / PII redactor.  Applied at the *persistence boundary*
 * for any free-form text we are about to store on disk (workspace memory
 * snapshots, file digest summaries, optionally the optimized prompt itself).
 *
 * Design rules:
 *   1. **Never modify the prompt that flows through the optimization pipeline
 *      back to the user.** Redaction is only ever applied to the *copy* we
 *      are about to persist.  This keeps results faithful while still
 *      preventing secrets from leaving the user's box inside the local DB.
 *   2. **Conservative defaults**: detect things that look structurally like
 *      a secret (API keys, JWTs, AWS keys, private keys, bearer tokens,
 *      `*_KEY=` env assignments).  PII detection (email/phone) is opt-in via
 *      env `PROMPT_OPT_REDACT_PII=1`.
 *   3. **Disable kill-switch**: env `PROMPT_OPT_REDACT=0` turns the whole
 *      module into a no-op for users who self-host on an isolated box.
 *   4. **Deterministic**: the same input always produces the same output so
 *      idempotent writes don't churn rows.
 */

const REDACTION_DISABLED = (process.env.PROMPT_OPT_REDACT ?? '').toLowerCase() === '0';
const REDACT_PII         = (process.env.PROMPT_OPT_REDACT_PII ?? '').toLowerCase() === '1';

const REDACT_TOKEN = '[REDACTED]';

interface Rule {
  name: string;
  pattern: RegExp;
  replace?: (match: string) => string;
}

/** Order matters: longer/more specific patterns first. */
const BASE_RULES: Rule[] = [
  // PEM-style private keys (multi-line).
  {
    name: 'pem-private-key',
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY-----/g,
    replace: () => '-----BEGIN PRIVATE KEY-----\n[REDACTED]\n-----END PRIVATE KEY-----',
  },
  // AWS access key id.
  { name: 'aws-akid', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  // AWS secret access key (40 chars base64-ish, after the literal label).
  { name: 'aws-secret', pattern: /aws_secret_access_key\s*[:=]\s*['"]?([A-Za-z0-9/+=]{40})['"]?/gi, replace: () => 'aws_secret_access_key=[REDACTED]' },
  // Google API key.
  { name: 'gcp-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  // GitHub personal access tokens (classic + fine-grained + GHO/GHU/GHR).
  { name: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g },
  // Slack tokens.
  { name: 'slack-token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  // Stripe live keys.
  { name: 'stripe-key', pattern: /\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]{24,}\b/g },
  // OpenAI/Anthropic-style sk-... keys (>=20 chars after sk-).
  { name: 'sk-token', pattern: /\bsk-(?:proj-|ant-|live-|test-)?[A-Za-z0-9_-]{20,}\b/gi },
  // JSON Web Tokens (three base64url segments separated by dots).
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  // Bearer tokens in Authorization headers.
  { name: 'bearer', pattern: /\b(?:Bearer|Token)\s+[A-Za-z0-9._\-+/=]{16,}/gi, replace: () => 'Bearer [REDACTED]' },
  // .env-style secret assignments: SOMETHING_SECRET=xxx / SOMETHING_KEY=xxx / PASSWORD=xxx.
  {
    name: 'env-secret-assignment',
    pattern: /\b([A-Z][A-Z0-9_]{1,}(?:_SECRET|_TOKEN|_KEY|_PASSWORD|_API_KEY|PASSWORD|SECRET))\s*=\s*['"]?([^\s'"`]{6,})['"]?/g,
    replace: (m) => m.replace(/=\s*['"]?[^\s'"`]+['"]?$/, '=[REDACTED]'),
  },
  // Generic high-entropy hex/base64 token (>=32 chars) preceded by a "key/token/secret" hint word.
  {
    name: 'hinted-high-entropy',
    pattern: /\b(?:key|token|secret|password|passwd|pwd|apikey|api_key)["'\s:=]{1,4}([A-Za-z0-9+/=_\-]{32,})/gi,
    replace: (m) => m.replace(/[A-Za-z0-9+/=_\-]{32,}$/, REDACT_TOKEN),
  },
];

const PII_RULES: Rule[] = [
  // Email addresses (RFC-light).
  { name: 'email', pattern: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g },
  // International phone numbers (loose).
  { name: 'phone', pattern: /\b\+?\d{1,3}[\s.-]?\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,4}\b/g },
  // US-style SSNs (only when clearly formatted).
  { name: 'ssn', pattern: /\b\d{3}-\d{2}-\d{4}\b/g },
  // Credit-card-ish digit runs (13-19 digits, no surrounding alphanumerics).
  { name: 'card', pattern: /(?<![\w\d])\d{13,19}(?![\w\d])/g },
];

export interface RedactionResult {
  redacted: string;
  hits: Array<{ rule: string; count: number }>;
}

/**
 * Apply the active redaction rules to `text` and report which rules fired.
 * Returns the input unchanged when redaction is globally disabled.
 */
export function redactForPersistence(text: string): RedactionResult {
  if (REDACTION_DISABLED || typeof text !== 'string' || text.length === 0) {
    return { redacted: text, hits: [] };
  }

  const rules = REDACT_PII ? [...BASE_RULES, ...PII_RULES] : BASE_RULES;
  const hits = new Map<string, number>();
  let working = text;

  for (const rule of rules) {
    let count = 0;
    working = working.replace(rule.pattern, (match) => {
      count++;
      return rule.replace ? rule.replace(match) : REDACT_TOKEN;
    });
    if (count > 0) { hits.set(rule.name, (hits.get(rule.name) ?? 0) + count); }
  }

  return {
    redacted: working,
    hits: Array.from(hits.entries()).map(([rule, count]) => ({ rule, count })),
  };
}

/** Convenience: just the redacted text without metadata. */
export function redact(text: string): string {
  return redactForPersistence(text).redacted;
}

/** Test-only helper exposing whether the runtime has the layer enabled. */
export function redactionStatus(): { enabled: boolean; pii: boolean } {
  return { enabled: !REDACTION_DISABLED, pii: REDACT_PII };
}
