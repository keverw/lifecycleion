import { expect, test } from 'bun:test';
import vm from 'node:vm';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { HTTPClient } from './http-client';
import {
  buildURL,
  extractFetchHeaders,
  matchesFilter,
  parseContentType,
} from './utils';
import {
  RESPONSE_STREAM_ABORT_FLAG,
  STREAM_ABORT_HEADERS_KEY,
  STREAM_ABORT_STATUS_KEY,
} from './consts';
import { CookieJar } from './cookie-jar';
import {
  matchesDomainList,
  matchesOriginList,
  matchesWildcardDomain,
  normalizeOrigin,
  validateConfigEntry,
} from '../domain-utils/domain-utils';
import { normalizeDomain } from '../domain-utils/helpers';
import { MockAdapter } from './adapters/mock-adapter';
import type { MockRequest } from './adapters/mock-adapter';
import { NodeAdapter } from './adapters/node-adapter';
import { FetchAdapter } from './adapters/fetch-adapter';
import type {
  AdapterRequest,
  CancelResult,
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

test("only the first cancel of a request in flight returns 'cancelled'", async () => {
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

  expect(builder.cancel('first')).toBe('cancelled');
  expect(builder.cancel('second')).toBe('already_cancelled');

  const response = await sending;
  expect(response.isCancelled).toBe(true);
  expect(builder.error?.cancelReason).toBe('first');
  expect(builder.cancel()).toBe('already_cancelled');
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
  expect(builder.cancel('by builder')).toBe('already_cancelled');
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
  expect(builder.cancel()).toBe('already_cancelled');
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
  expect(builder.cancel()).toBe('already_settled');
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
    expect(() => client.addResponseObserver(() => {}, { [field]: [] })).toThrow(
      /empty/,
    );
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

test('MockAdapter driven directly reads request header names case-insensitively, uppercases the method', async () => {
  const adapter = new MockAdapter();
  let seen: unknown;
  adapter.routes.on('PURGE', '/p', (req) => {
    seen = [req.method, req.body, req.cookies, req.headers['content-type']];
    return { status: 200 };
  });

  await adapter.send({
    requestURL: 'http://a.test/p',
    method: 'purge',
    headers: { 'Content-Type': 'application/json', Cookie: 'a=1' },
    body: '{"x":1}',
  });

  expect(seen).toEqual(['PURGE', { x: 1 }, { a: '1' }, 'application/json']);
});

test('a response header given as an array keeps every value, joined', async () => {
  const adapter = new MockAdapter();
  adapter.routes.get('/l', () => ({
    status: 200,
    headers: { Link: ['<a>', '<b>'] },
  }));

  const response = await new HTTPClient({ adapter, baseURL: 'http://a.test' })
    .get('/l')
    .send();

  expect(response.headers.link).toBe('<a>, <b>');
});

test('contentTypeHeaders */* matches any type, and an entry with no slash is refused', async () => {
  const adapter = new MockAdapter();
  adapter.routes.get('/j', () => ({ status: 200, body: { a: 1 } }));
  const client = new HTTPClient({ adapter, baseURL: 'http://a.test' });
  let calls = 0;
  client.addResponseObserver(
    () => {
      calls++;
    },
    { contentTypeHeaders: ['*/*'] },
  );

  await client.get('/j').send();

  expect(calls).toBe(1);
  for (const pattern of ['json', '*', '']) {
    expect(() =>
      client.addResponseObserver(() => {}, { contentTypeHeaders: [pattern] }),
    ).toThrow(TypeError);
  }
});

test('a host filter entry with a scheme, port or nothing is refused', () => {
  const client = new HTTPClient();
  for (const pattern of [
    'api.test:8080',
    'http://api.test',
    'api.test/v1',
    '',
    '[::1]:8080',
  ]) {
    expect(() =>
      client.addResponseObserver(() => {}, { hosts: [pattern] }),
    ).toThrow(TypeError);
  }
  for (const pattern of [
    'api.test',
    '*.api.test',
    '::1',
    '[::1]',
    '127.0.0.1',
  ]) {
    client.addResponseObserver(() => {}, { hosts: [pattern] })();
  }
});

test('parseContentType reads the media type, not a substring of the header', () => {
  expect(parseContentType('application/jsonl')).toBe('binary');
  expect(parseContentType('text/plain; profile="x+json"')).toBe('text');
  expect(parseContentType('application/vnd.api+json; charset=utf-8')).toBe(
    'json',
  );
  expect(parseContentType(' Application/JSON ')).toBe('json');
  expect(parseContentType('application/x-www-form-urlencoded')).toBe('text');
});

test('MockAdapter hands a constructor or __proto__ request header through as sent', async () => {
  const adapter = new MockAdapter();
  let seen: Record<string, string> | undefined;
  adapter.routes.get('/x', (req) => {
    seen = req.headers;
    return { status: 200 };
  });

  await adapter.send({
    requestURL: 'http://a.test/x',
    method: 'GET',
    headers: JSON.parse('{"constructor": "abc", "__proto__": "v"}') as Record<
      string,
      string
    >,
  });

  expect(Object.getOwnPropertyDescriptor(seen, 'constructor')?.value).toBe(
    'abc',
  );
  expect(Object.getOwnPropertyDescriptor(seen, '__proto__')?.value).toBe('v');
});

test('an array response header Node keeps once keeps its first value; others are joined', async () => {
  const adapter = new MockAdapter();
  adapter.routes.get('/r', () => ({
    status: 302,
    headers: { location: ['/a', '/b'] },
  }));
  adapter.routes.get('/a', () => ({
    status: 200,
    headers: {
      'content-type': ['application/json', 'application/json'],
      link: ['<a>', '<b>'],
    },
    body: '{"ok":true}',
  }));
  const response = await new HTTPClient({
    adapter,
    baseURL: 'http://a.test',
    followRedirects: true,
  })
    .get('/r')
    .send();

  expect(response.status).toBe(200);
  expect(response.body).toEqual({ ok: true });
  expect(response.headers.link).toBe('<a>, <b>');
});

test('a filter field a callback kind does not take is allowed when it is nullish', () => {
  const client = new HTTPClient();
  client.addErrorObserver(() => {}, {
    hosts: ['a.test'],
    statusCodes: undefined,
  } as never)();
  client.addRequestInterceptor((request) => request, {
    contentTypes: null,
  } as never)();
  expect(() =>
    client.addErrorObserver(() => {}, { statusCodes: [500] } as never),
  ).toThrow(TypeError);
});

test('parseContentType reads the first media type of a joined header', () => {
  expect(parseContentType('application/json, application/json')).toBe('json');
  expect(parseContentType('text/plain;charset=utf-8, text/html')).toBe('text');
});

test('a contentTypeHeaders entry with a partial wildcard or a list is refused', () => {
  const client = new HTTPClient();
  for (const pattern of [
    'application/*+json',
    '*/json',
    'application/json, application/problem+json',
    'application/ json',
    'application /json',
  ]) {
    expect(() =>
      client.addResponseObserver(() => {}, { contentTypeHeaders: [pattern] }),
    ).toThrow(TypeError);
  }
});

test('response header keys that differ only in case are combined as a repeat', async () => {
  const adapter = new MockAdapter();
  adapter.routes.get('/h', () => ({
    status: 200,
    headers: {
      Link: '<a>',
      link: '<b>',
      'Content-Type': 'text/plain',
      'content-type': 'application/json',
    },
    body: 'hi',
  }));

  const response = await new HTTPClient({ adapter, baseURL: 'http://a.test' })
    .get('/h')
    .send();

  expect(response.headers.link).toBe('<a>, <b>');
  expect(response.headers['content-type']).toBe('text/plain');
});

test('an error whose request URL could not be read matches no hosts or schemes filter', async () => {
  const client = new HTTPClient({
    adapter: new MockAdapter(),
    baseURL: 'https://public.test',
  });
  const seen: string[] = [];
  client.addErrorObserver(
    (error) => {
      seen.push(`hosts ${error.code}`);
    },
    { hosts: ['payments.test'] },
  );
  client.addErrorObserver(
    (error) => {
      seen.push(`schemes ${error.code}`);
    },
    { schemes: ['http'] },
  );
  client.addRequestInterceptor((request) => ({
    ...request,
    requestURL: 42 as unknown as string,
  }));

  const builder = client.get('/x');
  await builder.send();

  expect(builder.error?.code).toBe('interceptor_error');
  expect(seen).toEqual([]);
  expect(
    matchesFilter({ hosts: ['*'] }, { requestURL: '' }, 'final', 'error'),
  ).toBe(false);
});

test('a 3xx with no Location on the last allowed hop is the final response, not a redirect_loop', async () => {
  const adapter = new MockAdapter();
  adapter.routes.get('/a', () => ({
    status: 302,
    headers: { location: '/b' },
  }));
  adapter.routes.get('/b', () => ({ status: 302, body: 'no location' }));
  const builder = new HTTPClient({
    adapter,
    baseURL: 'http://a.test',
    followRedirects: true,
    maxRedirects: 1,
  }).get('/a');

  const response = await builder.send();

  expect(response.status).toBe(302);
  expect(response.isFailed).toBe(false);
  expect(builder.error).toBeNull();
});

test('an error observer sees the URL the error names when an interceptor made it unreadable', async () => {
  const client = new HTTPClient({
    adapter: new MockAdapter(),
    baseURL: 'https://public.test',
  });
  const seen: string[] = [];
  client.addErrorObserver(
    (_error, request) => {
      seen.push(request.requestURL);
    },
    { hosts: ['public.test'] },
  );
  client.addRequestInterceptor((request) => ({
    ...request,
    requestURL: undefined as unknown as string,
  }));

  const builder = client.get('/x');
  await builder.send();

  expect(builder.error?.requestURL).toBe('https://public.test/x');
  expect(seen).toEqual(['https://public.test/x']);
});

test('a hosts entry the matcher can never match is refused; whole-label wildcards anywhere are not', () => {
  const client = new HTTPClient();
  for (const pattern of [
    '*api.example.com',
    'api.*.test',
    '**',
    'api..example.com',
    '.example.com',
    '*.internal',
    '**.co.uk',
    '10.*.0.1',
    '10.0.0.256',
    'example.123',
    '*.example.0x10',
  ]) {
    expect(() =>
      client.addErrorObserver(() => {}, { hosts: [pattern] }),
    ).toThrow(TypeError);
  }
  for (const pattern of [
    '*',
    '*.example.com',
    '**.example.com',
    'example.com.',
    'api.*.example.com',
    'api.**.example.com',
    'backend',
    '*.',
    'redis',
  ]) {
    client.addErrorObserver(() => {}, { hosts: [pattern] })();
  }
});

test('a retry interceptor that makes the URL unreadable reports the hop URL to errors and host filters', async () => {
  const adapter = new MockAdapter();
  let calls = 0;
  adapter.routes.get('/x', () => ({ status: calls++ === 0 ? 503 : 200 }));
  const client = new HTTPClient({
    adapter,
    baseURL: 'http://api.test',
    retryPolicy: { strategy: 'fixed', maxRetryAttempts: 2, delayMS: 0 },
  });
  const seen: string[] = [];
  client.addErrorObserver(
    (_error, request) => {
      seen.push(request.requestURL);
    },
    { hosts: ['api.test'] },
  );
  client.addRequestInterceptor(
    (request) => ({ ...request, requestURL: 42 as unknown as string }),
    { phases: ['retry'] },
  );

  const builder = client.get('/x');
  const response = await builder.send();

  expect(builder.error?.code).toBe('interceptor_error');
  expect(response.requestURL).toBe('http://api.test/x');
  expect(seen).toEqual(['http://api.test/x']);
});

test('with redirects off, a 3xx with no Location is the final response, not redirect_disabled', async () => {
  const adapter = new MockAdapter();
  adapter.routes.get('/n', () => ({
    status: 302,
    body: { info: 'no location' },
  }));
  const builder = new HTTPClient({ adapter, baseURL: 'http://a.test' }).get(
    '/n',
  );

  const response = await builder.send();

  expect(response.status).toBe(302);
  expect(response.isFailed).toBe(false);
  expect(response.body).toEqual({ info: 'no location' });
  expect(builder.error).toBeNull();
});

test('a cut-off response an adapter throws is read under the rules for answers', async () => {
  const throwing = (status: number): HTTPAdapter => ({
    getType: () => 'fetch',
    send: () => {
      const error = Object.assign(new Error('cut'), {
        [RESPONSE_STREAM_ABORT_FLAG]: true,
        [STREAM_ABORT_STATUS_KEY]: status,
        [STREAM_ABORT_HEADERS_KEY]: {
          'Content-Type': 'text/plain',
          Location: '/x',
        },
      });
      return Promise.reject(error);
    },
  });

  const redirectBuilder = new HTTPClient({
    adapter: throwing(302),
    baseURL: 'http://api.test',
  }).get('/a');
  const redirect = await redirectBuilder.send();

  expect(redirectBuilder.error?.code).toBe('redirect_disabled');
  expect(redirect.detectedRedirectURL).toBe('http://api.test/x');

  const cut = await new HTTPClient({
    adapter: throwing(200),
    baseURL: 'http://api.test',
  })
    .get('/a')
    .send();

  expect(cut.status).toBe(200);
  expect(cut.headers['content-type']).toBe('text/plain');

  for (const status of [Number.NaN, -5, 1.5, 1e9]) {
    const response = await new HTTPClient({
      adapter: throwing(status),
      baseURL: 'http://api.test',
    })
      .get('/a')
      .send();

    expect(response.status).toBe(0);
  }
});

test('a 3xx the adapter reports as a transport failure is neither followed nor refused as a redirect', async () => {
  for (const isFollowing of [true, false]) {
    const sent: string[] = [];
    const builder = new HTTPClient({
      baseURL: 'http://api.test',
      followRedirects: isFollowing,
      adapter: {
        getType: () => 'node',
        send: (request: AdapterRequest) => {
          sent.push(request.requestURL);
          return Promise.resolve({
            status: 302,
            isTransportError: true,
            headers: { location: '/b' },
            body: null,
          });
        },
      },
    }).get('/a');

    const response = await builder.send();

    expect(sent).toEqual(['http://api.test/a']);
    expect(response.isFailed).toBe(true);
    expect(builder.error?.code).toBe('network_error');
  }
});

test('a redirect observer that rewrites the method in place does not change the body replay', async () => {
  const adapter = new MockAdapter();
  const seen: unknown[] = [];
  adapter.routes.post('/login', () => ({
    status: 303,
    headers: { location: '/landing' },
  }));
  adapter.routes.get('/landing', (req) => {
    seen.push(req.body);
    return { status: 200 };
  });
  const client = new HTTPClient({
    adapter,
    baseURL: 'http://api.test',
    followRedirects: true,
  });
  client.addResponseObserver(
    (_response, request) => {
      (request as { method: string }).method = 'GET';
    },
    { phases: ['redirect'] },
  );

  await client.post('/login', { body: { password: 'hunter2' } }).send();

  expect(seen).toEqual([undefined]);
});

test('an unset response header value from an adapter means no header', async () => {
  const response = await new HTTPClient({
    baseURL: 'http://api.test',
    adapter: {
      getType: () => 'node',
      send: () =>
        Promise.resolve({
          status: 200,
          headers: {
            'x-unset': undefined,
            'x-arr': ['a', null],
          } as unknown as Record<string, string>,
          body: null,
        }),
    },
  })
    .get('/a')
    .send();

  expect(Object.hasOwn(response.headers, 'x-unset')).toBe(false);
  expect(response.headers['x-arr']).toBe('a');
});

test('a cancel that lands while interceptors or redirect observers run ends the request before dispatch', async () => {
  // An adapter that answers without checking its signal first.
  const sent: string[] = [];
  const adapter: HTTPAdapter = {
    getType: () => 'node',
    send: (request: AdapterRequest) => {
      sent.push(request.requestURL);
      return Promise.resolve<AdapterResponse>(
        request.requestURL.endsWith('/r')
          ? { status: 302, headers: { location: '/b' }, body: null }
          : request.requestURL.endsWith('/flaky') && sent.length === 1
            ? { status: 503, headers: {}, body: null }
            : { status: 200, headers: {}, body: null },
      );
    },
  };

  for (const phase of ['initial', 'retry', 'redirect'] as const) {
    sent.length = 0;
    const client = new HTTPClient({
      adapter,
      baseURL: 'http://api.test',
      followRedirects: true,
      retryPolicy: { strategy: 'fixed', maxRetryAttempts: 1, delayMS: 0 },
    });
    // eslint-disable-next-line prefer-const -- assigned after the callbacks that read it
    let builder: ReturnType<HTTPClient['get']>;
    if (phase === 'redirect') {
      client.addResponseObserver(() => void builder.cancel('stop'), {
        phases: ['redirect'],
      });
    } else {
      client.addRequestInterceptor(
        (request) => {
          builder.cancel('stop');
          return request;
        },
        { phases: [phase] },
      );
    }
    builder = client.get(
      phase === 'redirect' ? '/r' : phase === 'retry' ? '/flaky' : '/x',
    );

    const response = await builder.send();

    expect(response.isCancelled).toBe(true);
    expect(builder.state).toBe('cancelled');
    expect(sent).toHaveLength(phase === 'initial' ? 0 : 1);
  }
});

test('an interceptor that rewrites the URL in place and cancels does not move the observer off the reported URL', async () => {
  const adapter = new MockAdapter();
  adapter.routes.get('/a', () => ({
    status: 302,
    headers: { location: 'http://b.test/b' },
  }));
  const client = new HTTPClient({
    adapter,
    baseURL: 'http://a.test',
    followRedirects: true,
  });
  const seen: string[] = [];
  client.addErrorObserver(
    (_error, request) => {
      seen.push(request.requestURL);
    },
    { hosts: ['b.test', 'a.test'] },
  );
  client.addRequestInterceptor(
    (request) => {
      request.requestURL = 'http://evil.test/x';
      return { cancel: true };
    },
    { phases: ['redirect'] },
  );
  const redirected = client.get('/a');
  const response = await redirected.send();

  expect(response.requestURL).toBe('http://b.test/b');
  expect(seen).toEqual(['http://b.test/b']);

  const initialClient = new HTTPClient({ adapter, baseURL: 'http://a.test' });
  initialClient.addErrorObserver(
    (_error, request) => {
      seen.push(request.requestURL);
    },
    { hosts: ['a.test'] },
  );
  initialClient.addRequestInterceptor((request) => {
    request.requestURL = 'http://evil.test/x';
    return { cancel: true };
  });
  await initialClient.get('/a').send();

  expect(seen).toEqual(['http://b.test/b', 'http://a.test/a']);
});

test('a statusCodes entry that is not an integer status is refused', () => {
  const client = new HTTPClient();
  for (const code of [Number.NaN, 200.5, -1, 1000]) {
    expect(() =>
      client.addResponseObserver(() => {}, { statusCodes: [code] }),
    ).toThrow(TypeError);
  }
  client.addResponseObserver(() => {}, { statusCodes: [0, 200, 999] })();
});

test('an unsupported filter field is refused on a class instance or prototype too', () => {
  class Filter {
    public get statusCodes(): number[] {
      return [401];
    }
  }
  const client = new HTTPClient();

  expect(() =>
    client.addErrorObserver(() => {}, new Filter() as never),
  ).toThrow(TypeError);
  expect(() =>
    client.addErrorObserver(
      () => {},
      Object.create({ statusCode: [401] }) as never,
    ),
  ).toThrow(TypeError);
});

test('a filter from another realm, or a class instance with methods, is accepted', () => {
  const client = new HTTPClient();
  client.addResponseObserver(
    () => {},
    vm.runInNewContext('({ hosts: ["api.test"], methods: ["GET"] })') as never,
  )();
  class HostFilter {
    public hosts = ['api.test'];
    public describe(): string {
      return 'api';
    }
  }
  client.addResponseObserver(() => {}, new HostFilter())();
});

test('a hosts entry with surrounding whitespace is read as the matcher reads it', () => {
  const client = new HTTPClient();
  for (const pattern of ['api.test ', ' *.example.com', '*.example.com\n']) {
    client.addResponseObserver(() => {}, { hosts: [pattern] })();
  }
});

test('a caller null-prototype base is not taken for a realm root', () => {
  const client = new HTTPClient({ adapter: new MockAdapter() });
  const base = Object.create(null) as Record<string, unknown>;
  base.statusCodes = [500];

  expect(() =>
    client.addErrorObserver(() => {}, Object.create(base) as never),
  ).toThrow(TypeError);
  expect(() =>
    client.addErrorObserver(() => {}, { statusCodes: () => true } as never),
  ).toThrow(TypeError);

  const shared = Object.create(null) as Record<string, string>;
  shared.authorization = 'Bearer t';
  expect(() =>
    client.get('/x').headers(Object.create(shared) as Record<string, string>),
  ).toThrow(TypeError);
});

test('an initial interceptor can rewrite a GET with a body before FetchAdapter refuses it', async () => {
  const sent: string[] = [];
  const client = new HTTPClient({
    baseURL: 'http://api.test',
    adapter: {
      getType: () => 'fetch',
      send: (request: AdapterRequest) => {
        sent.push(request.method);
        return Promise.resolve({ status: 200, headers: {}, body: null });
      },
    },
  });
  client.addRequestInterceptor((request) => ({
    ...request,
    method: 'POST',
    headers: { ...request.headers, 'x-http-method-override': 'GET' },
  }));

  const response = await client.get('/search', { body: { q: 'x' } }).send();

  expect(response.status).toBe(200);
  expect(sent).toEqual(['POST']);
});

test('a method refusal no interceptor changed is the caller request_setup_error', async () => {
  const client = new HTTPClient({
    baseURL: 'http://api.test',
    adapter: {
      getType: () => 'fetch',
      send: () => Promise.resolve({ status: 200, headers: {}, body: null }),
    },
  });
  client.addRequestInterceptor((request) => request, {
    hosts: ['other.test'],
  });

  for (const builder of [
    client.request('TRACE', '/x'),
    client.get('/x', { body: 'x' }),
  ]) {
    await builder.send();
    expect(builder.error?.code).toBe('request_setup_error');
  }
});

test('a cancel between redirect hops starts no further attempt', async () => {
  const adapter = new MockAdapter();
  adapter.routes.get('/a', () => ({
    status: 302,
    headers: { location: '/b' },
  }));
  adapter.routes.get('/b', () => ({ status: 200 }));
  const client = new HTTPClient({
    adapter,
    baseURL: 'http://api.test',
    followRedirects: true,
  });
  client.addResponseObserver(() => void client.cancelOwn(), {
    phases: ['redirect'],
  });
  const states: string[] = [];
  const builder = client.get('/a', {
    onAttemptStart: () => {
      states.push(
        ...client.listRequests().requests.map((entry) => entry.state),
      );
    },
  });

  const response = await builder.send();

  expect(response.isCancelled).toBe(true);
  // The cancelled hop starts no attempt at all, so nothing can write `sending` over it.
  expect(states).toEqual(['sending']);
  expect(client.listRequests().requests).toEqual([]);
});

test('an interceptor body mistake on a refused GET is the interceptor error; observers see its URL', async () => {
  const client = new HTTPClient({
    baseURL: 'http://api.test',
    adapter: {
      getType: () => 'fetch',
      send: () => Promise.resolve({ status: 200, headers: {}, body: null }),
    },
  });
  const seen: string[] = [];
  client.addErrorObserver(
    (_error, request) => {
      seen.push(request.requestURL);
    },
    { hosts: ['other.test'] },
  );
  client.addRequestInterceptor((request) => ({
    ...request,
    requestURL: 'http://other.test/x',
  }));
  const own = client.get('/x', { body: 'x' });
  await own.send();

  expect(own.error?.code).toBe('request_setup_error');
  expect(seen).toEqual(['http://other.test/x']);

  const badBodyClient = new HTTPClient({
    baseURL: 'http://api.test',
    adapter: {
      getType: () => 'fetch',
      send: () => Promise.resolve({ status: 200, headers: {}, body: null }),
    },
  });
  badBodyClient.addRequestInterceptor((request) => ({
    ...request,
    body: new URLSearchParams('a=1') as unknown as string,
  }));
  const bad = badBodyClient.get('/x', { body: 'x' });
  await bad.send();

  expect(bad.error?.code).toBe('interceptor_error');
});

test('a cancel that lands after the answer but before the request settles is honoured', async () => {
  const adapter = new MockAdapter();
  adapter.routes.get('/x', () => ({ status: 200 }));
  const client = new HTTPClient({ adapter, baseURL: 'http://api.test' });
  let cancelResult: CancelResult | undefined;
  const builder = client.get('/x', {
    onAttemptEnd: () => {
      cancelResult = builder.cancel('late');
    },
  });

  const response = await builder.send();

  expect(cancelResult).toBe('cancelled');
  expect(response.isCancelled).toBe(true);
  expect(builder.state).toBe('cancelled');
  expect(builder.error?.cancelReason).toBe('late');
  expect(builder.cancel()).toBe('already_cancelled');
});

test('an interceptor that rewrites the caller request in place into another refusal is the interceptor error', async () => {
  const client = new HTTPClient({
    baseURL: 'http://api.test',
    adapter: {
      getType: () => 'fetch',
      send: () => Promise.resolve({ status: 200, headers: {}, body: null }),
    },
  });
  client.addRequestInterceptor((request) => {
    request.method = 'TRACE';
    return request;
  });
  const builder = client.get('/x', { body: 'x' });
  await builder.send();

  expect(builder.error?.code).toBe('interceptor_error');
});

test('a late cancel on an answer that failed ends the request cancelled too', async () => {
  // An answer whose JSON body is not bytes: the request fails as adapter_error.
  const client = new HTTPClient({
    baseURL: 'http://api.test',
    adapter: {
      getType: () => 'node',
      send: () =>
        Promise.resolve({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: 'not bytes' as unknown as Uint8Array,
        }),
    },
  });
  let cancelResult: CancelResult | undefined;
  const builder = client.get('/x', {
    onAttemptEnd: () => {
      cancelResult = builder.cancel('late');
    },
  });

  const response = await builder.send();

  expect(cancelResult).toBe('cancelled');
  expect(response.isCancelled).toBe(true);
  expect(builder.state).toBe('cancelled');
  expect(builder.error?.cancelReason).toBe('late');
});

test('a cancel made before an early failure ends the request cancelled, as its true says', async () => {
  // An initial interceptor that cancels, then throws.
  const client = new HTTPClient({
    adapter: new MockAdapter(),
    baseURL: 'http://api.test',
  });
  let cancelResult: CancelResult | undefined;
  // eslint-disable-next-line prefer-const -- assigned after the interceptor that reads it
  let builder: ReturnType<HTTPClient['get']>;
  client.addRequestInterceptor(() => {
    cancelResult = builder.cancel('mine');
    throw new Error('refresh failed');
  });
  builder = client.get('/x');
  const response = await builder.send();

  expect(cancelResult).toBe('cancelled');
  expect(response.isCancelled).toBe(true);
  expect(builder.state).toBe('cancelled');
  expect(builder.error?.cancelReason).toBe('mine');

  // A redirect observer that cancels, then a cookie jar that throws between hops.
  const adapter = new MockAdapter();
  adapter.routes.get('/a', () => ({
    status: 302,
    headers: { location: '/b' },
  }));
  const jar = new CookieJar();
  const jarClient = new HTTPClient({
    adapter,
    baseURL: 'http://api.test',
    followRedirects: true,
    cookieJar: jar,
  });
  let jarCancelResult: CancelResult | undefined;
  // eslint-disable-next-line prefer-const -- assigned after the observer that reads it
  let jarBuilder: ReturnType<HTTPClient['get']>;
  jarClient.addResponseObserver(
    () => {
      jarCancelResult = jarBuilder.cancel('mine');
      jar.getCookieHeaderString = () => {
        throw new Error('jar broke');
      };
    },
    { phases: ['redirect'] },
  );
  jarBuilder = jarClient.get('/a');
  const jarResponse = await jarBuilder.send();

  expect(jarCancelResult).toBe('cancelled');
  expect(jarResponse.isCancelled).toBe(true);
  expect(jarBuilder.state).toBe('cancelled');
});

test('late cancels: a timeout, a redirect hop, an earlier reason, redirect callbacks and the tracker', async () => {
  // A late cancel after a timed-out final attempt ends the request cancelled.
  const timeoutClient = new HTTPClient({
    baseURL: 'http://api.test',
    timeout: 30,
    adapter: {
      getType: () => 'node',
      send: (request: AdapterRequest) =>
        new Promise<AdapterResponse>((_resolve, reject) => {
          request.signal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        }),
    },
  });
  const timed: ReturnType<HTTPClient['get']> = timeoutClient.get('/x', {
    onAttemptEnd: () => {
      timed.cancel('late');
    },
  });
  const timedResponse = await timed.send();
  expect(timedResponse.isCancelled).toBe(true);
  expect(timed.error?.cancelReason).toBe('late');

  // A redirect-phase interceptor that cancels and throws reports the hop's history,
  // and the redirect observers do not run after a cancel from the hop's onAttemptEnd.
  const adapter = new MockAdapter();
  adapter.routes.get('/a', () => ({
    status: 302,
    headers: { location: '/b' },
  }));
  adapter.routes.get('/b', () => ({ status: 200 }));
  const redirectClient = new HTTPClient({
    adapter,
    baseURL: 'http://api.test',
    followRedirects: true,
  });
  // eslint-disable-next-line prefer-const -- assigned after the interceptor that reads it
  let hop: ReturnType<HTTPClient['get']>;
  redirectClient.addRequestInterceptor(
    () => {
      hop.cancel('mine');
      throw new Error('refresh failed');
    },
    { phases: ['redirect'] },
  );
  hop = redirectClient.get('/a');
  const hopResponse = await hop.send();
  expect(hopResponse.isCancelled).toBe(true);
  expect(hopResponse.redirectHistory).toEqual(['http://api.test/b']);

  const observed: string[] = [];
  const quietClient = new HTTPClient({
    adapter,
    baseURL: 'http://api.test',
    followRedirects: true,
  });
  quietClient.addResponseObserver(
    () => {
      observed.push('observer');
    },
    { phases: ['redirect'] },
  );
  const quiet: ReturnType<HTTPClient['get']> = quietClient.get('/a', {
    onAttemptEnd: () => {
      quiet.cancel();
    },
  });
  expect((await quiet.send()).isCancelled).toBe(true);
  expect(observed).toEqual([]);

  // An interceptor cancel keeps the reason of an earlier cancel() that returned 'cancelled'.
  const reasonClient = new HTTPClient({ adapter, baseURL: 'http://api.test' });
  // eslint-disable-next-line prefer-const -- assigned after the interceptor that reads it
  let reasoned: ReturnType<HTTPClient['get']>;
  reasonClient.addRequestInterceptor(() => {
    reasoned.cancel('mine');
    return { cancel: true, reason: 'theirs' };
  });
  reasoned = reasonClient.get('/b');
  await reasoned.send();
  expect(reasoned.error?.cancelReason).toBe('mine');

  // builder.cancel() marks the tracked request cancelled, as client.cancel does.
  const trackedClient = new HTTPClient({
    adapter,
    baseURL: 'http://api.test',
    followRedirects: true,
  });
  const states: string[] = [];
  const tracked: ReturnType<HTTPClient['get']> = trackedClient.get('/a', {
    onAttemptEnd: () => {
      tracked.cancel();
      states.push(
        ...trackedClient.listRequests().requests.map((entry) => entry.state),
      );
    },
  });
  await tracked.send();
  expect(states).toEqual(['cancelled']);
});

test('a cancel at a phase boundary starts no attempt and runs no later callbacks', async () => {
  // cancelAll while an async initial interceptor awaits: no attempt begins.
  const adapter = new MockAdapter();
  adapter.routes.get('/x', () => ({ status: 200 }));
  adapter.routes.get('/a', () => ({
    status: 302,
    headers: { location: '/b' },
  }));
  adapter.routes.get('/b', () => ({ status: 200 }));
  adapter.routes.get('/flaky', () => ({ status: 503 }));
  const client = new HTTPClient({ adapter, baseURL: 'http://api.test' });
  const log: string[] = [];
  client.addRequestInterceptor(async (request) => {
    await Promise.resolve();
    log.push(`cancelAll=${client.cancelAll('nav')}`);
    return request;
  });
  const first = client.get('/x', {
    onAttemptStart: () => {
      log.push('start');
    },
  });
  const firstResponse = await first.send();
  expect(firstResponse.isCancelled).toBe(true);
  expect(log).toEqual(['cancelAll=1']);
  expect(first.attemptCount).toBeNull();

  // A redirect observer's cancel: no redirect interceptor, no second attempt.
  const redirectClient = new HTTPClient({
    adapter,
    baseURL: 'http://api.test',
    followRedirects: true,
  });
  const hopLog: string[] = [];
  // eslint-disable-next-line prefer-const -- assigned after the observer that reads it
  let hop: ReturnType<HTTPClient['get']>;
  redirectClient.addResponseObserver(
    () => {
      hop.cancel('x');
    },
    { phases: ['redirect'] },
  );
  redirectClient.addRequestInterceptor(
    (request) => {
      hopLog.push('redirect interceptor');
      return request;
    },
    { phases: ['redirect'] },
  );
  hop = redirectClient.get('/a', {
    onAttemptStart: ({ attemptNumber }) =>
      hopLog.push(`start ${attemptNumber}`),
  });
  expect((await hop.send()).isCancelled).toBe(true);
  expect(hopLog).toEqual(['start 1']);
  expect(hop.attemptCount).toBe(1);
  expect(hop.state).toBe('cancelled');

  // A cancel from onAttemptEnd({ willRetry: true }) runs no retry-phase observer.
  const retryClient = new HTTPClient({
    adapter,
    baseURL: 'http://api.test',
    retryPolicy: { strategy: 'fixed', maxRetryAttempts: 1, delayMS: 0 },
  });
  const retryLog: string[] = [];
  retryClient.addResponseObserver(
    () => {
      retryLog.push('retry observer');
    },
    { phases: ['retry'] },
  );
  const retried: ReturnType<HTTPClient['get']> = retryClient.get('/flaky', {
    onAttemptEnd: () => {
      retried.cancel('z');
    },
  });
  expect((await retried.send()).isCancelled).toBe(true);
  expect(retryLog).toEqual([]);
});

test('builder.cancel() marks the tracked request at once; the builder settles with the request', async () => {
  const adapter = new MockAdapter();
  adapter.routes.get('/slow', async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { status: 200 };
  });
  const client = new HTTPClient({ adapter, baseURL: 'http://api.test' });
  const builder = client.get('/slow');
  const pending = builder.send();
  await new Promise((resolve) => setTimeout(resolve, 5));

  expect(builder.cancel('x')).toBe('cancelled');
  expect(client.listRequests().requests.map((entry) => entry.state)).toEqual([
    'cancelled',
  ]);
  // Not terminal before the request has settled: no completion time stamped yet.
  expect(builder.state).toBe('sending');

  await pending;
  expect(builder.state).toBe('cancelled');
});

test('a cancel ends an interceptor chain, and an interceptor or factory cancel answers a later cancel() false', async () => {
  const adapter = new MockAdapter();
  adapter.routes.get('/flaky', () => ({ status: 503 }));
  const log: string[] = [];
  const client = new HTTPClient({
    adapter,
    baseURL: 'http://api.test',
    retryPolicy: { strategy: 'fixed', maxRetryAttempts: 1, delayMS: 0 },
  });
  client.addRequestInterceptor(
    (request) => {
      log.push('first');
      client.cancelAll('nav');
      return request;
    },
    { phases: ['retry'] },
  );
  client.addRequestInterceptor(
    (request) => {
      log.push('second');
      return request;
    },
    { phases: ['retry'] },
  );
  expect((await client.get('/flaky').send()).isCancelled).toBe(true);
  expect(log).toEqual(['first']);

  const cancelling = new HTTPClient({
    adapter,
    baseURL: 'http://api.test',
    retryPolicy: { strategy: 'fixed', maxRetryAttempts: 1, delayMS: 0 },
  });
  cancelling.addRequestInterceptor(() => ({ cancel: true, reason: 'A' }), {
    phases: ['retry'],
  });
  let lateCancelResult: CancelResult | undefined;
  const builder: ReturnType<HTTPClient['get']> = cancelling.get('/flaky', {
    onAttemptEnd: ({ attemptNumber }) => {
      if (attemptNumber === 2) {
        lateCancelResult = builder.cancel('B');
      }
    },
  });
  await builder.send();

  expect(lateCancelResult).toBe('already_cancelled');
  expect(builder.error?.cancelReason).toBe('A');
});

test("the tracker reads cancelled once the caller's own signal aborts", async () => {
  const adapter = new MockAdapter();
  adapter.routes.get('/slow', async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { status: 200 };
  });
  const client = new HTTPClient({ adapter, baseURL: 'http://api.test' });
  const controller = new AbortController();
  const pending = client.get('/slow').signal(controller.signal).send();
  await new Promise((resolve) => setTimeout(resolve, 5));

  controller.abort('caller');

  expect(client.listRequests().requests.map((entry) => entry.state)).toEqual([
    'cancelled',
  ]);
  await pending;
});

test('a cancel made while send() sets the request up is applied, not dropped', async () => {
  const sent: string[] = [];
  const client = new HTTPClient({
    baseURL: 'http://api.test',
    adapter: {
      getType: () => 'node',
      send: (request: AdapterRequest) => {
        sent.push(request.requestURL);
        return Promise.resolve({ status: 200, headers: {}, body: null });
      },
    },
  });
  let cancelResult: CancelResult | undefined;
  const builder: ReturnType<HTTPClient['get']> = client.get('/x').headers({
    'x-a': {
      toString() {
        cancelResult ??= builder.cancel('setup');
        return 'v';
      },
    } as unknown as string,
  });

  const response = await builder.send();

  expect(cancelResult).toBe('cancelled');
  expect(response.isCancelled).toBe(true);
  expect(builder.error?.cancelReason).toBe('setup');
  expect(sent).toEqual([]);
});

test('a redirect-phase interceptor cancel aborts the hop that answered', async () => {
  const signals: AbortSignal[] = [];
  const client = new HTTPClient({
    baseURL: 'http://api.test',
    followRedirects: true,
    adapter: {
      getType: () => 'node',
      send: (request: AdapterRequest) => {
        if (request.signal) {
          signals.push(request.signal);
        }
        return Promise.resolve({
          status: 307,
          headers: { location: '/b' },
          body: null,
        });
      },
    },
  });
  client.addRequestInterceptor(() => ({ cancel: true }), {
    phases: ['redirect'],
  });

  const response = await client.put('/a', { body: 'x' }).send();

  expect(response.isCancelled).toBe(true);
  expect(signals.map((signal) => signal.aborted)).toEqual([true]);
});

test('a cancel held during setup holds against a setup throw and a caller signal', async () => {
  const client = new HTTPClient({
    adapter: new MockAdapter(),
    baseURL: 'http://api.test',
  });

  // A later setup value throws: send() still rejects, but the builder ends cancelled.
  let held: CancelResult | undefined;
  const throwing: ReturnType<HTTPClient['get']> = client.get('/x').headers({
    'x-a': {
      toString() {
        held ??= throwing.cancel('setup');
        return 'v';
      },
    } as unknown as string,
    'x-b': {
      toString() {
        throw new Error('boom');
      },
    } as unknown as string,
  });
  const rejection = await throwing.send().then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(held).toBe('cancelled');
  expect((rejection as Error).message).toBe('boom');
  expect(throwing.state).toBe('cancelled');

  // The caller's signal already aborted: the setup cancel answers already_cancelled.
  const controller = new AbortController();
  controller.abort('sig');
  let answer: CancelResult | undefined;
  const signalled: ReturnType<HTTPClient['get']> = client
    .get('/x')
    .signal(controller.signal)
    .headers({
      'x-a': {
        toString() {
          answer ??= signalled.cancel('setup');
          return 'v';
        },
      } as unknown as string,
    });
  await signalled.send();
  expect(answer).toBe('already_cancelled');
  expect(signalled.error?.cancelReason).toBe('sig');

  // The signal aborts after the held cancel: the held cancel's reason stands.
  const later = new AbortController();
  const ordered: ReturnType<HTTPClient['get']> = client
    .get('/x')
    .signal(later.signal)
    .headers({
      'x-a': {
        toString() {
          if (!later.signal.aborted) {
            ordered.cancel('setup');
            later.abort('sig');
          }
          return 'v';
        },
      } as unknown as string,
    });
  await ordered.send();
  expect(ordered.error?.cancelReason).toBe('setup');
});

test('a cancel right after send() failed during setup answers already_settled', async () => {
  const disabled = new HTTPClient({
    adapter: new MockAdapter(),
    baseURL: 'http://api.test',
  });
  disabled.disable();
  const blocked = disabled.get('/x');
  const blockedSend = blocked.send().then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(blocked.cancel('late')).toBe('already_settled');
  await blockedSend;
  expect(blocked.state).toBe('failed');

  const client = new HTTPClient({
    adapter: new MockAdapter(),
    baseURL: 'http://api.test',
  });
  const throwing = client.get('/x').headers({
    'x-b': {
      toString() {
        throw new Error('boom');
      },
    } as unknown as string,
  });
  const throwingSend = throwing.send().then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(throwing.cancel('late')).toBe('already_settled');
  await throwingSend;
  expect(throwing.state).toBe('failed');
});

test('a cancel right after send() failed composing the caller signal answers already_settled', async () => {
  const client = new HTTPClient({
    adapter: new MockAdapter(),
    baseURL: 'http://api.test',
  });
  const fake = {
    aborted: false,
    [Symbol.toStringTag]: 'AbortSignal',
  } as unknown as AbortSignal;
  const builder = client.get('/x').signal(fake);
  const sending = builder.send().then(
    () => undefined,
    (error: unknown) => error,
  );

  expect(builder.cancel('late')).toBe('already_settled');
  expect(await sending).toBeInstanceOf(Error);
  expect(builder.state).toBe('failed');
});

test('a held setup cancel answers consistently, and a first cancel keeps its own (missing) reason', async () => {
  const client = new HTTPClient({
    adapter: new MockAdapter(),
    baseURL: 'http://api.test',
  });
  const builder: ReturnType<HTTPClient['get']> = client.get('/x').headers({
    'x-a': {
      toString() {
        builder.cancel('setup');
        return 'v';
      },
    } as unknown as string,
    'x-b': {
      toString() {
        throw new Error('boom');
      },
    } as unknown as string,
  });
  const sending = builder.send().then(
    () => undefined,
    (error: unknown) => error,
  );
  const again = builder.cancel('again');
  await sending;
  expect(again).toBe('already_cancelled');
  expect(builder.cancel()).toBe('already_cancelled');

  // A reasonless cancel() that came first is not given the interceptor's reason.
  const reasonClient = new HTTPClient({
    adapter: new MockAdapter(),
    baseURL: 'http://api.test',
  });
  // eslint-disable-next-line prefer-const -- assigned after the interceptor that reads it
  let first: ReturnType<HTTPClient['get']>;
  reasonClient.addRequestInterceptor(() => {
    first.cancel();
    return { cancel: true, reason: 'I' };
  });
  first = reasonClient.get('/x');
  await first.send();
  expect(first.error?.cancelReason).toBeUndefined();
});

test('round 56: numeric IPv4 host entries, label null, and a FormData changed mid-upload', async () => {
  const client = new HTTPClient();
  // Read as the URL parser reads them - `127.0.0.1` - by the matcher too, so accepted.
  for (const pattern of ['2130706433', '0x7f000001']) {
    client.addResponseObserver(() => {}, { hosts: [pattern] })();
  }
  client.addResponseObserver(() => {}, { hosts: ['127.0.0.1'] })();

  // label: null in request options means no label, as null means unset elsewhere.
  const unlabelled = new HTTPClient({ adapter: new MockAdapter() }).get(
    'http://api.test/x',
    { label: null as unknown as string },
  );
  expect(unlabelled.state).toBe('pending');

  // A FormData changed mid-upload: an overrun is refused before it reaches the wire, and
  // a shortfall fails as the same non-retryable source mismatch.
  const received: number[] = [];
  const server = http.createServer((req, res) => {
    let bytes = 0;
    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
    });
    req.on('close', () => received.push(bytes));
    req.on('end', () => res.end('ok'));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    for (const change of ['grow', 'shrink'] as const) {
      const form = new FormData();
      form.append('a', 'x'.repeat(10));
      form.append('b', 'y'.repeat(10));
      form.append('c', 'z'.repeat(10));
      let hasChanged = false;
      const rejection = await new NodeAdapter()
        .send({
          requestURL: `http://127.0.0.1:${port}/`,
          method: 'POST',
          headers: {},
          body: form,
          onUploadProgress: (event) => {
            if (!hasChanged && event.loaded > 0) {
              hasChanged = true;
              if (change === 'grow') {
                form.append('d', 'w'.repeat(50));
              } else {
                form.delete('c');
              }
            }
          },
        })
        .then(
          (response) => response.errorCause,
          (error: unknown) => error as Error,
        );

      expect(rejection?.message).toMatch(/Content-Length/);
    }
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('hosts filters match a hostname with -- in a label, * included', async () => {
  const adapter = new MockAdapter();
  adapter.routes.get('/x', () => ({ status: 200 }));
  const client = new HTTPClient({ adapter });
  const seen: string[] = [];
  client.addResponseObserver(
    () => {
      seen.push('*');
    },
    { hosts: ['*'] },
  );
  client.addResponseObserver(
    () => {
      seen.push('exact');
    },
    { hosts: ['r3---sn-abc.googlevideo.com'] },
  );
  client.addResponseObserver(
    () => {
      seen.push('wildcard');
    },
    { hosts: ['**.googlevideo.com'] },
  );

  await client.get('http://r3---sn-abc.googlevideo.com/x').send();

  expect(seen.sort()).toEqual(['*', 'exact', 'wildcard']);
});

test("hosts: ['*'] matches any host a URL can carry", async () => {
  const adapter = new MockAdapter();
  adapter.routes.get('/x', () => ({ status: 200 }));
  const client = new HTTPClient({ adapter });
  const seen: string[] = [];
  client.addResponseObserver(
    (_response, request) => {
      seen.push(new URL(request.requestURL).hostname);
    },
    { hosts: ['*'] },
  );

  client.addResponseObserver(
    (_response, request) => {
      seen.push(`fqdn ${new URL(request.requestURL).hostname}`);
    },
    { hosts: ['*.'] },
  );

  for (const host of ['my_service', '-edge.example.com', 'api.example.com']) {
    await client.get(`http://${host}/x`).send();
  }

  expect(seen).toEqual([
    'my_service',
    'fqdn my_service',
    '-edge.example.com',
    'fqdn -edge.example.com',
    'api.example.com',
    'fqdn api.example.com',
  ]);
});

test('MockAdapter refuses a cookie maxAge that is not a number', async () => {
  const adapter = new MockAdapter();
  adapter.routes.get('/c', () => ({
    status: 200,
    cookies: { s: { value: '1', maxAge: Number.NaN } },
  }));
  const builder = new HTTPClient({ adapter, baseURL: 'http://api.test' }).get(
    '/c',
  );

  await builder.send();

  expect(builder.error?.code).toBe('adapter_error');
});

test('round 63: transport refusals are not retried, Mock honours a 0% cancel, a bad set-cookie is the adapter', async () => {
  // NodeAdapter: a header value Node refuses fails once.
  let hits = 0;
  const server = http.createServer((_req, res) => {
    hits++;
    res.end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const builder = new HTTPClient({
      adapter: new NodeAdapter(),
      retryPolicy: { strategy: 'fixed', maxRetryAttempts: 3, delayMS: 0 },
    })
      .get(`http://127.0.0.1:${port}/`)
      .headers({ authorization: 'Bearer tok\r\n' });
    await builder.send();
    expect(builder.attemptCount).toBe(1);
    expect(builder.error?.code).toBe('adapter_error');
    expect(hits).toBe(0);
  } finally {
    server.close();
  }

  // MockAdapter: a cancel from the 0% upload callback runs no route handler.
  const adapter = new MockAdapter();
  let handled = 0;
  adapter.routes.post('/charge', () => {
    handled++;
    return { status: 200 };
  });
  const mockClient = new HTTPClient({ adapter, baseURL: 'http://api.test' });
  const charge: ReturnType<HTTPClient['post']> = mockClient.post('/charge', {
    body: 'x',
    onUploadProgress: (event) => {
      if (event.progress === 0) {
        charge.cancel();
      }
    },
  });
  expect((await charge.send()).isCancelled).toBe(true);
  expect(handled).toBe(0);

  // A set-cookie value that is not a string is the adapter's malformed answer.
  const jarBuilder = new HTTPClient({
    baseURL: 'http://api.test',
    cookieJar: new CookieJar(),
    adapter: {
      getType: () => 'node',
      send: () =>
        Promise.resolve({
          status: 200,
          headers: { 'set-cookie': 5 } as unknown as Record<string, string>,
          body: null,
        }),
    },
  }).get('/x');
  await jarBuilder.send();
  expect(jarBuilder.error?.code).toBe('adapter_error');
  expect(jarBuilder.error?.cause?.message).not.toMatch(/Cookie jar/);
});

test('round 64: a missing URL matches no host, methods are copied, bodyContainsKeys needs a plain object', () => {
  // An interceptor whose context lost its requestURL does not pass a hosts filter.
  expect(
    matchesFilter({ hosts: ['api.example.com'] }, {}, 'initial', 'request'),
  ).toBe(false);
  expect(matchesFilter({ methods: ['GET'] }, {}, 'initial', 'request')).toBe(
    false,
  );

  // A methods list's own map is not called; a hole is refused.
  const client = new HTTPClient();
  const methods = ['CONNECT'];
  (methods as unknown as { map: unknown }).map = () => undefined;
  expect(() =>
    client.addRequestInterceptor((request) => request, { methods }),
  ).toThrow(TypeError);
  // eslint-disable-next-line no-sparse-arrays -- the hole is the point
  const sparse = [, 'GET'] as string[];
  expect(() =>
    client.addRequestInterceptor((request) => request, { methods: sparse }),
  ).toThrow(TypeError);

  // A binary body has no keys a bodyContainsKeys filter can match.
  expect(
    matchesFilter(
      { bodyContainsKeys: ['0'] },
      { body: new Uint8Array([1, 2, 3]) },
      'final',
      'response',
    ),
  ).toBe(false);
  expect(
    matchesFilter(
      { bodyContainsKeys: ['0'] },
      { body: { 0: 'x' } },
      'final',
      'response',
    ),
  ).toBe(true);
});

test('round 67: request builder validation, json(), the query kept as written, send() order', async () => {
  // A query already in the path is kept as written; params add to it, and override
  // only the keys they name.
  expect(
    buildURL('https://a.test', '/s?tag=a&tag=b&x[]=1&a=%E9&constructor=1', {
      page: 2,
    }),
  ).toBe('https://a.test/s?tag=a&tag=b&x[]=1&a=%E9&constructor=1&page=2');
  expect(buildURL('https://a.test', '/s?page=1&q=x', { page: 2 })).toBe(
    'https://a.test/s?q=x&page=2',
  );

  const client = new HTTPClient({
    adapter: new MockAdapter(),
    baseURL: 'http://api.test',
  });
  // params must be a plain object; a non-function callback and a non-string label throw.
  for (const options of [
    { params: new URLSearchParams('a=1') },
    { params: 'ab' },
    { params: 0 },
    { signal: '' },
    { onAttemptStart: 'nope' },
    { onDownloadProgress: 42 },
    { streamResponse: true },
    { label: 5 },
  ]) {
    expect(() => client.get('/x', options as never)).toThrow(TypeError);
  }

  // A fragment survives a second `#` when params are added.
  expect(buildURL('http://a.test', '/x?a=1#h#i', { b: 2 })).toBe(
    'http://a.test/x?a=1&b=2#h#i',
  );

  // A second send() says once-only, even when the first ended cancelled by a signal.
  const controller = new AbortController();
  controller.abort();
  const once = client.get('/x').signal(controller.signal);
  await once.send();
  const second = await once.send().then(
    () => undefined,
    (error: unknown) => error as Error,
  );
  expect(second?.message).toMatch(/only be called once/);
});

test('round 69: baseURL must be a string without a query or fragment', () => {
  for (const baseURL of [
    new URL('https://api.example.com'),
    123,
    'https://api.example.com/v1?key=abc',
    'https://api.example.com/#x',
  ]) {
    expect(
      () =>
        new HTTPClient({
          adapter: new MockAdapter(),
          baseURL: baseURL as string,
        }),
    ).toThrow();
  }
  const client = new HTTPClient({ adapter: new MockAdapter() });
  expect(() =>
    client.createSubClient({ baseURL: 'https://api.example.com?x=1' }),
  ).toThrow();
});

test('MockAdapter route mistakes found after the route ran are not retried', async () => {
  for (const response of [
    { status: 200, cookies: { a: { value: '1', maxAge: Number.NaN } } },
    { status: 200, headers: { 'set-cookie': [123] as unknown as string[] } },
  ]) {
    const adapter = new MockAdapter();
    let runs = 0;
    adapter.routes.get('/x', () => {
      runs++;
      return response;
    });
    const builder = new HTTPClient({
      adapter,
      baseURL: 'http://api.test',
      retryPolicy: { strategy: 'fixed', maxRetryAttempts: 3, delayMS: 0 },
    }).get('/x');

    const result = await builder.send();

    expect(runs).toBe(1);
    expect(builder.error?.code).toBe('adapter_error');
    expect(result.isNetworkError).toBe(false);
  }
});

test('round 71: a bracketed params key replaces its top-level key; single-value headers are strings', async () => {
  expect(
    buildURL('https://a.test', '/x?page[size]=10&page[number]=1&q=z', {
      'page[number]': 2,
    }),
  ).toBe('https://a.test/x?q=z&page%5Bnumber%5D=2');

  const adapter = new MockAdapter();
  adapter.routes.get('/h', () => ({
    status: 200,
    headers: { 'content-length': 2, 'content-type': 7 } as unknown as Record<
      string,
      string
    >,
    body: 'hi',
  }));
  const response = await new HTTPClient({ adapter, baseURL: 'http://api.test' })
    .get('/h')
    .send();

  expect(response.headers['content-length']).toBe('2');
  expect(response.status).toBe(200);
});

test('round 72: a retry interceptor changing only the scheme of a redirect target does not promote it to the credential scope', async () => {
  const scopes: string[] = [];
  let attemptsAtB = 0;
  const client = new HTTPClient({
    followRedirects: true,
    retryPolicy: { strategy: 'fixed', maxRetryAttempts: 1, delayMS: 0 },
    adapter: {
      getType: () => 'node',
      send: (request: AdapterRequest) => {
        if (request.requestURL.startsWith('https://a.test')) {
          return Promise.resolve({
            status: 302,
            headers: { location: 'http://b.test/hop' },
            body: null,
          });
        }
        scopes.push(new URL(request.initialURL ?? '').host);
        attemptsAtB++;
        return Promise.resolve({
          status: attemptsAtB === 1 ? 503 : 200,
          headers: {},
          body: null,
        });
      },
    },
  });
  client.addRequestInterceptor(
    (request) => ({
      ...request,
      requestURL: request.requestURL.replace('http://', 'https://'),
    }),
    { phases: ['retry'] },
  );

  await client.get('https://a.test/start').send();

  expect(scopes).toEqual(['a.test', 'a.test']);
});

test('round 73: a trailing-dot spelling of the redirect host selects no scope; a leading-bracket key is overridden', async () => {
  expect(buildURL(undefined, '/a?[x]=1&y=2', { x: 2 })).toBe('/a?y=2&x=2');

  const scopes: string[] = [];
  let attemptsAtB = 0;
  const client = new HTTPClient({
    followRedirects: true,
    retryPolicy: { strategy: 'fixed', maxRetryAttempts: 1, delayMS: 0 },
    adapter: {
      getType: () => 'node',
      send: (request: AdapterRequest) => {
        if (request.requestURL.startsWith('https://a.test')) {
          return Promise.resolve({
            status: 307,
            headers: { location: 'https://evil.example/next' },
            body: null,
          });
        }
        scopes.push(new URL(request.initialURL ?? '').host);
        attemptsAtB++;
        return Promise.resolve({
          status: attemptsAtB === 1 ? 503 : 200,
          headers: {},
          body: null,
        });
      },
    },
  });
  client.addRequestInterceptor(
    (request) => ({
      ...request,
      requestURL: request.requestURL.replace('evil.example/', 'evil.example./'),
    }),
    { phases: ['retry'] },
  );

  await client.get('https://a.test/start').send();

  expect(scopes).toEqual(['a.test', 'a.test']);
});

test('round 74: MockAdapter parity with a real server', async () => {
  const adapter = new MockAdapter();
  let seen: MockRequest | undefined;
  adapter.routes.post('/p', (req) => {
    seen = req;
    return { status: 200 };
  });
  adapter.routes.head('/h', () => ({ status: 200, body: { x: 1 } }));
  const client = new HTTPClient({ adapter, baseURL: 'http://api.test' });

  const form = new FormData();
  form.append('tag', 'a');
  form.append('tag', 'b');
  await client
    .post('/p', {
      body: form,
      params: {
        ids: Array.from({ length: 25 }, (_, i) => i),
        constructor: 'x',
      },
      headers: { cookie: 'a=hello%20world; b="quoted"' },
    })
    .send();

  expect(seen?.body).toMatchObject({ allFields: { tag: ['a', 'b'] } });
  // As Express reads it: qs's 20-item array limit applies.
  expect(Array.isArray(seen?.query.ids)).toBe(false);
  expect(Object.hasOwn(seen?.query ?? {}, 'constructor')).toBe(true);
  expect(seen?.headers.host).toBe('api.test');
  expect(seen?.headers['content-type']).toMatch(
    /^multipart\/form-data; boundary=/,
  );
  expect(seen?.cookies).toEqual({ a: 'hello world', b: 'quoted' });

  const head = await client.request('HEAD', '/h').send();
  expect(head.headers['content-type']).toBe('application/json');

  // Route mistakes: an injecting cookie shorthand, an impossible status.
  for (const response of [
    { status: 200, cookies: { session: 'abc; Domain=other.test' } },
    { status: 200, cookies: { 'x=y': 'z' } },
    { status: 50 },
  ]) {
    const bad = new MockAdapter();
    let didDownloadFinish = false;
    bad.routes.get('/b', () => response as never);
    const builder = new HTTPClient({
      adapter: bad,
      baseURL: 'http://api.test',
    }).get('/b', {
      onDownloadProgress: (event) => {
        didDownloadFinish ||= event.progress === 1;
      },
    });
    await builder.send();
    expect(builder.error?.code).toBe('adapter_error');
    expect(didDownloadFinish).toBe(false);
  }
});

test('round 75: an undefined params value keeps the path pair; mock sameSite/maxAge are checked', async () => {
  expect(buildURL('https://x', '/p?a=1&b=2', { a: undefined, b: 3 })).toBe(
    'https://x/p?a=1&b=3',
  );

  for (const cookie of [
    { value: 'v', sameSite: 'Lax; Path=/admin' },
    { value: 'v', maxAge: '5; Path=/y' },
  ]) {
    const adapter = new MockAdapter();
    adapter.routes.get('/c', () => ({
      status: 200,
      cookies: { sid: cookie as never },
    }));
    const builder = new HTTPClient({ adapter, baseURL: 'http://api.test' }).get(
      '/c',
    );
    await builder.send();
    expect(builder.error?.code).toBe('adapter_error');
  }
});

test('round 76: null ca refused, nested undefined params and encoded keys', () => {
  for (const config of [
    { ca: null },
    { ca: [null] },
    { mtls: { cert: 'c', key: 'k', ca: null } },
  ]) {
    expect(() => new NodeAdapter(config as never)).toThrow(/ca/);
  }
  expect(
    buildURL('https://x', '/x?filter[status]=active&page=2', {
      filter: { status: undefined },
    }),
  ).toBe('https://x/x?filter[status]=active&page=2');
  expect(buildURL('https://x', '/x?c%2B%2B=1', { 'c++': 2 })).toBe(
    'https://x/x?c%2B%2B=2',
  );
});

test('round 78: an empty params array or object clears the path pairs for its key', () => {
  expect(buildURL('http://x', '/s?tags=a&tags=b&page=2', { tags: [] })).toBe(
    'http://x/s?page=2',
  );
  expect(buildURL('http://x', '/s?filter[a]=1&q=z', { filter: {} })).toBe(
    'http://x/s?q=z',
  );
  expect(
    buildURL('http://x', '/s?filter[a]=1', { filter: { a: undefined } }),
  ).toBe('http://x/s?filter[a]=1');
});

test('round 80: undefined-only params arrays, repeated fetch Location, mock non-Latin-1 cookie, edge-hyphen public suffix', async () => {
  expect(buildURL('https://x.test', '/p?ids=7&x=1', { ids: [undefined] })).toBe(
    'https://x.test/p?ids=7&x=1',
  );

  const headers = new Headers();
  headers.append('location', '/a');
  headers.append('location', '/b');
  expect(extractFetchHeaders(headers).location).toBe('/a');

  const adapter = new MockAdapter();
  adapter.routes.get('/c', () => ({ status: 200, cookies: { sid: 'v€' } }));
  const builder = new HTTPClient({ adapter, baseURL: 'http://api.test' }).get(
    '/c',
  );
  await builder.send();
  expect(builder.error?.code).toBe('adapter_error');

  const jar = new CookieJar();
  jar.parseSetCookieHeader('s=1; Domain=x-.ck', 'https://x-.ck/');
  expect(jar.getCookieHeaderString('https://victim.x-.ck/')).toBe('');
});

test('round 81: a timed-out attempt is a timeout whatever the adapter rejects with; nextRetryAt is kept', async () => {
  let sends = 0;
  const hanging: HTTPAdapter = {
    getType: () => 'node',
    send: (request) => {
      sends++;
      return new Promise((_, reject) => {
        request.signal?.addEventListener('abort', () => {
          reject(new Error('socket hang up'));
        });
      });
    },
  };
  const timedOut = new HTTPClient({
    adapter: hanging,
    baseURL: 'http://x.test',
    timeout: 30,
    retryPolicy: { strategy: 'fixed', maxRetryAttempts: 1, delayMS: 1 },
  }).get('/a');
  const timedOutResponse = await timedOut.send();
  expect(sends).toBe(2);
  expect(timedOutResponse.isTimeout).toBe(true);
  expect(timedOut.error?.code).toBe('timeout');
  expect(timedOut.error?.isRetriesExhausted).toBe(true);

  const client = new HTTPClient({
    adapter: new RecordingAdapter(503),
    baseURL: 'http://x.test',
    retryPolicy: { strategy: 'fixed', maxRetryAttempts: 1, delayMS: 200 },
  });
  client.addResponseObserver(
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    },
    { phases: ['retry'] },
  );
  let nextRetryAt = 0;
  let secondStart = 0;
  await client
    .get('/a')
    .onAttemptEnd((event) => {
      nextRetryAt = event.nextRetryAt ?? nextRetryAt;
    })
    .onAttemptStart((event) => {
      if (event.attemptNumber === 2) {
        secondStart = Date.now();
      }
    })
    .send();
  expect(secondStart - nextRetryAt).toBeLessThan(150);
});

test('round 82: override apex for edge-hyphen hosts, a resolved transport error after the timer, a clock step during retry observers', async () => {
  const jar = new CookieJar({ publicSuffixes: { add: ['amazonaws.com'] } });
  jar.parseSetCookieHeader(
    'a=1; Domain=foo.s3.amazonaws.com',
    'https://-x.foo.s3.amazonaws.com/',
  );
  expect(jar.getCookieHeaderString('https://-x.foo.s3.amazonaws.com/')).toBe(
    'a=1',
  );

  let sends = 0;
  const resolving: HTTPAdapter = {
    getType: () => 'node',
    send: (request) => {
      sends++;
      return new Promise((resolve) => {
        request.signal?.addEventListener('abort', () => {
          resolve({
            status: 0,
            headers: {},
            body: null,
            isTransportError: true,
          });
        });
      });
    },
  };
  const timedOut = new HTTPClient({
    adapter: resolving,
    baseURL: 'http://x.test',
    timeout: 30,
    retryPolicy: { strategy: 'fixed', maxRetryAttempts: 1, delayMS: 1 },
  }).get('/a');
  const timedOutResponse = await timedOut.send();
  expect(sends).toBe(2);
  expect(timedOutResponse.isTimeout).toBe(true);
  expect(timedOut.error?.code).toBe('timeout');

  const client = new HTTPClient({
    adapter: new RecordingAdapter(503),
    baseURL: 'http://x.test',
    retryPolicy: { strategy: 'fixed', maxRetryAttempts: 1, delayMS: 50 },
  });
  const realNow = Date.now.bind(Date);
  client.addResponseObserver(
    () => {
      Date.now = () => realNow() - 3_600_000;
    },
    { phases: ['retry'] },
  );
  const startedAt = performance.now();
  try {
    const builder = client.get('/a');
    const pending = builder.send();
    const winner = await Promise.race([
      pending.then(() => 'done'),
      new Promise((resolve) => setTimeout(() => resolve('stuck'), 1000)),
    ]);
    if (winner === 'stuck') {
      builder.cancel();
      await pending;
    }
    expect(winner).toBe('done');
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(40);
  } finally {
    Date.now = realNow;
  }
});

test('round 83: a stream factory that fails after headers keeps the cookie and status; progress hooks guarded by the client; callback-less sinks report their bytes', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, {
      'set-cookie': 'sid=abc; Path=/',
      'content-length': '1000',
    });
    if (req.url === '/now') {
      res.end('x'.repeat(1000));
      return;
    }
    res.flushHeaders();
    setTimeout(() => res.end('x'.repeat(1000)), 400);
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const cases: Array<{
      factory: () => unknown;
      code: string;
      timeout?: number;
    }> = [
      {
        factory: () => {
          throw new Error('no disk');
        },
        code: 'stream_setup_error',
      },
      { factory: () => null, code: 'cancelled' },
      {
        factory: () => new Promise(() => {}),
        code: 'stream_setup_error',
        timeout: 100,
      },
    ];
    for (const { factory, code, timeout } of cases) {
      const jar = new CookieJar();
      const builder = new HTTPClient({
        adapter: new NodeAdapter(),
        baseURL,
        cookieJar: jar,
        ...(timeout ? { timeout } : {}),
      })
        .get('/slow')
        .streamResponse(factory as never);
      const response = await builder.send();
      expect(builder.error?.code).toBe(code as never);
      expect(jar.getCookieHeaderString(`${baseURL}/`)).toBe('sid=abc');
      if (code === 'stream_setup_error') {
        expect(response.status).toBe(200);
      }
    }

    const events: number[] = [];
    const chunks: unknown[] = [];
    const streamed = await new HTTPClient({
      adapter: new NodeAdapter(),
      baseURL,
    })
      .get('/now')
      .onDownloadProgress((event) => events.push(event.loaded))
      .streamResponse(
        () =>
          ({
            write: (chunk: unknown) => {
              chunks.push(chunk);
              return true;
            },
            end: (callback?: () => void) => callback?.(),
          }) as never,
      )
      .send();
    expect(streamed.isStreamed).toBe(true);
    expect(events.at(-1)).toBe(1000);
  } finally {
    server.close();
  }

  let sends = 0;
  const progressing: HTTPAdapter = {
    getType: () => 'node',
    send: (request) => {
      sends++;
      request.onDownloadProgress?.({ loaded: 2, total: 2, progress: 1 });
      return Promise.resolve({ status: 200, headers: {}, body: null });
    },
  };
  const reported: unknown[] = [];
  const onError = (event: Event): void => {
    reported.push((event as ErrorEvent).error);
    event.preventDefault();
  };
  globalThis.addEventListener('error', onError);
  try {
    const response = await new HTTPClient({
      adapter: progressing,
      baseURL: 'http://x.test',
      retryPolicy: { strategy: 'fixed', maxRetryAttempts: 2, delayMS: 1 },
    })
      .get('/a')
      .onDownloadProgress(() => {
        throw new Error('hook failed');
      })
      .send();
    expect(sends).toBe(1);
    expect(response.status).toBe(200);
    expect(response.isFailed).toBe(false);
    expect(reported).toHaveLength(1);
  } finally {
    globalThis.removeEventListener('error', onError);
  }
});

