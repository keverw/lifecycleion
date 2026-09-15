import { describe, expect, test } from 'bun:test';
import { ArraySink } from './array';
import type { LogEntry } from '../types';
import { MAX_RENDER_DEPTH, TRUNCATED } from '../../internal/render-budget';
import {
  muteConsoleError,
  restoreConsoleError,
} from '../../internal/console-test-utils';

describe('ArraySink', () => {
  test('should store log entries', () => {
    const sink = new ArraySink();

    const entry: LogEntry = {
      timestamp: Date.now(),
      type: 'info',
      serviceName: '',
      template: 'Test message',
      message: 'Test message',
    };

    sink.write(entry);

    expect(sink.logs.length).toBe(1);
    expect(sink.logs[0]).toEqual(entry);
  });

  test('should store multiple log entries', () => {
    const sink = new ArraySink();

    const entries: LogEntry[] = [
      {
        timestamp: Date.now(),
        type: 'info',
        serviceName: '',
        template: 'Info message',
        message: 'Info message',
      },
      {
        timestamp: Date.now(),
        type: 'error',
        serviceName: '',
        template: 'Error message',
        message: 'Error message',
      },
      {
        timestamp: Date.now(),
        type: 'warn',
        serviceName: '',
        template: 'Warning message',
        message: 'Warning message',
      },
    ];

    for (const entry of entries) {
      sink.write(entry);
    }

    expect(sink.logs.length).toBe(3);
    expect(sink.logs).toEqual(entries);
  });

  test('should clear all logs', () => {
    const sink = new ArraySink();

    const entry: LogEntry = {
      timestamp: Date.now(),
      type: 'info',
      serviceName: '',
      template: 'Test message',
      message: 'Test message',
    };

    sink.write(entry);
    sink.write(entry);
    sink.write(entry);

    expect(sink.logs.length).toBe(3);

    sink.clear();

    expect(sink.logs.length).toBe(0);
  });

  test('should return snapshot friendly logs', () => {
    const sink = new ArraySink();

    const entries: LogEntry[] = [
      {
        timestamp: Date.now(),
        type: 'info',
        serviceName: '',
        template: 'Info message',
        message: 'Info message',
      },
      {
        timestamp: Date.now(),
        type: 'error',
        serviceName: '',
        template: 'Error message',
        message: 'Error message',
      },
    ];

    for (const entry of entries) {
      sink.write(entry);
    }

    const snapshot = sink.getSnapshotFriendlyLogs();

    expect(snapshot).toEqual(['info: Info message', 'error: Error message']);
  });

  test('should store params and redacted params', () => {
    const sink = new ArraySink();

    const entry: LogEntry = {
      timestamp: Date.now(),
      type: 'info',
      serviceName: '',
      template: 'User {{userID}} logged in',
      message: 'User 456 logged in',
      params: { userID: 456, password: 'secret' },
      redactedParams: { userID: 456, password: '******' },
    };

    sink.write(entry);

    expect(sink.logs[0].params).toEqual({ userID: 456, password: 'secret' });
    expect(sink.logs[0].redactedParams).toEqual({
      userID: 456,
      password: '******',
    });
  });

  test('should store service name', () => {
    const sink = new ArraySink();

    const entry: LogEntry = {
      timestamp: Date.now(),
      type: 'info',
      serviceName: 'TestService',
      template: 'Test message',
      message: 'Test message',
    };

    sink.write(entry);

    expect(sink.logs[0].serviceName).toBe('TestService');
  });

  test('should transform log entries with transformer', () => {
    const sink = new ArraySink({
      transformer: (entry) => {
        return {
          ...entry,
          message: `${entry.serviceName}: ${entry.type} - ${entry.message}`,
        };
      },
    });

    const entry: LogEntry = {
      timestamp: Date.now(),
      type: 'info',
      serviceName: 'TestService',
      template: 'Test message',
      message: 'Test message',
    };

    sink.write(entry);

    expect(sink.logs[0].message).toBe('TestService: info - Test message');
    const snapshot = sink.getSnapshotFriendlyLogs();
    expect(snapshot[0]).toBe('info: TestService: info - Test message');
  });

  test('should keep original entry when transformer returns false', () => {
    const sink = new ArraySink({
      transformer: (entry) => {
        if (entry.message === 'Keep original') {
          return false;
        }
        return { ...entry, message: `Transformed: ${entry.message}` };
      },
    });

    const entry1: LogEntry = {
      timestamp: Date.now(),
      type: 'info',
      serviceName: '',
      template: 'Keep original',
      message: 'Keep original',
    };

    const entry2: LogEntry = {
      timestamp: Date.now(),
      type: 'info',
      serviceName: '',
      template: 'Transform this',
      message: 'Transform this',
    };

    sink.write(entry1);
    sink.write(entry2);

    expect(sink.logs[0].message).toBe('Keep original');
    expect(sink.logs[1].message).toBe('Transformed: Transform this');
  });

  test('should allow accessing error object in transformer', () => {
    const sink = new ArraySink({
      transformer: (entry) => {
        if (entry.error) {
          return { ...entry, message: `ERROR with object: ${entry.message}` };
        }
        return entry;
      },
    });

    const error = new Error('Test error');
    const entry: LogEntry = {
      timestamp: Date.now(),
      type: 'error',
      serviceName: '',
      template: 'Error occurred',
      message: 'Error occurred',
      error,
    };

    sink.write(entry);

    expect(sink.logs[0].message).toBe('ERROR with object: Error occurred');
    expect(sink.logs[0].error).toBe(error);
  });
});

