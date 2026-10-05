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

export function materializeNodeRequestHeaders(
  headers: Record<string, string | string[]>,
): Record<string, string> {
  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(headers)) {
    if (!Array.isArray(value)) {
      defineEntry(result, key, value);
      continue;
    }

    defineEntry(
      result,
      key,
      key.toLowerCase() === 'cookie'
        ? // RFC 6265 cookie-pair delimiter for a single Cookie header field.
          value.join('; ')
        : value.join(', '),
    );
  }

  return result;
}
