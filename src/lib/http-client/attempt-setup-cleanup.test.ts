import { expect, spyOn, test } from 'bun:test';
import { HTTPClient } from './http-client';
import type { AdapterResponse, AttemptEndEvent, HTTPAdapter } from './types';

test.each(['bigint', 'circular', 'toJSON'] as const)(
  'failed %s serialization clears the attempt timer and ends the attempt',
  async (kind) => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const body =
      kind === 'bigint'
        ? { value: 1n }
        : kind === 'circular'
          ? circular
          : {
              toJSON() {
                throw new Error('serialization failed');
              },
            };
    let sends = 0;
    const adapter: HTTPAdapter = {
      getType: () => 'node',
      send: () => {
        sends++;
        return Promise.resolve({ status: 200, headers: {}, body: null });
      },
    };
    const timeoutMS = 12_345;
    const timer = spyOn(globalThis, 'setTimeout');
    const clear = spyOn(globalThis, 'clearTimeout');
    const starts: number[] = [];
    const ends: AttemptEndEvent[] = [];
    try {
      const request = new HTTPClient({ adapter })
        .put('https://example.com/')
        .json(body)
        .timeout(timeoutMS)
        .onAttemptStart((event) => {
          starts.push(event.attemptNumber);
        })
        .onAttemptEnd((event) => {
          ends.push(event);
        });
      const response = await request.send();
      expect(request.error?.code).toBe('request_setup_error');
      expect(response.isNetworkError).toBe(false);
      expect(response.isTimeout).toBe(false);
      expect(sends).toBe(0);
      expect(starts).toEqual([1]);
      expect(request.attemptCount).toBe(1);
      // Attempt setup fails after the attempt began, so its start time is recorded.
      expect(request.startedAt).not.toBeNull();
      const attemptTimerIndex = timer.mock.calls.findIndex(
        (call) => call[1] === timeoutMS,
      );
      expect(attemptTimerIndex).toBeGreaterThanOrEqual(0);
      expect(clear).toHaveBeenCalledWith(
        timer.mock.results[attemptTimerIndex].value,
      );
      expect(ends).toMatchObject([
        { attemptNumber: 1, status: 0, willRetry: false },
      ]);
    } finally {
      for (const result of timer.mock.results) {
        if (result.type === 'return') {
          clearTimeout(result.value);
        }
      }
      timer.mockRestore();
      clear.mockRestore();
    }
  },
);

test.each([Number.NaN, '5000'])(
  'invalid timeout %s is rejected before the builder sends',
  async (timeout) => {
    let sends = 0;
    const adapter: HTTPAdapter = {
      getType: () => 'mock',
      send: () => {
        sends++;
        return Promise.resolve({ status: 200, headers: {}, body: null });
      },
    };
    const request = new HTTPClient({ adapter }).get('https://example.com/');
    const initialState = request.state;
    expect(() => request.timeout(timeout as number)).toThrow(TypeError);
    expect(request.state).toBe(initialState);
    expect(request.startedAt).toBeNull();
    expect(request.error).toBeNull();
    expect(sends).toBe(0);
    expect((await request.timeout(1000).send()).status).toBe(200);
    expect(sends).toBe(1);
  },
);

