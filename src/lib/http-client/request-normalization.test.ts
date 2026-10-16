import { expect, test } from 'bun:test';
import vm from 'node:vm';
import { HTTPClient } from './http-client';
import { matchesFilter } from './utils';
import { CookieJar } from './cookie-jar';
import { MockAdapter } from './adapters/mock-adapter';
import { NodeAdapter } from './adapters/node-adapter';
import type {
  AdapterRequest,
  AdapterResponse,
  AdapterType,
  HTTPAdapter,
  HTTPMethod,
} from './types';

/** A cookie jar whose storing of a response fails. */
function failingJar(): CookieJar {
  const jar = new CookieJar();
  jar.processResponseHeaders = () => {
    throw new Error('jar failed');
  };
  return jar;
}

/** Answers every request with `status`, recording what each attempt sent. */
class RecordingAdapter implements HTTPAdapter {
  public readonly requests: AdapterRequest[] = [];

  constructor(private readonly status: number) {}

  public getType(): AdapterType {
    return 'node';
  }

  public send(request: AdapterRequest): Promise<AdapterResponse> {
    this.requests.push(request);
    return Promise.resolve({ status: this.status, headers: {}, body: null });
  }
}

test('a lowercase method is the non-idempotent POST without an interceptor', async () => {
  const adapter = new RecordingAdapter(503);
  const client = new HTTPClient({
    adapter,
    baseURL: 'http://example.test',
    retryPolicy: { strategy: 'fixed', maxRetryAttempts: 2, delayMS: 1 },
  });

  const response = await client
    .request('post', '/orders')
    .json({ a: 1 })
    .send();

  // Not retried: a POST is not idempotent, however the caller spelled it.
  expect(adapter.requests).toHaveLength(1);
  expect(adapter.requests[0]?.method).toBe('POST');
  expect(response.status).toBe(503);
});

test('defaultHeaders that is not a plain record is refused, not dropped', () => {
  const adapter = new RecordingAdapter(200);
  for (const defaultHeaders of [
    new Headers({ authorization: 'Bearer x' }),
    new Map([['authorization', 'Bearer x']]),
  ]) {
    expect(
      () =>
        new HTTPClient({
          adapter,
          defaultHeaders: defaultHeaders as never,
        }),
    ).toThrow('HTTPClient defaultHeaders must be a plain object');
  }

  const client = new HTTPClient({ adapter });
  expect(() =>
    client.createSubClient({
      defaultHeaders: new Headers({ authorization: 'Bearer x' }) as never,
    }),
  ).toThrow('HTTPClient sub-client defaultHeaders must be a plain object');
});

test('an undefined header value is left out, not sent as "undefined"', async () => {
  const adapter = new RecordingAdapter(200);
  const client = new HTTPClient({
    adapter,
    baseURL: 'http://example.test',
    defaultHeaders: { authorization: 'Bearer x', 'x-keep': '1' },
  });
  // The usual way to remove a header from an interceptor.
  client.addRequestInterceptor((request) => ({
    ...request,
    headers: {
      ...request.headers,
      authorization: undefined,
    },
  }));

  await client
    .get('/x', {
      headers: {
        'x-extra': undefined,
        'x-null': null,
      },
    })
    .send();

  const sent = adapter.requests[0]?.headers ?? {};
  expect(sent).not.toHaveProperty('authorization');
  expect(sent).not.toHaveProperty('x-extra');
  expect(sent).not.toHaveProperty('x-null');
  expect(sent['x-keep']).toBe('1');
});

test('an answer that arrives after the timer fired and cannot be read is the answered adapter_error', async () => {
  // An adapter that ignores its abort signal and answers late; storing the answer fails.
  const adapter: HTTPAdapter = {
    getType: () => 'node',
    send: () =>
      new Promise((resolve) => {
        setTimeout(() => {
          resolve({
            status: 503,
            headers: {},
            body: null,
          });
        }, 60);
      }),
  };
  const client = new HTTPClient({
    adapter,
    baseURL: 'http://example.test',
    timeout: 20,
    cookieJar: failingJar(),
  });

  const request = client.get('/slow');
  const response = await request.send();

  // As an unreadable answer that arrived in time is: the server answered, so it is not
  // a timeout to retry. A late answer that reads cleanly is delivered.
  expect(response.isTimeout).toBe(false);
  expect(request.error?.code).toBe('adapter_error');
  expect(response.status).toBe(503);
});

test('numeric effectiveRequestHeaders are read as strings, not discarded', async () => {
  const adapter: HTTPAdapter = {
    getType: () => 'node',
    send: () =>
      Promise.resolve({
        status: 200,
        headers: {},
        body: null,
        // As Node's `getHeaders()` answers them.
        effectiveRequestHeaders: {
          'content-length': 5 as unknown as string,
          'x-added': 'yes',
        },
      }),
  };
  const client = new HTTPClient({ adapter, baseURL: 'http://example.test' });
  const seen: Array<Record<string, string | string[]>> = [];
  client.addResponseObserver((_response, request) => {
    seen.push(request.headers);
  });

  await client.post('/x').json({ a: 1 }).send();

  expect(seen[0]?.['content-length']).toBe('5');
  expect(seen[0]?.['x-added']).toBe('yes');
});

test('an undefined request header removes the client default instead of sending it', async () => {
  const adapter = new RecordingAdapter(200);
  const client = new HTTPClient({
    adapter,
    baseURL: 'http://example.test',
    defaultHeaders: { authorization: 'Bearer secret', 'x-keep': '1' },
  });

  // Dropping a default credential for one request, say to a third-party URL.
  await client.get('/x', { headers: { authorization: undefined } }).send();
  const sub = client.createSubClient({
    defaultHeaders: { authorization: null },
    defaultHeadersStrategy: 'merge',
  });
  await sub.get('/y').send();

  for (const request of adapter.requests) {
    expect(request.headers).not.toHaveProperty('authorization');
    expect(request.headers['x-keep']).toBe('1');
  }
  expect(adapter.requests).toHaveLength(2);
});

test('an unset item in a header array is left out', async () => {
  const adapter = new RecordingAdapter(200);
  const client = new HTTPClient({ adapter, baseURL: 'http://example.test' });

  await client
    .get('/x', {
      headers: {
        accept: ['application/json', undefined],
      },
    })
    .send();

  expect(adapter.requests[0]?.headers.accept).toBe('application/json');
});

test('a null in effectiveRequestHeaders is skipped, not the whole record', async () => {
  const adapter: HTTPAdapter = {
    getType: () => 'node',
    send: () =>
      Promise.resolve({
        status: 200,
        headers: {},
        body: null,
        effectiveRequestHeaders: {
          'content-length': 12 as unknown as string,
          'x-trace': null as unknown as string,
          'user-agent': 'agent',
        },
      }),
  };
  const client = new HTTPClient({ adapter, baseURL: 'http://example.test' });
  const seen: Array<Record<string, string | string[]>> = [];
  client.addResponseObserver((_response, request) => {
    seen.push(request.headers);
  });

  await client.post('/x').json({ a: 1 }).send();

  expect(seen[0]?.['content-length']).toBe('12');
  expect(seen[0]?.['user-agent']).toBe('agent');
  expect(seen[0]).not.toHaveProperty('x-trace');
});

