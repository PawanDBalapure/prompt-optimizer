import type { CustomSecretPatternConfig, SecretPatternMatchMode } from '../types';
import {
  ALLOWED_MATCH_MODES,
  BASE64_RE,
  clampString,
  isString,
  MAX_AGENT_NAME_CHARS,
  MAX_CUSTOM_PATTERNS,
  MAX_FILENAME_CHARS,
  MAX_IMAGE_BASE64_CHARS,
  MAX_LABEL_CHARS,
  MAX_MIME_CHARS,
  MAX_PATTERN_CHARS,
  MAX_PROMPT_CHARS,
  type ValidWebviewMessage,
} from './validatorTypes';

type Raw = Record<string, unknown>;

/** Validate secret-detection settings fields. Returns false to reject the message. */
export function applySecretFields(data: Raw, out: ValidWebviewMessage): boolean {
  if (data.enabled !== undefined) {
    if (typeof data.enabled !== 'boolean') { return false; }
    out.enabled = data.enabled;
  }
  if (data.customPatterns !== undefined) {
    if (!Array.isArray(data.customPatterns)) { return false; }
    if (data.customPatterns.length > MAX_CUSTOM_PATTERNS) { return false; }
    const cleaned: CustomSecretPatternConfig[] = [];
    for (const entry of data.customPatterns) {
      if (!entry || typeof entry !== 'object') { return false; }
      const e = entry as Raw;
      const pattern = clampString(e.pattern, MAX_PATTERN_CHARS);
      if (pattern === undefined) { return false; }
      const label = clampString(e.label, MAX_LABEL_CHARS);
      let matchMode: SecretPatternMatchMode | undefined;
      if (e.matchMode !== undefined) {
        if (!isString(e.matchMode) || !ALLOWED_MATCH_MODES.has(e.matchMode as SecretPatternMatchMode)) {
          return false;
        }
        matchMode = e.matchMode as SecretPatternMatchMode;
      }
      cleaned.push({ pattern, label, matchMode });
    }
    out.customPatterns = cleaned;
  }
  return true;
}

/** Validate OCR image payload fields (id / name / mime / base64 body). */
export function applyOcrFields(data: Raw, out: ValidWebviewMessage): boolean {
  if (data.id !== undefined) {
    const id = clampString(data.id, 64);
    if (id === undefined || !/^[A-Za-z0-9._-]+$/.test(id)) { return false; }
    out.id = id;
  }
  if (data.name !== undefined) {
    const name = clampString(data.name, MAX_FILENAME_CHARS);
    if (name === undefined) { return false; }
    out.name = name;
  }
  if (data.mime !== undefined) {
    const mime = clampString(data.mime, MAX_MIME_CHARS);
    if (mime === undefined || !/^image\/[a-zA-Z0-9.+-]+$/.test(mime)) { return false; }
    out.mime = mime;
  }
  if (data.dataBase64 !== undefined) {
    if (!isString(data.dataBase64)) { return false; }
    if (data.dataBase64.length === 0 || data.dataBase64.length > MAX_IMAGE_BASE64_CHARS) {
      return false;
    }
    if (!BASE64_RE.test(data.dataBase64)) { return false; }
    out.dataBase64 = data.dataBase64;
  }
  return true;
}

/** Validate custom agent creation/deletion fields. */
export function applyAgentFields(data: Raw, out: ValidWebviewMessage): boolean {
  if (data.agentName !== undefined) {
    const agentName = clampString(data.agentName, MAX_AGENT_NAME_CHARS);
    if (agentName === undefined) { return false; }
    out.agentName = agentName;
  }
  if (data.agentContent !== undefined) {
    const agentContent = clampString(data.agentContent, MAX_PROMPT_CHARS);
    if (agentContent === undefined) { return false; }
    out.agentContent = agentContent;
  }
  if (data.agentId !== undefined) {
    const agentId = clampString(data.agentId, MAX_AGENT_NAME_CHARS);
    if (agentId === undefined) { return false; }
    out.agentId = agentId;
  }
  return true;
}

/** Validate Instructions-Manager fields (paths, rule toggles, personas). */
export function applyInstructionFields(data: Raw, out: ValidWebviewMessage): boolean {
  if (data.relPath !== undefined) {
    const relPath = clampString(data.relPath, 512);
    // Workspace-relative paths only: reject absolutes and parent-dir escapes.
    if (
      relPath === undefined
      || relPath.length === 0
      || relPath.includes('..')
      || /^([a-zA-Z]:[\\/]|[\\/])/.test(relPath)
    ) {
      return false;
    }
    out.relPath = relPath;
  }
  if (data.line !== undefined) {
    if (typeof data.line !== 'number' || !Number.isInteger(data.line) || data.line < 1 || data.line > 1_000_000) {
      return false;
    }
    out.line = data.line;
  }
  if (data.ruleText !== undefined) {
    const ruleText = clampString(data.ruleText, 4_000);
    if (ruleText === undefined) { return false; }
    out.ruleText = ruleText;
  }
  if (data.personaId !== undefined) {
    const personaId = clampString(data.personaId, 64);
    if (personaId === undefined || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(personaId)) { return false; }
    out.personaId = personaId;
  }
  if (data.sourceFile !== undefined) {
    const sourceFile = clampString(data.sourceFile, 128);
    // Basename only: no path separators, must end with .md.
    if (sourceFile === undefined || !/^[A-Za-z0-9._-]+\.md$/.test(sourceFile)) { return false; }
    out.sourceFile = sourceFile;
  }
  return true;
}
