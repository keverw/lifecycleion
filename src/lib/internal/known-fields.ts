import { isNullish } from './is-nullish';

/** What a field name reads as when it is an option's, or a typo of one. */
const OPTION_NAME = /^[A-Za-z_$][\w$]{0,63}$/;

/**
 * Refuses, with a `TypeError` naming `label`, an object holding an own enumerable field
 * that is not one of `fields`: a misspelled option (`folowRedirects`, `timout`) would
 * otherwise be read as absent, and the option it meant would silently keep its default.
 * A field the reader takes from a prototype or a getter is read as it always was. One
 * whose own data value is `null` or `undefined` would be read as absent either way, so it
 * is let through, as a filter's is - a wider options shape forwarded with its extra
 * fields unset. Anything that is not an object is left to the caller's own check.
 *
 * The refusal names the field when it reads as an option name - a short identifier, as a
 * typo of one is. Any other key is not written into the message: it may be the wrong value
 * pasted in as a key (`'Bearer …'`).
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

    const field = OPTION_NAME.test(key)
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
