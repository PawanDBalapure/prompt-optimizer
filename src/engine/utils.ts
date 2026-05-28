import { createHash } from 'node:crypto';

/**
 * Returns a stable 32-character hex key for use in the prompt_versions table.
 * sha256 of the normalised prompt text prevents collisions between prompts
 * that share the same first 120 characters.
 */
export function hashPromptKey(rawPrompt: string): string {
  return createHash('sha256')
    .update(rawPrompt.trim().toLowerCase())
    .digest('hex')
    .slice(0, 32);
}

/** Race a promise against a timeout; resolve with `defaultValue` on timeout. */
export function withTimeout<T>(promise: Promise<T>, ms: number, defaultValue: T): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(defaultValue), ms);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}
