import { describe, expect, test } from 'bun:test';
import * as vm from 'node:vm';
import {
  serializeError,
  deserializeError,
  isErrorLike,
} from './serialize-error';

function withExtras(error: Error): Error & Record<string, unknown> {
  return error as Error & Record<string, unknown>;
}

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
    withExtras(error).nestedError = nested;
    withExtras(error).deeplyNested = {
      anotherError: new Error('Deep error'),
    };
    withExtras(error).someOtherInfo = 'info';

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
    expect(withExtras(error).errPrefix).toBe('IPCWorkerErr');
    expect(withExtras(error).errCode).toBe('WorkerCrashedFatally');
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
    expect(withExtras(restored).errPrefix).toBe('IPCWorkerErr');
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

describe('serializeError - values that resist serialization', () => {
  // This runs at an IPC/RPC boundary, usually while already reporting a failure, so a
  // second failure raised here replaces the one being reported. Every case below threw
  // before it was hardened.

  test('cuts a cyclic error instead of exhausting the stack', () => {
    const error: Error & { self?: unknown } = new Error('boom');

    error.self = error;

    const serialized = serializeError(error);

    expect(serialized.message).toBe('boom');
    expect(serialized['self']).toBe('[max depth exceeded]');
  });

  test('stops at the depth cap on a payload with no cycle in it', () => {
    let deep: Record<string, unknown> = { bottom: true };

    for (let index = 0; index < 5000; index++) {
      deep = { next: deep };
    }

    const error: Error & { payload?: unknown } = new Error('x');

    error.payload = deep;

    expect(() => serializeError(error)).not.toThrow();
    expect(JSON.stringify(serializeError(error))).toContain(
      '[max depth exceeded]',
    );
  });

  test('serializes a value referenced twice side by side in full both times', () => {
    // Releasing `seen` on the way out is what keeps a shared subtree from being mistaken
    // for a cycle.
    const shared = { id: 7 };
    const error: Error & { l?: unknown; r?: unknown } = new Error('x');

    error.l = shared;
    error.r = shared;

    const serialized = serializeError(error);

    expect(serialized['l']).toEqual({ id: 7 });
    expect(serialized['r']).toEqual({ id: 7 });
  });

  test('survives a message accessor that throws', () => {
    const error = new Error('placeholder');

    Object.defineProperty(error, 'message', {
      get() {
        throw new Error('message refused');
      },
    });

    expect(() => serializeError(error)).not.toThrow();
    expect(serializeError(error).name).toBe('Error');
  });

  test('survives a revoked Proxy', () => {
    const { proxy, revoke } = Proxy.revocable(new Error('p'), {});

    revoke();

    expect(() => serializeError(proxy)).not.toThrow();
  });

  test('survives a hostile has trap and a throwing toString', () => {
    const hostileHas = new Proxy(
      {},
      {
        has() {
          throw new Error('has refused');
        },
      },
    );

    expect(() => serializeError(hostileHas)).not.toThrow();
    expect(() =>
      serializeError({
        toString() {
          throw new Error('toString refused');
        },
      }),
    ).not.toThrow();
  });

  test('recognizes an error built in another realm', () => {
    // A bare `instanceof` fails across realms, so a `vm` error fell to the error-like
    // branch and was serialized without its non-enumerable `message` and `stack`.
    const foreign: unknown = vm.runInNewContext(
      'new Error("from another realm")',
    );

    const serialized = serializeError(foreign);

    expect(serialized.message).toBe('from another realm');
    expect(serialized.stack).toBeDefined();
  });

  test('marks one unreadable property without discarding its siblings', () => {
    const error: Error & { good?: unknown } = new Error('x');

    error.good = 'kept';
    Object.defineProperty(error, 'bad', {
      get() {
        throw new Error('property refused');
      },
      enumerable: true,
    });

    const serialized = serializeError(error);

    expect(serialized['good']).toBe('kept');
    expect(serialized['bad']).toBeUndefined();
  });
});

describe('deserializeError - untrusted input', () => {
  test('stores __proto__ as data instead of reparenting the error', () => {
    // This runs on whatever arrived over IPC. `Object.assign` uses [[Set]], so a payload
    // carrying `__proto__` reparented the reconstructed error rather than storing the key.
    const wire = JSON.parse(
      '{"name":"E","message":"m","__proto__":{"polluted":true}}',
    ) as Parameters<typeof deserializeError>[0];

    const error = deserializeError(wire);

    expect(Object.getPrototypeOf(error)).toBe(Error.prototype);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  test('tolerates a payload that does not match the declared shape', () => {
    const error = deserializeError({
      name: 42,
      message: null,
    } as unknown as Parameters<typeof deserializeError>[0]);

    expect(error).toBeInstanceOf(Error);
    expect(typeof error.message).toBe('string');
  });

  describe('serializeError onFormatError', () => {
    test('should report an unserializable value with its path', () => {
      // This runs at an IPC boundary, usually while already reporting a failure, so the
      // marker keeps the payload intact and sendable. The cause has nowhere to go but a
      // handler - and must not ride along in the payload, which is about to cross a wire.
      const seen: string[] = [];

      const bag: Record<string, unknown> = { safe: 'kept' };

      Object.defineProperty(bag, 'token', {
        get() {
          throw new Error('accessor refused: hunter2secret');
        },
        enumerable: true,
      });

      const result = serializeError(
        Object.assign(new Error('boom'), { context: bag }),
        {
          onFormatError: (error, _kind, path) =>
            seen.push(`${path}|${error.message}`),
        },
      );

      expect(seen).toHaveLength(1);
      expect(seen[0]).toContain('<error>.context.token');

      const wire = JSON.stringify(result);

      expect(wire).toContain('<unserializable: value>');
      expect(wire).toContain('kept');
      expect(wire).not.toContain('hunter2secret');
    });
  });
});
