/** A value for an error message, by its type only: a string's contents are never written. */
export function describeValue(value: unknown): string {
  return value === null ? 'null' : typeof value;
}