test('round 84: a cancel from the final download event of a chunked body keeps its cookie; a single Location with ", " is kept whole', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'set-cookie': 'sid=abc; Path=/' });
    res.write('he');
    res.end('llo');
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const jar = new CookieJar();
    const builder = new HTTPClient({
      adapter: new NodeAdapter(),
      baseURL,
      cookieJar: jar,
    }).get('/chunked');
    builder.onDownloadProgress((event) => {
      if (event.progress === 1) {
        builder.cancel();
      }
    });
    await builder.send();
    expect(builder.error?.code).toBe('cancelled');
    expect(jar.getCookieHeaderString(`${baseURL}/`)).toBe('sid=abc');
  } finally {
    server.close();
  }

  const single = new Headers({ location: '/files/Smith, John.pdf' });
  expect(extractFetchHeaders(single).location).toBe('/files/Smith, John.pdf');
  for (const [first, second] of [
    ['/a', '/b'],
    ['https://x.test/a', 'https://y.test/b'],
  ]) {
    const repeated = new Headers();
    repeated.append('location', first);
    repeated.append('location', second);
    expect(extractFetchHeaders(repeated).location).toBe(first);
  }
});

test('round 85: undispatched redirects, cross-origin Range, 303 body, Location heuristic, redirect request shape, adapter without detectedRedirectURL', async () => {
  /** Answers `/start` with a redirect to `location`, anything else with 200. */
  const redirecting = (
    status: number,
    location: string,
  ): HTTPAdapter & { requests: AdapterRequest[] } => {
    const requests: AdapterRequest[] = [];
    return {
      requests,
      getType: () => 'node',
      send: (request) => {
        requests.push(request);
        return Promise.resolve<AdapterResponse>(
          new URL(request.requestURL).pathname === '/start'
            ? { status, headers: { location }, body: null }
            : { status: 200, headers: {}, body: null },
        );
      },
    };
  };

  // A refused Location is detected, not followed.
  const refused = new HTTPClient({
    adapter: redirecting(302, 'ftp://files.test/x'),
    baseURL: 'http://a.test',
    followRedirects: true,
  }).get('/start');
  await refused.send();
  expect(refused.error?.code).toBe('request_setup_error');
  expect(refused.error?.wasRedirectFollowed).toBe(false);
  expect(refused.error?.detectedRedirectURL).toBe('ftp://files.test/x');

  // Range and conditional headers survive a cross-origin hop; a 303 drops a GET body.
  const crossAdapter = redirecting(302, 'http://cdn.test/asset');
  await new HTTPClient({
    adapter: crossAdapter,
    baseURL: 'http://a.test',
    followRedirects: true,
  })
    .get('/start')
    .headers({ range: 'bytes=1000-', 'if-none-match': '"v1"' })
    .send();
  expect(crossAdapter.requests[1].headers.range).toBe('bytes=1000-');
  expect(crossAdapter.requests[1].headers['if-none-match']).toBe('"v1"');

  const seeOther = redirecting(303, '/result');
  await new HTTPClient({
    adapter: seeOther,
    baseURL: 'http://a.test',
    followRedirects: true,
  })
    .get('/start')
    .text('payload')
    .send();
  expect(seeOther.requests[1].method).toBe('GET');
  expect(seeOther.requests[1].body ?? null).toBeNull();
  expect(seeOther.requests[1].headers['content-type']).toBeUndefined();

  // Only a scheme-and-authority or a path after ", " starts a second Location.
  expect(
    extractFetchHeaders(new Headers({ location: '/files/Smith, Re:notes.pdf' }))
      .location,
  ).toBe('/files/Smith, Re:notes.pdf');

  // Redirect interceptors see the request shape the initial phase does.
  const seen: Array<Record<string, unknown>> = [];
  const shapeClient = new HTTPClient({
    adapter: redirecting(302, '/next'),
    baseURL: 'http://a.test',
    followRedirects: true,
    includeAttemptHeader: true,
  });
  shapeClient.addRequestInterceptor(
    (request) => {
      seen.push({ ...request });
      return request;
    },
    { phases: ['initial', 'redirect'] },
  );
  await shapeClient.get('/start').send();
  expect(Object.keys(seen[1]).sort()).toEqual(Object.keys(seen[0]).sort());
  expect(Object.keys(seen[1].headers as object).sort()).toEqual(
    Object.keys(seen[0].headers as object).sort(),
  );

  // A redirect the client does not follow still names its target.
  const disabled = new HTTPClient({
    adapter: redirecting(302, '/x'),
    baseURL: 'http://a.test',
    followRedirects: false,
  }).get('/start');
  await disabled.send();
  expect(disabled.error?.code).toBe('redirect_disabled');
  expect(disabled.error?.detectedRedirectURL).toBe('http://a.test/x');
});

