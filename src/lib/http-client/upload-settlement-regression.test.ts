import { expect, spyOn, test } from 'bun:test';
import { HTTPClient } from './http-client';
import {
  BUILT_IN_NETWORK_SEND_KEY,
  REQUEST_BODY_SETTLED_KEY,
  UPLOAD_SOURCE_STALL_GRACE_MS,
  UPLOAD_SOURCE_WAIT_LISTENER_KEY,
} from './consts';
import { readUploadSourceWaitListener } from './internal/upload-source-wait';
import type { HTTPRequestBuilder } from './http-request-builder';
import type {
  AdapterRequest,
  AdapterResponse,
  HTTPAdapter,
  HTTPResponse,
} from './types';

test.each([
  ['resolved', 'noop'],
  ['resolved', 'throw'],
  ['rejected', 'noop'],
  ['rejected', 'throw'],
] as const)(
  '%s upload errors with %s then do not gain a second adoption',
  async (mode, behavior) => {
    const failure = new Error('upload failed');
    const source =
      mode === 'resolved'
        ? Promise.resolve<Error | undefined>(failure)
        : Promise.reject<Error | undefined>(failure);
    await source.catch(() => undefined);
    let thenReads = 0;
    Object.defineProperty(failure, 'then', {
      get() {
        thenReads++;
        if (behavior === 'throw') {
          throw new Error('error then must not be read');
        }
        return () => undefined;
      },
    });
    const adapter: HTTPAdapter = {
      getType: () => 'node',
      send: () =>
        Promise.resolve<AdapterResponse>({
          status: 200,
          headers: {},
          body: null,
          requestBodySettled: source,
        }),
    };

    const response = await new HTTPClient({ adapter })
      .put('https://example.com/upload')
      .text('body')
      .send();
    expect(response.status).toBe(200);
    const result = await Promise.race([
      response.requestBodySettled?.then((error) => ({
        message: error?.message,
        cause: error?.cause,
      })),
      new Promise<string>((resolve) =>
        setTimeout(() => resolve('stalled'), 50),
      ),
    ]);
    expect(result).toEqual({ message: 'upload failed', cause: failure });
    expect(thenReads).toBe(0);
  },
);

test('retry invokes an upload settlement thenable once', async () => {
  let attempts = 0;
  let invocations = 0;
  const settled = {
    then(resolve: (value: undefined) => void) {
      invocations++;
      resolve(undefined);
    },
  } as Promise<Error | undefined>;
  const adapter: HTTPAdapter = {
    getType: () => 'node',
    send: () => {
      attempts++;
      return Promise.resolve<AdapterResponse>({
        status: attempts === 1 ? 503 : 200,
        headers: {},
        body: null,
        ...(attempts === 1 ? { requestBodySettled: settled } : {}),
      });
    },
  };

  const response = await new HTTPClient({ adapter })
    .put('https://example.com/upload')
    .text('body')
    .retryPolicy({ strategy: 'fixed', maxRetryAttempts: 1, delayMS: 0 })
    .send();
  expect(response.status).toBe(200);
  expect(attempts).toBe(2);
  expect(invocations).toBe(1);
});

test('redirect invokes an upload settlement thenable once', async () => {
  let attempts = 0;
  let invocations = 0;
  const settled = {
    then(resolve: (value: undefined) => void) {
      invocations++;
      resolve(undefined);
    },
  } as Promise<Error | undefined>;
  const adapter: HTTPAdapter = {
    getType: () => 'node',
    send: () => {
      attempts++;
      return Promise.resolve<AdapterResponse>({
        status: attempts === 1 ? 307 : 200,
        headers: attempts === 1 ? { location: '/next' } : {},
        body: null,
        ...(attempts === 1 ? { requestBodySettled: settled } : {}),
      });
    },
  };

  const response = await new HTTPClient({ adapter, followRedirects: true })
    .put('https://example.com/upload')
    .text('body')
    .send();
  expect(response.status).toBe(200);
  expect(attempts).toBe(2);
  expect(invocations).toBe(1);
});

