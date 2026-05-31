/**
 * File-based config loader for fleet/managed deployments.
 *
 * Reads, in priority order (later wins):
 *   1. user-global  ~/.promptoptimizer/config.json
 *   2. workspace    <workspace_root>/.promptoptimizer/config.json
 *   3. process.env  (always wins — single source of truth for ad-hoc overrides)
 *
 * The schema mirrors the env-var table in README.md so ops can flip a single
 * file in source control rather than maintain shell wrappers per workstation.
 *
 * Design rules:
 *   - **JSON, not YAML** — keeps the engine dep-free.
 *   - **Pure read** — never mutates the user's config; only consumed at init.
 *   - **Best-effort** — a missing or malformed file is logged at warn and
 *     ignored.  The optimizer must continue to work with no config file at all.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { reportEngineError } from './logger.js';

export interface ResolvedEngineConfig {
  /** Logger level — `debug` | `info` | `warn` | `error` | `silent`. */
  log_level?: string;
  /** Logger output format — `text` | `json`. */
  log_format?: string;
  /** Disable secret redactor at persistence boundary.  Default: enabled. */
  redact_enabled?: boolean;
  /** Additionally redact PII (email/phone/SSN/credit card). */
  redact_pii?: boolean;
  /** Per-file byte cap when ingesting workspace memory files. */
  memory_max_bytes_per_file?: number;
  /** Aggregate cap across all workspace memory files. */
  memory_max_total_bytes?: number;
  /** Hard ceiling on combined augmented context (memory + KG + digests + peers). */
  memory_max_augmented_bytes?: number;
  /** Candidate cap fed into the semantic similarity scan (see #1 in roadmap). */
  cache_candidate_cap?: number;
  /** Append-only audit log toggle.  When false, no audit rows are written. */
  audit_log_enabled?: boolean;
  /** When true, audit_log stores raw prompts (default: hash-only). */
  audit_log_raw?: boolean;
  /** Optional OTLP/HTTP endpoint (line-protocol JSON) for metrics export. */
  otlp_endpoint?: string;
  /** Per-augment-source rate limiter — calls per second. */
  augment_rate_per_sec?: number;
  /** Circuit-breaker error threshold before an augment source is tripped. */
  augment_breaker_threshold?: number;
  /** Cool-down after the breaker trips, in milliseconds. */
  augment_breaker_cooldown_ms?: number;
}

const ENV_KEY_MAP: Record<string, keyof ResolvedEngineConfig> = {
  PROMPT_OPT_LOG_LEVEL:           'log_level',
  PROMPT_OPT_LOG_FORMAT:          'log_format',
  PROMPT_OPT_REDACT:              'redact_enabled',
  PROMPT_OPT_REDACT_PII:          'redact_pii',
  POMEMORY_MAX_BYTES_PER_FILE:    'memory_max_bytes_per_file',
  POMEMORY_MAX_TOTAL_BYTES:       'memory_max_total_bytes',
  POMEMORY_MAX_AUGMENTED_BYTES:   'memory_max_augmented_bytes',
  PROMPT_OPT_CACHE_CANDIDATE_CAP: 'cache_candidate_cap',
  PROMPT_OPT_AUDIT_ENABLED:       'audit_log_enabled',
  PROMPT_OPT_AUDIT_RAW:           'audit_log_raw',
  PROMPT_OPT_OTLP_ENDPOINT:       'otlp_endpoint',
  PROMPT_OPT_AUGMENT_RPS:         'augment_rate_per_sec',
  PROMPT_OPT_AUGMENT_BREAKER:     'augment_breaker_threshold',
  PROMPT_OPT_AUGMENT_COOLDOWN:    'augment_breaker_cooldown_ms',
};

/** Merge two partial configs; the right-hand side wins on collision. */
function merge(a: ResolvedEngineConfig, b: ResolvedEngineConfig): ResolvedEngineConfig {
  return { ...a, ...b };
}

function readJsonIfPresent(filePath: string): ResolvedEngineConfig {
  try {
    if (!fs.existsSync(filePath)) { return {}; }
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parsed as ResolvedEngineConfig;
  } catch (err) {
    reportEngineError('config_load', err, {
      level: 'warn',
      meta: { path: filePath },
    });
    return {};
  }
}

function envOverrides(): ResolvedEngineConfig {
  const out: ResolvedEngineConfig = {};
  for (const [envKey, cfgKey] of Object.entries(ENV_KEY_MAP)) {
    const v = process.env[envKey];
    if (v === undefined) { continue; }
    if (cfgKey === 'redact_enabled') {
      out.redact_enabled = !(v === '0' || v.toLowerCase() === 'false');
      continue;
    }
    if (cfgKey === 'redact_pii' || cfgKey === 'audit_log_enabled' || cfgKey === 'audit_log_raw') {
      out[cfgKey] = v === '1' || v.toLowerCase() === 'true';
      continue;
    }
    if (
      cfgKey === 'memory_max_bytes_per_file' ||
      cfgKey === 'memory_max_total_bytes' ||
      cfgKey === 'memory_max_augmented_bytes' ||
      cfgKey === 'cache_candidate_cap' ||
      cfgKey === 'augment_rate_per_sec' ||
      cfgKey === 'augment_breaker_threshold' ||
      cfgKey === 'augment_breaker_cooldown_ms'
    ) {
      const n = Number.parseInt(v, 10);
      if (Number.isFinite(n) && n >= 0) { (out as Record<string, unknown>)[cfgKey] = n; }
      continue;
    }
    (out as Record<string, unknown>)[cfgKey] = v;
  }
  return out;
}

export function loadEngineConfig(workspaceRoot?: string): ResolvedEngineConfig {
  const userPath = path.join(os.homedir(), '.promptoptimizer', 'config.json');
  const wsPath = workspaceRoot
    ? path.join(workspaceRoot, '.promptoptimizer', 'config.json')
    : null;

  let cfg = readJsonIfPresent(userPath);
  if (wsPath) { cfg = merge(cfg, readJsonIfPresent(wsPath)); }
  cfg = merge(cfg, envOverrides());
  return cfg;
}

/**
 * Convenience accessors with defaults — call sites stay clean.  Thresholds
 * mirror the engine's hard-coded fallbacks so removing the config file is
 * always safe.
 */
export function pickCandidateCap(cfg: ResolvedEngineConfig): number {
  return Math.max(100, cfg.cache_candidate_cap ?? 2000);
}
export function pickAugmentRps(cfg: ResolvedEngineConfig): number {
  return Math.max(0.1, cfg.augment_rate_per_sec ?? 4);
}
export function pickBreakerThreshold(cfg: ResolvedEngineConfig): number {
  return Math.max(1, cfg.augment_breaker_threshold ?? 5);
}
export function pickBreakerCooldown(cfg: ResolvedEngineConfig): number {
  return Math.max(1000, cfg.augment_breaker_cooldown_ms ?? 30_000);
}
