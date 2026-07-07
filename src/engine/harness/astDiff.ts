import { extractSkeleton } from './slicer.js';

/**
 * Structural diff validation: compare the pre-edit and post-edit skeletons
 * (named functions/classes/methods + branch/loop counts) and flag changes
 * that fall outside what the request asked for.  The agent's response never
 * flows through the optimizer automatically, so this is exposed as a CLI
 * verdict (`--harness-validate-diff`) IDE hosts can call after generation.
 */

export interface StructuralDiffVerdict {
  ok: boolean;
  warnings: string[];
  removed: string[];
  added: string[];
}

function label(key: string): string {
  const [kind, name] = key.split(':');
  return name ? `${kind} "${name}"` : `${kind} block`;
}

/** True when the request text mentions the construct's name. */
function mentionedInRequest(key: string, requestLower: string): boolean {
  const name = key.split(':')[1];
  return name !== undefined && requestLower.includes(name.toLowerCase());
}

/**
 * Compare original vs modified code structure.  Named constructs that vanish
 * (or appear) without being mentioned in the request produce warnings;
 * anonymous branch/loop count drops are reported as softer signals.
 */
export function validateStructuralDiff(
  original: string,
  modified: string,
  request: string,
): StructuralDiffVerdict {
  const before = extractSkeleton(original);
  const after = extractSkeleton(modified);
  const requestLower = request.toLowerCase();

  const removed: string[] = [];
  const added: string[] = [];
  const warnings: string[] = [];

  for (const [key, count] of before) {
    const afterCount = after.get(key) ?? 0;
    if (afterCount >= count) { continue; }
    removed.push(key);
    if (key.includes(':') && !mentionedInRequest(key, requestLower)) {
      warnings.push(`Agent removed ${label(key)} which was not part of the request.`);
    } else if (!key.includes(':') && count - afterCount > 1) {
      warnings.push(`Agent removed ${count - afterCount} ${label(key)}s — verify no logic was dropped.`);
    }
  }
  for (const [key, count] of after) {
    const beforeCount = before.get(key) ?? 0;
    if (count <= beforeCount) { continue; }
    added.push(key);
    if (key.includes(':') && !mentionedInRequest(key, requestLower)) {
      warnings.push(`Agent added ${label(key)} which was not requested.`);
    }
  }

  return { ok: warnings.length === 0, warnings, removed, added };
}