test('retry invokes a tagged failure settlement thenable once', async () => {
  let attempts = 0;
  let invocations = 0;
  const settled = {
    then(resolve: (value: undefined) => void) {
      invocations++;
      resolve(undefined);
    },
  } as Promise<Error | undefined>;
  const adapter: HTTPAdapter = {
    getType: () => 'node',
    send: () => {
      attempts++;
      if (attempts === 1) {
        const failure = new Error('temporary');
        Object.assign(failure, { [REQUEST_BODY_SETTLED_KEY]: settled });
        return Promise.reject(failure);
      }
      return Promise.resolve<AdapterResponse>({
        status: 200,
        headers: {},
        body: null,
      });
    },
  };

  const response = await new HTTPClient({ adapter })
    .put('https://example.com/upload')
    .text('body')
    .retryPolicy({ strategy: 'fixed', maxRetryAttempts: 1, delayMS: 0 })
    .send();
  expect(response.status).toBe(200);
  expect(attempts).toBe(2);
  expect(invocations).toBe(1);
});

for (const shouldThrow of [false, true]) {
  test(`upload errors with a synthesized then are safe: throws=${String(shouldThrow)}`, async () => {
    const failure = new Error('proxy upload failure');
    const source = Promise.resolve<Error | undefined>(failure);
    Object.setPrototypeOf(
      failure,
      new Proxy(Error.prototype, {
        get(target, key, receiver) {
          if (key === 'then') {
            if (shouldThrow) {
              throw new Error('unreadable synthesized then');
            }
            return () => undefined;
          }
          return Reflect.get(target, key, receiver);
        },
      }),
    );
    const adapter: HTTPAdapter = {
      getType: () => 'node',
      send: () =>
        Promise.resolve({
          status: 200,
          headers: {},
          body: null,
          requestBodySettled: source,
        }),
    };
    const response = await new HTTPClient({ adapter })
      .get('https://example.com/upload')
      .send();
    const outcome = await Promise.race([
      response.requestBodySettled?.then(
        (error) => ({ error }),
        (error: unknown) => ({ rejected: error }),
      ),
      new Promise<string>((resolve) =>
        setTimeout(() => resolve('stalled'), 50),
      ),
    ]);
    expect(outcome).toHaveProperty('error');
    if (typeof outcome === 'object' && outcome !== null && 'error' in outcome) {
      expect(outcome.error?.cause).toBe(failure);
    }
  });
}

test.each(['noop', 'throw'] as const)(
  'a synthesized then that changes after its first lookup cannot %s during publication',
  async (behavior) => {
    let thenReads = 0;
    const failure = new Error('upload failed');
    Object.setPrototypeOf(
      failure,
      new Proxy(Error.prototype, {
        get(target, key, receiver) {
          if (key === 'then') {
            if (++thenReads === 1) {
              return undefined;
            }
            if (behavior === 'throw') {
              throw new Error('second then lookup');
            }
            return () => undefined;
          }
          return Reflect.get(target, key, receiver);
        },
      }),
    );
    const adapter: HTTPAdapter = {
      getType: () => 'node',
      send: () =>
        Promise.resolve({
          status: 200,
          headers: {},
          body: null,
          requestBodySettled: Promise.reject(failure),
        }),
    };
    const response = await new HTTPClient({ adapter })
      .put('https://example.com/upload')
      .text('body')
      .send();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        response.requestBodySettled?.then(
          (error) => ({ message: error?.message, cause: error?.cause }),
          (error: unknown) => ({ rejected: error }),
        ),
        new Promise<string>((resolve) => {
          timer = setTimeout(() => resolve('stalled'), 100);
        }),
      ]);
      expect(outcome).toEqual({ message: 'upload failed', cause: failure });
      expect(thenReads).toBe(0);
    } finally {
      clearTimeout(timer);
    }
  },
);

for (const shape of ['own', 'inherited', 'proxy'] as const) {
  test(`wrapped upload errors retain code and stack: ${shape}`, async () => {
    const failure = new Error('upload failed');
    let codeReads = 0;
    let stackReads = 0;
    Object.defineProperties(failure, {
      code: {
        get() {
          codeReads++;
          return 'ECONNRESET';
        },
      },
      stack: {
        get() {
          stackReads++;
          return 'original upload stack';
        },
      },
    });
    if (shape === 'own') {
      Object.defineProperty(failure, 'then', { value: () => undefined });
    } else {
      const prototype =
        shape === 'inherited'
          ? Object.assign(Object.create(Error.prototype) as object, {
              then: () => undefined,
            })
          : new Proxy(Error.prototype, {
              get(target, key, receiver) {
                return key === 'then'
                  ? () => undefined
                  : Reflect.get(target, key, receiver);
              },
            });
      Object.setPrototypeOf(failure, prototype);
    }
    const source = Promise.reject<Error | undefined>(failure);
    void source.catch(() => undefined);
    const adapter: HTTPAdapter = {
      getType: () => 'node',
      send: () =>
        Promise.resolve({
          status: 200,
          headers: {},
          body: null,
          requestBodySettled: source,
        }),
    };
    const response = await new HTTPClient({ adapter })
      .get('https://example.com/upload')
      .send();
    const outcome = await response.requestBodySettled;
    expect(outcome?.cause).toBe(failure);
    expect(outcome).toHaveProperty('code', 'ECONNRESET');
    expect(outcome?.stack).toBe('original upload stack');
    expect(codeReads).toBe(1);
    expect(stackReads).toBe(1);
  });
}

