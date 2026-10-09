import { expect, spyOn, test } from 'bun:test';
import { HTTPClient } from './http-client';
import { CookieJar } from './cookie-jar';
import type {
  AdapterRequest,
  AdapterResponse,
  AttemptEndEvent,
  HTTPAdapter,
} from './types';

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

test('an attempt signal that cannot be composed leaves no attempt timer behind', async () => {
  const anyDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'any');
  Object.defineProperty(AbortSignal, 'any', {
    value: () => {
      throw new Error('composition failed');
    },
    configurable: true,
  });
  const adapter: HTTPAdapter = {
    getType: () => 'mock',
    send: () => Promise.resolve({ status: 200, headers: {}, body: null }),
  };
  const timeoutMS = 12_345;
  const timer = spyOn(globalThis, 'setTimeout');
  try {
    const request = new HTTPClient({ adapter })
      .get('https://example.com/')
      .timeout(timeoutMS);
    await request.send();
    expect(request.error?.code).toBe('request_setup_error');
    expect(timer.mock.calls.some((call) => call[1] === timeoutMS)).toBe(false);
  } finally {
    for (const result of timer.mock.results) {
      if (result.type === 'return') {
        clearTimeout(result.value);
      }
    }
    timer.mockRestore();
    if (anyDescriptor) {
      Object.defineProperty(AbortSignal, 'any', anyDescriptor);
    } else {
      Reflect.deleteProperty(AbortSignal, 'any');
    }
  }
});

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
  expect((await response.requestBodySettled)?.cause).toBe(uploadError);
  expect(request.attemptCount).toBe(2);
});

test('unstringifiable interceptor header is a contained interceptor_error', async () => {
  // Converted once, when the interceptor's request is snapshotted, so the failure is the
  // interceptor's and no attempt is begun for it.
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
  expect(request.error?.code).toBe('interceptor_error');
  // No attempt began, as for any initial-phase interceptor failure.
  expect(request.attemptCount).toBeNull();
  expect(sends).toBe(0);
  // Once for the snapshot, once for the best-effort observer snapshot.
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
  expect(request.error?.code).toBe('interceptor_error');
  expect(observed).toHaveLength(1);
  expect(observed[0].first).toBeDefined();
  expect(observed[0].second).toBe(observed[0].first);
  expect(observed[0]).not.toHaveProperty('bad');
});

