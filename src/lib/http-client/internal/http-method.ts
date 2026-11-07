import { HTTP_METHODS } from '../consts';
import { isHTTPToken } from './http-token';
import { asciiUppercase } from '../../internal/ascii-text';

const STANDARD_HTTP_METHODS: ReadonlySet<string> = new Set(HTTP_METHODS);

/**
 * What is wrong with `method` as a method name - completing "the method …" - or
 * `undefined` when nothing is: a method is a non-empty RFC 9110 token. Never the method
 * itself, which may be text pasted in whole. The rule `request()` and every adapter hold
 * a method to.
 */
export function describeNonTokenMethod(method: string): string | undefined {
  if (method === '') {
    return 'is empty';
  }
  if (!isHTTPToken(method)) {
    return 'is not a valid HTTP method name (got a string with characters an HTTP token does not allow)';
  }
  return undefined;
}

/**
 * A standard method in any case, uppercased - so `'post'` is `POST` for the
 * non-idempotent check and method filters, and every adapter sends `patch` as `PATCH`
 * (`fetch` uppercases only six of them) - and any other method as given, since method
 * names are case-sensitive (RFC 9110) and a server may route `purge` and `PURGE` apart.
 */
export function normalizeStandardMethod(method: string): string {
  const uppercased = asciiUppercase(method);
  return STANDARD_HTTP_METHODS.has(uppercased) ? uppercased : method;
}