test('unreadable upload error code and stack do not reject settlement', async () => {
  const failure = new Error('upload failed');
  Object.defineProperties(failure, {
    then: { value: () => undefined },
    code: {
      get() {
        throw new Error('unreadable code');
      },
    },
    stack: {
      get() {
        throw new Error('unreadable stack');
      },
    },
  });
  const source = Promise.reject<Error | undefined>(failure);
  void source.catch(() => undefined);
  const adapter: HTTPAdapter = {
    getType: () => 'node',
    send: () =>
      Promise.resolve({
        status: 200,
        headers: {},
        body: null,
        requestBodySettled: source,
      }),
  };
  const response = await new HTTPClient({ adapter })
    .get('https://example.com/upload')
    .send();
  const outcome = await response.requestBodySettled;
  expect(outcome?.cause).toBe(failure);
  expect(outcome?.message).toBe('upload failed');
  expect(typeof outcome?.stack).toBe('string');
});

for (const isInherited of [false, true]) {
  for (const thenValue of [undefined, null, 0, 'not callable']) {
    test(`non-callable data then on ${isInherited ? 'an unknown prototype' : 'the error itself'} is still wrapped: value=${String(thenValue)}`, async () => {
      class UploadError extends Error {
        public readonly uploadID = 'upload-123';
      }
      const failure = new UploadError('upload failed');
      Object.defineProperty(
        isInherited ? UploadError.prototype : failure,
        'then',
        {
          value: thenValue,
        },
      );
      const source = Promise.reject<Error | undefined>(failure);
      void source.catch(() => undefined);
      const adapter: HTTPAdapter = {
        getType: () => 'node',
        send: () =>
          Promise.resolve({
            status: 200,
            headers: {},
            body: null,
            requestBodySettled: source,
          }),
      };
      const response = await new HTTPClient({ adapter })
        .get('https://example.com/upload')
        .send();
      const outcome = await response.requestBodySettled;
      expect(outcome).not.toBe(failure);
      expect(outcome?.cause).toBe(failure);
      expect(outcome?.message).toBe('upload failed');
      expect(outcome?.cause).toHaveProperty('uploadID', 'upload-123');
    });
  }
}

test.each([
  Error,
  EvalError,
  RangeError,
  ReferenceError,
  SyntaxError,
  TypeError,
  URIError,
])(
  'ordinary %p upload errors are wrapped with the original as cause',
  async (ErrorType) => {
    const failure = new ErrorType('upload failed');
    const adapter: HTTPAdapter = {
      getType: () => 'node',
      send: () =>
        Promise.resolve({
          status: 200,
          headers: {},
          body: null,
          requestBodySettled: Promise.reject(failure),
        }),
    };
    const response = await new HTTPClient({ adapter })
      .get('https://example.com/upload')
      .send();
    expect((await response.requestBodySettled)?.cause).toBe(failure);
  },
);

