/** Pure string-escaping helpers shared by security + rendering modules. */

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function sqlLikeToRegExp(pattern: string): RegExp {
  let source = '';
  for (const char of pattern) {
    if (char === '%') {
      source += '.*';
    } else if (char === '_') {
      source += '.';
    } else {
      source += escapeRegExp(char);
    }
  }
  return new RegExp(source, 'i');
}

export function matchesExactLiteralAtBoundaries(prompt: string, pattern: string): boolean {
  const escapedPattern = escapeRegExp(pattern.trim());
  if (escapedPattern === '') {
    return false;
  }
  return new RegExp(
    `(^|[^A-Za-z0-9_])${escapedPattern}(?=$|[^A-Za-z0-9_])`,
    'i',
  ).test(prompt);
}
