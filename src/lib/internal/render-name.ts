/**
 * A name for a message, as a string, never a throw.
 *
 * Names reach messages through template literals, and a template literal over a symbol -
 * or over an object whose `toString` throws - throws before the code around it can do
 * anything. Wherever a name is typed `string` but supplied by caller code, a JavaScript
 * caller (or an option passed through from one) can hand over anything, and on a
 * failure-reporting path that throw would replace the report it was building.
 *
 * A string is returned as-is. Anything else renders as `String()` gives it - a symbol as
 * `Symbol(description)` - or as `fallback` when that throws.
 */
export function renderName(name: unknown, fallback: string): string {
  if (typeof name === 'string') {
    return name;
  }
  try {
    return String(name);
  } catch {
    return fallback;
  }
}
