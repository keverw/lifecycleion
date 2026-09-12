import { parseRedactPaths, redactMatchedPaths } from './internal/redact-paths';
import { stringifyTemplateValue } from './internal/stringify-template-value';
import {
  createRenderBudget,
  resolveMaxRenderLength,
  type RenderBudget,
  type TruncationHandler,
} from './internal/render-budget';
import { createTruncationReporter } from './internal/truncation-reporter';
import {
  createFormatReporter,
  type FormatErrorHandler,
  type ReportFormatFailure,
} from './internal/format-reporter';
import {
  REDACTION_FAILED_MARKER,
  type RedactValueFunction,
} from './internal/default-redact-function';

export type {
  TruncationHandler,
  TruncationInfo,
  TruncationReason,
} from './internal/render-budget';

export type {
  FormatErrorHandler,
  FormatFailureKind,
} from './internal/format-reporter';

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
   * Notified when a value could not be formatted, so a `***REDACTION FAILED***` or
   * `[unrenderable]` marker leaves a diagnosis and not only a marker.
   *
   * `kind` says which stage threw: `'redaction'` for a broken `redactFunction`,
   * `'render'` for a value that refused to be read or stringified. Both calls can raise
   * either: {@link redactValue} hands back structure, but masking a leaf renders it first,
   * so a `toString` that throws under a masked key is a `'render'` failure there too.
   * Render subjects are rooted at `<value>` in both, so the same leaf is named the same way
   * whichever half reports it.
   *
   * The cause is deliberately absent from the markers: it comes from your own getter,
   * `toString` or `redactFunction` and may carry the value it was hiding, so writing it
   * into the output would send it wherever that output goes. It comes here instead.
   *
   * With no handler set, a standalone call reports on the standard global `'error'`
   * channel - so a `logger.registerReportErrorListener()` records it - and falls back to
   * `console.error` only when nothing claims the event. The `Logger` and its sinks always
   * supply a handler for their own work, so this default is never reached from inside a
   * log call.
   *
   * Fires at most once per kind per call - a failure is raised per leaf, so an
   * unconditional throw would otherwise report thousands of times for one broken
   * function. Do not redact, render or log from inside it.
   */
  onFormatError?: FormatErrorHandler;
  /**
   * Characters this render may emit, defaulting to {@link MAX_RENDER_LENGTH}.
   *
   * One allowance for the whole value, shared by every level of it - a container is not
   * given a fresh one per entry, which is what keeps a deep payload from costing a cap per
   * level. `Infinity` renders without a bound; anything else unusable takes the default
   * rather than being honoured, since this is the bound that makes an untrusted payload
   * safe to render and a typo in a config must not be what switches it off.
   *
   * @see onTruncate, which is how a caller learns it was reached.
   */
  maxRenderLength?: number;
  /**
   * Notified when the render was cut short - by {@link maxRenderLength}, the depth cap, or
   * a cycle.
   *
   * Deliberately not {@link onFormatError}: these are degradations rather than failures.
   * The walk succeeded and simply could not represent everything, so there is no error to
   * hand over, and the marker in the output says where it stopped. That is enough when a
   * person reads the output and not enough when a program consumes it, which is what this
   * is for.
   *
   * Fires at most once per call. Do not render, redact or log from inside it.
   */
  onTruncate?: TruncationHandler;
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
  const budget = createRenderBudget(
    resolveMaxRenderLength(options?.maxRenderLength),
  );

  const reportTruncation = createTruncationReporter(
    budget,
    options?.onTruncate,
  );

  try {
    return redactValueWith(value, options, null, budget);
  } finally {
    // Masking renders every leaf it replaces, so this walk can be cut short exactly as a
    // render can - and a caller holding structure rather than a string has even less way
    // to notice than one who could scan for the marker.
    reportTruncation(ANONYMOUS_ROOT);
  }
}

/** Names the root of a value that has no key of its own, as the render walk spells it. */
const ANONYMOUS_ROOT = '<value>';

/** Whether a report's subject is one of the bracketed names for a whole input. */
function isBracketedSubject(path: string): boolean {
  return path.startsWith('<') && path.endsWith('>');
}

/**
 * Spell a redaction walk's render failure the way the render walk spells the same leaf.
 *
 * The two walks name the same position differently: `stringifyTemplateValue` roots a path
 * at {@link ANONYMOUS_ROOT} and the redaction walk hands back the caller's own entry,
 * bare. Only the rooted form can be re-rooted, so an unrooted one reached `curlyBrackets`'
 * `rootPathAt` unchanged and told a template author `a` where every other render failure
 * in the same call said `user.a`.
 */
function rootedRenderReport(report: ReportFormatFailure): ReportFormatFailure {
  return (error: unknown, path: string): void => {
    if (path.length === 0) {
      report(error, ANONYMOUS_ROOT);

      return;
    }

    report(
      error,
      isBracketedSubject(path) ? path : `${ANONYMOUS_ROOT}.${path}`,
    );
  };
}