describe('ArraySink - redactedParams snapshot', () => {
  function entryWith(redactedParams: Record<string, unknown>): LogEntry {
    return {
      timestamp: Date.now(),
      type: 'info',
      template: 'hi',
      message: 'hi',
      redactedParams,
      redactedKeys: ['user.token'],
    };
  }

  test('a param added after the log call is not readable from the stored entry', () => {
    // The shared-subtree gap `FileSink` closes by rendering in `write()`. `redactedParams`
    // hands back the caller's own nested object wherever nothing under it was masked, so
    // a caller reusing one params object could add the token afterwards and read it back
    // from `logs[i].redactedParams` under a `redactedKeys` path that masked nothing
    // because the key did not exist yet.
    const sink = new ArraySink();
    const user: Record<string, unknown> = { name: 'kev' };

    sink.write(entryWith({ user }));

    user.token = 'topsecret-should-never-be-stored';
    user.name = 'changed';

    const stored = sink.logs[0].redactedParams as Record<
      string,
      Record<string, unknown>
    >;

    expect(stored.user.token).toBeUndefined();
    expect(stored.user.name).toBe('kev');
    expect(stored.user).not.toBe(user);
  });

  test('keeps masked values, nested shape, and the bag itself', () => {
    const sink = new ArraySink();

    sink.write(
      entryWith({
        user: { name: 'kev', token: '******' },
        list: [1, { deep: ['x'] }],
        count: 3,
      }),
    );

    expect(sink.logs[0].redactedParams).toEqual({
      user: { name: 'kev', token: '******' },
      list: [1, { deep: ['x'] }],
      count: 3,
    });
    expect(Array.isArray((sink.logs[0].redactedParams as any).list)).toBe(true);
  });

  test('a Date, an Error, or a class instance is kept by reference, not flattened', () => {
    // The same rule the redaction and rendering walks turn on: these are values, not
    // structure, and copying one either loses its non-enumerable members or reconstructs
    // it wrongly.
    const sink = new ArraySink();
    const when = new Date();
    const failure = new Error('boom');

    class Session {
      public id = 'abc';
    }

    const session = new Session();

    sink.write(entryWith({ when, failure, session }));

    const stored = sink.logs[0].redactedParams as Record<string, unknown>;

    expect(stored.when).toBe(when);
    expect(stored.failure).toBe(failure);
    expect(stored.session).toBe(session);
  });

  test('a cycle resolves to the copy already made rather than recursing forever', () => {
    const sink = new ArraySink();
    const node: Record<string, unknown> = { name: 'root' };

    node.self = node;

    sink.write(entryWith({ node }));

    const stored = sink.logs[0].redactedParams as Record<
      string,
      Record<string, unknown>
    >;

    expect(stored.node).not.toBe(node);
    expect(stored.node.self).toBe(stored.node);
  });

  test('a subtree referenced twice shares one copy', () => {
    // The snapshot only has to stop tracking the caller, not reproduce identity - but
    // where the original was aliased, the copy is too, so a reader sees the same shape.
    const sink = new ArraySink();
    const child = { value: 1 };

    sink.write(entryWith({ left: child, right: child }));

    const stored = sink.logs[0].redactedParams as Record<string, unknown>;

    expect(stored.left).not.toBe(child);
    expect(stored.left).toBe(stored.right);
  });

  test('a throwing accessor is replaced by the marker, and the rest is still copied', () => {
    const sink = new ArraySink();
    const hostile: Record<string, unknown> = { fine: 'ok' };

    Object.defineProperty(hostile, 'bad', {
      enumerable: true,
      get() {
        throw new Error('getter blew up');
      },
    });

    sink.write(entryWith({ hostile, other: 'kept' }));

    const stored = sink.logs[0].redactedParams as Record<string, unknown>;

    expect(stored.other).toBe('kept');
    expect(stored.hostile).toEqual({
      fine: 'ok',
      bad: '<value could not be copied>',
    });
  });

  test('a container whose keys cannot be read is the marker at every reference', () => {
    // Memoized only once it enumerates: a second reference must not come back as the
    // empty copy the first attempt had started before `Object.keys` refused. A live
    // `Proxy` with a throwing `ownKeys` trap, not a revoked one - a revoked proxy fails
    // `isPlainContainer` and is rightly kept by reference as a value.
    const sink = new ArraySink();
    const unenumerable = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('ownKeys refused');
        },
      },
    );

    sink.write(entryWith({ a: unenumerable, b: unenumerable }));

    const stored = sink.logs[0].redactedParams as Record<string, unknown>;

    expect(stored.a).toBe('<value could not be copied>');
    expect(stored.b).toBe('<value could not be copied>');
  });

  test('a revoked Proxy is not structure, so it is kept by reference like any value', () => {
    const sink = new ArraySink();
    const revoked = Proxy.revocable({}, {});

    revoked.revoke();

    sink.write(entryWith({ a: revoked.proxy }));

    expect((sink.logs[0].redactedParams as Record<string, unknown>).a).toBe(
      revoked.proxy,
    );
  });

  test('stops at the render depth with the marker the rendered message uses', () => {
    const sink = new ArraySink();
    const root: Record<string, unknown> = {};
    let cursor = root;

    for (let index = 0; index < MAX_RENDER_DEPTH + 5; index++) {
      const next: Record<string, unknown> = {};

      cursor.next = next;
      cursor = next;
    }

    cursor.leaf = 'bottom';

    sink.write(entryWith(root));

    let stored: unknown = sink.logs[0].redactedParams;
    let depth = 0;

    while (typeof stored === 'object' && stored !== null) {
      stored = (stored as Record<string, unknown>).next;
      depth++;
    }

    expect(stored).toBe(TRUNCATED);
    expect(depth).toBe(MAX_RENDER_DEPTH);
  });

  test('a __proto__ key is stored as an entry rather than reparenting the copy', () => {
    const sink = new ArraySink();
    const bag: Record<string, unknown> = {};

    Object.defineProperty(bag, '__proto__', {
      value: { polluted: true },
      enumerable: true,
      writable: true,
      configurable: true,
    });

    sink.write(entryWith({ bag }));

    const stored = sink.logs[0].redactedParams as Record<
      string,
      Record<string, unknown>
    >;

    expect(Object.getPrototypeOf(stored.bag)).toBe(Object.prototype);
    expect(Object.keys(stored.bag)).toEqual(['__proto__']);
    expect((stored.bag as any).polluted).toBeUndefined();
  });

  test('the transformer is handed the snapshot, so it reads what a later reader will', () => {
    const sink = new ArraySink({
      transformer: (entry) => ({ ...entry, timestamp: 0 }),
    });
    const user: Record<string, unknown> = { name: 'kev' };

    sink.write(entryWith({ user }));

    user.token = 'added-later';

    const stored = sink.logs[0].redactedParams as Record<
      string,
      Record<string, unknown>
    >;

    expect(sink.logs[0].timestamp).toBe(0);
    expect(stored.user.token).toBeUndefined();
  });

  test("params stays the caller's own object by reference", () => {
    // Documented as the escape hatch for a sink that needs the real values, so it is
    // deliberately left alone by the snapshot.
    const sink = new ArraySink();
    const params = { user: { name: 'kev' } };

    sink.write({ ...entryWith({ user: { name: 'kev' } }), params });

    expect(sink.logs[0].params).toBe(params);
  });

  test('an entry without redactedParams is stored as it came', () => {
    const sink = new ArraySink();
    const entry: LogEntry = {
      timestamp: Date.now(),
      type: 'info',
      template: 'hi',
      message: 'hi',
    };

    sink.write(entry);

    expect(sink.logs[0]).toBe(entry);
  });

  test('should report a param it could not copy into the snapshot', () => {
    // Reached by writing the entry directly, which is this sink's own contract: `write`
    // takes a `LogEntry` from wherever one comes from, and nothing requires
    // `redactedParams` to have been through redaction on the way. Under a `Logger` with
    // redaction configured it usually has been, and a hostile getter is already a marker
    // by the time the snapshot runs - which is exactly why this is asserted at the sink
    // rather than end to end.
    const seen: string[] = [];

    const sink = new ArraySink({
      onFormatError: (error, _kind, path) =>
        seen.push(`${path}|${error.message}`),
    });

    const hostile: Record<string, unknown> = { safe: 'kept' };

    Object.defineProperty(hostile, 'token', {
      get() {
        throw new Error('accessor refused: hunter2secret');
      },
      enumerable: true,
    });

    sink.write({
      timestamp: Date.now(),
      type: 'info',
      template: 't',
      message: 'm',
      redactedParams: { user: hostile },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('<params>.user.token');
    expect(seen[0]).toContain('accessor refused');

    // The marker replaces only the value that refused; its readable sibling is kept, and
    // the cause reaches the handler rather than the stored entry.
    const stored = JSON.stringify(sink.logs[0].redactedParams);

    expect(stored).toContain('<value could not be copied>');
    expect(stored).toContain('kept');
    expect(stored).not.toContain('hunter2secret');
  });
});
test('should report a transformer that throws rather than silently ignoring it', () => {
  // Falling through to the original entry is the right recovery - a broken transformer
  // must not cost you the log - but it was also completely silent, so a transformer that
  // threw on every entry looked exactly like one that had chosen to pass every entry
  // through untouched.
  const seen: string[] = [];

  const sink = new ArraySink({
    transformer: () => {
      throw new Error('transformer refused');
    },
    onFormatError: (error, kind, subject) =>
      seen.push(`${kind}|${subject}|${error.message}`),
  });

  sink.write({
    timestamp: Date.now(),
    type: 'info',
    template: 't',
    message: 'm',
  });

  expect(seen).toHaveLength(1);
  // `'transform'`, not `'render'`: the entry was formatted fine and the caller's own
  // transformer is what refused, which is a different thing to fix.
  expect(seen[0]).toContain('transform|<transformer>');
  expect(seen[0]).toContain('transformer refused');

  // Unchanged: the entry is still stored.
  expect(sink.logs.length).toBe(1);
  expect(sink.logs[0]?.message).toBe('m');
});

