import { getPathParts } from './internal/path-utils';
import {
  TRUNCATED_LENGTH,
  createRenderBudget,
  noteTruncation,
  resolveMaxRenderLength,
  type TruncationHandler,
} from './internal/render-budget';
import { createTruncationReporter } from './internal/truncation-reporter';
import { stringifyTemplateValue } from './internal/stringify-template-value';
import {
  createFormatReporter,
  type FormatErrorHandler,
  type FormatFailureKind,
  type ReportFormatFailure,
} from './internal/format-reporter';

export type {
  TruncationHandler,
  TruncationInfo,
  TruncationReason,
} from './internal/render-budget';

export type {
  FormatErrorHandler,
  FormatFailureKind,
} from './internal/format-reporter';

export type TemplateFunction = (locals: Record<string, unknown>) => string;

/** Options shared by {@link CurlyBrackets} and its compiled form. */
export interface CurlyBracketsOptions {
  /**
   * Notified when a placeholder could not be resolved or rendered, so a `(null)` in the
   * output leaves a diagnosis and not only a gap.
   *
   * An unresolvable path and an *unreadable* one produce the same `fallback`, and until
   * this existed they were indistinguishable: `{{error.message}}` on an error whose
   * `message` accessor throws rendered exactly like a typo. This is what tells them apart.
   *
   * Fires at most once per render of the template - not once per placeholder. With no
   * handler it uses the standard host path: a cancelable global `'error'` event first;
   * `globalThis.reportError()` when event dispatch is unavailable; then guarded
   * `console.error`. Only a read that actually threw reaches it; a placeholder that simply
   * is not there reports nothing, which is the distinction this exists to draw.
   */
  onFormatError?: FormatErrorHandler;
  /**
   * Characters this template may emit across all of its placeholders, per render.
   *
   * Defaults to {@link MAX_RENDER_LENGTH}. The bound is per render and shared, not per
   * placeholder: `{{body}}{{body}}{{body}}` is the shape it exists for, since the same
   * value substituted `n` times is `n` times the output for one payload - and where the
   * *template* is user input, as it is for anything rendering a message someone else
   * wrote, `n` is theirs to choose too.
   *
   * Only the values substituted in are charged. The literal text between placeholders is
   * passed through untouched and costs nothing, and neither does `fallback`, so the cap
   * governs interpolation rather than the length of the template itself.
   *
   * `Infinity` renders without a bound, for a caller who is not writing to a log and has
   * already decided the payload is theirs to trust. Anything else unusable - a negative,
   * zero, `NaN`, a non-number - takes the default rather than being honoured: this is the
   * bound that makes a hostile template safe to render, and a typo in a config must not
   * be the thing that switches it off.
   *
   * @see onTruncate, which is how a caller learns the cap was reached.
   */
  maxRenderLength?: number;
  /**
   * Notified when {@link maxRenderLength} cut this render short.
   *
   * Truncation is an ordinary degradation rather than a failure - the `[max length
   * exceeded]` marker in the output is its own diagnosis - so it is deliberately not
   * routed through {@link onFormatError}, whose `FormatFailureKind` means "something
   * refused to render". For a log line the marker is enough, which is why nothing here
   * fires unless a handler is set. For a template rendering something a person will
   * read, it is not: the output is quietly shortened and ships that way, and scanning the
   * result for the marker cannot tell a real cut from a payload containing those words.
   *
   * Fires at most once per render, not once per placeholder, for the reason
   * {@link onFormatError} does: a template past its budget truncates every placeholder
   * after the first, and a handler per one is a flood. The first is also the informative
   * one - everything after it is a consequence.
   *
   * Do not render, redact or log from inside it.
   */
  onTruncate?: TruncationHandler;
}

interface CurlyBracketsFunction {
  (
    str?: string,
    locals?: Record<string, unknown>,
    fallback?: string,
    options?: CurlyBracketsOptions,
  ): string;
  compileTemplate: (
    str: string,
    fallback?: string,
    options?: CurlyBracketsOptions,
  ) => TemplateFunction;
  escape: (str: string) => string;
}

const PLACEHOLDER_PATTERN = /(?:\\)?{{(\s*[^{}]+?\s*)(?:\\)?\s*}}/g;

/**
 * Processes a template string, replacing placeholders with corresponding values from a provided object.
 *
 * @param {string} str - The template string to process.
 * @param locals - An object containing key-value pairs for placeholder replacement.
 * @param fallback - A default string to use when a placeholder's corresponding value is not found.
 * @returns - The processed string with placeholders replaced by their corresponding values.
 */

