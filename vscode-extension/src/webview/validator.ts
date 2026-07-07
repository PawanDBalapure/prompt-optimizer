import {
  applyAgentFields,
  applyInstructionFields,
  applyOcrFields,
  applySecretFields,
} from './validatorFields';
import {
  clampString,
  isString,
  MAX_PROMPT_CHARS,
  type ValidWebviewMessage,
} from './validatorTypes';

export type { ValidWebviewMessage } from './validatorTypes';

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
  'ready', 'setMode', 'setTargetModel', 'setDensity', 'agentRun', 'analyze',
  'estimateTokens',
  'sendPrompt', 'openChatWithPrompt', 'copyPrompt', 'openChat',
  'openReadme', 'openSecretSettings', 'saveSecretSettings',
  'openSettings', 'close',
  'openMemoryFile', 'openPeerWorkspaces', 'requestStatusOverview',
  'manageAgentSkills', 'openUserGuide', 'openOnboarding', 'showHistory',
  'commitPrompt', 'showPromptLog', 'switchPromptBranch',
  'reportIssue',
  'ocrImage',
  'createAgent',
  'deleteAgent',
  'refreshOverview',
  'resetToDefaults',
  'requestInstructionsOverview',
  'instructionsHistory',
  'openInstructionFile',
  'exportInstructions',
  'importInstructions',
  'toggleInstructionRule',
  'togglePersona',
]);

const ALLOWED_MODES = new Set(['agent', 'optimize', 'direct']);
const ALLOWED_MODELS = new Set(['claude', 'gpt', 'gemini', 'deepseek', 'grok', 'local']);
const ALLOWED_DENSITIES = new Set(['rich', 'lean']);

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
  if (data.text !== undefined) {
    const text = clampString(data.text, MAX_PROMPT_CHARS);
    if (text === undefined) { return null; }
    out.text = text;
  }
  if (data.fieldId !== undefined) {
    if (!isString(data.fieldId) || !['inputTokenCount', 'optimizedTokenCount'].includes(data.fieldId)) {
      return null;
    }
    out.fieldId = data.fieldId;
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
  if (data.density !== undefined) {
    if (!isString(data.density) || !ALLOWED_DENSITIES.has(data.density)) { return null; }
    out.density = data.density;
  }

  if (!applySecretFields(data, out)) { return null; }
  if (!applyOcrFields(data, out)) { return null; }
  if (!applyAgentFields(data, out)) { return null; }
  if (!applyInstructionFields(data, out)) { return null; }

  return out;
}
