import type { RedactFunctionResult } from './default-redact-function';
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
 * - anything else is used literally, so a function that returns nothing drops the value,
 *   and one returning `{ note: 'withheld' }` gets that object as the replacement rather
 *   than a mask of the value it was replacing
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
  redactFunction:
    ((key: string, value: string) => RedactFunctionResult) | undefined,
): unknown {
  let requested: unknown = null;

  if (redactFunction !== undefined) {
    requested = redactFunction(key, value);

    if (typeof requested === 'string') {
      return requested;
    }

    if (typeof requested === 'number' && Number.isFinite(requested)) {
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
    if (match.kind !== 'defaults' && requested !== null) {
      // Used literally. `undefined` from a function that returns nothing drops the value,
      // which is what it did before deferral existed.
      return requested;
    }
  }

  return isDerived ? REDACTED_PLACEHOLDER : defaultRedactValue(key, value);
}
