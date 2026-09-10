import { describe, expect, test } from 'bun:test';
import { ArraySink } from './array';
import type { LogEntry } from '../types';
import { MAX_RENDER_DEPTH, TRUNCATED } from '../../internal/render-budget';

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
      onRenderError: (error, path) => seen.push(`${path}|${error.message}`),
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
