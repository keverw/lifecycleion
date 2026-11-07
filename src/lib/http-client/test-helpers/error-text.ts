/**
 * Every string an error carries, for a test that checks a secret is in none of them: its
 * message and every own property, string- or symbol-keyed, enumerable or not (a URL
 * parser's `input`), its JSON form, and the same again for every object among them - its
 * `cause` chain, and the errors an `AggregateError` holds in an array.
 */
export function errorText(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  const pending: unknown[] = [error];

  while (pending.length > 0) {
    const current = pending.pop();

    if (typeof current !== 'object' || current === null) {
      // A primitive member or `cause`, a thrown string say.
      parts.push(jsonOf(current));
      continue;
    }
    if (seen.has(current)) {
      continue;
    }
    seen.add(current);
    parts.push(jsonOf(current));
    // Read as well as the own keys: a `DOMException`'s `message` is an inherited getter.
    try {
      pending.push((current as { message?: unknown }).message);
    } catch {
      // An unreadable message carries nothing to find.
    }

    for (const key of Reflect.ownKeys(current)) {
      let value: unknown;
      try {
        value = (current as Record<PropertyKey, unknown>)[key];
      } catch {
        continue;
      }
      if (typeof value === 'string') {
        parts.push(value);
      } else {
        pending.push(value);
      }
    }
  }

  return parts.join('\n');
}

function jsonOf(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}
