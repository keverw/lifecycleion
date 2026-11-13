import { expect, spyOn, test } from 'bun:test';
import { HTTPClient } from './http-client';
import { MockAdapter } from './adapters/mock-adapter';
import type { AdapterResponse } from './types';
import { captureErrorReports } from './test-helpers/capture-error-reports';
import * as bodyCopyModule from './internal/request-body-copy';
import * as domainUtilsModule from '../domain-utils/domain-utils';
import {
  THROWING_FILTER_HOST,
  makeMarkedFiltersThrow,
} from './test-helpers/throwing-filter';

test.each(['final', 'retry'] as const)(
  'a %s response filter that throws cannot stall send or skip later observers',
  async (phase) => {
    const adapter = new MockAdapter();
    let attempts = 0;
    adapter.routes.get('/test', () => ({
      status: ++attempts === 1 && phase === 'retry' ? 503 : 200,
      body: 'ok',
    }));
    const client = new HTTPClient({
      adapter,
      retryPolicy: { strategy: 'fixed', delayMS: 1, maxRetryAttempts: 1 },
    });
    const observed: string[] = [];
    client.addResponseObserver(
      () => {
        throw new Error('must not be called');
      },
      { phases: [phase], hosts: [THROWING_FILTER_HOST] },
    );
    client.addResponseObserver(
      (_response, _request, info) => {
        observed.push(info.type);
      },
      { phases: ['retry', 'final'] },
    );
    const { reports, release } = captureErrorReports();
    const filterSpy = makeMarkedFiltersThrow();
    try {
      const response = await client.get('/test').send();
      expect(response.status).toBe(200);
      expect(attempts).toBe(phase === 'retry' ? 2 : 1);
      expect(observed).toEqual(
        phase === 'retry' ? ['retry', 'final'] : ['final'],
      );
      expect(reports.length).toBeGreaterThan(0);
    } finally {
      filterSpy.mockRestore();
      release();
    }
  },
  1000,
);

test('an error observer filter that throws preserves retries and the final adapter error', async () => {
  const adapter = new MockAdapter();
  let attempts = 0;
  adapter.send = () => {
    attempts++;
    return Promise.reject(new Error('network failed'));
  };
  const client = new HTTPClient({
    adapter,
    retryPolicy: { strategy: 'fixed', delayMS: 1, maxRetryAttempts: 1 },
  });
  const observed: string[] = [];
  client.addErrorObserver(
    () => {
      throw new Error('must not be called');
    },
    // Matching it throws on every phase.
    { phases: ['retry', 'final'], hosts: [THROWING_FILTER_HOST] },
  );
  client.addErrorObserver(
    (_error, _request, info) => {
      observed.push(info.type);
    },
    { phases: ['retry', 'final'] },
  );
  const { reports, release } = captureErrorReports();
  const filterSpy = makeMarkedFiltersThrow();
  try {
    const response = await client.get('/test').send();
    expect(response.isFailed).toBe(true);
    expect(attempts).toBe(2);
    expect(observed).toEqual(['retry', 'final']);
    expect(reports.length).toBeGreaterThan(0);
  } finally {
    filterSpy.mockRestore();
    release();
  }
}, 1000);

test.each([
  ['a rewritten', 'https://api.internal/', 'POST'],
  ['no', undefined, undefined],
] as const)(
  'a response observer that leaves the request %s URL and method does not change which later observers run',
  async (_label, requestURL, method) => {
    const adapter = new MockAdapter();
    adapter.routes.get('/x', () => ({ status: 200, body: { secret: 1 } }));
    const client = new HTTPClient({ adapter });
    const heard: string[] = [];
    client.addResponseObserver((_response, request) => {
      Object.assign(request, { requestURL, method });
    });
    client.addResponseObserver(
      () => {
        heard.push('hosts');
      },
      { hosts: ['api.internal'] },
    );
    client.addResponseObserver(
      () => {
        heard.push('schemes');
      },
      { schemes: ['https'] },
    );
    client.addResponseObserver(
      () => {
        heard.push('methods');
      },
      { methods: ['POST'] },
    );
    client.addResponseObserver(
      () => {
        heard.push('other.test');
      },
      { hosts: ['other.test'], methods: ['GET'] },
    );

    await client.get('http://other.test/x').send();

    expect(heard).toEqual(['other.test']);
  },
);

