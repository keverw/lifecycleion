import { getPathParts } from './internal/path-utils';
import { stringifyValue } from './stringify-value';
import {
  createRenderReporter,
  type RenderErrorHandler,
} from './internal/render-reporter';

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
   * defaults to `console.error`, the same three rungs the rest of the library uses. Only
   * a read that actually threw reaches it; a placeholder that simply is not there reports
   * nothing, which is the distinction this exists to draw.
   */
  onRenderError?: RenderErrorHandler;
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
    const report = createRenderReporter(options?.onRenderError);

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
    const renderOptionsFor = (
      placeholder: string,
    ): { onRenderError: RenderErrorHandler } => ({
      onRenderError: (error: Error, path: string): void => {
        report(error, rootPathAt(placeholder, path));
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

      try {
        return stringifyValue(replacement, renderOptionsFor(p1.trim()));
      } catch {
        // `String()` invokes `toString`/`Symbol.toPrimitive`, both ordinary properties.
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
