import { readUnknownMember } from './read-member';

/**
 * A one-line stand-in for a `Buffer`, `TypedArray` or `DataView`.
 *
 * Names the kind and the size, which is what a reader wants to know about attached binary
 * data, and costs one leaf rather than one per byte.
 *
 * Shared by `serializeError` and the template renderer, which reach for it under different
 * rules: `serializeError` uses it for *every* view, because an IPC payload has no business
 * carrying one JSON key per byte; the renderer uses it only when the decoded text could not
 * fit the budget anyway - see `stringifyTemplateValue`, where `String(Buffer.from('hello'))`
 * is still `hello`. Held here so the two produce the same text without either importing the
 * other's entry point.
 */
export function describeBinaryView(value: object): string {
  // Guarded read, as everything else on these paths is: `constructor` and `name` are
  // ordinary properties on a subclass or `Proxy`'s prototype and can throw.
  const name = readUnknownMember(
    readUnknownMember(value, 'constructor'),
    'name',
  );

  // Through the intrinsic getter, not the property: the size printed here is the size the
  // reader will believe, and a subclass is free to claim any other.
  const byteLength = readBinaryByteLength(value);

  return `<binary: ${typeof name === 'string' && name.length > 0 ? name : 'ArrayBufferView'}, ${byteLength === null ? 'unknown' : String(byteLength)} bytes>`;
}

/**
 * The `byteLength` getter every `TypedArray` inherits, and the one `DataView` declares.
 *
 * Taken from the prototypes once, at load, so {@link readBinaryByteLength} can measure a
 * view without asking the view. Both read an internal slot, which is the only honest
 * answer available: `byteLength` is an accessor, and a subclass may override it -
 * `class Evil extends Uint8Array { get byteLength() { return 0 } }` passes
 * `ArrayBuffer.isView` and reports nothing while holding twenty megabytes.
 */
// Detached from its object deliberately, which is exactly what `unbound-method` warns
// about: the whole point is to call it on a value that may have overridden its own. The
// `this` it is called with is supplied explicitly below.
/* eslint-disable @typescript-eslint/unbound-method */
const TYPED_ARRAY_BYTE_LENGTH = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype) as object,
  'byteLength',
)?.get;

const DATA_VIEW_BYTE_LENGTH = Object.getOwnPropertyDescriptor(
  DataView.prototype,
  'byteLength',
)?.get;
/* eslint-enable @typescript-eslint/unbound-method */

/**
 * How many bytes a view actually holds, or `null` when that cannot be established.
 *
 * Measured through the intrinsic getters above rather than by reading the property, and
 * that is the whole point of the function: the caller uses this to decide whether
 * rendering the view could overrun a budget, so a size the *value* supplies is worth
 * nothing. A subclass that under-reports would otherwise be handed the slow path it just
 * claimed not to need - which is the one case a size check exists to catch.
 *
 * `null` - a foreign-realm view neither getter recognizes, a detached buffer, a host
 * without one of the intrinsics - means "no usable measurement", and every caller reads
 * that as "assume it does not fit", the way every other bound here fails closed on a
 * measurement it could not take.
 */
export function readBinaryByteLength(value: object): number | null {
  for (const getter of [TYPED_ARRAY_BYTE_LENGTH, DATA_VIEW_BYTE_LENGTH]) {
    if (getter === undefined) {
      continue;
    }

    try {
      const byteLength: unknown = getter.call(value);

      if (typeof byteLength === 'number' && Number.isFinite(byteLength)) {
        return byteLength >= 0 ? byteLength : null;
      }
    } catch {
      // Not this kind of view - `%TypedArray%.prototype.byteLength` throws on a `DataView`
      // and vice versa - so try the other before giving up.
      continue;
    }
  }

  return null;
}