test.each([
  ['body', 'interceptor_error'],
  ['requestURL', 'interceptor_error'],
  // Every field is read once, when the interceptor's request is snapshotted, so a getter
  // that throws is the interceptor's failure whichever field it is on.
  ['method', 'interceptor_error'],
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
    // One build, for the attempt: no snapshot is taken up front, and the failed
    // attempt's snapshot adds none.
    expect(serializations).toBe(1);
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

/**
 * An adapter for the getter tests below: a `302` to `/next` first when the phase under
 * test is `redirect`, a `503` first when it is `retry`, and a `200` otherwise. Every
 * request it is handed is recorded.
 */
function makeRecordingAdapter(phase: 'initial' | 'retry' | 'redirect'): {
  adapter: HTTPAdapter;
  sent: AdapterRequest[];
} {
  const sent: AdapterRequest[] = [];
  const adapter: HTTPAdapter = {
    getType: () => 'node',
    send: (request): Promise<AdapterResponse> => {
      sent.push(request);
      const isFirst = sent.length === 1;
      const response: AdapterResponse =
        phase === 'redirect' && isFirst
          ? { status: 302, headers: { location: '/next' }, body: null }
          : phase === 'retry' && isFirst
            ? { status: 503, headers: {}, body: null }
            : { status: 200, headers: {}, body: null };
      return Promise.resolve(response);
    },
  };

  return { adapter, sent };
}

test.each(['initial', 'retry', 'redirect'] as const)(
  'a %s interceptor URL getter is read once, so a later answer cannot redirect the request or its cookies',
  async (phase) => {
    // Validated on one read and used on the next: a getter answering the real URL to the
    // http(s) check and another host afterwards got that request sent elsewhere, with the
    // real host's cookies attached by the jar.
    const { adapter, sent } = makeRecordingAdapter(phase);
    const jar = new CookieJar();
    jar.setCookie({ name: 'session', value: 'secret', domain: 'example.com' });
    const client = new HTTPClient({
      adapter,
      followRedirects: true,
      cookieJar: jar,
      retryPolicy: { strategy: 'fixed', maxRetryAttempts: 1, delayMS: 0 },
    });
    const readCounts: number[] = [];
    client.addRequestInterceptor(
      (request) => {
        const stateful = { ...request };
        const { requestURL } = request;
        const index = readCounts.push(0) - 1;
        Object.defineProperty(stateful, 'requestURL', {
          enumerable: true,
          get(): string {
            readCounts[index]++;
            return readCounts[index] === 1
              ? requestURL
              : 'https://evil.example/steal';
          },
        });
        return stateful;
      },
      { phases: [phase] },
    );

    const response = await client.get('https://example.com/start').send();

    expect(response.status).toBe(200);
    expect(readCounts).toEqual([1]);
    expect(sent.length).toBe(phase === 'initial' ? 1 : 2);

    for (const request of sent) {
      expect(request.requestURL).toStartWith('https://example.com/');
      expect(request.headers.cookie).toBe('session=secret');
    }

    expect(response.requestURL).toStartWith('https://example.com/');
  },
);

test.each(['initial', 'retry', 'redirect'] as const)(
  'a %s interceptor headers getter is read once, so the headers checked are the headers sent',
  async (phase) => {
    // The header record is checked (the browser-restricted list) and then merged again
    // for dispatch. A getter - on the record itself or on one of its entries - answering
    // differently to the second read sent headers nothing had checked.
    const { adapter, sent } = makeRecordingAdapter(phase);
    const client = new HTTPClient({
      adapter,
      followRedirects: true,
      retryPolicy: { strategy: 'fixed', maxRetryAttempts: 1, delayMS: 0 },
    });
    let recordReads = 0;
    let entryReads = 0;
    let conversions = 0;
    client.addRequestInterceptor(
      (request) => {
        const stateful = { ...request };
        const original = request.headers;
        Object.defineProperty(stateful, 'headers', {
          enumerable: true,
          get(): Record<string, string | string[]> {
            recordReads++;
            const record: Record<string, string | string[]> = {
              ...original,
              'x-record': recordReads === 1 ? 'first' : 'later',
            };
            Object.defineProperty(record, 'x-entry', {
              enumerable: true,
              get(): string {
                entryReads++;
                return entryReads === 1 ? 'first' : 'later';
              },
            });
            record['x-converted'] = {
              toString(): string {
                conversions++;
                return conversions === 1 ? 'first' : 'later';
              },
            } as unknown as string;
            return record;
          },
        });
        return stateful;
      },
      { phases: [phase] },
    );

    const response = await client.get('https://example.com/start').send();

    expect(response.status).toBe(200);
    expect(recordReads).toBe(1);
    expect(entryReads).toBe(1);
    expect(conversions).toBe(1);

    const intercepted = sent[sent.length - 1];
    expect(intercepted.headers['x-record']).toBe('first');
    expect(intercepted.headers['x-entry']).toBe('first');
    expect(intercepted.headers['x-converted']).toBe('first');
  },
);

test.each([
  ['a string', 'abc'],
  ['null', null],
  ['an array', ['a', 'b', 'c']],
] as const)(
  'an interceptor returning headers that are %s fails as interceptor_error with an empty header snapshot',
  async (_label, headers) => {
    let sends = 0;
    const adapter: HTTPAdapter = {
      getType: () => 'node',
      send: () => {
        sends++;
        return Promise.resolve({ status: 200, headers: {}, body: null });
      },
    };
    const client = new HTTPClient({ adapter });
    client.addRequestInterceptor((request) => ({
      ...request,
      headers: headers as unknown as Record<string, string>,
    }));
    const observed: Array<Record<string, string | string[]>> = [];
    client.addErrorObserver((_error, attemptRequest) => {
      observed.push(attemptRequest.headers);
    });

    const request = client.get('https://example.com/');
    await request.send();

    expect(request.error?.code).toBe('interceptor_error');
    expect(sends).toBe(0);
    // Not `{ 0: 'a', 1: 'b', 2: 'c' }`: a string or an array is not a header record.
    expect(observed).toEqual([{}]);
  },
);
