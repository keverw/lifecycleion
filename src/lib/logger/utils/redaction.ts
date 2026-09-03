import { deepClone } from '../../deep-clone';
import { defaultRedactValue } from '../../internal/default-redact-function';
import { getPathParts } from '../../internal/path-utils';
import { stringifyTemplateValue } from '../../internal/stringify-template-value';
import type { RedactFunction } from '../types';

/**
 * Default redaction function using datamask
 * Masks sensitive values with asterisks
 */
export const defaultRedactFunction: RedactFunction = defaultRedactValue;

/**
 * Substituted for a value whose redaction failed.
 *
 * Deliberately distinct from a successful mask: an operator seeing the ordinary `***`
 * concludes redaction worked, so a broken `redactFunction` would hide itself. Redaction
 * fails closed — the original value is never left in place — but it says so.
 */
export const REDACTION_FAILED_MARKER = '***REDACTION FAILED***';

/**
 * Set a value at a nested path in an object
 */
function setNestedValue(
  obj: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const parts = getPathParts(path);

  if (!parts || parts.length === 0) {
    return;
  }

  let current: unknown = obj;

  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (
      current === undefined ||
      current === null ||
      typeof current !== 'object' ||
      !(part in current)
    ) {
      return; // Path doesn't exist, can't set value
    }

    const next = (current as Record<string, unknown>)[part];

    if (next === undefined || next === null || typeof next !== 'object') {
      return; // Path doesn't exist, can't set value
    }

    current = next;
  }

  const lastPart = parts[parts.length - 1];

  if (
    lastPart !== undefined &&
    current !== undefined &&
    current !== null &&
    typeof current === 'object' &&
    lastPart in current
  ) {
    (current as Record<string, unknown>)[lastPart] = value;
  }
}

/**
 * Get a value at a nested path in an object
 */
function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = getPathParts(path);

  if (!parts || parts.length === 0) {
    return undefined;
  }

  let current: unknown = obj;

  for (const part of parts) {
    if (
      current === undefined ||
      current === null ||
      typeof current !== 'object' ||
      !(part in current)
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

/**
 * Apply redaction to params based on redacted keys
 * Supports top-level keys and mixed object/array paths
 * (e.g., 'user.password', 'users[0].password', or 'users[0]["password-hash"]')
 *
 * @param params Original params object
 * @param redactedKeys Keys to redact (supports nested object paths, array indexes, and quoted bracket keys)
 * @param redactFunction Custom redaction function (uses defaultRedactFunction if not provided)
 * @returns New object with redacted values
 */
export function applyRedaction(
  params: Record<string, unknown>,
  redactedKeys?: string[],
  redactFunction?: RedactFunction,
): Record<string, unknown> {
  // No redaction needed
  if (!redactedKeys || redactedKeys.length === 0) {
    return params;
  }

  const redactFn = redactFunction || defaultRedactFunction;

  /**
   * Apply the caller's function, deferring to the default when it declines.
   *
   * `null` (or nothing at all) means "use the default for this one", so a caller can
   * special-case a few keys without reproducing the default masking for the rest. To
   * render a literal null, return the string.
   */
  const redactValue = (fieldKey: string, value: unknown): unknown => {
    const masked = redactFn(fieldKey, value);

    return masked === null || masked === undefined
      ? defaultRedactValue(fieldKey, value)
      : masked;
  };

  // Deep clone to avoid mutating original.
  //
  // Guarded, and failing closed: `deepClone` runs over caller-supplied params and can
  // throw on a structure it cannot copy. Returning the originals here would hand every
  // sink — and the rendered message — the unredacted values, which is the one outcome
  // redaction exists to prevent, so an uncopyable params object yields only markers for
  // the redacted keys and nothing else. Losing the non-sensitive params from
  // `redactedParams` is the price; `entry.params` still carries them for a sink that
  // opts into the raw view.
  let redactedParams: Record<string, unknown>;

  try {
    redactedParams = deepClone(params);
  } catch {
    return Object.fromEntries(
      redactedKeys.map((key) => [key, REDACTION_FAILED_MARKER]),
    );
  }

  // Apply redaction to specified keys (supports nested object paths, array indexes, and quoted bracket keys)
  for (const key of redactedKeys) {
    // Every step here runs code this module does not own: `redactFn` is user-supplied,
    // `stringifyTemplateValue` invokes `toString`, and reading or writing the path can
    // trip an accessor or a `Proxy` trap. A failure must not propagate — `handleLog` is
    // on a path that must not throw — and must never leave the original value in place,
    // so the key is marked instead.
    try {
      // Check if it's a nested key or array path
      if (key.includes('.') || key.includes('[')) {
        const value = getNestedValue(params, key);

        if (value !== undefined) {
          const redactedValue = redactValue(key, stringifyTemplateValue(value));
          setNestedValue(redactedParams, key, redactedValue);
        }

        // Also redact a key spelled exactly like the path, when one exists.
        // `{ 'user.password': 'secret' }` names one literal key, not a nested one, and
        // the path walk looks for `params.user.password` - so without this the caller
        // redacts the only spelling they have and the value still renders in the clear.
        // Both are covered rather than one or the other: the entry is ambiguous, and
        // leaving either reading unredacted is the outcome redaction exists to prevent.
        if (key in params) {
          redactedParams[key] = redactValue(
            key,
            stringifyTemplateValue(params[key]),
          );
        }
      } else {
        // Top-level key
        if (key in params) {
          redactedParams[key] = redactValue(
            key,
            stringifyTemplateValue(params[key]),
          );
        }
      }
    } catch {
      try {
        // The literal slot first, and unconditionally: `setNestedValue` re-parses `key`
        // as a path, so for a key spelled `'user.password'` it finds no such path, writes
        // nothing, and the deep clone's original value survives in the clear. That is
        // reachable without any user code at all - a value whose `toString` throws makes
        // `stringifyTemplateValue` fail on the success path above and land here.
        if (key in redactedParams) {
          redactedParams[key] = REDACTION_FAILED_MARKER;
        }

        setNestedValue(redactedParams, key, REDACTION_FAILED_MARKER);
      } catch {
        // The path cannot even be written. Drop every param rather than return a copy
        // whose sensitive key still holds its original value.
        return Object.fromEntries(
          redactedKeys.map((failedKey) => [failedKey, REDACTION_FAILED_MARKER]),
        );
      }
    }
  }

  return redactedParams;
}
