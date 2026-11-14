/**
 * A string's UTF-8 byte length, measured rather than encoded, so a large body is not
 * copied to be measured: Node's native count where there is a `Buffer` - a string body is
 * measured on every send - and {@link countUTF8ByteLength} where there is none, as in a
 * browser. The two agree, a lone surrogate counted as U+FFFD's three bytes by both.
 */
export const utf8ByteLength: (text: string) => number =
  typeof Buffer === 'function'
    ? (text) => Buffer.byteLength(text)
    : countUTF8ByteLength;

/**
 * A string's UTF-8 byte length, counted by its UTF-16 units. A lone surrogate counts as
 * the three bytes of U+FFFD it is encoded as.
 */
export function countUTF8ByteLength(text: string): number {
  let bytes = 0;

  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);

    if (unit < 0x80) {
      bytes += 1;
    } else if (unit < 0x800) {
      bytes += 2;
    } else if (
      unit >= 0xd800 &&
      unit <= 0xdbff &&
      index + 1 < text.length &&
      (text.charCodeAt(index + 1) & 0xfc00) === 0xdc00
    ) {
      bytes += 4;
      index++;
    } else {
      bytes += 3;
    }
  }

  return bytes;
}
