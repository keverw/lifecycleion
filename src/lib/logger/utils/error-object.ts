import { errorToString } from '../../error-to-string';
import { doubleEOL } from '../../constants';

/**
 * Prepare an error object for logging with an optional prefix
 */
export function prepareErrorObjectLog(prefix: string, error: unknown): string {
  prefix = prefix.trim();

  let prefixLine = '';

  if (prefix.length > 0) {
    prefixLine = prefix + ': ' + doubleEOL;
  }

  return prefixLine + errorToString(error);
}
