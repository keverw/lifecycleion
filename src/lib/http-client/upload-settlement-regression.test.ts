import { expect, test } from 'bun:test';
import { HTTPClient } from './http-client';
import { REQUEST_BODY_SETTLED_KEY } from './consts';
import type { AdapterResponse, HTTPAdapter } from './types';

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
