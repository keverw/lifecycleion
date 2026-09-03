import { stringifyTemplateValue } from './stringify-template-value';

/** Whether a value is a plain object or an array, and so has a shape worth rebuilding. */
function isWalkableContainer(value: unknown): value is object {
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

/** Applies the caller's masking to one leaf value. */
export type MaskLeaf = (key: string, value: string) => unknown;

/**
 * Mask every leaf of a value, keeping its shape.
 *
 * Naming a container in `redactedKeys` or `sensitiveFieldNames` used to stringify it and
 * mask the result, which was wrong twice over. `String({ a: 'secret' })` is
 * `'[object Object]'`, so the mask was applied to text that was never the secret and the
 * structure was replaced by a meaningless `[ob*********ct]`. An array fared worse:
 * `['topsecret', 'other']` joined to `'topsecret,other'` and masked proportionally, so
 * the edges of the first and last elements survived into the output.
 *
 * Masking each leaf and rebuilding the container fixes both, and keeps the shape intact
 * for a structured sink that reads the redacted params.
 *
 * @param key   The entry as the caller wrote it. Every leaf under it is masked because of
 *              that one entry, so that is the key each leaf is reported under - a
 *              `redactFunction` keyed on it keeps working for a container.
 * @param value The value to mask.
 * @param mask  Applied to each leaf, already stringified the way templates render it.
 * @param seen  Guards against a container that contains itself.
 */
export function maskValueDeep(
  key: string,
  value: unknown,
  mask: MaskLeaf,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  // Only a plain object or an array is walked. Anything else that happens to be an
  // object has a string form worth keeping - an `Error` renders `Error: boom`, a `Date`
  // renders its timestamp - and walking it would replace that with `[object Object]`,
  // which tells a reader less than the masked string does.
  //
  // Tested by prototype rather than with `is-plain-object`, which accepts an `Error` and
  // a `Date` too. Guarded because reading the prototype of a revoked `Proxy` throws.
  if (!isWalkableContainer(value)) {
    return mask(key, stringifyTemplateValue(value));
  }

  if (seen.has(value)) {
    // A cycle cannot be rebuilt, and must not be walked forever. Nothing of the original
    // survives here, which is the safe direction.
    return '***REDACTED***';
  }

  seen.add(value);

  try {
    if (Array.isArray(value)) {
      return (value as unknown[]).map((item) =>
        maskValueDeep(key, item, mask, seen),
      );
    }

    const masked: Record<string, unknown> = {};

    for (const [entryKey, entryValue] of Object.entries(value)) {
      masked[entryKey] = maskValueDeep(key, entryValue, mask, seen);
    }

    return masked;
  } finally {
    // Released so a value referenced twice side by side is masked both times rather than
    // the second being reported as a cycle.
    seen.delete(value);
  }
}