test.each(['ordinary', 'proxy'] as const)(
  'without Error.isError, %s upload errors are conservatively wrapped',
  async (shape) => {
    // Isolate the missing runtime API from this suite and import after removing it.
    const script = `
    delete Error.isError;
    const { HTTPClient } = await import(${JSON.stringify(`${import.meta.dir}/http-client.ts`)});
    const watchdog = setTimeout(() => process.exit(42), 1000);
    const target = new Error('upload failed');
    Object.defineProperty(target, 'then', { value: undefined, configurable: true });
    let reads = 0;
    const failure = ${JSON.stringify(shape)} === 'ordinary' ? target : new Proxy(target, {
      get(target, key, receiver) {
        if (key === 'then') {
          return ++reads === 1 ? undefined : () => {};
        }
        return Reflect.get(target, key, receiver);
      },
    });
    const adapter = {
      getType: () => 'node',
      send: () => Promise.resolve({
        status: 200, headers: {}, body: null,
        requestBodySettled: Promise.reject(failure),
      }),
    };
    const response = await new HTTPClient({ adapter }).get('https://example.com/upload').send();
    const error = await response.requestBodySettled;
    clearTimeout(watchdog);
    process.stdout.write(JSON.stringify({ message: error?.message, wrapped: error?.cause === failure, reads }));
  `;
    const child = Bun.spawn([process.execPath, '--eval', script], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
    expect(JSON.parse(stdout)).toEqual({
      message: 'upload failed',
      wrapped: true,
      reads: 0,
    });
  },
);

for (const isAccessor of [false, true]) {
  test(`uncertain then still requires upload error wrapper: accessor=${isAccessor}`, async () => {
    let reads = 0;
    const target = new Error('upload failed');
    if (isAccessor) {
      Object.defineProperty(target, 'then', {
        get() {
          reads++;
          return reads === 1 ? undefined : () => undefined;
        },
      });
    } else {
      Object.defineProperty(target, 'then', {
        value: undefined,
        configurable: true,
      });
    }
    const failure = isAccessor
      ? target
      : new Proxy(target, {
          get(object, key, receiver) {
            if (key === 'then') {
              reads++;
              return () => undefined;
            }
            return Reflect.get(object, key, receiver);
          },
        });
    const source = Promise.reject<Error | undefined>(failure);
    void source.catch(() => undefined);
    const adapter: HTTPAdapter = {
      getType: () => 'node',
      send: () =>
        Promise.resolve({
          status: 200,
          headers: {},
          body: null,
          requestBodySettled: source,
        }),
    };
    const response = await new HTTPClient({ adapter })
      .get('https://example.com/upload')
      .send();
    const outcome = await response.requestBodySettled;
    expect(outcome).not.toBe(failure);
    expect(outcome?.cause).toBe(failure);
    // Accessors are not evaluated just to decide whether another evaluation is safe.
    if (isAccessor) {
      expect(reads).toBe(0);
    }
  });
}

test('redirect and final observers share the already-adopted upload outcome', async () => {
  let attempts = 0;
  let adoptions = 0;
  const source = {
    then(resolve: (value: undefined) => void) {
      adoptions++;
      resolve(undefined);
    },
  } as Promise<Error | undefined>;
  const adapter: HTTPAdapter = {
    getType: () => 'node',
    send: () =>
      Promise.resolve<AdapterResponse>(
        ++attempts === 1
          ? {
              status: 302,
              headers: { location: '/done' },
              body: null,
              requestBodySettled: source,
            }
          : { status: 200, headers: {}, body: null },
      ),
  };
  const client = new HTTPClient({ adapter, followRedirects: true });
  const seen: Array<Promise<Error | undefined> | undefined> = [];
  client.addResponseObserver(
    (response) => {
      seen.push(response.requestBodySettled);
    },
    { phases: ['redirect', 'final'] },
  );
  const response = await client
    .post('https://example.com/upload')
    .text('body')
    .send();
  expect(response.status).toBe(200);
  expect(seen).toHaveLength(2);
  expect(seen[0]).toBeDefined();
  expect(seen[0]).toBe(seen[1]);
  expect(response.requestBodySettled).toBe(seen[0]);
  expect(await response.requestBodySettled).toBeUndefined();
  expect(adoptions).toBe(1);
});

test.each([
  [
    'a rejected promise',
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the hostile adapter value under test
    () => Promise.reject<Error | undefined>(undefined),
  ],
  [
    'a foreign thenable',
    () =>
      ({
        then(_resolve: unknown, reject: (reason: unknown) => void) {
          reject(undefined);
        },
      }) as Promise<Error | undefined>,
  ],
] as const)(
  'an upload settlement rejected with undefined from %s reports an Error, not completion',
  async (_label, makeSource) => {
    const source = makeSource();

    if (source instanceof Promise) {
      source.catch(() => undefined);
    }

    const adapter: HTTPAdapter = {
      getType: () => 'node',
      send: () =>
        Promise.resolve<AdapterResponse>({
          status: 200,
          headers: {},
          body: null,
          requestBodySettled: source,
        }),
    };

    const response = await new HTTPClient({ adapter })
      .put('https://example.com/upload')
      .text('body')
      .send();
    expect(response.status).toBe(200);
    const outcome = await response.requestBodySettled;
    // `undefined` is the documented value for a completed upload; a rejection is a
    // failure whatever its reason.
    expect(outcome).toBeInstanceOf(Error);
  },
);

test.each([
  ['an Error', new Error('upload failed')],
  ['a non-Error value', 'upload failed'],
] as const)(
  'an upload outcome from %s carries no own then',
  async (_label, failure) => {
    // `serializeError` walks `getOwnPropertyNames`, so an own `then` would reach its output.
    const adapter: HTTPAdapter = {
      getType: () => 'node',
      send: () =>
        Promise.resolve({
          status: 200,
          headers: {},
          body: null,
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          requestBodySettled: Promise.reject(failure),
        }),
    };
    const response = await new HTTPClient({ adapter })
      .get('https://example.com/upload')
      .send();
    const outcome = await response.requestBodySettled;
    expect(outcome).toBeInstanceOf(Error);
    expect(Object.getOwnPropertyNames(outcome)).not.toContain('then');
  },
);

/** A one-entry form, the only body the client hands a source-wait listener with. */
function formBody(): FormData {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(8)]), 'f.bin');

  return form;
}