describe('ArraySink - a self-logging onFormatError cannot recurse', () => {
  // The guard `FileSink` and `NamedPipeSink` hold over a format failure, which this sink
  // lacked. Each `write()` built a fresh reporter, so a handler that logged back into the
  // sink ran the same throwing transformer, reported again, and logged again - a
  // synchronous recursion that stored thousands of entries and ended in a stack overflow.

  const entry = (message: string): LogEntry => ({
    timestamp: Date.now(),
    type: 'info',
    template: message,
    message,
  });

  test('through a throwing transformer', () => {
    let calls = 0;
    let depth = 0;
    let maxDepth = 0;

    const self: { sink?: ArraySink } = {};

    const sink = new ArraySink({
      transformer: () => {
        throw new Error('transformer refused');
      },
      onFormatError: () => {
        calls++;
        depth++;
        maxDepth = Math.max(maxDepth, depth);

        self.sink?.write(entry('the sink failed'));

        depth--;
      },
    });

    self.sink = sink;

    sink.write(entry('first'));

    expect(maxDepth).toBe(1);
    expect(calls).toBe(1);

    // Not vacuous: the handler's own entry is still stored, alongside the one that
    // started this. Only the second diagnosis of the same failure is dropped.
    expect(sink.logs.map((log) => log.message)).toEqual([
      'the sink failed',
      'first',
    ]);
  });

  test('through a param the snapshot cannot copy', () => {
    // The other reporter in `write()`, guarded by the same count: a handler that logs the
    // failure it was handed, with the hostile value still inside it.
    let calls = 0;

    const self: { sink?: ArraySink } = {};

    const hostile: Record<string, unknown> = {};

    Object.defineProperty(hostile, 'token', {
      get() {
        throw new Error('accessor refused');
      },
      enumerable: true,
    });

    const sink = new ArraySink({
      onFormatError: () => {
        calls++;

        self.sink?.write({
          ...entry('the sink failed'),
          redactedParams: { again: hostile },
        });
      },
    });

    self.sink = sink;

    sink.write({ ...entry('first'), redactedParams: { user: hostile } });

    expect(calls).toBe(1);
    expect(sink.logs).toHaveLength(2);
    // Both entries were snapshotted with the marker; neither was lost.
    expect(JSON.stringify(sink.logs[0]?.redactedParams)).toContain(
      '<value could not be copied>',
    );
    expect(JSON.stringify(sink.logs[1]?.redactedParams)).toContain(
      '<value could not be copied>',
    );
  });

  test('holds until an async onFormatError settles, then reports the next real failure', async () => {
    // A flag cleared when the handler returned was cleared at its first `await`, so an
    // `async` handler that logged back after awaiting found no guard and reported again,
    // once per turn of the event loop.
    let calls = 0;

    const self: { sink?: ArraySink } = {};

    const sink = new ArraySink({
      transformer: () => {
        throw new Error('transformer refused');
      },
      // eslint-disable-next-line @typescript-eslint/no-misused-promises -- an async handler is the supported shape under test
      onFormatError: async () => {
        calls++;

        await new Promise((resolve) => setTimeout(resolve, 5));

        self.sink?.write(entry('the sink failed'));
      },
    });

    self.sink = sink;

    sink.write(entry('first'));

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(calls).toBe(1);
    expect(sink.logs.map((log) => log.message)).toEqual([
      'first',
      'the sink failed',
    ]);

    // The guard came down when the handler settled, not before and not never: a later
    // failure that is not nested inside a report is reported on its own account.
    sink.write(entry('second'));

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(calls).toBe(2);
    expect(sink.logs).toHaveLength(4);
  });

  test('a handler that throws releases the guard for the next failure', () => {
    // The throw lands on the console rung, as every reporter promises; what must not
    // happen is the count staying up behind it and the sink going silent thereafter.
    let calls = 0;

    const sink = new ArraySink({
      transformer: () => {
        throw new Error('transformer refused');
      },
      onFormatError: () => {
        calls++;

        throw new Error('handler refused');
      },
    });

    sink.write(entry('first'));
    sink.write(entry('second'));

    expect(calls).toBe(2);
    expect(sink.logs).toHaveLength(2);
  });
});