test("a later interceptor's method filter matches an earlier interceptor's lowercase method", async () => {
  const adapter = new RecordingAdapter(200);
  const client = new HTTPClient({ adapter, baseURL: 'http://example.test' });
  client.addRequestInterceptor((request) => ({
    ...request,
    method: 'post' as HTTPMethod,
  }));
  let didRun = false;
  client.addRequestInterceptor(
    (request) => {
      didRun = true;
      return request;
    },
    { methods: ['POST'] },
  );

  await client.get('/x').send();

  expect(didRun).toBe(true);
  expect(adapter.requests[0]?.method).toBe('POST');
});

test('a method that is not a string is refused when the request is made', () => {
  const client = new HTTPClient({ adapter: new RecordingAdapter(200) });
  for (const method of [undefined, null, 42]) {
    expect(() => client.request(method as never, '/x')).toThrow(
      'HTTPClient request method is not a string',
    );
  }
});

test("an interceptor's non-string method fails clearly, even past a method filter", async () => {
  const adapter = new RecordingAdapter(200);
  const client = new HTTPClient({ adapter, baseURL: 'http://example.test' });
  client.addRequestInterceptor((request) => ({
    ...request,
    method: 42 as unknown as HTTPMethod,
  }));
  client.addRequestInterceptor((request) => request, { methods: ['GET'] });

  const errors: Array<{ code: string; message: string }> = [];
  client.addErrorObserver((error) => {
    errors.push({
      code: error.code,
      message: String(error.cause?.message),
    });
  });

  const response = await client.get('/x').send();

  expect(response.isFailed).toBe(true);
  expect(errors[0]?.code).toBe('interceptor_error');
  expect(errors[0]?.message).toContain('method is not a string');
  expect(adapter.requests).toHaveLength(0);
});

test("an interceptor's unset header removes the default whatever its capitalization", async () => {
  const adapter = new RecordingAdapter(200);
  const client = new HTTPClient({
    adapter,
    baseURL: 'http://example.test',
    defaultHeaders: { authorization: 'Bearer secret' },
  });
  client.addRequestInterceptor((request) => ({
    ...request,
    headers: {
      ...request.headers,
      Authorization: undefined,
    },
  }));

  await client.get('/x').send();

  expect(adapter.requests[0]?.headers).not.toHaveProperty('authorization');
  expect(adapter.requests[0]?.headers).not.toHaveProperty('Authorization');
});

test('an empty method is refused, and matches no method filter', () => {
  const client = new HTTPClient({ adapter: new RecordingAdapter(200) });
  expect(() => client.request('', '/x')).toThrow(
    'HTTPClient request method is empty',
  );
  expect(
    matchesFilter({ methods: ['GET'] }, { method: '' }, 'initial', 'request'),
  ).toBe(false);
});

test("a refused interceptor request's unset header is left out of what error observers see", async () => {
  const adapter = new RecordingAdapter(200);
  const client = new HTTPClient({
    adapter,
    baseURL: 'http://example.test',
    defaultHeaders: { authorization: 'Bearer secret', 'x-keep': '1' },
  });
  // Refused for its method, so error observers get a best-effort copy of it.
  client.addRequestInterceptor((request) => ({
    ...request,
    method: 42 as unknown as HTTPMethod,
    headers: {
      ...request.headers,
      Authorization: undefined,
    },
  }));
  const seen: Array<Record<string, string | string[]>> = [];
  client.addErrorObserver((_error, request) => {
    seen.push(request.headers);
  });

  await client.get('/x').send();

  expect(seen).toHaveLength(1);
  expect(seen[0]).not.toHaveProperty('authorization');
  expect(seen[0]?.['x-keep']).toBe('1');
  expect(adapter.requests).toHaveLength(0);
});

test('an interceptor that returns no request fails with a clear message', async () => {
  for (const returned of [undefined, true, 'http://example.test/y']) {
    const adapter = new RecordingAdapter(200);
    const client = new HTTPClient({ adapter, baseURL: 'http://example.test' });
    // As a forgotten `return request` does, for `undefined`.
    client.addRequestInterceptor(() => returned as never);
    client.addRequestInterceptor((request) => request);
    const messages: string[] = [];
    client.addErrorObserver((error) => {
      messages.push(`${error.code}: ${String(error.cause?.message)}`);
    });

    const response = await client.get('/x').send();

    expect(response.isFailed).toBe(true);
    expect(messages).toEqual([
      `interceptor_error: [HTTPClient] Interceptor returned a value that is not a request, a cancel or null (got ${typeof returned}).`,
    ]);
    expect(adapter.requests).toHaveLength(0);
  }
});

test('a method that is not a valid HTTP method name is refused before dispatch', async () => {
  const adapter = new RecordingAdapter(200);
  const client = new HTTPClient({ adapter, baseURL: 'http://example.test' });
  for (const method of ['GE T', 'GET\n', ' ']) {
    expect(() => client.request(method, '/x')).toThrow(
      'HTTPClient request method is not a valid HTTP method name',
    );
  }
  // A custom method made of token characters is still accepted.
  expect(() => client.request('PROPFIND', '/x')).not.toThrow();

  client.addRequestInterceptor((request) => ({
    ...request,
    method: 'GET\r\n' as HTTPMethod,
  }));
  const messages: string[] = [];
  client.addErrorObserver((error) => {
    messages.push(String(error.cause?.message));
  });

  await client.get('/x').send();

  expect(messages).toEqual([
    '[HTTPClient] Interceptor returned a request whose method is not a valid HTTP method name (got "GET\\r\\n").',
  ]);
  expect(adapter.requests).toHaveLength(0);
});

test('a filter whose methods is not an array of strings is refused when registered', () => {
  const client = new HTTPClient({ adapter: new RecordingAdapter(200) });
  // As a JS caller might write it; it used to match by substring.
  expect(() =>
    client.addRequestInterceptor((request) => request, {
      methods: 'POST' as never,
    }),
  ).toThrow(
    'HTTPClient request interceptor filter methods must be an array of method names (got string)',
  );
  expect(() =>
    client.addResponseObserver(() => undefined, { methods: 'POST' as never }),
  ).toThrow('HTTPClient response observer filter methods must be an array');
  expect(() =>
    client.addErrorObserver(() => undefined, { methods: [42] as never }),
  ).toThrow(
    'HTTPClient error observer filter method is not a string (got number)',
  );
});