for (const staleWait of ['left open', 'reported late'] as const) {
  test(`a source wait an earlier attempt ${staleWait === 'left open' ? 'left open' : 'reports late'} does not hold the next attempt's upload wait`, async () => {
    // While the adapter says its writer is waiting on its source, the wait before the next
    // dispatch does not count the time as silence. That is the latest attempt's writer
    // only: the first attempt's says it is waiting - and never says it is done, as a writer
    // whose outcome the watchdog settled need not, or says it again once the next attempt
    // is out - and the second attempt's upload, which never settles, must still time out.
    let attempts = 0;
    let firstRequest: AdapterRequest | undefined;
    let didHaveListener = false;
    const reports: ErrorEvent[] = [];
    const onGlobalError = (event: Event): void => {
      reports.push(event as ErrorEvent);
      event.preventDefault();
    };
    const adapter: HTTPAdapter = {
      getType: () => 'node',
      send: (request: AdapterRequest): Promise<AdapterResponse> => {
        attempts++;

        if (attempts === 1) {
          firstRequest = request;
          didHaveListener = readUploadSourceWaitListener(request) !== undefined;

          if (staleWait === 'left open') {
            readUploadSourceWaitListener(request)?.(true);
          }

          return Promise.resolve({
            status: 503,
            headers: {},
            body: null,
            requestBodySettled: Promise.resolve(undefined),
          });
        }

        if (staleWait === 'reported late' && firstRequest !== undefined) {
          readUploadSourceWaitListener(firstRequest)?.(true);
        }

        return Promise.resolve({
          status: 503,
          headers: {},
          body: null,
          requestBodySettled: new Promise<Error | undefined>(() => {}),
        });
      },
    };

    globalThis.addEventListener('error', onGlobalError);
    try {
      const response = await orHung(
        new HTTPClient({ adapter, timeout: 50 })
          .put('https://example.com/upload')
          .formData(formBody())
          .retryPolicy({ strategy: 'fixed', maxRetryAttempts: 2, delayMS: 1 }),
        1_000,
      );

      expect(didHaveListener).toBe(true);
      expect(response).not.toBe('hung');
      expect(attempts).toBe(2);
      expect(response !== 'hung' && response.isTimeout).toBe(true);
      expect(reports).toHaveLength(1);
    } finally {
      globalThis.removeEventListener('error', onGlobalError);
    }
  });
}

/**
 * Runs `fn` with `performance.now()` answering `offsetMS()` past the real clock, so a grace
 * measured on it can be moved past rather than waited out.
 */
async function withClockOffset<T>(
  offsetMS: () => number,
  fn: () => Promise<T>,
): Promise<T> {
  const realNow = performance.now.bind(performance);
  const nowSpy = spyOn(performance, 'now').mockImplementation(
    () => realNow() + offsetMS(),
  );

  try {
    return await fn();
  } finally {
    nowSpy.mockRestore();
  }
}

/** Collects the host `'error'` reports `fn` causes, and keeps them off the console. */
async function withHostReports<T>(
  fn: (reports: ErrorEvent[]) => Promise<T>,
): Promise<T> {
  const reports: ErrorEvent[] = [];
  const onGlobalError = (event: Event): void => {
    reports.push(event as ErrorEvent);
    event.preventDefault();
  };

  globalThis.addEventListener('error', onGlobalError);
  try {
    return await fn(reports);
  } finally {
    globalThis.removeEventListener('error', onGlobalError);
  }
}

