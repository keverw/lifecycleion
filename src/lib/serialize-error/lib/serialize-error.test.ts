import { describe, expect, test } from 'bun:test';
import * as vm from 'node:vm';
import {
  serializeError,
  deserializeError,
  isErrorLike,
  type SerializedError,
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
    test('survives an options bag whose handler getter throws', () => {
      // The options are read before any `try`, so a `Proxy` or a getter on the bag escaped
      // the one function whose contract is "never throws, always terminates" - and it
      // escaped while describing somebody else's failure at an IPC boundary.
      const hostileOptions = {
        get onFormatError(): never {
          throw new Error('options refused');
        },
      };

      const result = serializeError(new Error('boom'), hostileOptions);

      expect(result.message).toBe('boom');
      expect(result.name).toBe('Error');
    });

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

describe('serializeError on binary data attached to an error', () => {
  test('describes a bare ArrayBuffer rather than sending an empty object', () => {
    // `ArrayBuffer.isView` is false for the backing store, so it fell through to the object
    // branch - and `Object.keys(new ArrayBuffer(n))` is empty, so a buffer crossed the wire
    // as `{}`: indistinguishable from an empty object and silent about its size.
    const serialized = serializeError(
      Object.assign(new Error('boom'), { data: new ArrayBuffer(99) }),
    );

    expect(serialized.data).toBe('<binary: ArrayBuffer, 99 bytes>');
  });

  // `Array.isArray` is false for a `Buffer`, so it fell through to the object branch and
  // `Object.keys` enumerated its bytes: an ordinary buffer became a JSON object with one
  // key per byte, exhausting the node budget and spending the walk that is supposed to
  // describe a failure cheaply. `errorToString` already collapses the same shapes to a single leaf.
  test('a Buffer is one leaf, not one key per byte', () => {
    const error = new Error('boom') as Error & { data?: unknown };

    error.data = Buffer.from('hello world');

    const serialized = serializeError(error) as { data?: unknown };

    expect(serialized.data).toBe('<binary: Buffer, 11 bytes>');
  });

  test('a large typed array costs one node', () => {
    const error = new Error('boom') as Error & { data?: unknown };

    error.data = new Uint8Array(500_000);

    const started = Date.now();
    const serialized = serializeError(error) as { data?: unknown };

    expect(serialized.data).toBe('<binary: Uint8Array, 500000 bytes>');
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test('a DataView is described the same way', () => {
    const error = new Error('boom') as Error & { data?: unknown };

    error.data = new DataView(new ArrayBuffer(8));

    const serialized = serializeError(error) as { data?: unknown };

    expect(serialized.data).toBe('<binary: DataView, 8 bytes>');
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

  test('serializes Date fields as ISO timestamps', () => {
    const error = Object.assign(new Error('boom'), {
      occurredAt: new Date('2020-01-01T00:00:00.000Z'),
    });

    expect(serializeError(error).occurredAt).toBe('2020-01-01T00:00:00.000Z');
  });

  test('serializes Date fields created in another realm', () => {
    const occurredAt: unknown = vm.runInNewContext(
      "new Date('2020-01-01T00:00:00.000Z')",
    );
    const error = Object.assign(new Error('boom'), { occurredAt });

    expect(serializeError(error).occurredAt).toBe('2020-01-01T00:00:00.000Z');
  });

  test('bounds an enormous string passed as the error value', () => {
    const serialized = serializeError('x'.repeat(2_000_000));

    expect(serialized.message).toEndWith('[max length exceeded]');
    expect(JSON.stringify(serialized).length).toBeLessThan(1_100_000);
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

  test('keeps the payload JSON-serializable for leaves JSON cannot carry', () => {
    // The promise this module makes is a payload that survives `JSON.stringify`, and three
    // leaves broke it. A `BigInt` threw outright - at the IPC boundary, while already
    // reporting a failure - and a function or symbol value was dropped, key and all, with
    // nothing to say it had been there.
    const error = new Error('leaves');

    Object.assign(withExtras(error), {
      big: 9_007_199_254_740_993n,
      fn: function named() {
        return 1;
      },
      sym: Symbol('marker'),
      nested: { big: 1n },
    });

    const serialized = serializeError(error);

    expect(serialized.big).toBe('9007199254740993');
    // This module's own marker vocabulary - the angle brackets of
    // `<unserializable: value>` - not `errorToString`'s human-facing `[Function]`: this
    // payload is parsed by a receiver with no way to ask what a value means.
    expect(serialized.fn).toBe('<function>');
    expect(serialized.sym).toBe('<symbol: Symbol(marker)>');
    expect((serialized.nested as { big: unknown }).big).toBe('1');

    // The point of all four: this no longer throws.
    expect(() => JSON.stringify(serialized)).not.toThrow();
    expect(JSON.parse(JSON.stringify(serialized))).toMatchObject({
      message: 'leaves',
      big: '9007199254740993',
      fn: '<function>',
      sym: '<symbol: Symbol(marker)>',
    });
  });

  test('a hostile own `toJSON` cannot throw from inside the caller stringify', () => {
    // The worst of the dropped leaves. `JSON.stringify` *invokes* an own `toJSON`, so a
    // nested object carrying one was copied verbatim - method and all - and threw from the
    // caller's own `stringify`, downstream of everything this module guards.
    const error = new Error('hostile toJSON');

    withExtras(error).payload = {
      toJSON() {
        throw new Error('toJSON blew up');
      },
    };

    const serialized = serializeError(error);

    expect(() => JSON.stringify(serialized)).not.toThrow();
    expect((serialized.payload as { toJSON: unknown }).toJSON).toBe(
      '<function>',
    );
  });

  test('leaves `NaN` and the infinities to JSON own null convention', () => {
    // Deliberately untouched: `JSON.stringify` writes `null` for these rather than
    // throwing, so there is nothing to rescue and a marker would only disagree with what
    // the receiver gets.
    const error = new Error('numbers');

    Object.assign(withExtras(error), { nan: NaN, inf: Infinity });

    const serialized = serializeError(error);

    expect(serialized.nan).toBeNaN();
    expect(JSON.parse(JSON.stringify(serialized))).toMatchObject({
      nan: null,
      inf: null,
    });
  });

  test('bounds long string fields across the serialized payload', () => {
    // The depth and node caps do not bound one string. Error payloads cross process
    // boundaries, so one hostile message must not allocate an arbitrarily large frame.
    // The visible marker makes the lossy result explicit to the receiver.
    const long = 'x'.repeat(2_000_000);
    const error = new Error(long);

    withExtras(error).detail = long;

    const serialized = serializeError(error);

    expect(serialized.message).toEndWith('[max length exceeded]');
    expect(serialized['[max length exceeded]']).toBe('[max length exceeded]');
    expect(JSON.stringify(serialized).length).toBeLessThan(1_100_000);
  });

  test('preserves cause after a message spends the general text allowance', () => {
    const serialized = serializeError(
      new Error('x'.repeat(2_000_000), {
        cause: new Error('nested-cause-secret'),
      }),
    );

    expect(serialized).toHaveProperty('cause');
    expect((serialized.cause as SerializedError).message).toBe(
      'nested-cause-secret',
    );
    expect(JSON.stringify(serialized).length).toBeLessThan(1_100_000);
  });

  test('preserves AggregateError errors after a huge message', () => {
    const serialized = serializeError(
      new AggregateError(
        [new Error('first nested failure')],
        'x'.repeat(2_000_000),
      ),
    );

    expect(serialized).toHaveProperty('errors');
    expect((serialized.errors as SerializedError[])[0]?.message).toBe(
      'first nested failure',
    );
  });

  test('bounds a single enormous property name too', () => {
    const error = new Error('boom');
    const longKey = 'k'.repeat(2_000_000);

    withExtras(error)[longKey] = 'value';

    const serialized = serializeError(error);
    const outputKey = Object.keys(serialized).find((key) =>
      key.startsWith('k'),
    );

    expect(outputKey).toEndWith('[max length exceeded]');
    expect(JSON.stringify(serialized).length).toBeLessThan(1_100_000);
  });

  test('bounds an error-*like* bag carrying more own keys than the node budget', () => {
    // The same cap from the other side. `isErrorLike` accepts a plain object with `name`,
    // `message` and `stack` - which is what an error arriving over IPC looks like - and
    // that branch copied every own key uncharged, so adding those three members to a huge
    // bag bought its way past the cap the identical bag without them is bounded by.
    const bag: Record<string, unknown> = {
      name: 'Error',
      message: 'like',
      stack: 'stack',
    };

    for (let index = 0; index < 200_000; index++) {
      bag[`k${String(index)}`] = index;
    }

    const serialized = serializeError(
      new Error('boom', { cause: bag }),
    ) as unknown as { cause: Record<string, unknown> };

    expect(Object.keys(serialized.cause).length).toBeLessThan(200_000);
    // What makes it error-shaped survives the cut: those three are read by name.
    expect(serialized.cause.name).toBe('Error');
    expect(serialized.cause.message).toBe('like');
  });

  test('an error-like bag keeps its name and message when they come last', () => {
    // The budget can run out *on* `name` or `message` when the filler keys are enumerated
    // first, which charging them left it free to do: the marker landed on `name`, or both
    // were dropped, and `deserializeError` rebuilds a nameless `Error('')` from that.
    // Swept across the boundary rather than aimed at it: which key the budget lands on
    // depends on what the walk spent getting here, and every one of these positions used
    // to produce either the marker or nothing at all.
    for (const filler of [99_990, 99_992, 99_993, 99_994, 100_010]) {
      const bag: Record<string, unknown> = {};

      for (let index = 0; index < filler; index++) {
        bag[`k${String(index)}`] = index;
      }

      bag.name = 'TypeError';
      bag.message = 'last of all';
      bag.stack = 'stack';

      const serialized = serializeError(
        new Error('boom', { cause: bag }),
      ) as unknown as { cause: Record<string, unknown> };

      expect(serialized.cause.name).toBe('TypeError');
      expect(serialized.cause.message).toBe('last of all');
    }
  });

  test('a payload carrying an empty stack keeps the reconstructed one', () => {
    // Empty is absent, as it already is for `message`. Assigning it overwrote the stack
    // `new Error` had just constructed, so an error re-thrown on the receiving end of an
    // IPC boundary had no trace at either end of it.
    const rebuilt = deserializeError({
      name: 'Error',
      message: 'no stack on the wire',
      stack: '',
    });

    expect(rebuilt.stack).toBeTruthy();
    expect(rebuilt.message).toBe('no stack on the wire');
  });
});
