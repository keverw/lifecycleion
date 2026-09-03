/**
 * Normalizes values to the same string representation used by template rendering.
 */

/** Whether a value is a plain object or an array, so its contents are its meaning. */
function isPlainContainer(value: unknown): value is object {
  if (value === null || typeof value !== 'object') {
    return false;
  }

  try {
    if (Array.isArray(value)) {
      return true;
    }

    const prototype: unknown = Object.getPrototypeOf(value);

    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

/**
 * Whether a value carries a `toString` of its own worth using.
 *
 * `Error`, `Date`, `URL` and anything else that overrides `toString` renders something
 * meaningful. A class that does not override it inherits `Object.prototype.toString`,
 * which renders `[object Object]` and says nothing at all.
 */
function hasOwnStringForm(value: object): boolean {
  try {
    return (
      (value as { toString?: unknown }).toString !== Object.prototype.toString
    );
  } catch {
    return false;
  }
}

/** A name for a value whose own string form says nothing, such as `[FooBar]`. */
function describeByConstructor(value: object): string {
  try {
    const name: unknown = (value as { constructor?: { name?: unknown } })
      .constructor?.name;

    if (typeof name === 'string' && name.length > 0) {
      return `[${name}]`;
    }
  } catch {
    // Fall through to the generic form.
  }

  return '[object Object]';
}

export function stringifyTemplateValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  // A plain object or array is its contents, so render them rather than `[object Object]`
  // - and rather than an array's default comma join, which cannot be told apart from one
  // element that happens to contain a comma.
  if (isPlainContainer(value)) {
    try {
      const json = JSON.stringify(value);

      if (typeof json === 'string') {
        return json;
      }
    } catch {
      // Cyclic, or holding a `BigInt`. Fall through rather than throw out of a log call.
    }

    return Array.isArray(value) ? '[array]' : '[object]';
  }

  if (value !== null && typeof value === 'object' && !hasOwnStringForm(value)) {
    // A class instance with no `toString` of its own. Name it rather than dumping its
    // fields, which is neither what the caller asked for nor safe to assume is printable.
    return describeByConstructor(value);
  }

  try {
    return String(value);
  } catch {
    return '[unrenderable]';
  }
}
