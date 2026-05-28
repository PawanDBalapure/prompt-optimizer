/**
 * Lightweight, dependency-free structured logger.  The optimizer runs in many
 * environments (VS Code extension host, JetBrains bundled Node, CLI sidecar,
 * test harness) so we deliberately avoid pulling in `pino` / `winston`.
 *
 * Behaviour:
 *   - Level filter via env `PROMPT_OPT_LOG_LEVEL` (default: warn)
 *     Allowed: debug, info, warn, error, silent
 *   - Format via env `PROMPT_OPT_LOG_FORMAT` (default: text)
 *     - text: `[level] [scope] message {…meta}` on stderr
 *     - json: one JSON object per line, suitable for ingestion
 *   - Sink is always stderr to avoid polluting the CLI's JSON stdout.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10, info: 20, warn: 30, error: 40, silent: 99,
};

function parseLevel(value: string | undefined, fallback: LogLevel): LogLevel {
  const lower = (value ?? '').trim().toLowerCase() as LogLevel;
  return (lower in LEVEL_ORDER) ? lower : fallback;
}

const ACTIVE_LEVEL: LogLevel = parseLevel(process.env.PROMPT_OPT_LOG_LEVEL, 'warn');
const FORMAT_JSON = (process.env.PROMPT_OPT_LOG_FORMAT ?? '').toLowerCase() === 'json';

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[ACTIVE_LEVEL];
}

function emit(level: LogLevel, scope: string, message: string, meta?: Record<string, unknown>): void {
  if (!shouldLog(level)) { return; }
  const timestamp = new Date().toISOString();
  if (FORMAT_JSON) {
    const payload: Record<string, unknown> = { ts: timestamp, level, scope, message };
    if (meta) { payload.meta = meta; }
    try { process.stderr.write(JSON.stringify(payload) + '\n'); }
    catch { /* stderr unavailable — give up silently */ }
    return;
  }
  const metaStr = meta && Object.keys(meta).length > 0 ? ` ${safeStringify(meta)}` : '';
  try { process.stderr.write(`[${timestamp}] [${level}] [${scope}] ${message}${metaStr}\n`); }
  catch { /* stderr unavailable */ }
}

function safeStringify(meta: Record<string, unknown>): string {
  try { return JSON.stringify(meta); }
  catch { return '[unserialisable meta]'; }
}

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info (message: string, meta?: Record<string, unknown>): void;
  warn (message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/** Create a logger bound to a named scope (e.g. "SemanticCacheManager"). */
export function createLogger(scope: string): Logger {
  return {
    debug: (m, x) => emit('debug', scope, m, x),
    info:  (m, x) => emit('info',  scope, m, x),
    warn:  (m, x) => emit('warn',  scope, m, x),
    error: (m, x) => emit('error', scope, m, x),
  };
}

/** Expose the resolved level for diagnostics / health reports. */
export function activeLogLevel(): LogLevel { return ACTIVE_LEVEL; }
