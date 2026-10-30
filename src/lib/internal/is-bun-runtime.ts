/**
 * Whether this is Bun. Read with care, at load: React Native's `process` and a browser
 * bundle's stand-in have no `versions`.
 */
export const isBunRuntime =
  typeof process === 'object' &&
  process !== null &&
  typeof (process as { versions?: { bun?: unknown } }).versions?.bun ===
    'string';