test("an array's named properties survive the snapshot", () => {
  // The snapshot copied indexes only, so a redaction marker sitting on an array's *named*
  // property - which `maskValueDeep` and `redactPathsInner` both carry, and which the
  // other sinks print - simply vanished on the way into this one. `ArraySink` then held
  // less of the entry than every sink rendering from the same one.
  const sink = new ArraySink();

  const items = Object.assign([1, 2], {
    cursor: 'abc',
    token: '***REDACTED***',
  });

  sink.write({
    timestamp: Date.now(),
    type: 'info',
    template: 't',
    message: 'm',
    redactedParams: { items },
  });

  const stored = sink.logs[0]?.redactedParams?.['items'] as unknown[] & {
    cursor?: string;
    token?: string;
  };

  expect(Array.isArray(stored)).toBe(true);
  expect([...stored]).toEqual([1, 2]);
  expect(stored.cursor).toBe('abc');
  expect(stored.token).toBe('***REDACTED***');

  // Still a copy: the point of the snapshot is that later mutation cannot reach it.
  items.cursor = 'mutated';
  expect(stored.cursor).toBe('abc');
});

test('bounds the snapshot rather than trusting an array that lies about its length', () => {
  // `Array.isArray` is true for a `Proxy` over an array, and `length` is whatever the trap
  // answers. Unbounded, `write()` allocated a slot per claimed element synchronously inside
  // the caller's log call - a two-million claim took roughly half a second, and `2 ** 32 - 1`
  // is minutes of it. The elements themselves are never read here, so the claim alone is the
  // whole cost.
  const liar = new Proxy([1, 2, 3], {
    get(target, key, receiver) {
      if (key === 'length') {
        return 3_000_000_000;
      }

      return Reflect.get(target, key, receiver) as unknown;
    },
  });

  const sink = new ArraySink();
  const startedAt = Date.now();

  sink.write({
    timestamp: Date.now(),
    type: 'info',
    template: 't',
    message: 'm',
    redactedParams: { items: liar },
  });

  const stored = sink.logs[0]?.redactedParams?.['items'] as unknown[];

  expect(Array.isArray(stored)).toBe(true);
  // Bounded, and self-describing: the copy says where it stopped rather than looking like
  // an array that was genuinely that long.
  expect(stored.length).toBeLessThanOrEqual(1_000_001);
  expect(stored[stored.length - 1]).toBe('[max entries exceeded]');
  expect(Date.now() - startedAt).toBeLessThan(10_000);
});

