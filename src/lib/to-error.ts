/**
 * Coerce whatever was thrown or rejected with into an `Error`.
 *
 * `throw` accepts any value and a promise can reject with any value, so a failure path
 * must not assume it was handed an `Error`. Reading `.message` off `null` raises a
 * `TypeError` of its own, and on a reporting path that one escapes into the caller that
 * was only trying to report a failure.
 *
 * Shared rather than per-module: `safe-handle-callback`, `Logger` sinks, and `Logger`
 * event handlers all need the same guarantee, and a second copy would drift.
 */
export function toError(value: unknown): Error {
  let description: string;

  try {
    if (value instanceof Error) {
      return value;
    }

    description = typeof value === 'string' ? value : String(value);
  } catch {
    // Both steps run code this module does not own: `instanceof` walks a prototype
    // chain, which a revoked `Proxy` makes throw, and `String()` invokes
    // `toString`/`Symbol.toPrimitive`, which are ordinary properties.
    description = 'unknown value';
  }

  // The value itself is kept as the cause: the description is lossy, and for a value
  // whose `toString` threw it carries nothing at all.
  return new Error(`Non-error value thrown: ${description}`, { cause: value });
}
