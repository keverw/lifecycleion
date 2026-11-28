import { isNullish } from '../../internal/is-nullish';
import { describeValue } from '../../internal/describe-value';

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
  return prototype === null || isRealmRootPrototype(prototype);
}

/**
 * Whether `value` is a realm's `Object.prototype` - this one, or another realm's (a `vm`
 * context's, an iframe's). Read by shape, not identity: no prototype of its own, and the
 * `Object.prototype` methods as its own properties - each a function, or an accessor as a
 * hardened realm (SES) makes some - read by descriptor, so no getter runs. A caller's
 * null-prototype dictionary used as a base has no such entries, or holds plain values
 * under those names.
 */
export function isRealmRootPrototype(value: object): boolean {
  return (
    value === Object.prototype ||
    (Reflect.getPrototypeOf(value) === null &&
      ROOT_PROTOTYPE_METHODS.every((name) => {
        const descriptor = Reflect.getOwnPropertyDescriptor(value, name);

        return (
          descriptor !== undefined &&
          (!('value' in descriptor) || typeof descriptor.value === 'function')
        );
      }))
  );
}

/** Methods every realm's `Object.prototype` holds as its own. */
const ROOT_PROTOTYPE_METHODS = [
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toString',
  'valueOf',
] as const;

/** Throw a `TypeError` naming `label` unless `value` is nullish or a plain record. */
export function assertOptionalHeaderRecord(
  value: unknown,
  label: string,
): void {
  if (!isNullish(value)) {
    assertHeaderRecord(value, label);
  }
}

/** Throw a `TypeError` naming `label` unless `value` is a plain record. */
export function assertHeaderRecord(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (!isPlainRecord(value)) {
    throw new TypeError(
      `${label} must be a plain object of header names to values, not a Headers, Map or array (got ${describeValue(value)})`,
    );
  }
}