test('round 86: multipart names as fetch sends them, an unreadable file is not retried, Transfer-Encoding refused', async () => {
  const received: Array<{ field: string; filename: string }> = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('error', () => {});
    req.on('end', () => {
      void new Response(Buffer.concat(chunks), {
        headers: { 'content-type': req.headers['content-type'] ?? '' },
      })
        .formData()
        .then((form) => {
          for (const [field, value] of form.entries()) {
            received.push({
              field,
              filename: typeof value === 'string' ? '' : (value as File).name,
            });
          }
          res.end('ok');
        })
        .catch(() => res.end('bad'));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const client = new HTTPClient({ adapter: new NodeAdapter(), baseURL });
    const form = new FormData();
    form.append('a"b\\c', new File(['x'], '日本語 "v2".pdf'));
    form.append('cv', new File(['y'], 'résumé.pdf'));
    await client.post('/upload').formData(form).send();
    const viaNode = received.splice(0);
    await new HTTPClient({ adapter: new FetchAdapter(), baseURL })
      .post('/upload')
      .formData(form)
      .send();
    expect(viaNode).toEqual(received);
    expect(viaNode[1]).toEqual({ field: 'cv', filename: 'résumé.pdf' });

    const missing = new FormData();
    missing.append('f', Bun.file('/nonexistent/round-86'));
    const unreadable = client
      .put('/upload')
      .formData(missing)
      .retryPolicy({ strategy: 'fixed', maxRetryAttempts: 3, delayMS: 1 });
    await unreadable.send();
    expect(unreadable.error?.code).toBe('adapter_error');
    expect(unreadable.attemptCount).toBe(1);

    const framed = client
      .post('/upload')
      .headers({ 'transfer-encoding': 'chunked' })
      .text('hello');
    await framed.send();
    expect(framed.error?.code).toBe('adapter_error');
    expect(framed.attemptCount).toBe(1);
  } finally {
    server.close();
  }
});

test('round 87: a cancel before a detected redirect is followed names it; a 303 HEAD drops body headers', async () => {
  for (const cancelFrom of ['observer', 'attemptEnd'] as const) {
    const adapter = new MockAdapter();
    adapter.routes.get('/p', () => ({
      status: 302,
      headers: { location: '/next' },
    }));
    const client = new HTTPClient({
      adapter,
      baseURL: 'https://a.test',
      followRedirects: true,
    });
    const builder = client.get('/p');
    if (cancelFrom === 'observer') {
      client.addResponseObserver(
        () => {
          builder.cancel();
        },
        {
          phases: ['redirect'],
        },
      );
    } else {
      builder.onAttemptEnd(() => {
        builder.cancel();
      });
    }
    const response = await builder.send();
    expect(response.isCancelled).toBe(true);
    expect(response.wasRedirectDetected).toBe(true);
    expect(response.wasRedirectFollowed).toBe(false);
    expect(response.detectedRedirectURL).toBe('https://a.test/next');
  }

  const requests: AdapterRequest[] = [];
  await new HTTPClient({
    adapter: {
      getType: () => 'node',
      send: (request) => {
        requests.push(request);
        return Promise.resolve<AdapterResponse>(
          requests.length === 1
            ? { status: 303, headers: { location: '/y' }, body: null }
            : { status: 200, headers: {}, body: null },
        );
      },
    },
    baseURL: 'https://a.test',
    followRedirects: true,
  })
    .request('HEAD', '/p', {
      body: 'abc',
      headers: { 'content-encoding': 'gzip', 'content-length': '3' },
    })
    .send();
  expect(requests[1].headers['content-encoding']).toBeUndefined();
  expect(requests[1].headers['content-length']).toBeUndefined();
});

test('round 88: label and scope arguments are checked', async () => {
  const adapter = new MockAdapter();
  adapter.routes.get('/slow', async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { status: 200 };
  });
  const client = new HTTPClient({ adapter, baseURL: 'http://a.test' });
  const unlabeled = client.get('/slow');
  const pending = unlabeled.send();

  expect(() => client.cancelAllWithLabel(undefined as never)).toThrow(
    TypeError,
  );
  expect(() => client.cancelOwnWithLabel('  ')).toThrow(/non-empty/);
  expect(() => client.listRequests({ scope: 'mine' as never })).toThrow(
    TypeError,
  );
  expect(() => client.listRequests({ label: 5 as never })).toThrow(TypeError);
  expect(client.listRequests().count).toBe(1);

  const response = await pending;
  expect(response.isCancelled).toBe(false);
});

