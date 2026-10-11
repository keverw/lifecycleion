import { expect, spyOn, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import * as http from 'node:http';
import { NodeAdapter } from './node-adapter';
import type { AdapterRequest, WritableLike } from '../types';

test.each(['string', 'bytes', 'multipart'] as const)(
  '%s upload whose signal refuses its abort-state read fails with the write error',
  async (kind) => {
    // The refusal reads as "not aborted", so the write failure - the real one - answers
    // the request and `requestBodySettled`, rather than the getter's error standing in
    // for it.
    const writeFailure = new Error('request end failed');
    let hasWriteFailed = false;
    const req = Object.assign(new EventEmitter(), {
      destroyed: false,
      setHeader() {},
      getHeaders: () => ({}),
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
        // The request itself is read once, when `send()` is called, so the throw comes
        // from the signal's own `aborted`, which a signal that is not a native
        // `AbortSignal` can still refuse at any read.
        signal: {
          get aborted() {
            if (hasWriteFailed) {
              throw new Error('signal aborted getter refused');
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
        const response = await Promise.race([
          pending,
          new Promise<never>((_resolve, reject) => {
            deadline = setTimeout(
              () => reject(new Error('Adapter remained pending')),
              200,
            );
          }),
        ]);
        expect(response.status).toBe(0);
        expect(response.isTransportError).toBe(true);
        expect(response.errorCause).toBe(writeFailure);
        expect(await response.requestBodySettled).toBe(writeFailure);
      } finally {
        clearTimeout(deadline);
      }
      expect(reports).toHaveLength(0);
      expect(req.destroyed).toBe(true);
    } finally {
      globalThis.removeEventListener('error', onError);
      requestSpy.mockRestore();
      endSpy.mockRestore();
    }
  },
  1000,
);

test('a socket error before a response behind a refusing signal fails with the socket error', async () => {
  // The request `'error'` handler reads the signal guarded; a refusal reads as "not
  // aborted", so the reset itself answers the request and `requestBodySettled`.
  const reset = Object.assign(new Error('read ECONNRESET'), {
    code: 'ECONNRESET',
  });
  let isSignalRefusing = false;
  const req = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
    setHeader() {},
    getHeaders: () => ({}),
    // Never calls back: the upload is still going out when the socket resets.
    write() {
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
  const requestSpy = spyOn(http, 'request').mockImplementation(
    () => req as unknown as http.ClientRequest,
  );
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

    isSignalRefusing = true;
    req.emit('error', reset);

    const response = await pending;
    expect(response.status).toBe(0);
    expect(response.isTransportError).toBe(true);
    expect(response.errorCause).toBe(reset);
    expect(await response.requestBodySettled).toBe(reset);
  } finally {
    requestSpy.mockRestore();
  }
});

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

test('a socket error after an early ack behind a refusing signal settles the upload with the socket error', async () => {
  // The request `'error'` handler failed the request with the signal's refusal whatever
  // had happened, while the write-failure handler reads the same refusal as "not aborted"
  // once a response has arrived. With a `200` already in hand that reject was a no-op,
  // but it still answered `requestBodySettled` with the getter's error instead of the
  // reset that actually cut the upload short, and the reset itself went unreported.
  const reset = Object.assign(new Error('read ECONNRESET'), {
    code: 'ECONNRESET',
  });
  let isSignalRefusing = false;
  let respond: ((res: http.IncomingMessage) => void) | undefined;
  const req = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
    setHeader() {},
    getHeaders: () => ({}),
    // Never calls back: the upload is still going out when the socket resets.
    write() {
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
    req.emit('error', reset);

    expect(await response.requestBodySettled).toBe(reset);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reports).toEqual([reset]);
  } finally {
    globalThis.removeEventListener('error', onError);
    requestSpy.mockRestore();
  }
});

test('a socket error during streamResponse setup behind a refusing signal still aborts the factory', async () => {
  // An async factory is still setting up its sink on a `200` when the socket resets, and
  // the caller's signal refuses its `aborted` read by then. The request `'error'` handler
  // rejected with the refusal and returned, skipping the setup-window handler: the
  // factory's signal never fired, so its cleanup never ran, and the request failed with
  // the getter's error rather than settling as the stream failure it was.
  const reset = Object.assign(new Error('read ECONNRESET'), {
    code: 'ECONNRESET',
  });
  let isSignalRefusing = false;
  let respond: ((res: http.IncomingMessage) => void) | undefined;
  let factorySignal: AbortSignal | undefined;
  const req = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
    setHeader() {},
    getHeaders: () => ({}),
    write() {
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
  try {
    const pending = new NodeAdapter().send({
      requestURL: 'http://example.test/download',
      method: 'GET',
      headers: {},
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
      streamResponse: (_info, context) => {
        factorySignal = context.signal;

        // Never settles: the factory is still setting up when the socket goes.
        return new Promise<WritableLike>(() => {});
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    const res = Object.assign(new EventEmitter(), {
      statusCode: 200,
      headers: { 'content-length': '2' },
      complete: false,
    });
    respond?.(res as unknown as http.IncomingMessage);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(factorySignal).toBeDefined();

    isSignalRefusing = true;
    req.emit('error', reset);

    const response = await pending;
    expect(response.status).toBe(200);
    expect(response.isStreamError).toBe(true);
    expect(response.errorCause).toBe(reset);
    expect(factorySignal?.aborted).toBe(true);
  } finally {
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

test('a response task that fails after an early-ack stream setup was answered reports without settling the upload', async () => {
  // The response closing during an async factory's setup answers the request as a
  // stream failure while the body is still going out. The factory then rejects on its
  // aborted signal, and tagging that rejection reads the request's headers again - where
  // a `getHeaders` that now refuses throws out of the task. The request was already
  // answered, so that failure goes to the host channel and nowhere else: not into
  // `requestBodySettled`, which belongs to the writer still running, and not into an
  // early release of the abort listener that writer still needs.
  const refusal = new Error('getHeaders refused');
  const writeFailure = new Error('socket reset mid-upload');
  let isHeaderRefusing = false;
  let failPendingWrite: ((error: Error) => void) | undefined;
  let respond: ((res: http.IncomingMessage) => void) | undefined;
  const req = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
    setHeader() {},
    getHeaders: () => {
      if (isHeaderRefusing) {
        throw refusal;
      }
      return {};
    },
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
  const abortListeners = new Set<unknown>();
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
      headers: { 'x-trace': 'trace-1' },
      body: 'payload',
      signal: {
        aborted: false,
        addEventListener(_type: string, listener: unknown) {
          abortListeners.add(listener);
        },
        removeEventListener(_type: string, listener: unknown) {
          abortListeners.delete(listener);
        },
      } as unknown as AbortSignal,
      streamResponse: (_info, context) =>
        // A sink that is still opening, and gives up when its signal fires.
        new Promise<WritableLike>((_resolve, reject) => {
          context.signal.addEventListener('abort', () => {
            reject(new Error('sink open aborted'));
          });
        }),
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(failPendingWrite).toBeDefined();

    const res = Object.assign(new EventEmitter(), {
      statusCode: 200,
      headers: { 'content-length': '2' },
      complete: false,
    });
    respond?.(res as unknown as http.IncomingMessage);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Answers the request synchronously, without reaching the writer; the factory's
    // rejection is handled on a later microtask, by which point the header refuses.
    res.emit('aborted');
    isHeaderRefusing = true;

    const response = await pending;
    expect(response.status).toBe(200);
    expect(response.isStreamError).toBe(true);
    expect(response.errorCause?.message).toBe(
      'Response stream closed during setup',
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(reports).toHaveLength(1);
    expect((reports[0] as Error).message).toBe(
      'Error in a callback NodeAdapter response task',
    );
    expect((reports[0] as Error).cause).toBe(refusal);

    // The writer is still running, so its outcome is open and the abort listener stays.
    const bodySettled = response.requestBodySettled?.then((value) => ({
      value,
    }));
    expect(
      await Promise.race([
        bodySettled,
        new Promise((resolve) => setTimeout(() => resolve('pending'), 0)),
      ]),
    ).toBe('pending');
    expect(abortListeners.size).toBeGreaterThan(0);

    isHeaderRefusing = false;
    failPendingWrite?.(writeFailure);

    expect(await bodySettled).toEqual({ value: writeFailure });
    expect(abortListeners.size).toBe(0);
    expect(reports).toHaveLength(2);
    expect(reports[1]).toBe(writeFailure);
  } finally {
    isHeaderRefusing = false;
    globalThis.removeEventListener('error', onError);
    requestSpy.mockRestore();
  }
});
