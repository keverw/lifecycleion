/** A value for an error message: a string as written, anything else by its type. */
export function describeValue(value: unknown): string {
  return value === null
    ? 'null'
    : typeof value === 'string'
      ? `'${value}'`
      : typeof value;
}