test("a filter's lowercase method matches, and a nullish methods means no filter", async () => {
  const adapter = new RecordingAdapter(200);
  const client = new HTTPClient({ adapter, baseURL: 'http://example.test' });
  const ran: string[] = [];
  client.addRequestInterceptor(
    (request) => {
      ran.push('lowercase');
      return request;
    },
    { methods: ['post'] },
  );
  client.addRequestInterceptor(
    (request) => {
      ran.push('nullish');
      return request;
    },
    { methods: null as never },
  );

  await client.post('/x').send();

  expect(ran).toEqual(['lowercase', 'nullish']);
});

test('a falsy headers option that is not nullish is refused, as headers() refuses it', () => {
  const client = new HTTPClient({ adapter: new RecordingAdapter(200) });
  for (const headers of ['', 0, false]) {
    expect(() => client.get('/x', { headers: headers as never })).toThrow(
      'HTTPRequestBuilder headers must be a plain object',
    );
  }
});

test('a filter method that no request can have is refused when registered', () => {
  const client = new HTTPClient({ adapter: new RecordingAdapter(200) });
  for (const [entry, problem] of [
    ['GET, POST', 'is not a valid HTTP method name'],
    ['', 'is empty'],
  ] as const) {
    expect(() =>
      client.addRequestInterceptor((request) => request, {
        methods: [entry as HTTPMethod],
      }),
    ).toThrow(`HTTPClient request interceptor filter method ${problem}`);
  }
});

test('a cancel after the adapter answered reports the answered status', async () => {
  const controller = new AbortController();
  const adapter: HTTPAdapter = {
    getType: () => 'node',
    send: () =>
      Promise.resolve({
        status: 200,
        headers: {},
        body: null,
      }),
  };
  // The caller cancels while the answer is being stored, and storing it then fails.
  const cookieJar = new CookieJar();
  cookieJar.processResponseHeaders = () => {
    controller.abort();
    throw new Error('jar failed');
  };
  const client = new HTTPClient({
    adapter,
    baseURL: 'http://example.test',
    cookieJar,
  });
  const statuses: number[] = [];

  const response = await client
    .get('/x')
    .signal(controller.signal)
    .onAttemptEnd((event) => {
      statuses.push(event.status);
    })
    .send();

  expect(response.isCancelled).toBe(true);
  expect(statuses).toEqual([200]);
});

test('an attempt reports its end once, even if the retry path throws after announcing it', async () => {
  const adapter = new RecordingAdapter(503);
  const client = new HTTPClient({
    adapter,
    baseURL: 'http://example.test',
    retryPolicy: { strategy: 'fixed', maxRetryAttempts: 2, delayMS: 1 },
  });
  // The client's own retry wait failing - nothing in it is meant to throw.
  (
    client as unknown as { _cancellableDelay: () => Promise<void> }
  )._cancellableDelay = () => Promise.reject(new Error('retry wait failed'));
  const events: Array<{ attemptNumber: number; willRetry: boolean }> = [];

  await client
    .get('/x')
    .onAttemptEnd((event) => {
      events.push({
        attemptNumber: event.attemptNumber,
        willRetry: event.willRetry,
      });
    })
    .send();

  expect(events).toEqual([{ attemptNumber: 1, willRetry: true }]);
});

test('a later builder header replaces an earlier one whatever their capitalization', async () => {
  const adapter = new RecordingAdapter(200);
  const client = new HTTPClient({ adapter, baseURL: 'http://example.test' });

  await client
    .get('/a')
    .headers({ Authorization: 'old' })
    .headers({ authorization: undefined })
    .headers({ Authorization: 'new' })
    .send();
  await client
    .get('/b')
    .headers({ Authorization: 'a' })
    .headers({ authorization: 'b' })
    .headers({ Authorization: 'c' })
    .send();

  expect(adapter.requests[0]?.headers.authorization).toBe('new');
  expect(adapter.requests[1]?.headers.authorization).toBe('c');
});

test('defaultHeaders is copied at construction, so later changes do not reach the client', async () => {
  const adapter = new RecordingAdapter(200);
  const defaultHeaders: Record<string, string | undefined> = {
    Authorization: 'Bearer a',
  };
  const client = new HTTPClient({
    adapter,
    baseURL: 'http://example.test',
    defaultHeaders,
  });
  const sub = client.createSubClient({});
  defaultHeaders.Authorization = undefined;
  defaultHeaders['x-later'] = '1';

  await client.get('/x').send();
  await sub.get('/y').send();

  for (const request of adapter.requests) {
    expect(request.headers.authorization).toBe('Bearer a');
    expect(request.headers).not.toHaveProperty('x-later');
  }
});

test('a standard method is uppercased, and any other method is sent as given', async () => {
  const adapter = new RecordingAdapter(200);
  const client = new HTTPClient({ adapter, baseURL: 'http://example.test' });
  const filtered: string[] = [];
  client.addRequestInterceptor(
    (request) => {
      filtered.push(request.method);
      return request;
    },
    // A custom method matches exactly; a standard one in any case.
    { methods: ['purge', 'patch'] },
  );

  for (const method of ['patch', 'purge', 'PURGE', 'Options']) {
    await client.request(method, '/x').send();
  }

  expect(adapter.requests.map((request): string => request.method)).toEqual([
    'PATCH',
    'purge',
    'PURGE',
    'OPTIONS',
  ]);
  expect(filtered).toEqual(['PATCH', 'purge']);
});

test("a request interceptor's filter that throws fails the request as interceptor_error", async () => {
  const adapter = new RecordingAdapter(200);
  const client = new HTTPClient({ adapter, baseURL: 'http://example.test' });
  let didRun = false;
  client.addRequestInterceptor(
    (request) => {
      didRun = true;
      return request;
    },
    { bodyContainsKeys: ['data'] },
  );
  const codes: string[] = [];
  client.addErrorObserver((error) => {
    codes.push(error.code);
  });
  const body = new Proxy(
    {},
    {
      get(): never {
        throw new Error('body unreadable');
      },
      has(): never {
        throw new Error('body unreadable');
      },
      getOwnPropertyDescriptor(): never {
        throw new Error('body unreadable');
      },
    },
  );

  const response = await client.post('/x', { body }).send();

  expect(response.isFailed).toBe(true);
  expect(codes).toEqual(['interceptor_error']);
  expect(didRun).toBe(false);
  expect(adapter.requests).toHaveLength(0);
});

test('a late answer is decided by the answer: delivered if readable, never re-sent if not', async () => {
  for (const isReadable of [true, false]) {
    let sends = 0;
    const adapter: HTTPAdapter = {
      getType: () => 'node',
      // Ignores its abort signal and answers after the attempt's timer fired.
      send: () => {
        sends++;
        return new Promise((resolve) => {
          setTimeout(() => {
            resolve({
              status: 200,
              headers: { 'content-type': 'text/plain' },
              body: new TextEncoder().encode('late'),
            });
          }, 60);
        });
      },
    };
    const client = new HTTPClient({
      adapter,
      baseURL: 'http://example.test',
      timeout: 20,
      retryPolicy: { strategy: 'fixed', maxRetryAttempts: 2, delayMS: 1 },
      // Storing the answer fails when it is to be unreadable.
      cookieJar: isReadable ? new CookieJar() : failingJar(),
    });

    const request = client.get('/slow');
    const response = await request.send();

    expect(sends).toBe(1);
    expect(response.status).toBe(200);
    expect(response.isTimeout).toBe(false);
    if (isReadable) {
      expect(response.isFailed).toBe(false);
      expect(response.body).toBe('late');
    } else {
      expect(request.error?.code).toBe('adapter_error');
    }
  }
});

