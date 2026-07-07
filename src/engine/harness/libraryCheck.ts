import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Anti-hallucination library check: when the prompt mentions a problem domain
 * (dates, HTTP, testing, …), look up which library the repo ALREADY uses and
 * pin the agent to it.  When none exists, ask for a maintained suggestion +
 * install command instead of a silent invention.
 */

interface LibraryDomain {
  /** Domain keywords that must appear in the prompt. */
  keywords: RegExp;
  /** Known package names for this domain, in preference order. */
  packages: string[];
  label: string;
}

const DOMAINS: LibraryDomain[] = [
  { label: 'date/time', keywords: /\b(date|time(stamp|zone)?|calendar|duration)\b/i, packages: ['date-fns', 'dayjs', 'luxon', 'moment'] },
  { label: 'HTTP client', keywords: /\b(http|fetch|api call|request|axios)\b/i, packages: ['axios', 'got', 'ky', 'node-fetch', 'undici'] },
  { label: 'testing', keywords: /\b(test|spec|unit test|mock)\b/i, packages: ['vitest', 'jest', 'mocha', 'ava'] },
  { label: 'validation', keywords: /\b(validat\w+|schema|sanitiz\w+)\b/i, packages: ['zod', 'yup', 'joi', 'ajv'] },
  { label: 'state management', keywords: /\b(state management|global state|store)\b/i, packages: ['zustand', 'redux', '@reduxjs/toolkit', 'jotai', 'mobx'] },
  { label: 'styling', keywords: /\b(style|styling|css|theme)\b/i, packages: ['tailwindcss', 'styled-components', '@emotion/react', 'sass'] },
];

function readJsDependencies(workspaceRoot: string): Set<string> {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(workspaceRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ]);
  } catch {
    return new Set();
  }
}

function readPythonDependencies(workspaceRoot: string): Set<string> {
  try {
    const raw = fs.readFileSync(path.join(workspaceRoot, 'requirements.txt'), 'utf8');
    return new Set(
      raw.split(/\r?\n/)
        .map((l) => l.split(/[=<>~!\[;#]/)[0].trim().toLowerCase())
        .filter(Boolean),
    );
  } catch {
    return new Set();
  }
}

/**
 * Return at most 2 library-pinning constraint lines for domains the prompt
 * actually mentions.  Empty when no manifest exists (nothing to pin against).
 */
export function buildLibraryConstraints(rawPrompt: string, workspaceRoot?: string): string[] {
  if (!workspaceRoot) { return []; }
  const deps = readJsDependencies(workspaceRoot);
  const pyDeps = readPythonDependencies(workspaceRoot);
  if (deps.size === 0 && pyDeps.size === 0) { return []; }

  const out: string[] = [];
  for (const domain of DOMAINS) {
    if (out.length >= 2) { break; }
    if (!domain.keywords.test(rawPrompt)) { continue; }
    const installed = domain.packages.find((p) => deps.has(p) || pyDeps.has(p.toLowerCase()));
    if (installed) {
      const alternatives = domain.packages.filter((p) => p !== installed).slice(0, 2).join('/');
      out.push(`Use ${installed} (already a dependency) for ${domain.label}; do not add ${alternatives} or invent new libraries.`);
    } else if (deps.size > 0 || pyDeps.size > 0) {
      out.push(`No ${domain.label} library present — suggest one maintained option with its install command before using it.`);
    }
  }
  return out;
}
