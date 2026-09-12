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

  test('marks and reports an unreadable message instead of emptying it', () => {
    // Across a process boundary, where the receiver has no `onFormatError` of its own. A
    // guarded read answering `undefined` met `?? ''` and produced a well-formed error whose
    // message simply was not there - indistinguishable, on the far side of the wire, from
    // an error genuinely raised with no message.
    const error = new Error('never read');

    Object.defineProperty(error, 'message', {
      get(): never {
        throw new Error('message refused');
      },
      configurable: true,
    });

    const seen: [string, string][] = [];
    const serialized = serializeError(error, {
      onFormatError: (failure, kind, path) => {
        seen.push([kind, path]);
      },
    });

    expect(serialized.message).toBe('<unserializable: text>');
    expect(seen).toEqual([['render', '<error>.message']]);
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

    // Marked, as the test's name says, not dropped. `undefined` was the old answer and it
    // did not survive `JSON.stringify`: the property vanished from the wire entirely, so
    // the peer saw a field the error had never carried rather than one that refused to be
    // read.
    expect(serialized['bad']).toBe('<unserializable: value>');
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

describe('serializeError terminates on payloads nothing else bounds', () => {
  // The depth cap bounds how deep the walk goes, the cycle cut bounds loops, and neither
  // bounds how much the walk *emits*. `seen` is released as the walk leaves a node -
  // deliberately - so a shared subtree is serialized once per reference, which is
  // exponential in depth rather than linear in size.

  const diamond = (levels: number): unknown => {
    let child: unknown = { leaf: 'x' };

    for (let index = 0; index < levels; index++) {
      child = { l: child, r: child };
    }

    return child;
  };

  test('a shared subtree does not grow the output exponentially with depth', () => {
    const twenty = new Error('boom') as Error & { data?: unknown };
    const thirty = new Error('boom') as Error & { data?: unknown };

    twenty.data = diamond(20);
    thirty.data = diamond(30);

    const twentySize = JSON.stringify(serializeError(twenty)).length;
    const thirtySize = JSON.stringify(serializeError(thirty)).length;

    // Ten more levels is 1024x the routes through the graph. Unbounded, twenty levels
    // produced 22 MB and thirty ran out of memory.
    expect(twentySize).toBeLessThan(4_000_000);
    expect(thirtySize).toBeLessThan(4_000_000);
  });

  test('a huge sparse array is not materialized in full', () => {
    // Every slot is a hole, so every read answers `undefined` and costs nothing to walk -
    // which is exactly why a per-container charge was not enough on its own.
    const error = new Error('boom') as Error & { data?: unknown };

    error.data = new Array(20_000_000);

    const startedAt = Date.now();
    const serialized = serializeError(error) as unknown as {
      data: unknown[];
    };

    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(serialized.data.length).toBeLessThan(1_000_000);
  });

  test('an ordinary error payload is untouched by the cap', () => {
    const error = new Error('boom') as Error & { data?: unknown };

    error.data = { user: 'alice', attempts: [1, 2, 3], meta: { ok: true } };

    const serialized = serializeError(error) as unknown as { data: unknown };

    expect(serialized.data).toEqual({
      user: 'alice',
      attempts: [1, 2, 3],
      meta: { ok: true },
    });
  });
});

describe('serializeError on values that are error-shaped without being errors', () => {
  test('reports and marks a shape that cannot be enumerated', () => {
    // `describeContainer` answering `'unreadable'` was ignored, so this returned a bare
    // `{}`: not a valid `SerializedError`, nothing reported, and a peer rebuilding a
    // nameless `Error('')` from it.
    const hostile = new Proxy(
      { name: 'HostileError', message: 'boom', stack: 'stack' },
      {
        ownKeys() {
          throw new Error('ownKeys refused');
        },
      },
    );

    const reported: unknown[] = [];
    const result = serializeError(hostile, {
      onFormatError: (failure) => {
        reported.push(failure);
      },
    });

    expect(reported).toHaveLength(1);
    expect(result.name).toBe('Error');
    expect(typeof result.message).toBe('string');
    expect(result.message).not.toBe('');
  });

  test('keeps the three members of an error-shaped array', () => {
    // An array is reported by length, so the object branch never saw these keys and the
    // whole value serialized to `{}`.
    const arrayLike = ['a'] as unknown[] & Record<string, unknown>;
    arrayLike.name = 'ArrayError';
    arrayLike.message = 'from an array';
    arrayLike.stack = 'stack line';

    const result = serializeError(arrayLike);

    expect(result.name).toBe('ArrayError');
    expect(result.message).toBe('from an array');
    expect(result.stack).toBe('stack line');
  });

  test('does not walk the elements of a huge error-shaped array', () => {
    const huge = new Array(200_000).fill('x') as unknown[] &
      Record<string, unknown>;
    huge.name = 'BigError';
    huge.message = 'big';
    huge.stack = 'stack';

    const result = serializeError(huge);

    expect(result.name).toBe('BigError');
    expect(Object.keys(result).length).toBeLessThan(10);
  });
});

describe('serializeError on non-string name/message/stack', () => {
  test('describes a member that is present but not a string', () => {
    // `?? ''` turned this into an empty message, and the own-property copy loop then
    // skipped `message` because the key was already on the result - so the `42` reached
    // the peer nowhere at all.
    const error = withExtras(new Error('ignored'));
    error.message = 42 as unknown as string;

    const result = serializeError(error);

    expect(result.message).toBe('42');
  });

  test('treats an absent or null member as absent rather than describing it', () => {
    // `deserializeError` refuses to fabricate `'null'` on the far side of the wire, so
    // describing it here would put the two ends of one round trip in disagreement.
    const error = withExtras(new Error('ignored'));
    error.message = null as unknown as string;
    error.name = null as unknown as string;
    error.stack = null as unknown as string;

    const result = serializeError(error);

    expect(result.name).toBe('Error');
    expect(result.message).toBe('');
    expect(result.stack).toBeUndefined();

    const rebuilt = deserializeError(result);

    expect(rebuilt.name).toBe('Error');
    expect(rebuilt.message).toBe('');
  });
});

describe('error-shaped objects with inherited members', () => {
  test('carries name, message and stack read off the prototype', () => {
    // `isErrorLike` tests with `in`, so what makes the value error-shaped can live on its
    // prototype. An own-key copy carried none of it: the result was `{ field: 'email' }` -
    // not a valid `SerializedError` - and `deserializeError` rebuilt a nameless `Error('')`.
    const proto = {
      name: 'ValidationError',
      message: 'bad input',
      stack: 'at validate',
    };

    const value = Object.create(proto) as Record<string, unknown>;

    value.field = 'email';

    const serialized = serializeError(value);

    expect(serialized.name).toBe('ValidationError');
    expect(serialized.message).toBe('bad input');
    expect(serialized.stack).toBe('at validate');
    expect((serialized as Record<string, unknown>).field).toBe('email');

    const rebuilt = deserializeError(serialized);

    expect(rebuilt.message).toBe('bad input');
    expect(rebuilt.name).toBe('ValidationError');
  });

  test('an own member still wins over the inherited one', () => {
    const proto = {
      name: 'Inherited',
      message: 'inherited',
      stack: 'at proto',
    };
    const value = Object.create(proto) as Record<string, unknown>;

    value.message = 'own';

    const serialized = serializeError(value);

    expect(serialized.message).toBe('own');
    expect(serialized.name).toBe('Inherited');
  });

  test('keeps an own property whose name is on Object.prototype', () => {
    // `!(key in result)` walked the prototype chain, so an own `toString`, `valueOf` or
    // `constructor` answered "already present" about a key the result had never been
    // given, and was dropped with no marker and no report.
    const shadowingKeys = ['toString', 'valueOf', 'constructor'];
    const error = new Error('boom');

    for (const key of shadowingKeys) {
      (error as unknown as Record<string, unknown>)[key] = `own-${key}`;
    }

    const serialized = serializeError(error) as unknown as Record<
      string,
      unknown
    >;

    for (const key of shadowingKeys) {
      expect(serialized[key]).toBe(`own-${key}`);
    }
  });

  test('bounds an error carrying more own keys than the node budget', () => {
    // The error's own enumeration was uncharged, so `MAX_SERIALIZED_NODES` bounded every
    // walk but the one that reaches every error: a `cause` holding three hundred thousand
    // keys copied and serialized all of them, synchronously, at an IPC boundary.
    const cause = new Error('cause');
    const bag = cause as unknown as Record<string, unknown>;

    for (let index = 0; index < 200_000; index++) {
      bag[`k${String(index)}`] = index;
    }

    const serialized = serializeError(
      new Error('boom', { cause }),
    ) as unknown as { cause: Record<string, unknown> };

    expect(Object.keys(serialized.cause).length).toBeLessThan(200_000);
    expect(serialized.cause.name).toBe('Error');
    expect(serialized.cause.message).toBe('cause');
  });
});
