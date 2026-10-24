import { readUnknownMember } from './read-member';

/**
 * A one-line stand-in for a `Buffer`, `TypedArray`, `DataView` or `ArrayBuffer`.
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
 * The `byteLength` getters: the one every `TypedArray` inherits, and the ones `DataView`,
 * `ArrayBuffer` and `SharedArrayBuffer` declare.
 *
 * Taken from the prototypes once, at load, so {@link readBinaryByteLength} can measure a
 * value without asking the value. Each reads an internal slot, which is the only honest
 * answer available: `byteLength` is an accessor, and a subclass may override it -
 * `class Evil extends Uint8Array { get byteLength() { return 0 } }` passes
 * `ArrayBuffer.isView` and reports nothing while holding twenty megabytes.
 *
 * They double as brand checks. Each throws on anything that is not its own kind, which is
 * how {@link isArrayBufferLike} recognizes a buffer without `instanceof` - that operator is
 * realm-bound, and a buffer from an iframe or a `vm` context fails it while being exactly
 * the thing worth naming.
 *
 * `SharedArrayBuffer` is absent in browsers without cross-origin isolation, so it is looked
 * up defensively rather than assumed.
 */
// Detached from its object deliberately, which is exactly what `unbound-method` warns
// about: the whole point is to call it on a value that may have overridden its own. The
// `this` it is called with is supplied explicitly below.
/* eslint-disable @typescript-eslint/unbound-method */
const TYPED_ARRAY_BYTE_LENGTH = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype) as object,
  'byteLength',
)?.get;

const TYPED_ARRAY_LENGTH = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype) as object,
  'length',
)?.get;

const DATA_VIEW_BYTE_LENGTH = Object.getOwnPropertyDescriptor(
  DataView.prototype,
  'byteLength',
)?.get;

const DATA_VIEW_BUFFER = Object.getOwnPropertyDescriptor(
  DataView.prototype,
  'buffer',
)?.get;

const ARRAY_BUFFER_BYTE_LENGTH = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  'byteLength',
)?.get;

const SHARED_ARRAY_BUFFER_BYTE_LENGTH =
  typeof SharedArrayBuffer === 'function'
    ? Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, 'byteLength')
        ?.get
    : undefined;
/* eslint-enable @typescript-eslint/unbound-method */

/** Binary template lookup exposes numeric elements and intrinsic length, not expandos. */
export function readBinaryTemplateMember(value: object, key: string): unknown {
  const length = callByteLengthGetter(TYPED_ARRAY_LENGTH, value);
  if (length === null) {
    return undefined;
  }
  if (key === 'length') {
    return length;
  }
  const index = Number(key);
  if (
    !Number.isSafeInteger(index) ||
    index < 0 ||
    index >= length ||
    String(index) !== key
  ) {
    return undefined;
  }
  return (value as Record<string, unknown>)[key];
}

/** One intrinsic getter's answer for `value`, or `null` when it is not that kind. */
function callByteLengthGetter(
  getter: (() => unknown) | undefined,
  value: object,
): number | null {
  if (getter === undefined) {
    return null;
  }

  let byteLength: unknown;

  try {
    byteLength = getter.call(value);
  } catch {
    // Not this kind - each getter throws on a receiver without its internal slot, which is
    // what makes trying them in turn a brand check rather than a guess.
    return null;
  }

  if (typeof byteLength !== 'number' || !Number.isFinite(byteLength)) {
    return null;
  }

  return byteLength >= 0 ? byteLength : null;
}

/**
 * Whether `value` is an `ArrayBuffer` or `SharedArrayBuffer` - the backing store itself
 * rather than a view over one.
 *
 * `ArrayBuffer.isView` is deliberately false for these, and without this they fell through
 * to the generic object naming and rendered as `[ArrayBuffer]`: correct, cheap, and silent
 * about the one thing worth knowing. There is no decode to avoid here - a buffer has no
 * useful string form at any size - so unlike a view this needs no budget test. It is purely
 * that forty megabytes and two bytes should not read the same.
 */
export function isArrayBufferLike(value: object): boolean {
  return arrayBufferKindOf(value) !== undefined;
}

/**
 * Which kind of buffer `value` is - `ArrayBuffer` or `SharedArrayBuffer` - told by its
 * internal slot through the intrinsic getters, so from any realm; `undefined` for
 * anything else. A detached `ArrayBuffer` is still one (its `byteLength` reads `0`).
 */
