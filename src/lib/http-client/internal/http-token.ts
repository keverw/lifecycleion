/** RFC 9110's `token`: the characters a header name, a method and a cookie name are made of. */
const HTTP_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** Whether `text` is a non-empty RFC 9110 token. */
export function isHTTPToken(text: string): boolean {
  return HTTP_TOKEN.test(text);
}
