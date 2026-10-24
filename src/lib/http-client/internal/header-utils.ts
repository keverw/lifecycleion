import {
  BROWSER_FORBIDDEN_METHOD_OVERRIDE_VALUES,
  BROWSER_METHOD_OVERRIDE_HEADER_NAMES,
  BROWSER_RESTRICTED_HEADERS,
  BROWSER_RESTRICTED_HEADER_PREFIXES,
} from '../consts';
import { defineEntry } from '../../internal/define-entry';
import { isNullish } from '../../internal/is-nullish';
import { isHTTPToken } from './http-token';
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
 * before any adapter sees a request, and every adapter driven directly applies it too,
 * through `copyRequestHeaders`.
 *
 * A `null` or `undefined` value, or array item, means no header (an array left with no
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

/**
 * Remove every entry named `name` (lowercase), in any case, from `headers` - a record the
 * caller owns, such as an adapter's copy of its request headers.
 */
export function deleteHeader(
  headers: Record<string, string | string[]>,
  name: string,
): void {
  for (const key of Object.keys(headers)) {
    if (lowerCaseHeaderName(key) === name) {
      delete headers[key];
    }
  }
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
 * The part of a header a runtime refused, for a refusal message: `the value of header
 * 'name'` or `the name of header 'name'`, `header 'name'` when the runtime does not say
 * which part, or `a header name` whenever the name is not a token - text pasted in whole
 * as a name, `Authorization: Bearer …`, is written nowhere. Never the value: a runtime's
 * own message quotes it, which is why an adapter writes its own.
 */
export function describeRefusedHeader(
  name: string,
  part: 'name' | 'value' | 'header',
): string {
  // A token, as every transport requires a header name to be.
  if (!isHTTPToken(name)) {
    return 'a header name';
  }

  return part === 'header'
    ? `header '${name}'`
    : `the ${part} of header '${name}'`;
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
 * A request's headers as the `(name, value)` pairs a browser transport is handed one at a
 * time - `fetch`'s `Headers`, XHR's `setRequestHeader` - with every `Cookie` spelling and
 * item joined into one pair, last, by NodeAdapter's rule (see {@link joinCookieHeader}):
 * appended separately they were joined with `, `, which reads as one cookie. An array
 * value's items are a pair each.
 */
export function requestHeaderPairs(
  headers: Record<string, string | string[]>,
): Array<[string, string]> {
  const entries = Object.entries(headers);
  const pairs: Array<[string, string]> = [];

  for (const [key, value] of entries) {
    if (lowerCaseHeaderName(key) === 'cookie') {
      continue;
    }

    for (const item of Array.isArray(value) ? value : [value]) {
      pairs.push([key, item]);
    }
  }

  const cookie = joinCookieHeader(entries);
  if (cookie !== undefined) {
    pairs.push([cookie.name, cookie.value]);
  }

  return pairs;
}

/**
 * Join repeated request header values into the single field each transport sends:
 * `; ` for `Cookie` (the RFC 6265 cookie-pair delimiter), `, ` for everything else.
 * Shared by NodeAdapter and MockAdapter, so it stays free of Node-only imports.
 */
export function materializeRequestHeaders(
  headers: Record<string, string | string[]>,
  /** Name every header in lowercase, as a Node server receives it (MockAdapter). */
  options: { isLowercasingNames?: boolean } = {},
): Record<string, string> {
  const result: Record<string, string> = {};
  // Names that differ only in case are one header, joined under the first spelling, as
  // `fetch`'s `Headers` joins them: Node's `http` lowercases names and kept only the last.
  const spellings = new Map<string, string>();
  const isLowercasingNames = options.isLowercasingNames === true;
  const entries = Object.entries(headers);
  // `Cookie` by the one rule every adapter joins it with (see `joinCookieHeader`), put in
  // where its first set spelling stands.
  const cookie = joinCookieHeader(entries);

  for (const [key, value] of entries) {
    const lower = lowerCaseHeaderName(key);

    if (lower === 'cookie') {
      if (cookie !== undefined && key === cookie.name) {
        defineEntry(result, isLowercasingNames ? lower : key, cookie.value);
      }
      continue;
    }

    const present = presentHeaderValue(value);
    if (present === undefined) {
      continue;
    }

    const joined = Array.isArray(present) ? present.join(', ') : present;
    const spelling = spellings.get(lower);

    if (spelling === undefined) {
      const name = isLowercasingNames ? lower : key;
      spellings.set(lower, name);
      defineEntry(result, name, joined);
    } else {
      defineEntry(result, spelling, `${result[spelling]}, ${joined}`);
    }
  }

  return result;
}