test('a filter list that is not an array of the right entries is refused when registered', () => {
  const client = new HTTPClient({ adapter: new RecordingAdapter(200) });
  // A string used to match by substring: 'initial,retry' ran in both phases.
  expect(() =>
    client.addRequestInterceptor((request) => request, {
      phases: 'initial,retry' as never,
    }),
  ).toThrow(
    'HTTPClient request interceptor filter phases must be an array (got string)',
  );
  expect(() =>
    client.addResponseObserver(() => undefined, {
      statusCodes: ['200'] as never,
    }),
  ).toThrow(
    'HTTPClient response observer filter statusCodes must contain only numbers (got string)',
  );
  expect(() =>
    client.addErrorObserver(() => undefined, 'final' as never),
  ).toThrow('HTTPClient error observer filter must be an object (got string)');
});

test('a filter is read once and copied, so later changes to it do not apply', async () => {
  const adapter = new RecordingAdapter(200);
  const client = new HTTPClient({ adapter, baseURL: 'http://example.test' });
  let phaseReads = 0;
  const filter = {
    get phases(): Array<'initial'> {
      phaseReads++;
      return ['initial'];
    },
    hosts: ['example.test'],
  };
  let runs = 0;
  client.addRequestInterceptor((request) => {
    runs++;
    return request;
  }, filter);
  filter.hosts.push('other.test');
  filter.hosts.splice(0, 1);

  await client.get('/x').send();

  expect(phaseReads).toBe(1);
  expect(runs).toBe(1);
});

test('a callback that is not a function is refused when registered', () => {
  const client = new HTTPClient({ adapter: new RecordingAdapter(200) });
  expect(() => client.addRequestInterceptor(null as never)).toThrow(
    'HTTPClient request interceptor must be a function (got null)',
  );
  expect(() => client.addResponseObserver('log' as never)).toThrow(
    'HTTPClient response observer must be a function (got string)',
  );
  expect(() => client.addErrorObserver({} as never)).toThrow(
    'HTTPClient error observer must be a function (got object)',
  );
});

test("an upload Error keeps a Node system error's fields, with the original as cause", async () => {
  const original = Object.assign(new Error('write ECONNRESET'), {
    code: 'ECONNRESET',
    errno: -54,
    syscall: 'write',
    address: '127.0.0.1',
    port: 8080,
  });
  const adapter: HTTPAdapter = {
    getType: () => 'node',
    send: () =>
      Promise.resolve({
        status: 200,
        headers: {},
        body: null,
        requestBodySettled: Promise.resolve(original),
      }),
  };
  const client = new HTTPClient({ adapter, baseURL: 'http://example.test' });

  const response = await client.post('/x').json({ a: 1 }).send();
  const uploadError = await response.requestBodySettled;

  expect(uploadError?.cause).toBe(original);
  expect(uploadError?.message).toBe('write ECONNRESET');
  expect(uploadError).toMatchObject({
    code: 'ECONNRESET',
    errno: -54,
    syscall: 'write',
    address: '127.0.0.1',
    port: 8080,
  });
});

test('a filter naming a phase, scheme or content type that cannot occur is refused', () => {
  const client = new HTTPClient({ adapter: new RecordingAdapter(200) });
  // An interceptor never runs in the final phase, so this would match nothing.
  expect(() =>
    client.addRequestInterceptor((request) => request, {
      phases: ['final' as never],
    }),
  ).toThrow(
    `HTTPClient request interceptor filter phases has "final", which is not one of 'initial', 'retry', 'redirect'`,
  );
  expect(() =>
    client.addErrorObserver(() => undefined, { phases: ['redirect' as never] }),
  ).toThrow('HTTPClient error observer filter phases has "redirect"');
  expect(() =>
    client.addRequestInterceptor((request) => request, {
      schemes: ['HTTPS' as never],
    }),
  ).toThrow('HTTPClient request interceptor filter schemes has "HTTPS"');
  expect(() =>
    client.addResponseObserver(() => undefined, {
      contentTypes: ['xml' as never],
    }),
  ).toThrow('HTTPClient response observer filter contentTypes has "xml"');
});

test('a filter field that kind of callback cannot use is refused when registered', () => {
  const client = new HTTPClient({ adapter: new RecordingAdapter(200) });
  // Ignored, an error observer filtered to 500 would see every error.
  expect(() =>
    client.addErrorObserver(() => undefined, {
      statusCodes: [500],
    } as never),
  ).toThrow('HTTPClient error observer filter has no "statusCodes" field');
  // An interceptor has no response content type to match, so it would never run.
  expect(() =>
    client.addRequestInterceptor((request) => request, {
      contentTypes: ['json'],
    } as never),
  ).toThrow(
    'HTTPClient request interceptor filter has no "contentTypes" field',
  );
  // A misspelled field is refused the same way.
  expect(() =>
    client.addResponseObserver(() => undefined, { phase: ['final'] } as never),
  ).toThrow('HTTPClient response observer filter has no "phase" field');
});

test("a callback cannot change the request's redirect history", async () => {
  const adapter = new MockAdapter();
  let hits = 0;
  adapter.routes.get('/start', () => ({
    status: 302,
    headers: { location: '/end' },
  }));
  adapter.routes.get('/end', () =>
    ++hits < 2 ? { status: 503 } : { status: 200, body: 'ok' },
  );
  const client = new HTTPClient({
    adapter,
    baseURL: 'http://example.test',
    followRedirects: true,
    retryPolicy: { strategy: 'fixed', maxRetryAttempts: 2, delayMS: 1 },
  });
  client.addRequestInterceptor(
    (request, _phase, context) => {
      context.redirectHistory.push('http://elsewhere.test/');
      return request;
    },
    { phases: ['retry', 'redirect'] },
  );
  client.addResponseObserver(
    (response) => {
      response.redirectHistory.push('http://elsewhere.test/');
    },
    { phases: ['redirect', 'retry'] },
  );

  const response = await client.get('/start').send();

  expect(response.redirectHistory).toEqual(['http://example.test/end']);
});

test('boolean options and cookieJar are checked by type at construction', () => {
  const adapter = new RecordingAdapter(200);
  // An environment variable's string would otherwise be read as `true`.
  expect(
    () => new HTTPClient({ adapter, followRedirects: 'false' as never }),
  ).toThrow('HTTPClient followRedirects must be a boolean (got string)');
  expect(
    () => new HTTPClient({ adapter, includeRequestID: 1 as never }),
  ).toThrow('HTTPClient includeRequestID must be a boolean (got number)');
  expect(() => new HTTPClient({ adapter, cookieJar: {} as never })).toThrow(
    'HTTPClient cookieJar must be a CookieJar',
  );
  expect(
    () =>
      new HTTPClient({
        adapter,
        followRedirects: null as never,
        cookieJar: null,
      }),
  ).not.toThrow();
});

