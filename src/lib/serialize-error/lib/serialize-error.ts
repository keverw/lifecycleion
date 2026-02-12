export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
  [key: string]: unknown;
}

/** Check if a value looks like an Error (has name, message, and stack). */
export function isErrorLike(
  value: unknown,
): value is { name: string; message: string; stack: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'name' in value &&
    'message' in value &&
    'stack' in value
  );
}

/**
 * Convert any Error (or error-like object, or arbitrary value) into a
 * plain, JSON-serializable object. All own properties — including the
 * non-enumerable ones that Error hides — are captured. Nested errors
 * are recursively serialized.
 */
export function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    const result: SerializedError = {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };

    for (const key of Object.getOwnPropertyNames(error)) {
      if (!(key in result)) {
        result[key] = (error as Record<string, unknown>)[key];
      }
    }

    return deepSerializeRecord(result);
  }

  if (isErrorLike(error)) {
    return deepSerializeRecord({
      ...(error as Record<string, unknown>),
    } as SerializedError);
  }

  return { name: 'Error', message: String(error) };
}

/**
 * Turn a serialized error object back into a throwable Error.
 * Useful on the receiving end of IPC / RPC when you need to re-throw.
 */
export function deserializeError(obj: SerializedError): Error {
  const { name, message, stack, ...rest } = obj;
  const error = new Error(message);
  error.name = name;

  if (stack) {
    error.stack = stack;
  }

  Object.assign(error, rest);
  return error;
}

// ── internal helpers ────────────────────────────────────────────────

function deepSerializeRecord(record: SerializedError): SerializedError {
  const result: SerializedError = {} as SerializedError;

  for (const [key, value] of Object.entries(record)) {
    result[key] = deepSerialize(value);
  }

  return result;
}

function deepSerialize(value: unknown): unknown {
  if (isErrorLike(value)) {
    return serializeError(value);
  }

  if (Array.isArray(value)) {
    return value.map(deepSerialize);
  }

  if (typeof value === 'object' && value !== null) {
    const result: Record<string, unknown> = {};

    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = deepSerialize(v);
    }

    return result;
  }

  return value;
}