/**
 * Sends `builder`'s request: its response, or `'hung'` if it has not settled within `ms`.
 * A request given up on is cancelled, and settled, before this returns, so it cannot time
 * out later and report into the next test's host reports.
 */
async function orHung(
  builder: HTTPRequestBuilder,
  ms: number,
): Promise<HTTPResponse | 'hung'> {
  const sent = builder.send();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    sent,
    new Promise<'hung'>((resolve) => {
      timer = setTimeout(() => resolve('hung'), ms);
    }),
  ]);

  clearTimeout(timer);

  if (result === 'hung') {
    builder.cancel('gave up on a hung request');
    await sent;
  }

  return result;
}

for (const shape of ['one wait', 'empty reads'] as const) {
  test(`an adapter whose source never moves the upload still has its wait end: ${shape}`, async () => {
    // A source wait counts as activity for no longer than the grace `NodeAdapter` gives
    // one itself, so the client's bound does not rest on an adapter's word. That grace runs
    // from the first wait since the upload last made progress: one wait that never ends,
    // and a source whose reads keep coming back with nothing - waits that end with no
    // progress between them - both time out once the grace and the stall bound have run
    // out, the outcome never settling. The clock is moved past the grace rather than
    // waited out.
    let attempts = 0;
    let didHaveListener = false;
    let clockOffsetMS = 0;
    const timers: Array<ReturnType<typeof setInterval>> = [];
    const adapter: HTTPAdapter = {
      getType: () => 'node',
      send: (request: AdapterRequest): Promise<AdapterResponse> => {
        attempts++;
        const listener = readUploadSourceWaitListener(request);
        didHaveListener = listener !== undefined;
        listener?.(true);

        // Past the grace a little after the first wait has begun - between a wait's end
        // and the next one's start for the empty reads, so no look at the clock falls
        // between the move and the reports around it.
        let reads = 0;
        timers.push(
          setInterval(() => {
            reads++;
            if (shape === 'one wait') {
              if (reads === 15) {
                clockOffsetMS = UPLOAD_SOURCE_STALL_GRACE_MS + 1_000;
              }

              return;
            }

            listener?.(false);
            if (reads === 15) {
              clockOffsetMS = UPLOAD_SOURCE_STALL_GRACE_MS + 1_000;
            }
            listener?.(true);
          }, 10),
        );

        return Promise.resolve({
          status: 503,
          headers: {},
          body: null,
          requestBodySettled: new Promise<Error | undefined>(() => {}),
        });
      },
    };

    try {
      await withClockOffset(
        () => clockOffsetMS,
        async () =>
          await withHostReports(async (reports) => {
            const response = await orHung(
              new HTTPClient({ adapter, timeout: 50 })
                .put('https://example.com/upload')
                .formData(formBody())
                .retryPolicy({
                  strategy: 'fixed',
                  maxRetryAttempts: 1,
                  delayMS: 1,
                }),
              1_000,
            );

            expect(didHaveListener).toBe(true);
            expect(response).not.toBe('hung');
            expect(attempts).toBe(1);
            expect(response !== 'hung' && response.isTimeout).toBe(true);
            expect(reports).toHaveLength(1);
          }),
      );
    } finally {
      for (const timer of timers) {
        clearInterval(timer);
      }
    }
  });
}

test('upload progress counts while the adapter says it is waiting on its source, past the grace too', async () => {
  // Progress is activity whatever else the adapter has said: an upload that reports
  // progress throughout a source wait running past the grace is still moving, and the
  // retry goes out once it settles.
  let attempts = 0;
  let clockOffsetMS = 0;
  let progressTimer: ReturnType<typeof setInterval> | undefined;
  const adapter: HTTPAdapter = {
    getType: () => 'node',
    send: (request: AdapterRequest): Promise<AdapterResponse> => {
      attempts++;

      if (attempts > 1) {
        return Promise.resolve({ status: 200, headers: {}, body: null });
      }

      readUploadSourceWaitListener(request)?.(true);
      let loaded = 0;
      progressTimer = setInterval(() => {
        loaded++;
        // Past the grace, a few reports in - moved in the same turn as a report, so no
        // look at the clock falls between the two.
        if (loaded === 5) {
          clockOffsetMS = UPLOAD_SOURCE_STALL_GRACE_MS + 1_000;
        }
        request.onUploadProgress?.({ loaded, total: 1_000, progress: -1 });
      }, 10);

      return Promise.resolve({
        status: 503,
        headers: {},
        body: null,
        requestBodySettled: new Promise<Error | undefined>((resolve) => {
          setTimeout(() => {
            clearInterval(progressTimer);
            resolve(undefined);
          }, 300);
        }),
      });
    },
  };

  try {
    await withClockOffset(
      () => clockOffsetMS,
      async () =>
        await withHostReports(async (reports) => {
          const response = await new HTTPClient({ adapter, timeout: 50 })
            .put('https://example.com/upload')
            .formData(formBody())
            .retryPolicy({ strategy: 'fixed', maxRetryAttempts: 1, delayMS: 1 })
            .send();

          expect(response.isTimeout).toBe(false);
          expect(response.status).toBe(200);
          expect(attempts).toBe(2);
          expect(reports).toHaveLength(0);
        }),
    );
  } finally {
    clearInterval(progressTimer);
  }
});