test.each([
  ['a rewritten', 'https://api.internal/', 'POST'],
  ['no', undefined, undefined],
] as const)(
  'an error observer that leaves the request %s URL and method does not change which later observers run',
  async (_label, requestURL, method) => {
    const client = new HTTPClient({
      adapter: {
        getType: () => 'mock',
        send: () => Promise.reject(new Error('down')),
      },
    });
    const heard: string[] = [];
    client.addErrorObserver((_error, request) => {
      Object.assign(request, { requestURL, method });
    });
    client.addErrorObserver(
      () => {
        heard.push('hosts');
      },
      { hosts: ['api.internal'] },
    );
    client.addErrorObserver(
      () => {
        heard.push('schemes');
      },
      { schemes: ['https'] },
    );
    client.addErrorObserver(
      () => {
        heard.push('other.test');
      },
      { hosts: ['other.test'], schemes: ['http'] },
    );

    await client.get('http://other.test/x').send();

    expect(heard).toEqual(['other.test']);
  },
);

test('a parent client observer that rewrites the request or the response does not change which sub-client response observers run', async () => {
  const adapter = new MockAdapter();
  adapter.routes.get('/x', () => ({ status: 200, body: { secret: 1 } }));
  const root = new HTTPClient({ adapter });
  const sub = root.createSubClient();
  const heard: string[] = [];
  root.addResponseObserver((response, request) => {
    Object.assign(request, {
      requestURL: 'https://secret.internal/x',
      method: 'POST',
    });
    Object.assign(response, { status: 500, headers: undefined });
  });
  sub.addResponseObserver(
    () => {
      heard.push('secret.internal');
    },
    { hosts: ['secret.internal'] },
  );
  sub.addResponseObserver(
    () => {
      heard.push('methods POST');
    },
    { methods: ['POST'] },
  );
  sub.addResponseObserver(
    () => {
      heard.push('statusCodes 500');
    },
    { statusCodes: [500] },
  );
  sub.addResponseObserver(
    () => {
      heard.push('public.example.com');
    },
    { hosts: ['public.example.com'], methods: ['GET'], statusCodes: [200] },
  );
  sub.addResponseObserver(() => {
    heard.push('unfiltered');
  });
  const { reports, release } = captureErrorReports();
  try {
    await sub.get('https://public.example.com/x').send();
  } finally {
    release();
  }

  expect(heard).toEqual(['public.example.com', 'unfiltered']);
  expect(reports).toEqual([]);
});

test('a parent client observer that rewrites the request does not change which sub-client error observers run', async () => {
  const root = new HTTPClient({
    adapter: {
      getType: () => 'mock',
      send: () => Promise.reject(new Error('down')),
    },
  });
  const sub = root.createSubClient();
  const heard: string[] = [];
  root.addErrorObserver((_error, request) => {
    Object.assign(request, {
      requestURL: 'https://secret.internal/x',
      method: 'POST',
    });
  });
  sub.addErrorObserver(
    () => {
      heard.push('secret.internal');
    },
    { hosts: ['secret.internal'] },
  );
  sub.addErrorObserver(
    () => {
      heard.push('public.example.com');
    },
    { hosts: ['public.example.com'], schemes: ['https'] },
  );

  await sub.get('https://public.example.com/x').send();

  expect(heard).toEqual(['public.example.com']);
});

test.each(['answered', 'thrown'] as const)(
  'a retry-phase observer that rewrites the request in place does not change the %s attempt the cancelled request reports',
  async (outcome) => {
    const client = new HTTPClient({
      adapter: {
        getType: () => 'mock',
        send: () =>
          outcome === 'answered'
            ? Promise.resolve({ status: 503, headers: {}, body: null })
            : Promise.reject(new Error('down')),
      },
      retryPolicy: { strategy: 'fixed', delayMS: 5000, maxRetryAttempts: 1 },
    });
    const redact = (request: { requestURL: string; method: string }) => {
      request.requestURL = 'https://redacted.invalid/';
      request.method = 'PATCH';
    };
    client.addResponseObserver(
      (_response, request) => {
        redact(request);
      },
      { phases: ['retry'] },
    );
    client.addErrorObserver(
      (_error, request) => {
        redact(request);
      },
      { phases: ['retry'] },
    );
    const finalHeard: { requestURL: string; method: string }[] = [];
    client.addErrorObserver(
      (_error, request) => {
        finalHeard.push({
          requestURL: request.requestURL,
          method: request.method,
        });
      },
      { hosts: ['api.example.com'], methods: ['GET'] },
    );
    const builder = client.get('https://api.example.com/x');
    // Cancelled during the wait before the retry, after the retry-phase observers ran.
    client.addResponseObserver(
      () => {
        setTimeout(() => builder.cancel(), 20);
      },
      { phases: ['retry'] },
    );
    client.addErrorObserver(
      () => {
        setTimeout(() => builder.cancel(), 20);
      },
      { phases: ['retry'] },
    );

    const response = await builder.send();

    expect(response.isCancelled).toBe(true);
    expect(response.requestURL).toBe('https://api.example.com/x');
    expect(builder.error?.requestURL).toBe('https://api.example.com/x');
    expect(finalHeard).toEqual([
      { requestURL: 'https://api.example.com/x', method: 'GET' },
    ]);
  },
);

