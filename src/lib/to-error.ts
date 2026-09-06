/**
 * Coerce whatever was thrown or rejected with into an `Error`.
 *
 * `throw` accepts any value and a promise can reject with any value, so a failure path
 * must not assume it was handed an `Error`. Reading `.message` off `null` raises a
 * `TypeError` of its own, and on a reporting path that one escapes into the caller that
 * was only trying to report a failure.
 *
 * Shared rather than per-module: `safe-handle-callback`, `Logger` sinks, `Logger` event
 * handlers, `LifecycleManager`, and the HTTP client's adapters all need the same
 * guarantee, and a second copy would drift.
 *
 * **An `Error` is returned unchanged** - same identity, `stack`, `message`, and `cause` -
 * so a caller that only ever throws `Error`s sees nothing new.
 *
 * **Anything else becomes `Non-error value thrown: <description>`**, with the original
 * value kept on `cause`. The prefix is the point: it says the failure path was handed
 * something that was never an `Error`, which a bare `String(value)` would have disguised.
 * Read `cause`, not the message, to recover the thrown value.
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

/**
 * Describe any thrown or rejected value as a single-line string, without ever throwing.
 *
 * `toError` guarantees an `Error` *object*, not a readable one: it returns an `Error`
 * instance unchanged — deliberately, so the original identity, `stack`, and `cause`
 * survive for a caller that needs them — and `message` is an ordinary property that a
 * subclass or a `Proxy` can turn into an accessor that throws. So `toError(value).message`
 * is still an unguarded read, and on a reporting path that throw escapes into the caller
 * that was only trying to report a failure.
 *
 * This is the pairing for the common case: normalize, then read, both guarded. Reach for
 * it anywhere a failure has to become text — a `console.error`, a template literal, a log
 * line — and for `toError` only when the `Error` object itself is what you need.
 *
 * For the full multi-line rendering of an error's `name`, `code`, `additionalInfo`, and
 * `stack`, see `errorToString` in `error-to-string`, which is guarded the same way.
 *
 * @returns The value's message, or a placeholder when it cannot be read. Never throws.
 */
export function describeError(value: unknown): string {
  try {
    const message: unknown = toError(value).message;

    return typeof message === 'string' ? message : String(message);
  } catch {
    // `message` may be an accessor that throws, and a non-string `message` may be an
    // object whose `toString` throws in turn.
    return '<error message could not be read>';
  }
}