test('a plain object from another realm is accepted as a JSON body', async () => {
  const adapter = new RecordingAdapter(200);
  const client = new HTTPClient({ adapter, baseURL: 'http://example.test' });
  const body = vm.runInNewContext('({ a: 1, when: new Date(0) })') as Record<
    string,
    unknown
  >;

  const response = await client.post('/x').json(body).send();

  expect(response.isFailed).toBe(false);
  // Its `Date` is sent as this realm's would be, not as `{}`.
  expect(adapter.requests[0]?.body).toBe(
    '{"a":1,"when":"1970-01-01T00:00:00.000Z"}',
  );
});

test('only the first cancel of a request in flight returns true', async () => {
  const adapter: HTTPAdapter = {
    getType: () => 'node',
    send: (request) =>
      new Promise((_resolve, reject) => {
        request.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      }),
  };
  const client = new HTTPClient({ adapter, baseURL: 'http://example.test' });
  const builder = client.get('/x');
  const sending = builder.send();
  await Promise.resolve();

  expect(builder.cancel('first')).toBe(true);
  expect(builder.cancel('second')).toBe(false);

  const response = await sending;
  expect(response.isCancelled).toBe(true);
  expect(builder.error?.cancelReason).toBe('first');
  expect(builder.cancel()).toBe(false);
});

test('a per-request retryNonIdempotentMethods must be a boolean', () => {
  const client = new HTTPClient({ adapter: new RecordingAdapter(200) });
  // Read by truthiness, 'false' would let a POST be replayed.
  expect(() =>
    client.post('/x', { retryNonIdempotentMethods: 'false' as never }),
  ).toThrow(
    'HTTPRequestBuilder retryNonIdempotentMethods must be a boolean (got string)',
  );
  expect(() => client.post('/x').retryNonIdempotentMethods(1 as never)).toThrow(
    'HTTPRequestBuilder retryNonIdempotentMethods must be a boolean',
  );
  expect(() =>
    client.post('/x', { retryNonIdempotentMethods: null as never }),
  ).not.toThrow();
});

test("an error observer cannot change the response's redirect history", async () => {
  const adapter = new MockAdapter();
  adapter.routes.get('/start', () => ({
    status: 302,
    headers: { location: '/end' },
  }));
  const client = new HTTPClient({
    adapter,
    baseURL: 'http://example.test',
    followRedirects: true,
  });
  client.addRequestInterceptor(
    () => {
      throw new Error('refused');
    },
    { phases: ['redirect'] },
  );
  client.addErrorObserver((error) => {
    error.redirectHistory.push('http://elsewhere.test/');
  });

  const response = await client.get('/start').send();

  expect(response.redirectHistory).toEqual(['http://example.test/end']);
});

test('userAgent and a sub-client defaultHeadersStrategy are checked at construction', () => {
  const adapter = new RecordingAdapter(200);
  expect(() => new HTTPClient({ adapter, userAgent: 123 as never })).toThrow(
    'HTTPClient userAgent must be a string (got number)',
  );
  const client = new HTTPClient({
    adapter,
    defaultHeaders: { authorization: 'Bearer a' },
  });
  // Read as 'replace', a typo would drop the inherited authorization.
  expect(() =>
    client.createSubClient({ defaultHeadersStrategy: 'MERGE' as never }),
  ).toThrow(
    `HTTPClient sub-client defaultHeadersStrategy must be 'replace' or 'merge' (got "MERGE")`,
  );
});

test('a cancel counts only when it is what cancels the request', async () => {
  const adapter: HTTPAdapter = {
    getType: () => 'node',
    send: (request) =>
      new Promise((_resolve, reject) => {
        request.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      }),
  };
  const client = new HTTPClient({ adapter, baseURL: 'http://example.test' });
  const builder = client.get('/x');
  const sending = builder.send();
  await Promise.resolve();

  expect(client.cancel(builder.requestID, 'by client')).toBe(1);
  // Already cancelled, by the client.
  expect(builder.cancel('by builder')).toBe(false);
  expect(client.cancelAll()).toBe(0);

  await sending;
  expect(builder.error?.cancelReason).toBe('by client');
});

test("a JSON body's nested toJSON values are sent as JSON.stringify sends them", async () => {
  const adapter = new RecordingAdapter(200);
  const client = new HTTPClient({ adapter, baseURL: 'http://example.test' });
  class Money {
    public toJSON(): string {
      return '1.00 USD';
    }
  }
  const body = {
    url: new URL('http://a.test/'),
    price: new Money(),
    inner: vm.runInNewContext('({ when: new Date(0) })') as unknown,
  };

  await client.post('/x').json(body).send();

  expect(adapter.requests[0]?.body).toBe(JSON.stringify(body));
});

test('a 307 replays the JSON body as the first hop sent it', async () => {
  const adapter = new MockAdapter();
  const received: unknown[] = [];
  adapter.routes.post('/start', (request) => {
    received.push(request.body);
    return { status: 307, headers: { location: '/end' } };
  });
  adapter.routes.post('/end', (request) => {
    received.push(request.body);
    return { status: 200, body: 'ok' };
  });
  const client = new HTTPClient({
    adapter,
    baseURL: 'http://example.test',
    followRedirects: true,
  });
  const body = { url: new URL('http://a.test/'), when: new Date(0) };

  await client.post('/start').json(body).send();

  expect(received).toHaveLength(2);
  expect(received[1]).toEqual(received[0]);
});

test("a request the caller's signal aborted is not counted by the client's cancels", async () => {
  const adapter: HTTPAdapter = {
    getType: () => 'node',
    send: (request) =>
      new Promise((_resolve, reject) => {
        request.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      }),
  };
  const client = new HTTPClient({ adapter, baseURL: 'http://example.test' });
  const controller = new AbortController();
  const builder = client.get('/x').signal(controller.signal);
  const sending = builder.send();
  await Promise.resolve();

  controller.abort('by caller');

  expect(client.cancel(builder.requestID)).toBe(0);
  expect(client.cancelAll()).toBe(0);
  expect(builder.cancel()).toBe(false);
  await sending;
});

test('bodyContainsKeys matches own keys only, not inherited names', async () => {
  const adapter = new RecordingAdapter(200);
  const client = new HTTPClient({ adapter, baseURL: 'http://example.test' });
  const ran: string[] = [];
  for (const key of ['constructor', 'a.toString', 'a.b']) {
    client.addRequestInterceptor(
      (request) => {
        ran.push(key);
        return request;
      },
      { bodyContainsKeys: [key] },
    );
  }

  await client
    .post('/x')
    .json({ a: { b: 1 } })
    .send();

  expect(ran).toEqual(['a.b']);
});

