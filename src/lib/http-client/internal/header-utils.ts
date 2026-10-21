import {
  BROWSER_FORBIDDEN_METHOD_OVERRIDE_VALUES,
  BROWSER_METHOD_OVERRIDE_HEADER_NAMES,
  BROWSER_RESTRICTED_HEADERS,
  BROWSER_RESTRICTED_HEADER_PREFIXES,
} from '../consts';
import { defineEntry } from '../../internal/define-entry';
import { isNullish } from '../../internal/is-nullish';
import type { RequestHeadersInput } from '../types';

/**
 * A header name lowercased in ASCII only, as HTTP header names are compared: `toLowerCase`
 * maps the Kelvin sign U+212A to `k`, turning `X-Key` - a name every transport refuses -
 * into the valid `x-key`, and grouping it with a real `x-key`.
 */
export function lowerCaseHeaderName(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

/**
 * A header value as every header normalizer reads it - the one rule they share, so a
 * header is present or absent alike on the wire and to observers. HTTPClient applies it
 * before any adapter sees a request; driven directly, NodeAdapter and MockAdapter apply
 * it too, while FetchAdapter and XHRAdapter pass the values they are given on as is. A
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
  const lowerKey = lowerCaseHeaderName(key);

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
 * Used by `HTTPClient` in a browser runtime to fail fast during development; an adapter
 * driven directly does not run it.
 */
export function assertNoBrowserRestrictedHeaders(
  headers: RequestHeadersInput,
  adapterName: string,
): void {
  for (const [key, value] of Object.entries(headers)) {
    const present = presentHeaderValue(value);
    // An unset header is not sent, so it is not refused either.
    if (present === undefined) {
      continue;
    }
    if (
      isBrowserRestrictedHeader(
        key,
        Array.isArray(present) ? present.join(', ') : present,
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
 * Every spelling of `Cookie` among `entries` as the one field NodeAdapter and MockAdapter
 * send - {@link materializeRequestHeaders}' rule, for the adapters that build their own:
 * each value read as {@link presentHeaderValue} reads it (an unset one, or an array with
 * no items, left out), items and spellings joined with `; `, under the first set
 * spelling's name. `undefined` when none is set.
 */
export function joinCookieHeader(
  entries: ReadonlyArray<readonly [string, unknown]>,
): { name: string; value: string } | undefined {
  let name: string | undefined;
  const parts: string[] = [];

  for (const [key, value] of entries) {
    if (lowerCaseHeaderName(key) !== 'cookie') {
      continue;
    }
    const present = presentHeaderValue(value);
    if (present === undefined) {
      continue;
    }
    name ??= key;
    parts.push(Array.isArray(present) ? present.join('; ') : present);
  }

  return name === undefined ? undefined : { name, value: parts.join('; ') };
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
  // Names that differ only in case are one header, joined under the first spelling, as
  // `fetch`'s `Headers` joins them: Node's `http` lowercases names and kept only the last.
  const spellings = new Map<string, string>();

  for (const [key, value] of Object.entries(headers)) {
    const present = presentHeaderValue(value);
    if (present === undefined) {
      continue;
    }

    const lower = lowerCaseHeaderName(key);
    const separator = lower === 'cookie' ? '; ' : ', ';
    const joined = Array.isArray(present) ? present.join(separator) : present;
    const spelling = spellings.get(lower);

    if (spelling === undefined) {
      spellings.set(lower, key);
      defineEntry(result, key, joined);
    } else {
      defineEntry(result, spelling, `${result[spelling]}${separator}${joined}`);
    }
  }

  return result;
}
