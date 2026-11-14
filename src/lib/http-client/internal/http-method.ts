import { HTTP_METHODS } from '../consts';
import { isHTTPToken } from './http-token';
import { asciiUppercase } from '../../internal/ascii-text';

/**
 * The methods uppercased whatever their case (see `normalizeStandardMethod`): the
 * standard ones the client sends, and `CONNECT`, which RFC 9110 defines but nothing here
 * sends, since every refusal of it reads it in any case - so a request filter on
 * `CONNECT` selects the `connect` one interceptor hands the next.
 */
const UPPERCASED_METHODS: ReadonlySet<string> = new Set([
  ...HTTP_METHODS,
  'CONNECT',
]);

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
 * `CONNECT` is uppercased too (see {@link UPPERCASED_METHODS}).
 */
export function normalizeStandardMethod(method: string): string {
  const uppercased = asciiUppercase(method);
  return UPPERCASED_METHODS.has(uppercased) ? uppercased : method;
}
