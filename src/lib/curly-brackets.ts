export type TemplateFunction = (locals: Record<string, unknown>) => string;

interface CurlyBracketsFunction {
  (str?: string, locals?: Record<string, unknown>, fallback?: string): string;
  compileTemplate: (str: string, fallback?: string) => TemplateFunction;
  escape: (str: string) => string;
}

/**
 * Processes a template string, replacing placeholders with corresponding values from a provided object.
 *
 * @param {string} str - The template string to process.
 * @param locals - An object containing key-value pairs for placeholder replacement.
 * @param fallback - A default string to use when a placeholder's corresponding value is not found.
 * @returns - The processed string with placeholders replaced by their corresponding values.
 */

// eslint-disable-next-line @typescript-eslint/naming-convention
const CurlyBrackets: CurlyBracketsFunction = function (
  str: string = '',
  locals: Record<string, unknown> = {},
  fallback: string = '(null)',
): string {
  // Short-circuit if no brackets - no need to process
  if (!str.includes('{{')) {
    return str;
  }

  const compiled = CurlyBrackets.compileTemplate(str, fallback);

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
): TemplateFunction {
  const pattern = /(?:\\)?{{(\s*[\w.]+?)(?:\\)?\s*}}/g;

  return (locals: Record<string, unknown>): string => {
    return str.replace(pattern, (match, p1: string) => {
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
      const parts = key.split('.');

      // Use a more specific approach to ensure the type is consistent
      let replacement: unknown = locals;

      for (const part of parts) {
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
      }

      if (replacement === undefined || replacement === null) {
        return fallback;
      }

      // eslint-disable-next-line @typescript-eslint/no-base-to-string
      return String(replacement);
    });
  };
};

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
