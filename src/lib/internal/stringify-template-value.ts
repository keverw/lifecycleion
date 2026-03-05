/**
 * Normalizes values to the same string representation used by template rendering.
 */
export function stringifyTemplateValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  return String(value);
}
