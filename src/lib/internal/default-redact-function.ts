import datamask from 'datamask';

/**
 * The masking every redaction feature falls back to.
 *
 * Shared rather than per-module so `errorToString`'s `sensitiveFieldNames` and the
 * logger's `redactedKeys` produce the same output for the same value. A second copy would
 * drift, and a value masked one way in a log line and another way in a rendered error is
 * exactly the inconsistency this is here to prevent.
 *
 * Partial by design: the first and last characters survive, so the same secret can be
 * correlated across log lines without being readable.
 */
export function defaultRedactValue(_keyName: string, value: unknown): unknown {
  if (typeof value === 'string') {
    const masked = datamask.string(value, '*', 60);

    // `datamask` masks a proportion of the string, so a short value can come back with
    // nothing masked at all - a one-character secret was returned verbatim. A mask that
    // did not mask is not a mask, so fall through to the opaque form rather than hand
    // back the original.
    if (masked !== value) {
      return masked;
    }
  }

  // Non-string values, and strings too short for proportional masking to hide anything.
  return '***REDACTED***';
}
