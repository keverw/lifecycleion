import { parseRedactPaths, redactMatchedPaths } from './internal/redact-paths';
import { stringifyTemplateValue } from './internal/stringify-template-value';
import { REDACTION_FAILED_MARKER } from './internal/default-redact-function';

export type { RedactMaskConfig } from './internal/default-redact-function';

/** Decides the replacement for a redacted value. See the logger's `redactFunction`. */
export type StringifyRedactFunction = (key: string, value: unknown) => unknown;

export interface StringifyValueOptions {
  /**
   * Paths to redact, rooted at `value` and using the same syntax as the logger's
   * `redactedKeys`: a bare name is a top-level key, and `user.password` or
   * `items[0].token` addresses one location.
   */
  redactedKeys?: string[];
  /**
   * Decides how a redacted value is replaced. Return a string to use it literally,
   * `null` to defer to the default masking, a number to defer at that percent, or a
   * `RedactMaskConfig` to ask for a particular masking.
   */
  redactFunction?: StringifyRedactFunction;
}

/**
 * Render any value as a display string, optionally redacting parts of it first.
 *
 * The rendering every Lifecycleion module uses, exported so an application can produce
 * the same text. A plain object or array renders as JSON, so its contents are readable
 * and an array cannot be confused with one element containing a comma. Anything with a
 * string form of its own keeps it - an `Error` renders `Error: boom`, a `Date` its
 * timestamp, a `URL` its href. A class instance that defines no `toString` renders as
 * `[ClassName]`, naming what was passed without dumping fields the caller never asked
 * to print.
 *
 * Pass `redactedKeys` to mask parts of the value before it is rendered. Paths, masking
 * and the `redactFunction` contract are exactly the logger's, so a function written for
 * one works here.
 *
 * Never throws. A value that resists rendering degrades to a placeholder rather than
 * raising an error out of whatever was trying to describe it.
 *
 * @example
 * stringifyValue({ user: { password: 'hunter2secret' } }, {
 *   redactedKeys: ['user.password'],
 * });
 * // '{"user":{"password":"h***********t"}}'
 */
export function stringifyValue(
  value: unknown,
  options?: StringifyValueOptions,
): string {
  try {
    const entries = options?.redactedKeys;

    if (entries === undefined || entries.length === 0) {
      return stringifyTemplateValue(value);
    }

    const paths = parseRedactPaths(entries);

    // Fails closed, as `sensitiveFieldNames` does: a list that is present but unusable
    // means the caller asked for masking and this cannot tell what for, so nothing is
    // rendered rather than everything.
    if (paths === null) {
      return REDACTION_FAILED_MARKER;
    }

    if (paths.length === 0) {
      return stringifyTemplateValue(value);
    }

    return stringifyTemplateValue(
      redactMatchedPaths(value, paths, options?.redactFunction),
    );
  } catch {
    return '[unrenderable]';
  }
}
