import { errorToString } from '../../error-to-string';
import { DOUBLE_EOL } from '../../constants';

/**
 * Prepare an error object for logging with an optional prefix
 */
export function prepareErrorObjectLog(prefix: string, error: unknown): string {
  prefix = prefix.trim();

  let prefixLine = '';

  if (prefix.length > 0) {
    prefixLine = prefix + ': ' + DOUBLE_EOL;
  }

  return prefixLine + errorToString(error);
}
