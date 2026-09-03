import { deepClone } from '../../deep-clone';
import {
  defaultRedactValue,
  REDACTION_FAILED_MARKER,
} from '../../internal/default-redact-function';
import {
  parseRedactPaths,
  redactMatchedPaths,
} from '../../internal/redact-paths';
import type { RedactFunction } from '../types';

/**
 * Default redaction function using datamask
 * Masks sensitive values with asterisks
 */
export const defaultRedactFunction: RedactFunction = defaultRedactValue;

export { REDACTION_FAILED_MARKER } from '../../internal/default-redact-function';

/**
 * Apply redaction to params based on redacted keys
 * Supports top-level keys and mixed object/array paths
 * (e.g., 'user.password', 'users[0].password', or 'users[0]["password-hash"]')
 *
 * @param params Original params object
 * @param redactedKeys Keys to redact (supports nested object paths, array indexes, and quoted bracket keys)
 * @param redactFunction Custom redaction function (uses defaultRedactFunction if not provided)
 * @returns New object with redacted values
 */
export function applyRedaction(
  params: Record<string, unknown>,
  redactedKeys?: string[],
  redactFunction?: RedactFunction,
): Record<string, unknown> {
  // No redaction needed
  if (!redactedKeys || redactedKeys.length === 0) {
    return params;
  }

  /** Every redacted key marked, used whenever nothing safer can be produced. */
  const allMarked = (): Record<string, unknown> =>
    Object.fromEntries(
      redactedKeys.map((key) => [key, REDACTION_FAILED_MARKER]),
    );

  // Parsed with the shared parser rather than a local `includes('.')` test, so an entry
  // addresses the same thing here as it does in `sensitiveFieldNames` and
  // `stringifyValue`. A list that is present but unusable fails closed.
  const paths = parseRedactPaths(redactedKeys);

  if (paths === null) {
    return allMarked();
  }

  // A copy is probed for, not used.
  //
  // `deepClone` runs over caller-supplied params and throws on a structure it cannot
  // copy - a throwing getter, a revoked `Proxy`. That is the signal this fails closed
  // on: returning the originals would hand every sink, and the rendered message, the
  // unredacted values, which is the one outcome redaction exists to prevent. An
  // uncopyable params object yields only markers for the redacted keys and nothing
  // else. Losing the non-sensitive params is the price; `entry.params` still carries
  // them for a sink that opts into the raw view.
  //
  // The walk below then runs over `params` itself rather than the copy, and builds its
  // own. Masking the copy would mask the wrong thing: `deepClone` keeps only enumerable
  // own properties, so an `Error` arrives as `{}` and its message is never seen. The
  // walk does not mutate what it reads, so the copy has no other job.
  try {
    deepClone(params);
  } catch {
    return allMarked();
  }

  try {
    return redactMatchedPaths(params, paths, redactFunction) as Record<
      string,
      unknown
    >;
  } catch {
    // The walk guards every step it owns, so reaching here means something beneath it
    // refused entirely. Drop every param rather than return a copy whose sensitive key
    // still holds its original value.
    return allMarked();
  }
}
