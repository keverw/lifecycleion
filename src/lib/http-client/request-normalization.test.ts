import { expect, test } from 'bun:test';
import { HTTPClient } from './http-client';
import { matchesFilter } from './utils';
import type {
  AdapterRequest,
  AdapterResponse,
  AdapterType,
  HTTPAdapter,
  HTTPMethod,
} from './types';

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
    .request('post' as HTTPMethod, '/orders')
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
      authorization: undefined as unknown as string,
    },
  }));

  await client
    .get('/x', {
      headers: {
        'x-extra': undefined as unknown as string,
        'x-null': null as unknown as string,
      },
    })
    .send();

  const sent = adapter.requests[0]?.headers ?? {};
  expect(sent).not.toHaveProperty('authorization');
  expect(sent).not.toHaveProperty('x-extra');
  expect(sent).not.toHaveProperty('x-null');
  expect(sent['x-keep']).toBe('1');
});

test('an answer that arrives after the timer fired and cannot be read is a timeout', async () => {
  // An adapter that ignores its abort signal and answers late with headers that throw.
  const adapter: HTTPAdapter = {
    getType: () => 'node',
    send: () =>
      new Promise((resolve) => {
        setTimeout(() => {
          resolve({
            status: 503,
            get headers(): Record<string, string> {
              throw new Error('headers unreadable');
            },
            body: null,
          });
        }, 60);
      }),
  };
  const client = new HTTPClient({
    adapter,
    baseURL: 'http://example.test',
    timeout: 20,
  });

  const response = await client.get('/slow').send();

  expect(response.isTimeout).toBe(true);
  expect(response.status).toBe(0);
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
  await client
    .get('/x', { headers: { authorization: undefined as unknown as string } })
    .send();
  const sub = client.createSubClient({
    defaultHeaders: { authorization: null as unknown as string },
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
        accept: ['application/json', undefined as unknown as string],
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
      'HTTPClient request method must be a string',
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
      Authorization: undefined as unknown as string,
    },
  }));

  await client.get('/x').send();

  expect(adapter.requests[0]?.headers).not.toHaveProperty('authorization');
  expect(adapter.requests[0]?.headers).not.toHaveProperty('Authorization');
});

test('an empty method is refused, and matches no method filter', () => {
  const client = new HTTPClient({ adapter: new RecordingAdapter(200) });
  expect(() => client.request('' as HTTPMethod, '/x')).toThrow(
    'HTTPClient request method must not be empty',
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
      Authorization: undefined as unknown as string,
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