/**
 * {@link redactValue}, with the `'render'` channel supplied from outside.
 *
 * `stringifyValue` renders what this returns, so the two halves of one call are one
 * operation and must share one render budget: building a reporter at each end gave the
 * call two, and `stringifyValue({ a: hostileA, b: hostileB }, { redactedKeys: ['a'] })`
 * therefore fired `onFormatError('render')` twice against a contract that promises at
 * most once per kind per call.
 */
function redactValueWith(
  value: unknown,
  options: StringifyValueOptions | undefined,
  renderReport: ReportFormatFailure | null,
  budget: RenderBudget,
): unknown {
  // Declared out here so the `catch` can reach it, as `applyRedaction` does: a failure
  // that escapes the guarded region below must still leave a diagnosis and not only the
  // marker, which is the whole promise `onFormatError` makes. Assigned rather than
  // built here, so the no-options hot path still allocates nothing.
  let report: ReportFormatFailure | null = null;

  try {
    const entries = options?.redactedKeys;

    // Before the reporter is built: with nothing to redact there is nothing to report,
    // and `stringifyValue(value)` with no options is the hot path every template render
    // takes.
    if (entries === undefined) {
      return value;
    }

    report = createFormatReporter('redaction', options?.onFormatError);

    // Whether the list is usable and whether it is empty are both asked of
    // `parseRedactPaths`, rather than of `entries.length` up here.
    //
    // A `length` read of its own used to take the "nothing was asked for" exit early, and
    // that exit hands the value back in the clear, so it had to ask what the list *is*
    // before asking how long it is: an unusable list answering `0` - `{ length: 0 }` -
    // otherwise skipped the fail-closed branch below and the value was rendered whole. But
    // `length` is an ordinary property, and a `Proxy` over an array answers `Array.isArray`
    // yes while still refusing the read, so the fast path could throw in the one position
    // nothing was watching - above the reporter, out to the catch, and back to the caller
    // as a bare marker. `parseRedactPaths` is guarded throughout and answers both questions
    // from one read, refusing anything it cannot use, so a list that will not be read now
    // fails closed with a `<redactedKeys>` report like any other unusable one, and an empty
    // list still hands the value back two exits lower.
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

    return redactMatchedPaths(
      value,
      paths,
      options?.redactFunction,
      report,
      undefined,
      // A `'render'` reporter, never `report`: a leaf that refuses to render while being
      // masked is a render failure, and reporting it through `report` would label it
      // `'redaction'` and spend the single redaction report a broken `redactFunction`
      // still needs. The caller's own when there is one - `stringifyValue` renders what
      // this returns, so both halves share one budget - and one of this call's own
      // otherwise.
      rootedRenderReport(
        renderReport ?? createFormatReporter('render', options?.onFormatError),
      ),
      // The caller's allowance, so masking and the render that follows spend one budget
      // between them rather than a megabyte each. Without it `maxRenderLength` bounded
      // only half the operation: a `redactFunction` answering oversized replacements got
      // a fresh cap of its own whatever the caller had asked for, and the truncation it
      // caused was invisible to `onTruncate`.
      budget,
    );
  } catch (error) {
    // Reported when there is a reporter to report with. Nothing above is expected to
    // throw - `parseRedactPaths` is guarded throughout and the walk guards every read it
    // owns - but a `RangeError` from a payload nested past the stack, or a
    // `redactFunction` read that is an accessor and throws, both land here, and returning
    // the marker without a word is exactly the silence `onFormatError` exists to end.
    //
    // Keyed `<value>`, the way `applyRedaction` keys a walk that refused entirely
    // `<params>`: everything that can arrive here failed while redacting the value, not
    // while reading the list, since a list this cannot use is reported as `<redactedKeys>`
    // above and returns from there. Reporting through the same reporter the walk was
    // handed keeps the once-per-pass bound, so a leaf failure already reported and then
    // escaping is not counted twice.
    //
    // Still `null` only for a throw raised before the reporter was built - reading
    // `options` itself - where no handler had been read to call.
    if (report !== null) {
      report(error, '<value>');
    }

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
  // Defaults to the console, as every other failure channel in this library does. One
  // small closure per call, which is what `applyRedaction` and `errorToString` already
  // allocate for their own reporters.
  const report = createFormatReporter('render', options?.onFormatError);

  // One allowance for this call, created here rather than inside the walk so the same
  // budget covers the redaction pass's own masking and the render that follows it - two
  // halves of one operation, as `redactValueWith` already documents for the reporter.
  const budget = createRenderBudget(
    resolveMaxRenderLength(options?.maxRenderLength),
  );

  const reportTruncation = createTruncationReporter(
    budget,
    options?.onTruncate,
  );

  try {
    return stringifyTemplateValue(
      redactValueWith(value, options, report, budget),
      '',
      report,
      budget,
    );
  } catch (error) {
    // Nothing below is expected to throw - the walk guards every read it owns - but a
    // `RangeError` from a payload nested past the stack lands here, and returning the
    // marker without a word is exactly the silence `onFormatError` exists to end.
    report(error, '<value>');

    return '[unrenderable]';
  } finally {
    // After the render whatever it did, including throwing: a cut that happened before a
    // later failure is still a cut, and the reporter reads the budget's counters rather
    // than the string, so it sees one made anywhere in the walk.
    reportTruncation(ANONYMOUS_ROOT);
  }
}
