import {
  maskDomain,
  maskEmail,
  maskString,
  splitCharacters,
} from '../datamask';
import { isPlainContainer } from './is-plain-container';

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
 * The masking hides a proportion of the string, so a short value keeps most of itself: a
 * four-digit PIN rendered `1**4` and a two-character value rendered `*b`. Anything
 * shorter than this is replaced outright instead.
 *
 * A length in characters, not UTF-16 units, counted the way the masking below counts them
 * (see `splitCharacters`). Measured in units, four emoji were "eight characters" and
 * masked in part, and the cut then landed inside one of them.
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
  /**
   * A single character, repeated once per masked character. Defaults to `'*'`; a longer
   * string is cut to its first code point, since its length multiplies everything written
   * to every sink.
   */
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
 * - `undefined` - the default masking too, exactly as `null`, so a function that returns
 *   nothing for a key it does not special-case still masks it
 *
 * An object is therefore always read as a masking request, never as a replacement value.
 * One that is not a usable request falls back to the default masking rather than being
 * emitted, so a rendered `{"note":"x"}` can never stand where a masked value belonged.
 */
export type RedactFunctionResult =
  string | number | RedactMaskConfig | null | undefined;

/**
 * Decides the replacement for a redacted value.
 *
 * The one definition behind every name the package publishes for this shape -
 * `RedactFunction` on the logger, `RedactFieldFunction` on `errorToString`,
 * `StringifyRedactFunction` on `stringifyValue`, `RedactLeafFunction` on the shared walk.
 * They are aliases so each entry point can document the parameter in its own terms; they
 * were separate declarations, which meant a change to what a function may return had to
 * be made in several places and compiled fine when it was not.
 *
 * Handed the key exactly as the caller wrote it - `user.password`, not the leaf - and the
 * value **already stringified**, so `value` is always a `string` whatever it started as.
 * That is also what keeps a mutating function from reaching into the caller's own payload.
 *
 * See {@link RedactFunctionResult} for what to hand back. In short: a string is the
 * replacement, and everything else is a control signal.
 */
export type RedactValueFunction = (
  key: string,
  value: string,
) => RedactFunctionResult;

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
  // Only an object can be a request. A primitive is the caller's own replacement - except
  // `null` and `undefined`, which `resolveRedaction` reads as "use the default masking"
  // before ever using a literal, so neither can reach the output as a dropped value.
  if (value === null || typeof value !== 'object') {
    return { kind: 'literal' };
  }

  try {
    // A plain object is the only shape a config comes in. An array or a class instance is
    // not a request - and not a literal either, since no object is: it falls back to the
    // default masking below.
    //
    // The shared test rather than a fourth private copy of it, so "what counts as a data
    // object" cannot mean one thing here and another in the walks.
    if (!isPlainContainer(value) || Array.isArray(value)) {
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

    if (
      !keys.every(
        (key) => typeof key === 'string' && REDACT_MASK_CONFIG_KEYS.has(key),
      )
    ) {
      return { kind: 'defaults' };
    }

    // A key set to `undefined` names nothing. `{ percent: undefined }` is the *normal*
    // shape of a config assembled conditionally - `{ percent: cond ? 10 : undefined }` -
    // which is precisely the case `'defaults'` exists for, and it is identical in effect
    // to `{}`, since `maskWithConfig` falls back to the default for an absent setting
    // either way.
    //
    // Presence alone would send it down the `maskWithConfig` branch and so past the
    // derived-value rule, which is the leak `{}` was routed away from: a `URL` came back
    // with its query intact and a card number with its BIN prefix and last four. Reading
    // the values, not just the keys, is what keeps the two spellings of "no settings"
    // landing in the same place.
    let hasSetting = false;
    const config: Record<string, unknown> = {};

    for (const key of keys) {
      const setting = (value as Record<string | symbol, unknown>)[key];
      if (setting === undefined) {
        continue;
      }

      const isValid =
        key === 'strategy'
          ? setting === 'string' || setting === 'email' || setting === 'domain'
          : key === 'maskChar'
            ? typeof setting === 'string' && setting.length > 0
            : typeof setting === 'number' && Number.isFinite(setting);
      if (!isValid) {
        return { kind: 'defaults' };
      }
      hasSetting = true;
      config[key as string] = setting;
    }

    return hasSetting ? { kind: 'settings', config } : { kind: 'defaults' };
  } catch {
    // A revoked `Proxy`, or an `ownKeys`/`getPrototypeOf` trap that throws. Unclassifiable,
    // so it cannot be honoured as a request - and handing it back as a literal would put a
    // value nothing can read into the output. The default masking is the safe answer.
    return { kind: 'defaults' };
  }
}