const CurlyBrackets: CurlyBracketsFunction = function (
  str: string = '',
  locals: Record<string, unknown> = {},
  fallback: string = '(null)',
  options?: CurlyBracketsOptions,
): string {
  // Short-circuit if no brackets - no need to process
  if (!str.includes('{{')) {
    return str;
  }

  const compiled = CurlyBrackets.compileTemplate(str, fallback, options);

  return compiled(locals);
} as CurlyBracketsFunction;

/**
 * Compiles a template string into a reusable function, which can be called with different sets of locals.
 * This is more efficient when you have a template that you want to use with different sets of locals,
 * as it avoids the overhead of parsing the template string each time it is used.
 *
 * @param {string} str - The template string to compile.
 * @param {string} fallback - A default string to use when a placeholder's corresponding value is not found in locals.
 * @returns A function that takes an object of locals and returns a processed string.
 */

CurlyBrackets.compileTemplate = function (
  str: string,
  fallback: string = '(null)',
  options?: CurlyBracketsOptions,
): TemplateFunction {
  return (locals: Record<string, unknown>): string => {
    // One reporter per render of the compiled template, not per compile: a compiled
    // template is reused across calls, and a budget shared between them would report the
    // first render's failure and stay silent for every render after it.
    const report = createFormatReporter('render', options?.onFormatError);

    // One allowance for the whole template, not one per placeholder. A render left to
    // open a budget of its own puts every individual placeholder in bounds while a
    // template with N of them emits up to N megabytes - the same "the cap depends on
    // where the value sits" hole the leaf caps closed one level down. Handed down into
    // each render below rather than applied to what comes back, so a value larger than
    // what is left is never materialized in the first place.
    //
    // Per render of the compiled template rather than per compile, matching `report`: a
    // compiled template is reused, and a budget shared across calls would spend itself on
    // the first one.
    const budget = createRenderBudget(
      resolveMaxRenderLength(options?.maxRenderLength),
    );

    // One notification per render, matching `report`. See
    // `CurlyBracketsOptions.onTruncate`.
    const reportTruncation = createTruncationReporter(
      budget,
      options?.onTruncate,
    );

    // Forwarded into the shared reporter rather than handed over directly, and rooted at
    // the placeholder rather than at the anonymous `<value>` a bare render reports.
    //
    // Two things this buys. Each placeholder wraps the handler in a once-per-call reporter
    // of its own, so handing the caller's handler straight down would give every
    // placeholder its own report budget - one report per broken placeholder, which is the
    // flood the bound exists to prevent; routing them through the shared per-kind reporters
    // below keeps it at one per render of the template. And a template has many
    // placeholders, so `<value>.token` names the failure without naming which `{{...}}`
    // produced it, which is most of what the caller needs to act.
    //
    // One reporter per kind, built on first use. `report` above is the `'render'` one, and
    // the render walk raises nothing else from here - this list passes no `redactedKeys`,
    // so no redaction runs. Kept keyed by kind regardless: two kinds must never share a
    // budget, since a redaction failure and a render failure in the same template are two
    // different things and collapsing them would hide one.
    const byKind = new Map<FormatFailureKind, ReportFormatFailure>([
      ['render', report],
    ]);

    const renderOptionsFor = (
      placeholder: string,
    ): { onFormatError: FormatErrorHandler } => ({
      onFormatError: (
        error: Error,
        kind: FormatFailureKind,
        path: string,
      ): void => {
        let forKind = byKind.get(kind);

        if (forKind === undefined) {
          forKind = createFormatReporter(kind, options?.onFormatError);
          byKind.set(kind, forKind);
        }

        forKind(error, rootPathAt(placeholder, path));
      },
    });

    return str.replace(PLACEHOLDER_PATTERN, (match, p1: string) => {
      if (typeof p1 !== 'string') {
        return match;
      }

      const hasLeadingEscape = match.startsWith('\\');
      const hasEndingEscape = match.endsWith('\\}}');
      const isFullyEscaped = hasLeadingEscape && hasEndingEscape;

      if (isFullyEscaped) {
        return match.slice(1, -3) + '}}';
      }

      if (hasLeadingEscape) {
        return match.slice(1);
      }

      if (hasEndingEscape) {
        return '{{' + p1.trim() + '}}';
      }

      const key = p1.trim();
      const parts = getPathParts(key);

      if (!parts || parts.length === 0) {
        return match;
      }

      // Use a more specific approach to ensure the type is consistent
      let replacement: unknown = locals;

      for (const part of parts) {
        // Both the membership test and the read run code this function does not own: a
        // `Proxy` can throw from its `has` trap, and an ordinary property can be an
        // accessor that throws — an `Error` with a hostile `message` getter reaching
        // `{{error.message}}` is the case that matters, since the logger renders
        // templates on paths that must not raise an error of their own. An unresolvable
        // path is exactly what `fallback` is for, so treat an unreadable one the same
        // way rather than propagating.
        try {
          if (
            replacement !== undefined &&
            replacement !== null &&
            typeof replacement === 'object' &&
            part in replacement
          ) {
            replacement = (replacement as Record<string, unknown>)[part];
          } else {
            replacement = undefined;
            break;
          }
        } catch (error) {
          // Said, not swallowed. This is the read that makes an unreadable path
          // indistinguishable from an absent one in the output; the handler is where the
          // difference survives.
          report(error, p1.trim());
          replacement = undefined;
          break;
        }
      }

      if (replacement === undefined || replacement === null) {
        return fallback;
      }

      const name = p1.trim();

      // Checked, not only charged - the same guard the sibling walks keep, and for the
      // same reason. Charging the result bounds what is *emitted* and does nothing about
      // what is *produced*: every placeholder after the budget ran out still rendered its
      // value in full, only for the result to be cut to the marker and thrown away. One
      // 60,000-key param behind 500 placeholders spent 1.9 seconds synchronously inside
      // `logger.info()` rendering 500 megabyte-scale strings nobody would ever see.
      //
      // The marker is emitted uncharged: the budget it would be billed against is already
      // gone, and charging it would be billing the payload for the template's shape. The
      // shape is still bounded - `n` placeholders emit at most `n` markers, and the
      // allowance above is what stops `{{body}}{{body}}{{body}}` from being `n` times one
      // payload however large `n` grows.
      //
      // Reported with no `dropped` count, and that is the honest answer rather than a
      // missing one: the guard exists precisely so the value is never rendered here, so
      // nothing ever measured it.
      if (budget.remaining <= 0) {
        noteTruncation(budget, 'length');
        reportTruncation(name);

        return TRUNCATED_LENGTH;
      }

      // The pass's own budget, handed *down* rather than applied to what comes back.
      // Charging the result still let the one placeholder that straddles the boundary
      // open a fresh `MAX_RENDER_LENGTH` inside `stringifyValue` and materialize a
      // megabyte-scale string before it was cut - the check above only stops the
      // placeholders *after* the one that exhausts the budget. Threaded in, the render
      // itself truncates at whatever is left, so a template's total cost is one
      // allowance rather than one per straddle.
      //
      // Called at the internal seam rather than through `stringifyValue`, which takes no
      // budget: with no `redactedKeys` - which this never passes - that function is
      // exactly the reporter, the guard, and the call below.
      const placeholderReport = createFormatReporter(
        'render',
        renderOptionsFor(name).onFormatError,
      );

      try {
        return stringifyTemplateValue(
          replacement,
          '',
          placeholderReport,
          budget,
        );
      } catch (error) {
        // A `RangeError` from a payload nested past the stack, which is the one failure
        // the walk's own per-read guards cannot absorb. Reported and answered with the
        // same marker `stringifyValue`'s top-level guard used to produce here, rather
        // than with the fallback - a value that exists but would not render is not an
        // absent one.
        placeholderReport(error, '<value>');

        return '[unrenderable]';
      } finally {
        // Asked after every placeholder, including the ones that threw: the reporter reads
        // the budget's own counters, so a cut made deep inside a container - a key, a
        // nested leaf, a cycle - is seen exactly as a cut to a top-level string is.
        reportTruncation(name);
      }
    });
  };
};

