import { trimSpacesAndTabs } from '../../internal/ascii-text';

/**
 * Whether every character of `text` can be written into a `Cookie` header as part of
 * one cookie-pair: no control character other than a tab (a CR LF is a header injection,
 * a DEL is refused by the header parser on the other side; a tab is header-safe, and
 * RFC 6265bis keeps a cookie that carries one), no `;` (the pair delimiter), and none
 * of `extra`.
 *
 * Deliberately looser than RFC 6265's cookie-octet grammar, which also forbids space,
 * comma, double quote and backslash in a value. Servers send all four - a JSON blob, a
 * quoted value, a comma-separated list - and browsers store and return them, so
 * refusing them would drop real cookies from `CookieJar.parseSetCookieHeader`. What is
 * refused here is exactly what would change the *framing* of the header: another pair,
 * or another line.
 *
 * The one rule for cookie text: the jar stores by it, and `MockAdapter`'s `cookies`
 * shorthand writes by it, so a route sets exactly the cookies a raw `set-cookie` would.
 */
export function isHeaderSafeCookieText(text: string, extra: string): boolean {
  for (const char of text) {
    const code = char.charCodeAt(0);

    // Above U+00FF is refused too: no header can carry it, so a stored cookie holding
    // one would fail every request to its host, and take the host's other cookies with it.
    if (
      (code <= 0x1f && code !== 0x09) ||
      code === 0x7f ||
      code > 0xff ||
      char === ';' ||
      extra.includes(char)
    ) {
      return false;
    }
  }

  return true;
}

/**
 * Whether `name` is one the jar stores as given beside a value: no `=` (its own
 * delimiter), none of what {@link isHeaderSafeCookieText} refuses, and no space or tab at
 * its edges, which a server reading it back would trim off - inside it they are kept, as
 * RFC 6265bis keeps them. An empty name is a nameless cookie, held to rules of its own.
 */
export function isWritableCookieName(name: string): boolean {
  return isHeaderSafeCookieText(name, '=') && trimSpacesAndTabs(name) === name;
}

/**
 * Whether `value` - a cookie's value, or a `Path` or `Domain` written beside it - is one
 * the jar stores as given: none of what {@link isHeaderSafeCookieText} refuses, and no
 * space or tab at its edges, which a server reading it back would trim off.
 */
export function isWritableCookieValue(value: string): boolean {
  return (
    trimSpacesAndTabs(value) === value && isHeaderSafeCookieText(value, '')
  );
}