test('a JSON rawBody is parsed back only for an attempt an observer runs for, once for all of them', async () => {
  let attempts = 0;
  const root = new HTTPClient({
    adapter: {
      getType: () => 'mock',
      send: () =>
        Promise.resolve({
          status: ++attempts < 3 ? 503 : 200,
          headers: { 'content-type': 'text/plain' },
          body: new TextEncoder().encode('ok'),
        }),
    },
    retryPolicy: { strategy: 'fixed', delayMS: 1, maxRetryAttempts: 2 },
  });
  const sub = root.createSubClient();
  const rawBodies: unknown[] = [];
  root.addResponseObserver((_response, request) => {
    rawBodies.push(request.rawBody);
  });
  sub.addResponseObserver((_response, request) => {
    rawBodies.push(request.rawBody);
  });
  // Registered for every phase, but never matching: it runs for no attempt.
  sub.addResponseObserver(() => {}, {
    phases: ['retry', 'final'],
    hosts: ['other.test'],
  });
  const text = JSON.stringify({ value: 1 });
  const parsedTexts: unknown[] = [];
  const parse = JSON.parse;
  JSON.parse = ((source: string, reviver?: Parameters<typeof parse>[1]) => {
    parsedTexts.push(source);
    return parse(source, reviver) as unknown;
  }) as typeof JSON.parse;
  let response;
  try {
    response = await sub
      .put('https://api.example.com/x')
      .json({ value: 1 })
      .send();
  } finally {
    JSON.parse = parse;
  }

  expect(response.status).toBe(200);
  expect(attempts).toBe(3);
  // Once, for the final attempt: the body is sent as the text `.json()` serialized it
  // to, and the two retried attempts had no observer run for them.
  expect(parsedTexts.filter((source) => source === text)).toHaveLength(1);
  expect(rawBodies).toEqual([{ value: 1 }, { value: 1 }]);
  expect(rawBodies[0]).toBe(rawBodies[1]);
});

test('every observer, in every phase, is handed a JSON rawBody as the data sent', async () => {
  let calls = 0;
  const client = new HTTPClient({
    adapter: {
      getType: () => 'mock',
      send: () => {
        calls++;
        if (calls === 1) {
          return Promise.reject(new Error('down'));
        }

        return Promise.resolve<AdapterResponse>(
          calls === 2
            ? { status: 503, headers: {}, body: null }
            : calls === 3
              ? {
                  status: 307,
                  headers: { location: 'https://api.example.com/next' },
                  body: null,
                }
              : { status: 200, headers: {}, body: null },
        );
      },
    },
    followRedirects: true,
    retryPolicy: { strategy: 'fixed', delayMS: 1, maxRetryAttempts: 3 },
  });
  const seen: { phase: string; rawBody: unknown }[] = [];
  client.addResponseObserver(
    (_response, request, phase) => {
      seen.push({ phase: `response ${phase.type}`, rawBody: request.rawBody });
    },
    { phases: ['retry', 'redirect', 'final'] },
  );
  client.addErrorObserver(
    (_error, request, phase) => {
      seen.push({ phase: `error ${phase.type}`, rawBody: request.rawBody });
    },
    { phases: ['retry', 'final'] },
  );

  const response = await client
    .put('https://api.example.com/x')
    .json({ a: 1 })
    .send();

  expect(response.status).toBe(200);
  expect(seen).toEqual([
    { phase: 'error retry', rawBody: { a: 1 } },
    { phase: 'response retry', rawBody: { a: 1 } },
    { phase: 'response redirect', rawBody: { a: 1 } },
    { phase: 'response final', rawBody: { a: 1 } },
  ]);
});

