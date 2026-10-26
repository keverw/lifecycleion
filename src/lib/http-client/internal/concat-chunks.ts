import {
  arrayBufferKindOf,
  readBinaryByteLength,
} from '../../internal/binary-view';

/**
 * `chunks` joined into one plain `Uint8Array` of `byteLength` bytes that spans a
 * fixed-length `ArrayBuffer` of its own, copied once. Not a view: a `Buffer` from Node's
 * pool shares its `ArrayBuffer` with other data. Each chunk is placed by the length its
 * internal slot holds, not the `byteLength` it reports.
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
    bytes.set(chunk, offset);
    offset += readBinaryByteLength(chunk) ?? 0;
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
    Reflect.get(Uint8Array.prototype, 'byteOffset', chunk) !== 0 ||
    readBinaryByteLength(chunk) !== byteLength
  ) {
    return false;
  }

  const buffer = Reflect.get(Uint8Array.prototype, 'buffer', chunk) as object;

  return (
    Object.getPrototypeOf(buffer) === ArrayBuffer.prototype &&
    arrayBufferKindOf(buffer) === 'ArrayBuffer' &&
    // `undefined` where the runtime has no resizable buffers, which leaves it fixed.
    Reflect.get(ArrayBuffer.prototype, 'resizable', buffer) !== true &&
    readBinaryByteLength(buffer) === byteLength
  );
}
