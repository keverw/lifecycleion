/**
 * A string's UTF-8 byte length, counted rather than encoded, so a large body is not
 * copied to be measured. A lone surrogate counts as the three bytes of U+FFFD it is
 * encoded as.
 */
export function utf8ByteLength(text: string): number {
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