test('slow source reads that each return bytes add up past the grace without the upload being cut', async () => {
  // The grace a source wait counts within runs from the first wait since the upload last
  // made progress, and progress ends that run. An upload of many slow reads, each
  // answering with bytes the adapter reports as progress, is still moving however long
  // the reads add up to: each read is a wait of its own, longer than the stall bound and
  // counted as activity, and the retry goes out once the upload settles. Each read is
  // moved twenty seconds on the clock as it answers - five of them, past the grace.
  let attempts = 0;
  let clockOffsetMS = 0;
  const adapter: HTTPAdapter = {
    getType: () => 'node',
    send: (request: AdapterRequest): Promise<AdapterResponse> => {
      attempts++;

      if (attempts > 1) {
        return Promise.resolve({ status: 200, headers: {}, body: null });
      }

      const listener = readUploadSourceWaitListener(request);

      return Promise.resolve({
        status: 503,
        headers: {},
        body: null,
        requestBodySettled: (async (): Promise<Error | undefined> => {
          for (let read = 1; read <= 5; read++) {
            listener?.(true);
            // Longer than the stall bound, in real time.
            await new Promise((resolve) => setTimeout(resolve, 120));
            clockOffsetMS += 20_000;
            listener?.(false);
            request.onUploadProgress?.({
              loaded: read,
              total: 5,
              progress: read / 5,
            });
          }

          return undefined;
        })(),
      });
    },
  };

  await withClockOffset(
    () => clockOffsetMS,
    async () =>
      await withHostReports(async (reports) => {
        const response = await new HTTPClient({ adapter, timeout: 50 })
          .put('https://example.com/upload')
          .formData(formBody())
          .retryPolicy({ strategy: 'fixed', maxRetryAttempts: 1, delayMS: 1 })
          .send();

        expect(clockOffsetMS).toBeGreaterThan(UPLOAD_SOURCE_STALL_GRACE_MS);
        expect(response.isTimeout).toBe(false);
        expect(response.status).toBe(200);
        expect(attempts).toBe(2);
        expect(reports).toHaveLength(0);
      }),
  );
});

test('progress reported while the adapter is still waiting on its source starts the wait over', async () => {
  // Progress reported during a source wait - with no end of the wait between - is
  // activity, and the wait goes on from there as a new one, not as silence: the retry
  // goes out once the upload settles, the wait having outlasted the stall bound after
  // the report.
  let attempts = 0;
  const adapter: HTTPAdapter = {
    getType: () => 'node',
    send: (request: AdapterRequest): Promise<AdapterResponse> => {
      attempts++;

      if (attempts > 1) {
        return Promise.resolve({ status: 200, headers: {}, body: null });
      }

      const listener = readUploadSourceWaitListener(request);

      return Promise.resolve({
        status: 503,
        headers: {},
        body: null,
        requestBodySettled: (async (): Promise<Error | undefined> => {
          listener?.(true);
          await new Promise((resolve) => setTimeout(resolve, 20));
          request.onUploadProgress?.({ loaded: 1, total: 2, progress: 0.5 });
          // Still waiting, for longer than the stall bound.
          await new Promise((resolve) => setTimeout(resolve, 300));
          listener?.(false);

          return undefined;
        })(),
      });
    },
  };

  await withHostReports(async (reports) => {
    const response = await new HTTPClient({ adapter, timeout: 50 })
      .put('https://example.com/upload')
      .formData(formBody())
      .retryPolicy({ strategy: 'fixed', maxRetryAttempts: 1, delayMS: 1 })
      .send();

    expect(response.isTimeout).toBe(false);
    expect(response.status).toBe(200);
    expect(attempts).toBe(2);
    expect(reports).toHaveLength(0);
  });
});