test('round 89: a followed hop that redirects to its own URL still counts as followed when cancelled', async () => {
  const adapter = new MockAdapter();
  adapter.routes.get('/a', () => ({
    status: 302,
    headers: { location: '/b' },
  }));
  adapter.routes.get('/b', () => ({
    status: 302,
    headers: { location: '/b' },
  }));
  const builder = new HTTPClient({
    adapter,
    baseURL: 'http://api.test',
    followRedirects: true,
  }).get('/a');
  builder.onAttemptEnd((event) => {
    if (event.attemptNumber === 2) {
      builder.cancel();
    }
  });
  const response = await builder.send();
  expect(response.isCancelled).toBe(true);
  expect(response.redirectHistory).toEqual(['http://api.test/b']);
  expect(response.wasRedirectFollowed).toBe(true);
  expect(response.detectedRedirectURL).toBe('http://api.test/b');
});

test('round 90: IP literals with a port or path are no host, removals below a domain widen nothing, domain clears reach suffix tenants', () => {
  for (const entry of [
    '127.0.0.1:8080',
    'x@127.0.0.1',
    '127.0.0.1/evil.com',
    '127.0.0.1#x',
    '[::1]:8080',
  ]) {
    expect(normalizeDomain(entry)).toBe('');
  }
  expect(normalizeDomain('127.0.0.1')).toBe('127.0.0.1');
  expect(normalizeDomain('[::1]')).toBe('::1');
  expect(
    matchesOriginList('https://192.168.1.10:9999', ['192.168.1.10:8080']),
  ).toBe(false);
  expect(validateConfigEntry('192.168.001.010', 'domain').info).toContain(
    '192.168.1.8',
  );

  const narrowed = new CookieJar({
    publicSuffixes: { remove: ['a.example.com'] },
  });
  narrowed.parseSetCookieHeader(
    'a=1; Domain=example.com',
    'https://x.a.example.com/',
  );
  expect(narrowed.getCookieHeaderString('https://x.a.example.com/')).toBe(
    'a=1',
  );
  expect(narrowed.clear('example.com', 'domain')).toBe(1);

  const jar = new CookieJar();
  jar.parseSetCookieHeader('s=1', 'https://a.github.io/');
  jar.parseSetCookieHeader('t=1', 'http://sub.localhost/');
  expect(jar.clear('github.io', 'domain')).toBe(1);
  expect(jar.clear('localhost', 'domain')).toBe(1);
  expect(() => jar.clear('example.com', 'Domain' as never)).toThrow(TypeError);
});