test('attempt setup failures release caller and composed signal listeners', async () => {
  const anyDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'any');
  const originalAdd = Object.getOwnPropertyDescriptor(
    EventTarget.prototype,
    'addEventListener',
  )?.value as EventTarget['addEventListener'];
  const originalRemove = Object.getOwnPropertyDescriptor(
    EventTarget.prototype,
    'removeEventListener',
  )?.value as EventTarget['removeEventListener'];
  const counts = new Map<AbortSignal, number>();
  const add = spyOn(
    EventTarget.prototype,
    'addEventListener',
  ).mockImplementation(function (
    this: EventTarget,
    ...args: Parameters<typeof originalAdd>
  ) {
    if (this instanceof AbortSignal && args[0] === 'abort') {
      counts.set(this, (counts.get(this) ?? 0) + 1);
    }
    Reflect.apply(originalAdd, this, args);
  });
  const remove = spyOn(
    EventTarget.prototype,
    'removeEventListener',
  ).mockImplementation(function (
    this: EventTarget,
    ...args: Parameters<typeof originalRemove>
  ) {
    if (this instanceof AbortSignal && args[0] === 'abort') {
      counts.set(this, (counts.get(this) ?? 0) - 1);
    }
    Reflect.apply(originalRemove, this, args);
  });
  Object.defineProperty(AbortSignal, 'any', {
    value: undefined,
    configurable: true,
  });
  const controller = new AbortController();
  const adapter: HTTPAdapter = {
    getType: () => 'node',
    send: () => {
      throw new Error('Serialization must fail before dispatch');
    },
  };
  try {
    const client = new HTTPClient({ adapter });
    for (let i = 0; i < 3; i++) {
      const request = client
        .post('https://example.com/')
        .signal(controller.signal)
        .json({ value: 1n });
      await request.send();
      expect(request.error?.code).toBe('request_setup_error');
      expect(counts.get(controller.signal)).toBe(0);
      expect(counts.size).toBeGreaterThanOrEqual(4);
      expect([...counts.values()].every((count) => count === 0)).toBe(true);
    }
  } finally {
    add.mockRestore();
    remove.mockRestore();
    if (anyDescriptor) {
      Object.defineProperty(AbortSignal, 'any', anyDescriptor);
    } else {
      Reflect.deleteProperty(AbortSignal, 'any');
    }
  }
});

test('retry setup failure retains the prior upload outcome and attempt count', async () => {
  const uploadError = new Error('upload failed');
  let sends = 0;
  const adapter: HTTPAdapter = {
    getType: () => 'node',
    send: () => {
      sends++;
      return Promise.resolve({
        status: 503,
        headers: {},
        body: null,
        requestBodySettled: Promise.resolve(uploadError),
      });
    },
  };
  const client = new HTTPClient({
    adapter,
    retryPolicy: { strategy: 'fixed', maxRetryAttempts: 1, delayMS: 0 },
  });
  client.addRequestInterceptor(
    (request) => ({ ...request, body: { value: 1n } }),
    { phases: ['retry'] },
  );
  const starts: number[] = [];
  const ends: number[] = [];
  const request = client
    .put('https://example.com/')
    .json({ value: 1 })
    .onAttemptStart(({ attemptNumber }) => {
      starts.push(attemptNumber);
    })
    .onAttemptEnd(({ attemptNumber }) => {
      ends.push(attemptNumber);
    });
  const response = await request.send();
  expect(request.error?.code).toBe('request_setup_error');
  expect(response.isNetworkError).toBe(false);
  expect(sends).toBe(1);
  expect(starts).toEqual([1, 2]);
  expect(ends).toEqual([1, 2]);
  expect(await response.requestBodySettled).toBe(uploadError);
  expect(request.attemptCount).toBe(2);
});

test('unstringifiable interceptor header stays a contained request_setup_error', async () => {
  let sends = 0;
  let conversions = 0;
  const adapter: HTTPAdapter = {
    getType: () => 'mock',
    send: () => {
      sends++;
      return Promise.resolve({ status: 200, headers: {}, body: null });
    },
  };
  const client = new HTTPClient({ adapter });
  client.addRequestInterceptor((request) => ({
    ...request,
    headers: {
      ...request.headers,
      bad: {
        toString() {
          conversions++;
          throw new Error('header conversion failed');
        },
      } as unknown as string,
    },
  }));
  const observed: Array<Record<string, string | string[]>> = [];
  client.addErrorObserver((_error, attemptRequest) => {
    observed.push(attemptRequest.headers);
  });
  const request = client.get('https://example.com/').headers({
    'X-Trace': 'abc',
  });
  await request.send();
  expect(request.error?.code).toBe('request_setup_error');
  expect(request.attemptCount).toBe(1);
  expect(sends).toBe(0);
  expect(conversions).toBe(2);
  // Only the unconvertible entry is dropped from the best-effort snapshot.
  expect(observed).toHaveLength(1);
  expect(observed[0]['x-trace']).toBe('abc');
  expect(observed[0]).not.toHaveProperty('bad');
});

