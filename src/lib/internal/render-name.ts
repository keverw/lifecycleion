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

/**
 * {@link renderName} for a name that may be supplied as a function building it, so a
 * caller can leave the work of building a name to the failure path that needs one. A
 * function is called here, once; one that throws answers `fallback`, as does whatever it
 * returns that cannot be rendered.
 */
export function resolveName(name: unknown, fallback: string): string {
  if (typeof name !== 'function') {
    return renderName(name, fallback);
  }

  try {
    return renderName((name as () => unknown)(), fallback);
  } catch {
    return fallback;
  }
}

/**
 * The event name for a handler's report, never a throw: `event` is typed `string`, but a
 * JavaScript caller can use any `Map` key, and a symbol renders as `Symbol(description)`.
 */
export function renderEventName(event: unknown): string {
  return renderName(event, '<unnamed event>');
}
