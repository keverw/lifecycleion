/** A value for an error message, by its type only: a string's contents are never written. */
export function describeValue(value: unknown): string {
  return value === null ? 'null' : typeof value;
}

/**
 * A value for an error message: a number as itself, anything else as {@link describeValue}
 * names it.
 */
export function describeNumberOrType(value: unknown): string {
  return typeof value === 'number' ? String(value) : describeValue(value);
}
