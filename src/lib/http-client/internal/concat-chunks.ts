/**
 * `chunks` joined into one fresh array of `byteLength` bytes, copied once. Fresh, not a
 * view: a `Buffer` from Node's pool shares its `ArrayBuffer` with other data.
 *
 * A lone chunk that is a plain `Uint8Array` spanning the whole of its own buffer - a web
 * stream's, as the runtime's `fetch` hands one over - shares it with nothing there, so it
 * is the result as it is, not copied. A `Buffer`, pooled or not, is always copied: the result is a plain
 * `Uint8Array` either way.
 */
export function concatChunks(
  chunks: readonly Uint8Array[],
  byteLength: number,
): Uint8Array {
  if (chunks.length === 1) {
    const [only] = chunks;

    if (
      Object.getPrototypeOf(only) === Uint8Array.prototype &&
      only.byteOffset === 0 &&
      only.byteLength === byteLength &&
      byteLength === only.buffer.byteLength
    ) {
      return only;
    }
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return bytes;
}