test("a redirect interceptor that rewrites the hop's URL in place still loses cross-origin credentials", async () => {
  const adapter = new MockAdapter();
  const received: Array<Record<string, string | string[]>> = [];
  adapter.routes.get('/start', () => ({
    status: 302,
    headers: { location: '/land' },
  }));
  adapter.routes.get('/land', (request) => {
    received.push(request.headers);
    return { status: 200, body: 'ok' };
  });
  const client = new HTTPClient({
    adapter,
    baseURL: 'http://a.test',
    followRedirects: true,
    defaultHeaders: { authorization: 'Bearer secret' },
  });
  client.addRequestInterceptor(
    (request) => {
      // Mutated rather than copied.
      request.requestURL = 'http://c.test/land';
      return request;
    },
    { phases: ['redirect'] },
  );

  await client.get('/start').send();

  expect(received).toHaveLength(1);
  expect(received[0]).not.toHaveProperty('authorization');
});

test("an error's cause does not carry the request headers when serialized", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: () => new Response('body'),
  });
  try {
    const failure = new Error('factory failed');
    const builder = new HTTPClient({ adapter: new NodeAdapter() })
      .get(`http://127.0.0.1:${server.port}/`)
      .headers({ authorization: 'Bearer secret' })
      .streamResponse(() => {
        throw failure;
      });

    await builder.send();

    expect(builder.error?.code).toBe('stream_setup_error');
    expect(JSON.stringify(failure)).not.toContain('secret');
    expect(Object.keys(failure)).toEqual([]);
  } finally {
    await server.stop(true);
  }
});

test('a retry-phase interceptor does not spend the attempt timeout', async () => {
  let sends = 0;
  const adapter: HTTPAdapter = {
    getType: () => 'node',
    // Honors its signal, as a real adapter does: an attempt whose timer already fired is
    // refused, so a timer armed before the interceptor would fail the retry.
    send: (request) => {
      sends++;
      if (request.signal?.aborted) {
        return Promise.reject(new DOMException('aborted', 'AbortError'));
      }
      return Promise.resolve({
        status: sends === 1 ? 503 : 200,
        headers: {},
        body: null,
      });
    },
  };
  const client = new HTTPClient({
    adapter,
    baseURL: 'http://example.test',
    timeout: 30,
    retryPolicy: { strategy: 'fixed', maxRetryAttempts: 1, delayMS: 1 },
  });
  // A token refresh slower than the attempt timeout.
  client.addRequestInterceptor(
    async (request) => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return request;
    },
    { phases: ['retry'] },
  );

  const response = await client.get('/x').send();

  expect(sends).toBe(2);
  expect(response.isTimeout).toBe(false);
  expect(response.status).toBe(200);
});

test('a builder whose send() rejects is left failed, not sending', async () => {
  const client = new HTTPClient({ adapter: new RecordingAdapter(200) });
  const params = {
    get page(): string {
      throw new Error('params unreadable');
    },
  };
  const builder = client.get('http://example.test/x').params(params);

  const rejection = await builder.send().then(
    () => undefined,
    (error: unknown) => error,
  );

  expect(rejection).toBeInstanceOf(Error);
  expect(builder.state).toBe('failed');
  expect(builder.cancel()).toBe(false);
  expect(() => client.get('/x').signal({ aborted: false } as never)).toThrow(
    'HTTPRequestBuilder signal must be an AbortSignal',
  );
});

test("a redirect observer that rewrites the hop's URL in place still loses cross-origin credentials", async () => {
  const adapter = new MockAdapter();
  const received: Array<Record<string, string | string[]>> = [];
  adapter.routes.get('/start', () => ({
    status: 302,
    headers: { location: 'http://c.test/land' },
  }));
  adapter.routes.get('/land', (request) => {
    received.push(request.headers);
    return { status: 200, body: 'ok' };
  });
  const client = new HTTPClient({
    adapter,
    baseURL: 'http://a.test',
    followRedirects: true,
    defaultHeaders: { authorization: 'Bearer secret' },
  });
  client.addResponseObserver(
    (_response, request) => {
      // Made to look as if the hop had been sent to the redirect's target already.
      (request as { requestURL: string }).requestURL = 'http://c.test/land';
    },
    { phases: ['redirect'] },
  );

  await client.get('/start').send();

  expect(received).toHaveLength(1);
  expect(received[0]).not.toHaveProperty('authorization');
});

test('a cancel from a final observer neither cancels nor counts the decided request', async () => {
  const adapter = new RecordingAdapter(200);
  const client = new HTTPClient({ adapter, baseURL: 'http://example.test' });
  const counts: number[] = [];
  client.addResponseObserver(
    () => {
      counts.push(client.cancelAll('late'));
    },
    { phases: ['final'] },
  );
  const builder = client.get('/x');

  const response = await builder.send();

  expect(counts).toEqual([0]);
  expect(response.isCancelled).toBe(false);
  expect(builder.state).toBe('completed');
});

test('a signal whose aborted getter throws is read as not aborted when the request starts', async () => {
  const adapter = new RecordingAdapter(200);
  const client = new HTTPClient({ adapter, baseURL: 'http://example.test' });
  const controller = new AbortController();
  // A real AbortSignal, so it is accepted, with an `aborted` that cannot be read.
  Object.defineProperty(controller.signal, 'aborted', {
    get(): boolean {
      throw new Error('aborted unreadable');
    },
  });

  const response = await client.get('/x').signal(controller.signal).send();

  expect(response.status).toBe(200);
});

test('a sub-client whose retryPolicy is null does not retry', async () => {
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
    baseURL: 'http://example.test',
    retryPolicy: { strategy: 'fixed', maxRetryAttempts: 3, delayMS: 1 },
  });

  await client.createSubClient({ retryPolicy: null }).get('/x').send();

  expect(sends).toBe(1);
});

test('only RFC 9110 idempotent methods are retried; a custom method is not', async () => {
  const calls: Record<string, number> = {};
  const adapter: HTTPAdapter = {
    getType: () => 'node',
    send: (request) => {
      calls[request.method] = (calls[request.method] ?? 0) + 1;
      return Promise.resolve({ status: 503, headers: {}, body: null });
    },
  };
  const client = new HTTPClient({
    adapter,
    baseURL: 'http://example.test',
    retryPolicy: { strategy: 'fixed', maxRetryAttempts: 2, delayMS: 1 },
  });

  for (const method of ['LOCK', 'MKCOL', 'POST', 'PUT', 'OPTIONS']) {
    await client.request(method, '/x').send();
  }

  expect(calls).toEqual({ LOCK: 1, MKCOL: 1, POST: 1, PUT: 3, OPTIONS: 3 });
});