test('spends one allowance across the whole snapshot rather than one per container', () => {
  // A per-container cap is no cap at all: the same total cost splits across any shape the
  // payload likes. Two arrays each claiming the full bound must together cost one bound.
  const claim = (): unknown[] =>
    new Proxy([1], {
      get(target, key, receiver) {
        if (key === 'length') {
          return 2_000_000;
        }

        return Reflect.get(target, key, receiver) as unknown;
      },
    });

  const sink = new ArraySink();

  sink.write({
    timestamp: Date.now(),
    type: 'info',
    template: 't',
    message: 'm',
    redactedParams: { a: claim(), b: claim() },
  });

  const stored = sink.logs[0]?.redactedParams as Record<string, unknown>;
  const first = stored['a'] as unknown[];
  const second = stored['b'] as unknown[] | undefined;
  const total = (first.length ?? 0) + (second?.length ?? 0);

  // The two together, markers included, stay inside the one allowance.
  expect(total).toBeLessThanOrEqual(1_000_003);
  expect(first[first.length - 1]).toBe('[max entries exceeded]');

  // `a` spent the allowance, so `b` never starts: the bag says so under a marker key of
  // its own rather than looking like a params object that only ever had one entry.
  expect(second).toBeUndefined();
  expect(stored['[max entries exceeded]']).toBe('[max entries exceeded]');
});

