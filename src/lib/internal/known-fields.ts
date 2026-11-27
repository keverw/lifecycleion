import { describeValue } from './describe-value';
import { isNullish } from './is-nullish';

/**
 * Refuses, with a `TypeError` naming `label`, an options argument that is not an object: a
 * string, number, array or function would otherwise be read as one with no fields, every
 * option at its default - `new HTTPClient('https://api.test')` a client with no
 * `baseURL`. `undefined` is no options; so is `null` where `isNullAbsent` says so, and
 * elsewhere it is refused.
 */
export function assertOptionsObject(
  value: unknown,
  label: string,
  isNullAbsent = false,
): void {
  if (value === undefined || (isNullAbsent && value === null)) {
    return;
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(
      `${label} must be an object (got ${Array.isArray(value) ? 'an array' : describeValue(value)})`,
    );
  }
}

/** What a field name reads as: an identifier. */
const OPTION_NAME = /^[A-Za-z_$][\w$]*$/;

/**
 * A camelCase name made of words, as every option is (`delayMS`, `maxRetryAfterMS`): a
 * lowercase word, then words that start uppercase, then at most one short acronym, no
 * digit or `_`, and no word longer than 13 letters - the longest in any option name is
 * `authorization`. A key shaped so names an option of some kind - another variant's, say
 * - not a secret, where a long lowercase run (`correcthorsebatterystaple`, with a suffix
 * or without) may be a passphrase pasted in as a key. One way to read any key, as no
 * quantifier can take a letter the next one could, so no key makes it backtrack.
 */
const WORDS_NAME = /^[a-z]{1,13}(?:[A-Z][a-z]{1,12})*(?:[A-Z]{2,4})?$/;

/** How many single-character edits away from a field a key may be and still be named. */
const MAX_TYPO_DISTANCE = 2;

/**
 * Whether `key` reads as an option's name, or a typo of one of `fields`: a camelCase name
 * of words ({@link WORDS_NAME}), the same name as a field in another case, or one at most
 * {@link MAX_TYPO_DISTANCE} edits from it (`folowRedirects`, `timout`). A token pasted in
 * as a key - an API key, an AWS access key ID - is an identifier too, but none of these,
 * so it is not written into the refusal.
 */
function readsAsOptionName(key: string, fields: readonly string[]): boolean {
  if (!OPTION_NAME.test(key)) {
    return false;
  }

  if (WORDS_NAME.test(key)) {
    return true;
  }

  const lowerKey = key.toLowerCase();
  return fields.some(
    (field) =>
      field.toLowerCase() === lowerKey ||
      editDistanceAtMost(key, field, MAX_TYPO_DISTANCE),
  );
}

/** Whether `a` and `b` are at most `limit` single-character edits apart (Levenshtein). */
function editDistanceAtMost(a: string, b: string, limit: number): boolean {
  if (Math.abs(a.length - b.length) > limit) {
    return false;
  }

  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let row = 1; row <= a.length; row++) {
    const current = [row];
    let rowMin = row;
    for (let column = 1; column <= b.length; column++) {
      const cost = a[row - 1] === b[column - 1] ? 0 : 1;
      const value = Math.min(
        previous[column] + 1,
        current[column - 1] + 1,
        previous[column - 1] + cost,
      );
      current.push(value);
      rowMin = Math.min(rowMin, value);
    }
    if (rowMin > limit) {
      return false;
    }
    previous = current;
  }

  return previous[b.length] <= limit;
}

/**
 * Refuses, with a `TypeError` naming `label`, an object holding an own enumerable field
 * that is not one of `fields`: a misspelled option (`folowRedirects`, `timout`) would
 * otherwise be read as absent, and the option it meant would silently keep its default.
 * A field the reader takes from a prototype or a getter is read as it always was. One
 * whose own data value is `null` or `undefined` would be read as absent either way, so it
 * is let through, as a filter's is - a wider options shape forwarded with its extra
 * fields unset. Anything that is not an object is left to the caller's own check.
 *
 * The refusal names the field when it reads as an option's name, or a typo of one taken
 * (see `readsAsOptionName`). Any other key is not written into the message: it may be the wrong
 * value pasted in as a key (`'Bearer …'`, a token).
 */
export function assertKnownFields(
  value: unknown,
  fields: readonly string[],
  label: string,
  /** Keys let through without being named among the fields taken. */
  exempt: readonly string[] = [],
): void {
  if (typeof value !== 'object' || value === null) {
    return;
  }

  for (const key of Object.keys(value)) {
    if (fields.includes(key) || exempt.includes(key)) {
      continue;
    }

    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor !== undefined &&
      'value' in descriptor &&
      isNullish(descriptor.value)
    ) {
      continue;
    }

    const field = readsAsOptionName(key, fields)
      ? `${JSON.stringify(key)} field`
      : 'field by that name';
    throw new TypeError(
      `${label} has no ${field} (it takes ${fields.join(', ')})`,
    );
  }
}

/**
 * The names of a type's fields, from a record that must list each of them - so a field
 * added to the type and not here fails to compile.
 */
export function fieldNames<T>(record: Record<keyof T, true>): string[] {
  return Object.keys(record);
}
