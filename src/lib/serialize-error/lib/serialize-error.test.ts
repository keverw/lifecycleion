import { describe, expect, test } from 'bun:test';
import {
  serializeError,
  deserializeError,
  isErrorLike,
} from './serialize-error';

class WorkerCrashedError extends Error {
  public errPrefix = 'IPCWorkerErr';
  public errType = 'Client';
  public errCode = 'WorkerCrashedFatally';
  public additionalInfo: Record<string, unknown> = {};

  constructor(additionalInfo: {
    totalRestarts: number;
    maxRestarts: number;
    restartWindowSeconds: number;
  }) {
    super('Worker crashed too many times. Stopping restarts.');
    Error.captureStackTrace(this, WorkerCrashedError);
    this.name = 'WorkerCrashedError';
    if (additionalInfo) {
      this.additionalInfo = additionalInfo;
    }
  }
}

// ── serializeError ──────────────────────────────────────────────────

describe('serializeError', () => {
  test('should serialize a standard Error', () => {
    const error = new Error('Something broke');
    const serialized = serializeError(error);

    expect(serialized.name).toBe('Error');
    expect(serialized.message).toBe('Something broke');
    expect(serialized.stack).toBeDefined();

    // It's a plain object — JSON.stringify just works.
    const json = JSON.parse(JSON.stringify(serialized));
    expect(json.name).toBe('Error');
    expect(json.message).toBe('Something broke');
  });

  test('should capture all custom properties from an Error subclass', () => {
    const error = new WorkerCrashedError({
      totalRestarts: 6,
      maxRestarts: 5,
      restartWindowSeconds: 60,
    });

    const serialized = serializeError(error);

    expect(serialized.name).toBe('WorkerCrashedError');
    expect(serialized.message).toBe(
      'Worker crashed too many times. Stopping restarts.',
    );
    expect(serialized.stack).toBeDefined();
    expect(serialized.errPrefix).toBe('IPCWorkerErr');
    expect(serialized.errType).toBe('Client');
    expect(serialized.errCode).toBe('WorkerCrashedFatally');
    expect(serialized.additionalInfo).toEqual({
      totalRestarts: 6,
      maxRestarts: 5,
      restartWindowSeconds: 60,
    });
  });

  test('should handle non-Error values', () => {
    expect(serializeError('oops')).toEqual({ name: 'Error', message: 'oops' });
    expect(serializeError(404)).toEqual({ name: 'Error', message: '404' });
    expect(serializeError(null)).toEqual({ name: 'Error', message: 'null' });
  });

  test('should handle error-like plain objects', () => {
    const errorLike = {
      name: 'CustomError',
      message: 'something failed',
      stack: 'fake stack',
      code: 42,
    };

    const serialized = serializeError(errorLike);

    expect(serialized.name).toBe('CustomError');
    expect(serialized.message).toBe('something failed');
    expect(serialized.code).toBe(42);
  });

  test('should recursively serialize nested errors', () => {
    const nested = new WorkerCrashedError({
      totalRestarts: 3,
      maxRestarts: 5,
      restartWindowSeconds: 30,
    });

    const error = new Error('Main error');
    (error as Record<string, unknown>).nestedError = nested;
    (error as Record<string, unknown>).deeplyNested = {
      anotherError: new Error('Deep error'),
    };
    (error as Record<string, unknown>).someOtherInfo = 'info';

    const serialized = serializeError(error);

    const nestedData = serialized.nestedError as Record<string, unknown>;
    expect(nestedData.name).toBe('WorkerCrashedError');
    expect(nestedData.message).toBe(
      'Worker crashed too many times. Stopping restarts.',
    );
    expect(nestedData.errPrefix).toBe('IPCWorkerErr');

    const deep = serialized.deeplyNested as Record<string, unknown>;
    const anotherError = deep.anotherError as Record<string, unknown>;
    expect(anotherError.name).toBe('Error');
    expect(anotherError.message).toBe('Deep error');

    expect(serialized.someOtherInfo).toBe('info');
  });

  test('JSON.stringify round-trip should preserve all data', () => {
    const error = new WorkerCrashedError({
      totalRestarts: 6,
      maxRestarts: 5,
      restartWindowSeconds: 60,
    });

    const serialized = serializeError(error);
    const roundTripped = JSON.parse(JSON.stringify(serialized));

    expect(roundTripped.name).toBe('WorkerCrashedError');
    expect(roundTripped.message).toBe(
      'Worker crashed too many times. Stopping restarts.',
    );
    expect(roundTripped.errPrefix).toBe('IPCWorkerErr');
    expect(roundTripped.errCode).toBe('WorkerCrashedFatally');
    expect(roundTripped.additionalInfo).toEqual({
      totalRestarts: 6,
      maxRestarts: 5,
      restartWindowSeconds: 60,
    });
  });
});

// ── deserializeError ────────────────────────────────────────────────

describe('deserializeError', () => {
  test('should create a throwable Error from a serialized object', () => {
    const serialized = serializeError(
      new WorkerCrashedError({
        totalRestarts: 6,
        maxRestarts: 5,
        restartWindowSeconds: 60,
      }),
    );

    const error = deserializeError(serialized);

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('WorkerCrashedError');
    expect(error.message).toBe(
      'Worker crashed too many times. Stopping restarts.',
    );
    expect((error as Record<string, unknown>).errPrefix).toBe('IPCWorkerErr');
    expect((error as Record<string, unknown>).errCode).toBe(
      'WorkerCrashedFatally',
    );
  });

  test('full round-trip: Error → serialize → JSON → parse → deserialize → Error', () => {
    const original = new WorkerCrashedError({
      totalRestarts: 6,
      maxRestarts: 5,
      restartWindowSeconds: 60,
    });

    const json = JSON.stringify(serializeError(original));
    const restored = deserializeError(JSON.parse(json));

    expect(restored).toBeInstanceOf(Error);
    expect(restored.name).toBe('WorkerCrashedError');
    expect(restored.message).toBe(
      'Worker crashed too many times. Stopping restarts.',
    );
    expect((restored as Record<string, unknown>).errPrefix).toBe(
      'IPCWorkerErr',
    );
  });
});

// ── isErrorLike ─────────────────────────────────────────────────────

describe('isErrorLike', () => {
  test('should identify error-like objects', () => {
    expect(isErrorLike(new Error('test'))).toBe(true);
    expect(isErrorLike({ name: 'E', message: 'msg', stack: 'trace' })).toBe(
      true,
    );
  });

  test('should reject non-error-like values', () => {
    expect(isErrorLike({ message: 'no name or stack' })).toBe(false);
    expect(isErrorLike(null)).toBe(false);
    expect(isErrorLike('string')).toBe(false);
    expect(isErrorLike(42)).toBe(false);
  });
});
