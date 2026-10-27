/**
 * The case and whitespace rules wire and config text is read by. `toLowerCase`,
 * `toUpperCase` and `trim()` are Unicode-aware, which a protocol is not: `toLowerCase`
 * turns the Kelvin sign into `k`, and `trim()` takes a no-break space - the last byte of a
 * UTF-8 `à` once a header is read as latin1. ESLint refuses them in the HTTP client and
 * domain utilities, and points here.
 */

/**
 * `text` with its ASCII letters uppercased, and nothing else: `toUpperCase` would also
 * turn `poſt` (U+017F) into `POST`.
 */
export function asciiUppercase(text: string): string {
  return text.replace(/[a-z]/g, (letter) => letter.toUpperCase());
}

/**
 * `text` with its ASCII letters lowercased, and nothing else: `toLowerCase` would also
 * turn `TRAC\u212A` (KELVIN SIGN) into `track`.
 */
export function asciiLowercase(text: string): string {
  return text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

/**
 * `text` without the characters `isTrimmed` picks, by UTF-16 code unit, at either end. By
 * index rather than a regex: a `[...]+$` branch rescans a run from each of its positions
 * when the run does not end the string, so it takes seconds on 64 KB of spaces between
 * two letters, and the strings trimmed here include a server's header values.
 */
export function trimWhere(
  text: string,
  isTrimmed: (code: number) => boolean,
): string {
  let start = 0;

  while (start < text.length && isTrimmed(text.charCodeAt(start))) {
    start++;
  }

  return trimEndWhere(text.slice(start), isTrimmed);
}

/** `text` without the characters `isTrimmed` picks at its end, as {@link trimWhere} trims. */
export function trimEndWhere(
  text: string,
  isTrimmed: (code: number) => boolean,
): string {
  let end = text.length;

  while (end > 0 && isTrimmed(text.charCodeAt(end - 1))) {
    end--;
  }

  return text.slice(0, end);
}

/** Whether `code` is HTTP whitespace (tab, LF, CR, space), what `fetch` trims from a header value. */
function isHTTPWhitespace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

/**
 * `text` without the HTTP whitespace (tab, LF, CR, space) at either end, as a header
 * value's parts are trimmed: `trim()` would also take a no-break space and others.
 */
export function trimHTTPWhitespace(text: string): string {
  return trimWhere(text, isHTTPWhitespace);
}

/** Whether `code` is a space or a tab. */
function isSpaceOrTab(code: number): boolean {
  return code === 0x20 || code === 0x09;
}

/** `text` without leading and trailing spaces and tabs, the only whitespace RFC 6265bis trims. */
export function trimSpacesAndTabs(text: string): string {
  return trimWhere(text, isSpaceOrTab);
}

/** Whitespace `trim()` takes - any of it - at either end. */
const ANY_WHITESPACE_EDGE = /^\s|\s$/;

/**
 * Whether `text` has whitespace at an end - any whitespace, deliberately: for a name that
 * holds none, where trimming it would turn it into another.
 */
export function hasWhitespaceEdge(text: string): boolean {
  return ANY_WHITESPACE_EDGE.test(text);
}

/**
 * Whether `text`, trimmed of HTTP whitespace (tab, LF, CR, space), still has whitespace at
 * an end - a no-break space picked up from pasted config, a vertical tab, a form feed. Such
 * an entry matches nothing and is refused where it is validated, rather than trimmed into
 * another one: `trim()` took it, so `'\u00A0*'` was the global `*`.
 */
export function hasNonHTTPWhitespaceEdge(text: string): boolean {
  return hasWhitespaceEdge(trimHTTPWhitespace(text));
}

/**
 * Whether `text` is empty or whitespace alone - any whitespace, deliberately: for a name
 * the caller picks (a request label) or a value that must hold something (a PEM trust
 * store), a no-break space is as blank as a space.
 */
export function isBlankText(text: string): boolean {
  return !/\S/.test(text);
}