test('a form body is copied for the observers only for an attempt an observer runs for, once for all of them', async () => {
  const sent: unknown[] = [];
  const root = new HTTPClient({
    adapter: {
      getType: () => 'mock',
      send: (request) => {
        sent.push(request.body);
        return Promise.resolve({
          status: sent.length < 3 ? 503 : 200,
          headers: {},
          body: null,
        });
      },
    },
    retryPolicy: { strategy: 'fixed', delayMS: 1, maxRetryAttempts: 2 },
  });
  const sub = root.createSubClient();
  const handed: { body: unknown; rawBody: unknown }[] = [];
  root.addResponseObserver((_response, request) => {
    handed.push({ body: request.body, rawBody: request.rawBody });
  });
  sub.addResponseObserver((_response, request) => {
    handed.push({ body: request.body, rawBody: request.rawBody });
  });
  // Registered for every phase, but never matching: it runs for no attempt.
  sub.addResponseObserver(() => {}, {
    phases: ['retry', 'final'],
    hosts: ['other.test'],
  });
  const form = new FormData();
  form.append('field', 'value');
  const builder = sub.put('https://api.example.com/x').body(form);
  // Counted from here: the builder's own copy of the form is already taken.
  const append = spyOn(FormData.prototype, 'append');
  let appends: number;
  let response;
  try {
    response = await builder.send();
    appends = append.mock.calls.length;
  } finally {
    append.mockRestore();
  }

  expect(response.status).toBe(200);
  expect(sent).toHaveLength(3);
  // One for each attempt's adapter copy, and one for the observers of the final attempt:
  // the two retried attempts had no observer run for them.
  expect(appends).toBe(4);
  expect(handed).toHaveLength(2);
  const [first, second] = handed;
  expect(first.body).toBeInstanceOf(FormData);
  expect([...(first.body as FormData).entries()]).toEqual([['field', 'value']]);
  expect(first.rawBody).toBe(first.body);
  expect(second.body).toBe(first.body);
  expect(first.body).not.toBe(sent[2]);
});

test('every observer, in every phase, is handed a bytes body as a copy of the bytes sent', async () => {
  let calls = 0;
  const sent: unknown[] = [];
  const client = new HTTPClient({
    adapter: {
      getType: () => 'mock',
      send: (request) => {
        calls++;
        sent.push(request.body);
        if (calls === 1) {
          return Promise.reject(new Error('down'));
        }

        return Promise.resolve<AdapterResponse>(
          calls === 2
            ? { status: 503, headers: {}, body: null }
            : calls === 3
              ? {
                  status: 307,
                  headers: { location: 'https://api.example.com/next' },
                  body: null,
                }
              : { status: 200, headers: {}, body: null },
        );
      },
    },
    followRedirects: true,
    retryPolicy: { strategy: 'fixed', delayMS: 1, maxRetryAttempts: 3 },
  });
  const seen: { phase: string; bytes: number[]; isRawBody: boolean }[] = [];
  client.addResponseObserver(
    (_response, request, phase) => {
      seen.push({
        phase: `response ${phase.type}`,
        bytes: [...(request.body as Uint8Array)],
        isRawBody: request.rawBody === request.body,
      });
      // Redacted in place: no later attempt sends it.
      (request.body as Uint8Array).fill(0);
    },
    { phases: ['retry', 'redirect', 'final'] },
  );
  client.addErrorObserver(
    (_error, request, phase) => {
      seen.push({
        phase: `error ${phase.type}`,
        bytes: [...(request.body as Uint8Array)],
        isRawBody: request.rawBody === request.body,
      });
      (request.body as Uint8Array).fill(0);
    },
    { phases: ['retry', 'final'] },
  );

  const response = await client
    .put('https://api.example.com/x')
    .body(new Uint8Array([1, 2, 3]))
    .send();

  expect(response.status).toBe(200);
  // Each attempt's observers are handed a copy of their own, which an earlier attempt's
  // observer did not zero.
  expect(seen).toEqual([
    { phase: 'error retry', bytes: [1, 2, 3], isRawBody: true },
    { phase: 'response retry', bytes: [1, 2, 3], isRawBody: true },
    { phase: 'response redirect', bytes: [1, 2, 3], isRawBody: true },
    { phase: 'response final', bytes: [1, 2, 3], isRawBody: true },
  ]);
  expect(sent).toEqual(
    Array.from({ length: 4 }, () => new Uint8Array([1, 2, 3])),
  );
});

