import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Pre-flight harness configuration.  Loaded per-workspace from
 * `.promptoptimizer/harness.json` (explicit, wins) with a fuzzy fallback that
 * harvests boundary rules from workspace memory files (AGENTS.md etc.).
 * Every feature has a kill switch; everything defaults to on.
 */
export interface HarnessConfig {
  /** Master switch — false disables every harness injection. */
  enabled: boolean;
  /** Force diff-only / search-replace output constraint. */
  diffOnly: boolean;
  /** Repo-relative path prefixes the agent must not modify. */
  forbiddenPaths: string[];
  /** When non-empty, the agent may ONLY modify these path prefixes. */
  allowedPaths: string[];
  /** Free-text team guidelines, ranked by relevance and injected (top 3). */
  guidelines: string[];
  /** Inject "use existing library X" constraints from package.json. */
  libraryCheck: boolean;
  /** Inject extracted function signatures the agent must preserve. */
  signatureAnchoring: boolean;
  /** Expand add/create/fix prompts with test-first + edge-case constraints. */
  intentExpansion: boolean;
  /** Prefer AST-based slicing when a tree-sitter grammar is available. */
  astSlicing: boolean;
}

const DEFAULTS: HarnessConfig = {
  enabled: true,
  diffOnly: true,
  forbiddenPaths: [],
  allowedPaths: [],
  guidelines: [],
  libraryCheck: true,
  signatureAnchoring: true,
  intentExpansion: true,
  astSlicing: true,
};

const MEMORY_FILES = ['AGENTS.md', 'CLAUDE.md', '.promptoptimizer/memory.md'];
/** Bullet lines like "- Do not modify src/core/db" become forbidden paths. */
const FORBIDDEN_LINE = /^[-*]\s+(?:do not|don't|never)\s+(?:modify|touch|edit|change)\s+[`"']?([\w./\\-]+)[`"']?/i;
const MAX_GUIDELINES = 50;
const MAX_PATHS = 50;

function asStringArray(value: unknown, cap: number): string[] {
  if (!Array.isArray(value)) { return []; }
  return value
    .filter((v): v is string => typeof v === 'string' && v.trim() !== '')
    .map((v) => v.trim())
    .slice(0, cap);
}

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** Fallback: harvest forbidden paths + guideline bullets from memory files. */
function harvestFromMemoryFiles(workspaceRoot: string): Pick<HarnessConfig, 'forbiddenPaths' | 'guidelines'> {
  const forbiddenPaths: string[] = [];
  const guidelines: string[] = [];
  for (const rel of MEMORY_FILES) {
    const abs = path.join(workspaceRoot, rel);
    let text = '';
    try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      const forbidden = FORBIDDEN_LINE.exec(trimmed);
      if (forbidden) {
        if (forbiddenPaths.length < MAX_PATHS) { forbiddenPaths.push(forbidden[1]); }
        continue;
      }
      // Rule-shaped bullets ("- Use X", "- Always/Never …") become guidelines.
      if (/^[-*]\s+(use|always|never|prefer|avoid|must|do not|don't)\b/i.test(trimmed)
        && trimmed.length >= 15 && trimmed.length <= 200
        && guidelines.length < MAX_GUIDELINES) {
        guidelines.push(trimmed.replace(/^[-*]\s+/, ''));
      }
    }
  }
  return { forbiddenPaths, guidelines };
}

/**
 * Load the harness config for a workspace.  `harness.json` values win;
 * boundary/guideline harvesting from memory files fills any gaps.
 * Never throws — a broken config degrades to defaults.
 */
export function loadHarnessConfig(workspaceRoot?: string): HarnessConfig {
  const config: HarnessConfig = { ...DEFAULTS, forbiddenPaths: [], allowedPaths: [], guidelines: [] };
  if (process.env.PROMPT_OPT_HARNESS === 'off') {
    return { ...config, enabled: false };
  }
  if (!workspaceRoot || !fs.existsSync(workspaceRoot)) { return config; }

  let fileConfig: Record<string, unknown> = {};
  try {
    const raw = fs.readFileSync(path.join(workspaceRoot, '.promptoptimizer', 'harness.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') { fileConfig = parsed as Record<string, unknown>; }
  } catch { /* absent or malformed — fall through to harvesting */ }

  config.enabled = asBool(fileConfig.enabled, true);
  config.diffOnly = asBool(fileConfig.diffOnly, true);
  config.libraryCheck = asBool(fileConfig.libraryCheck, true);
  config.signatureAnchoring = asBool(fileConfig.signatureAnchoring, true);
  config.intentExpansion = asBool(fileConfig.intentExpansion, true);
  config.astSlicing = asBool(fileConfig.astSlicing, true);
  config.forbiddenPaths = asStringArray(fileConfig.forbiddenPaths, MAX_PATHS);
  config.allowedPaths = asStringArray(fileConfig.allowedPaths, MAX_PATHS);
  config.guidelines = asStringArray(fileConfig.guidelines, MAX_GUIDELINES);

  // Memory-file fallback only fills what harness.json left empty.
  if (config.forbiddenPaths.length === 0 || config.guidelines.length === 0) {
    const harvested = harvestFromMemoryFiles(workspaceRoot);
    if (config.forbiddenPaths.length === 0) { config.forbiddenPaths = harvested.forbiddenPaths; }
    if (config.guidelines.length === 0) { config.guidelines = harvested.guidelines; }
  }
  return config;
}