/**
 * One mask character, whatever the caller supplied.
 *
 * The masking emits one `maskChar` per masked character, so the length of this string is a
 * multiplier on everything written to every sink - the same output amplification the
 * `percent` ceiling below exists to stop, and the one this was missing: checked only for
 * being non-empty, a `redactFunction` answering `{ maskChar: 'X'.repeat(100_000) }` over
 * three 200-character params produced 54 MB per log line. It escapes the render budget
 * too, which charges the input leaf before `mask` runs and never charges the result, so
 * `MAX_RENDER_LENGTH` saw six hundred characters of it.
 *
 * The first code point rather than the first UTF-16 unit, so an astral mask character
 * survives whole instead of being cut into a lone surrogate - and taken from a two-unit
 * slice rather than by spreading the whole string, which would walk the very length this
 * is here to refuse to carry.
 */
function normalizeMaskChar(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    return '*';
  }

  const codePoint = value.slice(0, 2).codePointAt(0);

  return codePoint === undefined ? '*' : String.fromCodePoint(codePoint);
}

/**
 * A usable masking percent, or `fallback` when the value does not name one.
 *
 * Clamped at the ceiling as well as the floor. The masking hides a *proportion*, emitting
 * `length * percent / 100` mask characters without stopping at the length of the value,
 * so an out-of-range percent lengthens the output rather than merely over-masking: at
 * 10000 a 200-character secret came back as a 20,000-character string, written to every
 * sink. A percent above 100 names nothing beyond "all of it", so 100 is the honest
 * reading of one - and these numbers come from caller code, where
 * `Number(process.env.MASK_PERCENT)` or someone reading `percent` as a multiplier is an
 * ordinary mistake rather than a hostile one.
 */
function normalizePercent(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.min(value, 100)
    : fallback;
}

/**
 * Apply a masking request to an already-stringified value.
 *
 * Never returns the original: a strategy that hides nothing - too short a value, a
 * percent of zero, an address with nothing to mask - falls through to the opaque
 * placeholder rather than handing back what it was asked to hide.
 *
 * Always well-formed: every strategy cuts between characters, see {@link maskString}.
 *
 * Every setting is read inside the guard, none of them above it. `config` is whatever a
 * caller's `redactFunction` handed back, so each of these is an ordinary property that can
 * be an accessor that throws when this exported helper is called directly. Read above
 * the `try`, such a config threw out of here
 * and came back as `***REDACTION FAILED***` even though it named a perfectly usable
 * setting, and which key it was depended on `Reflect.ownKeys` ordering. Inside, it lands
 * on the same opaque placeholder every other unusable request does.
 */
export function maskWithConfig(
  value: string,
  config: RedactMaskConfig,
): string {
  let masked: string;

  try {
    const maskChar = normalizeMaskChar(config.maskChar);

    const percent = normalizePercent(config.percent, DEFAULT_MASK_PERCENT);

    // Above the strategy branches, not inside the string one. Every strategy here masks a
    // *proportion*, so the rule this constant exists for holds for all three - and sat in
    // the `else` it exempted exactly the requests a caller spells out: a four-digit PIN
    // under `strategy: 'domain'` came back `***4` and a two-character value under
    // `strategy: 'email'` came back `*b`, where the default path replaces both outright.
    //
    // Counted in characters, as the masking is. `value.length` is UTF-16 units, and for
    // an astral-heavy value that is up to twice the character count - see the constant.
    if (splitCharacters(value).length < MINIMUM_PARTIAL_MASK_LENGTH) {
      return REDACTED_PLACEHOLDER;
    }

    if (config.strategy === 'email') {
      // The per-part percents go through the same normalization rather than being handed
      // over as given: they are the same caller-supplied number by another name, and
      // reading one directly would leave the ceiling - and the finiteness check - applying
      // to `percent` alone.
      masked = maskEmail(
        value,
        maskChar,
        normalizePercent(config.userPercent, percent),
        normalizePercent(config.domainPercent, percent),
      );
    } else if (config.strategy === 'domain') {
      masked = maskDomain(value, maskChar, percent);
    } else {
      masked = maskString(value, maskChar, percent);
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
