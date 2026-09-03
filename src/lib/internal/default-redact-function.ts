import datamask from 'datamask';

/**
 * Substituted for a value whose redaction failed.
 *
 * Deliberately distinct from a successful mask: an operator seeing the ordinary mask
 * concludes redaction worked, so a broken `redactFunction` would hide itself. Redaction
 * fails closed - the original value is never left in place - but it says so.
 *
 * Shared so a failure reads the same whether it happened while redacting log params or
 * while rendering an error.
 */
export const REDACTION_FAILED_MARKER = '***REDACTION FAILED***';

/** Used where a value is replaced rather than masked in part. */
export const REDACTED_PLACEHOLDER = '***REDACTED***';

/**
 * How much of a value the default masking hides.
 *
 * High on purpose. Enough survives to correlate the same secret across log lines, but a
 * long value no longer leaves a proportionally long prefix and suffix readable - at the
 * previous 60% an API key showed roughly ten of twenty-two characters.
 */
export const DEFAULT_MASK_PERCENT = 90;

/**
 * Below this length, proportional masking hides too little to be worth doing.
 *
 * `datamask` masks a proportion of the string, so a short value keeps most of itself: a
 * four-digit PIN rendered `1**4` and a two-character value rendered `*b`. Anything
 * shorter than this is replaced outright instead.
 */
const MINIMUM_PARTIAL_MASK_LENGTH = 8;

/**
 * Asks for a particular masking rather than supplying the masked text.
 *
 * Returned from a `redactFunction` when the caller wants the library's masking with
 * different settings, instead of reproducing it. `strategy` picks how the value is
 * treated: `'string'` masks a proportion of it, `'email'` keeps the `@` and the dots so
 * an address stays recognizable, `'domain'` does the same for a hostname.
 */
export interface RedactMaskConfig {
  strategy?: 'string' | 'email' | 'domain';
  /** 0-100. Defaults to {@link DEFAULT_MASK_PERCENT}. */
  percent?: number;
  /** Defaults to `'*'`. */
  maskChar?: string;
  /** `email` only. Falls back to `percent`. */
  userPercent?: number;
  /** `email` only. Falls back to `percent`. */
  domainPercent?: number;
}

/** Whether a value returned from a `redactFunction` is a masking request. */
export function isRedactMaskConfig(value: unknown): value is RedactMaskConfig {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  try {
    return (
      Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null
    );
  } catch {
    return false;
  }
}

/**
 * Apply a masking request to an already-stringified value.
 *
 * Never returns the original: a strategy that hides nothing - too short a value, a
 * percent of zero, an address `datamask.email` cannot parse - falls through to the
 * opaque placeholder rather than handing back what it was asked to hide.
 */
export function maskWithConfig(
  value: string,
  config: RedactMaskConfig,
): string {
  const maskChar =
    typeof config.maskChar === 'string' && config.maskChar.length > 0
      ? config.maskChar
      : '*';

  const percent =
    typeof config.percent === 'number' &&
    Number.isFinite(config.percent) &&
    config.percent >= 0
      ? config.percent
      : DEFAULT_MASK_PERCENT;

  let masked: string;

  try {
    if (config.strategy === 'email') {
      masked = datamask.email(
        value,
        maskChar,
        config.userPercent ?? percent,
        config.domainPercent ?? percent,
      );
    } else if (config.strategy === 'domain') {
      masked = datamask.domain(value, maskChar, percent);
    } else {
      if (value.length < MINIMUM_PARTIAL_MASK_LENGTH) {
        return REDACTED_PLACEHOLDER;
      }

      masked = datamask.string(value, maskChar, percent);
    }
  } catch {
    return REDACTED_PLACEHOLDER;
  }

  // A mask that did not mask is not a mask.
  return typeof masked === 'string' && masked !== value
    ? masked
    : REDACTED_PLACEHOLDER;
}

/**
 * The masking every redaction feature falls back to.
 *
 * Shared rather than per-module so `errorToString`'s `sensitiveFieldNames` and the
 * logger's `redactedKeys` produce the same output for the same value. A second copy would
 * drift, and a value masked one way in a log line and another way in a rendered error is
 * exactly the inconsistency this is here to prevent.
 */
export function defaultRedactValue(_keyName: string, value: unknown): unknown {
  if (typeof value === 'string') {
    return maskWithConfig(value, {});
  }

  return REDACTED_PLACEHOLDER;
}
