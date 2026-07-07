import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

/** One bundled-or-custom agent skill entry shown in the manage picker. */
export interface LibEntry {
  id: string;
  label: string;
  readOnly: boolean;
  tags: string[];
  libPath: string;
  targetPath: string;
  installed: boolean;
}

/** Load the bundled skill-library entries, resolving install state. */
export function loadLibraryEntries(libDir: string, targetDir: string): LibEntry[] {
  const libFiles = fs.readdirSync(libDir).filter((f) => /\.md$/i.test(f));
  return libFiles.map((f) => {
    const libPath = path.join(libDir, f);
    const raw = fs.readFileSync(libPath, 'utf8');
    const id = (/^id:\s*(.+)$/m.exec(raw)?.[1] ?? path.basename(f, '.md')).trim();
    const targetPath = path.join(targetDir, `${id}.md`);
    return {
      id,
      label: (/^label:\s*(.+)$/m.exec(raw)?.[1] ?? id).trim(),
      readOnly: /^true$/i.test(/^readOnly:\s*(true|false)$/im.exec(raw)?.[1] ?? ''),
      tags: (/^tags:\s*\[([^\]]*)\]/m.exec(raw)?.[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean),
      libPath,
      targetPath,
      installed: fs.existsSync(targetPath),
    };
  }).sort((a, b) => a.id.localeCompare(b.id));
}

/** Merge user-created workspace agents (not in the bundled library) into `entries`. */
export function mergeCustomEntries(entries: LibEntry[], targetDir: string): void {
  const knownIds = new Set(entries.map((e) => e.id));
  let files: string[] = [];
  try { files = fs.readdirSync(targetDir).filter((f) => /\.md$/i.test(f)); }
  catch { files = []; }
  for (const f of files) {
    const id = path.basename(f, '.md');
    if (knownIds.has(id)) { continue; }
    const targetPath = path.join(targetDir, f);
    const raw = (() => { try { return fs.readFileSync(targetPath, 'utf8'); } catch { return ''; } })();
    entries.push({
      id,
      label: (/^label:\s*(.+)$/m.exec(raw)?.[1] ?? id).trim(),
      readOnly: false,
      tags: (/^tags:\s*\[([^\]]*)\]/m.exec(raw)?.[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean),
      libPath: targetPath, // no bundled origin — the workspace file is canonical
      targetPath,
      installed: true,
    });
    knownIds.add(id);
  }
  entries.sort((a, b) => a.id.localeCompare(b.id));
}

/** Markdown template for a brand-new custom agent. */
export function newAgentTemplate(id: string, label: string): string {
  return `---
id: ${id}
label: ${label}
readOnly: false
tags: [custom]
---

# ${label}

## Role
Describe what this agent does in one or two sentences.

## Instructions
- Step 1: …
- Step 2: …
- Step 3: …

## Output format
Explain the structure of the response you want this agent to produce.
`;
}

/**
 * Apply the user's tick selections: copy newly-enabled bundled skills into the
 * workspace, remove disabled ones (prompting when local edits exist).
 */
export async function applySkillSelections(
  entries: LibEntry[],
  wantEnabled: Set<string>,
): Promise<{ added: number; removed: number }> {
  // Re-stat in case an edit action just created a file.
  for (const e of entries) { e.installed = fs.existsSync(e.targetPath); }
  let added = 0;
  let removed = 0;
  for (const e of entries) {
    const shouldEnable = wantEnabled.has(e.id);
    if (shouldEnable && !e.installed) {
      try {
        fs.copyFileSync(e.libPath, e.targetPath);
        added++;
      } catch (err) {
        vscode.window.showWarningMessage(
          `Failed to enable "${e.id}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } else if (!shouldEnable && e.installed) {
      try {
        // Only auto-remove files that match the bundled library content to
        // avoid clobbering user customisations of the same id.
        const existing = fs.readFileSync(e.targetPath, 'utf8');
        const bundled = fs.readFileSync(e.libPath, 'utf8');
        if (existing === bundled) {
          fs.unlinkSync(e.targetPath);
          removed++;
        } else {
          const choice = await vscode.window.showWarningMessage(
            `"${e.id}.md" has local edits. Remove anyway?`,
            { modal: true },
            'Remove', 'Keep',
          );
          if (choice === 'Remove') {
            fs.unlinkSync(e.targetPath);
            removed++;
          }
        }
      } catch (err) {
        vscode.window.showWarningMessage(
          `Failed to disable "${e.id}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
  return { added, removed };
}