/**
 * A render path re-rooted at the placeholder that produced it.
 *
 * `stringifyValue` reports against an anonymous root, since it renders a bare value and has
 * no name for it - `<value>` for the value itself, `<value>.token` for something inside it.
 * Here there is a name: the placeholder as written. Swapping the root turns
 * `<value>.token` into `user.token`, which is the path the template author can actually
 * look up.
 *
 * Only the root token is replaced, never anything after it, so the structural segments the
 * renderer built are passed through untouched.
 */
function rootPathAt(placeholder: string, path: string): string {
  const ANONYMOUS_ROOT = '<value>';

  if (path === ANONYMOUS_ROOT) {
    return placeholder;
  }

  return path.startsWith(`${ANONYMOUS_ROOT}.`) ||
    path.startsWith(`${ANONYMOUS_ROOT}[`)
    ? `${placeholder}${path.slice(ANONYMOUS_ROOT.length)}`
    : path;
}

/**
 * Escapes placeholders in a string by prefixing them with a backslash, preventing them from being replaced when processed.
 *
 * @param {string} str - The string in which to escape placeholders.
 * @returns {string} - The string with placeholders escaped.
 */

CurlyBrackets.escape = function (str: string): string {
  // Use a regex to replace instances of {{ and }} that are not already preceded by a backslash
  return str
    .replace(/(\\)?{{/g, (match, backslash) => (backslash ? match : '\\{{'))
    .replace(/(\\)?}}/g, (match, backslash) => (backslash ? match : '\\}}'));
};

export { CurlyBrackets };
