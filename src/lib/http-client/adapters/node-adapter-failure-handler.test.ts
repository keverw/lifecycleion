import { expect, spyOn, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import * as http from 'node:http';
import { NodeAdapter } from './node-adapter';
import { REQUEST_BODY_SETTLED_KEY } from '../consts';
import type { AdapterRequest, WritableLike } from '../types';

test.each(['string', 'bytes', 'multipart'] as const)(
  '%s upload whose signal refuses its abort-state read rejects with the refusal',
  async (kind) => {
    const writeFailure = new Error('request end failed');
    const handlerFailure = new Error(
      'signal aborted getter failed during recovery',
    );
    let hasWriteFailed = false;
    const req = Object.assign(new EventEmitter(), {
      destroyed: false,
      setHeader() {},
      write(_data: unknown, callback?: (error: Error | null) => void) {
        callback?.(null);
        return true;
      },
      end() {},
      destroy() {
        this.destroyed = true;
        return this;
      },
    });
    const endSpy = spyOn(req, 'end').mockImplementation(() => {
      hasWriteFailed = true;
      throw writeFailure;
    });
    const requestSpy = spyOn(http, 'request').mockImplementation(
      () => req as unknown as http.ClientRequest,
    );
    const reports: unknown[] = [];
    const onError = (event: Event): void => {
      reports.push((event as ErrorEvent).error);
      event.preventDefault();
    };
    globalThis.addEventListener('error', onError);
    const form = new FormData();
    form.append('field', 'payload');
    try {
      const request: AdapterRequest = {
        requestURL: 'http://example.test/upload',
        method: 'POST',
        headers: {},
        body:
          kind === 'multipart'
            ? form
            : kind === 'bytes'
              ? new TextEncoder().encode('payload')
              : 'payload',
        // The request itself is read once, when `send()` is called, so the throw that
        // reaches the recovery handler comes from the signal's own `aborted`, which a
        // signal that is not a native `AbortSignal` can still refuse at any read.
        signal: {
          get aborted() {
            if (hasWriteFailed) {
              throw handlerFailure;
            }
            return false;
          },
          addEventListener() {},
          removeEventListener() {},
        } as unknown as AbortSignal,
      };
      const pending = new NodeAdapter().send(request);
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        const bounded = Promise.race([
          pending,
          new Promise<never>((_resolve, reject) => {
            deadline = setTimeout(
              () => reject(new Error('Adapter remained pending')),
              200,
            );
          }),
        ]);
        const failure = await bounded.then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(failure).toBe(handlerFailure);
      } finally {
        clearTimeout(deadline);
      }
      // Delivered as the rejection, so not reported on the host channel a second time.
      expect(reports).toHaveLength(0);
      const outcome = Reflect.get(handlerFailure, REQUEST_BODY_SETTLED_KEY);
      expect(outcome).toBeDefined();
      expect(await outcome).toBe(writeFailure);
      expect(req.destroyed).toBe(true);
    } finally {
      globalThis.removeEventListener('error', onError);
      requestSpy.mockRestore();
      endSpy.mockRestore();
    }
  },
  1000,
);

