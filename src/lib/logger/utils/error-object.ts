import { errorToString } from '../../error-to-string';
import { DOUBLE_EOL } from '../../constants';
import type { ErrorToStringOptions } from '../../error-to-string';

/**
 * Prepare an error object for logging with an optional prefix.
 *
 * `options` carries the logger's own `redactFunction` and `onFormatError` through to
 * the render. Without them this rendered the error with the library defaults, so an error
 * logged through `errorObject()` masked differently from the same values logged as params,
 * and a redaction failure here went to `console.error` even when the caller had provided a
 * handler - twice for one log call, since `handleLog` reports separately for the params.
 */
export function prepareErrorObjectLog(
  prefix: string,
  error: unknown,
  options?: ErrorToStringOptions,
): string {
  prefix = prefix.trim();

  let prefixLine = '';

  if (prefix.length > 0) {
    prefixLine = prefix + ': ' + DOUBLE_EOL;
  }

  return prefixLine + errorToString(error, undefined, options);
}
