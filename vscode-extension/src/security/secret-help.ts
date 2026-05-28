import type { SecretPatternMatchMode } from '../types';
import { escapeHtml } from '../util/escape';
import { SECRET_PATTERN_MODE_LABELS } from './secret-modes';

const SECRET_PATTERN_MODE_HELP: Array<{ mode: SecretPatternMatchMode; note: string; example: string }> = [
  { mode: 'regex', note: 'Use full JavaScript regex for precise token shapes. Regex is checked against the whole prompt and each individual line.', example: String.raw`\bacme_(live|test)_[A-Za-z0-9]{32}\b` },
  { mode: 'like', note: 'SQL LIKE semantics checked against the whole prompt and each individual line. `%` matches any run, `_` matches one character.', example: '%Authorization: Bearer%' },
  { mode: 'contains', note: 'Case-insensitive literal substring checked against the whole prompt and each individual line.', example: 'Authorization: Bearer' },
  { mode: 'startsWith', note: 'Case-insensitive match when any individual line begins with the value.', example: 'sk-' },
  { mode: 'endsWith', note: 'Case-insensitive match when any individual line ends with the value.', example: '-----END PRIVATE KEY-----' },
  { mode: 'exact', note: 'Case-insensitive literal match at token boundaries on the whole prompt or on any individual line, so the value is treated as a standalone secret and not just any substring.', example: 'ghp_exampletokenvalue' },
];

const SECRET_PATTERN_HELP_EXAMPLES: Array<{ label: string; mode: SecretPatternMatchMode; pattern: string; note: string }> = [
  { label: 'Acme API token', mode: 'regex', pattern: String.raw`\bacme_(live|test)_[A-Za-z0-9]{32}\b`, note: 'Good when your secrets always start with a known prefix like acme_live_.' },
  { label: 'JWT bearer token', mode: 'regex', pattern: String.raw`\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b`, note: 'Good for catching raw JWTs that users accidentally paste.' },
  { label: 'Billing service key', mode: 'regex', pattern: String.raw`\bbill_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b`, note: 'Good when keys use a namespace plus UUID.' },
  { label: 'Internal DB connection string', mode: 'regex', pattern: String.raw`\bServer=[^;\s]+;Database=[^;\s]+;User Id=[^;\s]+;Password=[^;\s]+;?\b`, note: 'Good for structured credentials that are often pasted whole.' },
  { label: 'Payments secret env var', mode: 'regex', pattern: String.raw`\bPAYMENTS_SECRET\s*=\s*['"]?[A-Za-z0-9._-]{24,}['"]?`, note: 'Good when developers paste .env snippets into prompts.' },
  { label: 'Authorization bearer header', mode: 'contains', pattern: 'Authorization: Bearer', note: 'Good for catching copied HTTP headers without writing regex.' },
  { label: 'PromptProxy staging token', mode: 'regex', pattern: String.raw`\bppx_(dev|staging|prod)_[A-Za-z0-9]{40}\b`, note: 'Good if you own the token format and want very low false positives.' },
  { label: 'Generic app secret assignment', mode: 'regex', pattern: String.raw`\b(app_secret|client_secret|signing_key)\s*[:=]\s*['"]?[A-Za-z0-9+/=]{24,}['"]?`, note: 'Good when the same secret may appear in config snippets with different values.' },
  { label: 'SSH private key', mode: 'startsWith', pattern: '-----BEGIN ', note: 'Good for catastrophic copy-paste mistakes, especially key blocks.' },
  { label: 'Slack token', mode: 'regex', pattern: String.raw`\bxox[baprs]-[A-Za-z0-9-]{10,}\b`, note: 'Good if your team frequently pastes chat or webhook configs.' },
  { label: 'Internal webhook secret URL', mode: 'regex', pattern: String.raw`\bhttps://hooks\.acme\.internal/[A-Za-z0-9/_-]*token=[A-Za-z0-9]{24,}\b`, note: 'Good when the secret lives inside a URL query or path.' },
  { label: 'Vector index key', mode: 'regex', pattern: String.raw`\bvec_[A-F0-9]{48}\b`, note: 'Good when you have machine-generated uppercase hex keys.' },
];