test('an unexpected response-task failure aborts the stream and frees the connection', async () => {
  // Nothing on the response path is meant to throw past its own `catch`, so the failure
  // is injected: the shared-listener registry refuses this writable. That handler only
  // rejected, which left the socket open with the response still streaming in and the
  // factory's signal unfired, so its cleanup listeners never ran.
  let closedResponses = 0;
  const server = http.createServer((_req, res) => {
    res.on('close', () => {
      closedResponses++;
    });
    res.writeHead(200, { 'Content-Length': '1000' });
    res.write('partial');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  // No `off` or `removeListener`, so its listeners go through the shared registry.
  const writable: WritableLike = {
    write: () => true,
    end: () => {},
    on() {
      return this;
    },
    once() {
      return this;
    },
    destroy: () => {},
  };
  const injected = new Error('listener registry refused the writable');
  const originalSet = Object.getOwnPropertyDescriptor(WeakMap.prototype, 'set')
    ?.value as (
    this: WeakMap<WeakKey, unknown>,
    key: WeakKey,
    value: unknown,
  ) => WeakMap<WeakKey, unknown>;
  const setSpy = spyOn(WeakMap.prototype, 'set').mockImplementation(function (
    this: WeakMap<WeakKey, unknown>,
    key: WeakKey,
    value: unknown,
  ) {
    if (key === writable) {
      throw injected;
    }
    return originalSet.call(this, key, value);
  });
  let factorySignal: AbortSignal | undefined;
  try {
    const failure = await new NodeAdapter()
      .send({
        requestURL: `http://127.0.0.1:${port}/slow`,
        method: 'GET',
        headers: {},
        streamResponse: (_info, context) => {
          factorySignal = context.signal;
          return writable;
        },
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(failure).toBe(injected);
    expect(factorySignal?.aborted).toBe(true);
    const deadline = Date.now() + 2000;
    while (closedResponses === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(closedResponses).toBe(1);
  } finally {
    setSpy.mockRestore();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('an early-ack upload whose write fails behind a refusing signal keeps its response and reports once', async () => {
  // The server answers while the body is still going out, and the write then fails with
  // a caller signal that refuses its `aborted` read. That read escaped the write-failure
  // handler, and its recovery then destroyed a request that had already answered and
  // reported the failure as an `AggregateError` on top of the response.
  const writeFailure = new Error('socket reset mid-upload');
  let isSignalRefusing = false;
  let failPendingWrite: ((error: Error) => void) | undefined;
  let respond: ((res: http.IncomingMessage) => void) | undefined;
  const req = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
    setHeader() {},
    getHeaders: () => ({}),
    write(_data: unknown, callback?: (error: Error | null) => void) {
      failPendingWrite = (error) => callback?.(error);
      return true;
    },
    end() {
      this.writableEnded = true;
    },
    destroy() {
      this.destroyed = true;
      return this;
    },
  });
  const requestSpy = spyOn(http, 'request').mockImplementation(((
    _options: unknown,
    callback: (res: http.IncomingMessage) => void,
  ) => {
    respond = callback;
    return req as unknown as http.ClientRequest;
  }) as unknown as typeof http.request);
  const reports: unknown[] = [];
  const onError = (event: Event): void => {
    reports.push((event as ErrorEvent).error);
    event.preventDefault();
  };
  globalThis.addEventListener('error', onError);
  try {
    const pending = new NodeAdapter().send({
      requestURL: 'http://example.test/upload',
      method: 'POST',
      headers: {},
      body: 'payload',
      signal: {
        get aborted() {
          if (isSignalRefusing) {
            throw new Error('aborted getter refused');
          }
          return false;
        },
        addEventListener() {},
        removeEventListener() {},
      } as unknown as AbortSignal,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(failPendingWrite).toBeDefined();

    const res = Object.assign(new EventEmitter(), {
      statusCode: 200,
      headers: { 'content-length': '2' },
      complete: false,
    });
    respond?.(res as unknown as http.IncomingMessage);
    res.emit('data', Buffer.from('ok'));
    res.complete = true;
    res.emit('end');

    const response = await pending;
    expect(response.status).toBe(200);

    isSignalRefusing = true;
    failPendingWrite?.(writeFailure);

    expect(await response.requestBodySettled).toBe(writeFailure);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Reported once, as the write failure it is, and the request left to the grace
    // deadline rather than torn down under a response that may still be arriving.
    expect(reports).toEqual([writeFailure]);
    expect(req.destroyed).toBe(false);
  } finally {
    globalThis.removeEventListener('error', onError);
    requestSpy.mockRestore();
  }
});

test('a response-task recovery that answers and then throws reports only what went undelivered', async () => {
  // The recovery handler rejects with the task's failure, then its teardown throws. The
  // caller has the task's failure, so the host channel is told only about the teardown's,
  // rather than about both again.
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Length': '1000' });
    res.write('partial');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  const writable: WritableLike = {
    write: () => true,
    end: () => {},
    on() {
      return this;
    },
    once() {
      return this;
    },
    destroy: () => {},
  };
  const injected = new Error('listener registry refused the writable');
  const teardownFailure = new Error('destroyed getter refused');
  let isTeardownRefusing = false;
  const originalSet = Object.getOwnPropertyDescriptor(WeakMap.prototype, 'set')
    ?.value as (
    this: WeakMap<WeakKey, unknown>,
    key: WeakKey,
    value: unknown,
  ) => WeakMap<WeakKey, unknown>;
  const setSpy = spyOn(WeakMap.prototype, 'set').mockImplementation(function (
    this: WeakMap<WeakKey, unknown>,
    key: WeakKey,
    value: unknown,
  ) {
    if (key === writable) {
      isTeardownRefusing = true;
      throw injected;
    }
    return originalSet.call(this, key, value);
  });
  const originalRequest = http.request.bind(http) as (
    ...args: unknown[]
  ) => http.ClientRequest;
  const requestSpy = spyOn(http, 'request').mockImplementation(
    (...args: unknown[]) => {
      const created = originalRequest(...args);
      let descriptor: PropertyDescriptor | undefined;
      for (
        let proto = Object.getPrototypeOf(created) as object | null;
        proto && !descriptor?.get;
        proto = Object.getPrototypeOf(proto) as object | null
      ) {
        descriptor = Object.getOwnPropertyDescriptor(proto, 'destroyed');
      }
      const readDestroyed = (target: http.ClientRequest): boolean =>
        Boolean(descriptor?.get?.call(target));
      Object.defineProperty(created, 'destroyed', {
        configurable: true,
        get(this: http.ClientRequest) {
          if (isTeardownRefusing) {
            throw teardownFailure;
          }
          return readDestroyed(this);
        },
        // Node assigns `destroyed` when the socket closes, which can be after this test
        // ends: a getter alone would make that assignment throw out of its close listener.
        set(this: http.ClientRequest, isDestroyed: boolean) {
          descriptor?.set?.call(this, isDestroyed);
        },
      });
      return created;
    },
  );
  const reports: unknown[] = [];
  const onError = (event: Event): void => {
    reports.push((event as ErrorEvent).error);
    event.preventDefault();
  };
  globalThis.addEventListener('error', onError);
  try {
    const failure = await new NodeAdapter()
      .send({
        requestURL: `http://127.0.0.1:${port}/slow`,
        method: 'GET',
        headers: {},
        streamResponse: () => writable,
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(failure).toBe(injected);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reports).toHaveLength(1);
    expect((reports[0] as Error).cause).toBe(teardownFailure);
  } finally {
    isTeardownRefusing = false;
    globalThis.removeEventListener('error', onError);
    setSpy.mockRestore();
    requestSpy.mockRestore();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