export function arrayBufferKindOf(
  value: object,
): 'ArrayBuffer' | 'SharedArrayBuffer' | undefined {
  if (callByteLengthGetter(ARRAY_BUFFER_BYTE_LENGTH, value) !== null) {
    return 'ArrayBuffer';
  }

  if (callByteLengthGetter(SHARED_ARRAY_BUFFER_BYTE_LENGTH, value) !== null) {
    return 'SharedArrayBuffer';
  }

  return undefined;
}

/**
 * Whether `value` presents as bytes by its prototype chain - a typed array, `DataView` or
 * buffer, from any realm, or a `Proxy` over one - read off each prototype's own data
 * (a typed array prototype's `BYTES_PER_ELEMENT`, a `DataView`'s or buffer's
 * `Symbol.toStringTag`) rather than by `instanceof`, which only knows this realm. For a
 * value {@link readBinaryByteLength} cannot measure, to tell bytes it must refuse from a
 * value that is not bytes at all. A prototype chain that throws answers no.
 */
export function presentsAsBinary(value: object): boolean {
  return someInPrototypeChain(
    value,
    (prototype) =>
      Object.getOwnPropertyDescriptor(prototype, 'BYTES_PER_ELEMENT') !==
        undefined || isBinaryTag(ownToStringTag(prototype), true),
  );
}

/**
 * Whether `value`'s prototype chain holds a buffer's own prototype - an `ArrayBuffer` or
 * `SharedArrayBuffer`, from any realm - told by its `Symbol.toStringTag`, read off the
 * prototypes so a `Proxy`'s `get` trap is not run. A chain that throws answers no.
 */
export function hasBufferTagInChain(value: object): boolean {
  return someInPrototypeChain(value, (prototype) =>
    isBinaryTag(ownToStringTag(prototype), false),
  );
}

/** Whether `matches` holds for some prototype in `value`'s chain; `false` if it throws. */
function someInPrototypeChain(
  value: object,
  matches: (prototype: object) => boolean,
): boolean {
  try {
    for (
      let prototype = Object.getPrototypeOf(value) as object | null;
      prototype !== null;
      prototype = Object.getPrototypeOf(prototype) as object | null
    ) {
      if (matches(prototype)) {
        return true;
      }
    }
  } catch {
    // A hostile chain: not bytes as far as can be told.
  }

  return false;
}

/** A prototype's own `Symbol.toStringTag`, as a plain value; getters are not run. */
function ownToStringTag(prototype: object): unknown {
  return Object.getOwnPropertyDescriptor(prototype, Symbol.toStringTag)?.value;
}

/** A buffer's tag, or - with `isViewIncluded` - a `DataView`'s. */
function isBinaryTag(tag: unknown, isViewIncluded: boolean): boolean {
  return (
    tag === 'ArrayBuffer' ||
    tag === 'SharedArrayBuffer' ||
    (isViewIncluded && tag === 'DataView')
  );
}

/**
 * How many bytes a view actually holds, or `null` when that cannot be established.
 *
 * Measured through the intrinsic getters above rather than by reading the property, and
 * that is the whole point of the function: the caller uses this to decide whether
 * rendering the view could overrun a budget, so a size the *value* supplies is worth
 * nothing. A subclass that under-reports would otherwise be handed the slow path it just
 * claimed not to need - which is the one case a size check exists to catch.
 *
 * `null` - a value no getter recognizes (a `Proxy`, which has no internal slots), a host
 * without one of the intrinsics - means "no usable measurement", and every caller reads
 * that as "assume it does not fit", the way every other bound here fails closed on a
 * measurement it could not take. A detached buffer, or a view over one, measures `0`:
 * the getters read it as empty, which is what it holds.
 */
export function readBinaryByteLength(value: object): number | null {
  for (const getter of [
    TYPED_ARRAY_BYTE_LENGTH,
    DATA_VIEW_BYTE_LENGTH,
    ARRAY_BUFFER_BYTE_LENGTH,
    SHARED_ARRAY_BUFFER_BYTE_LENGTH,
  ]) {
    const byteLength = callByteLengthGetter(getter, value);

    if (byteLength !== null) {
      return byteLength;
    }
  }

  // A `DataView` over a detached buffer, or one a resizable buffer shrank out from under:
  // its `byteLength` getter throws where a typed array's reads `0`, so it is told by its
  // `buffer` getter, which does not, and measures `0` as such a typed array does.
  if (isDataViewBrand(value)) {
    return 0;
  }

  return null;
}

/** Whether `value` is a `DataView`, told by an intrinsic getter that never throws for one. */
function isDataViewBrand(value: object): boolean {
  if (DATA_VIEW_BUFFER === undefined) {
    return false;
  }

  try {
    DATA_VIEW_BUFFER.call(value);
    return true;
  } catch {
    return false;
  }
}