test('round 91: clear arguments checked, nested private suffixes kept, IP entry info, dropped-body headers', async () => {
  const jar = new CookieJar();
  jar.parseSetCookieHeader('a=1', 'https://a.example.com/');
  jar.parseSetCookieHeader('b=1', 'https://bucket1.s3.amazonaws.com/');
  jar.parseSetCookieHeader('c=1', 'https://www.amazonaws.com/');
  expect(() => jar.clear(undefined as never, 'domain')).toThrow(TypeError);
  expect(() => jar.clear(null as never, 'domain')).toThrow(TypeError);
  expect(() => (jar.clear as (host: string) => number)('example.com')).toThrow(
    TypeError,
  );
  expect(jar.getAllCookies()).toHaveLength(3);
  expect(jar.clear('www.amazonaws.com', 'domain')).toBe(1);
  expect(jar.getCookieHeaderString('https://bucket1.s3.amazonaws.com/')).toBe(
    'b=1',
  );

  expect(validateConfigEntry('192.168.1.08', 'domain').valid).toBe(false);
  expect(validateConfigEntry('2001:DB8:0:0::1', 'domain').info).toBeUndefined();
  expect(
    validateConfigEntry('::ffff:127.0.0.1', 'domain').info,
  ).toBeUndefined();

  const requests: AdapterRequest[] = [];
  await new HTTPClient({
    adapter: {
      getType: () => 'node',
      send: (request) => {
        requests.push(request);
        return Promise.resolve<AdapterResponse>(
          requests.length === 1
            ? { status: 302, headers: { location: '/y' }, body: null }
            : { status: 200, headers: {}, body: null },
        );
      },
    },
    baseURL: 'https://a.test',
    followRedirects: true,
  })
    .post('/p')
    .headers({ 'content-language': 'fr', 'content-location': '/doc' })
    .text('x')
    .send();
  expect(requests[1].headers['content-language']).toBeUndefined();
  expect(requests[1].headers['content-location']).toBeUndefined();
});

