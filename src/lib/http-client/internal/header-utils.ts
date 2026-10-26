import {
  BROWSER_FORBIDDEN_METHOD_OVERRIDE_VALUES,
  BROWSER_METHOD_OVERRIDE_HEADER_NAMES,
  BROWSER_RESTRICTED_HEADERS,
  BROWSER_RESTRICTED_HEADER_PREFIXES,
} from '../consts';
import { defineEntry } from '../../internal/define-entry';
import { isNullish } from '../../internal/is-nullish';
import { isHTTPToken } from './http-token';
import { copyArrayValue } from './array-copy';
import { asciiLowercase } from './http-method';
import type { RequestHeadersInput } from '../types';

/**
 * A header name lowercased in ASCII only, as HTTP header names are compared: `toLowerCase`
 * maps the Kelvin sign U+212A to `k`, turning `X-Key` - a name every transport refuses -
 * into the valid `x-key`, and grouping it with a real `x-key`.
 */
export const lowerCaseHeaderName: (name: string) => string = asciiLowercase;

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
 * A copy of a header record the client built, its arrays copied too: a record handed on -
 * to an observer, an interceptor, an adapter, the next attempt - shares no array with the
 * one it was copied from, so an item one of them changes in place reaches no other.
 */
export function copyHeaderRecord(
  headers: Record<string, string | string[]>,
): Record<string, string | string[]> {
  const copy: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    defineEntry(copy, name, copyArrayValue(value));
  }
  return copy;
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

/** Empty, or only the whitespace `fetch` trims from a header value (tab, LF, CR, space). */
const HTTP_WHITESPACE_ONLY = /^[\t\n\r ]*$/;

/** That same whitespace at either end of a value; `trim()` also takes U+00A0 and more. */
const HTTP_WHITESPACE_EDGES = /^[\t\n\r ]+|[\t\n\r ]+$/g;

/**
 * `text` without the HTTP whitespace (tab, LF, CR, space) at either end, as a header
 * value's parts are trimmed: `trim()` would also take a no-break space and others.
 */
export function trimHTTPWhitespace(text: string): string {
  return text.replace(HTTP_WHITESPACE_EDGES, '');
}

/**
 * A header value's comma-separated values, split as the Fetch standard's "get, decode,
 * and split" splits them: a comma inside a quoted string (`"a,b"`, with `\` escaping the
 * next character) does not split, and the quotes stay part of the value. Each value is
 * trimmed of HTTP whitespace - the standard trims tab and space only, from a value whose
 * ends `Headers` has already trimmed of all four, and a line break anywhere else makes
 * the value one a browser refuses outright.
 */
function splitHeaderValues(input: string): string[] {
  const values: string[] = [];
  let position = 0;
  let temporaryValue = '';

  while (true) {
    const start = position;
    while (
      position < input.length &&
      input[position] !== '"' &&
      input[position] !== ','
    ) {
      position++;
    }
    temporaryValue += input.slice(start, position);

    if (position < input.length && input[position] === '"') {
      const quoteStart = position;
      position = skipQuotedString(input, position);
      temporaryValue += input.slice(quoteStart, position);

      if (position < input.length) {
        continue;
      }
    }

    values.push(trimHTTPWhitespace(temporaryValue));
    temporaryValue = '';

    if (position >= input.length) {
      return values;
    }

    // At a comma: step past it to the next value.
    position++;
  }
}

/**
 * The position just past the quoted string opening at `position`, as the Fetch
 * standard's "collect an HTTP quoted string" finds it: the closing `"`, a `\` taking the
 * character after it, or the end of the input when the string is never closed.
 */
function skipQuotedString(input: string, position: number): number {
  position++;

  while (position < input.length) {
    const char = input[position];
    position++;

    if (char === '"') {
      break;
    }

    if (char === '\\' && position < input.length) {
      position++;
    }
  }

  return position;
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
  // forbidden method such as TRACE/CONNECT/TRACK through an allowed verb. The
  // value is split as a browser splits it - not inside a quoted string - and each
  // method lowercased in ASCII only, as a browser compares it: `TRAC\u212A`
  // (KELVIN SIGN) is not `track`, and neither is `"TRACK"`.
  if (BROWSER_METHOD_OVERRIDE_HEADER_NAMES.has(lowerKey) && value) {
    return splitHeaderValues(value).some((method) =>
      BROWSER_FORBIDDEN_METHOD_OVERRIDE_VALUES.has(asciiLowercase(method)),
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
        `[${adapterName}] Cannot set ${describeRefusedHeader(key, 'header')}: it is browser-restricted. ` +
          `Browsers silently ignore this header — remove it to avoid subtle bugs.`,
      );
    }
  }
}

/**
 * Every spelling of `Cookie` among `entries` as the one field NodeAdapter and MockAdapter
 * send - {@link materializeRequestHeaders}' rule, for the adapters that build their own:
 * each value read as {@link presentHeaderValue} reads it (an unset one, or an array with
 * no items, left out), items and spellings joined with `; `, under the first spelling
 * with a cookie in it. A value or item that is empty, or only whitespace, holds no cookie
 * and is left out, so it leaves no stray `; ` behind. `undefined` when none holds one: no
 * `Cookie` header is sent.
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
    for (const item of Array.isArray(present) ? present : [present]) {
      if (HTTP_WHITESPACE_ONLY.test(item)) {
        continue;
      }
      name ??= key;
      parts.push(item);
    }
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
  // under the first spelling that holds a cookie.
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