test('a request body for the observers that cannot be built is built once and reported once, and every observer is handed the request without it', async () => {
  const root = new HTTPClient({
    adapter: {
      getType: () => 'mock',
      send: () => Promise.resolve({ status: 200, headers: {}, body: null }),
    },
  });
  const sub = root.createSubClient();
  const handed: unknown[] = [];
  for (const client of [root, root, sub, sub]) {
    client.addResponseObserver((_response, request) => {
      handed.push([request.body, request.rawBody, request.method]);
    });
  }
  const form = new FormData();
  form.append('field', 'value');
  const builder = sub.put('https://api.example.com/x').body(form);
  // The adapter's copy is the first append from here; every later one, the observers'
  // copy, throws.
  let appends = 0;
  const original: unknown = Reflect.get(FormData.prototype, 'append');
  const append = spyOn(FormData.prototype, 'append').mockImplementation(
    function (this: FormData, ...args: unknown[]) {
      if (++appends >= 2) {
        throw new Error('copy failed');
      }
      Reflect.apply(original as (...a: unknown[]) => void, this, args);
    },
  );
  const { reports, release } = captureErrorReports();
  let response;
  try {
    response = await builder.send();
  } finally {
    append.mockRestore();
    release();
  }

  expect(response.status).toBe(200);
  expect(handed).toEqual(
    Array.from({ length: 4 }, () => [null, undefined, 'PUT']),
  );
  expect(appends).toBe(2);
  expect(reports).toHaveLength(1);
  expect(((reports[0] as Error).cause as Error).message).toBe('copy failed');
});

test('a request body for the observers that cannot be built is reported once for the attempt, in the retry phase and the final phase alike', async () => {
  const client = new HTTPClient({
    adapter: {
      getType: () => 'mock',
      send: () => Promise.resolve({ status: 503, headers: {}, body: null }),
    },
    retryPolicy: { strategy: 'fixed', delayMS: 5000, maxRetryAttempts: 1 },
  });
  const handed: unknown[] = [];
  const form = new FormData();
  form.append('field', 'value');
  const builder = client.put('https://api.example.com/x').body(form);
  // Cancelled during the wait before the retry, after the retry-phase observer ran, so
  // the final-phase error observer is handed the same attempt's request.
  client.addResponseObserver(
    (_response, request) => {
      handed.push(['retry', request.body]);
      setTimeout(() => builder.cancel(), 20);
    },
    { phases: ['retry'] },
  );
  client.addErrorObserver((_error, request) => {
    handed.push(['final', request.body]);
  });
  // The adapter's copy is the first append from here; every later one, the observers'
  // copy, throws.
  let appends = 0;
  const original: unknown = Reflect.get(FormData.prototype, 'append');
  const append = spyOn(FormData.prototype, 'append').mockImplementation(
    function (this: FormData, ...args: unknown[]) {
      if (++appends >= 2) {
        throw new Error('copy failed');
      }
      Reflect.apply(original as (...a: unknown[]) => void, this, args);
    },
  );
  const { reports, release } = captureErrorReports();
  let response;
  try {
    response = await builder.send();
  } finally {
    append.mockRestore();
    release();
  }

  expect(response.isCancelled).toBe(true);
  expect(handed).toEqual([
    ['retry', null],
    ['final', null],
  ]);
  expect(reports).toHaveLength(1);
  expect(((reports[0] as Error).cause as Error).message).toBe('copy failed');
});

test("a JSON rawBody that cannot be parsed back leaves the observers the body's text", async () => {
  const client = new HTTPClient({
    adapter: {
      getType: () => 'mock',
      send: () => Promise.resolve({ status: 200, headers: {}, body: null }),
    },
  });
  const handed: unknown[] = [];
  for (let index = 0; index < 2; index++) {
    client.addResponseObserver((_response, request) => {
      handed.push([request.body, request.rawBody]);
    });
  }
  // Nothing else parses the body: no interceptor reads it.
  const parse = spyOn(JSON, 'parse').mockImplementation(() => {
    throw new RangeError('engine limit');
  });
  const { reports, release } = captureErrorReports();
  try {
    await client.put('https://api.example.com/x').json({ a: 1 }).send();
  } finally {
    parse.mockRestore();
    release();
  }

  expect(handed).toEqual([
    ['{"a":1}', undefined],
    ['{"a":1}', undefined],
  ]);
  expect(reports).toHaveLength(1);
});