test('best-effort snapshot reads interceptor headers from a single object', async () => {
  const adapter: HTTPAdapter = {
    getType: () => 'mock',
    send: () => Promise.resolve({ status: 200, headers: {}, body: null }),
  };
  const client = new HTTPClient({ adapter });
  let reads = 0;
  client.addRequestInterceptor((request) => ({
    ...request,
    // Each read yields a new object stamped with its read number, so entries taken
    // from different reads would disagree.
    get headers() {
      reads++;
      return {
        first: String(reads),
        second: String(reads),
        bad: {
          toString() {
            throw new Error('header conversion failed');
          },
        } as unknown as string,
      };
    },
  }));
  const observed: Array<Record<string, string | string[]>> = [];
  client.addErrorObserver((_error, attemptRequest) => {
    observed.push(attemptRequest.headers);
  });
  const request = client.get('https://example.com/');
  await request.send();
  expect(request.error?.code).toBe('request_setup_error');
  expect(observed).toHaveLength(1);
  expect(observed[0].first).toBeDefined();
  expect(observed[0].second).toBe(observed[0].first);
  expect(observed[0]).not.toHaveProperty('bad');
});

test.each([
  ['body', 'interceptor_error'],
  ['requestURL', 'interceptor_error'],
  ['method', 'request_setup_error'],
] as const)(
  'retry request with a throwing %s getter keeps its own failure and attempt count',
  async (field, expectedCode) => {
    let sends = 0;
    const adapter: HTTPAdapter = {
      getType: () => 'node',
      send: () => {
        sends++;
        return Promise.resolve({ status: 503, headers: {}, body: null });
      },
    };
    const client = new HTTPClient({
      adapter,
      retryPolicy: { strategy: 'fixed', maxRetryAttempts: 1, delayMS: 0 },
    });
    client.addRequestInterceptor(
      (request) => {
        const hostile = { ...request };
        Object.defineProperty(hostile, field, {
          enumerable: true,
          get(): never {
            throw new Error(`hostile ${field} getter`);
          },
        });
        return hostile;
      },
      { phases: ['retry'] },
    );
    const observed: Array<{ code: string; requestURL: string }> = [];
    client.addErrorObserver((error, attemptRequest) => {
      observed.push({
        code: error.code,
        requestURL: attemptRequest.requestURL,
      });
    });
    const ends: number[] = [];
    const request = client
      .put('https://example.com/')
      .json({ value: 1 })
      .onAttemptEnd(({ attemptNumber }) => {
        ends.push(attemptNumber);
      });
    await request.send();
    expect(sends).toBe(1);
    expect(request.error?.code).toBe(expectedCode);
    expect(request.error?.cause).toBeInstanceOf(Error);
    expect((request.error?.cause as Error).message).toBe(
      `hostile ${field} getter`,
    );
    expect(ends).toEqual([1, 2]);
    expect(request.attemptCount).toBe(2);
    // The snapshot keeps every field it could read.
    expect(observed).toEqual([
      {
        code: expectedCode,
        requestURL: field === 'requestURL' ? '' : 'https://example.com/',
      },
    ]);
  },
);

test.each(['body', 'header'] as const)(
  'a %s setup failure does not build the body again for its snapshot',
  async (failure) => {
    const adapter: HTTPAdapter = {
      getType: () => 'node',
      send: () => Promise.resolve({ status: 200, headers: {}, body: null }),
    };
    const client = new HTTPClient({ adapter });
    let serializations = 0;
    const body = {
      toJSON() {
        serializations++;
        if (failure === 'body') {
          throw new Error('serialization failed');
        }
        return { value: 1 };
      },
    };
    if (failure === 'header') {
      client.addRequestInterceptor((request) => ({
        ...request,
        headers: {
          ...request.headers,
          bad: {
            toString() {
              throw new Error('header conversion failed');
            },
          } as unknown as string,
        },
      }));
    }
    const observed: Array<{ body: unknown; rawBody: unknown }> = [];
    client.addErrorObserver((_error, attemptRequest) => {
      observed.push({
        body: attemptRequest.body,
        rawBody: attemptRequest.rawBody,
      });
    });
    await client.put('https://example.com/').json(body).send();
    expect(observed).toHaveLength(1);
    // One build for the request's opening snapshot, one for the attempt; the
    // failed attempt's snapshot adds none.
    expect(serializations).toBe(2);
    if (failure === 'body') {
      // Reported as it came, without a second validate-and-clone.
      expect(observed[0]).toEqual({ body: null, rawBody: body });
    } else {
      // The bodies built before the header failure are the snapshot's.
      expect(observed[0].body).toBe('{"value":1}');
    }
  },
);