const SECRET_PATTERN_HELP_BEST_PRACTICES = [
  'Prefer exact prefixes like acme_, ppx_, or bill_ over generic catch-alls.',
  'Add minimum lengths like {24,} to reduce false positives.',
  'Use word boundaries like \\b where possible.',
  'Tie generic values to names like client_secret= instead of matching any long random string.',
  'Separate patterns by secret family instead of writing one giant regex.',
];

const SECRET_PATTERN_HELP_AVOID = [
  'token.*',
  'secret.*',
  '[A-Za-z0-9]{20,}',
  'Anything that matches ordinary IDs, hashes, or filenames.',
];

const SECRET_PATTERN_HELP_STARTER_SET: Array<{ label: string; mode: SecretPatternMatchMode; pattern: string }> = [
  { label: 'Acme API token', mode: 'regex', pattern: String.raw`\bacme_(live|test)_[A-Za-z0-9]{32}\b` },
  { label: 'JWT bearer token', mode: 'regex', pattern: String.raw`\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b` },
  { label: 'Authorization bearer header', mode: 'contains', pattern: 'Authorization: Bearer' },
  { label: 'SSH private key', mode: 'startsWith', pattern: '-----BEGIN ' },
];

export function renderSecretPatternHelpTooltip(): string {
  const modeItems = SECRET_PATTERN_MODE_HELP.map((item) => (
    `<li><strong>${escapeHtml(SECRET_PATTERN_MODE_LABELS[item.mode])}</strong>: ${escapeHtml(item.note)} <code>${escapeHtml(item.example)}</code></li>`
  )).join('');

  const exampleItems = SECRET_PATTERN_HELP_EXAMPLES.map((item) => (
    `<div class="tooltip-pattern"><strong>${escapeHtml(item.label)}</strong><div class="tooltip-note">${escapeHtml(SECRET_PATTERN_MODE_LABELS[item.mode])}</div><code>${escapeHtml(item.pattern)}</code><div class="tooltip-note">${escapeHtml(item.note)}</div></div>`
  )).join('');

  const bestPracticeItems = SECRET_PATTERN_HELP_BEST_PRACTICES.map((item) => `<li>${escapeHtml(item)}</li>`).join('');
  const avoidItems = SECRET_PATTERN_HELP_AVOID.map((item) => `<li><code>${escapeHtml(item)}</code></li>`).join('');
  const starterItems = SECRET_PATTERN_HELP_STARTER_SET.map((item) => (
    `<div class="tooltip-pattern"><strong>${escapeHtml(item.label)}</strong><div class="tooltip-note">${escapeHtml(SECRET_PATTERN_MODE_LABELS[item.mode])}</div><code>${escapeHtml(item.pattern)}</code></div>`
  )).join('');

  return [
    '<div class="tooltip-panel" role="tooltip">',
    '<div class="tooltip-title">Custom pattern guide</div>',
    '<div class="tooltip-note">All custom match modes are case-insensitive. Regex and LIKE are the most flexible for long prompts.</div>',
    '<div class="tooltip-section"><strong>Supported match modes</strong><ul class="tooltip-list">',
    modeItems,
    '</ul></div>',
    '<div class="tooltip-section"><strong>Recommended examples</strong>',
    exampleItems,
    '</div>',
    '<div class="tooltip-section"><strong>What works best</strong><ul class="tooltip-list">',
    bestPracticeItems,
    '</ul></div>',
    '<div class="tooltip-section"><strong>What to avoid</strong><ul class="tooltip-list">',
    avoidItems,
    '</ul></div>',
    '<div class="tooltip-section"><strong>Good starter set</strong>',
    starterItems,
    '</div>',
    '</div>',
  ].join('');
}
