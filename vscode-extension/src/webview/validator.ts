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
const ALLOWED_MATCH_MODES = new Set<SecretPatternMatchMode>(
  ['regex', 'like', 'contains', 'startsWith', 'endsWith', 'exact'],
);

/** Soft cap on free-text prompt size accepted from the webview. */
const MAX_PROMPT_CHARS = 200_000;
const MAX_PATTERN_CHARS = 2_000;
const MAX_LABEL_CHARS = 200;
const MAX_CUSTOM_PATTERNS = 200;
/** Cap base64 image payloads at ~12 MB encoded (~9 MB raw). */
const MAX_IMAGE_BASE64_CHARS = 12 * 1024 * 1024;
const MAX_FILENAME_CHARS = 256;
const MAX_MIME_CHARS = 64;
const MAX_AGENT_NAME_CHARS = 200;
const BASE64_RE = /^[A-Za-z0-9+/=\s]+$/;

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
  text?: string;
  fieldId?: string;
  optimized?: string;
  mode?: string;
  model?: string;
  density?: string;
  enabled?: boolean;
  customPatterns?: CustomSecretPatternConfig[];
  /** OCR request id (round-trip correlation token from the webview). */
  id?: string;
  /** OCR original filename (display only). */
  name?: string;
  /** OCR image MIME type, e.g. "image/png". */
  mime?: string;
  /** OCR image bytes, base64-encoded. */
  dataBase64?: string;
  /** Display name for a new custom agent. */
  agentName?: string;
  /** Markdown body for a new custom agent. */
  agentContent?: string;
  /** Id (slug) of an agent to delete. */
  agentId?: string;
  /** Workspace-relative path of an instruction source (Instructions Manager). */
  relPath?: string;
  /** 1-based line number of a rule to toggle. */
  line?: number;
  /** Original rule text, used to verify the toggle target. */
  ruleText?: string;
  /** Id (slug) of a bundled persona to enable/disable. */
  personaId?: string;
  /** Bundled persona source file name (basename). */
  sourceFile?: string;
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

  if (data.id !== undefined) {
    const id = clampString(data.id, 64);
    if (id === undefined || !/^[A-Za-z0-9._-]+$/.test(id)) { return null; }
    out.id = id;
  }
  if (data.name !== undefined) {
    const name = clampString(data.name, MAX_FILENAME_CHARS);
    if (name === undefined) { return null; }
    out.name = name;
  }
  if (data.mime !== undefined) {
    const mime = clampString(data.mime, MAX_MIME_CHARS);
    if (mime === undefined || !/^image\/[a-zA-Z0-9.+-]+$/.test(mime)) { return null; }
    out.mime = mime;
  }
  if (data.dataBase64 !== undefined) {
    if (!isString(data.dataBase64)) { return null; }
    if (data.dataBase64.length === 0 || data.dataBase64.length > MAX_IMAGE_BASE64_CHARS) {
      return null;
    }
    if (!BASE64_RE.test(data.dataBase64)) { return null; }
    out.dataBase64 = data.dataBase64;
  }

  if (data.agentName !== undefined) {
    const agentName = clampString(data.agentName, MAX_AGENT_NAME_CHARS);
    if (agentName === undefined) { return null; }
    out.agentName = agentName;
  }
  if (data.agentContent !== undefined) {
    const agentContent = clampString(data.agentContent, MAX_PROMPT_CHARS);
    if (agentContent === undefined) { return null; }
    out.agentContent = agentContent;
  }
  if (data.agentId !== undefined) {
    const agentId = clampString(data.agentId, MAX_AGENT_NAME_CHARS);
    if (agentId === undefined) { return null; }
    out.agentId = agentId;
  }

  if (data.relPath !== undefined) {
    const relPath = clampString(data.relPath, 512);
    // Workspace-relative paths only: reject absolutes and parent-dir escapes.
    if (
      relPath === undefined
      || relPath.length === 0
      || relPath.includes('..')
      || /^([a-zA-Z]:[\\/]|[\\/])/.test(relPath)
    ) {
      return null;
    }
    out.relPath = relPath;
  }

  if (data.line !== undefined) {
    if (typeof data.line !== 'number' || !Number.isInteger(data.line) || data.line < 1 || data.line > 1_000_000) {
      return null;
    }
    out.line = data.line;
  }

  if (data.ruleText !== undefined) {
    const ruleText = clampString(data.ruleText, 4_000);
    if (ruleText === undefined) { return null; }
    out.ruleText = ruleText;
  }

  if (data.personaId !== undefined) {
    const personaId = clampString(data.personaId, 64);
    if (personaId === undefined || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(personaId)) { return null; }
    out.personaId = personaId;
  }

  if (data.sourceFile !== undefined) {
    const sourceFile = clampString(data.sourceFile, 128);
    // Basename only: no path separators, must end with .md.
    if (sourceFile === undefined || !/^[A-Za-z0-9._-]+\.md$/.test(sourceFile)) { return null; }
    out.sourceFile = sourceFile;
  }

  return out;
}
