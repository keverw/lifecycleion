import { HTTP_METHODS } from '../consts';

const STANDARD_HTTP_METHODS: ReadonlySet<string> = new Set(HTTP_METHODS);

/**
 * `text` with its ASCII letters uppercased, and nothing else: `toUpperCase` would also
 * turn `poſt` (U+017F) into `POST`.
 */
export function asciiUppercase(text: string): string {
  return text.replace(/[a-z]/g, (letter) => letter.toUpperCase());
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