test('round 92: IPv4 entries read by the URL parser in origins and shorthand; uppercase mapped IPv6', () => {
  expect(validateConfigEntry('http://192.168.1.08', 'origin').valid).toBe(
    false,
  );
  expect(
    validateConfigEntry('http://192.168.001.010', 'origin').info,
  ).toContain('192.168.1.8');
  expect(validateConfigEntry('10.1', 'domain').info).toContain('10.0.0.1');
  expect(validateConfigEntry('0x7f.1', 'domain').info).toContain('127.0.0.1');
  expect(validateConfigEntry('10.0.0.1', 'domain').info).toBeUndefined();
  expect(validateConfigEntry('example.com', 'domain').valid).toBe(true);
  expect(validateConfigEntry('[::FFFF:127.0.0.1]', 'domain').valid).toBe(true);
  expect(validateConfigEntry('::FFFF:127.0.0.1', 'domain').valid).toBe(true);
});

test('round 93: IPv4-looking entries with userinfo or a path are refused; a padded default port matches', () => {
  for (const entry of [
    'user@10.0.0.1',
    '10.0.0.1/x.5',
    '10.0.0.1?a.1',
    '10.0.0.1#.1',
    '10.0.0.1\\x.1',
  ]) {
    expect(validateConfigEntry(entry, 'domain').valid).toBe(false);
    expect(validateConfigEntry(`http://${entry}`, 'origin').valid).toBe(false);
  }
  expect(
    matchesOriginList('http://example.com', ['http://example.com:080']),
  ).toBe(true);
  expect(matchesOriginList('http://10.0.0.1', ['http://10.0.0.1:080'])).toBe(
    true,
  );
});

