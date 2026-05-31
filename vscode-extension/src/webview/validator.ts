import type { CustomSecretPatternConfig, SecretPatternMatchMode } from '../types';

/**
 * Lightweight validators for messages arriving from the webview.
 *
 * The webview is sandboxed but its messages still flow through the IPC layer
 * untyped.  Validating shape + value bounds at the trust boundary prevents
 * malformed payloads from corrupting global state (OWASP A03: Injection /
 * A04: Insecure Design) and gives us defence in depth against XSS-driven
 * configuration tampering.
 */

const ALLOWED_TYPES = new Set([
  'ready', 'setMode', 'setTargetModel', 'agentRun', 'analyze',
  'sendPrompt', 'openChatWithPrompt', 'copyPrompt', 'openChat',
  'openReadme', 'openSecretSettings', 'saveSecretSettings',
  'openSettings', 'close',
  'openMemoryFile', 'openPeerWorkspaces', 'requestStatusOverview',
  'manageAgentSkills', 'openUserGuide', 'openOnboarding', 'showHistory',
  'commitPrompt', 'showPromptLog', 'switchPromptBranch',
  'reportIssue',
]);

const ALLOWED_MODES = new Set(['agent', 'optimize', 'direct']);
const ALLOWED_MODELS = new Set(['claude', 'gpt', 'gemini', 'local']);
const ALLOWED_MATCH_MODES = new Set<SecretPatternMatchMode>(
  ['regex', 'like', 'contains', 'startsWith', 'endsWith', 'exact'],
);

/** Soft cap on free-text prompt size accepted from the webview. */
const MAX_PROMPT_CHARS = 200_000;
const MAX_PATTERN_CHARS = 2_000;
const MAX_LABEL_CHARS = 200;
const MAX_CUSTOM_PATTERNS = 200;

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

function clampString(v: unknown, max: number): string | undefined {
  if (!isString(v)) { return undefined; }
  return v.length > max ? v.slice(0, max) : v;
}

export interface ValidWebviewMessage {
  type: string;
  prompt?: string;
  optimized?: string;
  mode?: string;
  model?: string;
  enabled?: boolean;
  customPatterns?: CustomSecretPatternConfig[];
}

/**
 * Returns a normalised message object if the payload is well-formed, or
 * `null` to instruct the caller to drop the message.
 */
export function validateMessage(raw: unknown): ValidWebviewMessage | null {
  if (!raw || typeof raw !== 'object') { return null; }
  const data = raw as Record<string, unknown>;
  const type = data.type;
  if (!isString(type) || !ALLOWED_TYPES.has(type)) { return null; }

  const out: ValidWebviewMessage = { type };

  if (data.prompt !== undefined) {
    const prompt = clampString(data.prompt, MAX_PROMPT_CHARS);
    if (prompt === undefined) { return null; }
    out.prompt = prompt;
  }

  if (data.optimized !== undefined) {
    const optimized = clampString(data.optimized, MAX_PROMPT_CHARS);
    if (optimized === undefined) { return null; }
    out.optimized = optimized;
  }

  if (data.mode !== undefined) {
    if (!isString(data.mode) || !ALLOWED_MODES.has(data.mode)) { return null; }
    out.mode = data.mode;
  }

  if (data.model !== undefined) {
    if (!isString(data.model) || !ALLOWED_MODELS.has(data.model)) { return null; }
    out.model = data.model;
  }

  if (data.enabled !== undefined) {
    if (typeof data.enabled !== 'boolean') { return null; }
    out.enabled = data.enabled;
  }

  if (data.customPatterns !== undefined) {
    if (!Array.isArray(data.customPatterns)) { return null; }
    if (data.customPatterns.length > MAX_CUSTOM_PATTERNS) { return null; }
    const cleaned: CustomSecretPatternConfig[] = [];
    for (const entry of data.customPatterns) {
      if (!entry || typeof entry !== 'object') { return null; }
      const e = entry as Record<string, unknown>;
      const pattern = clampString(e.pattern, MAX_PATTERN_CHARS);
      if (pattern === undefined) { return null; }
      const label = clampString(e.label, MAX_LABEL_CHARS);
      let matchMode: SecretPatternMatchMode | undefined;
      if (e.matchMode !== undefined) {
        if (!isString(e.matchMode) || !ALLOWED_MATCH_MODES.has(e.matchMode as SecretPatternMatchMode)) {
          return null;
        }
        matchMode = e.matchMode as SecretPatternMatchMode;
      }
      cleaned.push({ pattern, label, matchMode });
    }
    out.customPatterns = cleaned;
  }

  return out;
}
