import { parseRedactPaths, redactMatchedPaths } from './internal/redact-paths';
import { stringifyTemplateValue } from './internal/stringify-template-value';
import {
  createRedactionReporter,
  type RedactionErrorHandler,
} from './internal/redaction-reporter';
import {
  REDACTION_FAILED_MARKER,
  type RedactValueFunction,
} from './internal/default-redact-function';

export type {
  RedactFunctionResult,
  RedactMaskConfig,
} from './internal/default-redact-function';

/** Decides the replacement for a redacted value. See the logger's `redactFunction`. */
export type StringifyRedactFunction = RedactValueFunction;

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
  /**
   * Notified when redaction fails for a value, so a broken `redactFunction` leaves a
   * diagnosis and not only a `***REDACTION FAILED***` marker. Defaults to `console.error`.
   *
   * Not routed to the global `'error'` channel: reporting there would loop, since a
   * listening logger logs it, logging renders, rendering redacts, and redaction throws
   * again. Fires at most once per call - a failure is raised per leaf, so an unconditional
   * throw would otherwise report thousands of times for one broken function.
   *
   * Do not redact or log from inside it.
   */
  onRedactionError?: RedactionErrorHandler;
}

/**
 * Return `value` with every path in `redactedKeys` masked, keeping its shape.
 *
 * The masking half of {@link stringifyValue}, for a caller that wants the structure back
 * rather than text - to inspect it, hand it to their own sink, or serialize it
 * themselves. Paths and the `redactFunction` contract are exactly the logger's, so a
 * function written for one works here.
 *
 * The value passed in is never modified. Copies are built only along the branches that
 * lead to a mask, so anything not named comes back as it went in - a `Date` is still that
 * `Date`, an `Error` still carries its `message` and `stack`. Naming a plain object or
 * array masks each value inside it and keeps the shape, so what comes back is still an
 * object or an array.
 *
 * **Masking covers exactly what {@link stringifyValue} prints: own enumerable
 * string-keyed properties of plain objects and arrays.** Anything `Object.entries` does
 * not see - a non-enumerable property, a symbol key, one carried on a prototype, one a
 * `Proxy` hides from `ownKeys` - is neither masked nor printed. The result is therefore
 * safe to *render*, and is not a sanitized object for an arbitrary consumer: hand it to
 * `Object.getOwnPropertyNames`, a different serializer, or a sink that walks properties
 * directly, and hidden state comes with it.
 *
 * Never throws. A failure yields the redaction marker rather than the original value.
 *
 * @example
 * redactValue({ user: { password: 'hunter2secret' } }, {
 *   redactedKeys: ['user.password'],
 * });
 * // { user: { password: 'h***********t' } }
 */
export function redactValue(
  value: unknown,
  options?: StringifyValueOptions,
): unknown {
  try {
    const entries = options?.redactedKeys;

    if (entries === undefined || entries.length === 0) {
      // Before the reporter is built: with nothing to redact there is nothing to report,
      // and `stringifyValue(value)` with no options is the hot path every template render
      // takes.
      return value;
    }

    const report = createRedactionReporter(options?.onRedactionError);

    const paths = parseRedactPaths(entries);

    // Fails closed, as `sensitiveFieldNames` does: a list that is present but unusable
    // means the caller asked for masking and this cannot tell what for, so nothing is
    // returned rather than everything.
    if (paths === null) {
      report(
        new Error('redactedKeys is not a usable list of paths'),
        '<redactedKeys>',
      );

      return REDACTION_FAILED_MARKER;
    }

    if (paths.length === 0) {
      return value;
    }

    return redactMatchedPaths(value, paths, options?.redactFunction, report);
  } catch {
    // The reporter is scoped inside the `try`, and the only statements above it cannot
    // throw, so a failure here has no reporter to reach and nothing more to say than the
    // marker already says.
    return REDACTION_FAILED_MARKER;
  }
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
 * Pass `redactedKeys` to mask parts of the value before it is rendered - the same
 * options {@link redactValue} takes, so `stringifyValue(v, o)` and
 * `stringifyValue(redactValue(v, o))` produce the same text. Render an already-masked
 * structure by passing it with no options.
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
    return stringifyTemplateValue(redactValue(value, options));
  } catch {
    return '[unrenderable]';
  }
}