test('initial interceptor request with a throwing requestURL getter stays an interceptor_error', async () => {
  let sends = 0;
  const adapter: HTTPAdapter = {
    getType: () => 'mock',
    send: () => {
      sends++;
      return Promise.resolve({ status: 200, headers: {}, body: null });
    },
  };
  const client = new HTTPClient({ adapter });
  client.addRequestInterceptor((request) => {
    const hostile = { ...request };
    Object.defineProperty(hostile, 'requestURL', {
      enumerable: true,
      get(): never {
        throw new Error('hostile requestURL getter');
      },
    });
    return hostile;
  });
  const observed: string[] = [];
  client.addErrorObserver((error) => {
    observed.push(error.code);
  });
  const request = client.get('https://example.com/');
  const response = await request.send();
  expect(sends).toBe(0);
  expect(request.error?.code).toBe('interceptor_error');
  expect((request.error?.cause as Error).message).toBe(
    'hostile requestURL getter',
  );
  // The response falls back to the URL the request started with.
  expect(response.requestURL).toBe('https://example.com/');
  expect(observed).toEqual(['interceptor_error']);
});

test('redirect interceptor request with a throwing requestURL getter stays an interceptor_error', async () => {
  let sends = 0;
  const adapter: HTTPAdapter = {
    getType: () => 'node',
    send: () => {
      sends++;
      return Promise.resolve({
        status: 302,
        headers: { location: '/next' },
        body: null,
      });
    },
  };
  const client = new HTTPClient({ adapter, followRedirects: true });
  client.addRequestInterceptor(
    (request) => {
      const hostile = { ...request };
      Object.defineProperty(hostile, 'requestURL', {
        enumerable: true,
        get(): never {
          throw new Error('hostile requestURL getter');
        },
      });
      return hostile;
    },
    { phases: ['redirect'] },
  );
  const observed: string[] = [];
  client.addErrorObserver((error) => {
    observed.push(error.code);
  });
  const request = client.get('https://example.com/start');
  const response = await request.send();
  expect(sends).toBe(1);
  expect(request.error?.code).toBe('interceptor_error');
  expect((request.error?.cause as Error).message).toBe(
    'hostile requestURL getter',
  );
  // The response falls back to the redirect target the interceptor was given.
  expect(response.requestURL).toBe('https://example.com/next');
  expect(observed).toEqual(['interceptor_error']);
});

test.each(['initial', 'retry', 'redirect'] as const)(
  'a %s interceptor URL getter that throws after its first read ends the attempt it began',
  async (phase) => {
    let sends = 0;
    const adapter: HTTPAdapter = {
      getType: () => 'node',
      send: (): Promise<AdapterResponse> => {
        sends++;
        const response: AdapterResponse =
          phase === 'redirect' && sends === 1
            ? { status: 302, headers: { location: '/next' }, body: null }
            : { status: 503, headers: {}, body: null };
        return Promise.resolve(response);
      },
    };
    const client = new HTTPClient({
      adapter,
      followRedirects: true,
      retryPolicy: { strategy: 'fixed', maxRetryAttempts: 1, delayMS: 0 },
    });
    client.addRequestInterceptor(
      (request) => {
        const hostile = { ...request };
        const { requestURL } = request;
        let reads = 0;
        Object.defineProperty(hostile, 'requestURL', {
          enumerable: true,
          get(): string {
            reads++;
            if (reads > 1) {
              throw new Error('hostile requestURL getter');
            }
            return requestURL;
          },
        });
        return hostile;
      },
      { phases: [phase] },
    );
    const starts: number[] = [];
    const ends: number[] = [];
    const request = client
      .get('https://example.com/start')
      .onAttemptStart(({ attemptNumber }) => {
        starts.push(attemptNumber);
      })
      .onAttemptEnd(({ attemptNumber }) => {
        ends.push(attemptNumber);
      });
    await request.send();
    expect(request.error?.code).toBe('request_setup_error');
    expect((request.error?.cause as Error).message).toBe(
      'hostile requestURL getter',
    );
    // Every attempt that began also ended, and is counted.
    expect(ends).toEqual(starts);
    expect(request.attemptCount).toBe(starts.length);
    expect(sends).toBe(phase === 'initial' ? 0 : 1);
  },
);
