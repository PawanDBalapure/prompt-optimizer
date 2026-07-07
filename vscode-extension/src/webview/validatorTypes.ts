import type { CustomSecretPatternConfig, SecretPatternMatchMode } from '../types';

/** Soft cap on free-text prompt size accepted from the webview. */
export const MAX_PROMPT_CHARS = 200_000;
export const MAX_PATTERN_CHARS = 2_000;
export const MAX_LABEL_CHARS = 200;
export const MAX_CUSTOM_PATTERNS = 200;
/** Cap base64 image payloads at ~12 MB encoded (~9 MB raw). */
export const MAX_IMAGE_BASE64_CHARS = 12 * 1024 * 1024;
export const MAX_FILENAME_CHARS = 256;
export const MAX_MIME_CHARS = 64;
export const MAX_AGENT_NAME_CHARS = 200;
export const BASE64_RE = /^[A-Za-z0-9+/=\s]+$/;

export const ALLOWED_MATCH_MODES = new Set<SecretPatternMatchMode>(
  ['regex', 'like', 'contains', 'startsWith', 'endsWith', 'exact'],
);

export function isString(v: unknown): v is string {
  return typeof v === 'string';
}

export function clampString(v: unknown, max: number): string | undefined {
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
