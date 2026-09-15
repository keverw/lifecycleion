/**
 * Whether a value is a plain object or an array.
 *
 * The one rule the redaction and rendering code both turn on: a plain object or an array
 * is *structure*, so it is walked, its contents addressed by path, and its shape rebuilt.
 * Anything else - an `Error`, a `Date`, a `Map`, a `URL`, a class instance - is a *value*,
 * so it is rendered by its own string form and masked as a single leaf.
 *
 * Shared rather than copied because three walks depend on it agreeing with itself:
 * `maskValueDeep` decides what to rebuild, `stringifyTemplateValue` decides what to render
 * as JSON, and a disagreement between them would mean a value masked one way and rendered
 * another. It had drifted into two identical private copies already.
 *
 * Tested by prototype rather than with `is-plain-object`, which accepts an `Error` and a
 * `Date` too. Guarded because reading the prototype of a revoked `Proxy` throws.
 */
export function isPlainContainer(value: unknown): value is object {
  if (value === null || typeof value !== 'object') {
    return false;
  }

  try {
    if (Array.isArray(value)) {
      return true;
    }

    const prototype: unknown = Object.getPrototypeOf(value);

    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}