test('round 94: single-number and fullwidth IPv4 entries are read as the URL parser reads them', () => {
  for (const entry of ['2130706433', '0x7f000001', '017700000001']) {
    expect(validateConfigEntry(entry, 'domain').info).toContain('127.0.0.1');
    expect(normalizeDomain(entry)).toBe('127.0.0.1');
    expect(matchesOriginList('http://127.0.0.1', [entry])).toBe(true);
  }
  expect(validateConfigEntry('*.127.0.0.1', 'origin').valid).toBe(false);
  expect(validateConfigEntry('*.127.0.0.1', 'domain').valid).toBe(false);
  expect(
    validateConfigEntry('１９２.１６８.００１.０１０', 'domain').info,
  ).toContain('192.168.1.8');
  expect(validateConfigEntry('192.168.1.0８', 'domain').valid).toBe(false);
  expect(validateConfigEntry('example.com', 'domain').valid).toBe(true);
  expect(normalizeDomain('example.com')).toBe('example.com');
});

test('round 95: only fullwidth ASCII is mapped before reading an IP; fullwidth-only differences noted; numeric wildcard tails refused', () => {
  for (const host of ['127․0․0․1', '1﹒2.3.4', '⒈2.3.4']) {
    expect(normalizeDomain(host)).not.toBe('127.0.0.1');
    expect(validateConfigEntry(host, 'domain').valid).toBe(false);
  }
  expect(normalizeDomain('：：1')).toBe('');
  expect(validateConfigEntry('fe80：：1', 'domain').valid).toBe(false);
  expect(validateConfigEntry('１２７.0.0.1', 'domain').info).toContain(
    '127.0.0.1',
  );
  expect(normalizeDomain('１２７.0.0.1')).toBe('127.0.0.1');
  expect(validateConfigEntry('*.2.3.4', 'domain').valid).toBe(false);
  expect(validateConfigEntry('*.0.0.1', 'domain').valid).toBe(false);
  expect(validateConfigEntry('*.example.com', 'domain').valid).toBe(true);
});

