/**
 * `chunks` joined into one fresh array of `byteLength` bytes, copied once. Fresh, not a
 * view: a `Buffer` from Node's pool shares its `ArrayBuffer` with other data.
 */
export function concatChunks(
  chunks: readonly Uint8Array[],
  byteLength: number,
): Uint8Array {
  const bytes = new Uint8Array(byteLength);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return bytes;
}
