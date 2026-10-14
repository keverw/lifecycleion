import {
  BROWSER_FORBIDDEN_METHOD_OVERRIDE_VALUES,
  BROWSER_METHOD_OVERRIDE_HEADER_NAMES,
  BROWSER_RESTRICTED_HEADERS,
  BROWSER_RESTRICTED_HEADER_PREFIXES,
} from '../consts';
import { defineEntry } from '../../internal/define-entry';
import { isNullish } from '../../internal/is-nullish';

/**
 * A header value as every header normalizer reads it - the one rule they share, so a
 * header is present or absent alike on the wire, to observers and in every adapter. A
 * `null` or `undefined` value, or array item, means no header (an array left with no
 * item is unset too); anything else is converted with `String`. `undefined` when the
 * header is unset.
 */
export function presentHeaderValue(
  value: unknown,
): string | string[] | undefined {
  if (isNullish(value)) {
    return undefined;
  }
  // Converted as a header value always was: what a caller passes is not trusted to be
  // a string, and a number (Node's `getHeaders()`) is one in all but type.
  if (!Array.isArray(value)) {
    // eslint-disable-next-line @typescript-eslint/no-base-to-string -- a caller's value, converted as a header always was
    return String(value);
  }
  const items: string[] = [];
  for (const item of value as unknown[]) {
    if (!isNullish(item)) {
      // eslint-disable-next-line @typescript-eslint/no-base-to-string -- as above
      items.push(String(item));
    }
  }
  return items.length === 0 ? undefined : items;
}

export function isBrowserRestrictedHeader(
  key: string,
  value: string | undefined,
): boolean {
  const lowerKey = key.toLowerCase();

  // Straight denylist: browsers block these header names outright.
  if (BROWSER_RESTRICTED_HEADERS.has(lowerKey)) {
    return true;
  }

  // Prefix-based denylist for browser-owned header namespaces like `sec-*`.
  if (
    BROWSER_RESTRICTED_HEADER_PREFIXES.some((prefix) =>
      lowerKey.startsWith(prefix),
    )
  ) {
    return true;
  }

  // Method-override headers are only restricted when they try to tunnel a
  // forbidden method such as TRACE/CONNECT/TRACK through an allowed verb.
  if (BROWSER_METHOD_OVERRIDE_HEADER_NAMES.has(lowerKey) && value) {
    return value
      .split(',')
      .some((method) =>
        BROWSER_FORBIDDEN_METHOD_OVERRIDE_VALUES.has(
          method.trim().toLowerCase(),
        ),
      );
  }

  return false;
}

/**
 * Throws if any of the given headers are browser-restricted.
 * Used by Fetch and XHR adapters to fail fast during development.
 */
export function assertNoBrowserRestrictedHeaders(
  headers: Record<string, string | string[]>,
  adapterName: string,
): void {
  for (const [key, value] of Object.entries(headers)) {
    if (
      isBrowserRestrictedHeader(
        key,
        Array.isArray(value) ? value.join(', ') : value,
      )
    ) {
      throw new Error(
        `[${adapterName}] Cannot set browser-restricted header "${key}". ` +
          `Browsers silently ignore this header — remove it to avoid subtle bugs.`,
      );
    }
  }
}

/**
 * Returns true if the content-type indicates a JSON body.
 */
export function isJSONContentType(contentType: string | undefined): boolean {
  if (!contentType) {
    return false;
  }

  const lower = contentType.toLowerCase();
  return lower.includes('application/json') || lower.includes('+json');
}

/**
 * Join repeated request header values into the single field each transport sends:
 * `; ` for `Cookie` (the RFC 6265 cookie-pair delimiter), `, ` for everything else.
 * Shared by NodeAdapter and MockAdapter, so it stays free of Node-only imports.
 */
export function materializeRequestHeaders(
  headers: Record<string, string | string[]>,
): Record<string, string> {
  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(headers)) {
    const present = presentHeaderValue(value);
    if (present === undefined) {
      continue;
    }
    if (!Array.isArray(present)) {
      defineEntry(result, key, present);
      continue;
    }

    defineEntry(
      result,
      key,
      key.toLowerCase() === 'cookie' ? present.join('; ') : present.join(', '),
    );
  }

  return result;
}
