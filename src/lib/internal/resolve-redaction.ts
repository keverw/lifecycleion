import type { RedactValueFunction } from './default-redact-function';
import { capToMaxRenderLength, MAX_RENDER_LENGTH } from './render-budget';
import {
  defaultRedactValue,
  matchRedactMaskConfig,
  maskWithConfig,
  REDACTED_PLACEHOLDER,
} from './default-redact-function';

/**
 * Interpret what a `redactFunction` returned, for one already-stringified leaf.
 *
 * Shared so the logger and `errorToString` honour the contract identically:
 *
 * - a `string` is the replacement, used as-is
 * - `null` defers to the default masking
 * - a `number` defers too, at that percent - shorthand for `{ percent: n }`
 * - a {@link RedactMaskConfig} asks for the library's masking with those settings, and is
 *   recognized by naming nothing but masking settings - `{}` included, which asks for the
 *   defaults and so lands in the same place as `null`
 * - any other object is not a usable request, so it lands on the default masking too -
 *   `{ note: 'withheld' }`, a mixture, an array, a class instance. An object is never a
 *   replacement value; return a string for that
 * - `undefined` defers to the default masking, exactly as `null` does. A function that
 *   returns nothing for a key it does not special-case has not said what to put there,
 *   and every surface has to render *something*: `errorToString` writes a table row and
 *   `stringifyValue` writes a JSON leaf, so the value came out as the literal text
 *   `undefined` in both. Masking by default is the one answer that means the same thing
 *   everywhere and never prints what was named for redaction
 * - any other non-object is used literally - a boolean, a `bigint`, a symbol
 *
 * @param isDerived Whether the value reaching here was something other than a string -
 *                  a number, an object, a function. The default never masks such a value
 *                  in part: its string form is produced, and proportional masking keeps
 *                  the ends, which is where a card number or a `URL` query keeps its
 *                  identifying half. An explicit config overrides that, since asking for
 *                  partial masking of a number is a deliberate choice.
 */
export function resolveRedaction(
  key: string,
  value: string,
  isDerived: boolean,
  redactFunction: RedactValueFunction | undefined,
  /**
   * Where a string replacement is cut when nothing downstream will cut it. Defaults to
   * {@link MAX_RENDER_LENGTH}; a caller whose walk charges a budget passes `Infinity`.
   */
  limit: number = MAX_RENDER_LENGTH,
): unknown {
  let requested: unknown = null;

  if (redactFunction !== undefined) {
    requested = redactFunction(key, value);

    if (typeof requested === 'string') {
      // Cut to the same allowance every rendered leaf gets. A replacement escapes the
      // render budget exactly as a long `maskChar` did - the budget charges the *input*
      // leaf before `mask` runs and never charges what comes back - so a `redactFunction`
      // answering a ten-megabyte string for a two-hundred-character param wrote all ten to
      // every sink, per param, per line, while `MAX_RENDER_LENGTH` saw two hundred
      // characters of it. Capped rather than refused: a replacement is what the caller
      // asked to appear, and a marker on the end says where it stopped.
      //
      // At `limit`, which is a backstop for a caller with no budget rather than the cap
      // itself. A walk that charges a budget - `maskValueDeep` - cuts a replacement to
      // what is left and *records* the cut, so it passes `Infinity` here and this never
      // fires under it; cutting first at the constant meant `maxRenderLength: Infinity`
      // still came back at a million characters, a cap raised above the constant was
      // quietly lowered back to it, and the walk's report counted only the tail of a cut
      // this had already made in silence.
      return capToMaxRenderLength(requested, limit);
    }

    if (typeof requested === 'number') {
      // A non-finite percent names no usable setting, so it lands where `null` and an
      // empty config land rather than being emitted as a literal - which is what a bare
      // `NaN` used to do, serializing to `null` in the output. `Number(process.env.X)`
      // reaches here, and `{ percent: NaN }` already fell back to the default, so the
      // two spellings agreeing matters.
      if (!Number.isFinite(requested) || requested < 0) {
        return isDerived
          ? REDACTED_PLACEHOLDER
          : defaultRedactValue(key, value);
      }

      return maskWithConfig(value, { percent: requested });
    }

    const match = matchRedactMaskConfig(requested);

    if (match.kind === 'settings') {
      return maskWithConfig(value, match.config);
    }

    // An empty config falls through to the tail rather than to `maskWithConfig`, so it
    // lands exactly where `null` does - the derived-value rule included. Taking the
    // `maskWithConfig` path would skip that rule and partially mask a produced string,
    // which is how a `URL` kept its query and a card number its BIN prefix and last four.
    // For a value that genuinely was a string the two are identical anyway, so nothing is
    // lost by routing both through one place.
    if (
      match.kind !== 'defaults' &&
      requested !== null &&
      requested !== undefined
    ) {
      // Used literally.
      return requested;
    }
  }

  return isDerived ? REDACTED_PLACEHOLDER : defaultRedactValue(key, value);
}
