import { getPathParts } from './internal/path-utils';
import {
  TRUNCATED_LENGTH,
  chargeText,
  createRenderBudget,
} from './internal/render-budget';
import { stringifyValue } from './stringify-value';
import {
  createFormatReporter,
  type FormatErrorHandler,
  type FormatFailureKind,
  type ReportFormatFailure,
} from './internal/format-reporter';

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
   * Fires at most once per render of the template - not once per placeholder - and
   * reports on the standard global `'error'` channel when none is set, falling back to
   * `console.error` when nothing claims it. Only
   * a read that actually threw reaches it; a placeholder that simply is not there reports
   * nothing, which is the distinction this exists to draw.
   */
  onFormatError?: FormatErrorHandler;
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

    // One allowance for the whole template, not one per placeholder. Each `stringifyValue`
    // opens a budget of its own, so every individual render looked in bounds while a
    // template with N placeholders emitted up to N megabytes - the same "the cap depends on
    // where the value sits" hole the leaf caps closed one level down. Per render of the
    // compiled template rather than per compile, matching `report`: a compiled template is
    // reused, and a budget shared across calls would spend itself on the first one.
    const budget = createRenderBudget();

    // Forwarded into the shared reporter rather than handed over directly, and rooted at
    // the placeholder rather than at the anonymous `<value>` a bare render reports.
    //
    // Two things this buys. `stringifyValue` builds a reporter of its own per call, so
    // handing the caller's handler straight down would give every placeholder its own
    // once-per-call budget - one report per broken placeholder, which is the flood the
    // bound exists to prevent; routing them through `report` keeps it at one per render of
    // the template. And a template has many placeholders, so `<value>.token` names the
    // failure without naming which `{{...}}` produced it, which is most of what the caller
    // needs to act.
    // One reporter per kind, built on first use. `report` above is the `'render'` one;
    // a nested `stringifyValue` can also raise `'redaction'`, and the two must not share a
    // budget - a redaction failure and a render failure in the same template are two
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

      // Checked, not only charged - the same guard the sibling walks keep, and for the
      // same reason. `chargeText` bounds what is *emitted* and does nothing about what is
      // *produced*: `stringifyValue` is evaluated as its argument, so every placeholder
      // after the budget ran out still rendered its value in full - each opening a fresh
      // `MAX_RENDER_LENGTH` of its own - only for the result to be cut to the marker and
      // thrown away. One 60,000-key param behind 500 placeholders spent 1.9 seconds
      // synchronously inside `logger.info()` rendering 500 megabyte-scale strings nobody
      // would ever see. The marker is emitted uncharged, since the budget it would be
      // billed against is already gone and a template's placeholder count is the author's,
      // not the payload's.
      if (budget.remaining <= 0) {
        return TRUNCATED_LENGTH;
      }

      try {
        // Charged, and cut at whatever is left: the leaf caps inside bound one placeholder,
        // and this bounds their sum. A placeholder that runs out is emitted with the same
        // `[max length exceeded]` marker the renderers use, so a template that stopped
        // early never reads as one that rendered everything.
        return chargeText(
          budget,
          stringifyValue(replacement, renderOptionsFor(p1.trim())),
        );
      } catch (error) {
        // `String()` invokes `toString`/`Symbol.toPrimitive`, both ordinary properties.
        // Dead in practice - `stringifyValue` has its own top-level guard that reports and
        // returns `[unrenderable]` rather than throwing - but `report` is in scope, and a
        // backstop that renders the fallback without saying why is the same silence this
        // whole channel exists to end.
        report(error, p1.trim());

        return fallback;
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