test('an adapter answer without a valid status is the answered adapter_error', async () => {
  for (const status of [undefined, '503', Number.NaN, -1, 200.5]) {
    const adapter: HTTPAdapter = {
      getType: () => 'node',
      send: () => Promise.resolve({ status, headers: {}, body: null } as never),
    };
    const client = new HTTPClient({ adapter, baseURL: 'http://example.test' });
    const builder = client.get('/x');

    const response = await builder.send();

    expect(response.isFailed).toBe(true);
    expect(builder.error?.code).toBe('adapter_error');
  }
  // A class-instance answer whose fields are prototype getters is read whole.
  class Answer {
    public get status(): number {
      return 201;
    }
    public get headers(): Record<string, string> {
      return {};
    }
    public get body(): null {
      return null;
    }
  }
  const client = new HTTPClient({
    adapter: {
      getType: () => 'node',
      send: () => Promise.resolve(new Answer()),
    },
    baseURL: 'http://example.test',
  });
  expect((await client.get('/x').send()).status).toBe(201);
});

test('a redirect past maxRedirects still reports where it pointed', async () => {
  const adapter = new MockAdapter();
  adapter.routes.get('/a', () => ({
    status: 302,
    headers: { location: '/b' },
  }));
  adapter.routes.get('/b', () => ({
    status: 302,
    headers: { location: '/a' },
  }));
  const client = new HTTPClient({
    adapter,
    baseURL: 'http://example.test',
    followRedirects: true,
    maxRedirects: 1,
  });
  const builder = client.get('/a');

  const response = await builder.send();

  expect(builder.error?.code).toBe('redirect_loop');
  expect(response.wasRedirectDetected).toBe(true);
  expect(response.detectedRedirectURL).toBe('http://example.test/a');
});

test('CONNECT is refused on every adapter, and TRACE through fetch on any runtime', async () => {
  const client = new HTTPClient({ adapter: new RecordingAdapter(200) });
  expect(() => client.request('CONNECT', 'http://example.test/')).toThrow(
    'HTTPClient request method is CONNECT, which opens a tunnel and is not supported',
  );

  let fetchCalls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    fetchCalls++;
    return Promise.resolve(new Response('ok'));
  }) as unknown as typeof fetch;
  try {
    const fetchClient = new HTTPClient({
      baseURL: 'http://example.test',
      retryPolicy: { strategy: 'fixed', maxRetryAttempts: 2, delayMS: 1 },
    });
    const builder = fetchClient.request('TRACE', '/x');

    await builder.send();

    expect(fetchCalls).toBe(0);
    expect(builder.error?.code).toBe('request_setup_error');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a lowercase trace is the standard, idempotent TRACE', async () => {
  const methods: string[] = [];
  const adapter: HTTPAdapter = {
    getType: () => 'node',
    send: (request) => {
      methods.push(request.method);
      return Promise.resolve({ status: 503, headers: {}, body: null });
    },
  };
  const client = new HTTPClient({
    adapter,
    baseURL: 'http://example.test',
    retryPolicy: { strategy: 'fixed', maxRetryAttempts: 1, delayMS: 1 },
  });

  await client.request('trace', '/x').send();

  expect(methods).toEqual(['TRACE', 'TRACE']);
});

test('a redirect interceptor that cancels reports the hop as it was before it ran', async () => {
  const adapter = new MockAdapter();
  adapter.routes.get('/start', () => ({
    status: 302,
    headers: { location: '/next' },
  }));
  const client = new HTTPClient({
    adapter,
    baseURL: 'http://example.test',
    followRedirects: true,
  });
  client.addRequestInterceptor(
    (request) => {
      request.requestURL = 'http://user:pw@elsewhere.test/zzz';
      return null;
    },
    { phases: ['redirect'] },
  );

  const response = await client.get('/start').send();

  expect(response.isCancelled).toBe(true);
  expect(response.requestURL).toBe('http://example.test/next');
  expect(response.redirectHistory).toEqual(['http://example.test/next']);
});

test('MockAdapter serves OPTIONS and other methods through routes.on', async () => {
  const adapter = new MockAdapter();
  adapter.routes.options('/x', () => ({ status: 204 }));
  adapter.routes.on('PROPFIND', '/x', () => ({ status: 207 }));
  const client = new HTTPClient({ adapter, baseURL: 'http://example.test' });

  expect((await client.request('OPTIONS', '/x').send()).status).toBe(204);
  expect((await client.request('PROPFIND', '/x').send()).status).toBe(207);
  expect(() =>
    adapter.routes.on('NOT_A_METHOD', '/x', () => ({ status: 200 })),
  ).toThrow();
});

test("a MockAdapter route's own mistake is not retried", async () => {
  const adapter = new MockAdapter();
  let calls = 0;
  adapter.routes.get('/no-return', () => {
    calls++;
    return undefined as never;
  });
  adapter.routes.get('/bad-body', () => {
    calls++;
    return { status: 200, body: new Map() as never };
  });
  const client = new HTTPClient({
    adapter,
    baseURL: 'http://example.test',
    retryPolicy: { strategy: 'fixed', maxRetryAttempts: 2, delayMS: 1 },
  });

  for (const path of ['/no-return', '/bad-body']) {
    calls = 0;
    const builder = client.get(path);
    const response = await builder.send();

    expect(calls).toBe(1);
    expect(builder.error?.code).toBe('adapter_error');
    expect(response.isNetworkError).toBe(false);
  }
});

test('MockAdapter reads the first of two same-named cookies, and truncates maxAge', async () => {
  const adapter = new MockAdapter();
  let seen: string | undefined;
  adapter.routes.get('/c', (request) => {
    seen = request.cookies.s;
    return {
      status: 200,
      cookies: { gone: { value: 'x', maxAge: -0.5 } },
    };
  });
  const jar = new CookieJar();
  jar.processResponseHeaders(
    { 'set-cookie': ['gone=1; Path=/'] },
    'http://example.test/',
  );
  const client = new HTTPClient({
    adapter,
    baseURL: 'http://example.test',
    cookieJar: jar,
  });

  await client.get('/c').headers({ cookie: 'ignored=1' }).send();
  // The jar replaces the request's own cookie header; check parsing directly too.
  await adapter.send({
    requestURL: 'http://example.test/c',
    method: 'GET',
    headers: { cookie: 's=api; s=root' },
  });

  expect(seen).toBe('api');
  // A fractional negative Max-Age deletes the cookie rather than keeping it empty.
  expect(jar.getCookieHeaderString('http://example.test/')).toBe('');
});

test("one site's cookie cannot replace another's through a crafted name and path", () => {
  const jar = new CookieJar();
  jar.processResponseHeaders(
    { 'set-cookie': ['a=victim; Secure; Path=/@y.example.com/'] },
    'https://x.example.com/',
  );
  jar.processResponseHeaders(
    { 'set-cookie': ['a@x.example.com/=attacker; Path=/'] },
    'http://y.example.com/',
  );

  expect(
    jar.getCookieHeaderString('https://x.example.com/@y.example.com/'),
  ).toBe('a=victim');
});

