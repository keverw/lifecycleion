import {
  defaultRedactValue,
  isRedactMaskConfig,
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
 * - a {@link RedactMaskConfig} asks for the library's masking with those settings
 * - anything else is used literally, so a function that returns nothing drops the value
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
  redactFunction: ((key: string, value: unknown) => unknown) | undefined,
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

    if (isRedactMaskConfig(requested)) {
      return maskWithConfig(value, requested);
    }

    if (requested !== null) {
      // Used literally. `undefined` from a function that returns nothing drops the value,
      // which is what it did before deferral existed.
      return requested;
    }
  }

  return isDerived ? REDACTED_PLACEHOLDER : defaultRedactValue(key, value);
}
