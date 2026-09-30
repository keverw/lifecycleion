export function isFunction(value: unknown): boolean {
  if (typeof value === 'function') {
    return true;
  }
  try {
    return value instanceof Function;
  } catch {
    // Revoked object proxies cannot answer prototype checks.
    return false;
  }
}
