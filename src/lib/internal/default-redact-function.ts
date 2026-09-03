import datamask from 'datamask';

/**
 * Below this length, proportional masking hides too little to be worth doing.
 *
 * `datamask` masks a proportion of the string, so a short value keeps most of itself: a
 * four-digit PIN rendered `1**4` and a two-character value rendered `*b`. Anything
 * shorter than this is replaced outright instead.
 */
const MINIMUM_PARTIAL_MASK_LENGTH = 8;

/**
 * The masking every redaction feature falls back to.
 *
 * Shared rather than per-module so `errorToString`'s `sensitiveFieldNames` and the
 * logger's `redactedKeys` produce the same output for the same value. A second copy would
 * drift, and a value masked one way in a log line and another way in a rendered error is
 * exactly the inconsistency this is here to prevent.
 *
 * Partial by design for a value long enough to stay unreadable: roughly the middle 60%
 * is masked, so the first and last characters survive and the same secret can be
 * correlated across log lines. A short value is replaced outright instead, since a
 * proportional mask of one would hide almost nothing.
 */
export function defaultRedactValue(_keyName: string, value: unknown): unknown {
  if (
    typeof value === 'string' &&
    value.length >= MINIMUM_PARTIAL_MASK_LENGTH
  ) {
    const masked = datamask.string(value, '*', 60);

    // `datamask` masks a proportion of the string, so even above the length floor a
    // value can come back with nothing masked. A mask that did not mask is not a mask.
    if (masked !== value) {
      return masked;
    }
  }

  // Non-string values, and strings too short for proportional masking to hide anything.
  return '***REDACTED***';
}
