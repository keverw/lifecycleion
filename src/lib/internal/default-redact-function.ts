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

/**
 * The complete set of keys a masking request may carry.
 *
 * Exhaustive by design: recognition is what separates a masking request from an ordinary
 * object a `redactFunction` returned as the literal replacement, so a key added to
 * {@link RedactMaskConfig} without being added here would be read as a literal instead.
 */
const REDACT_MASK_CONFIG_KEYS = new Set([
  'strategy',
  'percent',
  'maskChar',
  'userPercent',
  'domainPercent',
]);

/**
 * What an object returned from a `redactFunction` turned out to be.
 *
 * - `'settings'` - a masking request naming at least one setting, in `config`
 * - `'defaults'` - a plain object naming no setting at all, such as `{}`
 * - `'literal'` - anything else, to be used as the replacement verbatim
 */
export type RedactMaskConfigMatch =
  | { kind: 'settings'; config: RedactMaskConfig }
  | { kind: 'defaults' }
  | { kind: 'literal' };

/**
 * Classify a value returned from a `redactFunction`.
 *
 * Recognized by its keys, not merely by being a plain object. Accepting any plain object
 * broke the documented contract in the one direction that matters: a function returning a
 * structured replacement - `{ note: 'withheld' }` - had that value silently discarded and
 * the library's proportional mask of the *original* emitted in its place, which is both
 * not what the caller asked for and a partial disclosure of the value they meant to
 * replace outright. An array return, meanwhile, was already used literally, so the two
 * disagreed.
 *
 * A request must therefore name nothing but settings. An object mixing settings with
 * unknown keys is a literal: guessing which half was meant could only ever mask when the
 * caller wanted their own value, and the safe direction is to hand back what was returned.
 *
 * `'defaults'` is reported separately from `'settings'` rather than folded into it, and
 * the distinction is load-bearing. Every field of {@link RedactMaskConfig} is optional, so
 * `{}` is a valid config and a caller assembling one conditionally can legitimately end up
 * with it - but it is not the *deliberate* request that lets a derived string be masked in
 * part. Masking it as though it were leaked a `URL`'s query string and a card number's BIN
 * prefix and last four, which is precisely what the derived-value rule exists to stop. An
 * empty config asks for the default, so the caller gets the default, `null` and all.
 *
 * Emptiness is decided here, in the same guarded read that classifies the keys, rather
 * than re-read at the call site: the value is caller code, an `ownKeys` trap need not
 * answer the same way twice, and one of the two reads could throw where the other did not.
 */
export function matchRedactMaskConfig(value: unknown): RedactMaskConfigMatch {
  if (value === null || typeof value !== 'object') {
    return { kind: 'literal' };
  }

  try {
    // Inside the guard, like the same test in `isPlainContainer`: `Array.isArray` throws
    // on a revoked `Proxy`, so testing it above the `try` would throw out of a function
    // whose whole contract is to answer which of three things this is.
    if (Array.isArray(value)) {
      return { kind: 'literal' };
    }

    const prototype: unknown = Object.getPrototypeOf(value);

    if (prototype !== Object.prototype && prototype !== null) {
      return { kind: 'literal' };
    }

    // Own keys rather than `in`: a masking request is a data object, and reading through
    // a prototype would let an unrelated shape inherit its way into being one.
    const keys = Object.keys(value);

    if (!keys.every((key) => REDACT_MASK_CONFIG_KEYS.has(key))) {
      return { kind: 'literal' };
    }

    return keys.length > 0
      ? { kind: 'settings', config: value }
      : { kind: 'defaults' };
  } catch {
    // A revoked `Proxy`, or an `ownKeys`/`getPrototypeOf` trap that throws. Not
    // classifiable, so not a request - and the caller's `catch` turns it into the failure
    // marker rather than anything derived from the value.
    return { kind: 'literal' };
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
