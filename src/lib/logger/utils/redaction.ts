import datamask from 'datamask';
import { deepClone } from '../../deep-clone';
import type { RedactFunction } from '../types';

/**
 * Default redaction function using datamask
 * Masks sensitive values with asterisks
 */
export const defaultRedactFunction: RedactFunction = (
  _keyName: string,
  value: unknown,
): unknown => {
  if (typeof value === 'string') {
    return datamask.string(value, '*', 60);
  }
  // For non-strings, mask as generic redacted value
  return '***REDACTED***';
};

/**
 * Set a value at a nested path in an object
 */
function setNestedValue(
  obj: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const parts = path.split('.');
  let current: Record<string, unknown> = obj;

  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    const next = current[part];

    if (next === undefined || next === null || typeof next !== 'object') {
      return; // Path doesn't exist, can't set value
    }

    current = next as Record<string, unknown>;
  }

  const lastPart = parts[parts.length - 1];
  if (lastPart !== undefined && lastPart in current) {
    current[lastPart] = value;
  }
}

/**
 * Get a value at a nested path in an object
 */
function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
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
 * Supports both top-level keys and nested paths using dot notation (e.g., 'user.password')
 *
 * @param params Original params object
 * @param redactedKeys Keys to redact (supports dot notation for nested keys)
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

  // Deep clone to avoid mutating original
  const redactedParams = deepClone(params) as Record<string, unknown>;

  // Apply redaction to specified keys (supports dot notation)
  for (const key of redactedKeys) {
    // Check if it's a nested key (contains dots)
    if (key.includes('.')) {
      const value = getNestedValue(redactedParams, key);

      if (value !== undefined) {
        const redactedValue = redactFn(key, value);
        setNestedValue(redactedParams, key, redactedValue);
      }
    } else {
      // Top-level key
      if (key in redactedParams) {
        redactedParams[key] = redactFn(key, redactedParams[key]);
      }
    }
  }

  return redactedParams;
}
