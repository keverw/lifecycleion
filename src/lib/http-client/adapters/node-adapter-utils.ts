import { defineEntry } from '../../internal/define-entry';

export function normalizeNodeRequestHeaders(
  headers: Record<string, string | string[] | number | undefined>,
): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};

  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }

    defineEntry(
      result,
      key.toLowerCase(),
      Array.isArray(value) ? value.map((item) => String(item)) : String(value),
    );
  }

  return result;
}