test('a request body for the observers that cannot be built is reported again for a later attempt', async () => {
  let isObserving = false;
  const client = new HTTPClient({
    adapter: {
      getType: () => 'mock',
      send: () => {
        isObserving = true;
        return Promise.resolve({ status: 503, headers: {}, body: null });
      },
    },
    retryPolicy: { strategy: 'fixed', delayMS: 1, maxRetryAttempts: 1 },
  });
  // The next attempt's adapter copy is taken after the retry-phase interceptors run.
  client.addRequestInterceptor(
    (request) => {
      isObserving = false;
      return request;
    },
    { phases: ['retry'] },
  );
  const handed: unknown[] = [];
  client.addResponseObserver(
    (_response, request) => {
      handed.push(request.body);
    },
    { phases: ['retry', 'final'] },
  );
  const original = bodyCopyModule.cloneBodyValue;
  const copies = spyOn(bodyCopyModule, 'cloneBodyValue').mockImplementation(
    (body) => {
      if (isObserving) {
        throw new Error('copy failed');
      }
      return original(body);
    },
  );
  const { reports, release } = captureErrorReports();
  try {
    await client
      .put('https://api.example.com/x')
      .body(new Uint8Array([1, 2]))
      .send();
  } finally {
    copies.mockRestore();
    release();
  }

  expect(handed).toEqual([null, null]);
  expect(reports).toHaveLength(2);
});

test.each<[string, () => unknown, (rawBody: unknown) => unknown]>([
  ['a JSON body', () => ({ a: 1 }), (rawBody) => rawBody],
  [
    'a bytes body',
    () => new Uint8Array([1, 2]),
    (rawBody) => [...(rawBody as Uint8Array)],
  ],
  [
    'a form body',
    () => {
      const form = new FormData();
      form.append('field', 'value');
      return form;
    },
    (rawBody) => [...(rawBody as FormData).entries()],
  ],
])(
  'an observer registered while the attempt is under way is handed %s',
  async (_label, makeBody, read) => {
    let answer: (() => void) | undefined;
    const client = new HTTPClient({
      adapter: {
        getType: () => 'mock',
        send: () =>
          new Promise((resolve) => {
            answer = () => {
              resolve({ status: 200, headers: {}, body: null });
            };
          }),
      },
    });
    const seen: { hasBody: boolean; rawBody: unknown }[] = [];
    const pending = client
      .put('https://api.example.com/x')
      .body(makeBody())
      .send();

    // Registered once the attempt has reached the adapter.
    for (let tick = 0; answer === undefined && tick < 100; tick++) {
      await Promise.resolve();
    }
    expect(answer).toBeDefined();
    client.addResponseObserver((_response, request) => {
      seen.push({ hasBody: 'body' in request, rawBody: read(request.rawBody) });
    });
    answer?.();
    const response = await pending;

    expect(response.status).toBe(200);
    expect(seen).toEqual([{ hasBody: true, rawBody: read(makeBody()) }]);
  },
);

test.each(['interceptors', 'observers'] as const)(
  'host-scoped %s of one phase parse the request URL once between them',
  async (kind) => {
    const parsesWith = async (count: number): Promise<number> => {
      const client = new HTTPClient({
        adapter: {
          getType: () => 'mock',
          send: () => Promise.resolve({ status: 200, headers: {}, body: null }),
        },
      });
      for (let index = 0; index < count; index++) {
        if (kind === 'interceptors') {
          client.addRequestInterceptor((request) => request, {
            hosts: ['other.example.com'],
          });
        } else {
          client.addResponseObserver(() => undefined, {
            hosts: ['other.example.com'],
          });
        }
      }
      const parse = spyOn(domainUtilsModule, 'safeParseURL');
      try {
        await client.get('https://api.example.com/x').send();
        return parse.mock.calls.length;
      } finally {
        parse.mockRestore();
      }
    };

    expect(await parsesWith(3)).toBe(await parsesWith(1));
  },
);

test("an interceptor's in-place edit of the URL is what the filters after it match", async () => {
  const client = new HTTPClient({
    adapter: {
      getType: () => 'mock',
      send: () => Promise.resolve({ status: 200, headers: {}, body: null }),
    },
  });
  const ran: string[] = [];
  client.addRequestInterceptor((request) => {
    request.requestURL = 'https://moved.test/x';
    return request;
  });
  client.addRequestInterceptor(
    (request) => {
      ran.push('moved');
      return request;
    },
    { hosts: ['moved.test'] },
  );
  client.addRequestInterceptor(
    (request) => {
      ran.push('original');
      return request;
    },
    { hosts: ['api.test'] },
  );

  await client.get('https://api.test/x').send();

  expect(ran).toEqual(['moved']);
});
