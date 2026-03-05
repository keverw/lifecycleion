import datamask from 'datamask';
import { deepClone } from '../../deep-clone';
import { getPathParts } from '../../internal/path-utils';
import { stringifyTemplateValue } from '../../internal/stringify-template-value';
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

  // Defensive fallback for direct callers bypassing applyRedaction.
  // Ideally, this should never be reached.
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

  // Deep clone to avoid mutating original
  const redactedParams = deepClone(params);

  // Apply redaction to specified keys (supports nested object paths, array indexes, and quoted bracket keys)
  for (const key of redactedKeys) {
    // Check if it's a nested key or array path
    if (key.includes('.') || key.includes('[')) {
      const value = getNestedValue(params, key);

      if (value !== undefined) {
        const redactedValue = redactFn(key, stringifyTemplateValue(value));
        setNestedValue(redactedParams, key, redactedValue);
      }
    } else {
      // Top-level key
      if (key in params) {
        redactedParams[key] = redactFn(
          key,
          stringifyTemplateValue(params[key]),
        );
      }
    }
  }

  return redactedParams;
}