describe('ArraySink - a then-only thenable from onFormatError', () => {
  const makeEntry = (message: string): LogEntry => ({
    timestamp: Date.now(),
    type: 'info',
    template: message,
    message,
  });

  test('is settled for the reporter and lowers the guard', async () => {
    // `isPromise` accepts anything with a `then`, and the reporter calls `catch` on what
    // the guard returns. Handing the handler's own object back threw `catch is not a
    // function` out of the report; wrapped in a real promise, it settles like any other.
    const captured = muteConsoleError();
    let calls = 0;
    const sink = new ArraySink({
      transformer: () => {
        throw new Error('transformer boom');
      },
      onFormatError: () => {
        calls++;

        return {
          then(onFulfilled: () => void) {
            setTimeout(onFulfilled, 5);
          },
        } as unknown as void;
      },
    });

    try {
      sink.write(makeEntry('first'));
      sink.write(makeEntry('second'));

      await new Promise((resolve) => setTimeout(resolve, 30));

      sink.write(makeEntry('third'));

      // Reported once while the first was pending, and again once it had settled.
      expect(calls).toBe(2);
      expect(sink.logs).toHaveLength(3);
      expect(captured.some((line) => line.includes('is not a function'))).toBe(
        false,
      );
    } finally {
      restoreConsoleError();
    }
  });
});