test('round 96: IPv4 read by the URL parser itself - percent and IDNA spellings, refused hosts match nothing', () => {
  for (const entry of ['127.0.0.%31', '127.0.0.①', '127.0.0.𝟏']) {
    expect(validateConfigEntry(entry, 'domain').info).toContain('127.0.0.1');
    expect(normalizeDomain(entry)).toBe('127.0.0.1');
  }
  expect(validateConfigEntry('127.0.0.𝟎𝟖', 'domain').valid).toBe(false);
  for (const host of ['1.2.3.08', 'a.2.3.4']) {
    expect(normalizeDomain(host)).toBe('');
    expect(matchesDomainList(host, [host])).toBe(false);
  }
  expect(matchesWildcardDomain('a.2.3.4', '*.2.3.4')).toBe(false);
  expect(validateConfigEntry('127.0.0.1.', 'domain').info).toBeUndefined();
  expect(normalizeDomain('example.com')).toBe('example.com');
  expect(matchesDomainList('api.example.com', ['*.example.com'])).toBe(true);
});

test('round 97: non-special schemes keep opaque hosts; every special scheme drops its default port', () => {
  expect(matchesOriginList('foo://a.2.3.4', ['foo://a.2.3.4'])).toBe(true);
  expect(matchesOriginList('foo://127.0.0.1', ['foo://2130706433'])).toBe(
    false,
  );
  expect(validateConfigEntry('foo://a.2.3.4', 'origin').valid).toBe(true);
  expect(normalizeOrigin('chrome-extension://123')).toBe(
    'chrome-extension://123',
  );
  expect(normalizeOrigin('http://2130706433')).toBe('http://127.0.0.1');

  expect(normalizeOrigin('wss://x.com:443')).toBe('wss://x.com');
  expect(normalizeOrigin('wss://x.com:0443')).toBe('wss://x.com');
  expect(normalizeOrigin('ws://x.com:80')).toBe('ws://x.com');
  expect(matchesOriginList('wss://x.com', ['wss://x.com:443'])).toBe(true);
  expect(normalizeOrigin('wss://x.com:8443')).toBe('wss://x.com:8443');
});

test('round 98: non-special-scheme IPv6 origins match; non-ASCII opaque hosts are refused', () => {
  expect(normalizeOrigin('foo://[::1]')).toBe('foo://[::1]');
  expect(
    matchesOriginList('capacitor://[2001:db8::1]', [
      'capacitor://[2001:db8::1]',
    ]),
  ).toBe(true);
  expect(validateConfigEntry('foo://bücher.example', 'origin').valid).toBe(
    false,
  );
  expect(validateConfigEntry('foo://example.com', 'origin').valid).toBe(true);
  expect(matchesOriginList('foo://a.2.3.4', ['foo://a.2.3.4'])).toBe(true);
});
