/**
 * Refuses a `.params()` value `qs` would throw on when the query is built, so a data
 * condition - a `Date` parsed from bad input - is refused where it is handed over, as a
 * body that cannot be copied is, rather than rejecting `send()` with `qs`'s own
 * `RangeError`: a `Date` (by `instanceof`, as `qs` tells one) that `toISOString`, the
 * call `qs` serializes it by, throws on, and an object nested inside itself. Walks the
 * own enumerable keys `qs` walks - a typed array's too, all but a `Buffer`'s, which `qs`
 * sends as its text - through data properties only, so no getter runs before `qs` reads
 * it; a getter's value, and a nested object changed after this call, are still read only
 * by `qs`, at `send()`. A nested `Proxy` is asked for its keys and descriptors here, so
 * its `ownKeys` and `getOwnPropertyDescriptor` traps run, and throw, here too.
 */
export function assertSerializableParams(
  params: Record<string, unknown>,
): void {
  const ancestors = new Set<object>();
  ancestors.add(params);
  for (const key of Object.keys(params)) {
    checkParamValue(params, key, key, ancestors);
  }
}

function checkParamValue(
  holder: object,
  key: string,
  path: string,
  ancestors: Set<object>,
): void {
  const descriptor = Reflect.getOwnPropertyDescriptor(holder, key);
  if (descriptor === undefined || !('value' in descriptor)) {
    return;
  }

  const value: unknown = descriptor.value;
  if (typeof value !== 'object' || value === null || isNodeBuffer(value)) {
    return;
  }

  if (value instanceof Date) {
    try {
      Date.prototype.toISOString.call(value);
    } catch {
      throw new TypeError(
        `HTTPRequestBuilder params.${path} is not a valid Date, so it cannot be put in a query`,
      );
    }
    return;
  }

  if (ancestors.has(value)) {
    throw new TypeError(
      `HTTPRequestBuilder params.${path} is an object it is nested inside, so it cannot be put in a query`,
    );
  }

  ancestors.add(value);
  for (const nestedKey of Object.keys(value)) {
    checkParamValue(value, nestedKey, `${path}.${nestedKey}`, ancestors);
  }
  ancestors.delete(value);
}

/** Whether `value` is a `Buffer`, which `qs` sends as its text rather than walking it. */
function isNodeBuffer(value: object): boolean {
  return typeof Buffer === 'function' && Buffer.isBuffer(value);
}