test("an earlier attempt's late upload progress does not keep the next attempt's upload wait open", async () => {
  // The wait before a dispatch watches the latest attempt's upload. An earlier attempt's
  // adapter still reporting progress on its own hook once the next attempt is out - a
  // custom adapter whose first upload goes on - is that upload's, not the next one's, and
  // the next one's outcome, which never settles, must still time out.
  let attempts = 0;
  let firstRequest: AdapterRequest | undefined;
  let progressTimer: ReturnType<typeof setInterval> | undefined;
  const adapter: HTTPAdapter = {
    getType: () => 'node',
    send: (request: AdapterRequest): Promise<AdapterResponse> => {
      attempts++;

      if (attempts === 1) {
        firstRequest = request;

        return Promise.resolve({
          status: 503,
          headers: {},
          body: null,
          requestBodySettled: Promise.resolve(undefined),
        });
      }

      let loaded = 0;
      progressTimer = setInterval(() => {
        loaded++;
        firstRequest?.onUploadProgress?.({
          loaded,
          total: 1_000,
          progress: -1,
        });
      }, 10);

      return Promise.resolve({
        status: 503,
        headers: {},
        body: null,
        requestBodySettled: new Promise<Error | undefined>(() => {}),
      });
    },
  };

  try {
    await withHostReports(async (reports) => {
      const response = await orHung(
        new HTTPClient({ adapter, timeout: 50 })
          .put('https://example.com/upload')
          .text('body')
          .retryPolicy({ strategy: 'fixed', maxRetryAttempts: 2, delayMS: 1 }),
        1_000,
      );

      expect(response).not.toBe('hung');
      expect(attempts).toBe(2);
      expect(response !== 'hung' && response.isTimeout).toBe(true);
      expect(reports).toHaveLength(1);
    });
  } finally {
    clearInterval(progressTimer);
  }
});

test('the wait after a thrown attempt leaves an upload waiting on its source alone', async () => {
  // The retry after an attempt that threw waits on the outcome tagged on the error, as
  // the retry after an answered one waits on the response's. A source wait the adapter
  // reports in that time is not silence there either: the retry goes out once the upload
  // settles, rather than the request failing as a timeout.
  let attempts = 0;
  const adapter: HTTPAdapter = {
    getType: () => 'node',
    send: (request: AdapterRequest): Promise<AdapterResponse> => {
      attempts++;

      if (attempts > 1) {
        return Promise.resolve({ status: 200, headers: {}, body: null });
      }

      const listener = readUploadSourceWaitListener(request);
      listener?.(true);

      return Promise.reject(
        Object.assign(new Error('connection reset'), {
          [REQUEST_BODY_SETTLED_KEY]: new Promise<Error | undefined>(
            (resolve) => {
              setTimeout(() => {
                listener?.(false);
                resolve(undefined);
              }, 300);
            },
          ),
        }),
      );
    },
  };

  await withHostReports(async (reports) => {
    const response = await new HTTPClient({ adapter, timeout: 50 })
      .put('https://example.com/upload')
      .formData(formBody())
      .retryPolicy({ strategy: 'fixed', maxRetryAttempts: 1, delayMS: 1 })
      .send();

    expect(response.isTimeout).toBe(false);
    expect(response.status).toBe(200);
    expect(attempts).toBe(2);
    expect(reports).toHaveLength(0);
  });
});

test('the client hands a source-wait listener with a form body only', async () => {
  const seen: boolean[] = [];
  const adapter: HTTPAdapter = {
    getType: () => 'node',
    send: (request: AdapterRequest): Promise<AdapterResponse> => {
      seen.push(readUploadSourceWaitListener(request) !== undefined);

      return Promise.resolve({ status: 200, headers: {}, body: null });
    },
  };
  const client = new HTTPClient({ adapter });

  await client.put('https://example.com/upload').text('body').send();
  await client.put('https://example.com/upload').formData(formBody()).send();

  expect(seen).toEqual([false, true]);
});

test('the marks shared between the client and the adapters are global-registry symbols', () => {
  // The client and each adapter are separate entry points, each bundled with its own copy
  // of the modules that set and read these marks: only a `Symbol.for` key is the same key
  // in both copies.
  expect(Symbol.keyFor(BUILT_IN_NETWORK_SEND_KEY)).toBeString();
  expect(Symbol.keyFor(UPLOAD_SOURCE_WAIT_LISTENER_KEY)).toBeString();
});
