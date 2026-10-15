import { isNullish } from '../../internal/is-nullish';

/**
 * Whether `value` is a record whose own properties are its entries: an object, not an
 * array, whose prototype is `null` or a root prototype - `Object.prototype`, or another
 * realm's (a `vm` context's plain object). A `Headers` or `Map` keeps its entries off its
 * own properties, so `Object.entries` answers `{}` for it, and a header record taken from
 * one would silently drop every header. Their prototypes inherit from `Object.prototype`
 * in whichever realm made them, so they are never a root.
 */
export function isPlainRecord(
  value: unknown,
): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype = Reflect.getPrototypeOf(value);
  return (
    prototype === null ||
    prototype === Object.prototype ||
    Reflect.getPrototypeOf(prototype) === null
  );
}

/** Throw a `TypeError` naming `label` unless `value` is nullish or a plain record. */
export function assertOptionalHeaderRecord(
  value: unknown,
  label: string,
): void {
  if (!isNullish(value) && !isPlainRecord(value)) {
    throw new TypeError(
      `${label} must be a plain object of header names to values (not a Headers, Map or array)`,
    );
  }
}
