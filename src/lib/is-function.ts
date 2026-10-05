/**
 * Whether `value` is a function.
 *
 * `typeof` answers for ordinary functions, including classes, async functions,
 * generators, and callable proxies. The `instanceof` fallback also accepts an object
 * that inherits from `Function.prototype` without being callable.
 *
 * Never throws: a check that cannot be answered counts as "not a function".
 */
export function isFunction(value: unknown): boolean {
  // The common case, answered without touching the value's prototype chain.
  if (typeof value === 'function') {
    return true;
  }

  // `instanceof` walks the prototype chain, which runs caller code for a proxy
  // (its `getPrototypeOf` trap) and throws outright for a revoked one.
  try {
    return value instanceof Function;
  } catch {
    return false;
  }
}
