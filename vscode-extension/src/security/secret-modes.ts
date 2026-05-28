import type { SecretPatternMatchMode } from '../types';

export const SECRET_PATTERN_MODE_VALUES: SecretPatternMatchMode[] = [
  'regex', 'like', 'contains', 'startsWith', 'endsWith', 'exact',
];

export const SECRET_PATTERN_MODE_LABELS: Record<SecretPatternMatchMode, string> = {
  regex: 'Regex',
  like: 'SQL LIKE',
  contains: 'Contains',
  startsWith: 'Starts with',
  endsWith: 'Ends with',
  exact: 'Exact text',
};

export const SECRET_PATTERN_MODE_PLACEHOLDERS: Record<SecretPatternMatchMode, string> = {
  regex: 'Regex source, e.g. mytoken-[a-z0-9]{32}',
  like: 'SQL LIKE pattern, e.g. %Authorization: Bearer%',
  contains: 'Literal text contained on any line, e.g. Authorization: Bearer',
  startsWith: 'Any line starts with this text, e.g. sk-',
  endsWith: 'Any line ends with this text, e.g. -----END PRIVATE KEY-----',
  exact: 'Standalone exact text on a line, e.g. ghp_exampletokenvalue',
};

export function normalizeSecretPatternMode(value: unknown): SecretPatternMatchMode {
  switch (value) {
    case 'like':
    case 'contains':
    case 'startsWith':
    case 'endsWith':
    case 'exact':
    case 'regex':
      return value;
    default:
      return 'regex';
  }
}
