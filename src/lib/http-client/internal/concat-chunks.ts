import {
  arrayBufferKindOf,
  readBinaryByteLength,
  readTypedArrayBuffer,
  readTypedArrayByteOffset,
} from '../../internal/binary-view';

const CHANGED_LENGTH_MESSAGE =
  'Response body chunk changed length after it was read';

/**
 * `chunks` joined into one plain `Uint8Array` of `byteLength` bytes that spans a
 * fixed-length `ArrayBuffer` of its own, copied once. Not a view: a `Buffer` from Node's
 * pool shares its `ArrayBuffer` with other data. Each chunk is placed by the length its
 * internal slot holds, not the `byteLength` it reports.
 *
 * Throws a `TypeError` when the chunks no longer hold `byteLength` bytes between them: a
 * chunk over a resizable buffer that grew or shrank after it was counted, or one whose
 * buffer was detached since. None is joined: one that grew would not fit the result, and
 * one that shrank would leave it ending in zeros.
 *
 * A lone chunk that already is that - a plain `Uint8Array` spanning the whole of a plain,
 * fixed-length, unshared `ArrayBuffer`, as a web stream's chunk from the runtime's `fetch`
 * is - shares it with nothing there, so it is the result as it is, not copied. A `Buffer`,
 * pooled or not, is always copied, as is a chunk over a resizable or shared buffer: the
 * result is a plain `Uint8Array` over a plain `ArrayBuffer` either way.
 */
export function concatChunks(
  chunks: readonly Uint8Array[],
  byteLength: number,
): Uint8Array {
  if (chunks.length === 1) {
    const [only] = chunks;

    if (isWholeOfPlainBuffer(only, byteLength)) {
      return only;
    }
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;

  for (const chunk of chunks) {
    const chunkLength = readBinaryByteLength(chunk) ?? 0;

    if (offset + chunkLength > byteLength) {
      throw new TypeError(CHANGED_LENGTH_MESSAGE);
    }

    // Nothing to copy from an empty chunk - nor from a detached one, which measures as
    // empty and which `set` would refuse in the runtime's own words: one counted with
    // bytes leaves the total short, refused below.
    if (chunkLength > 0) {
      bytes.set(chunk, offset);
      offset += chunkLength;
    }
  }

  if (offset !== byteLength) {
    throw new TypeError(CHANGED_LENGTH_MESSAGE);
  }

  return bytes;
}

/**
 * Whether `chunk` is a plain `Uint8Array` of `byteLength` bytes spanning the whole of a
 * plain `ArrayBuffer` that is neither resizable nor shared. Read through the intrinsic
 * getters, so a value's own claims about its buffer or extent count for nothing.
 */
function isWholeOfPlainBuffer(chunk: Uint8Array, byteLength: number): boolean {
  if (
    Object.getPrototypeOf(chunk) !== Uint8Array.prototype ||
    readTypedArrayByteOffset(chunk) !== 0 ||
    readBinaryByteLength(chunk) !== byteLength
  ) {
    return false;
  }

  const buffer = readTypedArrayBuffer(chunk);

  return (
    Object.getPrototypeOf(buffer) === ArrayBuffer.prototype &&
    arrayBufferKindOf(buffer) === 'ArrayBuffer' &&
    // `undefined` where the runtime has no resizable buffers, which leaves it fixed.
    Reflect.get(ArrayBuffer.prototype, 'resizable', buffer) !== true &&
    readBinaryByteLength(buffer) === byteLength
  );
}