test('MockAdapter matches a lowercase method uppercased, and names onHandlerError when it returns nothing', async () => {
  const adapter = new MockAdapter({ onHandlerError: () => undefined as never });
  adapter.routes.on('lock', '/x', () => ({ status: 200 }));
  adapter.routes.get('/throws', () => {
    throw new Error('route failed');
  });
  const client = new HTTPClient({ adapter, baseURL: 'http://example.test' });

  expect((await client.request('lock', '/x').send()).status).toBe(200);
  const builder = client.get('/throws');
  await builder.send();
  expect(builder.error?.cause?.message).toContain(
    'MockAdapter onHandlerError for GET /throws returned no MockResponse',
  );
});

test('a 307/308 keeps a GET request body and its content-type', async () => {
  for (const status of [307, 308]) {
    const adapter = new MockAdapter();
    const seen: unknown[] = [];
    adapter.routes.get('/old/_search', () => ({
      status,
      headers: { location: '/new/_search' },
    }));
    adapter.routes.get('/new/_search', (req) => {
      seen.push([req.headers['content-type'], req.body]);
      return { status: 200 };
    });
    const client = new HTTPClient({
      adapter,
      baseURL: 'http://es.test',
      followRedirects: true,
    });

    const response = await client
      .get('/old/_search', { body: { query: { match_all: {} } } })
      .send();

    expect(response.status).toBe(200);
    expect(seen).toEqual([
      ['application/json; charset=utf-8', { query: { match_all: {} } }],
    ]);
  }
});

test('a 303 rewrite to GET still drops the body and its headers', async () => {
  const adapter = new MockAdapter();
  const seen: unknown[] = [];
  adapter.routes.put('/a', () => ({
    status: 303,
    headers: { location: '/b' },
  }));
  adapter.routes.get('/b', (req) => {
    seen.push([
      req.headers['content-type'],
      req.headers['content-encoding'],
      req.body,
    ]);
    return { status: 200 };
  });
  const client = new HTTPClient({
    adapter,
    baseURL: 'http://a.test',
    followRedirects: true,
  });

  await client
    .put('/a', {
      body: new Uint8Array([31, 139, 8]),
      headers: { 'content-encoding': 'gzip' },
    })
    .send();

  expect(seen).toEqual([[undefined, undefined, undefined]]);
});

test('a cross-origin 307 keeps the content-encoding of the body it replays', async () => {
  const adapter = new MockAdapter();
  const seen: unknown[] = [];
  adapter.routes.put('/a', () => ({
    status: 307,
    headers: { location: 'http://b.test/x' },
  }));
  adapter.routes.put('/x', (req) => {
    seen.push([
      req.headers['content-encoding'],
      req.headers['content-type'],
      req.headers['x-api-key'],
    ]);
    return { status: 200 };
  });
  const client = new HTTPClient({
    adapter,
    baseURL: 'http://a.test',
    followRedirects: true,
  });

  await client
    .put('/a', {
      body: new Uint8Array([31, 139, 8]),
      headers: {
        'content-encoding': 'gzip',
        'content-type': 'application/json',
        'x-api-key': 'secret',
      },
    })
    .send();

  expect(seen).toEqual([['gzip', 'application/json', undefined]]);
});

test('a class-instance answer is read whole, its error flags included', async () => {
  class StreamErrorAnswer {
    public get status() {
      return 200;
    }
    public get headers() {
      return {};
    }
    public get body() {
      return new Uint8Array([1, 2]);
    }
    public get isStreamError() {
      return true;
    }
    public get streamErrorCode() {
      return 'stream_response_error' as const;
    }
  }
  class TransportErrorAnswer {
    public get status() {
      return 0;
    }
    public get headers() {
      return {};
    }
    public get body() {
      return null;
    }
    public get isTransportError() {
      return true;
    }
  }
  const adapterOf = (make: () => unknown): HTTPAdapter => ({
    getType: () => 'node',
    send: (_request: AdapterRequest) =>
      Promise.resolve(make() as AdapterResponse),
  });

  const streamResponse = await new HTTPClient({
    adapter: adapterOf(() => new StreamErrorAnswer()),
    baseURL: 'http://a.test',
  })
    .get('/x')
    .send();

  expect(streamResponse.isFailed).toBe(true);
  expect(streamResponse.isStreamError).toBe(true);

  const transportResponse = await new HTTPClient({
    adapter: adapterOf(() => new TransportErrorAnswer()),
    baseURL: 'http://a.test',
  })
    .get('/x')
    .send();

  expect(transportResponse.isNetworkError).toBe(true);
});

test('FetchAdapter refuses a GET or HEAD with a body once, without retrying', async () => {
  for (const method of ['GET', 'HEAD'] as const) {
    let sends = 0;
    const client = new HTTPClient({
      adapter: {
        getType: () => 'fetch',
        send: () => {
          sends++;
          return Promise.reject(new TypeError('cannot have body'));
        },
      },
      baseURL: 'http://a.test',
      retryPolicy: { strategy: 'fixed', maxRetryAttempts: 3, delayMS: 1 },
    });
    const builder = client.request(method, '/x', { body: { a: 1 } });

    const response = await builder.send();

    expect(sends).toBe(0);
    expect(builder.error?.code).toBe('request_setup_error');
    expect(response.isNetworkError).toBe(false);
  }
});

test('cancelAll does not count or cancel a request started while it runs', async () => {
  let cleanup: Promise<{ isCancelled: boolean }> | undefined;
  const client: HTTPClient = new HTTPClient({
    baseURL: 'http://a.test',
    adapter: {
      getType: () => 'node',
      send: (request: AdapterRequest) =>
        new Promise<AdapterResponse>((resolve, reject) => {
          if (request.requestURL.endsWith('/cleanup')) {
            setTimeout(
              () => resolve({ status: 200, headers: {}, body: null }),
              5,
            );
            return;
          }
          request.signal?.addEventListener('abort', () => {
            cleanup = client.get('/cleanup').send();
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        }),
    },
  });
  const pending = client.get('/long').send();
  await new Promise((resolve) => setTimeout(resolve, 5));

  expect(client.cancelAll()).toBe(1);
  expect((await pending).isCancelled).toBe(true);
  expect((await cleanup)?.isCancelled).toBe(false);
});

test('an empty filter list is refused when the callback is added, except phases', () => {
  const client = new HTTPClient();
  for (const field of [
    'statusCodes',
    'methods',
    'hosts',
    'schemes',
    'contentTypes',
    'contentTypeHeaders',
    'bodyContainsKeys',
  ]) {
    expect(() =>
      client.addResponseObserver(() => {}, { [field]: [] }),
    ).toThrow(/empty/);
  }
  expect(() =>
    client.addRequestInterceptor((request) => request, { hosts: [] }),
  ).toThrow(/empty/);

  const remove = client.addResponseObserver(() => {}, { phases: [] });
  remove();
});

test('MockAdapter omits a HEAD response body whatever the method case', async () => {
  const adapter = new MockAdapter();
  const response = await adapter.send({
    requestURL: 'http://a.test/missing',
    method: 'head',
    headers: {},
  });

  expect(response.status).toBe(404);
  expect(response.body).toBeNull();
});
