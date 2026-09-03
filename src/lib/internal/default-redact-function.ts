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
    return datamask.string(value, '*', 60);
  }

  // Defensive fallback for a non-string value.
  return '***REDACTED***';
}
