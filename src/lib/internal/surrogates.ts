/** Whether a UTF-16 unit is the first half of a surrogate pair. */
export function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

/** Whether a UTF-16 unit is the second half of a surrogate pair. */
export function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff;
}
