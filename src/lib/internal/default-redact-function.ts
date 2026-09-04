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
 * What a `redactFunction` may return.
 *
 * A **string** is the answer in the ordinary case: the function is handed one
 * already-stringified leaf and hands back the text that stands in for it. The rest are
 * control signals rather than replacement values - ways of saying "you do the masking":
 *
 * - `null` - use the default masking
 * - a `number` - the default masking at that percent, shorthand for `{ percent: n }`
 * - a {@link RedactMaskConfig} - the library's masking with these settings
 * - `undefined` - drop the value, which is what a function returning nothing does
 *
 * An object is therefore always read as a masking request, never as a replacement value.
 * One that is not a usable request falls back to the default masking rather than being
 * emitted, so a rendered `{"note":"x"}` can never stand where a masked value belonged.
 */
export type RedactFunctionResult =
  string | number | RedactMaskConfig | null | undefined;

/**
 * What a value returned from a `redactFunction` turned out to be.
 *
 * - `'settings'` - a masking request naming at least one setting, in `config`
 * - `'defaults'` - an object that is not a usable request, so the default masking applies
 * - `'literal'` - not an object at all, to be used as the replacement verbatim
 */
export type RedactMaskConfigMatch =
  | { kind: 'settings'; config: RedactMaskConfig }
  | { kind: 'defaults' }
  | { kind: 'literal' };

/**
 * Classify a value returned from a `redactFunction`.
 *
 * An **object is always a masking request** - never a replacement value. A `redactFunction`
 * is handed one already-stringified leaf and is meant to hand back the text that stands in
 * for it, so a string is the answer; the non-string returns are control signals, and an
 * object is the one that says "you do the masking, like this". Letting an object through
 * as a literal instead put a rendered `{"note":"x"}` in the log line where a masked value
 * belonged, and reading which kind of object it was is exactly the guess that leaked: an
 * unrecognized shape taken for a config discarded the caller's value and emitted a
 * proportional mask of the *original* in its place.
 *
 * So there are only two answers for an object, and the unusable one is not an error:
 *
 * - every own key names a setting, and there is at least one - `'settings'`, masked with
 *   exactly those
 * - anything else - `'defaults'`, masked as though no `redactFunction` had been given at
 *   all. `{}` lands here because every field is optional and a config assembled
 *   conditionally can legitimately come out empty; so do `{ note: 'x' }`, a mixed
 *   `{ percent: 10, note: 'x' }`, an array, a class instance, and a revoked `Proxy`.
 *   Honouring the half of a mixed object we recognize would be the same guess in a
 *   smaller costume, and falling back to the default is the answer that neither guesses
 *   nor leaves anything unmasked.
 *
 * `'defaults'` is reported separately from `'settings'` rather than folded into it, and
 * the distinction is load-bearing. An empty config is not the *deliberate* request that
 * lets a derived string be masked in part: masking `{}` as though it were leaked a `URL`'s
 * query string and a card number's BIN prefix and last four, which is precisely what the
 * derived-value rule exists to stop.
 *
 * The keys are read once, here, inside the guard that classifies them - not re-read at the
 * call site. The value is caller code, an `ownKeys` trap need not answer the same way
 * twice, and one of two reads could throw where the other did not.
 */
export function matchRedactMaskConfig(value: unknown): RedactMaskConfigMatch {
  // Only an object can be a request. A primitive is the caller's own replacement, which
  // is what keeps `undefined` dropping the value as it always has.
  if (value === null || typeof value !== 'object') {
    return { kind: 'literal' };
  }

  try {
    // A plain object is the only shape a config comes in. An array or a class instance is
    // not a request - and not a literal either, since no object is: it falls back to the
    // default masking below.
    if (Array.isArray(value)) {
      return { kind: 'defaults' };
    }

    const prototype: unknown = Object.getPrototypeOf(value);

    if (prototype !== Object.prototype && prototype !== null) {
      return { kind: 'defaults' };
    }

    // Own keys rather than `in`: a request is a data object, and reading through a
    // prototype would let an unrelated shape inherit its way into being one.
    //
    // `Reflect.ownKeys` rather than `Object.keys`, so a symbol key and a non-enumerable
    // one both count. `Object.keys` sees neither, which made an object carrying its data
    // that way indistinguishable from `{}`. Nothing is lost by the stricter read: a
    // setting defined non-enumerably still counts as one, since `maskWithConfig` reads it
    // by name either way.
    const keys = Reflect.ownKeys(value);

    return keys.length > 0 &&
      keys.every(
        (key) => typeof key === 'string' && REDACT_MASK_CONFIG_KEYS.has(key),
      )
      ? { kind: 'settings', config: value }
      : { kind: 'defaults' };
  } catch {
    // A revoked `Proxy`, or an `ownKeys`/`getPrototypeOf` trap that throws. Unclassifiable,
    // so it cannot be honoured as a request - and handing it back as a literal would put a
    // value nothing can read into the output. The default masking is the safe answer.
    return { kind: 'defaults' };
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
export function defaultRedactValue(
  _keyName: string,
  value: unknown,
): RedactFunctionResult {
  if (typeof value === 'string') {
    return maskWithConfig(value, {});
  }

  return REDACTED_PLACEHOLDER;
}
