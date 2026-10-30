import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setSystemTime,
  spyOn,
  test,
} from 'bun:test';
import vm from 'node:vm';
import * as http from 'node:http';
import * as zlib from 'node:zlib';
import { PassThrough, Writable } from 'node:stream';
import * as net from 'node:net';
import type { AddressInfo } from 'node:net';
import { HTTPClient } from './http-client';
import type { HTTPSubClient } from './http-client';
import {
  buildURL,
  derivedRedirectFields,
  extractFetchHeaders,
  isCrossOrigin,
  matchesFilter,
  readHostPattern,
  mergeHeaders,
  parseContentType,
  reportedRedirectTarget,
  stripCrossOriginURLCredentials,
} from './utils';
import * as httpUtils from './utils';
import {
  ADAPTER_ERROR_CARRIER_KEY,
  DEFAULT_MAX_RESPONSE_BYTES,
  EFFECTIVE_REQUEST_HEADERS_KEY,
  NON_RETRYABLE_HTTP_ADAPTER_ERROR_FLAG,
  RESPONSE_DECODE_ERROR_KEY,
  RESPONSE_STREAM_ABORT_FLAG,
  STREAM_ABORT_HEADERS_KEY,
  STREAM_ABORT_STATUS_KEY,
} from './consts';
import { CookieJar } from './cookie-jar';
import { matchesHostPattern } from './test-helpers/host-pattern';
import {
  isBrowserRestrictedHeader,
  materializeRequestHeaders,
} from './internal/header-utils';
import { knownBodyByteLength } from './internal/progress';
import { readBinaryByteLength } from '../internal/binary-view';
import { utf8ByteLength } from './internal/utf8-length';
import { createResponseBodySource } from './internal/response-decoding';
import {
  isIdentityContentEncoding,
  parseContentLength,
} from './internal/response-limit';
import { sleep } from '../sleep';
import {
  matchesCORSCredentialsList,
  matchesDomainList,
  matchesOriginList,
  matchesWildcardDomain,
  matchesWildcardOrigin,
  normalizeOrigin,
  validateConfigEntry,
} from '../domain-utils/domain-utils';
import {
  checkDNSLength,
  isIPv6,
  normalizeDomain,
} from '../domain-utils/helpers';
import { MockAdapter } from './adapters/mock-adapter';
import { errorText } from './test-helpers/error-text';
import type {
  MockCookieOptions,
  MockRequest,
  MockResponse,
} from './adapters/mock-adapter';
import { NodeAdapter } from './adapters/node-adapter';
import { getRevocationFixtures } from './test-helpers/https-test-server';
import { FetchAdapter } from './adapters/fetch-adapter';
import { XHRAdapter } from './adapters/xhr-adapter';
import type {
  AdapterRequest,
  CancelResult,
  AdapterResponse,
  AdapterType,
  HTTPAdapter,
  HTTPMethod,
  HTTPResponse,
  InterceptedRequest,
  InterceptorPhaseName,
  RequestInterceptor,
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
  expect(matchesFilter({ methods: ['GET'] }, { method: '' }, 'request')).toBe(
    false,
  );
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
    '[HTTPClient] Interceptor returned a request whose method is not a valid HTTP method name (got a string with characters an HTTP token does not allow).',
  ]);
  expect(adapter.requests).toHaveLength(0);
});

test('a filter whose methods is not an array of strings is refused when registered', () => {
  const client = new HTTPClient({ adapter: new RecordingAdapter(200) });
  // As a JS caller might write it: read as a string, it would match by substring.
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
    'HTTPClient error observer filter methods[0] is not a string (got number)',
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
    ).toThrow(`HTTPClient request interceptor filter methods[0] ${problem}`);
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
  // The caller's body is copied as it is handed over, so the body the filter cannot read
  // is one an earlier interceptor returned.
  client.addRequestInterceptor((request) => ({ ...request, body }));
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

  const response = await client.post('/x', { body: { data: 1 } }).send();

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
  // A string would match by substring: 'initial,retry' would run in both phases.
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
    'HTTPClient response observer filter statusCodes[0] must be a number (got string)',
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
    `HTTPClient request interceptor filter phases[0] is not one of 'initial', 'retry', 'redirect'`,
  );
  expect(() =>
    client.addErrorObserver(() => undefined, { phases: ['redirect' as never] }),
  ).toThrow('HTTPClient error observer filter phases[0] is not one of');
  expect(() =>
    client.addRequestInterceptor((request) => request, {
      schemes: ['HTTPS' as never],
    }),
  ).toThrow('HTTPClient request interceptor filter schemes[0] is not one of');
  expect(() =>
    client.addResponseObserver(() => undefined, {
      contentTypes: ['xml' as never],
    }),
  ).toThrow(
    'HTTPClient response observer filter contentTypes[0] is not one of',
  );
});

test('a filter getter that throws is refused as a TypeError naming the field', () => {
  const client = new HTTPClient({ adapter: new RecordingAdapter(200) });
  const boom = new Error('getter boom');
  class Filter {
    public get note(): string {
      throw boom;
    }

    public get hosts(): string[] {
      throw boom;
    }
  }

  for (const filter of [
    // A field the kind does not take, read only to check it is absent.
    Object.defineProperty(new Filter(), 'hosts', { value: undefined }),
    // A field the kind does take.
    Object.defineProperty(new Filter(), 'note', { value: undefined }),
  ]) {
    let caught: unknown;
    try {
      client.addRequestInterceptor((request) => request, filter);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TypeError);
    expect((caught as Error).message).toMatch(
      /^HTTPClient request interceptor filter "(note|hosts)" field could not be read$/,
    );
    expect((caught as Error).cause).toBe(boom);
  }
});

test('a throwing methods getter, or a filter whose fields cannot be listed, is refused as a TypeError', () => {
  const client = new HTTPClient({ adapter: new RecordingAdapter(200) });
  const boom = new Error('trap boom');
  const cases: Array<[object, string]> = [
    [
      {
        get methods(): string[] {
          throw boom;
        },
      },
      'HTTPClient request interceptor filter "methods" field could not be read',
    ],
    [
      new Proxy(
        {},
        {
          ownKeys: () => {
            throw boom;
          },
        },
      ),
      'HTTPClient request interceptor filter fields could not be read',
    ],
    [
      // A prototype that looks like a realm's root, whose trap throws for a field.
      Object.create(
        new Proxy(
          Object.fromEntries(
            [
              'hasOwnProperty',
              'isPrototypeOf',
              'propertyIsEnumerable',
              'toString',
              'valueOf',
            ].map((name) => [name, () => undefined]),
          ),
          {
            getPrototypeOf: () => null,
            getOwnPropertyDescriptor: (target, key) => {
              if (key === 'methods') {
                throw boom;
              }
              return Reflect.getOwnPropertyDescriptor(target, key);
            },
          },
        ),
      ) as object,
      'HTTPClient request interceptor filter "methods" field could not be read',
    ],
  ];

  for (const [filter, message] of cases) {
    let caught: unknown;
    try {
      client.addRequestInterceptor((request) => request, filter);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TypeError);
    expect((caught as Error).message).toBe(message);
    expect((caught as Error).cause).toBe(boom);
  }
});

test('a filter list is read no further than the entry it is refused at', () => {
  const client = new HTTPClient({ adapter: new RecordingAdapter(200) });
  const read: number[] = [];
  const hosts = new Proxy(['api.example.com', 42, 'never.example.com'], {
    get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) {
        read.push(Number(key));
      }
      return Reflect.get(target, key, receiver) as unknown;
    },
  });

  expect(() =>
    client.addRequestInterceptor((request) => request, {
      hosts: hosts as never,
    }),
  ).toThrow('HTTPClient request interceptor filter hosts[1] must be a string');
  expect(read).toEqual([0, 1]);
});

test('a filter list whose length is no array length is refused without being read', () => {
  const client = new HTTPClient({ adapter: new RecordingAdapter(200) });
  for (const length of [Number.POSITIVE_INFINITY, 1.5, -1, 'x']) {
    let reads = 0;
    const hosts = new Proxy([] as string[], {
      get(target, key, receiver) {
        if (key === 'length') {
          return length;
        }
        reads++;
        return Reflect.get(target, key, receiver) as unknown;
      },
      has: () => {
        reads++;
        return true;
      },
    });

    expect(() =>
      client.addRequestInterceptor((request) => request, {
        hosts: hosts,
      }),
    ).toThrow(
      'HTTPClient request interceptor filter hosts has no array length',
    );
    expect(reads).toBe(0);
  }
});

test('a misspelled config or request option is refused rather than read as absent', () => {
  const adapter = new RecordingAdapter(200);
  const client = new HTTPClient({ adapter, baseURL: 'http://example.test' });

  expect(
    () => new HTTPClient({ adapter, folowRedirects: true } as never),
  ).toThrow('HTTPClient config has no "folowRedirects" field');
  expect(() => client.createSubClient({ timout: 5 } as never)).toThrow(
    'HTTPClient createSubClient config has no "timout" field',
  );
  expect(() => client.get('/x', { timout: 5 } as never)).toThrow(
    'HTTPRequestOptions has no "timout" field',
  );
  expect(() => client.get('/x', 'fast' as never)).toThrow(
    'HTTPRequestOptions must be an object (got string)',
  );
  expect(() => new NodeAdapter({ decompres: false } as never)).toThrow(
    'NodeAdapter config has no "decompres" field',
  );
  expect(
    () =>
      new NodeAdapter({
        mtls: { cert: 'c', key: 'k', passphrse: 'p' },
      } as never),
  ).toThrow('NodeAdapter mtls has no "passphrse" field');
  expect(
    () => new NodeAdapter({ rejectUnauthorized: 'false' } as never),
  ).toThrow('NodeAdapter rejectUnauthorized must be a boolean (got string)');
  expect(() => new NodeAdapter({ socketPath: '' })).toThrow(
    'NodeAdapter socketPath must be a non-empty string (got an empty string)',
  );
  expect(() => new NodeAdapter({ servername: 5 } as never)).toThrow(
    'NodeAdapter servername must be a string (got number)',
  );
  expect(() => new NodeAdapter({ mtls: 'cert.pem' } as never)).toThrow(
    'NodeAdapter mtls must be an object with cert and key (got string)',
  );
  expect(() => new NodeAdapter({ mtls: { cert: 'pem' } } as never)).toThrow(
    'NodeAdapter mtls.key must be PEM text or bytes (got undefined)',
  );
  expect(() => new NodeAdapter({ mtls: { cert: ' ', key: 'pem' } })).toThrow(
    'NodeAdapter mtls.cert is empty',
  );
  expect(() => new NodeAdapter(null as never)).toThrow(
    'NodeAdapter config must be an object (got null)',
  );
  expect(
    () =>
      new NodeAdapter({
        mtls: { cert: 'pem', key: Buffer.from('key') },
        servername: '',
        rejectUnauthorized: true,
      }),
  ).not.toThrow();
  expect(() => new HTTPClient({ adapter: {} as never })).toThrow(
    'HTTPClient adapter must be an object with getType() and send() methods (got object)',
  );
  expect(() => new MockAdapter({ onHandlerError: 'x' } as never)).toThrow(
    'MockAdapter onHandlerError must be a function (got string)',
  );
  expect(() => new CookieJar({ publicSufixes: {} } as never)).toThrow(
    'CookieJar options has no "publicSufixes" field',
  );

  expect(
    () =>
      new HTTPClient({
        adapter,
        retryPolicy: { strategy: 'fixed', maxRetryAttemps: 0 } as never,
      }),
  ).toThrow('HTTPClient retryPolicy has no "maxRetryAttemps" field');
  expect(() =>
    client
      .get('/x')
      .retryPolicy({ strategy: 'exponential', facter: 2 } as never),
  ).toThrow('HTTPClient retryPolicy has no "facter" field');
  expect(() =>
    client
      .get('/x')
      .retryPolicy({ strategy: 'exponential', delayMS: 5 } as never),
  ).toThrow('HTTPClient retryPolicy has no "delayMS" field');

  expect(() => client.listRequests({ lable: 'search' } as never)).toThrow(
    'HTTPClient.listRequests() filter has no "lable" field',
  );
  expect(() => client.listRequests({ scop: 'all' } as never)).toThrow(
    'HTTPClient.listRequests() filter has no "scop" field',
  );
  expect(() => client.listRequests('all' as never)).toThrow(
    'HTTPClient.listRequests() filter must be an object (got string)',
  );

  // A key that is no option name is not written into the refusal.
  let refusal: unknown;
  try {
    client.get('/x', { 'Bearer secret-token': 1 } as never);
  } catch (error) {
    refusal = error;
  }
  expect((refusal as Error).message).toStartWith(
    'HTTPRequestOptions has no field by that name',
  );
  expect((refusal as Error).message).not.toContain('secret-token');

  // An unknown field left unset would be read as absent either way, and is let through.
  expect(() =>
    client.get('/x', { timout: undefined, extra: null } as never),
  ).not.toThrow();

  // Every documented field, and a sub-client's strategy, is still taken.
  expect(() =>
    client.createSubClient({ timeout: 5, defaultHeadersStrategy: 'merge' }),
  ).not.toThrow();
  expect(() => client.get('/x', { timeout: 5, label: 'l' })).not.toThrow();
});

test('a config or options argument that is not an object is refused rather than read as empty', () => {
  const client = new HTTPClient({ adapter: new RecordingAdapter(200) });

  // The base URL passed where the config belongs would build a client with none.
  expect(() => new HTTPClient('https://api.test' as never)).toThrow(
    'HTTPClient config must be an object (got string)',
  );
  expect(() => new HTTPClient(null as never)).toThrow(
    'HTTPClient config must be an object (got null)',
  );
  expect(() => client.createSubClient([] as never)).toThrow(
    'HTTPClient createSubClient config must be an object (got an array)',
  );
  expect(() => client.createSubClient(null as never)).toThrow(
    'HTTPClient createSubClient config must be an object (got null)',
  );
  // The suffix list given where `{ publicSuffixes: { add } }` belongs.
  expect(() => new CookieJar(['corp.internal'] as never)).toThrow(
    'CookieJar options must be an object (got an array)',
  );
  expect(() => new MockAdapter(100 as never)).toThrow(
    'MockAdapter config must be an object (got number)',
  );
  expect(() => new MockAdapter((() => undefined) as never)).toThrow(
    'MockAdapter config must be an object (got function)',
  );

  // `null` is no options where it always was.
  expect(() => new CookieJar(null as never)).not.toThrow();
  expect(() => new MockAdapter(null as never)).not.toThrow();
  expect(() => client.get('/x', null as never)).not.toThrow();
  expect(() => client.listRequests(null as never)).not.toThrow();
});

test('a publicSuffixes field it does not take is refused without its key written out unless it is a name', () => {
  expect(
    () => new CookieJar({ publicSuffixes: { ad: ['corp.internal'] } } as never),
  ).toThrow('publicSuffixes has no "ad" field (it takes add, remove)');

  let refusal: unknown;
  try {
    new CookieJar({
      publicSuffixes: { 'Bearer secret-token': [] },
    } as never);
  } catch (error) {
    refusal = error;
  }
  expect((refusal as Error).message).toStartWith(
    'publicSuffixes has no field by that name',
  );
  expect((refusal as Error).message).not.toContain('secret-token');
});

test('a cancel reason or request ID that is not a string is refused rather than dropped', () => {
  const client = new HTTPClient({ adapter: new RecordingAdapter(200) });

  expect(() => client.cancel(123 as never)).toThrow(
    'HTTPClient.cancel() requestID must be a string (got number)',
  );
  expect(() => client.cancel('id', { why: 'logout' } as never)).toThrow(
    'HTTPClient.cancel() reason must be a string (got object)',
  );
  expect(() => client.cancelAll(5 as never)).toThrow(
    'HTTPClient.cancelAll() reason must be a string (got number)',
  );
  expect(() => client.cancelOwn(null as never)).toThrow(
    'HTTPClient.cancelOwn() reason must be a string (got null)',
  );
  expect(() => client.cancelAllWithLabel('l', 5 as never)).toThrow(
    'HTTPClient.cancelAllWithLabel() reason must be a string (got number)',
  );
  expect(() => client.cancelOwnWithLabel('l', 5 as never)).toThrow(
    'HTTPClient.cancelOwnWithLabel() reason must be a string (got number)',
  );

  const builder = client.get('/x');
  expect(() => builder.cancel(7 as never)).toThrow(
    'HTTPRequestBuilder.cancel() reason must be a string (got number)',
  );
  // Refused, not applied: the builder can still be cancelled, or sent.
  expect(builder.state).toBe('pending');
  expect(builder.cancel('logout')).toBe('cancelled');
  expect(client.cancelAll()).toBe(0);
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
    `HTTPClient sub-client defaultHeadersStrategy must be 'replace' or 'merge' (got an unknown strategy)`,
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

test("a JSON body's rawBody is the value sent, read from the caller's body once", async () => {
  // A getter answering differently on each read: the observers' deep copy and the
  // serialization each read it, so `rawBody` said one thing and the bytes another.
  const adapter = new RecordingAdapter(200);
  const client = new HTTPClient({ adapter, baseURL: 'http://example.test' });
  let reads = 0;
  const body = {
    get token(): string {
      reads++;
      return `t${reads}`;
    },
    when: new Date(0),
  };
  const observed: unknown[] = [];
  client.addResponseObserver((_response, request) => {
    observed.push(request.rawBody);
  });

  const response = await client.post('/x').json(body).send();

  expect(response.status).toBe(200);
  expect(reads).toBe(1);
  expect(adapter.requests[0]?.body).toBe(
    '{"token":"t1","when":"1970-01-01T00:00:00.000Z"}',
  );
  expect(observed).toEqual([{ token: 't1', when: '1970-01-01T00:00:00.000Z' }]);
});

test('a JSON body that serializes to nothing is sent without a JSON content type', async () => {
  const adapter = new RecordingAdapter(200);
  const client = new HTTPClient({ adapter, baseURL: 'http://example.test' });
  const observed: Array<Record<string, string | string[]>> = [];
  client.addResponseObserver((_response, request) => {
    observed.push(request.headers);
  });

  const response = await client
    .post('/x')
    .json({ toJSON: () => undefined })
    .send();

  expect(response.status).toBe(200);
  expect(adapter.requests[0]?.body).toBeNull();
  expect(adapter.requests[0]?.headers['content-type']).toBeUndefined();
  expect(observed[0]?.['content-type']).toBeUndefined();
});

test('a MockAdapter route body that serializes to nothing is answered without a JSON content type', async () => {
  const adapter = new MockAdapter();
  adapter.routes.get('/x', () => ({
    status: 200,
    body: { toJSON: () => undefined },
  }));
  const client = new HTTPClient({ adapter, baseURL: 'http://example.test' });

  const response = await client.get('/x').send();

  expect(response.status).toBe(200);
  expect(response.headers['content-type']).toBeUndefined();
  expect(response.body).toBeNull();
});

test("an observer redacting a byte or form body's rawBody in place leaves the body sent alone", async () => {
  const adapter = new RecordingAdapter(200);
  const client = new HTTPClient({ adapter, baseURL: 'http://example.test' });
  client.addResponseObserver((_response, request) => {
    const rawBody = request.rawBody;
    if (rawBody instanceof Uint8Array) {
      rawBody.fill(0);
    } else if (rawBody instanceof FormData) {
      rawBody.set('secret', 'redacted');
    }
  });
  const form = new FormData();
  form.set('secret', 's3cret');

  await client
    .post('/bytes')
    .body(new Uint8Array([1, 2, 3]))
    .send();
  await client.post('/form').formData(form).send();

  expect(adapter.requests[0]?.body).toEqual(new Uint8Array([1, 2, 3]));
  expect((adapter.requests[1]?.body as FormData).get('secret')).toBe('s3cret');
});

test('with no observer registered no body is parsed back or copied, even where the adapter reports its headers', async () => {
  let calls = 0;
  const adapter: HTTPAdapter = {
    getType: () => 'node',
    send: () => {
      calls++;
      if (calls % 2 === 0) {
        // A non-retryable adapter failure, whose report copies the request for the
        // headers it carries, as the answered path does.
        const error = new Error('refused');
        Object.defineProperty(error, NON_RETRYABLE_HTTP_ADAPTER_ERROR_FLAG, {
          value: true,
        });
        (error as unknown as Record<symbol, unknown>)[
          EFFECTIVE_REQUEST_HEADERS_KEY
        ] = { 'x-sent': '1' };
        return Promise.reject(error);
      }
      return Promise.resolve({
        status: 200,
        headers: {},
        body: null,
        effectiveRequestHeaders: { 'x-sent': '1' },
      });
    },
  };
  const client = new HTTPClient({ adapter, baseURL: 'http://example.test' });
  // Attempt hooks are handed events, not the request, so they ask for no bodies.
  const hookEvents: number[] = [];
  const form = new FormData();
  form.set('a', '1');
  // Built before the spies: the body setters copy the body as it is handed over, and
  // what is counted here is the work `send()` does.
  const builders = [
    client.post('/x').json({ a: 1 }),
    client.post('/x').json({ a: 1 }),
    client.post('/x').formData(form),
    client.post('/x').formData(form),
  ];
  const parse = spyOn(JSON, 'parse');
  const entries = spyOn(FormData.prototype, 'entries');

  try {
    for (const builder of builders) {
      await builder
        .onAttemptStart((event) => hookEvents.push(event.attemptNumber))
        .onAttemptEnd((event) => hookEvents.push(event.attemptNumber))
        .send();
    }

    expect(calls).toBe(4);
    expect(hookEvents).toHaveLength(8);
    expect(parse).toHaveBeenCalledTimes(0);
    // Twice per request: the copy sent, taken from the request's own form, and one look
    // at whether that copy sends anything.
    expect(entries).toHaveBeenCalledTimes(4);
  } finally {
    parse.mockRestore();
    entries.mockRestore();
  }
});

test('a request ended before dispatch builds no observer bodies when no observer is registered', async () => {
  const client = new HTTPClient({
    adapter: new RecordingAdapter(200),
    baseURL: 'http://example.test',
  });
  client.addRequestInterceptor(() => {
    throw new Error('refused');
  });
  const form = new FormData();
  form.set('a', '1');
  // Built before the spies, which count the work `send()` does: the setters copy the
  // body as it is handed over.
  const jsonBuilder = client.post('/x').json({ a: 1 });
  const multipartBuilder = client.post('/x').formData(form);
  const parse = spyOn(JSON, 'parse');
  const stringify = spyOn(JSON, 'stringify');
  const entries = spyOn(FormData.prototype, 'entries');

  try {
    const json = await jsonBuilder.send();
    const multipart = await multipartBuilder.send();

    expect(json.status).toBe(0);
    expect(multipart.status).toBe(0);
    expect(parse).toHaveBeenCalledTimes(0);
    expect(stringify).toHaveBeenCalledTimes(0);
    expect(entries).toHaveBeenCalledTimes(0);
  } finally {
    parse.mockRestore();
    stringify.mockRestore();
    entries.mockRestore();
  }
});

test("an observer's body and rawBody are plain data fields, and a logger's spread copies nothing again", async () => {
  const adapter = new RecordingAdapter(200);
  const client = new HTTPClient({ adapter, baseURL: 'http://example.test' });
  const seen: unknown[] = [];
  const form = new FormData();
  form.set('a', '1');
  // Built before the spy, which counts the work `send()` does: the setter copies the
  // form as it is handed over.
  const jsonBuilder = client.post('/x').json({ a: 1 });
  const formBuilder = client.post('/form').formData(form);
  const entries = spyOn(FormData.prototype, 'entries');

  try {
    client.addResponseObserver((_response, request) => {
      const logged = { ...request };
      seen.push(
        'value' in (Object.getOwnPropertyDescriptor(request, 'body') ?? {}),
        'value' in (Object.getOwnPropertyDescriptor(request, 'rawBody') ?? {}),
        logged.body === request.body && logged.rawBody === request.rawBody,
      );
      request.rawBody = 'replaced';
      seen.push(request.rawBody);
    });

    await jsonBuilder.send();
    await formBuilder.send();

    expect(seen).toEqual([
      true,
      true,
      true,
      'replaced',
      true,
      true,
      true,
      'replaced',
    ]);
    // The copy sent, one look at whether it sends anything, and the observers' one
    // copy, the spread taking none.
    expect(entries).toHaveBeenCalledTimes(3);
  } finally {
    entries.mockRestore();
  }
});

test("an observer's bytes or form are the ones sent, copied before the adapter changes or transfers them", async () => {
  const adapter: HTTPAdapter = {
    getType: () => 'node',
    send: (request) => {
      // An adapter that hands the bytes on (transferring their buffer) or takes the
      // form apart as it writes it.
      if (request.body instanceof Uint8Array) {
        structuredClone(request.body, { transfer: [request.body.buffer] });
      } else if (request.body instanceof FormData) {
        request.body.delete('secret');
      }
      return Promise.resolve({ status: 200, headers: {}, body: null });
    },
  };
  const client = new HTTPClient({ adapter, baseURL: 'http://example.test' });
  const seen: unknown[] = [];
  client.addResponseObserver((_response, request) => {
    seen.push(
      request.body instanceof FormData
        ? request.body.get('secret')
        : request.rawBody,
    );
  });
  const form = new FormData();
  form.set('secret', 's3cret');

  await client
    .post('/bytes')
    .body(new Uint8Array([1, 2, 3]))
    .send();
  await client.post('/form').formData(form).send();

  expect(seen).toEqual([new Uint8Array([1, 2, 3]), 's3cret']);
});

test("a parent client's observer, or an error observer alone, is handed the request's bodies", async () => {
  const parent = new HTTPClient({
    adapter: new RecordingAdapter(200),
    baseURL: 'http://example.test',
  });
  const seen: unknown[] = [];
  parent.addResponseObserver((_response, request) => {
    seen.push(request.rawBody);
  });
  const sub = parent.createSubClient({});

  await sub.post('/x').json({ a: 1 }).send();

  const failing = new HTTPClient({
    adapter: {
      getType: () => 'node',
      send: () => {
        const error = new Error('refused');
        Object.defineProperty(error, NON_RETRYABLE_HTTP_ADAPTER_ERROR_FLAG, {
          value: true,
        });
        return Promise.reject(error);
      },
    },
    baseURL: 'http://example.test',
  });
  failing.addErrorObserver((_error, request) => {
    seen.push(request.body);
  });

  await failing.post('/x').body('text').send();

  expect(seen).toEqual([{ a: 1 }, 'text']);
});

test("an observer's body and rawBody for bytes or form data are one copy, not the one sent", async () => {
  const adapter = new RecordingAdapter(200);
  const client = new HTTPClient({ adapter, baseURL: 'http://example.test' });
  const seen: Array<{ isShared: boolean; isSent: boolean }> = [];
  client.addResponseObserver((_response, request) => {
    seen.push({
      isShared: request.body === request.rawBody,
      isSent: request.body === adapter.requests.at(-1)?.body,
    });
  });
  const form = new FormData();
  form.set('a', '1');

  await client
    .post('/bytes')
    .body(new Uint8Array([1, 2, 3]))
    .send();
  await client.post('/form').formData(form).send();

  expect(seen).toEqual([
    { isShared: true, isSent: false },
    { isShared: true, isSent: false },
  ]);
});

test('a redirect-phase observer redacting or replacing body and rawBody leaves the body being sent and its 307 replay alone', async () => {
  // Answered before the upload is written, as a server that answers early is: the
  // adapter reads what it was handed only once the observers have run.
  const handed: unknown[] = [];
  const adapter: HTTPAdapter = {
    getType: () => 'node',
    send: (request) => {
      handed.push(request.body);
      const status = handed.length % 2 === 1 ? 307 : 200;
      return Promise.resolve<AdapterResponse>(
        status === 307
          ? {
              status,
              headers: { location: 'http://example.test/next' },
              body: null,
              wasRedirectDetected: true,
              detectedRedirectURL: 'http://example.test/next',
            }
          : { status, headers: {}, body: null },
      );
    },
  };
  const client = new HTTPClient({
    adapter,
    baseURL: 'http://example.test',
    followRedirects: true,
  });
  client.addResponseObserver(
    (_response, request) => {
      for (const body of [request.body, request.rawBody]) {
        if (body instanceof FormData) {
          body.set('secret', 'redacted');
        } else if (body instanceof Uint8Array) {
          body.fill(0);
        }
      }
      request.body = 'replaced';
      request.rawBody = 'replaced';
    },
    { phases: ['redirect'] },
  );
  const form = new FormData();
  form.set('secret', 's3cret');

  await client.post('/form').formData(form).send();
  await client
    .post('/bytes')
    .body(new Uint8Array([1, 2, 3]))
    .send();

  expect(handed).toHaveLength(4);
  expect((handed[0] as FormData).get('secret')).toBe('s3cret');
  expect(handed[2]).toEqual(new Uint8Array([1, 2, 3]));
  // The 307 replays carry the caller's body too.
  expect((handed[1] as FormData).get('secret')).toBe('s3cret');
  expect(handed[3]).toEqual(new Uint8Array([1, 2, 3]));
});

test("a retry-phase observer changing rawBody changes neither the next attempt's bytes nor its rawBody", async () => {
  const sent: unknown[] = [];
  const adapter: HTTPAdapter = {
    getType: () => 'node',
    send: (request) => {
      sent.push(request.body);
      return Promise.resolve({
        status: sent.length === 1 ? 503 : 200,
        headers: {},
        body: null,
      });
    },
  };
  const client = new HTTPClient({
    adapter,
    baseURL: 'http://example.test',
    retryPolicy: { strategy: 'fixed', maxRetryAttempts: 1, delayMS: 1 },
  });
  let reads = 0;
  const body = {
    nested: { value: 1 },
    get token(): string {
      reads++;
      return 'fixed';
    },
  };
  const observed: Array<{ phase: string; rawBody: unknown; copy: unknown }> =
    [];
  client.addResponseObserver(
    (_response, request, phase) => {
      observed.push({
        phase: phase.type,
        rawBody: request.rawBody,
        copy: structuredClone(request.rawBody),
      });
      if (phase.type === 'retry') {
        const raw = request.rawBody as {
          nested: { value: number };
          token: string;
        };
        raw.nested.value = 99;
        raw.token = 'changed';
      }
    },
    { phases: ['retry', 'final'] },
  );

  const response = await client.put('/x').json(body).send();

  expect(response.status).toBe(200);
  // Once, as the body is handed to `.json()`: every attempt's bytes and the observers'
  // copies come from that one read.
  expect(reads).toBe(1);
  expect(sent).toEqual([
    '{"nested":{"value":1},"token":"fixed"}',
    '{"nested":{"value":1},"token":"fixed"}',
  ]);
  expect(observed.map((entry) => entry.phase)).toEqual(['retry', 'final']);
  expect(observed[1]?.rawBody).not.toBe(observed[0]?.rawBody);
  expect(observed[1]?.copy).toEqual({ nested: { value: 1 }, token: 'fixed' });
  expect(body.nested.value).toBe(1);
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
  // Nested: `.params()` reads only the top-level entries, so this getter runs at send.
  const params = {
    filter: {
      get page(): string {
        throw new Error('params unreadable');
      },
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

test('an empty filter list is refused when the callback is added, phases included', () => {
  const client = new HTTPClient();
  for (const field of [
    'statusCodes',
    'methods',
    'hosts',
    'schemes',
    'contentTypes',
    'contentTypeHeaders',
    'bodyContainsKeys',
    'phases',
  ]) {
    expect(() => client.addResponseObserver(() => {}, { [field]: [] })).toThrow(
      /empty/,
    );
  }
  for (const field of ['hosts', 'phases']) {
    expect(() =>
      client.addRequestInterceptor((request) => request, { [field]: [] }),
    ).toThrow(/empty/);
  }
  expect(() => client.addErrorObserver(() => {}, { phases: [] })).toThrow(
    /empty/,
  );
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
  expect(matchesFilter({ hosts: ['*'] }, { requestURL: '' }, 'error')).toBe(
    false,
  );
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
    'redis',
  ]) {
    client.addErrorObserver(() => {}, { hosts: [pattern] })();
  }
  // An empty label after the wildcard - `*.${domain}` with the domain unset.
  for (const pattern of ['*.', '*\uFF0E', ' *\u3002 ']) {
    expect(() =>
      client.addErrorObserver(() => {}, { hosts: [pattern] }),
    ).toThrow(/empty label/);
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

/**
 * Each interceptor phase, the path that reaches it, and the URL a request ended in that
 * phase before dispatch reports: the target as it was before the phase's interceptors ran.
 */
const INTERCEPTOR_PHASE_CASES = [
  ['initial', '/x', 'http://api.test/x'],
  ['retry', '/flaky', 'http://api.test/flaky'],
  ['redirect', '/r', 'http://api.test/b'],
] as const;

/**
 * Send a request - with `body` as JSON, when given - through `phase` with `interceptors`
 * registered for it, to an adapter that redirects `/r` to `/b` with a `307`, so a body is
 * replayed, and answers `/flaky` with a `503` the first time, and report what was sent and
 * what the error observers were handed.
 */
async function sendThroughInterceptorPhase(
  phase: InterceptorPhaseName,
  path: string,
  interceptors: Array<
    (
      request: InterceptedRequest,
      builder: ReturnType<HTTPClient['get']>,
    ) => ReturnType<RequestInterceptor>
  >,
  body?: Record<string, unknown>,
): Promise<{
  response: HTTPResponse<unknown>;
  builder: ReturnType<HTTPClient['get']>;
  sent: AdapterRequest[];
  observed: Array<{
    requestURL: string;
    headers: Record<string, unknown>;
    rawBody: unknown;
  }>;
}> {
  const sent: AdapterRequest[] = [];
  const adapter: HTTPAdapter = {
    getType: () => 'node',
    send: (request: AdapterRequest) => {
      sent.push(request);
      return Promise.resolve<AdapterResponse>(
        request.requestURL.endsWith('/r')
          ? { status: 307, headers: { location: '/b' }, body: null }
          : request.requestURL.endsWith('/flaky') && sent.length === 1
            ? { status: 503, headers: {}, body: null }
            : { status: 200, headers: {}, body: null },
      );
    },
  };
  const client = new HTTPClient({
    adapter,
    baseURL: 'http://api.test',
    followRedirects: true,
    retryPolicy: { strategy: 'fixed', maxRetryAttempts: 1, delayMS: 0 },
  });
  const observed: Array<{
    requestURL: string;
    headers: Record<string, unknown>;
    rawBody: unknown;
  }> = [];
  client.addErrorObserver((_error, request) => {
    observed.push({
      requestURL: request.requestURL,
      headers: request.headers,
      rawBody: request.rawBody,
    });
  });
  // eslint-disable-next-line prefer-const -- assigned after the callbacks that read it
  let builder: ReturnType<HTTPClient['get']>;
  for (const interceptor of interceptors) {
    client.addRequestInterceptor((request) => interceptor(request, builder), {
      phases: [phase],
    });
  }
  builder = body === undefined ? client.get(path) : client.get(path).json(body);
  const response = await builder.send();

  return { response, builder, sent, observed };
}

test('a cancel that lands mid-chain reports the request as it was before the interceptors ran', async () => {
  for (const [phase, path, reportedURL] of INTERCEPTOR_PHASE_CASES) {
    // The first cancels, and hands on a request the client would refuse to send; the
    // second never runs. The chain ends cancelled, so that request is never read.
    const { response, builder, sent, observed } =
      await sendThroughInterceptorPhase(phase, path, [
        (request, builder) => {
          builder.cancel('stop');
          return { ...request, requestURL: 'ftp://api.test/moved' };
        },
        (request) => request,
      ]);

    expect(response.isCancelled).toBe(true);
    expect(builder.error?.code).toBe('cancelled');
    expect(builder.error?.cancelReason).toBe('stop');
    expect(response.requestURL).toBe(reportedURL);
    expect(observed.map((request) => request.requestURL)).toEqual([
      reportedURL,
    ]);
    expect(sent).toHaveLength(phase === 'initial' ? 0 : 1);
  }
});

test('an interceptor that edits the request in place and is then cancelled leaves the reported URL and headers as the client built them', async () => {
  for (const [phase, path, reportedURL] of INTERCEPTOR_PHASE_CASES) {
    const { response, builder, sent, observed } =
      await sendThroughInterceptorPhase(
        phase,
        path,
        [
          async (request, builder) => {
            request.headers.authorization = 'SECRET';
            request.requestURL = 'http://api.test/moved';
            (request.body as Record<string, unknown>).edited = true;
            builder.cancel('stop');
            await Promise.resolve();
            return request;
          },
        ],
        { a: 1 },
      );

    expect(response.isCancelled).toBe(true);
    expect(builder.error?.cancelReason).toBe('stop');
    expect(response.requestURL).toBe(reportedURL);
    expect(observed).toHaveLength(1);
    expect(observed[0].requestURL).toBe(reportedURL);
    expect(observed[0].headers).not.toHaveProperty('authorization');
    // The body is copied for the retry and redirect phases' interceptors, not the
    // initial phase's, which are handed the builder's own.
    expect(observed[0].rawBody).toEqual(
      phase === 'initial' ? { a: 1, edited: true } : { a: 1 },
    );
    // Nor did the edit reach the hop that answered, in the redirect phase.
    expect(sent.map((request) => 'authorization' in request.headers)).toEqual(
      phase === 'initial' ? [] : [false],
    );
  }
});

test('an interceptor that edits the request in place and returns it sends the edit', async () => {
  for (const [phase, path] of INTERCEPTOR_PHASE_CASES) {
    const { response, sent } = await sendThroughInterceptorPhase(phase, path, [
      (request) => {
        request.headers.authorization = 'TOKEN';
        request.body = 'edited';
        request.method = 'POST';
        return request;
      },
    ]);

    expect(response.isFailed).toBe(false);
    const last = sent[sent.length - 1];
    expect(last.headers.authorization).toBe('TOKEN');
    expect(last.method).toBe('POST');
    expect(last.body).toBe('edited');
  }
});

test('a cancel made while an interceptor runs ends the request cancelled, whatever it then returns or throws', async () => {
  for (const ending of ['return undefined', 'throw'] as const) {
    for (const [phase, path, reportedURL] of INTERCEPTOR_PHASE_CASES) {
      const { response, builder, observed } = await sendThroughInterceptorPhase(
        phase,
        path,
        [
          (request, builder) => {
            builder.cancel('stop');
            request.requestURL = 'https://other.example/';
            if (ending === 'throw') {
              throw new Error('refresh failed');
            }
            return undefined as unknown as InterceptedRequest;
          },
        ],
      );

      // A cancel, not the `interceptor_error` the value or the throw would be alone.
      expect(response.isCancelled).toBe(true);
      expect(builder.error?.code).toBe('cancelled');
      expect(builder.error?.cancelReason).toBe('stop');
      expect(builder.error?.cause).toBeUndefined();
      expect(response.requestURL).toBe(reportedURL);
      expect(observed.map((request) => request.requestURL)).toEqual([
        reportedURL,
      ]);
    }
  }
});

test("a cancel made while the chain's result is copied ends the request as a cancel, reported as the client built it", async () => {
  for (const [phase, path, reportedURL] of INTERCEPTOR_PHASE_CASES) {
    const { response, builder, observed } = await sendThroughInterceptorPhase(
      phase,
      path,
      [
        (_request, builder) => ({
          requestURL: 'http://api.test/other',
          method: 'GET',
          headers: {},
          get body(): unknown {
            builder.cancel('stop');
            throw new Error('body read failed');
          },
        }),
      ],
    );

    expect(response.isCancelled).toBe(true);
    expect(builder.error?.code).toBe('cancelled');
    expect(builder.error?.cancelReason).toBe('stop');
    expect(response.requestURL).toBe(reportedURL);
    expect(response.redirectHistory).toEqual(
      phase === 'redirect' ? [reportedURL] : [],
    );
    expect(observed.map((request) => request.requestURL)).toEqual([
      reportedURL,
    ]);
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

test('numeric IPv4 host entries, label null, and a FormData changed mid-upload', async () => {
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

  for (const host of ['my_service', '-edge.example.com', 'api.example.com']) {
    await client.get(`http://${host}/x`).send();
  }

  expect(seen).toEqual(['my_service', '-edge.example.com', 'api.example.com']);
  // `*.` matches nothing, unregistered as in the domain matchers.
  expect(matchesHostPattern('api.example.com', '*.')).toBe(false);
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

test('transport refusals are not retried, Mock honours a 0% cancel, a bad set-cookie is the adapter', async () => {
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

test('a missing URL matches no host, methods are copied, bodyContainsKeys needs a plain object', async () => {
  // An interceptor result that lost its requestURL or method reaches no later filter: the
  // copy taken before the filter reads it refuses it.
  for (const dropped of ['requestURL', 'method'] as const) {
    const guarded: string[] = [];
    const dropping = new HTTPClient({
      adapter: new RecordingAdapter(200),
      baseURL: 'https://api.example.com',
    });
    dropping.addRequestInterceptor((request) => ({
      ...request,
      [dropped]: undefined,
    }));
    dropping.addRequestInterceptor(
      (request) => {
        guarded.push(request.requestURL);
        return request;
      },
      dropped === 'requestURL'
        ? { hosts: ['api.example.com'] }
        : { methods: ['GET'] },
    );
    const builder = dropping.get('/x');
    await builder.send();
    expect(builder.error?.code).toBe('interceptor_error');
    expect(guarded).toEqual([]);
  }

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
      'response',
    ),
  ).toBe(false);
  expect(
    matchesFilter(
      { bodyContainsKeys: ['0'] },
      { body: { 0: 'x' } },
      'response',
    ),
  ).toBe(true);
});

test('request builder validation, json(), the query kept as written, send() order', async () => {
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

test('baseURL must be a string without a query or fragment', () => {
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

test('a bracketed params key replaces its top-level key; single-value headers are strings', async () => {
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

test('a retry interceptor changing only the scheme of a redirect target does not promote it to the credential scope', async () => {
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

test.each(['evil.example./', 'evil.example../'])(
  'a trailing-dot spelling of the redirect host (%s) selects no scope',
  async (respelled) => {
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
        requestURL: request.requestURL.replace('evil.example/', respelled),
      }),
      { phases: ['retry'] },
    );

    await client.get('https://a.test/start').send();

    expect(scopes).toEqual(['a.test', 'a.test']);
  },
);

test('a retry that drops the extra dots from a redirect host is held to that hop', async () => {
  const seen: Array<{ scope: string; authorization: unknown }> = [];
  const client = new HTTPClient({
    followRedirects: true,
    retryPolicy: { strategy: 'fixed', maxRetryAttempts: 1, delayMS: 0 },
    adapter: {
      getType: () => 'node',
      send: (request: AdapterRequest) => {
        if (request.requestURL.startsWith('https://a.test')) {
          return Promise.resolve({
            status: 307,
            headers: { location: 'https://evil.example../next' },
            body: null,
          });
        }
        seen.push({
          scope: new URL(request.initialURL ?? '').host,
          authorization: request.headers.authorization,
        });
        return Promise.resolve({
          status: seen.length === 1 ? 503 : 200,
          headers: {},
          body: null,
        });
      },
    },
  });
  client.addRequestInterceptor(
    (request) => ({
      ...request,
      requestURL: request.requestURL.replace('evil.example..', 'evil.example'),
      headers: { ...request.headers, authorization: 'Bearer secret' },
    }),
    { phases: ['retry'] },
  );

  await client.get('https://a.test/start').send();

  expect(seen).toEqual([
    { scope: 'a.test', authorization: undefined },
    { scope: 'a.test', authorization: undefined },
  ]);
});

test('a retry URL that names no host leaves the credential scope where it was', async () => {
  const scopes: string[] = [];
  let attemptsAtNext = 0;
  const client = new HTTPClient({
    followRedirects: true,
    retryPolicy: { strategy: 'fixed', maxRetryAttempts: 2, delayMS: 0 },
    adapter: {
      getType: () => 'node',
      send: (request: AdapterRequest) => {
        if (request.requestURL.endsWith('/start')) {
          return Promise.resolve({
            status: 307,
            headers: { location: 'https://a.test/next' },
            body: null,
          });
        }
        scopes.push(new URL(request.initialURL ?? '').host);
        attemptsAtNext++;
        return Promise.resolve({
          status: attemptsAtNext < 3 ? 503 : 200,
          headers: {},
          body: null,
        });
      },
    },
  });
  // The first retry goes to `https://./next`, which names no host; the second comes back.
  let retries = 0;
  client.addRequestInterceptor(
    (request) => {
      retries++;
      return retries === 1
        ? { ...request, requestURL: 'https://./next' }
        : request;
    },
    { phases: ['retry'] },
  );

  await client.get('https://a.test/start').send();

  expect(scopes).toEqual(['a.test', 'a.test', 'a.test']);
});

test('a leading-bracket key is overridden', () => {
  expect(buildURL(undefined, '/a?[x]=1&y=2', { x: 2 })).toBe('/a?y=2&x=2');
});

test('MockAdapter parity with a real server', async () => {
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

test('an undefined params value keeps the path pair; mock sameSite/maxAge are checked', async () => {
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

test('null ca refused, nested undefined params and encoded keys', () => {
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

test('an empty params array or object clears the path pairs for its key', () => {
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

test('undefined-only params arrays, repeated fetch Location, mock non-Latin-1 cookie, edge-hyphen public suffix', async () => {
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

test('a timed-out attempt is a timeout whatever the adapter rejects with; nextRetryAt is kept', async () => {
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

test('override apex for edge-hyphen hosts, a resolved transport error after the timer, a clock step during retry observers', async () => {
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

test('a stream factory that fails after headers keeps the cookie and status; progress hooks guarded by the client; callback-less sinks report their bytes', async () => {
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

test('a cancel from the final download event of a chunked body keeps its cookie; a single Location with ", " is kept whole', async () => {
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

test('undispatched redirects, cross-origin Range, 303 body, Location heuristic, redirect request shape, adapter without detectedRedirectURL', async () => {
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

test('multipart names as fetch sends them, an unreadable file is not retried, Transfer-Encoding refused', async () => {
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

test('a cancel before a detected redirect is followed names it; a 303 HEAD drops body headers', async () => {
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

test('label and scope arguments are checked', async () => {
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

test('a followed hop that redirects to its own URL still counts as followed when cancelled', async () => {
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

test('IP literals with a port or path are no host, removals below a domain widen nothing, domain clears reach suffix tenants', () => {
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

test('clear arguments checked, nested private suffixes kept, IP entry info, dropped-body headers', async () => {
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

test('IPv4 entries read by the URL parser in origins and shorthand; uppercase mapped IPv6', () => {
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

test('IPv4-looking entries with userinfo or a path are refused; a padded default port matches', () => {
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

test('single-number and fullwidth IPv4 entries are read as the URL parser reads them', () => {
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

test('only fullwidth ASCII is mapped before reading an IP; fullwidth-only differences noted; numeric wildcard tails refused', () => {
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

test('IPv4 read by the URL parser itself - percent and IDNA spellings, refused hosts match nothing', () => {
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

test('non-special schemes keep opaque hosts; every special scheme drops its default port', () => {
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

test('non-special-scheme IPv6 origins match; non-ASCII opaque hosts are refused', () => {
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

test('extension and other single-label opaque origins can be allowlisted; opaque hosts keep their dots', () => {
  for (const origin of [
    'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
    'chrome-extension://123',
    'moz-extension://3f1b4c2a-0000-4000-8000-000000000000',
    'app://myapp',
  ]) {
    expect(validateConfigEntry(origin, 'origin').valid).toBe(true);
    expect(matchesOriginList(origin, [origin])).toBe(true);
    expect(matchesCORSCredentialsList(origin, [origin])).toBe(true);
  }
  expect(validateConfigEntry('https://com', 'origin').valid).toBe(false);
  expect(matchesOriginList('foo://a。b', ['foo://a.b'])).toBe(false);
  expect(validateConfigEntry('foo://a。example', 'origin').valid).toBe(false);
  expect(normalizeOrigin('https://127。0。0。1')).toBe('https://127.0.0.1');
});

test('an opaque origin with Unicode dots is refused before the IP branch', () => {
  for (const entry of ['foo://1。2。3。4', 'chrome-extension://1。2。3。4']) {
    expect(validateConfigEntry(entry, 'origin').valid).toBe(false);
    expect(matchesOriginList(entry, [entry])).toBe(false);
  }
  expect(validateConfigEntry('foo://1.2.3.4', 'origin').valid).toBe(true);
  expect(matchesOriginList('foo://1.2.3.4', ['foo://1.2.3.4'])).toBe(true);
});

test('a decoded trailing dot after an IPv4 address, file: origins, percent-encoded origin hosts', () => {
  expect(normalizeDomain('127.0.0.1%2e')).toBe('127.0.0.1');
  expect(matchesDomainList('127.0.0.1', ['127.0.0.1%2e'])).toBe(true);
  expect(validateConfigEntry('1.2.3.%34%2e', 'domain').valid).toBe(true);

  for (const entry of ['file://localhost', 'file://a.com:8080']) {
    expect(validateConfigEntry(entry, 'origin').valid).toBe(false);
    expect(matchesOriginList(entry, [entry])).toBe(false);
  }

  for (const entry of ['https://%31.b', 'https://ex%61mple.com']) {
    expect(validateConfigEntry(entry, 'origin').valid).toBe(false);
    expect(matchesOriginList(entry, [entry])).toBe(false);
  }
  expect(validateConfigEntry('https://example.com', 'origin').valid).toBe(true);
  expect(
    matchesOriginList('https://example.com', ['https://example.com']),
  ).toBe(true);
});

test('one trailing empty label in all, the scheme after leading whitespace, percent hosts in the wildcard matcher', () => {
  expect(validateConfigEntry('1.2.3.4..', 'domain').valid).toBe(false);
  expect(validateConfigEntry('1.2.3.4..', 'origin').valid).toBe(false);
  expect(matchesDomainList('1.2.3.4', ['1.2.3.4%2e.'])).toBe(false);
  expect(normalizeDomain('1.2.3.4.')).toBe('1.2.3.4');
  expect(normalizeDomain('127.0.0.1%2e')).toBe('127.0.0.1');
  expect(validateConfigEntry('127.0.0.1.', 'domain').valid).toBe(true);

  expect(matchesOriginList(' foo://a。b', ['foo://a.b'])).toBe(false);
  expect(matchesOriginList('\tfoo://a。b', ['foo://a.b'])).toBe(false);

  expect(
    matchesWildcardOrigin('https://api.ex%61mple.com', 'https://*.example.com'),
  ).toBe(false);
  expect(
    matchesWildcardOrigin('https://api.example.com', 'https://*.example.com'),
  ).toBe(true);
});

test('origins read as the parser reads their text, in the scheme:// form only', () => {
  for (const origin of [
    'https:ex%61mple.com',
    'https:/\t/ex%61mple.com',
    'https:example.com',
    'https:example.com:',
    'https://example.com:\t',
  ]) {
    expect(normalizeOrigin(origin)).toBe('');
    expect(matchesOriginList(origin, ['https://example.com'])).toBe(false);
  }
  expect(
    matchesWildcardOrigin('https:api.ex%61mple.com', 'https://*.example.com'),
  ).toBe(false);
  expect(
    matchesCORSCredentialsList(
      'https:api.ex%61mple.com',
      ['https://*.example.com'],
      { allowWildcardSubdomains: true },
    ),
  ).toBe(false);
  expect(normalizeOrigin('fo\to://a。b')).toBe('');
  expect(normalizeOrigin(' https://Example.com ')).toBe('https://example.com');
  expect(normalizeOrigin('https://exa\nmple.com')).toBe('https://example.com');
});

test('extra slashes or a backslash after scheme:// are refused', () => {
  for (const origin of [
    'https:///ex%61mple.com',
    'https:///example.com:',
    'https://example.com:\\',
    'https://example.com:\\?',
    'https:/\\example.com',
  ]) {
    expect(normalizeOrigin(origin)).toBe('');
    expect(matchesOriginList(origin, ['https://example.com'])).toBe(false);
  }
  expect(
    matchesWildcardOrigin('https:///a.ex%61mple.com', 'https://*.example.com'),
  ).toBe(false);
  expect(normalizeOrigin('https://example.com/')).toBe('https://example.com');
  expect(normalizeOrigin('https://[::1]:8443')).toBe('https://[::1]:8443');
});

test('Unicode dots are folded in the authority only', () => {
  for (const origin of [
    'https://example.com/。',
    'https://example.com/．',
    'https://example.com/。。',
  ]) {
    expect(normalizeOrigin(origin)).toBe('');
    expect(matchesOriginList(origin, ['https://example.com'])).toBe(false);
    expect(matchesCORSCredentialsList(origin, ['https://example.com'])).toBe(
      false,
    );
  }
  expect(normalizeOrigin('https://example。com')).toBe('https://example.com');
  expect(normalizeOrigin('https://127。0。0。1')).toBe('https://127.0.0.1');
  expect(
    matchesWildcardOrigin('https://api.example。com', 'https://*.example.com'),
  ).toBe(true);
});

test('underscore host labels are accepted as the URL standard allows; an empty body is null on every adapter', async () => {
  expect(normalizeDomain('a_b.example.com')).toBe('a_b.example.com');
  expect(normalizeDomain('my_service')).toBe('my_service');
  expect(normalizeDomain('a!b.example.com')).toBe('');
  expect(matchesOriginList('https://a_b.example.com', ['*'])).toBe(true);
  expect(
    matchesWildcardOrigin('https://a_b.example.com', 'https://*.example.com'),
  ).toBe(true);
  expect(matchesDomainList('my_service', ['*'])).toBe(true);
  expect(validateConfigEntry('*.foo_bar.example.com', 'domain').valid).toBe(
    true,
  );
  new HTTPClient().addResponseObserver(() => {}, {
    hosts: ['my_service'],
  })();

  const emptyJSON: HTTPAdapter = {
    getType: () => 'fetch',
    send: () =>
      Promise.resolve({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: new Uint8Array(0),
      }),
  };
  const response = await new HTTPClient({
    adapter: emptyJSON,
    baseURL: 'http://a.test',
  })
    .get('/x')
    .send();
  expect(response.body).toBeNull();
  expect(response.isParseError).toBe(false);
  expect(response.isFailed).toBe(false);
});

test('NodeAdapter drops a bodiless Content-Length, refuses Upgrade/CONNECT and unsendable bodies, sends no progress after a cancel', async () => {
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    seen.push(
      `${req.method} ${req.url} cl=${req.headers['content-length'] ?? '-'}`,
    );
    if (req.url === '/chunked') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('hello');
      return;
    }
    req.resume();
    req.on('end', () => res.end('ok'));
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const adapter = new NodeAdapter();
  try {
    const first = await adapter.send({
      requestURL: `${baseURL}/first`,
      method: 'POST',
      headers: { 'content-length': '20' },
    });
    expect(first.status).toBe(200);
    const second = await adapter.send({
      requestURL: `${baseURL}/second`,
      method: 'GET',
      headers: {},
    });
    expect(second.status).toBe(200);
    expect(seen).toContain('GET /second cl=-');

    for (const request of [
      {
        method: 'GET',
        headers: { upgrade: 'websocket', connection: 'Upgrade' },
      },
      { method: 'CONNECT', headers: {} },
      { method: 'POST', headers: {}, body: new ArrayBuffer(10) },
    ]) {
      const refused = await adapter
        .send({
          requestURL: `${baseURL}/x`,
          ...(request as Partial<AdapterRequest>),
        } as AdapterRequest)
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      expect(refused).toBeInstanceOf(TypeError);
    }

    const events: number[] = [];
    const controller = new AbortController();
    let settledAt = -1;
    const pending = adapter
      .send({
        requestURL: `${baseURL}/chunked`,
        method: 'GET',
        headers: {},
        signal: controller.signal,
        onDownloadProgress: (event) => {
          events.push(event.progress);
          controller.abort();
        },
      })
      .catch(() => {
        settledAt = events.length;
      });
    await pending;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settledAt).toBeGreaterThanOrEqual(0);
    expect(events.length).toBe(settledAt);
  } finally {
    server.close();
  }
});

test('an adapter answer without a body field is delivered; a dropped Content-Length is not reported as sent', async () => {
  const bodiless: HTTPAdapter = {
    getType: () => 'node',
    send: () =>
      Promise.resolve({
        status: 200,
        headers: { 'content-type': 'application/json' },
      } as unknown as AdapterResponse),
  };
  const delivered = await new HTTPClient({
    adapter: bodiless,
    baseURL: 'http://a.test',
  })
    .get('/x')
    .send();
  expect(delivered.isFailed).toBe(false);
  expect(delivered.body).toBeNull();

  let serverSaw: string | undefined;
  const server = http.createServer((req, res) => {
    serverSaw = req.headers['content-length'];
    req.resume();
    req.on('end', () => res.end('ok'));
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const client = new HTTPClient({ adapter: new NodeAdapter(), baseURL });
    let observerSaw: unknown = 'unset';
    client.addResponseObserver((_response, request) => {
      observerSaw = request.headers['content-length'];
    });
    await client.post('/x').headers({ 'content-length': '20' }).send();
    expect(serverSaw).not.toBe('20');
    expect(observerSaw).not.toBe('20');

    const direct = await new NodeAdapter().send({
      requestURL: `${baseURL}/x`,
      method: 'POST',
      headers: { 'Content-Length': '20' },
    });
    expect(direct.effectiveRequestHeaders?.['content-length']).not.toBe('20');
  } finally {
    server.close();
  }
});

test('a shared factory error does not mix requests; cancel and timeout are exclusive; detectedRedirectURL as written', async () => {
  const server = http.createServer((req, res) => {
    const who = req.url === '/a' ? 'a' : 'b';
    res.writeHead(200, {
      'x-who': who,
      'set-cookie': `${who}=1; Path=/`,
    });
    res.flushHeaders();
    setTimeout(() => res.end('x'), 200);
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const jar = new CookieJar();
    const client = new HTTPClient({
      adapter: new NodeAdapter(),
      baseURL,
      cookieJar: jar,
    });
    const shared = new Error('storage not ready');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const factory = async (): Promise<never> => {
      await gate;
      throw shared;
    };
    const a = client.get('/a').streamResponse(factory);
    const b = client.get('/b').streamResponse(factory);
    const pending = Promise.all([a.send(), b.send()]);
    setTimeout(release, 50);
    const [responseA, responseB] = await pending;
    expect(responseA.headers['x-who']).toBe('a');
    expect(responseB.headers['x-who']).toBe('b');
    expect(a.error?.cause).toBe(shared);
    expect(Object.getOwnPropertyNames(shared)).not.toContain(
      '_lifecycleion_stream_factory_error',
    );
    expect(jar.getCookieHeaderString(`${baseURL}/`)).toContain('a=1');
    expect(jar.getCookieHeaderString(`${baseURL}/`)).toContain('b=1');
  } finally {
    server.close();
  }

  const slow: HTTPAdapter = {
    getType: () => 'node',
    send: () =>
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('late')), 110);
      }),
  };
  const raced = new HTTPClient({
    adapter: slow,
    baseURL: 'http://a.test',
    timeout: 30,
  }).get('/x');
  setTimeout(() => raced.cancel(), 60);
  const racedResponse = await raced.send();
  expect(racedResponse.isCancelled).toBe(true);
  expect(racedResponse.isTimeout).toBe(false);

  const redirecting = new MockAdapter();
  redirecting.routes.get('/start', () => ({
    status: 302,
    headers: { location: 'https://admin:secret@other.test/y' },
  }));
  const redirectClient = new HTTPClient({
    adapter: redirecting,
    baseURL: 'https://a.test',
    followRedirects: true,
  });
  redirectClient.addRequestInterceptor(
    () => {
      throw new Error('no hop');
    },
    { phases: ['redirect'] },
  );
  const refused = redirectClient.get('/start');
  await refused.send();
  expect(refused.error?.code).toBe('interceptor_error');
  // On another origin than the request, so the userinfo the server wrote is dropped too.
  expect(refused.error?.detectedRedirectURL).toBe('https://other.test/y');
});

test("an adapter never flags the caller's own error in place", async () => {
  const shared = new Error('cannot serialize');
  const adapter = new MockAdapter();
  adapter.routes.get('/x', () => ({
    status: 200,
    body: {
      x: {
        toJSON() {
          throw shared;
        },
      },
    },
  }));
  const builder = new HTTPClient({ adapter, baseURL: 'http://a.test' }).get(
    '/x',
  );
  await builder.send();
  expect(builder.error?.code).toBe('adapter_error');
  expect(builder.error?.cause).toBe(shared);
  expect(Object.getOwnPropertyNames(shared)).not.toContain(
    '_lifecycleion_non_retryable_http_adapter_error',
  );
});

test('underscore suffix overrides; a sub-second mock maxAge keeps the cookie', async () => {
  const jar = new CookieJar({ publicSuffixes: { add: ['svc.my_net'] } });
  jar.parseSetCookieHeader('t=1; Domain=svc.my_net', 'http://a.svc.my_net/');
  expect(jar.getCookieHeaderString('http://b.svc.my_net/')).toBe('');

  // An edge hyphen too: the URL parser takes `-corp.example`, and the jar keeps its cookies
  // - shared across its hosts until the suffix is declared.
  const plainJar = new CookieJar();
  plainJar.parseSetCookieHeader(
    't=1; Domain=-corp.example',
    'http://a.-corp.example/',
  );
  expect(plainJar.getCookieHeaderString('http://b.-corp.example/')).toBe('t=1');

  const edgeJar = new CookieJar({
    publicSuffixes: { add: ['-corp.example', 'corp-.example'] },
  });
  for (const suffix of ['-corp.example', 'corp-.example']) {
    edgeJar.parseSetCookieHeader(
      `t=1; Domain=${suffix}`,
      `http://a.${suffix}/`,
    );
    expect(edgeJar.getCookieHeaderString(`http://b.${suffix}/`)).toBe('');
  }

  const adapter = new MockAdapter();
  adapter.routes.get('/c', () => ({
    status: 200,
    cookies: { s: { value: 'v', maxAge: 0.5 } },
  }));
  const response = await new HTTPClient({
    adapter,
    baseURL: 'http://api.test',
  })
    .get('/c')
    .send();
  expect(response.headers['set-cookie']).toEqual([
    expect.stringContaining('Max-Age=1'),
  ]);
});

test('FetchAdapter refusals at dispatch are not retried; terminal upload events count bytes; browser adapters never flag the caller error', async () => {
  const mine = new Error('header value failed');
  const hostile = {
    toString() {
      throw mine;
    },
  };
  const refused = await new FetchAdapter()
    .send({
      requestURL: 'http://127.0.0.1:1/x',
      method: 'GET',
      headers: { 'x-a': hostile as unknown as string },
    })
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  expect((refused as Error).cause).toBe(mine);
  expect(Object.getOwnPropertyNames(mine)).not.toContain(
    '_lifecycleion_non_retryable_http_adapter_error',
  );

  const undiciRefusal = Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('invalid keep-alive header'), {
      code: 'UND_ERR_INVALID_ARG',
    }),
  });
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = (() => {
    fetches++;
    return Promise.reject(undiciRefusal);
  }) as unknown as typeof fetch;
  try {
    const builder = new HTTPClient({
      adapter: new FetchAdapter(),
      baseURL: 'http://127.0.0.1:1',
      retryPolicy: { strategy: 'fixed', maxRetryAttempts: 2, delayMS: 1 },
    }).get('/x');
    await builder.send();
    expect(fetches).toBe(1);
    expect(builder.error?.code).toBe('adapter_error');
  } finally {
    globalThis.fetch = originalFetch;
  }

  const uploads: Array<{ loaded: number; total: number; progress: number }> =
    [];
  const adapter = new MockAdapter();
  adapter.routes.post('/u', () => ({ status: 200 }));
  await new HTTPClient({ adapter, baseURL: 'http://api.test' })
    .post('/u')
    .text('0123456789')
    .onUploadProgress((event) => uploads.push(event))
    .send();
  expect(uploads.at(-1)).toMatchObject({ loaded: 10, total: 10, progress: 1 });
});

test('NodeAdapter asks for and decodes gzip, deflate and br bodies, as fetch does', async () => {
  const json = JSON.stringify({ ok: true, items: [1, 2, 3] });
  const encoded: Record<string, Buffer> = {
    gzip: zlib.gzipSync(json),
    deflate: zlib.deflateSync(json),
    'deflate-raw': zlib.deflateRawSync(json),
    br: zlib.brotliCompressSync(json),
  };
  let lastAcceptEncoding: string | undefined;
  const server = http.createServer((req, res) => {
    lastAcceptEncoding = req.headers['accept-encoding'];
    const kind = (req.url ?? '/').slice(1);
    if (kind === 'corrupt') {
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
      });
      res.end('not gzip at all');
      return;
    }
    const body = encoded[kind] ?? Buffer.from(json);
    res.writeHead(200, {
      'content-type': 'application/json',
      'content-encoding': kind.startsWith('deflate') ? 'deflate' : kind,
      'content-length': String(body.length),
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const node = new HTTPClient({ adapter: new NodeAdapter(), baseURL });
    const fetchClient = new HTTPClient({
      adapter: new FetchAdapter(),
      baseURL,
    });
    for (const kind of Object.keys(encoded)) {
      const viaNode = await node.get(`/${kind}`).send();
      expect(viaNode.body).toEqual({ ok: true, items: [1, 2, 3] });
      expect(viaNode.isJSON).toBe(true);
      const viaFetch = await fetchClient.get(`/${kind}`).send();
      expect(viaNode.body).toEqual(viaFetch.body);
    }
    // NodeAdapter's own, read after a NodeAdapter request: the loop's last went through
    // fetch. No `br` over plain http, and `identity` for a `Range`.
    await node.get('/gzip').send();
    expect(lastAcceptEncoding).toBe('gzip, deflate');
    await node.get('/gzip').headers({ range: 'bytes=0-' }).send();
    expect(lastAcceptEncoding).toBe('identity');

    await node.get('/gzip').headers({ 'accept-encoding': 'identity' }).send();
    expect(lastAcceptEncoding).toBe('identity');

    const head = await node.head('/gzip').send();
    expect(head.isFailed).toBe(false);
    expect(head.body).toBeNull();

    const corrupt = node.get('/corrupt');
    const corruptResponse = await corrupt.send();
    expect(corruptResponse.isStreamError).toBe(true);
    expect(corruptResponse.status).toBe(200);

    const chunks: Buffer[] = [];
    const streamed = await node
      .get('/br')
      .streamResponse(
        () =>
          ({
            write: (chunk: Buffer, callback?: () => void) => {
              chunks.push(chunk);
              callback?.();
              return true;
            },
            end: (callback?: () => void) => callback?.(),
          }) as never,
      )
      .send();
    expect(streamed.isStreamed).toBe(true);
    expect(Buffer.concat(chunks).toString()).toBe(json);
  } finally {
    server.close();
  }
});

test('decoded bodies hold their end/error for a streamed reader; a Range request asks for identity', async () => {
  let lastAcceptEncoding: string | undefined;
  const server = http.createServer((req, res) => {
    lastAcceptEncoding = req.headers['accept-encoding'];
    if (req.url === '/empty-deflate') {
      res.writeHead(200, {
        'content-encoding': 'deflate',
        'content-length': '0',
      });
      res.end();
      return;
    }
    if (req.url === '/corrupt') {
      res.writeHead(200, { 'content-encoding': 'gzip' });
      res.end('not gzip at all');
      return;
    }
    res.end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const sink = (): never =>
    ({
      write: (_chunk: unknown, callback?: () => void) => {
        callback?.();
        return true;
      },
      end: (callback?: () => void) => callback?.(),
    }) as never;
  try {
    const client = new HTTPClient({
      adapter: new NodeAdapter(),
      baseURL,
      timeout: 2000,
    });
    const empty = await client
      .get('/empty-deflate')
      .streamResponse(sink)
      .send();
    expect(empty.isTimeout).toBe(false);
    expect(empty.isStreamed).toBe(true);

    const corrupt = await client
      .get('/corrupt')
      .streamResponse(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return sink();
      })
      .send();
    expect(corrupt.isTimeout).toBe(false);
    expect(corrupt.isStreamError).toBe(true);

    await client.get('/x').headers({ range: 'bytes=10-' }).send();
    expect(lastAcceptEncoding).toBe('identity');
  } finally {
    server.close();
  }
});

test('decoding stops on a timeout, a truncated body is a stream error, stacked codings decode', async () => {
  const bomb = zlib.gzipSync(Buffer.alloc(200 * 1024 * 1024), { level: 1 });
  const full = zlib.gzipSync(Buffer.alloc(100000, 'a'));
  const truncated = full.subarray(0, full.length - 4);
  const stacked = zlib.brotliCompressSync(zlib.gzipSync('{"stacked":true}'));
  const server = http.createServer((req, res) => {
    const send = (encoding: string, body: Buffer, type = 'text/plain') => {
      res.writeHead(200, {
        'content-type': type,
        'content-encoding': encoding,
        'content-length': String(body.length),
      });
      res.end(body);
    };
    if (req.url === '/bomb') {
      send('gzip', bomb);
    } else if (req.url === '/truncated') {
      send('gzip', truncated);
    } else if (req.url === '/stacked') {
      send('gzip, br', stacked, 'application/json');
    } else {
      send('gzip', Buffer.alloc(0));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const client = new HTTPClient({ adapter: new NodeAdapter(), baseURL });

    let eventsAfterSettle = 0;
    let isSettled = false;
    const timedOut = await client
      .get('/bomb')
      .timeout(30)
      .onDownloadProgress(() => {
        if (isSettled) {
          eventsAfterSettle++;
        }
      })
      .send();
    isSettled = true;
    expect(timedOut.isTimeout).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(eventsAfterSettle).toBe(0);

    const cut = await client.get('/truncated').send();
    expect(cut.isStreamError).toBe(true);

    const both = await client.get('/stacked').send();
    expect(both.body).toEqual({ stacked: true });

    const empty = await client.get('/empty').send();
    expect(empty.isFailed).toBe(false);
    expect(empty.body).toBeNull();
  } finally {
    server.close();
  }
}, 30_000);

test('host-only and domain cookies are two cookies; header order, trimming, attribute size, nameless cookies', () => {
  const jar = new CookieJar();
  jar.parseSetCookieHeader(
    'sid=real; Secure; HttpOnly; Path=/',
    'https://bank.example/',
  );
  jar.parseSetCookieHeader(
    'sid=x; Domain=bank.example; Secure; Path=/; Max-Age=0',
    'https://evil.bank.example/',
  );
  expect(jar.getCookieHeaderString('https://bank.example/')).toBe('sid=real');
  jar.parseSetCookieHeader(
    'sid=attacker; Domain=bank.example; Secure; Path=/',
    'https://evil.bank.example/',
  );
  expect(jar.getCookieHeaderString('https://bank.example/')).toContain(
    'sid=real',
  );

  const ordered = new CookieJar();
  ordered.parseSetCookieHeader('a=1', 'https://o.example/');
  ordered.parseSetCookieHeader('b=1', 'https://o.example/');
  ordered.parseSetCookieHeader('a=2', 'https://o.example/');
  expect(ordered.getCookieHeaderString('https://o.example/')).toBe('a=2; b=1');

  const text = new CookieJar();
  text.parseSetCookieHeader('greet=voilÃ ', 'https://t.example/');
  expect(text.getCookieHeaderString('https://t.example/')).toBe('greet=voilÃ ');
  text.parseSetCookieHeader('bad=x\u000b', 'https://t.example/');
  expect(text.getCookieHeaderString('https://t.example/')).not.toContain(
    'bad=',
  );
  text.parseSetCookieHeader(
    `long=1; Path=/${'x'.repeat(5000)}`,
    'https://t.example/',
  );
  expect(text.getCookieHeaderString('https://t.example/')).toContain('long=1');

  const nameless = new CookieJar();
  nameless.parseSetCookieHeader('flag', 'https://n.example/');
  expect(nameless.getCookieHeaderString('https://n.example/')).toBe('flag');
  nameless.parseSetCookieHeader('__Host-x', 'https://n.example/');
  expect(nameless.getCookieHeaderString('https://n.example/')).toBe('flag');
});

test('a long content-coding chain is refused; the adapter Accept-Encoding is not carried to a redirect hop', async () => {
  let hopAcceptEncoding: string | undefined;
  const server = http.createServer((req, res) => {
    if (req.url === '/chain') {
      res.writeHead(200, {
        'content-encoding': Array.from({ length: 50 }, () => 'br').join(','),
      });
      res.end('x');
      return;
    }
    if (req.url === '/start') {
      res.writeHead(302, { location: '/file' });
      res.end();
      return;
    }
    hopAcceptEncoding = req.headers['accept-encoding'];
    res.end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const client = new HTTPClient({
      adapter: new NodeAdapter(),
      baseURL,
      followRedirects: true,
    });
    const chained = await client.get('/chain').send();
    expect(chained.isStreamError).toBe(true);

    client.addRequestInterceptor(
      (request) => ({
        ...request,
        headers: { ...request.headers, range: 'bytes=10-' },
      }),
      { phases: ['redirect'] },
    );
    await client.get('/start').send();
    expect(hopAcceptEncoding).toBe('identity');
  } finally {
    server.close();
  }
});

describe('maxResponseBytes', () => {
  // Hits per path, so a test can tell a refused response was not retried.
  const hits = new Map<string, number>();
  const server = http.createServer((req, res) => {
    const path = req.url ?? '/';
    hits.set(path, (hits.get(path) ?? 0) + 1);

    if (path === '/small') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('x'.repeat(50));
    } else if (path === '/big' || path === '/big-503') {
      // Chunked, with no Content-Length: only counting the body can find it too large.
      res.writeHead(path === '/big' ? 200 : 503, {
        'content-type': 'text/plain',
        'x-kept': 'yes',
      });
      for (let i = 0; i < 6; i++) {
        res.write('x'.repeat(50));
      }
      res.end();
    } else if (path === '/declared') {
      // Headers only, with a length over the limit, then nothing: only a refusal made
      // from the Content-Length answers before the attempt times out.
      res.writeHead(200, { 'content-length': '5000' });
      res.flushHeaders();
    } else if (path === '/gzip') {
      // A few dozen bytes on the wire, 5000 once decoded.
      const encoded = zlib.gzipSync(Buffer.from('a'.repeat(5000)));
      res.writeHead(200, {
        'content-encoding': 'gzip',
        'content-length': String(encoded.length),
      });
      res.end(encoded);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  let baseURL = '';

  beforeAll(async () => {
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.closeAllConnections();
    server.close();
  });

  const adapters = [
    ['NodeAdapter', () => new NodeAdapter()],
    ['FetchAdapter', () => new FetchAdapter()],
  ] as const;

  for (const [name, makeAdapter] of adapters) {
    test(`${name}: a buffered body over the limit fails as response_too_large, keeping its status, retried as its status asks`, async () => {
      hits.delete('/big-503');
      const client = new HTTPClient({
        adapter: makeAdapter(),
        baseURL,
        maxResponseBytes: 100,
        retryPolicy: { strategy: 'fixed', maxRetryAttempts: 2, delayMS: 1 },
      });

      const builder = client.get('/big-503');
      const response = await builder.send();

      expect(response.status).toBe(503);
      expect(response.headers['x-kept']).toBe('yes');
      expect(response.body).toBeNull();
      expect(response.isStreamError).toBe(true);
      expect(response.isFailed).toBe(true);
      expect(builder.error?.code).toBe('response_too_large');
      expect(builder.error?.message).toBe(
        'Response body exceeded maxResponseBytes',
      );
      expect(builder.error?.cause?.message).toContain(
        'Response body exceeds maxResponseBytes (100); raise maxResponseBytes',
      );
      // A `503` asks for a retry, and none of its oversized body reached the caller.
      expect(builder.error?.isRetriesExhausted).toBe(true);
      expect(hits.get('/big-503')).toBe(3);
    });

    test(`${name}: a body within the limit is delivered`, async () => {
      const client = new HTTPClient({
        adapter: makeAdapter(),
        baseURL,
        maxResponseBytes: 100,
      });

      const response = await client.get<string>('/small').send();

      expect(response.isFailed).toBe(false);
      expect(response.body).toBe('x'.repeat(50));
    });

    test(`${name}: a Content-Length over the limit is refused before the body is read`, async () => {
      const builder = new HTTPClient({
        adapter: makeAdapter(),
        baseURL,
        maxResponseBytes: 100,
        timeout: 5000,
      }).get('/declared');
      const startedAt = performance.now();
      const response = await builder.send();

      expect(builder.error?.code).toBe('response_too_large');
      expect(response.status).toBe(200);
      expect(response.isTimeout).toBe(false);
      expect(performance.now() - startedAt).toBeLessThan(4000);
    });

    test(`${name}: Infinity disables the limit`, async () => {
      const response = await new HTTPClient({
        adapter: makeAdapter(),
        baseURL,
        maxResponseBytes: Infinity,
      })
        .get<string>('/big')
        .send();

      expect(response.isFailed).toBe(false);
      expect(response.body).toHaveLength(300);
    });
  }

  test('NodeAdapter counts a compressed body decoded', async () => {
    const builder = new HTTPClient({
      adapter: new NodeAdapter(),
      baseURL,
      maxResponseBytes: 1000,
    }).get('/gzip');
    const response = await builder.send();

    expect(builder.error?.code).toBe('response_too_large');
    expect(response.status).toBe(200);
    expect(response.isStreamError).toBe(true);

    // The same body within a limit that fits it decoded.
    const decoded = await new HTTPClient({
      adapter: new NodeAdapter(),
      baseURL,
      maxResponseBytes: 5000,
    })
      .get<Uint8Array>('/gzip')
      .send();
    expect(decoded.isFailed).toBe(false);
    expect(decoded.body).toHaveLength(5000);
  });

  test('NodeAdapter does not limit a streamed response', async () => {
    const received: Buffer[] = [];
    const response = await new HTTPClient({
      adapter: new NodeAdapter(),
      baseURL,
      maxResponseBytes: 100,
    })
      .get('/big')
      .streamResponse(
        () =>
          new Writable({
            write(chunk: Buffer, _encoding, callback) {
              received.push(chunk);
              callback();
            },
          }),
      )
      .send();

    expect(response.isFailed).toBe(false);
    expect(response.isStreamed).toBe(true);
    expect(Buffer.concat(received).length).toBe(300);
  });

  test('a sub-client inherits the limit, and a sub-client or request overrides it', async () => {
    const parent = new HTTPClient({
      adapter: new NodeAdapter(),
      baseURL,
      maxResponseBytes: 100,
    });

    const inheriting = parent.createSubClient({ maxResponseBytes: null });
    const inherited = inheriting.get('/big');
    await inherited.send();
    expect(inherited.error?.code).toBe('response_too_large');

    const raised = await parent
      .createSubClient({ maxResponseBytes: 1000 })
      .get('/big')
      .send();
    expect(raised.isFailed).toBe(false);

    const perRequest = await parent.get('/big').maxResponseBytes(1000).send();
    expect(perRequest.isFailed).toBe(false);

    const perRequestOption = await parent
      .get('/big', { maxResponseBytes: Infinity })
      .send();
    expect(perRequestOption.isFailed).toBe(false);

    // A null request value inherits the client's, which a sub-client took from its parent.
    const nullOption = inheriting.get('/big', { maxResponseBytes: null });
    await nullOption.send();
    expect(nullOption.error?.code).toBe('response_too_large');

    // A request can lower the limit too.
    const lowered = new HTTPClient({ adapter: new NodeAdapter(), baseURL })
      .get('/small')
      .maxResponseBytes(10);
    await lowered.send();
    expect(lowered.error?.code).toBe('response_too_large');
  });

  test('the default limit is DEFAULT_MAX_RESPONSE_BYTES, reported on the attempt snapshot', async () => {
    expect(DEFAULT_MAX_RESPONSE_BYTES).toBe(64 * 1024 * 1024);

    const seen: Array<number | undefined> = [];
    const client = new HTTPClient({ adapter: new NodeAdapter(), baseURL });
    client.addResponseObserver((_response, request) => {
      seen.push(request.maxResponseBytes);
    });
    await client.get('/small').send();
    await client.get('/small').maxResponseBytes(500).send();

    expect(seen).toEqual([DEFAULT_MAX_RESPONSE_BYTES, 500]);
  });

  test('MockAdapter fails a route body over the limit as response_too_large', async () => {
    const adapter = new MockAdapter();
    adapter.routes.get('/big', () => ({
      status: 201,
      headers: { 'x-kept': 'yes' },
      body: 'x'.repeat(200),
    }));
    const client = new HTTPClient({ adapter, maxResponseBytes: 100 });

    const builder = client.get('/big');
    const response = await builder.send();

    expect(builder.error?.code).toBe('response_too_large');
    expect(response.status).toBe(201);
    expect(response.headers['x-kept']).toBe('yes');
    expect(response.isStreamError).toBe(true);
    expect(response.body).toBeNull();

    const within = await client.get('/big').maxResponseBytes(200).send();
    expect(within.isFailed).toBe(false);
    expect(within.body).toBe('x'.repeat(200));
  });

  test('an invalid limit is refused where it is given', () => {
    const client = new HTTPClient({ adapter: new MockAdapter() });

    for (const value of [0, -1, 1.5, NaN, -Infinity, '100', true]) {
      expect(
        () => new HTTPClient({ maxResponseBytes: value as never }),
      ).toThrow(/^HTTPClient maxResponseBytes must be a positive integer/);
      expect(() =>
        client.createSubClient({ maxResponseBytes: value as never }),
      ).toThrow(TypeError);
      expect(() => client.get('/x').maxResponseBytes(value as never)).toThrow(
        /^HTTP request maxResponseBytes must be a positive integer/,
      );
      expect(() =>
        client.get('/x', { maxResponseBytes: value as never }),
      ).toThrow(TypeError);
    }

    // `null` inherits, and is accepted everywhere a value is.
    expect(() => client.get('/x').maxResponseBytes(null)).not.toThrow();
    expect(() =>
      client.createSubClient({ maxResponseBytes: null }),
    ).not.toThrow();
  });
});

test('NodeAdapter decompress: false hands the body over as it arrived and asks for no encoding', async () => {
  const gz = zlib.gzipSync('{"raw":true}');
  let acceptEncoding: string | undefined;
  const server = http.createServer((req, res) => {
    acceptEncoding = req.headers['accept-encoding'];
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-encoding': 'gzip',
      'content-length': String(gz.length),
    });
    res.end(gz);
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const raw = await new HTTPClient({
      adapter: new NodeAdapter({ decompress: false }),
      baseURL,
    })
      .get('/x')
      .send();
    expect(acceptEncoding).toBeUndefined();
    expect(Buffer.from(raw.body as Uint8Array).equals(gz)).toBe(true);

    expect(
      () => new NodeAdapter({ decompress: 'no' as unknown as boolean }),
    ).toThrow(TypeError);
  } finally {
    server.close();
  }
});

test('redirect_disabled carries no cause from the hop body', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(302, { location: '/small' });
    res.end('x'.repeat(500));
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const builder = new HTTPClient({
      adapter: new NodeAdapter(),
      baseURL,
      maxResponseBytes: 100,
    }).get('/start');
    await builder.send();
    expect(builder.error?.code).toBe('redirect_disabled');
    expect(builder.error?.cause).toBeUndefined();
  } finally {
    server.close();
  }
});

test("a custom adapter's stream code is held to the stream codes; attribute size counts wire octets", async () => {
  for (const code of ['cancelled', 'bogus', 42]) {
    const builder = new HTTPClient({
      adapter: {
        getType: () => 'node',
        send: () =>
          Promise.resolve({
            status: 200,
            headers: {},
            body: null,
            isStreamError: true,
            streamErrorCode: code,
          } as unknown as AdapterResponse),
      },
      baseURL: 'http://a.test',
    }).get('/x');
    await builder.send();
    expect(builder.error?.code).toBe('stream_write_error');
  }

  const jar = new CookieJar();
  const path = `/${'Ð¶'.repeat(300)}`;
  jar.parseSetCookieHeader(`sid=1; Path=${path}`, 'https://example.com/x/y');
  expect(jar.getAllCookies()[0]?.path).toBe(path);
});

test('polyfilled fetch bodies, custom adapter bodies over the limit, caller Accept-Encoding across origins', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve({
      status: 200,
      type: 'basic',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: { pipe() {} },
      arrayBuffer: () =>
        Promise.resolve(new TextEncoder().encode('{"ok":true}').buffer),
    })) as unknown as typeof fetch;
  try {
    const polyfilled = await new HTTPClient({
      adapter: new FetchAdapter(),
      baseURL: 'http://a.test',
    })
      .get('/x')
      .send();
    expect(polyfilled.body).toEqual({ ok: true });
  } finally {
    globalThis.fetch = originalFetch;
  }

  const big = await new HTTPClient({
    adapter: {
      getType: () => 'node',
      send: () =>
        Promise.resolve({
          status: 200,
          headers: {},
          body: new Uint8Array(5000),
        }),
    },
    baseURL: 'http://a.test',
    maxResponseBytes: 1000,
  })
    .get('/x')
    .send();
  expect(big.isStreamError).toBe(true);
  expect(big.body).toBeNull();

  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    seen.push(`${req.url} ${req.headers['accept-encoding']}`);
    if (req.url === '/start') {
      const port = (server.address() as AddressInfo).port;
      res.writeHead(302, { location: `http://localhost:${port}/file` });
      res.end();
      return;
    }
    res.end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    await new HTTPClient({
      adapter: new NodeAdapter({ decompress: false }),
      baseURL: `http://127.0.0.1:${port}`,
      followRedirects: true,
    })
      .get('/start')
      .headers({ 'accept-encoding': 'gzip' })
      .send();
    expect(seen).toEqual(['/start gzip', '/file gzip']);
  } finally {
    server.close();
  }
});

test('polyfilled fetch bodies are read incrementally and released; an inner raw deflate decodes', async () => {
  const { Readable } = await import('node:stream');
  let produced = 0;
  let isDestroyed = false;
  const endless = new Readable({
    read() {
      produced += 1024;
      this.push(Buffer.alloc(1024));
    },
  });
  endless.on('close', () => {
    isDestroyed = true;
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve({
      status: 200,
      type: 'basic',
      headers: new Headers({ 'content-type': 'text/plain' }),
      body: endless,
      arrayBuffer: () => Promise.reject(new Error('not read whole')),
    })) as unknown as typeof fetch;
  try {
    const capped = await new HTTPClient({
      adapter: new FetchAdapter(),
      baseURL: 'http://a.test',
      maxResponseBytes: 10_000,
    })
      .get('/x')
      .send();
    expect(capped.isStreamError).toBe(true);
    expect(produced).toBeLessThan(100_000);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(isDestroyed).toBe(true);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const body = zlib.gzipSync(zlib.deflateRawSync('inner'));
  const server = http.createServer((_req, res) => {
    res.writeHead(200, {
      'content-type': 'text/plain',
      'content-encoding': 'deflate, gzip',
    });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const decoded = await new HTTPClient({
      adapter: new NodeAdapter(),
      baseURL: `http://127.0.0.1:${port}`,
    })
      .get('/x')
      .send();
    expect(decoded.body).toBe('inner');
  } finally {
    server.close();
  }
});

test('bytes after a compressed stream are a stream error for every coding, and a stacked deflate does not hang', async () => {
  const junk = Buffer.alloc(1000, 'j');
  const bodies: Record<string, [string, Buffer]> = {
    br: ['br', Buffer.concat([zlib.brotliCompressSync('hello'), junk])],
    deflate: ['deflate', Buffer.concat([zlib.deflateSync('hello'), junk])],
    raw: ['deflate', Buffer.concat([zlib.deflateRawSync('hello'), junk])],
    stacked: [
      'deflate, gzip',
      zlib.gzipSync(
        Buffer.concat([zlib.deflateSync('hello'), Buffer.from('\n')]),
      ),
    ],
  };
  const server = http.createServer((req, res) => {
    const [encoding, body] = bodies[(req.url ?? '/').slice(1)] ?? [
      'identity',
      Buffer.from('x'),
    ];
    res.writeHead(200, {
      'content-type': 'text/plain',
      'content-encoding': encoding,
    });
    res.write(body);
    if (req.url === '/stacked') {
      res.end();
    }
    // The others never end: only a stream error settles them quickly.
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const client = new HTTPClient({
      adapter: new NodeAdapter(),
      baseURL,
      timeout: 2000,
    });
    for (const kind of Object.keys(bodies)) {
      const response = await client.get(`/${kind}`).send();
      expect(response.isTimeout).toBe(false);
      expect(response.isStreamError).toBe(true);
    }
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('trailing bytes in the last chunk of an ended response are a stream error too', async () => {
  const junk = Buffer.alloc(1000, 'j');
  const bodies: Record<string, [string, Buffer]> = {
    br: ['br', Buffer.concat([zlib.brotliCompressSync('hello'), junk])],
    deflate: ['deflate', Buffer.concat([zlib.deflateSync('hello'), junk])],
    raw: ['deflate', Buffer.concat([zlib.deflateRawSync('hello'), junk])],
    stacked: [
      'br, gzip',
      zlib.gzipSync(Buffer.concat([zlib.brotliCompressSync('hello'), junk])),
    ],
    clean: ['br', zlib.brotliCompressSync('hello')],
  };
  const server = http.createServer((req, res) => {
    const [encoding, body] = bodies[(req.url ?? '/').slice(1)] ?? [
      'identity',
      Buffer.from('x'),
    ];
    res.writeHead(200, {
      'content-type': 'text/plain',
      'content-encoding': encoding,
      'content-length': String(body.length),
    });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const client = new HTTPClient({ adapter: new NodeAdapter(), baseURL });
    for (const kind of ['br', 'deflate', 'raw', 'stacked']) {
      const response = await client.get(`/${kind}`).send();
      expect(response.isStreamError).toBe(true);
    }
    const clean = await client.get('/clean').send();
    expect(clean.body).toBe('hello');
  } finally {
    server.close();
  }
});

test('a large stacked deflate with trailing bytes fails; gzip zero padding is accepted', async () => {
  const payload = Buffer.alloc(300_000, 'p');
  const bodies: Record<string, [string, Buffer]> = {
    stacked: [
      'deflate, gzip',
      zlib.gzipSync(
        Buffer.concat([zlib.deflateSync(payload), Buffer.from('x')]),
      ),
    ],
    padded: ['gzip', Buffer.concat([zlib.gzipSync('hello'), Buffer.alloc(16)])],
  };
  const server = http.createServer((req, res) => {
    const [encoding, body] = bodies[(req.url ?? '/').slice(1)] ?? [
      'identity',
      Buffer.from('x'),
    ];
    res.writeHead(200, {
      'content-type': 'text/plain',
      'content-encoding': encoding,
      'content-length': String(body.length),
    });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const client = new HTTPClient({ adapter: new NodeAdapter(), baseURL });
    const stacked = await client.get('/stacked').send();
    expect(stacked.isStreamError).toBe(true);
    const padded = await client.get('/padded').send();
    expect(padded.isStreamError).toBe(false);
    expect(padded.body).toBe('hello');
  } finally {
    server.close();
  }
});

test('a redirect whose body only fails to decode is followed; a cut-off 3xx is not', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/start') {
      res.writeHead(302, {
        location: '/end',
        'content-encoding': 'gzip',
        'content-type': 'text/html',
      });
      res.end('<a href="/end">Moved</a>');
      return;
    }
    if (req.url === '/cut') {
      res.writeHead(302, { location: '/end', 'content-length': '100' });
      res.write('partial');
      setTimeout(() => res.socket?.destroy(), 20);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('arrived');
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const client = new HTTPClient({
      adapter: new NodeAdapter(),
      baseURL,
      followRedirects: true,
    });
    const followed = await client.get('/start').send();
    expect(followed.status).toBe(200);
    expect(followed.body).toBe('arrived');

    const cut = await client.get('/cut').send();
    expect(cut.status).toBe(302);
    expect(cut.isStreamError).toBe(true);
  } finally {
    server.close();
  }
});

test('a followed decode-failed redirect leaves no error behind; a 503 that only fails to decode is retried', async () => {
  let unavailableCount = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/start' || req.url === '/to-ok') {
      res.writeHead(302, {
        location: req.url === '/start' ? '/refused' : '/ok',
        'content-encoding': 'gzip',
      });
      res.end('Moved');
      return;
    }
    if (req.url === '/refused') {
      res.socket?.destroy();
      return;
    }
    if (req.url === '/busy' && unavailableCount++ === 0) {
      res.writeHead(503, { 'content-encoding': 'gzip' });
      res.end('Busy');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('arrived');
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const client = new HTTPClient({
      adapter: new NodeAdapter(),
      baseURL,
      followRedirects: true,
    });

    // The next hop's own failure is reported, not the redirect's decoding.
    const refused = client.get('/start');
    await refused.send();
    expect(refused.error?.code).toBe('network_error');

    // Redirect-phase observers see a plain 3xx.
    const seen: { status: number; isFailed: boolean; body: unknown }[] = [];
    client.addResponseObserver(
      (response) => {
        seen.push({
          status: response.status,
          isFailed: response.isFailed,
          body: response.body,
        });
      },
      { phases: ['redirect'] },
    );
    const ok = await client.get('/to-ok').send();
    expect(ok.body).toBe('arrived');
    expect(seen).toEqual([{ status: 302, isFailed: false, body: null }]);

    const retrying = new HTTPClient({
      adapter: new NodeAdapter(),
      baseURL,
      retryPolicy: { strategy: 'fixed', maxRetryAttempts: 2, delayMS: 1 },
    });
    const busy = await retrying.get('/busy').send();
    expect(busy.status).toBe(200);
    expect(busy.body).toBe('arrived');
  } finally {
    server.close();
  }
});

test('a plain ArrayBuffer body is held to maxResponseBytes', async () => {
  // A plain ArrayBuffer body from a custom adapter is held to maxResponseBytes.
  const bufferClient = new HTTPClient({
    adapter: {
      getType: () => 'mock',
      send: () =>
        Promise.resolve({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode(
            JSON.stringify({ pad: 'x'.repeat(90) }),
          ).buffer as unknown as Uint8Array,
        }),
    },
    baseURL: 'http://api.test',
    maxResponseBytes: 10,
  });
  const tooLarge = bufferClient.get('/x');
  await tooLarge.send();
  expect(tooLarge.error?.code).toBe('response_too_large');
});

test("an earlier hop's cause is not the next hop's", async () => {
  // An earlier hop's cause is not the next hop's.
  let hop = 0;
  const causeClient = new HTTPClient({
    adapter: {
      getType: () => 'mock',
      send: () =>
        Promise.resolve<AdapterResponse>(
          hop++ === 0
            ? {
                status: 302,
                headers: { location: '/b' },
                body: null,
                errorCause: new Error('hop1 stale cause'),
              }
            : { status: 0, isTransportError: true, headers: {}, body: null },
        ),
    },
    baseURL: 'http://api.test',
    followRedirects: true,
  });
  const stale = causeClient.get('/a');
  await stale.send();
  expect(stale.error?.code).toBe('network_error');
  expect(stale.error?.cause).toBeUndefined();
});

test('a jar that throws for the redirect target still names the redirect', async () => {
  // A jar that throws for the redirect target still names the redirect.
  const throwingJar = new CookieJar();
  const original = throwingJar.getCookieHeaderString.bind(throwingJar);
  throwingJar.getCookieHeaderString = (url: string) => {
    if (url.endsWith('/next')) {
      throw new Error('jar failed');
    }
    return original(url);
  };
  const jarClient = new HTTPClient({
    adapter: {
      getType: () => 'mock',
      send: (request) =>
        Promise.resolve<AdapterResponse>(
          request.requestURL.endsWith('/start')
            ? { status: 302, headers: { location: '/next' }, body: null }
            : { status: 200, headers: {}, body: null },
        ),
    },
    baseURL: 'http://api.test',
    followRedirects: true,
    cookieJar: throwingJar,
  });
  const jarFailure = jarClient.get('/start');
  const jarResponse = await jarFailure.send();
  expect(jarFailure.error?.code).toBe('request_setup_error');
  expect(jarResponse.wasRedirectDetected).toBe(true);
  expect(jarResponse.detectedRedirectURL).toBe('http://api.test/next');
});

test('a tab inside a cookie value is kept', () => {
  // A tab inside a cookie value is kept.
  const jar = new CookieJar();
  jar.processResponseHeaders(
    { 'set-cookie': ['a=x\ty', 'b=x y'] },
    'https://example.com/',
  );
  expect(jar.getCookieHeaderString('https://example.com/')).toContain('a=x\ty');
});

test('`*.` is no global wildcard', () => {
  // `*.` is no global wildcard.
  expect(matchesWildcardDomain('evil.com', '*.')).toBe(false);
  expect(matchesDomainList('evil.com', ['*.'])).toBe(false);
  expect(matchesOriginList('https://evil.com', ['*.'])).toBe(false);
});

test('credentials go from every network-path spelling when the initial URL is relative', () => {
  // Credentials go from every network-path spelling when the initial URL is relative.
  for (const target of [
    '\\\\user:pw@evil.com/x',
    '/\\user:pw@evil.com/x',
    ' //user:pw@evil.com/x',
    '\t//user:pw@evil.com/x',
  ]) {
    expect(stripCrossOriginURLCredentials(target, '/start')).not.toContain(
      'pw',
    );
  }
});

test('one bracket is no IPv6 literal', () => {
  // One bracket is no IPv6 literal.
  expect(isIPv6('[::1')).toBe(false);
  expect(normalizeDomain('[::1')).toBe('');
  expect(matchesDomainList('::1', ['[::1'])).toBe(false);
});

test('FetchAdapter reads a lowercase head as bodiless; a caller refusal counts 0 attempts with an interceptor', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, {
      'content-type': 'text/plain',
      'content-length': '1000',
    });
    res.end(req.method === 'HEAD' ? undefined : 'x'.repeat(1000));
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/x`;
  try {
    const response = await new FetchAdapter().send({
      requestURL: url,
      method: 'head',
      headers: {},
      maxResponseBytes: 10,
    });
    expect(response.isStreamError).toBeFalsy();
    expect(response.body).toBeNull();

    const client = new HTTPClient({
      adapter: new FetchAdapter(),
      baseURL: url,
    });
    client.addRequestInterceptor((request) => request);
    const refused = client.get('/x', { body: 'hello' });
    await refused.send();
    expect(refused.error?.code).toBe('request_setup_error');
    expect(refused.attemptCount).toBe(0);
  } finally {
    server.close();
  }
});

const zstdCompressSync = (
  zlib as unknown as { zstdCompressSync?: (input: Buffer) => Buffer }
).zstdCompressSync;

test.skipIf(zstdCompressSync === undefined)(
  'a zstd body cut short is a stream error, as gzip, br and deflate are',
  async () => {
    const big = Buffer.from(
      Array.from({ length: 50000 }, (_, i) => String(i)).join(','),
    );
    const whole = (zstdCompressSync as (input: Buffer) => Buffer)(big);
    let body = whole;
    const server = http.createServer((_req, res) => {
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-encoding': 'zstd',
      });
      res.end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const client = new HTTPClient({ adapter: new NodeAdapter(), baseURL });
      const complete = await client.get('/').send();
      expect(complete.isFailed).toBe(false);
      expect((complete.body as Uint8Array).byteLength).toBe(big.length);

      for (const cut of [1, Math.floor(whole.length / 2)]) {
        body = whole.subarray(0, whole.length - cut);
        const truncated = await client.get('/').send();
        expect(truncated.isStreamError).toBe(true);
      }
    } finally {
      server.close();
    }
  },
);

test('a cancel between hops carries no cause from the 3xx it leaves', async () => {
  const client = new HTTPClient({
    adapter: {
      getType: () => 'mock',
      send: () =>
        Promise.resolve<AdapterResponse>({
          status: 302,
          headers: { location: '/b' },
          body: null,
          errorCause: new Error('hop1 stale cause'),
        }),
    },
    baseURL: 'http://api.test',
    followRedirects: true,
  });
  client.addRequestInterceptor(() => ({ cancel: true }), {
    phases: ['redirect'],
  });
  const builder = client.get('/a');
  await builder.send();
  expect(builder.error?.code).toBe('cancelled');
  expect(builder.error?.cause).toBeUndefined();
});

test('a jar that throws for the redirect target reports the target as requestURL', async () => {
  const throwingJar = new CookieJar();
  const original = throwingJar.getCookieHeaderString.bind(throwingJar);
  throwingJar.getCookieHeaderString = (url: string) => {
    if (url.endsWith('/next')) {
      throw new Error('jar failed');
    }
    return original(url);
  };
  const client = new HTTPClient({
    adapter: {
      getType: () => 'mock',
      send: (request) =>
        Promise.resolve<AdapterResponse>(
          request.requestURL.endsWith('/start')
            ? { status: 302, headers: { location: '/next' }, body: null }
            : { status: 200, headers: {}, body: null },
        ),
    },
    baseURL: 'http://api.test',
    followRedirects: true,
    cookieJar: throwingJar,
  });
  const response = await client.get('/start').send();
  expect(response.requestURL).toBe('http://api.test/next');
  expect(response.redirectHistory).toEqual(['http://api.test/next']);
  expect(response.detectedRedirectURL).toBe('http://api.test/next');
});

test('a string body from a custom adapter is held to maxResponseBytes', async () => {
  const client = new HTTPClient({
    adapter: {
      getType: () => 'mock',
      send: () =>
        Promise.resolve({
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
          body: 'x'.repeat(1000) as unknown as Uint8Array,
        }),
    },
    baseURL: 'http://api.test',
    maxResponseBytes: 10,
  });
  const builder = client.get('/x');
  await builder.send();
  expect(builder.error?.code).toBe('response_too_large');

  // Counted as UTF-8: four characters, twelve bytes.
  const multibyte = new HTTPClient({
    adapter: {
      getType: () => 'mock',
      send: () =>
        Promise.resolve({
          status: 200,
          headers: { 'content-type': 'text/plain' },
          body: '€€€€' as unknown as Uint8Array,
        }),
    },
    baseURL: 'http://api.test',
    maxResponseBytes: 10,
  });
  const euro = multibyte.get('/x');
  await euro.send();
  expect(euro.error?.code).toBe('response_too_large');
});

test('a tab inside a cookie name or value is kept, as RFC 6265bis keeps it; one at a name edge is refused', () => {
  const jar = new CookieJar();
  const base = { domain: 'example.com', path: '/', value: '1', hostOnly: true };
  expect(jar.setCookie({ ...base, name: 'a\tb' })).toBe(true);
  expect(jar.setCookie({ ...base, name: '\tab' })).toBe(false);
  jar.processResponseHeaders(
    { 'set-cookie': ['c\td=1', 'e=x\ty'] },
    'https://example.com/',
  );
  expect(jar.getCookieHeaderString('https://example.com/')).toBe(
    'a\tb=1; c\td=1; e=x\ty',
  );
});

test('Domain=..example.com and SameSite=None without Secure are ignored', () => {
  const jar = new CookieJar();
  jar.processResponseHeaders(
    {
      'set-cookie': [
        'dots=1; Domain=..example.com',
        'lax=1; SameSite=None',
        'ok=1; SameSite=None; Secure',
      ],
    },
    'https://www.example.com/',
  );
  expect(jar.getCookieHeaderString('https://www.example.com/')).toBe('ok=1');
});

test('a cookie replacing an expired one takes its own place in the header', () => {
  const jar = new CookieJar();
  const start = Date.now();

  try {
    // Expired once stored, and not yet purged; host-only, so `a=new` replaces it.
    setSystemTime(new Date(start));
    expect(
      jar.setCookie({
        name: 'a',
        value: 'old',
        domain: 'example.com',
        hostOnly: true,
        path: '/',
        maxAge: 1,
      }),
    ).toBe(true);
    setSystemTime(new Date(start + 2000));
    jar.processResponseHeaders({ 'set-cookie': 'b=1' }, 'https://example.com/');
    setSystemTime(new Date(start + 2002));
    jar.processResponseHeaders(
      { 'set-cookie': 'a=new' },
      'https://example.com/',
    );
    expect(jar.getCookieHeaderString('https://example.com/')).toBe(
      'b=1; a=new',
    );
  } finally {
    setSystemTime();
  }
});

test('MockAdapter drops a path-only URL fragment and a 1xx body', async () => {
  const adapter = new MockAdapter();
  const seen: unknown[] = [];
  adapter.routes.get('/x', (request) => {
    seen.push(request.query);
    return { status: 200, body: 'ok' };
  });
  adapter.routes.get('/info', () => ({ status: 101, body: 'hi' }));
  await adapter.send({
    requestURL: '/x?a=1#frag',
    method: 'GET',
    headers: {},
  });
  expect(seen).toEqual([{ a: '1' }]);
  const informational = await adapter.send({
    requestURL: 'http://api.test/info',
    method: 'GET',
    headers: {},
  });
  expect(informational.body).toBeNull();
});

test('credentials-list trailing-dot wildcards and whitespace in origin patterns', () => {
  expect(
    matchesCORSCredentialsList(
      'https://a.example.com',
      ['https://*.example.com.'],
      { allowWildcardSubdomains: true },
    ),
  ).toBe(true);
  expect(matchesOriginList('https://evil.com', ['https:// *'])).toBe(false);
});

test('a status-0 answer carries its errorCause without isTransportError', async () => {
  const client = new HTTPClient({
    adapter: {
      getType: () => 'mock',
      send: () =>
        Promise.resolve<AdapterResponse>({
          status: 0,
          headers: {},
          body: null,
          errorCause: new Error('connect ECONNREFUSED'),
        }),
    },
    baseURL: 'http://api.test',
  });
  const builder = client.get('/x');
  await builder.send();
  expect(builder.error?.code).toBe('network_error');
  expect(builder.error?.cause?.message).toBe('connect ECONNREFUSED');
});

test('origin matchers agree with validateConfigEntry on whitespace and empty extras', () => {
  // Whitespace in a protocol wildcard's host: as the validator reads it.
  expect(validateConfigEntry('https:// *.example.com', 'origin').valid).toBe(
    true,
  );
  expect(
    matchesOriginList('https://a.example.com', ['https:// *.example.com']),
  ).toBe(true);
  expect(validateConfigEntry('https:// *', 'origin').valid).toBe(false);
  expect(matchesOriginList('https://evil.com', ['https:// *'])).toBe(false);

  // An empty userinfo, query or fragment is still one.
  for (const origin of [
    'https://example.com?',
    'https://example.com#',
    'https://@example.com',
    'https://:@example.com',
  ]) {
    expect(validateConfigEntry(origin, 'origin').valid).toBe(false);
    expect(normalizeOrigin(origin)).toBe('');
    expect(matchesOriginList(origin, ['https://example.com'])).toBe(false);
    expect(matchesOriginList('https://example.com', [origin])).toBe(false);
  }
  expect(
    matchesWildcardOrigin('https://a.example.com?', 'https://*.example.com'),
  ).toBe(false);
});

test('MockAdapter never serializes a streamError route body', async () => {
  const adapter = new MockAdapter();
  adapter.routes.get('/x', () => ({
    status: 200,
    body: new Map() as unknown as string,
    streamError: true,
  }));
  const response = await adapter.send({
    requestURL: 'http://api.test/x',
    method: 'GET',
    headers: {},
  });
  expect(response.status).toBe(200);
  expect(response.isStreamError).toBe(true);
  expect(response.body).toBeNull();
});

test('each callback is handed its own copy of the redirect hop', async () => {
  let hits = 0;
  const client = new HTTPClient({
    adapter: {
      getType: () => 'mock',
      send: (request) => {
        if (request.requestURL.endsWith('/1')) {
          return Promise.resolve<AdapterResponse>({
            status: 302,
            headers: { location: '/2' },
            body: null,
          });
        }
        return Promise.resolve<AdapterResponse>(
          hits++ === 0
            ? { status: 503, headers: {}, body: null }
            : { status: 200, headers: {}, body: null },
        );
      },
    },
    baseURL: 'http://api.test',
    followRedirects: true,
    retryPolicy: { strategy: 'fixed', maxRetryAttempts: 2, delayMS: 1 },
  });
  const seen: string[] = [];
  client.addResponseObserver(
    (_response, _request, phase) => {
      if (phase.type === 'retry' && phase.redirect) {
        seen.push(phase.redirect.to);
      }
    },
    { phases: ['retry'] },
  );
  const response = await client
    .get('/1')
    .onAttemptStart((event) => {
      if (event.redirect) {
        event.redirect.to = 'https://MUTATED/';
      }
    })
    .send();
  expect(response.status).toBe(200);
  expect(seen).toEqual(['http://api.test/2']);
});

test('each observer and interceptor in a chain gets its own phase', async () => {
  let hits = 0;
  const client = new HTTPClient({
    adapter: {
      getType: () => 'mock',
      send: (request) =>
        Promise.resolve<AdapterResponse>(
          request.requestURL.endsWith('/a')
            ? { status: 302, headers: { location: '/b' }, body: null }
            : hits++ === 0
              ? { status: 503, headers: {}, body: null }
              : { status: 200, headers: {}, body: null },
        ),
    },
    baseURL: 'http://api.test',
    followRedirects: true,
    retryPolicy: { strategy: 'fixed', maxRetryAttempts: 2, delayMS: 1 },
  });
  const seen: string[] = [];
  const mutate = (phase: { type: string; redirect?: { to: string } }) => {
    if (phase.type === 'retry' && phase.redirect) {
      seen.push(phase.redirect.to);
      phase.redirect.to = 'MUTATED';
    }
  };
  client.addResponseObserver((_r, _q, phase) => mutate(phase), {
    phases: ['retry'],
  });
  client.addResponseObserver((_r, _q, phase) => mutate(phase), {
    phases: ['retry'],
  });
  client.addRequestInterceptor(
    (request, phase) => {
      mutate(phase);
      return request;
    },
    { phases: ['retry'] },
  );
  client.addRequestInterceptor(
    (request, phase) => {
      mutate(phase);
      return request;
    },
    { phases: ['retry'] },
  );
  const response = await client.get('/a').send();
  expect(response.status).toBe(200);
  expect(seen).toEqual(Array.from({ length: 4 }, () => 'http://api.test/b'));
});

test('a trailing space after a protocol wildcard still matches; a Unicode dot in a Set-Cookie Domain is non-ASCII', () => {
  expect(matchesWildcardOrigin('https://a.example.com', 'https://* ')).toBe(
    true,
  );
  expect(matchesWildcardOrigin('https://a.example.com', 'https:// *')).toBe(
    false,
  );

  const jar = new CookieJar();
  jar.processResponseHeaders(
    { 'set-cookie': 'a=1; Domain=。example.com' },
    'https://www.example.com/',
  );
  // Ignored whole, as RFC 6265bis ignores a non-ASCII Domain.
  expect(jar.getAllCookies()).toEqual([]);
});

test('a coding chain refused as too long is a decode failure, so a 503 is retried', async () => {
  let hits = 0;
  const server = http.createServer((_req, res) => {
    if (hits++ === 0) {
      res.writeHead(503, {
        'content-encoding': Array.from({ length: 6 }, () => 'gzip').join(','),
      });
      res.end('x');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const client = new HTTPClient({
      adapter: new NodeAdapter(),
      baseURL,
      retryPolicy: { strategy: 'fixed', maxRetryAttempts: 2, delayMS: 1 },
    });
    const response = await client.get('/').send();
    expect(hits).toBe(2);
    expect(response.status).toBe(200);
  } finally {
    server.close();
  }
});

test('a nameless cookie posing as a prefix is ignored whole', () => {
  const jar = new CookieJar();
  jar.parseSetCookieHeader('flag', 'https://n.example/');
  jar.parseSetCookieHeader('__Host-x; Max-Age=0', 'https://n.example/');
  expect(jar.getCookieHeaderString('https://n.example/')).toBe('flag');
});

test('the last SameSite wins, an unrecognized one included', () => {
  const sameSite = new CookieJar();
  sameSite.parseSetCookieHeader(
    'a=1; SameSite=None; SameSite=bogus',
    'https://s.example/',
  );
  sameSite.parseSetCookieHeader(
    'b=1; SameSite=Strict; SameSite=bogus',
    'https://s.example/',
  );
  expect(sameSite.getAllCookies().map((c) => [c.name, c.sameSite])).toEqual([
    ['a', undefined],
    ['b', undefined],
  ]);
});

test('each interceptor gets its own context', async () => {
  const client = new HTTPClient({
    adapter: {
      getType: () => 'mock',
      send: () =>
        Promise.resolve<AdapterResponse>({
          status: 200,
          headers: {},
          body: null,
        }),
    },
    baseURL: 'http://api.test',
  });
  const seen: unknown[] = [];
  client.addRequestInterceptor((request, _phase, context) => {
    context.redirectHistory.push('https://evil.test/');
    context.attemptNumber = 99;
    return request;
  });
  client.addRequestInterceptor((request, _phase, context) => {
    seen.push([context.redirectHistory.length, context.attemptNumber]);
    return request;
  });
  await client.get('/x').send();
  expect(seen).toEqual([[0, 1]]);
});

test('the credentials list and wildcard origins trim as the validator does', () => {
  expect(
    matchesCORSCredentialsList(
      'https://a.example.com',
      ['https:// *.example.com'],
      { allowWildcardSubdomains: true },
    ),
  ).toBe(true);
  expect(matchesWildcardOrigin('https://a.example.com', ' https://*')).toBe(
    true,
  );
});

test('whitespace inside a wildcard pattern is refused, as in an exact entry', () => {
  for (const pattern of ['*.example .com', '*. example.com']) {
    expect(validateConfigEntry(pattern, 'domain').valid).toBe(false);
    expect(matchesDomainList('a.example.com', [pattern])).toBe(false);
  }
});

test('a name is at most 253 characters', () => {
  const label = 'a'.repeat(63);
  const tooLong = [label, label, label, label].join('.'); // 255 characters
  const longest = [label, label, label, 'a'.repeat(61)].join('.'); // 253
  expect(normalizeDomain(tooLong)).toBe('');
  expect(normalizeDomain(longest)).toBe(longest);
});

test('no wildcard over a tail a PSL wildcard rule makes every child of a suffix', () => {
  for (const pattern of ['*.kawasaki.jp', '*.*.sch.uk', '*.sch.uk']) {
    expect(validateConfigEntry(pattern, 'domain').valid).toBe(false);
  }
  expect(matchesWildcardDomain('city.kawasaki.jp', '*.kawasaki.jp')).toBe(
    false,
  );
  expect(matchesWildcardDomain('county.sch.uk', '*.sch.uk')).toBe(false);
  expect(
    matchesCORSCredentialsList(
      'https://city.kawasaki.jp',
      ['https://*.kawasaki.jp'],
      { allowWildcardSubdomains: true },
    ),
  ).toBe(false);
  // An ordinary tail is unaffected.
  expect(matchesWildcardDomain('a.example.com', '*.example.com')).toBe(true);
});

test('a trailing dot is not a label toward the 127-label cap', () => {
  expect(checkDNSLength('x.'.repeat(127))).toBe(true);
  expect(checkDNSLength(`${'x.'.repeat(126)}x`)).toBe(true);
  // 128 labels, refused - by the 253-character limit, which no 128-label name meets.
  expect(checkDNSLength(`${'x.'.repeat(127)}x`)).toBe(false);
});

test('every IPv6 form the URL parser reads is an IPv6 literal, brackets kept', () => {
  for (const address of ['1:2:3:4:5:6:1.2.3.4', '1:2:3:4:5::1.2.3.4']) {
    expect(isIPv6(address)).toBe(true);
  }
  expect(isIPv6('::1.2.3.04')).toBe(false);
  expect(normalizeOrigin('http://[1:2:3:4:5:6:1.2.3.4]:8080')).toBe(
    'http://[1:2:3:4:5:6:102:304]:8080',
  );
  expect(
    matchesOriginList('http://[1:2:3:4:5:6:102:304]', [
      'http://[1:2:3:4:5:6:1.2.3.4]',
    ]),
  ).toBe(true);
});

test('a bare cookie attribute reads as one with an empty value', () => {
  const jar = new CookieJar();
  jar.parseSetCookieHeader(
    '__Host-id=1; Secure; Path=/; Path',
    'https://example.com/app/page',
  );
  expect(jar.getAllCookies()).toEqual([]);

  jar.parseSetCookieHeader('a=1; Path=/; Path', 'https://example.com/app/page');
  expect(jar.getAllCookies()[0]?.path).toBe('/app');

  const sameSite = new CookieJar();
  sameSite.parseSetCookieHeader(
    'a=1; SameSite=None; SameSite',
    'https://example.com/',
  );
  expect(sameSite.getAllCookies().map((c) => c.sameSite)).toEqual([undefined]);

  const domain = new CookieJar();
  domain.parseSetCookieHeader(
    'a=1; Domain=example.com; Domain',
    'https://www.example.com/',
  );
  expect(domain.getAllCookies()[0]?.hostOnly).toBe(true);
});

test('a publicSuffixes entry ending in a number is refused', () => {
  for (const entry of ['10.0.0.1', 'corp.123']) {
    expect(() => new CookieJar({ publicSuffixes: { add: [entry] } })).toThrow(
      TypeError,
    );
  }
  expect(
    () => new CookieJar({ publicSuffixes: { add: ['corp.internal'] } }),
  ).not.toThrow();
});

test('MockAdapter echoes req.params; NodeAdapter joins case-variant header names', async () => {
  const mock = new MockAdapter();
  mock.routes.get('/u/:id', (request) => ({
    status: 200,
    body: request.params,
  }));
  const echoed = await mock.send({
    requestURL: 'http://api.test/u/7',
    method: 'GET',
    headers: {},
  });
  expect(echoed.status).toBe(200);

  let received: string | string[] | undefined;
  const server = http.createServer((req, res) => {
    received = req.headers['x-a'];
    res.end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  try {
    await new NodeAdapter().send({
      requestURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
      method: 'GET',
      headers: { 'X-A': '1', 'x-a': '2' },
    });
    expect(received).toBe('1, 2');
  } finally {
    server.close();
  }
});

test('a redirect hop cancelled before it went out is detected, not followed', async () => {
  const adapter = new MockAdapter();
  const hits: string[] = [];
  adapter.routes.get('/g', () => {
    hits.push('/g');
    return { status: 302, headers: { location: '/h' } };
  });
  adapter.routes.get('/h', () => {
    hits.push('/h');
    return { status: 200, body: 'ok' };
  });
  const client = new HTTPClient({
    adapter,
    baseURL: 'http://api.test',
    followRedirects: true,
  });
  const builder = client.get('/g');
  builder.onAttemptStart((event) => {
    if (event.attemptNumber === 2) {
      builder.cancel();
    }
  });
  const response = await builder.send();
  expect(hits).toEqual(['/g']);
  expect(response.isCancelled).toBe(true);
  expect(response.wasRedirectFollowed).toBe(false);
  expect(response.detectedRedirectURL).toBe('http://api.test/h');
});

test('an observer rawBody keeps an own __proto__ key; builder.response is set for final observers', async () => {
  const adapter = new MockAdapter();
  adapter.routes.post('/x', () => ({ status: 200, body: 'ok' }));
  const client = new HTTPClient({ adapter, baseURL: 'http://api.test' });
  let rawBody: unknown;
  client.addResponseObserver((_response, request) => {
    rawBody = request.rawBody;
  });
  await client.post('/x').json(JSON.parse('{"a":1,"__proto__":[1,2]}')).send();
  expect(Object.hasOwn(rawBody as object, '__proto__')).toBe(true);
  expect(Object.getPrototypeOf(rawBody)).toBe(Object.prototype);

  const seen: unknown[] = [];
  const builder = client.post('/x');
  client.addResponseObserver(() => {
    seen.push(builder.response?.status);
  });
  await builder.send();
  expect(seen.at(-1)).toBe(200);
});

test('FetchAdapter keeps a __proto__ header beside a Content-Length and joins case-variant cookies', async () => {
  // The raw list: a parsed header record cannot hold a `__proto__` key.
  const received: string[][] = [];
  const server = http.createServer((req, res) => {
    received.push(req.rawHeaders.map((entry) => entry.toLowerCase()));
    res.end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  try {
    const headers: Record<string, string> = JSON.parse(
      '{"__proto__":"x","Content-Length":"3"}',
    );
    await new FetchAdapter().send({
      requestURL: url,
      method: 'POST',
      headers,
      body: new TextEncoder().encode('abc'),
    });
    expect(received[0]).toContain('__proto__');

    await new FetchAdapter().send({
      requestURL: url,
      method: 'GET',
      headers: { Cookie: 'a=1', cookie: ['b=2', 'c=3'] },
    });
    expect(received[1]).toContain('a=1; b=2; c=3');
  } finally {
    server.close();
  }
});

test('setCookie refuses a non-boolean flag; fromJSON reads a null one as absent', () => {
  const jar = new CookieJar();
  const base = { name: 'a', value: '1', domain: 'example.com' };
  expect(jar.setCookie({ ...base, secure: 'true' as unknown as boolean })).toBe(
    false,
  );
  expect(jar.setCookie({ ...base, hostOnly: null as unknown as boolean })).toBe(
    false,
  );
  expect(
    jar.fromJSON({
      cookies: [
        { ...base, secure: null as unknown as boolean, createdAt: Date.now() },
      ],
    }),
  ).toBe(1);
  expect(jar.getCookieHeaderString('https://example.com/')).toBe('a=1');
});

test('setCookie accepts a Date from another realm', () => {
  const jar = new CookieJar();
  const expires = vm.runInNewContext('new Date(Date.now() + 3600000)') as Date;
  expect(
    jar.setCookie({ name: 'a', value: '1', domain: 'example.com', expires }),
  ).toBe(true);
  expect(jar.getAllCookies()[0]?.expires).toBeInstanceOf(Date);
  expect(jar.getCookieHeaderString('https://example.com/')).toBe('a=1');
});

test('a malformed publicSuffixes config throws', () => {
  for (const publicSuffixes of [
    ['corp.internal'],
    'corp.internal',
    { ad: ['corp.internal'] },
    42,
  ]) {
    expect(
      () =>
        new CookieJar({ publicSuffixes } as unknown as ConstructorParameters<
          typeof CookieJar
        >[0]),
    ).toThrow(TypeError);
  }
});

test('a trailing dot IDNA mapping exposes is one trailing dot', () => {
  expect(normalizeDomain('example.com.\u00AD')).toBe('example.com');
  expect(normalizeDomain('example.com.\u00AD.')).toBe('');
  expect(validateConfigEntry('com.\u00AD', 'domain').valid).toBe(false);
  expect(matchesDomainList('example.com', ['example.com.\u00AD'])).toBe(true);
});

test('a same-scheme URL without slashes is read on its own for credentials', () => {
  expect(
    stripCrossOriginURLCredentials('https:u:p@b.com/x', 'https://a.com/'),
  ).toBe('https://b.com/x');
});

test('header names are lowercased in ASCII only', () => {
  const kelvin = 'X-Key';
  expect(mergeHeaders({ [kelvin]: 'v' })).toEqual({ [`x-Key`]: 'v' });
});

test('NodeAdapter refuses a non-http scheme and does not retry a malformed userinfo escape', async () => {
  let hits = 0;
  const server = http.createServer((_req, res) => {
    hits++;
    res.end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    let refusal: unknown;
    try {
      await new NodeAdapter().send({
        requestURL: `wss://u:p@127.0.0.1:${port}/x`,
        method: 'GET',
        headers: {},
      });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(Error);
    expect(hits).toBe(0);

    const client = new HTTPClient({
      adapter: new NodeAdapter(),
      retryPolicy: { strategy: 'fixed', maxRetryAttempts: 2, delayMS: 1 },
    });
    const builder = client.get(`http://a%E0:b@127.0.0.1:${port}/`);
    await builder.send();
    expect(builder.error?.code).toBe('adapter_error');
    expect(builder.attemptCount).toBe(1);
  } finally {
    server.close();
  }
});

test('a late cancel keeps a redirect detected with no target to name', async () => {
  const adapter = new MockAdapter();
  adapter.routes.get('/x', () => ({ status: 302 }));
  const client = new HTTPClient({
    adapter,
    baseURL: 'http://api.test',
    followRedirects: true,
  });
  const builder = client.get('/x');
  builder.onAttemptEnd(() => {
    builder.cancel();
  });
  const response = await builder.send();
  expect(response.isCancelled).toBe(true);
  expect(response.wasRedirectDetected).toBe(true);
  expect(builder.error?.wasRedirectDetected).toBe(true);
});

test('a word-final Σ is read as the URL parser reads it; "null" is never a domain match; hex suffix tails refused', () => {
  expect(normalizeDomain('ΑΣ-b.com')).toBe(
    new URL('https://ΑΣ-b.com').hostname,
  );
  // `ας-b.com` is another domain.
  expect(
    matchesCORSCredentialsList('https://xn---b-b9b2e.com', ['ΑΣ-b.com']),
  ).toBe(false);
  expect(
    matchesOriginList(`https://${new URL('https://ΑΣ-b.com').hostname}`, [
      'ΑΣ-b.com',
    ]),
  ).toBe(true);

  expect(matchesDomainList('null', ['*'])).toBe(false);

  for (const entry of ['corp.0x1f', 'corp.0x']) {
    expect(() => new CookieJar({ publicSuffixes: { add: [entry] } })).toThrow(
      TypeError,
    );
  }
});

test('a Kelvin-sign header name is not grouped with a real one on the way out', () => {
  expect(materializeRequestHeaders({ 'x-key': 'a', 'X-Key': 'b' })).toEqual({
    'x-key': 'a',
    'X-Key': 'b',
  });
});

test('a CRL with a leading byte-order mark, or in a view at an offset, is read', () => {
  const crl = getRevocationFixtures().crlEmpty;
  // Bun's `tls` read a view from the start of its memory.
  expect(
    () => new NodeAdapter({ crl: Buffer.from(`xxxx${crl}`).subarray(4) }),
  ).not.toThrow();
  expect(() => new NodeAdapter({ crl: `\uFEFF${crl}` })).not.toThrow();
  expect(
    () =>
      new NodeAdapter({
        crl: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(crl)]),
      }),
  ).not.toThrow();
});

test('a cross-origin Location password never reaches redirect-phase observers or interceptors', async () => {
  const adapter = new MockAdapter();
  adapter.routes.get('/a', () => ({
    status: 302,
    headers: { location: 'https://admin:secret@other.example/x' },
  }));
  const client = new HTTPClient({
    adapter,
    baseURL: 'https://api.test',
    followRedirects: true,
  });
  const seen: string[] = [];
  client.addResponseObserver(
    (_response, _request, phase) => {
      if (phase.type === 'redirect') {
        seen.push(phase.to);
      }
    },
    { phases: ['redirect'] },
  );
  client.addRequestInterceptor(
    (request, phase, context) => {
      if (phase.type === 'redirect') {
        seen.push(phase.to, ...context.redirectHistory);
      }
      return request;
    },
    { phases: ['redirect'] },
  );
  await client.get('/a').send();
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.every((url) => !url.includes('secret'))).toBe(true);
});

test('a thrown failure on a POST names the method as why it was not retried', async () => {
  const client = new HTTPClient({
    adapter: {
      getType: () => 'mock',
      send: () =>
        Promise.reject(
          Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
        ),
    },
    baseURL: 'http://api.test',
    retryPolicy: { strategy: 'fixed', maxRetryAttempts: 2, delayMS: 1 },
  });
  const ends: unknown[] = [];
  await client
    .post('/x')
    .onAttemptEnd((event) => ends.push(event.retrySuppressedReason))
    .send();
  expect(ends).toEqual(['non_idempotent_method']);
});

test('a combining mark that maps to a letter is read in the URL parser order', () => {
  const host = 'x́ͅ.example.com';
  const browserHost = new URL(`https://${host}`).hostname;
  expect(normalizeDomain(host)).toBe(browserHost);
  expect(matchesDomainList(browserHost, [host])).toBe(true);
  expect(
    matchesDomainList(new URL(`https://a.${host}`).hostname, [`*.${host}`]),
  ).toBe(true);

  // The cookie jar's domains too, and its Σ case.
  const jar = new CookieJar();
  jar.setCookie({ name: 'a', value: '1', domain: 'ΑΣ-b.com' });
  expect(jar.getAllCookies()[0]?.domain).toBe(
    new URL('https://ΑΣ-b.com').hostname,
  );
});

test('MockAdapter groups request header names in ASCII case only', async () => {
  const adapter = new MockAdapter();
  const seen: unknown[] = [];
  adapter.routes.get('/h', (request) => {
    seen.push(request.headers['x-key']);
    return { status: 200, body: 'ok' };
  });
  await adapter.send({
    requestURL: 'http://api.test/h',
    method: 'GET',
    headers: { 'x-key': 'a', 'x-Key': 'b' },
  });
  expect(seen).toEqual(['a']);
});

test('a cookie domain whose trailing dot only IDNA mapping exposes is stored as the URL parser reads it', () => {
  const jar = new CookieJar();
  jar.setCookie({ name: 'sid', value: 'a', domain: 'example.com' });
  // The URL parser reads `example.com.` and a soft hyphen as `example.com.`, a host of
  // its own, so the jar files it there.
  jar.setCookie({ name: 'sid', value: 'b', domain: 'example.com.\u00AD' });
  expect(jar.getStoredDomains()).toEqual([
    { domain: 'example.com', count: 1 },
    { domain: 'example.com.', count: 1 },
  ]);
  expect(jar.getCookieHeaderString('https://example.com/')).toBe('sid=a');
  expect(jar.getCookieHeaderString('https://example.com.\u00AD/')).toBe(
    'sid=b',
  );
  // A second trailing dot exposed the same way names no host.
  expect(
    jar.setCookie({ name: 'sid', value: 'c', domain: 'example.com.\u00AD.' }),
  ).toBe(false);
});

test('NodeAdapter refuses an Expect header; a decode failure during stream setup keeps its cause', async () => {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits++;
    if (req.url === '/corrupt') {
      res.writeHead(200, { 'content-encoding': 'gzip' });
      res.write('not gzip at all');
      return; // held open
    }
    res.end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const client = new HTTPClient({
      adapter: new NodeAdapter(),
      baseURL,
      retryPolicy: { strategy: 'fixed', maxRetryAttempts: 2, delayMS: 1 },
    });
    const form = new FormData();
    form.append('a', 'b');
    const expecting = client
      .put('/upload')
      .headers({ expect: '100-continue' })
      .formData(form);
    await expecting.send();
    expect(expecting.error?.code).toBe('adapter_error');
    expect(expecting.attemptCount).toBe(1);
    expect(hits).toBe(0);

    const streamed = client.get('/corrupt').streamResponse(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return new Writable({
        write(_chunk, _encoding, done) {
          done();
        },
      });
    });
    await streamed.send();
    expect(streamed.error?.cause?.message).not.toBe(
      'Response stream closed during setup',
    );
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('maxRedirects must be a whole number; a request path must be a string', () => {
  expect(
    () =>
      new HTTPClient({
        adapter: new MockAdapter(),
        followRedirects: true,
        maxRedirects: 1.5,
      }),
  ).toThrow();
  const client = new HTTPClient({
    adapter: new MockAdapter(),
    baseURL: 'http://api.test',
  });
  for (const path of [new URL('http://api.test/x'), 123, undefined]) {
    expect(() => client.get(path as unknown as string)).toThrow(TypeError);
  }
});

test('a decomposed Unicode label is measured composed; an Expect header is refused even without a body; a hostile path value is described', async () => {
  const label = 'é'.repeat(35); // 70 code units, 35 once composed
  expect(normalizeDomain(`${label}.example.com`)).not.toBe('');
  expect(validateConfigEntry(`*.${label}.example.com`, 'domain').valid).toBe(
    true,
  );

  // Refused bodiless too: Node would otherwise send it chunked rather than with no length.
  let refusal: unknown;
  try {
    await new NodeAdapter().send({
      requestURL: 'http://127.0.0.1:1/',
      method: 'GET',
      headers: { expect: '100-continue' },
    });
  } catch (error) {
    refusal = error;
  }
  expect(refusal).toBeInstanceOf(TypeError);

  // A label TR46 shortens (soft hyphens map to nothing) is measured after mapping, not
  // refused before it.
  const softened = `example${'\u00ad'.repeat(60)}`;
  expect(matchesDomainList('x.example.com', [`*.${softened}.com`])).toBe(true);

  const client = new HTTPClient({
    adapter: new MockAdapter(),
    baseURL: 'http://api.test',
  });
  const hostile = new Proxy(
    {},
    {
      getPrototypeOf() {
        throw new Error('boom');
      },
    },
  );
  expect(() => client.get(hostile as unknown as string)).toThrow(TypeError);
});

test('a decode failure after the raw body ended reaches a pending stream setup', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-encoding': 'gzip' });
    res.end('not gzip at all, and the body ends here');
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    // No timeout: before, an async factory waited for ever.
    const client = new HTTPClient({
      adapter: new NodeAdapter(),
      baseURL,
      timeout: 0,
    });
    const started = Date.now();
    const builder = client.get('/').streamResponse(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      return new Writable({
        write(_chunk, _encoding, done) {
          done();
        },
      });
    });
    await builder.send();
    expect(builder.error?.code).toBe('stream_response_error');
    // Settled when decoding failed, not once the factory was done.
    expect(Date.now() - started).toBeLessThan(1_500);
  } finally {
    server.close();
  }
}, 10_000);

test('a hostile body is of unknown size, not a throw; header names are matched in ASCII case on the way out', () => {
  const hostile = new Proxy(
    {},
    {
      getPrototypeOf() {
        throw new Error('boom');
      },
    },
  );
  expect(knownBodyByteLength(hostile)).toBeUndefined();

  // The Kelvin-sign name is no `x-key`, so a real one is kept apart from it.
  expect(isBrowserRestrictedHeader('\u212Aeep-Alive', 'x')).toBe(false);
});

function stubResponse(): http.IncomingMessage {
  const res = new PassThrough() as unknown as http.IncomingMessage;
  Object.defineProperty(res, 'complete', { value: false, writable: true });
  return res;
}

test('a throwing failure listener stays contained; a body torn down by one holds nothing', async () => {
  const res = stubResponse();
  const { source } = createResponseBodySource(res, 'gzip');
  let didTearDown = false;
  source.onFailure?.(() => {
    throw new Error('listener failed');
  });
  source.onFailure?.(() => {
    didTearDown = true;
    (source as unknown as { destroy(): void }).destroy();
  });
  const uncaught: unknown[] = [];
  const onUncaught = (error: unknown) => uncaught.push(error);
  process.on('uncaughtException', onUncaught);
  try {
    (res as unknown as PassThrough).end(Buffer.from('not gzip at all'));
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    process.off('uncaughtException', onUncaught);
  }
  expect(uncaught).toEqual([]);
  expect(didTearDown).toBe(true);
  expect(source.heldError?.()).toBeUndefined();
});

test('an empty inner layer fails as a stream that ends early, whichever its coding', async () => {
  const zlib = await import('node:zlib');

  for (const inner of ['deflate', 'gzip', 'br', 'zstd']) {
    const res = stubResponse();
    const { source } = createResponseBodySource(res, `${inner}, gzip`);
    const outcome = await new Promise<string>((resolve) => {
      source.on('data', () => undefined);
      source.on('error', () => resolve('error'));
      source.on('end', () => resolve('end'));
      Object.assign(res, { complete: true });
      (res as unknown as PassThrough).end(zlib.gzipSync(Buffer.alloc(0)));
    });

    expect({ inner, outcome }).toEqual({ inner, outcome: 'error' });
  }
});

test('a first chunk that fills the decoder pauses the response, as pipe does for later ones', async () => {
  const zlib = await import('node:zlib');
  const { randomBytes } = await import('node:crypto');
  const res = stubResponse();
  createResponseBodySource(res, 'gzip');

  // Incompressible, so the first chunk is far past the decoder's buffer.
  (res as unknown as PassThrough).write(zlib.gzipSync(randomBytes(1 << 20)));
  await new Promise((resolve) => setTimeout(resolve, 10));

  expect((res as unknown as PassThrough).isPaused()).toBe(true);
});

test('onFailure replays a failure held before it subscribed', async () => {
  const res = stubResponse();
  const { source } = createResponseBodySource(
    res,
    Array.from({ length: 6 }, () => 'gzip').join(','),
  );
  const told: Error[] = [];
  source.onFailure?.((error) => told.push(error));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(told).toHaveLength(1);
});

test('exact and wildcard entries agree on an over-long label; onFailure hears decoding failures only', async () => {
  const label = `a${'\u00AD'.repeat(1100)}b`;
  expect(normalizeDomain(`${label}.example.com`)).toBe('');
  expect(validateConfigEntry(`*.${label}.example.com`, 'domain').valid).toBe(
    false,
  );

  const res = stubResponse();
  const { source } = createResponseBodySource(res, 'gzip');
  const told: Error[] = [];
  source.onFailure?.((error) => told.push(error));
  source.on('error', () => undefined);
  source.on('data', () => undefined);
  (res as unknown as PassThrough).emit('error', new Error('socket reset'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(told).toEqual([]);
});

test('a raw error held before onFailure subscribes is not replayed to it', async () => {
  const res = stubResponse();
  const { source } = createResponseBodySource(res, 'gzip');
  // No reader: the raw error is held.
  (res as unknown as PassThrough).emit('error', new Error('socket reset'));
  const told: Error[] = [];
  source.onFailure?.((error) => told.push(error));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(told).toEqual([]);
});

test('a decoding failure after the raw end reaches the reader before close', async () => {
  const res = stubResponse();
  const { source } = createResponseBodySource(res, 'gzip');
  const events: string[] = [];
  source.on('error', () => events.push('error'));
  source.on('close', () => events.push('close'));
  source.on('data', () => undefined);
  (res as unknown as PassThrough).end(Buffer.from('not gzip at all'));
  await new Promise((resolve) => setTimeout(resolve, 50));
  (res as unknown as PassThrough).destroy();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(events[0]).toBe('error');
  expect(events).toContain('close');
});

test('a held decoding failure is told once per subscription, and setup reads the same one', async () => {
  // A refused coding chain: the one failure held when NodeAdapter subscribes.
  const res = stubResponse();
  const { source } = createResponseBodySource(
    res,
    Array.from({ length: 6 }, () => 'gzip').join(','),
  );
  const told: Error[] = [];
  const listener = (error: Error) => told.push(error);
  const unsubscribe = source.onFailure?.(listener);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(told).toHaveLength(1);
  expect(source.heldError?.()).toBe(told[0]);

  // A new subscription of the same function is told again; the old one is not.
  unsubscribe?.();
  source.onFailure?.(listener);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(told).toHaveLength(2);
});

test('a throwing failure listener is reported on the live and replay paths; subscriptions are separate records', async () => {
  const reports: unknown[] = [];
  const onReport = (event: Event) => {
    reports.push((event as ErrorEvent).error);
    event.preventDefault();
  };
  globalThis.addEventListener('error', onReport);
  try {
    // Live: a corrupt body found failing after subscribing.
    const live = stubResponse();
    const liveBody = createResponseBodySource(live, 'gzip').source;
    liveBody.onFailure?.(() => {
      throw new Error('live listener failed');
    });
    liveBody.on('error', () => undefined);
    (live as unknown as PassThrough).end(Buffer.from('not gzip at all'));
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Replay: a refused chain held before subscribing.
    const replay = stubResponse();
    const replayBody = createResponseBodySource(
      replay,
      Array.from({ length: 6 }, () => 'gzip').join(','),
    ).source;
    replayBody.onFailure?.(() => {
      throw new Error('replay listener failed');
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    globalThis.removeEventListener('error', onReport);
  }
  expect(reports).toHaveLength(2);

  // The same function subscribed twice: unsubscribing one leaves the other told.
  const res = stubResponse();
  const body = createResponseBodySource(
    res,
    Array.from({ length: 6 }, () => 'gzip').join(','),
  ).source;
  const told: Error[] = [];
  const listener = (error: Error) => told.push(error);
  const first = body.onFailure?.(listener);
  body.onFailure?.(listener);
  first?.();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(told).toHaveLength(1);
});

test('a long run of dots is refused in linear time', () => {
  const started = performance.now();
  expect(normalizeDomain(`${'.'.repeat(40_000)}x`)).toBe('');
  expect(normalizeDomain(`${'a'.repeat(1000)}.`.repeat(5000))).toBe('');
  expect(performance.now() - started).toBeLessThan(200);
});

test('an oversized wildcard pattern or bracketed host is refused', () => {
  const huge = `*.${Array.from({ length: 5000 }, () => 'a'.repeat(1000)).join('.')}`;
  expect(validateConfigEntry(huge, 'domain').valid).toBe(false);
  expect(matchesDomainList('x.example.com', [huge])).toBe(false);
  expect(
    matchesCORSCredentialsList('https://x.example.com', [`https://${huge}`], {
      allowWildcardSubdomains: true,
    }),
  ).toBe(false);
  expect(normalizeDomain(`[${'1:'.repeat(5000)}1]`)).toBe('');
});

test('a pause asked before the first byte holds the decoded body', async () => {
  const res = stubResponse();
  const { source } = createResponseBodySource(res, 'gzip');
  const chunks: Buffer[] = [];
  source.pause();
  source.on('data', (chunk: Buffer) => chunks.push(chunk));
  (res as unknown as PassThrough).end(zlib.gzipSync('hello world'));

  // Wait until the decoder has really produced the body - held in its buffer, paused -
  // rather than for a fixed time a slow machine could outrun; read afresh each pass.
  const lastDecoderBuffered = () =>
    (
      source as unknown as { decoders: { readableLength: number }[] }
    ).decoders.at(-1)?.readableLength ?? 0;
  const deadline = Date.now() + 5_000;
  while (lastDecoderBuffered() === 0) {
    expect(Date.now()).toBeLessThan(deadline);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(chunks).toEqual([]);

  const ended = new Promise((resolve) => source.on('end', resolve));
  source.resume();
  await ended;
  expect(Buffer.concat(chunks).toString()).toBe('hello world');
});

test('an empty body paused before it ends holds its end until resumed', async () => {
  const res = stubResponse();
  const { source } = createResponseBodySource(res, 'gzip');
  const events: string[] = [];
  source.pause();
  source.on('data', () => events.push('data'));
  source.on('close', () => events.push('close'));
  (res as unknown as PassThrough).end();
  await new Promise((resolve) => setImmediate(resolve));
  (res as unknown as PassThrough).destroy();
  await new Promise((resolve) => setImmediate(resolve));
  expect(events).toEqual([]);

  // `'end'` is attached after `resume()` in the same tick, and still heard.
  source.resume();
  source.on('end', () => events.push('end'));
  await new Promise((resolve) => setImmediate(resolve));
  expect(events).toEqual(['end', 'close']);
});

test('an error after a held end does not overtake it', async () => {
  const res = stubResponse();
  const { source } = createResponseBodySource(res, 'gzip');
  const events: string[] = [];
  source.pause();
  source.on('data', () => undefined);
  source.on('end', () => events.push('end'));
  source.on('error', () => events.push('error'));
  (res as unknown as PassThrough).end();
  await new Promise((resolve) => setImmediate(resolve));
  (res as unknown as PassThrough).emit('error', new Error('socket reset'));
  source.resume();
  await new Promise((resolve) => setImmediate(resolve));
  expect(events).toEqual(['end', 'error']);
});

test('a hosts list changed in place is matched as it now reads', () => {
  const filter = { hosts: ['a.com'] };
  expect(
    matchesFilter(filter, { requestURL: 'https://a.com/' }, 'response'),
  ).toBe(true);
  filter.hosts[0] = 'b.com';
  expect(
    matchesFilter(filter, { requestURL: 'https://b.com/' }, 'response'),
  ).toBe(true);
});

test('the length guard reads Unicode dots as dots on every path', () => {
  // Two 601-character labels that normalize to `a` (soft hyphens map to nothing), joined
  // by an ideographic full stop: one 1,203-character run if that dot is not read as one.
  const label = `a${'\u00AD'.repeat(600)}`;
  const pattern = `*.${label}\u3002${label}.example.com`;
  expect(validateConfigEntry(pattern, 'domain').valid).toBe(true);
  expect(
    validateConfigEntry(pattern.replace('\u3002', '.'), 'domain').valid,
  ).toBe(true);
});

test('a paused body cut short delivers its close without a resume', async () => {
  const res = stubResponse();
  const { source } = createResponseBodySource(res, 'gzip');
  const events: string[] = [];
  source.pause();
  source.on('data', () => undefined);
  source.on('close', () => events.push('close'));
  (res as unknown as PassThrough).destroy();
  await new Promise((resolve) => setImmediate(resolve));
  expect(events).toEqual(['close']);
});

test('an error held behind a paused end is read by heldError, and let go on destroy', async () => {
  const res = stubResponse();
  const { source } = createResponseBodySource(res, 'gzip');
  source.pause();
  source.on('data', () => undefined);
  source.on('error', () => undefined);
  (res as unknown as PassThrough).end();
  await new Promise((resolve) => setImmediate(resolve));
  const reset = new Error('socket reset');
  (res as unknown as PassThrough).emit('error', reset);
  expect(source.heldError?.()).toBe(reset);
  (source as unknown as { destroy(): void }).destroy();
  expect(source.heldError?.()).toBeUndefined();
});

test('a registered host filter matches by its normalized pattern', async () => {
  const seen: string[] = [];
  const adapter = new MockAdapter();
  adapter.routes.get('/', () => ({ status: 200 }));
  const client = new HTTPClient({ adapter });
  client.addResponseObserver(
    (_response, request) => {
      seen.push(request.requestURL);
    },
    { hosts: ['BÜCHER.example', '*.example.com'] },
  );
  await client.get('https://xn--bcher-kva.example/').send();
  await client.get('https://api.example.com/').send();
  await client.get('https://other.example/').send();
  expect(seen).toEqual([
    'https://xn--bcher-kva.example/',
    'https://api.example.com/',
  ]);
});

test('an error held before a reader attaches is not overtaken by a paused end', async () => {
  const res = stubResponse();
  const { source } = createResponseBodySource(res, 'gzip');
  const events: string[] = [];
  (res as unknown as PassThrough).emit('error', new Error('socket reset'));
  source.pause();
  (res as unknown as PassThrough).end();
  await new Promise((resolve) => setImmediate(resolve));
  source.on('data', () => undefined);
  source.on('end', () => events.push('end'));
  source.on('error', () => events.push('error'));
  await new Promise((resolve) => setImmediate(resolve));
  expect(events).toEqual(['error']);
  source.resume();
  await new Promise((resolve) => setImmediate(resolve));
  expect(events).toEqual(['error', 'end']);
});

test('a body paused again before the release holds its end again', async () => {
  const res = stubResponse();
  const { source } = createResponseBodySource(res, 'gzip');
  const events: string[] = [];
  source.pause();
  source.on('data', () => undefined);
  source.on('end', () => events.push('end'));
  (res as unknown as PassThrough).end();
  await new Promise((resolve) => setImmediate(resolve));
  source.resume();
  source.pause();
  await new Promise((resolve) => setImmediate(resolve));
  expect(events).toEqual([]);
  source.resume();
  await new Promise((resolve) => setImmediate(resolve));
  expect(events).toEqual(['end']);
});

test('a paused gzip body cut short mid-body delivers its close without a resume', async () => {
  const res = stubResponse();
  const { source } = createResponseBodySource(res, 'gzip');
  const events: string[] = [];
  source.on('data', () => undefined);
  source.on('aborted', () => events.push('aborted'));
  source.on('close', () => events.push('close'));
  const whole = zlib.gzipSync(Buffer.alloc(64 * 1024, 'a'));
  (res as unknown as PassThrough).write(whole.subarray(0, whole.length >> 1));
  await new Promise((resolve) => setImmediate(resolve));
  source.pause();
  (res as unknown as PassThrough).emit('aborted');
  (res as unknown as PassThrough).destroy();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(events).toEqual(['aborted', 'close']);
});

test('a registered host filter reads each pattern once and answers as the unregistered matcher does', () => {
  const patterns = [
    '*.example.com',
    '**.example.com',
    '*.*.example.com',
    '*.com',
    '**.co.uk',
    '*.*',
    '*.127.0.0.1',
    'api.example.com',
    'BÜCHER.example',
    '*.bücher.example',
    '*',
    '*.',
    '*\uFF0E',
  ];
  const hosts = [
    'api.example.com',
    'a.b.example.com',
    'example.com',
    'example.co.uk',
    'x.example.co.uk',
    '127.0.0.1',
    'xn--bcher-kva.example',
    'api.xn--bcher-kva.example',
    'other.test',
    // Unreadable to the normalizer: only `*` alone matches it.
    '-edge.example.com',
  ];
  for (const pattern of patterns) {
    const hostPatterns = [readHostPattern(pattern)];
    for (const host of hosts) {
      const context = { requestURL: `https://${host}/` };
      expect([
        pattern,
        host,
        matchesFilter({ hosts: [pattern], hostPatterns }, context, 'response'),
      ]).toEqual([
        pattern,
        host,
        matchesFilter({ hosts: [pattern] }, context, 'response'),
      ]);
    }
  }
});

test('a host filter registered on a client matches what the unregistered matcher matches, and refuses what it never matches', async () => {
  const filters: string[][] = [
    ['*.example.com'],
    ['**.example.com'],
    ['*.*.example.com'],
    ['*.com'],
    ['*.*'],
    ['*.2.3.4'],
    ['api.example.com'],
    ['BÜCHER.example'],
    ['*.bücher.example'],
    ['*'],
    ['*.'],
    // Several patterns sharing one checked host: an IP, an exact name and wildcards.
    ['127.0.0.1', '*.example.com'],
    ['*.example.com', '127.0.0.1', 'xn--bcher-kva.example'],
    ['**.example.com', 'BÜCHER.example', '*.bücher.example'],
  ];
  const hosts = [
    'api.example.com',
    'a.b.example.com',
    'example.com',
    '127.0.0.1',
    'xn--bcher-kva.example',
    'api.xn--bcher-kva.example',
    '-edge.example.com',
  ];
  const adapter = new MockAdapter();
  adapter.routes.get('/', () => ({ status: 200 }));

  for (const filter of filters) {
    const expected = hosts.filter((host) =>
      matchesFilter(
        { hosts: filter },
        { requestURL: `https://${host}/` },
        'response',
      ),
    );
    const client = new HTTPClient({ adapter });
    const seen: string[] = [];
    const register = (): void => {
      client.addResponseObserver(
        (_response, request) => {
          seen.push(new URL(request.requestURL).hostname);
        },
        { hosts: filter },
      );
    };

    // Refused at registration only when it would never match anything.
    if (expected.length === 0 && filter.length === 1) {
      expect(register).toThrow(TypeError);
      continue;
    }

    register();
    for (const host of hosts) {
      await client.get(`https://${host}/`).send();
    }

    expect([filter, seen]).toEqual([filter, expected]);
  }
});

test('binary bodies from a custom adapter are measured by their slot for maxResponseBytes', async () => {
  class Understated extends Uint8Array {
    public override get byteLength(): number {
      return 5;
    }
  }
  const bodies: unknown[] = [
    new SharedArrayBuffer(100),
    vm.runInNewContext('new ArrayBuffer(100)'),
    new Understated(100),
  ];
  for (const body of bodies) {
    const client = new HTTPClient({
      adapter: {
        getType: () => 'mock',
        send: () =>
          Promise.resolve({
            status: 200,
            headers: { 'content-type': 'application/octet-stream' },
            body: body as Uint8Array,
          }),
      },
      baseURL: 'http://api.test',
      maxResponseBytes: 10,
    });
    const builder = client.get('/x');
    await builder.send();
    expect(builder.error?.code).toBe('response_too_large');
  }
});

test('`*.`, however its dot is written, matches nothing and is refused', () => {
  for (const pattern of ['*.', '*\uFF0E', '*\u3002']) {
    expect(readHostPattern(pattern).kind).toBe('never');
    expect(matchesHostPattern('evil.attacker.net', pattern)).toBe(false);
    expect(() =>
      new HTTPClient({ adapter: new MockAdapter() }).addRequestInterceptor(
        (request) => request,
        { hosts: [pattern] },
      ),
    ).toThrow(TypeError);
  }
});

test('.params(undefined) clears the params, as before', async () => {
  const adapter = new MockAdapter();
  const queries: unknown[] = [];
  adapter.routes.get('/x', (request) => {
    queries.push(request.query);
    return { status: 200 };
  });
  const client = new HTTPClient({ adapter, baseURL: 'http://api.test' });
  await client.get('/x').params({ a: '1' }).params(undefined).send();
  expect(queries).toEqual([{}]);
});

test('a string body is measured as UTF-8 without being encoded', () => {
  for (const text of [
    '',
    'ascii',
    'é€',
    '😀',
    'a\uD800b',
    '\uDC00',
    'x'.repeat(1000) + '€',
  ]) {
    expect([text, utf8ByteLength(text)]).toEqual([
      text,
      new TextEncoder().encode(text).byteLength,
    ]);
  }
});

test('a binary request body is measured by its slot for upload progress', () => {
  class Understated extends Uint8Array {
    public override get byteLength(): number {
      return 1;
    }
  }

  expect(knownBodyByteLength(new SharedArrayBuffer(3))).toBe(3);
  expect(knownBodyByteLength(new Understated(4))).toBe(4);
  expect(knownBodyByteLength(vm.runInNewContext('new Uint8Array(5)'))).toBe(5);
});

test('MockAdapter holds a route body to maxResponseBytes by its real size', async () => {
  class Understated extends Uint8Array {
    public override get length(): number {
      return 0;
    }
  }
  const adapter = new MockAdapter();
  adapter.routes.get('/big', () => ({
    status: 200,
    body: new Understated(100),
  }));

  const response = await adapter.send({
    requestURL: 'http://api.test/big',
    method: 'GET',
    headers: {},
    maxResponseBytes: 10,
  });

  expect(response.streamErrorCode).toBe('response_too_large');
});

test('a params value is read once, so the override check and the query agree', async () => {
  let reads = 0;
  const params = {
    get page(): string | undefined {
      reads++;
      return reads === 1 ? '3' : undefined;
    },
  };
  const adapter = new RecordingAdapter(200);
  const client = new HTTPClient({ adapter });

  await client.get('http://api.test/x?page=1').params(params).send();

  expect(adapter.requests[0]?.requestURL).toBe('http://api.test/x?page=3');
  expect(reads).toBe(1);
});

test('a body no getter can measure fails closed; one reporting 0 bytes is still delivered', async () => {
  const proxied = new Proxy(new Uint8Array(1000), {});

  const custom = (body: unknown) =>
    new HTTPClient({
      adapter: {
        getType: () => 'mock',
        send: () =>
          Promise.resolve({
            status: 200,
            headers: { 'content-type': 'application/octet-stream' },
            body: body as Uint8Array,
          }),
      },
      baseURL: 'http://api.test',
      maxResponseBytes: 10,
    });
  const refused = custom(proxied).get('/x');
  await refused.send();
  expect(refused.error?.code).toBe('response_too_large');

  class SaysEmpty extends Uint8Array {
    public override get byteLength(): number {
      return 0;
    }
  }
  const delivered = await custom(new SaysEmpty([1, 2, 3]))
    .get('/x')
    .send();
  expect(delivered.body).not.toBeNull();
});

test('a non-binary body is not held to the limit; an unmeasurable binary one only under a finite limit', async () => {
  const custom = (
    body: unknown,
    maxResponseBytes: number,
    contentType = 'application/octet-stream',
  ) =>
    new HTTPClient({
      adapter: {
        getType: () => 'mock',
        send: () =>
          Promise.resolve({
            status: 200,
            headers: { 'content-type': contentType },
            body: body as Uint8Array,
          }),
      },
      baseURL: 'http://api.test',
      maxResponseBytes,
    });

  const parsed = custom({ parsed: true }, 10).get('/x');
  await parsed.send();
  expect(parsed.error).toBeNull();

  const proxied = new Proxy(new Uint8Array(1000), {});
  const unlimited = custom(proxied, Infinity).get('/x');
  await unlimited.send();
  expect(unlimited.error?.code).not.toBe('response_too_large');
});

test("a custom adapter's string body with a JSON type is parsed as text", async () => {
  const client = new HTTPClient({
    adapter: {
      getType: () => 'mock',
      send: () =>
        Promise.resolve({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: '{"a":1}' as unknown as Uint8Array,
        }),
    },
    baseURL: 'http://api.test',
  });

  const response = await client.get('/x').send();
  expect(response.isFailed).toBe(false);
  expect(response.body).toEqual({ a: 1 });
});

test("a cookie seeded hostOnly is replaced by the server's host-only Set-Cookie", () => {
  const jar = new CookieJar();
  jar.setCookie({
    name: 's',
    value: '1',
    domain: 'example.com',
    hostOnly: true,
  });
  jar.parseSetCookieHeader('s=2', 'https://example.com/');

  expect(jar.getCookieHeaderString('https://example.com/')).toBe('s=2');
});

test('an unmeasurable body presenting as bytes from any realm is refused; an empty string is no body', async () => {
  const custom = (body: unknown, contentType = 'application/octet-stream') =>
    new HTTPClient({
      adapter: {
        getType: () => 'mock',
        send: () =>
          Promise.resolve({
            status: 200,
            headers: { 'content-type': contentType },
            body: body as Uint8Array,
          }),
      },
      baseURL: 'http://api.test',
      maxResponseBytes: 10,
    });

  for (const body of [
    new Proxy(new SharedArrayBuffer(1000), {}),
    new Proxy(vm.runInNewContext('new Uint8Array(1000)') as object, {}),
  ]) {
    const builder = custom(body).get('/x');
    await builder.send();
    expect(builder.error?.code).toBe('response_too_large');
  }

  const empty = await custom('', 'application/json').get('/x').send();
  expect(empty.body).toBeNull();
  expect(empty.isParseError).toBe(false);
});

test('a redirect whose page is past maxResponseBytes is followed, not failed', async () => {
  const adapter = new MockAdapter();
  adapter.routes.get('/start', () => ({
    status: 302,
    headers: { location: '/end', 'content-type': 'text/html' },
    body: 'x'.repeat(4096),
  }));
  adapter.routes.get('/end', () => ({ status: 200, body: 'ok' }));
  const client = new HTTPClient({
    adapter,
    baseURL: 'http://api.test',
    followRedirects: true,
    maxResponseBytes: 1024,
  });

  const response = await client.get('/start').send();
  expect(response.isFailed).toBe(false);
  expect(response.status).toBe(200);
  expect(response.body).toBe('ok');
});

test('a DataView over a detached buffer measures 0, as a typed array over one does', () => {
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  structuredClone(buffer, { transfer: [buffer] });

  expect(readBinaryByteLength(view)).toBe(0);
  expect(readBinaryByteLength(bytes)).toBe(0);
});

test('a bodiless answer is not held to maxResponseBytes by the client', async () => {
  const client = new HTTPClient({
    adapter: {
      getType: () => 'mock',
      send: () =>
        Promise.resolve({
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
          body: new Uint8Array(1000),
        }),
    },
    baseURL: 'http://api.test',
    maxResponseBytes: 10,
  });

  const response = await client.head('/x').send();
  expect(response.isFailed).toBe(false);
});

test('a cookie domain whose leading dot only mapping exposes is refused', () => {
  const jar = new CookieJar();
  expect(
    jar.setCookie({
      name: 's',
      value: '1',
      domain: '\u00AD.example.com.\u00AD',
    }),
  ).toBe(false);
});

test("a bodiless answer's stray body is dropped, not delivered past the limit", async () => {
  const client = new HTTPClient({
    adapter: {
      getType: () => 'mock',
      send: () =>
        Promise.resolve({
          status: 204,
          headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode('{"big":true}'),
        }),
    },
    baseURL: 'http://api.test',
    maxResponseBytes: 4,
  });

  const response = await client.get('/x').send();
  expect(response.isFailed).toBe(false);
  expect(response.body).toBeNull();
});

test('FetchAdapter and MockAdapter read a non-string method as the string it is', async () => {
  const method = { toString: () => 'POST' } as unknown as 'POST';
  let sentMethod: string | undefined;
  const originalFetch = globalThis.fetch;
  (globalThis as { fetch: unknown }).fetch = (
    _url: unknown,
    init?: RequestInit,
  ) => {
    sentMethod = init?.method;
    return Promise.resolve(new Response('ok', { status: 200 }));
  };
  try {
    const fetched = await new FetchAdapter().send({
      requestURL: 'https://local.test/x',
      method,
      headers: {},
    });
    expect(fetched.status).toBe(200);
    expect(sentMethod).toBe('POST');
  } finally {
    globalThis.fetch = originalFetch;
  }

  const adapter = new MockAdapter();
  adapter.routes.post('/x', () => ({ status: 201 }));
  const mocked = await adapter.send({
    requestURL: 'http://api.test/x',
    method,
    headers: {},
  });
  expect(mocked.status).toBe(201);
});

test('an adapter driven directly refuses an unusable maxResponseBytes', async () => {
  const adapter = new MockAdapter();
  let ran = 0;
  adapter.routes.get('/x', () => {
    ran++;
    return { status: 200 };
  });
  for (const maxResponseBytes of ['1048576', 0, Number.NaN, 1.5]) {
    const outcome = await adapter
      .send({
        requestURL: 'http://api.test/x',
        method: 'GET',
        headers: {},
        maxResponseBytes: maxResponseBytes as number,
      })
      .then(
        () => undefined,
        (error: unknown) => error as Error,
      );
    expect(outcome).toBeInstanceOf(TypeError);
  }
  expect(ran).toBe(0);

  const unlimited = await adapter.send({
    requestURL: 'http://api.test/x',
    method: 'GET',
    headers: {},
    maxResponseBytes: Infinity,
  });
  expect(unlimited.status).toBe(200);
});

test('a domain list longer than the pattern cache still matches', () => {
  const list = Array.from(
    { length: 600 },
    (_, i) => `*.tenant${i}.example.com`,
  );
  list.push('exact.example.org');

  expect(matchesDomainList('api.tenant599.example.com', list)).toBe(true);
  expect(matchesDomainList('exact.example.org', list)).toBe(true);
  expect(matchesDomainList('nope.example.net', list)).toBe(false);
});

test('an adapter answering with a Headers object, or an object header value, fails as adapter_error', async () => {
  for (const headers of [
    new Headers({ 'content-type': 'application/json' }),
    new Map([['content-type', 'application/json']]),
    { 'content-type': { type: 'json' } },
    { 'x-trace': [Symbol('t')] },
  ]) {
    let sends = 0;
    const client = new HTTPClient({
      baseURL: 'http://api.test',
      retryPolicy: { strategy: 'fixed', maxRetryAttempts: 2, delayMS: 0 },
      adapter: {
        getType: () => 'mock',
        send: () => {
          sends++;
          return Promise.resolve({
            status: 200,
            headers: headers as unknown as Record<string, string>,
            body: new TextEncoder().encode('{"a":1}'),
          });
        },
      },
    });
    const builder = client.get('/x');
    const response = await builder.send();

    expect(response.isFailed).toBe(true);
    expect(builder.error?.code).toBe('adapter_error');
    expect(String(builder.error?.cause)).toContain('header');
    expect(sends).toBe(1);
  }

  // A number is its text, as before.
  const numeric = await new HTTPClient({
    baseURL: 'http://api.test',
    adapter: {
      getType: () => 'mock',
      send: () =>
        Promise.resolve({
          status: 200,
          headers: { 'content-length': 2 } as unknown as Record<string, string>,
          body: null,
        }),
    },
  })
    .get('/x')
    .send();
  expect(numeric.headers['content-length']).toBe('2');
});

test('adapters refuse a missing method, and a throwing field getter, as non-retryable', async () => {
  const originalFetch = globalThis.fetch;
  let fetched = 0;
  (globalThis as { fetch: unknown }).fetch = () => {
    fetched++;
    return Promise.resolve(new Response('ok', { status: 200 }));
  };
  const mock = new MockAdapter();
  let ran = 0;
  mock.routes.get('/x', () => {
    ran++;
    return { status: 200 };
  });
  const throwing = (field: string) =>
    Object.defineProperty(
      { requestURL: 'http://api.test/x', method: 'GET', headers: {} },
      field,
      {
        get() {
          throw new Error(`${field} getter failed`);
        },
        enumerable: true,
      },
    ) as AdapterRequest;

  try {
    for (const adapter of [new FetchAdapter(), mock]) {
      const requests = [
        {
          requestURL: 'http://api.test/x',
          method: undefined as unknown as 'GET',
          headers: {},
        } as AdapterRequest,
        throwing('signal'),
        throwing('onUploadProgress'),
        throwing('maxResponseBytes'),
      ];
      for (const request of requests) {
        const outcome = await adapter.send(request).then(
          () => undefined,
          (error: unknown) => error as Record<PropertyKey, unknown>,
        );
        expect(outcome).toBeDefined();
        expect(outcome?.[NON_RETRYABLE_HTTP_ADAPTER_ERROR_FLAG]).toBe(true);
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
  }

  expect(fetched).toBe(0);
  expect(ran).toBe(0);
});

test('NodeAdapter refuses a bad method, and a throwing field getter, as non-retryable', async () => {
  const throwing = (field: string) =>
    Object.defineProperty(
      { requestURL: 'http://127.0.0.1:1/x', method: 'GET', headers: {} },
      field,
      {
        get() {
          throw new Error(`${field} getter failed`);
        },
        enumerable: true,
      },
    ) as AdapterRequest;
  const requests = [
    {
      requestURL: 'http://127.0.0.1:1/x',
      method: {
        toString() {
          throw new Error('no method');
        },
      } as unknown as 'GET',
      headers: {},
    },
    {
      requestURL: 'http://127.0.0.1:1/x',
      method: undefined as unknown as 'GET',
      headers: {},
    },
    throwing('signal'),
    throwing('maxResponseBytes'),
  ];

  for (const request of requests) {
    const outcome = await new NodeAdapter().send(request).then(
      () => undefined,
      (error: unknown) => error as Record<PropertyKey, unknown>,
    );

    expect(outcome?.[NON_RETRYABLE_HTTP_ADAPTER_ERROR_FLAG]).toBe(true);
  }
});

test('CookieJar.processResponseHeaders reads only set-cookie, and refuses a Headers', () => {
  const jar = new CookieJar();
  jar.processResponseHeaders(
    {
      'Set-Cookie': 'a=1; Path=/',
      'x-meta': { not: 'text' },
    } as unknown as Record<string, string>,
    'https://example.com/',
  );
  expect(jar.getCookieHeaderString('https://example.com/')).toBe('a=1');

  expect(() =>
    jar.processResponseHeaders(
      new Headers({ 'set-cookie': 'b=2' }) as unknown as Record<string, string>,
      'https://example.com/',
    ),
  ).toThrow('CookieJar processResponseHeaders headers must be a plain object');
});

test('a stream abort tagged with a Headers is left untagged, and a boolean header value is refused', async () => {
  for (const headers of [
    new Headers({ 'set-cookie': 'sid=1' }),
    { 'x-flag': true },
  ]) {
    const client = new HTTPClient({
      baseURL: 'http://api.test',
      adapter: {
        getType: () => 'mock',
        send: () => {
          const error = new Error('stream broke');
          Object.defineProperty(error, RESPONSE_STREAM_ABORT_FLAG, {
            value: true,
          });
          Object.defineProperty(error, STREAM_ABORT_STATUS_KEY, { value: 200 });
          Object.defineProperty(error, STREAM_ABORT_HEADERS_KEY, {
            value: headers,
          });
          return Promise.reject(error);
        },
      },
    });
    const response = await client.get('/x').send();

    // Untagged: no answer is claimed from headers that could not be read.
    expect(response.status).toBe(0);
  }

  const builder = new HTTPClient({
    baseURL: 'http://api.test',
    adapter: {
      getType: () => 'mock',
      send: () =>
        Promise.resolve({
          status: 200,
          headers: { 'x-flag': true } as unknown as Record<string, string>,
          body: null,
        }),
    },
  }).get('/x');
  await builder.send();
  expect(builder.error?.code).toBe('adapter_error');
});

test('every adapter driven directly refuses a Headers for its request headers', async () => {
  const headers = new Headers({
    authorization: 'Bearer x',
  }) as unknown as Record<string, string>;
  const mock = new MockAdapter();
  mock.routes.get('/x', () => ({ status: 200 }));
  const originalFetch = globalThis.fetch;
  let fetched = 0;
  (globalThis as { fetch: unknown }).fetch = () => {
    fetched++;
    return Promise.resolve(new Response('ok', { status: 200 }));
  };

  try {
    for (const adapter of [new FetchAdapter(), mock, new NodeAdapter()]) {
      const outcome = await adapter
        .send({ requestURL: 'http://127.0.0.1:1/x', method: 'GET', headers })
        .then(
          () => undefined,
          (error: unknown) => error as Record<PropertyKey, unknown>,
        );

      expect(String(outcome?.message)).toContain('must be a plain object');
      expect(String(outcome?.message)).toContain('(got object)');
      expect(outcome?.[NON_RETRYABLE_HTTP_ADAPTER_ERROR_FLAG]).toBe(true);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }

  expect(fetched).toBe(0);
});

test('FetchAdapter does not send an unset header value as "null"', async () => {
  const originalFetch = globalThis.fetch;
  let sent: Headers | undefined;
  (globalThis as { fetch: unknown }).fetch = (
    _url: unknown,
    init?: RequestInit,
  ) => {
    sent = new Headers(init?.headers);
    return Promise.resolve(new Response('ok', { status: 200 }));
  };

  try {
    await new FetchAdapter().send({
      requestURL: 'https://local.test/x',
      method: 'GET',
      headers: { 'x-kept': 'yes', 'x-unset': null as unknown as string },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  expect(sent?.get('x-kept')).toBe('yes');
  expect(sent?.has('x-unset')).toBe(false);
});

test("a caller's own AbortError under a non-retryable carrier is an adapter_error, not a cancel", async () => {
  const adapter = new MockAdapter();
  let ran = 0;
  adapter.routes.get('/x', () => {
    ran++;
    return {
      status: 200,
      body: {
        toJSON() {
          throw new DOMException('unrelated signal', 'AbortError');
        },
      },
    };
  });
  const builder = new HTTPClient({
    adapter,
    baseURL: 'http://api.test',
    retryPolicy: { strategy: 'fixed', maxRetryAttempts: 2, delayMS: 0 },
  }).get('/x');
  const response = await builder.send();

  expect(response.isCancelled).toBe(false);
  expect(builder.error?.code).toBe('adapter_error');
  expect(ran).toBe(1);
});

test('CookieJar.processResponseHeaders stores nothing when a line is refused', () => {
  const jar = new CookieJar();
  expect(() =>
    jar.processResponseHeaders(
      { 'set-cookie': ['a=1; Path=/', 42] } as unknown as Record<
        string,
        string[]
      >,
      'https://example.com/',
    ),
  ).toThrow('set-cookie line is not a string');
  expect(jar.getAllCookies()).toHaveLength(0);
});

test("a header value's toString throwing an AbortError fails every adapter as non-retryable, not as a cancel", async () => {
  const originalFetch = globalThis.fetch;
  (globalThis as { fetch: unknown }).fetch = () =>
    Promise.resolve(new Response('ok', { status: 200 }));
  const mock = new MockAdapter();
  mock.routes.get('/x', () => ({ status: 200 }));
  const headers = {
    'x-token': {
      toString() {
        throw new DOMException('unrelated signal', 'AbortError');
      },
    },
  } as unknown as Record<string, string>;

  try {
    for (const adapter of [new FetchAdapter(), mock, new NodeAdapter()]) {
      const outcome = await adapter
        .send({ requestURL: 'http://127.0.0.1:1/x', method: 'GET', headers })
        .then(
          () => undefined,
          (error: unknown) => error as Record<PropertyKey, unknown>,
        );

      expect(outcome?.name).not.toBe('AbortError');
      expect(outcome?.[NON_RETRYABLE_HTTP_ADAPTER_ERROR_FLAG]).toBe(true);
      expect((outcome?.cause as Error | undefined)?.name).toBe('AbortError');
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an adapter's flagged non-retryable AbortError is its failure, not a cancel or a retried timeout", async () => {
  for (const timeout of [undefined, 20]) {
    let sends = 0;
    const builder = new HTTPClient({
      baseURL: 'http://api.test',
      ...(timeout === undefined ? {} : { timeout }),
      retryPolicy: { strategy: 'fixed', maxRetryAttempts: 2, delayMS: 0 },
      adapter: {
        getType: () => 'mock',
        send: async () => {
          sends++;
          if (timeout !== undefined) {
            await sleep(timeout * 3);
          }
          const error = new DOMException('unrelated signal', 'AbortError');
          Object.defineProperty(error, NON_RETRYABLE_HTTP_ADAPTER_ERROR_FLAG, {
            value: true,
          });
          throw error;
        },
      },
    }).get('/x');
    const response = await builder.send();

    expect(response.isCancelled).toBe(false);
    expect(builder.error?.code).toBe('adapter_error');
    expect(sends).toBe(1);
  }
});

test('CookieJar refuses publicSuffixes given as a Map', () => {
  expect(
    () =>
      new CookieJar({
        publicSuffixes: new Map([['add', ['corp.internal']]]) as unknown as {
          add: string[];
        },
      }),
  ).toThrow('publicSuffixes must be a plain object');
});

test('a flagged AbortError while the caller did cancel is still the cancel', async () => {
  const builder = new HTTPClient({
    baseURL: 'http://api.test',
    adapter: {
      getType: () => 'mock',
      send: (request: AdapterRequest) =>
        new Promise((_resolve, reject) => {
          request.signal?.addEventListener('abort', () => {
            const error = new DOMException('cancelled', 'AbortError');
            Object.defineProperty(
              error,
              NON_RETRYABLE_HTTP_ADAPTER_ERROR_FLAG,
              {
                value: true,
              },
            );
            reject(error);
          });
        }),
    },
  }).get('/x');
  const pending = builder.send();
  await sleep(5);
  builder.cancel();
  const response = await pending;

  expect(response.isCancelled).toBe(true);
});

test('FetchAdapter and MockAdapter refuse a signal whose aborted getter throws as non-retryable', async () => {
  const signal = {
    get aborted(): boolean {
      throw new Error('aborted getter failed');
    },
    addEventListener() {},
    removeEventListener() {},
  } as unknown as AbortSignal;
  const mock = new MockAdapter();
  mock.routes.get('/x', () => ({ status: 200 }));

  for (const adapter of [new FetchAdapter(), mock]) {
    const outcome = await adapter
      .send({
        requestURL: 'http://api.test/x',
        method: 'GET',
        headers: {},
        signal,
      })
      .then(
        () => undefined,
        (error: unknown) => error as Record<PropertyKey, unknown>,
      );

    expect(outcome?.[NON_RETRYABLE_HTTP_ADAPTER_ERROR_FLAG]).toBe(true);
  }
});

test('publicSuffixes given as a list names the array', () => {
  expect(
    () =>
      new CookieJar({
        publicSuffixes: ['corp.internal'] as unknown as { add: string[] },
      }),
  ).toThrow('(got an array)');
});

test('an unreadable effectiveRequestHeaders record is absent, not an adapter_error', async () => {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  const builder = new HTTPClient({
    baseURL: 'http://api.test',
    adapter: {
      getType: () => 'mock',
      send: () =>
        Promise.resolve({
          status: 200,
          headers: {},
          body: null,
          effectiveRequestHeaders: proxy,
        }),
    },
  }).get('/x');
  const response = await builder.send();

  expect(response.status).toBe(200);
  expect(response.isFailed).toBe(false);
  expect(builder.error).toBeNull();
});

test('MockAdapter refuses a signal whose aborted throws on a later read as non-retryable', async () => {
  let reads = 0;
  const signal = {
    get aborted(): boolean {
      reads++;
      if (reads > 1) {
        throw new Error('aborted unreadable');
      }
      return false;
    },
    addEventListener() {},
    removeEventListener() {},
  } as unknown as AbortSignal;
  const mock = new MockAdapter();
  mock.routes.get('/x', () => ({ status: 200 }));

  const outcome = await mock
    .send({
      requestURL: 'http://api.test/x',
      method: 'GET',
      headers: {},
      signal,
    })
    .then(
      () => undefined,
      (error: unknown) => error as Record<PropertyKey, unknown>,
    );

  expect(reads).toBeGreaterThan(1);
  expect(outcome?.[NON_RETRYABLE_HTTP_ADAPTER_ERROR_FLAG]).toBe(true);
});

test('a domain list kept by the caller stops matching an entry they removed', () => {
  const list = ['*.a.example', 'exact.example'];
  expect(matchesDomainList('x.a.example', list)).toBe(true);
  expect(matchesDomainList('exact.example', list)).toBe(true);

  list[0] = '*.b.example';
  list.pop();
  expect(matchesDomainList('x.a.example', list)).toBe(false);
  expect(matchesDomainList('exact.example', list)).toBe(false);
  expect(matchesDomainList('x.b.example', list)).toBe(true);

  list.push('https://origin.example');
  expect(() => matchesDomainList('x.b.example', list)).toThrow(
    'origin-style patterns are not allowed',
  );
});

test('MockAdapter refuses a signal whose aborted throws while the route runs, not as a route error', async () => {
  let reads = 0;
  const signal = {
    get aborted(): boolean {
      reads++;
      // The two pre-flight checks read it; the wait on the route is next.
      if (reads > 2) {
        throw new Error('aborted unreadable');
      }
      return false;
    },
    addEventListener() {},
    removeEventListener() {},
  } as unknown as AbortSignal;
  let handlerErrors = 0;
  const mock = new MockAdapter({
    onHandlerError: () => {
      handlerErrors++;
      return { status: 500 };
    },
  });
  mock.routes.get('/x', async () => {
    await sleep(1);
    return { status: 200 };
  });

  const outcome = await mock
    .send({
      requestURL: 'http://api.test/x',
      method: 'GET',
      headers: {},
      signal,
    })
    .then(
      () => undefined,
      (error: unknown) => error as Record<PropertyKey, unknown>,
    );

  expect(reads).toBeGreaterThan(2);
  expect(handlerErrors).toBe(0);
  expect(outcome?.[NON_RETRYABLE_HTTP_ADAPTER_ERROR_FLAG]).toBe(true);
});

test("a caller's error carrying the carrier key is still wrapped and flagged", async () => {
  const mock = new MockAdapter();
  mock.routes.get('/x', () => ({ status: 200 }));
  const spoofed = Object.assign(new DOMException('x', 'AbortError'), {
    [ADAPTER_ERROR_CARRIER_KEY]: true,
  });
  const headers = {
    'x-token': {
      toString() {
        throw spoofed;
      },
    },
  } as unknown as Record<string, string>;

  const outcome = await mock
    .send({ requestURL: 'http://api.test/x', method: 'GET', headers })
    .then(
      () => undefined,
      (error: unknown) => error as Record<PropertyKey, unknown>,
    );

  expect(outcome).not.toBe(spoofed);
  expect(outcome?.name).not.toBe('AbortError');
  expect(outcome?.[NON_RETRYABLE_HTTP_ADAPTER_ERROR_FLAG]).toBe(true);
});

test('FetchAdapter refuses a signal whose aborted throws before anything is dispatched', async () => {
  const originalFetch = globalThis.fetch;
  let fetched = 0;
  (globalThis as { fetch: unknown }).fetch = () => {
    fetched++;
    return Promise.resolve(new Response('ok', { status: 200 }));
  };
  const signal = {
    get aborted(): boolean {
      throw new Error('aborted unreadable');
    },
    addEventListener() {},
    removeEventListener() {},
  } as unknown as AbortSignal;

  try {
    const outcome = await new FetchAdapter()
      .send({
        requestURL: 'https://local.test/x',
        method: 'POST',
        headers: {},
        body: 'x',
        signal,
      })
      .then(
        () => undefined,
        (error: unknown) => error as Record<PropertyKey, unknown>,
      );

    expect(outcome?.[NON_RETRYABLE_HTTP_ADAPTER_ERROR_FLAG]).toBe(true);
    expect(fetched).toBe(0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a signal's aborted counts only when it is exactly true", async () => {
  const mock = new MockAdapter();
  let ran = 0;
  mock.routes.get('/x', () => {
    ran++;
    return { status: 200 };
  });

  for (const aborted of [1, 'false', 'true', {}]) {
    const signal = {
      aborted,
      addEventListener() {},
      removeEventListener() {},
    } as unknown as AbortSignal;
    const response = await mock.send({
      requestURL: 'http://api.test/x',
      method: 'GET',
      headers: {},
      signal,
    });
    expect(response.status).toBe(200);
  }
  expect(ran).toBe(4);

  const aborted = new AbortController();
  aborted.abort();
  const outcome = await mock
    .send({
      requestURL: 'http://api.test/x',
      method: 'GET',
      headers: {},
      signal: aborted.signal,
    })
    .then(
      () => undefined,
      (error: unknown) => error as Error,
    );
  expect(outcome?.name).toBe('AbortError');
  expect(ran).toBe(4);
});

test('a sparse domain list skips its holes', () => {
  const list: string[] = ['a.example'];
  list[2] = 'b.example';
  expect(matchesDomainList('b.example', list)).toBe(true);
  expect(matchesDomainList('c.example', list)).toBe(false);
});

function signalReadableOnce(): AbortSignal {
  let reads = 0;
  return {
    get aborted(): boolean {
      reads++;
      if (reads > 1) {
        throw new Error('aborted unreadable');
      }
      return false;
    },
    addEventListener() {},
    removeEventListener() {},
  } as unknown as AbortSignal;
}

test("FetchAdapter keeps a broken body's real status when the signal turns unreadable", async () => {
  const originalFetch = globalThis.fetch;
  (globalThis as { fetch: unknown }).fetch = () =>
    Promise.resolve(
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.error(new Error('body broke'));
          },
        }),
        { status: 200, headers: { 'content-type': 'text/plain' } },
      ),
    );

  try {
    const response = await new FetchAdapter().send({
      requestURL: 'https://local.test/x',
      method: 'GET',
      headers: {},
      signal: signalReadableOnce(),
    });

    expect(response.status).toBe(200);
    expect(response.isStreamError).toBe(true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('FetchAdapter keeps a transport failure when the signal turns unreadable', async () => {
  const originalFetch = globalThis.fetch;
  (globalThis as { fetch: unknown }).fetch = () =>
    Promise.reject(new TypeError('fetch failed'));

  try {
    const outcome = await new FetchAdapter()
      .send({
        requestURL: 'https://local.test/x',
        method: 'GET',
        headers: {},
        signal: signalReadableOnce(),
      })
      .then(
        (response) => response as unknown as Record<PropertyKey, unknown>,
        (error: unknown) => error as Record<PropertyKey, unknown>,
      );

    expect(outcome[NON_RETRYABLE_HTTP_ADAPTER_ERROR_FLAG]).toBeUndefined();
    expect(String(outcome.message ?? outcome.errorCause)).not.toContain(
      'aborted unreadable',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('filling a hole in a kept domain list is seen', () => {
  // eslint-disable-next-line no-sparse-arrays -- the hole is the point
  const list: string[] = ['a.example', , 'b.example'] as string[];
  expect(matchesDomainList('c.example', list)).toBe(false);

  list[1] = 'c.example';
  expect(matchesDomainList('c.example', list)).toBe(true);
});

test("a refusal from another adapter a mock route calls is the route's failure", async () => {
  let handled = 0;
  const mock = new MockAdapter({
    onHandlerError: () => {
      handled++;
      return { status: 502 };
    },
  });
  const inner = new MockAdapter();
  mock.routes.get('/x', async () => {
    // A carrier: the inner adapter's refusal of a header value whose `toString` throws.
    await inner.send({
      requestURL: 'http://inner.test/y',
      method: 'GET',
      headers: {
        'x-token': {
          toString() {
            throw new Error('unconvertible');
          },
        },
      } as unknown as Record<string, string>,
    });
    return { status: 200 };
  });

  const response = await mock.send({
    requestURL: 'http://api.test/x',
    method: 'GET',
    headers: {},
    signal: new AbortController().signal,
  });

  expect(handled).toBe(1);
  expect(response.status).toBe(502);
});

test("a mock route's Headers, Map headers or Map cookies are refused, not dropped", async () => {
  const answers = [
    { status: 200, headers: new Headers({ 'set-cookie': 'a=1' }) },
    { status: 200, headers: new Map([['x-a', '1']]) },
    { status: 200, cookies: new Map([['a', '1']]) },
  ];

  for (const answer of answers) {
    const mock = new MockAdapter();
    mock.routes.get('/x', () => answer as unknown as { status: number });
    const outcome = await mock
      .send({ requestURL: 'http://api.test/x', method: 'GET', headers: {} })
      .then(
        () => undefined,
        (error: unknown) => error as Record<PropertyKey, unknown>,
      );

    expect(String(outcome?.message)).toContain('must be a plain object');
    expect(outcome?.[NON_RETRYABLE_HTTP_ADAPTER_ERROR_FLAG]).toBe(true);
  }
});

test("MockAdapter refuses a signal whose addEventListener throws as non-retryable, in a route's wait and in a delay", async () => {
  const signal = {
    aborted: false,
    addEventListener() {
      throw new Error('addEventListener refused');
    },
    removeEventListener() {},
  } as unknown as AbortSignal;
  let handlerErrors = 0;
  const mock = new MockAdapter({
    onHandlerError: () => {
      handlerErrors++;
      return { status: 500 };
    },
  });
  mock.routes.get('/wait', () => ({ status: 200 }));

  const waited = await mock
    .send({
      requestURL: 'http://api.test/wait',
      method: 'GET',
      headers: {},
      signal,
    })
    .then(
      () => undefined,
      (error: unknown) => error as Record<PropertyKey, unknown>,
    );
  expect(handlerErrors).toBe(0);
  expect(waited?.[NON_RETRYABLE_HTTP_ADAPTER_ERROR_FLAG]).toBe(true);

  const delayed = new MockAdapter();
  let attaches = 0;
  const delaySignal = {
    aborted: false,
    // The route's wait attaches first; only the delay's attach, the second, is refused.
    addEventListener() {
      attaches++;
      if (attaches > 1) {
        throw new Error('addEventListener refused');
      }
    },
    removeEventListener() {},
  } as unknown as AbortSignal;
  delayed.routes.get('/slow', () => ({ status: 200, delay: 5 }));
  const slept = await delayed
    .send({
      requestURL: 'http://api.test/slow',
      method: 'GET',
      headers: {},
      signal: delaySignal,
    })
    .then(
      () => undefined,
      (error: unknown) => error as Record<PropertyKey, unknown>,
    );
  expect(slept?.[NON_RETRYABLE_HTTP_ADAPTER_ERROR_FLAG]).toBe(true);
});

test('FetchAdapter checks a relative request against the page location before sending', async () => {
  const originalFetch = globalThis.fetch;
  const didHaveLocation = Object.hasOwn(globalThis, 'location');
  const originalLocation: unknown = (globalThis as { location?: unknown })
    .location;
  let fetched = 0;
  (globalThis as { fetch: unknown }).fetch = () => {
    fetched++;
    return Promise.reject(new TypeError('fetch refused the header'));
  };
  Object.defineProperty(globalThis, 'location', {
    value: { href: 'https://page.test/app/' },
    configurable: true,
    writable: true,
  });

  try {
    const outcome = await new FetchAdapter()
      .send({
        requestURL: '/api/x',
        method: 'GET',
        headers: { 'x-bad': 'line\nbreak' },
      })
      .then(
        () => undefined,
        (error: unknown) => error as Record<PropertyKey, unknown>,
      );

    expect(outcome?.[NON_RETRYABLE_HTTP_ADAPTER_ERROR_FLAG]).toBe(true);
    expect(fetched).toBe(0);
  } finally {
    globalThis.fetch = originalFetch;
    if (didHaveLocation) {
      Object.defineProperty(globalThis, 'location', {
        value: originalLocation,
        configurable: true,
        writable: true,
      });
    } else {
      delete (globalThis as { location?: unknown }).location;
    }
  }
});

test("a mock route's cookies and headers are checked as read, once", async () => {
  let cookieReads = 0;
  let headerReads = 0;
  const answers = [
    {
      status: 200,
      get cookies(): unknown {
        return cookieReads++ === 0 ? {} : new Map([['a', '1']]);
      },
    },
    {
      status: 200,
      get headers(): unknown {
        return headerReads++ === 0 ? {} : new Headers({ 'set-cookie': 'a=1' });
      },
    },
  ];

  for (const answer of answers) {
    const mock = new MockAdapter();
    mock.routes.get('/x', () => answer as unknown as { status: number });
    const outcome = await mock
      .send({ requestURL: 'http://api.test/x', method: 'GET', headers: {} })
      .then(
        (response) => response as unknown as Record<PropertyKey, unknown>,
        (error: unknown) => error as Record<PropertyKey, unknown>,
      );

    // Read once and passed as checked: an empty record, so no refusal and no cookie.
    expect(outcome.status).toBe(200);
  }

  expect(cookieReads).toBe(1);
  expect(headerReads).toBe(1);
});

test("FetchAdapter resolves a relative request against the document's base URL", async () => {
  const originalFetch = globalThis.fetch;
  const OriginalRequest = globalThis.Request;
  const saved = {
    location: Object.getOwnPropertyDescriptor(globalThis, 'location'),
    document: Object.getOwnPropertyDescriptor(globalThis, 'document'),
  };
  const probed: string[] = [];
  (globalThis as { fetch: unknown }).fetch = () =>
    Promise.resolve(new Response('ok', { status: 200 }));
  (globalThis as { Request: unknown }).Request = class extends OriginalRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      probed.push(typeof input === 'string' ? input : 'non-string input');
      super(input, init);
    }
  };
  Object.defineProperty(globalThis, 'location', {
    value: { href: 'https://page.test/' },
    configurable: true,
    writable: true,
  });
  // As a `<base href>` sets it: `fetch` resolves against this, not the location.
  Object.defineProperty(globalThis, 'document', {
    value: { baseURI: 'https://api.test/v2/' },
    configurable: true,
    writable: true,
  });

  try {
    await new FetchAdapter().send({
      requestURL: 'users',
      method: 'GET',
      headers: {},
    });

    expect(probed).toEqual(['https://api.test/v2/users']);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.Request = OriginalRequest;
    for (const [name, descriptor] of Object.entries(saved)) {
      if (descriptor === undefined) {
        delete (globalThis as Record<string, unknown>)[name];
      } else {
        Object.defineProperty(globalThis, name, descriptor);
      }
    }
  }
});

test("NodeAdapter's pre-dispatch check counts a signal as aborted only when exactly true", async () => {
  const signal = {
    aborted: 'false',
    addEventListener() {},
    removeEventListener() {},
  } as unknown as AbortSignal;

  // Nothing listens on port 1: a transport failure, not an abort nobody made.
  const response = await new NodeAdapter().send({
    requestURL: 'http://127.0.0.1:1/x',
    method: 'GET',
    headers: {},
    signal,
  });

  expect(response.isTransportError).toBe(true);
});

test('the AbortSignal.any fallback reads a caller signal by the shared rule', async () => {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- put back as it was, below
  const originalAny = AbortSignal.any;
  (AbortSignal as { any?: unknown }).any = undefined;
  let sends = 0;

  try {
    const response = await new HTTPClient({
      baseURL: 'http://api.test',
      adapter: {
        getType: () => 'mock',
        send: () => {
          sends++;
          return Promise.resolve({ status: 200, headers: {}, body: null });
        },
      },
    })
      .get('/x')
      .signal({
        aborted: 'false',
        reason: undefined,
        addEventListener() {},
        removeEventListener() {},
        [Symbol.toStringTag]: 'AbortSignal',
      } as unknown as AbortSignal)
      .send();

    expect(response.isCancelled).toBe(false);
    expect(sends).toBe(1);
  } finally {
    AbortSignal.any = originalAny;
  }
});

test("MockAdapter reads a route's status once", async () => {
  let reads = 0;
  const mock = new MockAdapter();
  mock.routes.get('/x', () => ({
    get status(): number {
      reads++;
      return reads === 1 ? 200 : 0;
    },
  }));

  const response = await mock.send({
    requestURL: 'http://api.test/x',
    method: 'GET',
    headers: {},
  });

  expect(response.status).toBe(200);
  expect(reads).toBe(1);
});

test('NodeAdapter refuses a malformed URL as non-retryable', async () => {
  const outcome = await new NodeAdapter()
    .send({ requestURL: 'not a url', method: 'GET', headers: {} })
    .then(
      () => undefined,
      (error: unknown) => error as Record<PropertyKey, unknown>,
    );

  expect(outcome?.[NON_RETRYABLE_HTTP_ADAPTER_ERROR_FLAG]).toBe(true);
});

test('a raw deflate body opening on a stored block with padding bits set is read as raw', async () => {
  // A non-final stored block whose padding bits make its first byte 0x08 - a zlib
  // method nibble - but whose first two bytes fail the zlib header check, then an empty
  // final block.
  const raw = Buffer.from([
    0x08,
    5,
    0,
    0xfa,
    0xff,
    ...Buffer.from('hello'),
    0x01,
    0,
    0,
    0xff,
    0xff,
  ]);
  const server = http.createServer((_req, res) => {
    res.writeHead(200, {
      'content-type': 'text/plain',
      'content-encoding': 'deflate',
    });
    res.end(raw);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const { port } = server.address() as AddressInfo;
    const response = await new HTTPClient({
      adapter: new NodeAdapter(),
      baseURL: `http://127.0.0.1:${port}`,
    })
      .get('/x')
      .send();

    expect(response.isStreamError).toBe(false);
    expect(response.body).toBe('hello');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("a mock route's transportError status is checked as the route's mistake", async () => {
  for (const status of ['x', 1.5, -1, 1000]) {
    const mock = new MockAdapter();
    mock.routes.get('/x', () => ({
      status: 200,
      transportError: { status: status as number },
    }));
    const outcome = await mock
      .send({ requestURL: 'http://api.test/x', method: 'GET', headers: {} })
      .then(
        () => undefined,
        (error: unknown) => error as Record<PropertyKey, unknown>,
      );

    expect(String(outcome?.message)).toContain('transportError status');
    expect(outcome?.[NON_RETRYABLE_HTTP_ADAPTER_ERROR_FLAG]).toBe(true);
  }
});

test("a decode failure after the body reached the caller's stream is not retried", async () => {
  let sends = 0;
  const builder = new HTTPClient({
    baseURL: 'http://api.test',
    retryPolicy: { strategy: 'fixed', maxRetryAttempts: 1, delayMS: 0 },
    adapter: {
      getType: () => 'node',
      send: (request: AdapterRequest) => {
        sends++;
        // The body handed to the caller's stream, then its decoding failed.
        void request.streamResponse?.(
          { status: 200, headers: {}, url: request.requestURL } as never,
          {} as never,
        );
        const cause = new Error('incorrect header check');
        Object.defineProperty(cause, RESPONSE_DECODE_ERROR_KEY, {
          value: true,
        });
        return Promise.resolve({
          status: 503,
          headers: {},
          body: null,
          isStreamError: true,
          streamErrorCode: 'stream_response_error',
          errorCause: cause,
        });
      },
    },
  })
    .get('/x')
    .streamResponse(() => new PassThrough());
  const response = await builder.send();

  expect(response.isStreamError).toBe(true);
  expect(sends).toBe(1);
});

test('MockAdapter uppercases a method ASCII only', async () => {
  const mock = new MockAdapter();
  let calls = 0;
  mock.routes.post('/x', () => {
    calls++;
    return { status: 201 };
  });

  // `toUpperCase` makes `poſt` (U+017F) `POST`. Not a token, it is refused before any
  // route is matched - never answered by the `POST` route.
  const outcome = await mock
    .send({
      requestURL: 'http://api.test/x',
      method: 'po\u017Ft',
      headers: {},
    })
    .then(
      () => undefined,
      (error: unknown) => error as Error,
    );

  expect(outcome?.message).toBe(
    'Adapter request method is not a valid HTTP method name (got a string with characters an HTTP token does not allow)',
  );
  expect(calls).toBe(0);
});

test('a CRL buffer changed in place is read again, not reused', async () => {
  const crl = Buffer.from(getRevocationFixtures().crlEmpty);
  const adapter = new NodeAdapter({ crl });

  // Read and parsed: nothing listens on port 1, so a transport failure.
  const first = await adapter.send({
    requestURL: 'https://127.0.0.1:1/',
    method: 'GET',
    headers: {},
  });
  expect(first.isTransportError).toBe(true);

  // The same buffer, its bytes replaced: refused, not served from the last parse.
  crl.fill(0x41);
  const second = await adapter
    .send({ requestURL: 'https://127.0.0.1:1/', method: 'GET', headers: {} })
    .then(
      () => undefined,
      (error: unknown) => error as Record<PropertyKey, unknown>,
    );

  expect(String(second?.message)).toContain('crl');
  expect(second?.[NON_RETRYABLE_HTTP_ADAPTER_ERROR_FLAG]).toBe(true);
});

async function withRawServer(
  handler: (res: http.ServerResponse) => void | Promise<void>,
  run: (baseURL: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer((_req, res) => {
    void handler(res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('a zstd body with a trailing skippable frame is whole', async () => {
  const data = (
    zlib as unknown as { zstdCompressSync: (input: Buffer) => Buffer }
  ).zstdCompressSync(Buffer.from('hello world'));
  // A skippable frame (RFC 8878): magic 0x184D2A50, a 4-byte size, then that many bytes.
  const skippable = Buffer.concat([
    Buffer.from([0x50, 0x2a, 0x4d, 0x18, 3, 0, 0, 0]),
    Buffer.from('abc'),
  ]);

  await withRawServer(
    (res) => {
      res.writeHead(200, {
        'content-type': 'text/plain',
        'content-encoding': 'zstd',
      });
      res.end(Buffer.concat([data, skippable]));
    },
    async (baseURL) => {
      const response = await new HTTPClient({
        adapter: new NodeAdapter(),
        baseURL,
      })
        .get('/x')
        .send();

      expect(response.isStreamError).toBe(false);
      expect(response.body).toBe('hello world');
    },
  );
});

test('a raw deflate body whose first chunk is one byte is still read as raw', async () => {
  const raw = Buffer.from([
    0x08,
    5,
    0,
    0xfa,
    0xff,
    ...Buffer.from('hello'),
    0x01,
    0,
    0,
    0xff,
    0xff,
  ]);

  await withRawServer(
    async (res) => {
      res.writeHead(200, {
        'content-type': 'text/plain',
        'content-encoding': 'deflate',
      });
      res.flushHeaders();
      res.write(raw.subarray(0, 1));
      await sleep(30);
      res.end(raw.subarray(1));
    },
    async (baseURL) => {
      const response = await new HTTPClient({
        adapter: new NodeAdapter(),
        baseURL,
      })
        .get('/x')
        .send();

      expect(response.isStreamError).toBe(false);
      expect(response.body).toBe('hello');
    },
  );
});

test('FetchAdapter sends a standard method uppercase, as every adapter does', async () => {
  const originalFetch = globalThis.fetch;
  const sent: Array<string | undefined> = [];
  (globalThis as { fetch: unknown }).fetch = (
    _url: unknown,
    init?: RequestInit,
  ) => {
    sent.push(init?.method);
    return Promise.resolve(new Response('ok', { status: 200 }));
  };
  // A `Request` that keeps a custom method as written, as Node's does. Bun's uppercases
  // `purge`, so its `fetch` would send `PURGE`, which FetchAdapter refuses.
  const originalRequest = globalThis.Request;
  globalThis.Request = class {
    public readonly method: string;

    constructor(_input: RequestInfo | URL, init?: RequestInit) {
      this.method = init?.method ?? 'GET';
    }
  } as unknown as typeof Request;

  try {
    for (const method of ['patch', 'purge']) {
      await new FetchAdapter().send({
        requestURL: 'https://local.test/x',
        method,
        headers: {},
      });
    }
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.Request = originalRequest;
  }

  // A standard method uppercased; any other kept as written (RFC 9110).
  expect(sent).toEqual(['PATCH', 'purge']);
});

test('a zstd body of two frames in one write decodes whole', async () => {
  const compress = (
    zlib as unknown as { zstdCompressSync: (input: Buffer) => Buffer }
  ).zstdCompressSync;
  const body = Buffer.concat([
    compress(Buffer.from('hello ')),
    compress(Buffer.from('world')),
  ]);

  await withRawServer(
    (res) => {
      res.writeHead(200, {
        'content-type': 'text/plain',
        'content-encoding': 'zstd',
      });
      res.end(body);
    },
    async (baseURL) => {
      const response = await new HTTPClient({
        adapter: new NodeAdapter(),
        baseURL,
      })
        .get('/x')
        .send();

      expect(response.isStreamError).toBe(false);
      expect(response.body).toBe('hello world');
    },
  );
});

test("setCookie caps a lifetime at 400 days from the cookie's creation", () => {
  const jar = new CookieJar();
  const createdAt = Date.now();
  const tenYears = 10 * 365 * 24 * 60 * 60;
  jar.setCookie({
    name: 'a',
    value: '1',
    domain: 'example.com',
    createdAt,
    maxAge: tenYears,
    expires: new Date(createdAt + tenYears * 1000),
  });

  const [stored] = jar.getAllCookies();
  const cap = 400 * 24 * 60 * 60;
  expect(stored.maxAge).toBe(cap);
  expect(stored.expires?.getTime()).toBe(createdAt + cap * 1000);
});

test("a cookie's creation is never taken from the future", () => {
  const jar = new CookieJar();
  const now = Date.now();
  const fiveYears = 5 * 365 * 24 * 60 * 60 * 1000;
  jar.setCookie({
    name: 'a',
    value: '1',
    domain: 'example.com',
    createdAt: now + fiveYears,
    expires: new Date(now + fiveYears + 10 * 24 * 60 * 60 * 1000),
  });

  const [stored] = jar.getAllCookies();
  const capMS = 400 * 24 * 60 * 60 * 1000;
  expect(stored.createdAt).toBeLessThanOrEqual(Date.now());
  expect(stored.expires?.getTime()).toBeLessThanOrEqual(Date.now() + capMS);
});

test('a kept origin list the caller changes is read afresh', () => {
  const list = ['https://*.a.example'];
  expect(matchesOriginList('https://x.a.example', list)).toBe(true);

  list[0] = 'https://*.b.example';
  expect(matchesOriginList('https://x.a.example', list)).toBe(false);
  expect(matchesOriginList('https://x.b.example', list)).toBe(true);
});

test('a raw deflate body whose first byte has a window nibble over 7 is read as raw', async () => {
  // A stored block whose padding bits make its first byte 0x88 - method 8, window 8 -
  // and whose first two bytes are a multiple of 31: no zlib header, since a zlib window
  // is at most 7.
  const raw = Buffer.from([
    0x88,
    28,
    0,
    0xe3,
    0xff,
    ...Buffer.from('x'.repeat(28)),
    0x01,
    0,
    0,
    0xff,
    0xff,
  ]);

  await withRawServer(
    (res) => {
      res.writeHead(200, {
        'content-type': 'text/plain',
        'content-encoding': 'deflate',
      });
      res.end(raw);
    },
    async (baseURL) => {
      const response = await new HTTPClient({
        adapter: new NodeAdapter(),
        baseURL,
      })
        .get('/x')
        .send();

      expect(response.isStreamError).toBe(false);
      expect(response.body).toBe('x'.repeat(28));
    },
  );
});

test('NodeAdapter hands over an empty body as empty bytes, as the other adapters do', async () => {
  await withRawServer(
    (res) => {
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': '0',
      });
      res.end();
    },
    async (baseURL) => {
      const response = await new NodeAdapter().send({
        requestURL: `${baseURL}/x`,
        method: 'GET',
        headers: {},
      });

      expect(response.body).toBeInstanceOf(Uint8Array);
      expect((response.body as Uint8Array).byteLength).toBe(0);
    },
  );
});

test('a decoded body resumed with no reader drains, as a raw response does', async () => {
  const res = new PassThrough() as unknown as http.IncomingMessage;
  const { source } = createResponseBodySource(res, 'gzip');
  let didEnd = false;
  source.on('end', () => {
    didEnd = true;
  });

  // No `data` listener: the body is drained, and its `end` heard.
  source.resume();
  (res as unknown as PassThrough).end(zlib.gzipSync(Buffer.from('hello')));
  await sleep(50);

  expect(didEnd).toBe(true);
});

test('NodeAdapter hands over no body for an answer that has none', async () => {
  await withRawServer(
    (res) => {
      res.writeHead(204);
      res.end();
    },
    async (baseURL) => {
      for (const method of ['GET', 'HEAD'] as const) {
        const response = await new NodeAdapter().send({
          requestURL: `${baseURL}/x`,
          method,
          headers: {},
        });

        expect(response.body).toBeNull();
      }
    },
  );
});

test('junk or a bad gzip trailer in a later chunk is a stream error', async () => {
  const junk = Buffer.alloc(1000, 'j');
  const stackedBody = zlib.gzipSync(zlib.brotliCompressSync('hello'));
  // The gzip CRC corrupted, in a chunk sent after the inner brotli stream has ended.
  stackedBody[stackedBody.length - 8] ^= 0xff;
  const bodies: Record<string, [string, Buffer, Buffer]> = {
    br: ['br', zlib.brotliCompressSync('hello'), junk],
    deflate: ['deflate', zlib.deflateSync('hello'), junk],
    raw: ['deflate', zlib.deflateRawSync('hello'), junk],
    stacked: [
      'br, gzip',
      stackedBody.subarray(0, stackedBody.length - 8),
      stackedBody.subarray(stackedBody.length - 8),
    ],
  };
  const server = http.createServer((req, res) => {
    const [encoding, first, later] = bodies[(req.url ?? '/').slice(1)] ?? [
      'identity',
      Buffer.from('x'),
      Buffer.alloc(0),
    ];
    res.writeHead(200, {
      'content-type': 'text/plain',
      'content-encoding': encoding,
    });
    res.write(first);
    setTimeout(() => {
      res.end(later);
    }, 50);
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const client = new HTTPClient({ adapter: new NodeAdapter(), baseURL });
    for (const kind of Object.keys(bodies)) {
      const response = await client.get(`/${kind}`).send();
      expect({ kind, isStreamError: response.isStreamError }).toEqual({
        kind,
        isStreamError: true,
      });
    }
  } finally {
    server.close();
  }
});

test('a HEAD answered 200 does not call the streamResponse factory', async () => {
  await withRawServer(
    (res) => {
      res.writeHead(200, { 'content-length': '5' });
      res.end();
    },
    async (baseURL) => {
      let factoryCalls = 0;
      const response = await new HTTPClient({
        adapter: new NodeAdapter(),
        baseURL,
      })
        .head('/x')
        .streamResponse(() => {
          factoryCalls++;
          return null;
        })
        .send();

      expect(factoryCalls).toBe(0);
      expect(response.status).toBe(200);
      expect(response.isStreamed).toBe(false);
      expect(response.isCancelled).toBe(false);
      expect(response.body).toBeNull();
    },
  );
});

test('a stacked deflate is read whole where the inflater reports no byte count', async () => {
  // An inflater with no `bytesWritten`, as a runtime may have: its count is not read.
  const prototypes = [zlib.Inflate.prototype, zlib.InflateRaw.prototype];
  for (const prototype of prototypes) {
    Object.defineProperty(prototype, 'bytesWritten', {
      configurable: true,
      get: () => undefined,
      set: () => undefined,
    });
  }

  try {
    for (const encode of [zlib.deflateSync, zlib.deflateRawSync]) {
      const res = new PassThrough() as unknown as http.IncomingMessage;
      // `deflate` applied first, so it is the inner coding and told by its first bytes.
      const { source } = createResponseBodySource(res, 'deflate, gzip');
      const chunks: Buffer[] = [];
      const outcome = new Promise<string>((resolve) => {
        source.on('data', (chunk: Buffer) => chunks.push(chunk));
        source.on('end', () => resolve('end'));
        source.on('error', (error: Error) => resolve(error.message));
      });

      (res as unknown as PassThrough).end(
        zlib.gzipSync(encode(Buffer.from('hello'))),
      );

      expect(await outcome).toBe('end');
      expect(Buffer.concat(chunks).toString()).toBe('hello');
    }
  } finally {
    for (const prototype of prototypes) {
      delete (prototype as { bytesWritten?: unknown }).bytesWritten;
    }
  }
});

test('a zstd body of many empty skippable frames before its data decodes whole', async () => {
  const data = (
    zlib as unknown as { zstdCompressSync: (input: Buffer) => Buffer }
  ).zstdCompressSync(Buffer.from('hello'));
  // An empty skippable frame (RFC 8878): its magic and a size of zero, 8 bytes in all.
  const skippable = Buffer.from([0x50, 0x2a, 0x4d, 0x18, 0, 0, 0, 0]);
  const res = new PassThrough() as unknown as http.IncomingMessage;
  const { source } = createResponseBodySource(res, 'zstd');
  const chunks: Buffer[] = [];
  const outcome = new Promise<string>((resolve) => {
    source.on('data', (chunk: Buffer) => chunks.push(chunk));
    source.on('end', () => resolve('end'));
    source.on('error', (error: Error) => resolve(error.message));
  });

  // A 64 KiB chunk of them: each frame is its own write to the decoder.
  (res as unknown as PassThrough).end(
    Buffer.concat([...new Array<Buffer>(8192).fill(skippable), data]),
  );

  expect(await outcome).toBe('end');
  expect(Buffer.concat(chunks).toString()).toBe('hello');
});

test('an opaque origin is cross-origin, even to the same URL', () => {
  expect(isCrossOrigin('foo://a/x', 'foo://b/y')).toBe(true);
  expect(isCrossOrigin('foo://a/x', 'foo://a/x')).toBe(true);
  expect(isCrossOrigin('file:///a', new URL('file:///a'))).toBe(true);
  expect(isCrossOrigin('https://a.test/x', 'foo://a.test/x')).toBe(true);
  expect(isCrossOrigin('https://a.test/x', 'https://a.test/y')).toBe(false);
});

test("detectedRedirectURL does not copy the request's userinfo onto a relative Location", async () => {
  await withRawServer(
    (res) => {
      // Each answers a redirect to itself, so a followed one ends as `redirect_loop`.
      res.writeHead(302, {
        location:
          res.req.url === '/userinfo'
            ? `//s:t@${res.req.headers.host}/userinfo`
            : '/x?q',
      });
      res.end();
    },
    async (baseURL) => {
      const credentialedURL = baseURL.replace('http://', 'http://u:p@');
      // The adapter's own report, as `redirect`-phase observers read it.
      const adapterResponse = await new NodeAdapter().send({
        requestURL: `${credentialedURL}/x`,
        method: 'GET',
        headers: {},
      });

      expect(adapterResponse.detectedRedirectURL).toBe(`${baseURL}/x?q`);

      // `redirect_disabled`, and the client loop's own `redirect_loop`.
      for (const isFollowing of [false, true]) {
        const client = new HTTPClient({
          adapter: new NodeAdapter(),
          followRedirects: isFollowing,
          ...(isFollowing ? { maxRedirects: 1 } : {}),
        });
        const relativeBuilder = client.get(`${credentialedURL}/x`);
        const relative = await relativeBuilder.send();
        const serverWritten = await client
          .get(`${credentialedURL}/userinfo`)
          .send();

        expect(relativeBuilder.error?.code).toBe(
          isFollowing ? 'redirect_loop' : 'redirect_disabled',
        );
        expect(relative.detectedRedirectURL).toBe(`${baseURL}/x?q`);
        // Userinfo the server wrote itself is still reported as written - but not where
        // the loop already followed it: the hop that ends the request was sent with
        // `s:t`, and userinfo identical to the request URL's own is not reported.
        expect(serverWritten.detectedRedirectURL).toBe(
          isFollowing
            ? `${baseURL}/userinfo`
            : baseURL.replace('http://', 'http://s:t@') + '/userinfo',
        );
      }

      // A hop the client loop detected and then did not follow: cancelled before it went out.
      const cancelling = new HTTPClient({
        adapter: new NodeAdapter(),
        followRedirects: true,
      });
      cancelling.addRequestInterceptor(() => ({ cancel: true as const }), {
        phases: ['redirect'],
      });
      const cancelled = await cancelling.get(`${credentialedURL}/x`).send();

      expect(cancelled.isCancelled).toBe(true);
      expect(cancelled.detectedRedirectURL).toBe(`${baseURL}/x?q`);
    },
  );
});

test('a Location that does not resolve reports no detectedRedirectURL', async () => {
  await withRawServer(
    (res) => {
      res.writeHead(302, { location: 'http://[bad' });
      res.end();
    },
    async (baseURL) => {
      const adapterResponse = await new NodeAdapter().send({
        requestURL: `${baseURL}/x`,
        method: 'GET',
        headers: {},
      });

      expect(adapterResponse.wasRedirectDetected).toBe(true);
      expect(adapterResponse.detectedRedirectURL).toBeUndefined();

      for (const isFollowing of [false, true]) {
        const builder = new HTTPClient({
          adapter: new NodeAdapter(),
          baseURL,
          followRedirects: isFollowing,
        }).get('/x');
        const response = await builder.send();

        expect(builder.error?.code).toBe(
          isFollowing ? 'request_setup_error' : 'redirect_disabled',
        );
        expect(response.wasRedirectDetected).toBe(true);
        expect(response.wasRedirectFollowed).toBe(false);
        expect(response.detectedRedirectURL).toBeUndefined();
        expect(builder.error?.detectedRedirectURL).toBeUndefined();
      }
    },
  );
});

test('a late cancel at a Location that does not resolve counts no followed hop', async () => {
  for (const location of ['http://[bad', '/ok']) {
    const adapter = new MockAdapter();
    adapter.routes.get('/x', () => ({ status: 302, headers: { location } }));
    const client = new HTTPClient({
      adapter,
      baseURL: 'http://a.test',
      followRedirects: true,
    });
    const builder = client.get('/x');
    // Cancelled from the interceptor, which then throws: the `interceptor_error` this
    // ends with is turned into a cancel after the loop.
    client.addRequestInterceptor(
      () => {
        builder.cancel();
        throw new Error('boom');
      },
      { phases: ['redirect'] },
    );
    const response = await builder.send();

    expect({
      location,
      isCancelled: response.isCancelled,
      wasRedirectDetected: response.wasRedirectDetected,
      wasRedirectFollowed: response.wasRedirectFollowed,
      detectedRedirectURL: response.detectedRedirectURL,
      redirectHistory: response.redirectHistory,
    }).toEqual({
      location,
      isCancelled: true,
      wasRedirectDetected: true,
      wasRedirectFollowed: false,
      detectedRedirectURL: location === '/ok' ? 'http://a.test/ok' : undefined,
      redirectHistory: [location === '/ok' ? 'http://a.test/ok' : location],
    });
  }
});

test('in a browser, a path still relative after baseURL resolves against the page as fetch does', async () => {
  const originalFetch = globalThis.fetch;
  const saved = {
    window: Object.getOwnPropertyDescriptor(globalThis, 'window'),
    document: Object.getOwnPropertyDescriptor(globalThis, 'document'),
  };
  const sentURLs: string[] = [];
  (globalThis as { fetch: unknown }).fetch = (url: string) => {
    sentURLs.push(url);
    return Promise.resolve(new Response('ok', { status: 200 }));
  };
  Object.defineProperty(globalThis, 'window', {
    value: {},
    configurable: true,
    writable: true,
  });
  // A page URL names a document, not a directory: `fetch('v1/users')` from it requests
  // `/dir/v1/users`.
  Object.defineProperty(globalThis, 'document', {
    value: { baseURI: 'https://app.test/dir/page' },
    configurable: true,
    writable: true,
  });

  try {
    await new HTTPClient().get('v1/users').send();
    await new HTTPClient({ baseURL: 'api' }).get('/users').send();
    await new HTTPClient({ baseURL: '/api' }).get('users').send();

    expect(sentURLs).toEqual([
      'https://app.test/dir/v1/users',
      'https://app.test/dir/api/users',
      'https://app.test/api/users',
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, descriptor] of Object.entries(saved)) {
      if (descriptor === undefined) {
        delete (globalThis as Record<string, unknown>)[name];
      } else {
        Object.defineProperty(globalThis, name, descriptor);
      }
    }
  }
});

test('an opaque-origin hop does not keep URL userinfo', () => {
  // Every non-special URL's origin reads `'null'`; two of them are not the same origin.
  expect(
    stripCrossOriginURLCredentials('foo://u:p@b.test/x', 'foo://a.test/'),
  ).toBe('foo://b.test/x');
  // The client's own origin still keeps its userinfo.
  expect(
    stripCrossOriginURLCredentials(
      'https://u:p@a.test/x',
      'https://a.test/start',
    ),
  ).toBe('https://u:p@a.test/x');
});

test('detectedRedirectURL drops server-written userinfo on another origin', async () => {
  // The shared helper, as an adapter reports it: cross-origin userinfo dropped, the
  // request's own origin's kept, and a request URL that does not parse counts as
  // cross-origin.
  expect(
    derivedRedirectFields('https://a.test/start', 302, {
      location: 'https://evil:secret@other.test/',
    }).detectedRedirectURL,
  ).toBe('https://other.test/');
  expect(
    derivedRedirectFields('https://a.test/start', 302, {
      location: 'https://u:p@a.test/next',
    }).detectedRedirectURL,
  ).toBe('https://u:p@a.test/next');
  expect(
    derivedRedirectFields('not a url', 302, {
      location: 'https://evil:secret@other.test/',
    }).detectedRedirectURL,
  ).toBe('https://other.test/');

  const adapter = new MockAdapter();
  adapter.routes.get('/cross', () => ({
    status: 302,
    headers: { location: 'https://evil:secret@other.test/y' },
  }));
  adapter.routes.get('/same', () => ({
    status: 302,
    headers: { location: 'https://u:p@a.test/z' },
  }));

  // An undispatched exit from the client's own loop: a redirect-phase interceptor that
  // refuses the hop.
  const following = new HTTPClient({
    adapter,
    baseURL: 'https://a.test',
    followRedirects: true,
  });
  following.addRequestInterceptor(
    () => {
      throw new Error('no hop');
    },
    { phases: ['redirect'] },
  );
  const cross = following.get('/cross');
  const crossResponse = await cross.send();
  expect(cross.error?.code).toBe('interceptor_error');
  expect(crossResponse.detectedRedirectURL).toBe('https://other.test/y');
  expect(cross.error?.detectedRedirectURL).toBe('https://other.test/y');
  const same = following.get('/same');
  await same.send();
  expect(same.error?.detectedRedirectURL).toBe('https://u:p@a.test/z');

  // The adapter's own report, on a redirect the client does not follow.
  const disabled = new HTTPClient({
    adapter,
    baseURL: 'https://a.test',
    followRedirects: false,
  }).get('/cross');
  await disabled.send();
  expect(disabled.error?.code).toBe('redirect_disabled');
  expect(disabled.error?.detectedRedirectURL).toBe('https://other.test/y');
});

test("an adapter's own detectedRedirectURL drops userinfo on another origin", async () => {
  const answering = (detectedRedirectURL: unknown): HTTPAdapter => ({
    getType: () => 'node',
    send: () =>
      Promise.resolve({
        status: 302,
        // Not what is reported: the adapter's own target is.
        headers: { location: 'https://ignored.test/' },
        body: null,
        wasRedirectDetected: true,
        detectedRedirectURL: detectedRedirectURL as string,
      }),
  });
  const send = async (detectedRedirectURL: unknown) => {
    const builder = new HTTPClient({
      adapter: answering(detectedRedirectURL),
      baseURL: 'https://a.test',
      followRedirects: false,
    }).get('/start');
    const response = await builder.send();
    expect(builder.error?.code).toBe('redirect_disabled');
    return [response.detectedRedirectURL, builder.error?.detectedRedirectURL];
  };

  expect(await send('https://a:b@other.test/')).toEqual([
    'https://other.test/',
    'https://other.test/',
  ]);
  expect(await send('https://a:b@a.test/next')).toEqual([
    'https://a:b@a.test/next',
    'https://a:b@a.test/next',
  ]);
  // Not a string: dropped, and the target derived from `Location` instead.
  expect(await send(new URL('https://a:b@other.test/'))).toEqual([
    'https://ignored.test/',
    'https://ignored.test/',
  ]);
});

test("an adapter's answer flags are read only as booleans", async () => {
  const answering = (answer: Record<string, unknown>): HTTPAdapter => ({
    getType: () => 'node',
    send: () =>
      Promise.resolve({
        headers: {},
        body: null,
        ...answer,
      } as AdapterResponse),
  });

  // A status-0 answer whose redirect flag is the string `'false'`: no redirect, so the
  // network error it is, and no string reported as the flag.
  const redirectBuilder = new HTTPClient({
    adapter: answering({ status: 0, wasRedirectDetected: 'false' }),
    baseURL: 'https://a.test',
    followRedirects: false,
  }).get('/x');
  const redirectResponse = await redirectBuilder.send();
  expect(redirectBuilder.error?.code).toBe('network_error');
  expect(redirectResponse.wasRedirectDetected).toBe(false);
  expect(redirectBuilder.error?.wasRedirectDetected).toBe(false);

  // A healthy `200` whose failure flags are strings is the success it reports.
  const healthyBuilder = new HTTPClient({
    adapter: answering({
      status: 200,
      body: 'ok',
      isTransportError: 'false',
      isStreamError: 'false',
    }),
    baseURL: 'https://a.test',
  }).get('/x');
  const healthyResponse = await healthyBuilder.send();
  expect(healthyBuilder.error).toBeNull();
  expect(healthyResponse.isFailed).toBe(false);
  expect(healthyResponse.isNetworkError).toBe(false);
  expect(healthyResponse.isStreamError).toBe(false);
});

test('an adapter driven with a requestURL that is not a string refuses it as non-retryable', async () => {
  const refusalOf = (adapter: HTTPAdapter, requestURL: unknown) =>
    adapter
      .send({
        requestURL: requestURL as string,
        // Another origin, so the URL's credentials are looked for.
        initialURL: 'https://a.test/',
        method: 'GET',
        headers: {},
      })
      .then(
        () => undefined,
        (error: unknown) => error as Record<PropertyKey, unknown>,
      );

  for (const adapter of [new FetchAdapter(), new XHRAdapter()]) {
    for (const requestURL of [new URL('https://u:p@b.test/x'), 42]) {
      const refusal = await refusalOf(adapter, requestURL);
      expect(refusal?.[NON_RETRYABLE_HTTP_ADAPTER_ERROR_FLAG]).toBe(true);
      expect(String(refusal?.message)).toContain(
        'Adapter request requestURL must be a string',
      );
    }
  }
});

test("detectedRedirectURL does not report the request URL's own userinfo", async () => {
  // The shared rule: the request's own userinfo is dropped, wherever it came from; other
  // userinfo on the request's origin is the server's, and kept.
  expect(
    reportedRedirectTarget('https://u:p@a.test/next', 'https://u:p@a.test/x'),
  ).toBe('https://a.test/next');
  expect(
    reportedRedirectTarget('//u:p@a.test/next', 'https://u:p@a.test/x'),
  ).toBe('//a.test/next');
  expect(
    reportedRedirectTarget('https://x:y@a.test/next', 'https://u:p@a.test/x'),
  ).toBe('https://x:y@a.test/next');
  expect(reportedRedirectTarget('/next', 'https://u:p@a.test/x')).toBe('/next');
  expect(
    derivedRedirectFields('https://u:p@a.test/start', 302, {
      location: 'https://u:p@a.test/next',
    }).detectedRedirectURL,
  ).toBe('https://a.test/next');

  // A custom adapter that resolves `Location` against the request URL, credentials and
  // all, as `new URL(location, requestURL)` does.
  const resolving: HTTPAdapter = {
    getType: () => 'node',
    send: (request) =>
      Promise.resolve({
        status: 302,
        headers: { location: '/next' },
        body: null,
        wasRedirectDetected: true,
        detectedRedirectURL: new URL('/next', request.requestURL).href,
      }),
  };
  const builder = new HTTPClient({
    adapter: resolving,
    baseURL: 'https://u:p@a.test',
    followRedirects: false,
  }).get('/start');
  const response = await builder.send();
  expect(builder.error?.code).toBe('redirect_disabled');
  expect(response.detectedRedirectURL).toBe('https://a.test/next');
  expect(builder.error?.detectedRedirectURL).toBe('https://a.test/next');
});

test('the adapter type is read once, as the config was checked against it', async () => {
  // A custom adapter whose `getType` answers `node` once, then `xhr`: a client that read
  // it again per request ran a request as two adapter types at once.
  let typeReads = 0;
  const adapter: HTTPAdapter = {
    getType: () => (typeReads++ === 0 ? 'node' : 'xhr'),
    send: () => Promise.resolve({ status: 200, headers: {}, body: null }),
  };
  const client = new HTTPClient({ adapter, baseURL: 'https://a.test' });

  const first = await client.get('/one').send();
  const second = await client.get('/two').send();

  expect(typeReads).toBe(1);
  expect(client.adapterType).toBe('node');
  expect(first.adapterType).toBe('node');
  expect(second.adapterType).toBe('node');
});

test("a sub-client sharing its parent's adapter takes the parent's adapter type", async () => {
  // A custom adapter whose `getType` answers `node` once, then `fetch`: a sub-client that
  // read it again treated the parent's one adapter as another type, and checked its
  // config and ran its requests as that type.
  let typeReads = 0;
  const adapter: HTTPAdapter = {
    getType: () => (typeReads++ === 0 ? 'node' : 'fetch'),
    send: () => Promise.resolve({ status: 200, headers: {}, body: null }),
  };
  const parent = new HTTPClient({ adapter, baseURL: 'https://a.test' });
  const inheriting = parent.createSubClient();
  const explicit = parent.createSubClient({ adapter });

  const response = await inheriting.get('/one').send();

  expect(typeReads).toBe(1);
  expect(inheriting.adapterType).toBe('node');
  expect(explicit.adapterType).toBe('node');
  expect(response.adapterType).toBe('node');

  // A sub-client given an adapter of its own reads that adapter's type, once.
  const own = parent.createSubClient({ adapter: new MockAdapter() });
  expect(own.adapterType).toBe('mock');
});

test('an initialURL that is not a string is refused as non-retryable by every adapter', async () => {
  // `null` resolved against the page as a relative reference, and was taken for the
  // page's own origin by the browser adapters.
  for (const adapter of [
    new FetchAdapter(),
    new XHRAdapter(),
    new NodeAdapter(),
    new MockAdapter(),
  ]) {
    for (const initialURL of [null, 42]) {
      const outcome = await adapter
        .send({
          requestURL: 'https://u:p@a.test/x',
          initialURL: initialURL as unknown as string,
          method: 'GET',
          headers: {},
        })
        .then(
          () => undefined,
          (error: unknown) => error as Record<PropertyKey, unknown>,
        );

      expect((outcome as unknown as Error).message).toBe(
        `Adapter request initialURL must be a string (got ${initialURL === null ? 'null' : 'number'})`,
      );
      expect(outcome?.[NON_RETRYABLE_HTTP_ADAPTER_ERROR_FLAG]).toBe(true);
    }
  }
});

test('a method that is not an HTTP token is refused by every adapter, without the method', async () => {
  // NodeAdapter passed on Node's refusal, which quotes the method; MockAdapter answered
  // it with the 404 of a route not found.
  const secret = 'secret-token';
  for (const adapter of [
    new FetchAdapter(),
    new XHRAdapter(),
    new NodeAdapter(),
    new MockAdapter(),
  ]) {
    for (const [method, message] of [
      [
        `GET ${secret}`,
        'Adapter request method is not a valid HTTP method name (got a string with characters an HTTP token does not allow)',
      ],
      [
        { toString: () => `GET ${secret}` },
        'Adapter request method is not a valid HTTP method name (got a string with characters an HTTP token does not allow)',
      ],
      ['', 'Adapter request method is empty'],
    ] as const) {
      const outcome = await adapter
        .send({
          requestURL: 'http://127.0.0.1:1/x',
          method: method as unknown as string,
          headers: {},
        })
        .then(
          () => undefined,
          (error: unknown) => error as Record<PropertyKey, unknown>,
        );

      expect((outcome as unknown as Error | undefined)?.message).toBe(message);
      expect(outcome?.[NON_RETRYABLE_HTTP_ADAPTER_ERROR_FLAG]).toBe(true);
      expect(errorText(outcome)).not.toContain(secret);
    }
  }
});

test('an adapter whose getType() is not an adapter type is refused when the client is built', () => {
  for (const [type, got] of [
    ['custom', 'string'],
    [undefined, 'undefined'],
    [null, 'null'],
    [1, 'number'],
  ] as const) {
    const adapter = {
      getType: () => type as unknown as AdapterType,
      send: () => Promise.resolve({ status: 200, headers: {}, body: null }),
    } satisfies HTTPAdapter;

    expect(() => new HTTPClient({ adapter })).toThrow(
      new TypeError(
        `HTTPClient adapter getType() must return 'fetch', 'xhr', 'node' or 'mock' (got ${got})`,
      ),
    );
  }
});

test("a sub-client's host-filtered interceptor reads its parent's result as one copy", async () => {
  // The parent's last result reaches the sub-client's chain as returned: a `requestURL`
  // getter that answered the trusted host to the filter and another to the interceptor
  // sent the sub-client's token to the other host.
  const seen: Array<{ url: string; authorization: unknown }> = [];
  const adapter: HTTPAdapter = {
    getType: () => 'node',
    send: (request) => {
      seen.push({
        url: request.requestURL,
        authorization: request.headers['authorization'],
      });
      return Promise.resolve({ status: 204, headers: {}, body: null });
    },
  };
  const parent = new HTTPClient({ adapter, baseURL: 'https://trusted.test' });
  let reads = 0;
  parent.addRequestInterceptor((request) => ({
    method: request.method,
    headers: request.headers,
    body: request.body,
    get requestURL() {
      return reads++ === 0 ? 'https://trusted.test/x' : 'https://evil.test/x';
    },
  }));
  const child = parent.createSubClient();
  child.addRequestInterceptor(
    (request) => ({
      ...request,
      headers: { ...request.headers, authorization: 'Bearer token' },
    }),
    { hosts: ['trusted.test'] },
  );

  await child.get('/x').send();

  expect(reads).toBe(1);
  expect(seen).toEqual([
    { url: 'https://trusted.test/x', authorization: 'Bearer token' },
  ]);
});

test('an interceptor result that cannot be copied is reported the same whatever is registered after it', async () => {
  // A result the next interceptor's copy failed on was reported from the request the
  // phase built, not from the result - so a later interceptor, even one this phase never
  // runs, changed what `requestURL` the failure carried.
  const reported = async (
    register: (client: HTTPClient) => void,
  ): Promise<Record<string, unknown>> => {
    const adapter: HTTPAdapter = {
      getType: () => 'node',
      send: () => Promise.resolve({ status: 204, headers: {}, body: null }),
    };
    const client = new HTTPClient({ adapter, baseURL: 'https://a.test' });
    let observedURL: string | undefined;
    client.addErrorObserver((_error, request) => {
      observedURL = request.requestURL;
    });
    client.addRequestInterceptor(
      () =>
        ({
          requestURL: 'https://a.test/bad',
          method: 'GET',
          headers: 'not a record',
        }) as unknown as InterceptedRequest,
    );
    register(client);
    const builder = client.get('/start');
    const response = await builder.send();

    return {
      code: builder.error?.code,
      responseURL: response.requestURL,
      errorURL: builder.error?.requestURL,
      observedURL,
    };
  };

  const alone = await reported(() => {});
  expect(alone).toEqual({
    code: 'interceptor_error',
    responseURL: 'https://a.test/bad',
    errorURL: 'https://a.test/bad',
    observedURL: 'https://a.test/bad',
  });

  // One this phase never runs, and one it does.
  expect(
    await reported((client) => {
      client.addRequestInterceptor((request) => request, {
        phases: ['retry'],
      });
    }),
  ).toEqual(alone);
  expect(
    await reported((client) => {
      client.addRequestInterceptor((request) => request);
    }),
  ).toEqual(alone);
});

test('a malformed interceptor result fails even when a later interceptor would replace it', async () => {
  // Each result is copied before the next interceptor reads it, so a result that is not
  // a request is refused there: the later interceptor never runs.
  let laterCalls = 0;
  const adapter: HTTPAdapter = {
    getType: () => 'node',
    send: () => Promise.resolve({ status: 204, headers: {}, body: null }),
  };
  const client = new HTTPClient({ adapter, baseURL: 'https://a.test' });
  client.addRequestInterceptor(
    () =>
      ({
        requestURL: 'https://a.test/bad',
        method: 'GET',
        headers: new Map(),
      }) as unknown as InterceptedRequest,
  );
  client.addRequestInterceptor(() => {
    laterCalls++;
    return { requestURL: 'https://a.test/ok', method: 'GET', headers: {} };
  });

  const builder = client.get('/start');
  const response = await builder.send();

  expect(builder.error?.code).toBe('interceptor_error');
  expect(response.requestURL).toBe('https://a.test/bad');
  expect(laterCalls).toBe(0);
});

test("a parent interceptor that redefines the request it was handed and returns it is copied before a sub-client's interceptor reads it", async () => {
  // Returned as the very object the parent's chain was handed, it could not be told
  // from a request no interceptor touched: the sub-client's `hosts` filter read the
  // trusted host and its token interceptor the other one.
  const sent: Array<[string, unknown]> = [];
  const adapter: HTTPAdapter = {
    getType: () => 'node',
    send: (request) => {
      sent.push([request.requestURL, request.headers['authorization']]);
      return Promise.resolve({ status: 204, headers: {}, body: null });
    },
  };
  const parent = new HTTPClient({ adapter, baseURL: 'https://trusted.test' });
  let reads = 0;
  parent.addRequestInterceptor((request) => {
    Object.defineProperty(request, 'requestURL', {
      configurable: true,
      enumerable: true,
      get() {
        return reads++ === 0 ? 'https://trusted.test/x' : 'https://evil.test/x';
      },
    });
    return request;
  });
  const child = parent.createSubClient();
  const seenByTokenInterceptor: string[] = [];
  child.addRequestInterceptor(
    (request) => {
      seenByTokenInterceptor.push(request.requestURL);
      return {
        ...request,
        headers: { ...request.headers, authorization: 'Bearer token' },
      };
    },
    { hosts: ['trusted.test'] },
  );

  await child.get('/x').send();

  expect(reads).toBe(1);
  expect(seenByTokenInterceptor).toEqual(['https://trusted.test/x']);
  expect(sent).toEqual([['https://trusted.test/x', 'Bearer token']]);
});

for (const phaseName of ['retry', 'redirect'] as const) {
  test(`an interceptor result that cannot be copied is reported the same in the ${phaseName} phase whatever is registered after it`, async () => {
    // As in the initial phase: the copy the next interceptor - or a sub-client's chain -
    // takes hands the failed result to the phase, which reports from it as it does when
    // its own copy fails.
    const reported = async (
      register: (client: HTTPSubClient) => void,
      isOnSubClient = false,
    ): Promise<Record<string, unknown>> => {
      let calls = 0;
      const adapter: HTTPAdapter = {
        getType: () => 'node',
        send: () => {
          calls++;
          const answer: AdapterResponse =
            calls > 1
              ? { status: 204, headers: {}, body: null }
              : phaseName === 'retry'
                ? { status: 503, headers: {}, body: null }
                : { status: 302, headers: { location: '/next' }, body: null };
          return Promise.resolve(answer);
        },
      };
      const root = new HTTPClient({
        adapter,
        baseURL: 'https://a.test',
        followRedirects: true,
        retryPolicy: { strategy: 'fixed', maxRetryAttempts: 1, delayMS: 0 },
      });
      const client = isOnSubClient ? root.createSubClient() : root;
      let observedURL: string | undefined;
      client.addErrorObserver((_error, request) => {
        observedURL = request.requestURL;
      });
      // The bad interceptor on the parent, for the sub-client: its result reaches the
      // sub-client's chain uncopied.
      (isOnSubClient ? root : client).addRequestInterceptor(
        () =>
          ({
            requestURL: 'https://a.test/bad',
            method: 'GET',
            headers: 'not a record',
          }) as unknown as InterceptedRequest,
        { phases: [phaseName] },
      );
      register(client);
      const builder = client.get('/start');
      const response = await builder.send();

      return {
        code: builder.error?.code,
        responseURL: response.requestURL,
        errorURL: builder.error?.requestURL,
        observedURL,
      };
    };

    const alone = await reported(() => {});
    expect(alone).toEqual({
      code: 'interceptor_error',
      responseURL: 'https://a.test/bad',
      errorURL: 'https://a.test/bad',
      observedURL: 'https://a.test/bad',
    });

    const passThrough = (
      client: HTTPSubClient,
      phases: InterceptorPhaseName[],
    ) =>
      client.addRequestInterceptor((request) => request, {
        phases,
      });
    const otherPhase = phaseName === 'retry' ? 'redirect' : 'retry';

    expect(
      await reported((client) => passThrough(client, [phaseName])),
    ).toEqual(alone);
    expect(
      await reported((client) => passThrough(client, [otherPhase])),
    ).toEqual(alone);
    expect(await reported(() => {}, true)).toEqual(alone);
    expect(
      await reported((client) => passThrough(client, [phaseName]), true),
    ).toEqual(alone);
  });
}

test('a header string passed where a header object belongs is not written into the error', () => {
  const headers = 'Authorization: Bearer secret-token' as unknown as Record<
    string,
    string
  >;
  const caught: unknown[] = [];

  for (const build of [
    () => new HTTPClient({ defaultHeaders: headers }),
    () => new HTTPClient().get('/x', { headers }),
    () => new CookieJar().processResponseHeaders(headers, 'https://a.test/'),
  ]) {
    try {
      build();
    } catch (error) {
      caught.push(error);
    }
  }

  expect(caught).toHaveLength(3);

  for (const error of caught) {
    expect(error).toBeInstanceOf(TypeError);
    expect((error as TypeError).message).toEndWith('(got string)');
    expect((error as TypeError).message).not.toContain('secret-token');
  }
});

test("a parent whose interceptors are not called in a phase leaves the sub-client's chain the request uncopied", async () => {
  // A copy is taken through `snapshotInterceptedRequest`, which checks the method with
  // `describeInvalidHTTPMethod`: counted from the moment the request is sent, nothing
  // else calls it before the sub-client's interceptor runs.
  const adapter: HTTPAdapter = {
    getType: () => 'node',
    send: () => Promise.resolve({ status: 204, headers: {}, body: null }),
  };
  const copiesBeforeOwnInterceptor = async (
    registerOnParent: (parent: HTTPClient) => void,
  ): Promise<number> => {
    const parent = new HTTPClient({ adapter, baseURL: 'https://a.test' });
    registerOnParent(parent);
    const child = parent.createSubClient();
    let copies = -1;
    const methodCheck = spyOn(httpUtils, 'describeInvalidHTTPMethod');
    try {
      child.addRequestInterceptor((request) => {
        copies = methodCheck.mock.calls.length;
        return request;
      });
      const builder = child.get('/x');
      methodCheck.mockClear();
      await builder.send();
    } finally {
      methodCheck.mockRestore();
    }

    return copies;
  };

  // Registered for retries only, or for another host: neither is called for this request.
  expect(
    await copiesBeforeOwnInterceptor((parent) => {
      parent.addRequestInterceptor((request) => request, {
        phases: ['retry'],
      });
    }),
  ).toBe(0);
  expect(
    await copiesBeforeOwnInterceptor((parent) => {
      parent.addRequestInterceptor((request) => request, {
        hosts: ['b.test'],
      });
    }),
  ).toBe(0);
  // One that is called hands on its result, copied before the sub-client's chain reads it.
  expect(
    await copiesBeforeOwnInterceptor((parent) => {
      parent.addRequestInterceptor((request) => request);
    }),
  ).toBe(1);
});

test('a refused method, strategy, URL, redirect Location, suffix, filter entry or cookie value is not written into the error', async () => {
  const secret = 'secret-token';
  const messages: string[] = [];
  const caught = (run: () => unknown): void => {
    try {
      run();
    } catch (error) {
      messages.push(String((error as Error).message));
    }
  };

  // Refused when built or registered.
  caught(() => new HTTPClient().request(`GET\r\nX-Token: ${secret}`, '/x'));
  caught(() =>
    new HTTPClient().createSubClient({
      defaultHeadersStrategy: secret as never,
    }),
  );
  caught(() => new CookieJar({ publicSuffixes: { add: [`*.${secret}`] } }));
  caught(() => new CookieJar({ publicSuffixes: { add: [`${secret}..com`] } }));
  caught(
    () =>
      new CookieJar({
        publicSuffixes: { add: [`a.${secret}.com`], remove: [`${secret}.com`] },
      }),
  );
  caught(() =>
    new HTTPClient().addRequestInterceptor((request) => request, {
      hosts: [`${secret}.test/path`],
    }),
  );
  caught(() =>
    new HTTPClient().addRequestInterceptor((request) => request, {
      schemes: [secret as never],
    }),
  );
  expect(messages).toHaveLength(7);

  // Refused when sent: a URL with no base, an interceptor's rewrite, a route's cookie.
  const noBase = new HTTPClient({ adapter: new RecordingAdapter(200) });
  const unresolved = noBase.get(`/x?token=${secret}`);
  await unresolved.send();
  messages.push(String(unresolved.error?.cause?.message));

  const rewriting = new HTTPClient({
    adapter: new RecordingAdapter(200),
    baseURL: 'https://a.test',
  });
  rewriting.addRequestInterceptor((request) => ({
    ...request,
    requestURL: `/x?token=${secret}`,
  }));
  const rewritten = rewriting.get('/x');
  await rewritten.send();
  messages.push(String(rewritten.error?.cause?.message));

  const adapter = new MockAdapter();
  adapter.routes.get('/login', () => ({
    status: 200,
    cookies: { session: `${secret}; Domain=other.test` },
  }));
  const cookieRoute = new HTTPClient({ adapter, baseURL: 'http://mock.test' });
  const withCookie = cookieRoute.get('/login');
  await withCookie.send();
  messages.push(String(withCookie.error?.cause?.message));

  // A redirect to an app's own scheme, its authorization code in the query; and one
  // whose Location is not a URL at all.
  for (const location of [
    `myapp://callback?code=${secret}`,
    `http://[${secret}`,
  ]) {
    const redirecting = new HTTPClient({
      adapter: {
        getType: () => 'node',
        send: () =>
          Promise.resolve({ status: 302, headers: { location }, body: null }),
      },
      baseURL: 'https://a.test',
      followRedirects: true,
    });
    const redirected = redirecting.get('/start');
    await redirected.send();
    messages.push(String(redirected.error?.cause?.message));
  }
  expect(messages.at(-2)).toContain('(got myapp:)');

  expect(messages).toHaveLength(12);
  for (const message of messages) {
    expect(message).not.toBe('undefined');
    expect(message).not.toContain(secret);
  }
});

test('CookieJar.clear() tells a blank host from an empty one', () => {
  const jar = new CookieJar();

  expect(() => jar.clear('', 'hostname')).toThrow(
    new TypeError(
      'CookieJar.clear() host must be a non-empty string (got an empty string)',
    ),
  );
  for (const host of ['   ', '\t\n']) {
    expect(() => jar.clear(host, 'domain')).toThrow(
      new TypeError(
        'CookieJar.clear() host must be a non-empty string (got a blank string)',
      ),
    );
  }
});

test('a refusal names the entry or the kind of value it refused', () => {
  const thrown = (run: () => unknown): string => {
    try {
      run();
    } catch (error) {
      return String((error as Error).message);
    }
    return 'nothing thrown';
  };
  const jar = new CookieJar();

  expect(thrown(() => jar.clear('', 'hostname'))).toBe(
    'CookieJar.clear() host must be a non-empty string (got an empty string)',
  );
  expect(thrown(() => jar.clear('a.test', 'Domain' as never))).toBe(
    "CookieJar.clear() scope must be 'hostname' or 'domain' (got an unknown scope)",
  );
  expect(
    thrown(() => new HTTPClient().listRequests({ scope: 'mine' as never })),
  ).toBe(
    "HTTPClient.listRequests() scope must be 'own' or 'all' (got an unknown scope)",
  );
  expect(
    thrown(
      () =>
        new CookieJar({
          publicSuffixes: {
            add: ['ok.test', 'a.shared.test'],
            remove: ['other.test', 'shared.test'],
          },
        }),
    ),
  ).toBe(
    'publicSuffixes.add[1] is, or is beneath, publicSuffixes.remove[1]; shared cookies conflict with tenant isolation',
  );
  expect(
    thrown(
      () => new CookieJar({ publicSuffixes: { add: ['ok.test', 5 as never] } }),
    ),
  ).toBe('publicSuffixes.add[1] must be a string (got number)');
  expect(
    thrown(
      () => new CookieJar({ publicSuffixes: { remove: ['ok.test', '.'] } }),
    ),
  ).toBe('publicSuffixes.remove[1] is empty');
  expect(
    thrown(() =>
      new HTTPClient().addRequestInterceptor((request) => request, {
        methods: ['GET', 'GET, POST'],
      }),
    ),
  ).toBe(
    'HTTPClient request interceptor filter methods[1] is not a valid HTTP method name (got a string with characters an HTTP token does not allow)',
  );
  expect(
    thrown(() =>
      new HTTPClient().addRequestInterceptor((request) => request, {
        hosts: ['a.test', 7 as never],
      }),
    ),
  ).toBe(
    'HTTPClient request interceptor filter hosts[1] must be a string (got number)',
  );
});

test('a MockAdapter route cookie name that cannot be written is named by its position', async () => {
  const adapter = new MockAdapter();
  adapter.routes.get('/login', () => ({
    status: 200,
    cookies: { theme: 'dark', 'session; Domain=other.test': 'x' },
  }));
  const builder = new HTTPClient({ adapter, baseURL: 'http://mock.test' }).get(
    '/login',
  );
  await builder.send();

  expect(builder.error?.cause?.message).toBe(
    'MockAdapter cookie name at position 1 cannot be written into a Set-Cookie line',
  );
});

test('a MockAdapter route that returns nothing is named by its registered pattern, not the request path', async () => {
  const adapter = new MockAdapter();
  adapter.routes.get(
    '/password-reset/:token',
    () => undefined as unknown as MockResponse,
  );
  const builder = new HTTPClient({
    adapter,
    baseURL: 'http://mock.test',
  }).get('/password-reset/abc123secret');
  await builder.send();

  const message = builder.error?.cause?.message ?? '';
  expect(message).toBe(
    'MockAdapter route for GET /password-reset/:token returned no MockResponse (got undefined)',
  );
  expect(message).not.toContain('abc123secret');
});

test('a MockAdapter cookie option whose value is not a string is refused by position, not written', async () => {
  const cases: Array<[unknown, string]> = [
    [undefined, 'undefined'],
    [{ nested: true }, 'object'],
    [7, 'number'],
  ];

  for (const [value, type] of cases) {
    const adapter = new MockAdapter();
    let calls = 0;
    adapter.routes.get('/login', () => {
      calls++;
      return {
        status: 200,
        cookies: {
          theme: 'dark',
          session: { value } as unknown as MockCookieOptions,
        },
      };
    });
    const builder = new HTTPClient({
      adapter,
      baseURL: 'http://mock.test',
      retryPolicy: { strategy: 'fixed', maxRetryAttempts: 2, delayMS: 1 },
    }).get('/login');
    await builder.send();

    expect(builder.error?.cause?.message).toBe(
      `MockAdapter cookie at position 1 value must be a string (got ${type})`,
    );
    // A route mistake: not retried, so the route ran once.
    expect(calls).toBe(1);
  }
});

test('a MockAdapter cookie value with a tab is set, as a raw set-cookie with one is', async () => {
  const jar = new CookieJar();
  const adapter = new MockAdapter();
  adapter.routes.get('/shorthand', () => ({
    status: 200,
    cookies: { a: 'x\ty', b: { value: 'p\tq' } },
  }));
  adapter.routes.get('/raw', () => ({
    status: 200,
    headers: { 'set-cookie': ['c=x\ty'] },
  }));
  const client = new HTTPClient({
    adapter,
    baseURL: 'http://mock.test',
    cookieJar: jar,
  });

  const shorthand = client.get('/shorthand');
  await shorthand.send();
  await client.get('/raw').send();

  expect(shorthand.error).toBeNull();
  expect(jar.getCookieHeaderString('http://mock.test/')).toBe(
    'a=x\ty; b=p\tq; c=x\ty',
  );
});

test('an onHandlerError that returns nothing is named by the route pattern, not the request path', async () => {
  const adapter = new MockAdapter({
    onHandlerError: () => undefined as unknown as MockResponse,
  });
  adapter.routes.get('/invite/:code', () => {
    throw new Error('route failed');
  });
  const builder = new HTTPClient({
    adapter,
    baseURL: 'http://mock.test',
  }).get('/invite/s3cr3t-code');
  await builder.send();

  const message = builder.error?.cause?.message ?? '';
  expect(message).toBe(
    'MockAdapter onHandlerError for GET /invite/:code returned no MockResponse (got undefined)',
  );
  expect(message).not.toContain('s3cr3t-code');
});

test('a MockAdapter cookie given as an array is refused as an array, not by a missing value', async () => {
  const adapter = new MockAdapter();
  adapter.routes.get('/login', () => ({
    status: 200,
    cookies: {
      theme: 'dark',
      session: ['v'] as unknown as MockCookieOptions,
    },
  }));
  const builder = new HTTPClient({
    adapter,
    baseURL: 'http://mock.test',
  }).get('/login');
  await builder.send();

  expect(builder.error?.cause?.message).toBe(
    'MockAdapter cookie at position 1 must be a string, null or a MockCookieOptions object (got an array)',
  );
});

test('a MockAdapter cookie field of the wrong type is refused by position and type, not coerced', async () => {
  const cases: Array<[unknown, string]> = [
    [
      42,
      'MockAdapter cookie at position 1 must be a string, null or a MockCookieOptions object (got number)',
    ],
    [
      { value: 42 },
      'MockAdapter cookie at position 1 value must be a string (got number)',
    ],
    [
      { value: 'v', path: null },
      'MockAdapter cookie at position 1 path must be a string (got null)',
    ],
    [
      { value: 'v', domain: 7 },
      'MockAdapter cookie at position 1 domain must be a string (got number)',
    ],
    [
      { value: 'v', httpOnly: 'false' },
      'MockAdapter cookie at position 1 httpOnly must be a boolean (got string)',
    ],
    [
      { value: 'v', secure: 1 },
      'MockAdapter cookie at position 1 secure must be a boolean (got number)',
    ],
    [
      { value: 'v', sameSite: 'lax' },
      "MockAdapter cookie at position 1 sameSite must be 'Strict', 'Lax' or 'None'",
    ],
    [
      { value: 'v', maxAge: '60' },
      'MockAdapter cookie at position 1 maxAge must be a number (got string)',
    ],
    [
      { value: 'v', maxAge: Number.NaN },
      'MockAdapter cookie at position 1 maxAge is NaN',
    ],
  ];

  for (const [entry, expected] of cases) {
    const adapter = new MockAdapter();
    let calls = 0;
    adapter.routes.get('/login', () => {
      calls++;
      return {
        status: 200,
        cookies: {
          theme: 'dark',
          session: entry as MockCookieOptions,
        },
      };
    });
    const builder = new HTTPClient({
      adapter,
      baseURL: 'http://mock.test',
      retryPolicy: { strategy: 'fixed', maxRetryAttempts: 2, delayMS: 1 },
    }).get('/login');
    await builder.send();

    expect(builder.error?.cause?.message).toBe(expected);
    expect(calls).toBe(1);
  }

  // A boolean flag, or none, is still accepted.
  const adapter = new MockAdapter();
  adapter.routes.get('/ok', () => ({
    status: 200,
    cookies: { s: { value: 'v', httpOnly: true, secure: false } },
  }));
  const ok = await new HTTPClient({ adapter, baseURL: 'http://mock.test' })
    .get('/ok')
    .send();
  expect(ok.headers['set-cookie']).toEqual(['s=v; Path=/; HttpOnly']);
});

test('each MockAdapter cookie option field is read once', async () => {
  const reads = new Map<string, number>();
  const options = {} as MockCookieOptions;
  const answers: Record<string, unknown> = {
    value: 'v',
    path: '/p',
    domain: 'mock.test',
    maxAge: 60,
    httpOnly: true,
    secure: false,
    sameSite: 'Lax',
  };
  for (const [field, answer] of Object.entries(answers)) {
    Object.defineProperty(options, field, {
      enumerable: true,
      get: () => {
        reads.set(field, (reads.get(field) ?? 0) + 1);
        return answer;
      },
    });
  }
  const adapter = new MockAdapter();
  adapter.routes.get('/c', () => ({ status: 200, cookies: { s: options } }));
  const response = await new HTTPClient({
    adapter,
    baseURL: 'http://mock.test',
  })
    .get('/c')
    .send();

  expect(response.headers['set-cookie']).toEqual([
    's=v; Path=/p; Max-Age=60; Domain=mock.test; HttpOnly; SameSite=Lax',
  ]);
  expect(Object.fromEntries(reads)).toEqual({
    value: 1,
    path: 1,
    domain: 1,
    maxAge: 1,
    httpOnly: 1,
    secure: 1,
    sameSite: 1,
  });
});

/**
 * A server pair for a cross-origin hop: `https://api.example/start` redirects to `target`,
 * whose first answer is a `503` and every later one a `200`. Records what each request to
 * a host other than `api.example` sent.
 */
function crossOriginRetryAdapter(target: string): {
  adapter: HTTPAdapter;
  sentToTarget: AdapterRequest[];
  sentToAPI: AdapterRequest[];
} {
  const sentToTarget: AdapterRequest[] = [];
  const sentToAPI: AdapterRequest[] = [];
  const adapter: HTTPAdapter = {
    getType: () => 'node',
    send: (request) => {
      if (new URL(request.requestURL).host === 'api.example') {
        sentToAPI.push(request);
        return Promise.resolve(
          request.requestURL.endsWith('/start')
            ? { status: 302, headers: { location: target }, body: null }
            : {
                status: sentToAPI.length === 2 ? 503 : 200,
                headers: {},
                body: null,
              },
        );
      }
      sentToTarget.push(request);
      return Promise.resolve({
        status: sentToTarget.length === 1 ? 503 : 200,
        headers: {},
        body: null,
      });
    },
  };
  return { adapter, sentToTarget, sentToAPI };
}

const crossOriginRetryPolicy = {
  strategy: 'fixed',
  maxRetryAttempts: 1,
  delayMS: 0,
} as const;

test('a retry interceptor does not send its credentials to a cross-origin redirect target', async () => {
  const { adapter, sentToTarget, sentToAPI } = crossOriginRetryAdapter(
    'https://evil.example/next',
  );
  const client = new HTTPClient({
    adapter,
    followRedirects: true,
    retryPolicy: crossOriginRetryPolicy,
  });
  // One that writes into the request it was handed and returns it. First, so it is
  // handed the request the chain began with.
  client.addRequestInterceptor(
    (request) => {
      (request.headers as Record<string, string>)['x-api-key'] = 'KEY';
      return request;
    },
    { phases: ['initial', 'retry'] },
  );
  // The documented token interceptor, with no `hosts` filter.
  client.addRequestInterceptor(
    (request) => ({
      ...request,
      headers: {
        ...request.headers,
        authorization: 'Bearer SECRET',
        cookie: 'session=1',
        accept: 'application/json',
      },
    }),
    { phases: ['initial', 'retry'] },
  );
  // And one that puts credentials into the URL.
  client.addRequestInterceptor(
    (request) => ({
      ...request,
      requestURL: request.requestURL.replace('://', '://user:pass@'),
    }),
    { phases: ['retry'] },
  );

  const response = await client.get('https://api.example/start').send();

  expect(response.status).toBe(200);
  expect(sentToAPI[0]?.headers.authorization).toBe('Bearer SECRET');
  expect(sentToAPI[0]?.headers['x-api-key']).toBe('KEY');
  expect(sentToTarget).toHaveLength(2);
  for (const sent of sentToTarget) {
    expect(sent.headers).not.toHaveProperty('authorization');
    expect(sent.headers).not.toHaveProperty('x-api-key');
    expect(sent.headers).not.toHaveProperty('cookie');
    expect(new URL(sent.requestURL).username).toBe('');
    expect(new URL(sent.requestURL).password).toBe('');
  }
  // A safelisted header the retry interceptor sets is still sent.
  expect(sentToTarget[1]?.headers.accept).toBe('application/json');
});

test("a parent client's retry interceptor does not send its credentials to a cross-origin redirect target", async () => {
  const { adapter, sentToTarget, sentToAPI } = crossOriginRetryAdapter(
    'https://evil.example/next',
  );
  const parent = new HTTPClient({
    adapter,
    followRedirects: true,
    retryPolicy: crossOriginRetryPolicy,
  });
  parent.addRequestInterceptor(
    (request) => ({
      ...request,
      headers: { ...request.headers, authorization: 'Bearer SECRET' },
    }),
    { phases: ['initial', 'retry'] },
  );
  const sub = parent.createSubClient({});
  sub.addRequestInterceptor(
    (request) => ({
      ...request,
      headers: { ...request.headers, 'x-sub': '1' },
    }),
    { phases: ['retry'] },
  );

  const response = await sub.get('https://api.example/start').send();

  expect(response.status).toBe(200);
  expect(sentToAPI[0]?.headers.authorization).toBe('Bearer SECRET');
  expect(sentToTarget).toHaveLength(2);
  for (const sent of sentToTarget) {
    expect(sent.headers).not.toHaveProperty('authorization');
    expect(sent.headers).not.toHaveProperty('x-sub');
  }
});

test('a credential a redirect interceptor gave a trusted target survives a retry there, and can be refreshed', async () => {
  const { adapter, sentToTarget } = crossOriginRetryAdapter(
    'https://trusted.example/next',
  );
  const client = new HTTPClient({
    adapter,
    followRedirects: true,
    retryPolicy: crossOriginRetryPolicy,
  });
  client.addRequestInterceptor(
    (request) => ({
      ...request,
      headers: { ...request.headers, 'x-trusted-token': 'T1' },
    }),
    { phases: ['redirect'], hosts: ['trusted.example'] },
  );
  client.addRequestInterceptor(
    (request) => ({
      ...request,
      headers: {
        ...request.headers,
        ...(request.headers['x-trusted-token'] !== undefined
          ? { 'x-trusted-token': 'T2' }
          : {}),
        'x-new': 'dropped',
      },
    }),
    { phases: ['retry'] },
  );

  const response = await client.get('https://api.example/start').send();

  expect(response.status).toBe(200);
  expect(sentToTarget.map((sent) => sent.headers['x-trusted-token'])).toEqual([
    'T1',
    'T2',
  ]);
  expect(sentToTarget[1]?.headers).not.toHaveProperty('x-new');
});

test("a retry interceptor's headers are sent on a same-origin redirect hop", async () => {
  const { adapter, sentToAPI } = crossOriginRetryAdapter(
    'https://api.example/next',
  );
  const client = new HTTPClient({
    adapter,
    followRedirects: true,
    retryPolicy: crossOriginRetryPolicy,
  });
  client.addRequestInterceptor(
    (request) => ({
      ...request,
      headers: {
        ...request.headers,
        authorization: 'Bearer SECRET',
        'x-api-key': 'KEY',
      },
    }),
    { phases: ['retry'] },
  );

  const response = await client.get('https://api.example/start').send();

  expect(response.status).toBe(200);
  // /start, /next (503), /next retried.
  expect(sentToAPI).toHaveLength(3);
  expect(sentToAPI[2]?.headers.authorization).toBe('Bearer SECRET');
  expect(sentToAPI[2]?.headers['x-api-key']).toBe('KEY');
});

test('a retry interceptor that names the host itself on a redirect hop sends its headers there', async () => {
  const { adapter, sentToTarget } = crossOriginRetryAdapter(
    'https://evil.example/next',
  );
  const client = new HTTPClient({
    adapter,
    followRedirects: true,
    retryPolicy: crossOriginRetryPolicy,
  });
  client.addRequestInterceptor(
    (request) => ({
      ...request,
      requestURL: 'https://failover.example/next',
      headers: { ...request.headers, authorization: 'Bearer FAILOVER' },
    }),
    { phases: ['retry'] },
  );

  await client.get('https://api.example/start').send();

  expect(sentToTarget.map((sent) => new URL(sent.requestURL).host)).toEqual([
    'evil.example',
    'failover.example',
  ]);
  expect(sentToTarget[0]?.headers).not.toHaveProperty('authorization');
  expect(sentToTarget[1]?.headers.authorization).toBe('Bearer FAILOVER');
});

/** An adapter whose `send()` never settles on its own and ignores its abort signal. */
function unresponsiveAdapter(): {
  adapter: HTTPAdapter;
  pending: Array<{
    resolve: (response: AdapterResponse) => void;
    reject: (error: unknown) => void;
  }>;
} {
  const pending: Array<{
    resolve: (response: AdapterResponse) => void;
    reject: (error: unknown) => void;
  }> = [];
  return {
    pending,
    adapter: {
      getType: () => 'node',
      send: () =>
        new Promise<AdapterResponse>((resolve, reject) => {
          pending.push({ resolve, reject });
        }),
    },
  };
}

test('an adapter that never settles is ended by the per-attempt timeout', async () => {
  const { adapter, pending } = unresponsiveAdapter();
  const ends: Array<{ status: number; willRetry: boolean }> = [];
  const builder = new HTTPClient({ adapter, baseURL: 'http://x.test' })
    .get('/hang')
    .timeout(50)
    .onAttemptEnd((event) => {
      ends.push({ status: event.status, willRetry: event.willRetry });
    });

  const response = await builder.send();

  expect(response.isTimeout).toBe(true);
  expect(response.isCancelled).toBe(false);
  expect(builder.error?.code).toBe('timeout');
  expect(ends).toEqual([{ status: 0, willRetry: false }]);
  expect(pending).toHaveLength(1);

  // A late answer or rejection is ignored, and the rejection is not left unhandled.
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', onUnhandled);
  try {
    pending[0]?.reject(new Error('late'));
    await sleep(20);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  expect(unhandled).toEqual([]);
  expect(response.isTimeout).toBe(true);
});

test('a timeout of an adapter that never settles is retried as a timeout', async () => {
  let sends = 0;
  const adapter: HTTPAdapter = {
    getType: () => 'node',
    send: () => {
      sends++;
      return sends === 1
        ? new Promise<AdapterResponse>(() => {})
        : Promise.resolve({ status: 200, headers: {}, body: null });
    },
  };
  const response = await new HTTPClient({
    adapter,
    baseURL: 'http://x.test',
    timeout: 50,
    retryPolicy: { strategy: 'fixed', maxRetryAttempts: 1, delayMS: 1 },
  })
    .get('/hang')
    .send();

  expect(sends).toBe(2);
  expect(response.status).toBe(200);
});

test('cancel() ends a request whose adapter never settles', async () => {
  const { adapter, pending } = unresponsiveAdapter();
  const builder = new HTTPClient({
    adapter,
    baseURL: 'http://x.test',
    timeout: 0,
  }).get('/hang');

  const sending = builder.send();
  await sleep(20);
  expect(builder.cancel('stop')).toBe('cancelled');
  const response = await sending;

  expect(response.isCancelled).toBe(true);
  expect(response.isTimeout).toBe(false);
  expect(builder.error?.code).toBe('cancelled');
  expect(builder.error?.cancelReason).toBe('stop');

  // A late answer changes nothing.
  pending[0]?.resolve({ status: 200, headers: {}, body: null });
  await sleep(10);
  expect(builder.state).toBe('cancelled');
});

test('a bare status 0 answered after the timer fired is a timeout, as an isTransportError one is', async () => {
  for (const isTransportError of [undefined, true]) {
    let sends = 0;
    const adapter: HTTPAdapter = {
      getType: () => 'node',
      send: (request) => {
        sends++;
        return new Promise((resolve) => {
          request.signal?.addEventListener('abort', () => {
            resolve({
              status: 0,
              headers: {},
              body: null,
              ...(isTransportError ? { isTransportError } : {}),
            });
          });
        });
      },
    };
    const builder = new HTTPClient({
      adapter,
      baseURL: 'http://x.test',
      timeout: 30,
      retryPolicy: { strategy: 'fixed', maxRetryAttempts: 1, delayMS: 1 },
    }).get('/a');
    const response = await builder.send();

    expect(sends).toBe(2);
    expect(response.isTimeout).toBe(true);
    expect(response.isNetworkError).toBe(false);
    expect(builder.error?.code).toBe('timeout');
  }
});

test('the hooks handed to an adapter the attempt gave up on do nothing, and its late upload outcome is observed', async () => {
  const handed: AdapterRequest[] = [];
  let resolveLate: ((response: AdapterResponse) => void) | undefined;
  const adapter: HTTPAdapter = {
    getType: () => 'node',
    send: (request) => {
      handed.push(request);
      return new Promise<AdapterResponse>((resolve) => {
        resolveLate = resolve;
      });
    },
  };
  const calls: string[] = [];
  const builder = new HTTPClient({ adapter, baseURL: 'http://x.test' })
    .put('/upload')
    .json({ a: 1 })
    .timeout(50)
    .onUploadProgress(() => calls.push('upload'))
    .onDownloadProgress(() => calls.push('download'))
    .streamResponse(() => {
      calls.push('factory');
      return null;
    });

  const response = await builder.send();
  expect(response.isTimeout).toBe(true);

  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', onUnhandled);
  try {
    const request = handed[0];
    const progress = { loaded: 1, total: 2, progress: 0.5 };
    request?.onUploadProgress?.(progress);
    request?.onDownloadProgress?.(progress);
    const sink = await request?.streamResponse?.(
      {
        status: 200,
        headers: {},
        url: request.requestURL,
        attempt: 1,
        requestID: builder.requestID,
      },
      { signal: new AbortController().signal },
    );
    expect(sink).toBeNull();

    resolveLate?.({
      status: 200,
      headers: {},
      body: null,
      requestBodySettled: Promise.reject(new Error('late upload')),
    });
    await sleep(20);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }

  expect(calls).toEqual([]);
  expect(unhandled).toEqual([]);
});

test("an abandoned adapter's upload progress does not hold the next attempt's settle wait open", async () => {
  let sends = 0;
  let ticker: ReturnType<typeof setInterval> | undefined;
  const adapter: HTTPAdapter = {
    getType: () => 'node',
    send: (request) => {
      sends++;
      if (sends === 1) {
        // Hung, and still reporting upload progress long after it was given up on.
        ticker = setInterval(() => {
          request.onUploadProgress?.({ loaded: 1, total: 2, progress: 0.5 });
        }, 5);
        return new Promise<AdapterResponse>(() => {});
      }
      // An early 503 whose upload never settles: the settle wait's stall bound ends it.
      return Promise.resolve({
        status: 503,
        headers: {},
        body: null,
        requestBodySettled: new Promise<Error | undefined>(() => {}),
      });
    },
  };
  const reports: Event[] = [];
  const onGlobalError = (event: Event): void => {
    reports.push(event);
    event.preventDefault();
  };
  globalThis.addEventListener('error', onGlobalError);
  try {
    const client = new HTTPClient({
      adapter,
      baseURL: 'http://x.test',
      timeout: 50,
      retryPolicy: { strategy: 'fixed', maxRetryAttempts: 2, delayMS: 1 },
    });
    // The abandoned attempt is bodiless - one with a body is not retried - and is handed
    // the progress hook because the caller asked for progress; the retry carries the
    // body whose settle wait is watched.
    client.addRequestInterceptor(
      (request) => ({ ...request, body: { a: 1 } }),
      { phases: ['retry'] },
    );
    const response = await client
      .put('/upload')
      .onUploadProgress(() => {})
      .send();

    expect(sends).toBe(2);
    expect(response.isTimeout).toBe(true);
    expect(reports).toHaveLength(1);
  } finally {
    clearInterval(ticker);
    globalThis.removeEventListener('error', onGlobalError);
  }
});

test('a status-0 stream error answered after the timer fired is not turned into a timeout', async () => {
  let sends = 0;
  const adapter: HTTPAdapter = {
    getType: () => 'node',
    send: (request) => {
      sends++;
      return new Promise((resolve) => {
        request.signal?.addEventListener('abort', () => {
          resolve({
            status: 0,
            headers: {},
            body: null,
            isStreamError: true,
            streamErrorCode: 'stream_response_error',
          });
        });
      });
    },
  };
  const builder = new HTTPClient({
    adapter,
    baseURL: 'http://x.test',
    timeout: 30,
    retryPolicy: { strategy: 'fixed', maxRetryAttempts: 1, delayMS: 1 },
  }).get('/a');
  const response = await builder.send();

  expect(sends).toBe(1);
  expect(response.isTimeout).toBe(false);
  expect(response.isStreamError).toBe(true);
  expect(builder.error?.code).toBe('stream_response_error');
});

test('a status-0 detected redirect answered after the timer fired is a timeout only where redirects are followed', async () => {
  for (const isFollowing of [true, false]) {
    let sends = 0;
    const adapter: HTTPAdapter = {
      getType: () => 'node',
      send: (request) => {
        sends++;
        return new Promise((resolve) => {
          request.signal?.addEventListener('abort', () => {
            resolve({
              status: 0,
              headers: {},
              body: null,
              wasRedirectDetected: true,
            });
          });
        });
      },
    };
    const builder = new HTTPClient({
      adapter,
      baseURL: 'http://x.test',
      timeout: 30,
      followRedirects: isFollowing,
      retryPolicy: { strategy: 'fixed', maxRetryAttempts: 1, delayMS: 1 },
    }).get('/a');
    const response = await builder.send();

    if (isFollowing) {
      expect(sends).toBe(2);
      expect(response.isTimeout).toBe(true);
      expect(builder.error?.code).toBe('timeout');
    } else {
      expect(sends).toBe(1);
      expect(response.isTimeout).toBe(false);
      expect(builder.error?.code).toBe('redirect_disabled');
    }
  }
});

test('a retry interceptor rewriting only the path or scheme of a cross-origin hop selects nothing', async () => {
  for (const rewrite of [
    (url: string) => url.replace('/next', '/other'),
    (url: string) => url.replace('https://', 'http://'),
  ]) {
    const { adapter, sentToTarget } = crossOriginRetryAdapter(
      'https://evil.example/next',
    );
    const client = new HTTPClient({
      adapter,
      followRedirects: true,
      retryPolicy: crossOriginRetryPolicy,
    });
    client.addRequestInterceptor(
      (request) => ({
        ...request,
        requestURL: rewrite(request.requestURL),
        headers: { ...request.headers, authorization: 'Bearer SECRET' },
      }),
      { phases: ['retry'] },
    );

    await client.get('https://api.example/start').send();

    expect(sentToTarget).toHaveLength(2);
    // The hop goes out as the server chose it: the rewrite is discarded with the header.
    expect(sentToTarget[1]?.requestURL).toBe('https://evil.example/next');
    expect(sentToTarget[1]?.headers).not.toHaveProperty('authorization');
  }
});

test("a retry interceptor's token reaches the caller's origin again after a hop away and back", async () => {
  const sent: AdapterRequest[] = [];
  let backAttempts = 0;
  const adapter: HTTPAdapter = {
    getType: () => 'node',
    send: (request) => {
      sent.push(request);
      const url = new URL(request.requestURL);
      if (url.pathname === '/start') {
        return Promise.resolve({
          status: 302,
          headers: { location: 'https://b.example/bounce' },
          body: null,
        });
      }
      if (url.host === 'b.example') {
        return Promise.resolve({
          status: 302,
          headers: { location: 'https://api.example/back' },
          body: null,
        });
      }
      backAttempts++;
      return Promise.resolve({
        status: backAttempts === 1 ? 503 : 200,
        headers: {},
        body: null,
      });
    },
  };
  const client = new HTTPClient({
    adapter,
    followRedirects: true,
    retryPolicy: crossOriginRetryPolicy,
  });
  client.addRequestInterceptor(
    (request) => ({
      ...request,
      headers: { ...request.headers, authorization: 'Bearer SECRET' },
    }),
    { phases: ['initial', 'retry'] },
  );

  const response = await client.get('https://api.example/start').send();

  expect(response.status).toBe(200);
  expect(sent.map((request) => new URL(request.requestURL).pathname)).toEqual([
    '/start',
    '/bounce',
    '/back',
    '/back',
  ]);
  expect(sent[1]?.headers).not.toHaveProperty('authorization');
  expect(sent[2]?.headers).not.toHaveProperty('authorization');
  expect(sent[3]?.headers.authorization).toBe('Bearer SECRET');
});

test('a host a retry interceptor chose does not carry its headers to a later redirect elsewhere', async () => {
  const sent: AdapterRequest[] = [];
  let failoverAttempts = 0;
  let thirdAttempts = 0;
  const adapter: HTTPAdapter = {
    getType: () => 'node',
    send: (request) => {
      sent.push(request);
      const host = new URL(request.requestURL).host;
      if (host === 'api.example') {
        return Promise.resolve({
          status: 302,
          headers: { location: 'https://evil.example/next' },
          body: null,
        });
      }
      if (host === 'evil.example') {
        return Promise.resolve({ status: 503, headers: {}, body: null });
      }
      if (host === 'failover.example') {
        failoverAttempts++;
        return Promise.resolve({
          status: 302,
          headers: { location: 'https://third.example/x' },
          body: null,
        });
      }
      thirdAttempts++;
      return Promise.resolve({
        status: thirdAttempts === 1 ? 503 : 200,
        headers: {},
        body: null,
      });
    },
  };
  const client = new HTTPClient({
    adapter,
    followRedirects: true,
    retryPolicy: { strategy: 'fixed', maxRetryAttempts: 2, delayMS: 0 },
  });
  client.addRequestInterceptor(
    (request) => ({
      ...request,
      requestURL: request.requestURL.startsWith('https://evil.example')
        ? 'https://failover.example/next'
        : request.requestURL,
      headers: { ...request.headers, authorization: 'Bearer SECRET' },
    }),
    { phases: ['retry'] },
  );

  const response = await client.get('https://api.example/start').send();

  expect(response.status).toBe(200);
  expect(failoverAttempts).toBe(1);
  expect(sent.map((request) => new URL(request.requestURL).host)).toEqual([
    'api.example',
    'evil.example',
    'failover.example',
    'third.example',
    'third.example',
  ]);
  expect(sent[2]?.headers.authorization).toBe('Bearer SECRET');
  expect(sent[4]?.headers).not.toHaveProperty('authorization');
});

test('an adapter that honors its signal is not held by the abort grace', async () => {
  const adapter = new MockAdapter();
  adapter.routes.get('/slow', async () => {
    await sleep(5_000);
    return { status: 200 };
  });
  const client = new HTTPClient({ adapter, baseURL: 'http://mock.test' });

  let startedAt = performance.now();
  const timedOut = await client.get('/slow').timeout(50).send();
  expect(timedOut.isTimeout).toBe(true);
  expect(performance.now() - startedAt).toBeLessThan(150);

  startedAt = performance.now();
  const builder = client.get('/slow').timeout(0);
  const sending = builder.send();
  await sleep(20);
  builder.cancel('stop');
  const cancelled = await sending;
  expect(cancelled.isCancelled).toBe(true);
  expect(performance.now() - startedAt).toBeLessThan(120);
});

/**
 * A `307` from `api.example` to `target`, whose first answer there is a `503` and whose
 * second is a `200`. Records every request sent to the target.
 */
function crossOriginReplayAdapter(target: string): {
  adapter: HTTPAdapter;
  sentToTarget: AdapterRequest[];
} {
  const sentToTarget: AdapterRequest[] = [];
  const targetURL = new URL(target);
  const adapter: HTTPAdapter = {
    getType: () => 'node',
    send: (request) => {
      const url = new URL(request.requestURL);
      if (url.host === 'api.example' && url.pathname === '/start') {
        return Promise.resolve({
          status: 307,
          headers: { location: target },
          body: null,
        });
      }
      if (url.host === targetURL.host) {
        sentToTarget.push(request);
      }
      return Promise.resolve({
        status: sentToTarget.length === 1 ? 503 : 200,
        headers: {},
        body: null,
      });
    },
  };
  return { adapter, sentToTarget };
}

test('a retry interceptor does not send a query-string credential to a cross-origin redirect target', async () => {
  const { adapter: replay, sentToTarget } = crossOriginReplayAdapter(
    'https://evil.example/next?hop=1',
  );
  const sent: AdapterRequest[] = [];
  const client = new HTTPClient({
    adapter: {
      getType: () => 'node',
      send: (request) => {
        sent.push(request);
        return replay.send(request);
      },
    },
    followRedirects: true,
    retryPolicy: crossOriginRetryPolicy,
  });
  client.addRequestInterceptor(
    (request) => {
      const url = new URL(request.requestURL);
      url.searchParams.set('access_token', 'SECRET');
      url.username = 'user';
      url.password = 'pass';
      url.hash = 'SECRET';
      return { ...request, requestURL: url.href };
    },
    { phases: ['initial', 'retry'] },
  );

  const response = await client.get('https://api.example/start').send();

  expect(response.status).toBe(200);
  // The caller's own origin gets it.
  expect(
    new URL(sent[0]?.requestURL ?? '').searchParams.get('access_token'),
  ).toBe('SECRET');
  // The hop goes out with its own URL, its own query included.
  expect(sentToTarget.map((sent) => sent.requestURL)).toEqual([
    'https://evil.example/next?hop=1',
    'https://evil.example/next?hop=1',
  ]);
});

test('a retry interceptor does not add a body field to a 307 replay on a cross-origin redirect target', async () => {
  const { adapter, sentToTarget } = crossOriginReplayAdapter(
    'https://evil.example/next',
  );
  const client = new HTTPClient({
    adapter,
    followRedirects: true,
    retryPolicy: crossOriginRetryPolicy,
  });
  client.addRequestInterceptor(
    (request) => ({
      ...request,
      headers: { ...request.headers, 'content-type': 'text/plain' },
      body: { ...(request.body as object), token: 'SECRET' },
    }),
    { phases: ['retry'] },
  );

  const response = await client
    .put('https://api.example/start')
    .json({ a: 1 })
    .send();

  expect(response.status).toBe(200);
  expect(sentToTarget).toHaveLength(2);
  // The hop's own body, with the headers that describe it.
  expect(sentToTarget[0]?.body).toBe(JSON.stringify({ a: 1 }));
  expect(sentToTarget[1]?.body).toBe(JSON.stringify({ a: 1 }));
  expect(sentToTarget[1]?.headers['content-type']).toBe(
    sentToTarget[0]?.headers['content-type'],
  );
});

test('a retry interceptor may still drop the body of a cross-origin 307 replay', async () => {
  const { adapter, sentToTarget } = crossOriginReplayAdapter(
    'https://evil.example/next',
  );
  const client = new HTTPClient({
    adapter,
    followRedirects: true,
    retryPolicy: crossOriginRetryPolicy,
  });
  client.addRequestInterceptor((request) => ({ ...request, body: undefined }), {
    phases: ['retry'],
  });

  await client.put('https://api.example/start').json({ a: 1 }).send();

  expect(sentToTarget).toHaveLength(2);
  expect(sentToTarget[0]?.body).toBe(JSON.stringify({ a: 1 }));
  expect(sentToTarget[1]?.body).toBeNull();
});

test('a retry interceptor that names the host itself on a redirect hop controls its URL and body there', async () => {
  const sentToFailover: AdapterRequest[] = [];
  const { adapter: replay, sentToTarget } = crossOriginReplayAdapter(
    'https://evil.example/next',
  );
  const adapter: HTTPAdapter = {
    getType: () => 'node',
    send: (request) => {
      if (new URL(request.requestURL).host === 'failover.example') {
        sentToFailover.push(request);
        return Promise.resolve({ status: 200, headers: {}, body: null });
      }
      return replay.send(request);
    },
  };
  const client = new HTTPClient({
    adapter,
    followRedirects: true,
    retryPolicy: crossOriginRetryPolicy,
  });
  client.addRequestInterceptor(
    (request) => ({
      ...request,
      requestURL: 'https://failover.example/next?access_token=FAILOVER',
      body: { ...(request.body as object), token: 'FAILOVER' },
    }),
    { phases: ['retry'] },
  );

  const response = await client
    .put('https://api.example/start')
    .json({ a: 1 })
    .send();

  expect(response.status).toBe(200);
  expect(sentToTarget).toHaveLength(1);
  expect(sentToFailover).toHaveLength(1);
  expect(sentToFailover[0]?.requestURL).toBe(
    'https://failover.example/next?access_token=FAILOVER',
  );
  expect(sentToFailover[0]?.body).toBe(
    JSON.stringify({ a: 1, token: 'FAILOVER' }),
  );
});

test("a retry interceptor's URL and body changes are sent on a same-origin redirect hop", async () => {
  const { adapter, sentToTarget } = crossOriginReplayAdapter(
    'https://api.example/next',
  );
  const client = new HTTPClient({
    adapter,
    followRedirects: true,
    retryPolicy: crossOriginRetryPolicy,
  });
  client.addRequestInterceptor(
    (request) => {
      const url = new URL(request.requestURL);
      url.searchParams.set('access_token', 'SECRET');
      return {
        ...request,
        requestURL: url.href,
        body: { ...(request.body as object), token: 'SECRET' },
      };
    },
    { phases: ['retry'] },
  );

  const response = await client
    .put('https://api.example/start')
    .json({ a: 1 })
    .send();

  expect(response.status).toBe(200);
  expect(sentToTarget).toHaveLength(2);
  expect(sentToTarget[1]?.requestURL).toBe(
    'https://api.example/next?access_token=SECRET',
  );
  expect(sentToTarget[1]?.body).toBe(JSON.stringify({ a: 1, token: 'SECRET' }));
});

test('an attempt abandoned after its stream factory was called is a stream error, not a retried timeout', async () => {
  for (const isAsyncFactory of [false, true]) {
    let sends = 0;
    const adapter: HTTPAdapter = {
      getType: () => 'node',
      send: async (request) => {
        sends++;
        // Headers arrive and the factory is called; then the adapter ignores its abort.
        await request.streamResponse?.(
          {
            status: 200,
            headers: {},
            url: request.requestURL,
            attempt: request.attemptNumber ?? 1,
            requestID: request.requestID ?? '',
          },
          { signal: new AbortController().signal },
        );
        return new Promise<AdapterResponse>(() => {});
      },
    };
    const sinks: PassThrough[] = [];
    const ends: Array<{ willRetry: boolean; status: number }> = [];
    const builder = new HTTPClient({
      adapter,
      baseURL: 'http://x.test',
      timeout: 50,
      retryPolicy: { strategy: 'fixed', maxRetryAttempts: 1, delayMS: 1 },
    })
      .get('/file')
      .streamResponse(() => {
        const sink = new PassThrough();
        sinks.push(sink);
        return isAsyncFactory ? Promise.resolve(sink) : sink;
      })
      .onAttemptEnd((event) => {
        ends.push({ willRetry: event.willRetry, status: event.status });
      });

    const response = await builder.send();

    expect(sends).toBe(1);
    expect(sinks).toHaveLength(1);
    expect(ends).toEqual([{ willRetry: false, status: 200 }]);
    expect(response.status).toBe(200);
    expect(response.isStreamError).toBe(true);
    expect(response.isTimeout).toBe(true);
    expect(response.isFailed).toBe(true);
    expect(builder.error?.code).toBe('stream_response_error');
    // The sink the adapter left behind is torn down.
    expect(sinks[0]?.destroyed).toBe(true);
  }
});

test("a 307 hop whose bodied attempt is abandoned reports its upload's outcome unknown, not the previous hop one", async () => {
  let sends = 0;
  const adapter: HTTPAdapter = {
    getType: () => 'node',
    send: () => {
      sends++;
      return sends === 1
        ? Promise.resolve({
            status: 307,
            headers: { location: '/b' },
            body: null,
            requestBodySettled: Promise.resolve(undefined),
          })
        : new Promise<AdapterResponse>(() => {});
    },
  };
  const response = await new HTTPClient({
    adapter,
    baseURL: 'http://x.test',
    timeout: 50,
    followRedirects: true,
  })
    .put('/a')
    .json({ a: 1 })
    .send();

  expect(sends).toBe(2);
  expect(response.isTimeout).toBe(true);
  const outcome = await response.requestBodySettled;
  expect(outcome).toBeInstanceOf(Error);
  expect(outcome?.message).toContain('unknown');
});

test("a retry whose bodied attempt is abandoned reports its upload's outcome unknown, not the previous attempt one", async () => {
  let sends = 0;
  const adapter: HTTPAdapter = {
    getType: () => 'node',
    send: () => {
      sends++;
      return sends === 1
        ? Promise.resolve({
            status: 503,
            headers: {},
            body: null,
            requestBodySettled: Promise.resolve(new Error('cut')),
          })
        : new Promise<AdapterResponse>(() => {});
    },
  };
  const response = await new HTTPClient({
    adapter,
    baseURL: 'http://x.test',
    timeout: 50,
    retryPolicy: { strategy: 'fixed', maxRetryAttempts: 1, delayMS: 1 },
  })
    .put('/a')
    .json({ a: 1 })
    .send();

  expect(sends).toBe(2);
  expect(response.isTimeout).toBe(true);
  const outcome = await response.requestBodySettled;
  expect(outcome).toBeInstanceOf(Error);
  expect(outcome?.message).toContain('unknown');
});

test('a retry interceptor that drops the body leaves the upload outcome of the attempt that had one', async () => {
  const sent: AdapterRequest[] = [];
  const cut = new Error('cut');
  const adapter: HTTPAdapter = {
    getType: () => 'node',
    send: (request) => {
      sent.push(request);
      return Promise.resolve(
        sent.length === 1
          ? {
              status: 503,
              headers: {},
              body: null,
              requestBodySettled: Promise.resolve(cut),
            }
          : { status: 200, headers: {}, body: null },
      );
    },
  };
  const client = new HTTPClient({
    adapter,
    baseURL: 'http://x.test',
    retryPolicy: { strategy: 'fixed', maxRetryAttempts: 1, delayMS: 1 },
  });
  client.addRequestInterceptor((request) => ({ ...request, body: undefined }), {
    phases: ['retry'],
  });

  const response = await client.put('/a').json({ a: 1 }).send();

  expect(sent).toHaveLength(2);
  expect(sent[1]?.body).toBeNull();
  expect(response.status).toBe(200);
  const outcome = await response.requestBodySettled;
  expect(outcome?.message).toBe('cut');
});

test("a transport failure answered after the timer fired stores its Set-Cookie; an abandoned attempt's late answer does not", async () => {
  // Answered late, within the abort grace.
  const lateJar = new CookieJar();
  const late = await new HTTPClient({
    adapter: {
      getType: () => 'node',
      send: async () => {
        await sleep(80);
        return {
          status: 502,
          isTransportError: true,
          headers: { 'set-cookie': 'sid=late; Path=/' },
          body: null,
        };
      },
    },
    baseURL: 'http://x.test',
    cookieJar: lateJar,
    timeout: 30,
  })
    .get('/a')
    .send();

  expect(late.isTimeout).toBe(true);
  expect(lateJar.getCookieHeaderString('http://x.test/a')).toBe('sid=late');

  // Answered only after the attempt gave up on the adapter.
  const { adapter, pending } = unresponsiveAdapter();
  const abandonedJar = new CookieJar();
  const abandoned = await new HTTPClient({
    adapter,
    baseURL: 'http://x.test',
    cookieJar: abandonedJar,
    timeout: 30,
  })
    .get('/a')
    .send();

  expect(abandoned.isTimeout).toBe(true);
  pending[0]?.resolve({
    status: 200,
    headers: { 'set-cookie': 'sid=abandoned; Path=/' },
    body: null,
  });
  await sleep(10);
  expect(abandonedJar.getCookieHeaderString('http://x.test/a')).toBe('');
});

test('a retry interceptor that edits the body in place on a cross-origin hop changes neither what is sent there nor the caller body', async () => {
  const json = { a: 1 };
  const form = new FormData();
  form.append('a', '1');
  const bytes = new Uint8Array([1, 2, 3]);
  const cases: Array<{
    body: unknown;
    send: (client: HTTPClient) => Promise<unknown>;
    edit: (body: unknown) => void;
    read: (sent: unknown) => unknown;
    expected: unknown;
  }> = [
    {
      body: json,
      send: (client) =>
        client.put('https://api.example/start').json(json).send(),
      edit: (body) => {
        (body as Record<string, unknown>).token = 'SECRET';
      },
      read: (sent) => sent,
      expected: JSON.stringify({ a: 1 }),
    },
    {
      body: form,
      send: (client) =>
        client.put('https://api.example/start').body(form).send(),
      edit: (body) => {
        (body as FormData).append('token', 'SECRET');
      },
      read: (sent) => [...(sent as FormData).entries()],
      expected: [['a', '1']],
    },
    {
      body: bytes,
      send: (client) =>
        client.put('https://api.example/start').body(bytes).send(),
      edit: (body) => {
        (body as Uint8Array).fill(9);
      },
      read: (sent) => [...(sent as Uint8Array)],
      expected: [1, 2, 3],
    },
  ];

  for (const { send, edit, read, expected } of cases) {
    const { adapter, sentToTarget } = crossOriginReplayAdapter(
      'https://evil.example/next',
    );
    const client = new HTTPClient({
      adapter,
      followRedirects: true,
      retryPolicy: crossOriginRetryPolicy,
    });
    client.addRequestInterceptor(
      (request) => {
        edit(request.body);
        return request;
      },
      { phases: ['retry'] },
    );

    await send(client);

    expect(sentToTarget).toHaveLength(2);
    expect(read(sentToTarget[0]?.body)).toEqual(expected);
    expect(read(sentToTarget[1]?.body)).toEqual(expected);
  }

  // The caller's own values are untouched.
  expect(json).toEqual({ a: 1 });
  expect([...form.entries()]).toEqual([['a', '1']]);
  expect([...bytes]).toEqual([1, 2, 3]);
});

test('a retry interceptor that edits the body in place and names the host itself sends its edit there, not to the caller body', async () => {
  const sentToFailover: AdapterRequest[] = [];
  const { adapter: replay } = crossOriginReplayAdapter(
    'https://evil.example/next',
  );
  const client = new HTTPClient({
    adapter: {
      getType: () => 'node',
      send: (request) => {
        if (new URL(request.requestURL).host === 'failover.example') {
          sentToFailover.push(request);
          return Promise.resolve({ status: 200, headers: {}, body: null });
        }
        return replay.send(request);
      },
    },
    followRedirects: true,
    retryPolicy: crossOriginRetryPolicy,
  });
  client.addRequestInterceptor(
    (request) => {
      (request.body as Record<string, unknown>).token = 'FAILOVER';
      return { ...request, requestURL: 'https://failover.example/next' };
    },
    { phases: ['retry'] },
  );
  const json = { a: 1 };

  await client.put('https://api.example/start').json(json).send();

  expect(sentToFailover[0]?.body).toBe(
    JSON.stringify({ a: 1, token: 'FAILOVER' }),
  );
  expect(json).toEqual({ a: 1 });
});

test('a body a retry interceptor replaces on a cross-origin hop is restored with all the headers that describe it', async () => {
  const { adapter, sentToTarget } = crossOriginReplayAdapter(
    'https://evil.example/next',
  );
  const client = new HTTPClient({
    adapter,
    followRedirects: true,
    retryPolicy: crossOriginRetryPolicy,
  });
  client.addRequestInterceptor(
    (request) => ({
      ...request,
      headers: {
        ...request.headers,
        'content-encoding': 'gzip',
        'content-language': 'fr',
        'content-type': 'application/octet-stream',
      },
      body: new Uint8Array([1, 2, 3]),
    }),
    { phases: ['retry'] },
  );

  await client.put('https://api.example/start').json({ a: 1 }).send();

  expect(sentToTarget).toHaveLength(2);
  expect(sentToTarget[1]?.body).toBe(JSON.stringify({ a: 1 }));
  expect(sentToTarget[1]?.headers['content-type']).toBe(
    sentToTarget[0]?.headers['content-type'],
  );
  expect(sentToTarget[1]?.headers).not.toHaveProperty('content-encoding');
  expect(sentToTarget[1]?.headers).not.toHaveProperty('content-language');
});

test('an empty body a retry interceptor sets on a cross-origin hop drops the body rather than replacing it', async () => {
  for (const empty of ['', new Uint8Array(0)]) {
    const { adapter, sentToTarget } = crossOriginReplayAdapter(
      'https://evil.example/next',
    );
    const client = new HTTPClient({
      adapter,
      followRedirects: true,
      retryPolicy: crossOriginRetryPolicy,
    });
    client.addRequestInterceptor((request) => ({ ...request, body: empty }), {
      phases: ['retry'],
    });

    await client.put('https://api.example/start').json({ a: 1 }).send();

    expect(sentToTarget).toHaveLength(2);
    const sent = sentToTarget[1]?.body;
    expect(
      typeof sent === 'string' ? sent.length : (sent as Uint8Array).byteLength,
    ).toBe(0);
  }
});

test('a safelisted header a retry interceptor adds on a cross-origin hop is kept', async () => {
  const { adapter, sentToTarget } = crossOriginReplayAdapter(
    'https://evil.example/next',
  );
  const client = new HTTPClient({
    adapter,
    followRedirects: true,
    retryPolicy: crossOriginRetryPolicy,
  });
  client.addRequestInterceptor(
    (request) => ({
      ...request,
      headers: {
        ...request.headers,
        'accept-language': 'fr',
        authorization: 'Bearer SECRET',
      },
    }),
    { phases: ['retry'] },
  );

  await client.put('https://api.example/start').json({ a: 1 }).send();

  expect(sentToTarget).toHaveLength(2);
  expect(sentToTarget[1]?.headers['accept-language']).toBe('fr');
  expect(sentToTarget[1]?.headers).not.toHaveProperty('authorization');
});

/**
 * An adapter that calls the stream factory once headers "arrive", then ignores its abort
 * and never settles.
 */
function factoryThenHangAdapter(): {
  adapter: HTTPAdapter;
  sends: () => number;
} {
  let sends = 0;
  return {
    sends: () => sends,
    adapter: {
      getType: () => 'node',
      send: (request) => {
        sends++;
        void request.streamResponse?.(
          {
            status: 200,
            headers: {},
            url: request.requestURL,
            attempt: request.attemptNumber ?? 1,
            requestID: request.requestID ?? '',
          },
          { signal: new AbortController().signal },
        );
        return new Promise<AdapterResponse>(() => {});
      },
    },
  };
}

test('a sink an async factory hands over after its attempt was abandoned is destroyed when it arrives', async () => {
  const { adapter, sends } = factoryThenHangAdapter();
  let sink: PassThrough | undefined;
  let release: (() => void) | undefined;
  const builder = new HTTPClient({
    adapter,
    baseURL: 'http://x.test',
    timeout: 30,
  })
    .get('/file')
    .streamResponse(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      sink = new PassThrough();
      return sink;
    });

  const response = await builder.send();

  // Still on its way when the attempt was given up on, so not retried.
  expect(sends()).toBe(1);
  expect(builder.error?.code).toBe('stream_response_error');
  expect(response.isTimeout).toBe(true);

  release?.();
  await sleep(10);
  expect(sink?.destroyed).toBe(true);
});

test('a cancel during the abort grace destroys the sink the adapter that ignored it was writing to', async () => {
  const { adapter } = factoryThenHangAdapter();
  const sink = new PassThrough();
  const builder = new HTTPClient({ adapter, baseURL: 'http://x.test' })
    .get('/file')
    .timeout(0)
    .streamResponse(() => sink);
  const sending = builder.send();
  await sleep(20);
  builder.cancel('stop');

  const response = await sending;

  expect(response.isCancelled).toBe(true);
  expect(sink.destroyed).toBe(true);
});

test('a factory that answered null or a thenable the client does not follow decides whether an abandoned attempt is retried', async () => {
  // None started: the abandoned attempt is the timeout it is, and retried.
  const declined = factoryThenHangAdapter();
  const declinedBuilder = new HTTPClient({
    adapter: declined.adapter,
    baseURL: 'http://x.test',
    timeout: 30,
    retryPolicy: { strategy: 'fixed', maxRetryAttempts: 1, delayMS: 1 },
  })
    .get('/file')
    .streamResponse(() => null);
  await declinedBuilder.send();
  expect(declined.sends()).toBe(2);
  expect(declinedBuilder.error?.code).toBe('timeout');

  // A thenable's sink is unknown: counted as started, and left alone.
  const thenable = factoryThenHangAdapter();
  const sink = new PassThrough();
  const thenableBuilder = new HTTPClient({
    adapter: thenable.adapter,
    baseURL: 'http://x.test',
    timeout: 30,
    retryPolicy: { strategy: 'fixed', maxRetryAttempts: 1, delayMS: 1 },
  })
    .get('/file')
    .streamResponse(
      () =>
        ({
          then: (resolve: (value: PassThrough) => void) => {
            resolve(sink);
          },
        }) as unknown as PassThrough,
    );
  await thenableBuilder.send();
  expect(thenable.sends()).toBe(1);
  expect(thenableBuilder.error?.code).toBe('stream_response_error');
  expect(sink.destroyed).toBe(false);
});

test('a cookie jar that throws on a transport failure answered after the timer fired leaves it the retried timeout', async () => {
  const jar = new CookieJar();
  jar.processResponseHeaders = () => {
    throw new Error('jar failed');
  };
  let sends = 0;
  const builder = new HTTPClient({
    adapter: {
      getType: () => 'node',
      send: async () => {
        sends++;
        await sleep(80);
        return {
          status: 502,
          isTransportError: true,
          headers: { 'set-cookie': 'a=b' },
          body: null,
        };
      },
    },
    baseURL: 'http://x.test',
    cookieJar: jar,
    timeout: 30,
    retryPolicy: { strategy: 'fixed', maxRetryAttempts: 1, delayMS: 1 },
  }).get('/a');

  const response = await builder.send();

  expect(sends).toBe(2);
  expect(response.isTimeout).toBe(true);
  expect(builder.error?.code).toBe('timeout');
});

test("a JSON body whose top-level toJSON answers a non-object is sent unchanged on a cross-origin hop's retry", async () => {
  for (const answer of [null, '', 42, 'hello']) {
    for (const isChoosingHost of [false, true]) {
      const sent: AdapterRequest[] = [];
      const { adapter: replay } = crossOriginReplayAdapter(
        'https://evil.example/next',
      );
      const client = new HTTPClient({
        adapter: {
          getType: () => 'node',
          send: (request) => {
            sent.push(request);
            return new URL(request.requestURL).host === 'failover.example'
              ? Promise.resolve({ status: 200, headers: {}, body: null })
              : replay.send(request);
          },
        },
        followRedirects: true,
        retryPolicy: crossOriginRetryPolicy,
      });
      client.addRequestInterceptor(
        (request) =>
          isChoosingHost
            ? { ...request, requestURL: 'https://failover.example/next' }
            : request,
        { phases: ['retry'] },
      );

      const builder = client
        .put('https://api.example/start')
        .json({ toJSON: () => answer });
      const response = await builder.send();

      expect(builder.error).toBeNull();
      expect(response.status).toBe(200);
      expect(sent).toHaveLength(3);
      for (const request of sent) {
        expect(request.body).toBe(JSON.stringify(answer));
        expect(request.headers['content-type']).toBe(
          sent[0]?.headers['content-type'],
        );
      }
    }
  }
});

test('a rejection from an async destroy of an abandoned sink is contained', async () => {
  const { adapter } = factoryThenHangAdapter();
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', onUnhandled);
  try {
    let destroys = 0;
    const builder = new HTTPClient({
      adapter,
      baseURL: 'http://x.test',
      timeout: 30,
    })
      .get('/file')
      .streamResponse(() => {
        const sink = new PassThrough();
        sink.destroy = (() => {
          destroys++;
          return Promise.reject(new Error('async destroy failed'));
        }) as unknown as PassThrough['destroy'];
        return sink;
      });

    await builder.send();
    await sleep(20);

    expect(destroys).toBe(1);
    expect(builder.error?.code).toBe('stream_response_error');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  expect(unhandled).toEqual([]);
});

test("a cross-origin hop's own body goes out with its own body headers, whatever a retry interceptor did to them", async () => {
  const { adapter, sentToTarget } = crossOriginReplayAdapter(
    'https://evil.example/next',
  );
  const client = new HTTPClient({
    adapter,
    followRedirects: true,
    retryPolicy: crossOriginRetryPolicy,
  });
  client.addRequestInterceptor(
    (request) => {
      (request.body as Record<string, unknown>).token = 'SECRET';
      return {
        ...request,
        headers: {
          ...request.headers,
          'content-type': 'text/plain',
          'content-language': 'fr',
        },
      };
    },
    { phases: ['retry'] },
  );

  await client.put('https://api.example/start').json({ a: 1 }).send();

  expect(sentToTarget).toHaveLength(2);
  expect(sentToTarget[1]?.body).toBe(JSON.stringify({ a: 1 }));
  expect(sentToTarget[1]?.headers['content-type']).toBe(
    sentToTarget[0]?.headers['content-type'],
  );
  expect(sentToTarget[1]?.headers).not.toHaveProperty('content-language');
});

test("a retry interceptor's body that cannot be copied, on a cross-origin hop held to its own body, sends the hop's own", async () => {
  const { adapter, sentToTarget } = crossOriginReplayAdapter(
    'https://evil.example/next',
  );
  const client = new HTTPClient({
    adapter,
    followRedirects: true,
    retryPolicy: crossOriginRetryPolicy,
  });
  // The caller's body is copied as it is handed over, so the body that cannot be copied
  // is one a retry interceptor returns. The hop is held to its own body, so that one is
  // never sent, and is not copied either.
  client.addRequestInterceptor(
    (request) => ({
      ...request,
      body: {
        toJSON: () => {
          throw new Error('not copyable');
        },
      },
    }),
    { phases: ['retry'] },
  );
  let reads = 0;
  const builder = client.put('https://api.example/start').json({
    toJSON: () => {
      reads++;
      return { a: 1 };
    },
  });

  const response = await builder.send();

  expect(reads).toBe(1);
  expect(response.status).toBe(200);
  expect(builder.error).toBeNull();
  expect(sentToTarget.map((request) => request.body)).toEqual([
    JSON.stringify({ a: 1 }),
    JSON.stringify({ a: 1 }),
  ]);
});

test("a retry interceptor's BigInt body on a cross-origin hop held to its own body sends the hop's own", async () => {
  const { adapter, sentToTarget } = crossOriginReplayAdapter(
    'https://evil.example/next',
  );
  const client = new HTTPClient({
    adapter,
    followRedirects: true,
    retryPolicy: crossOriginRetryPolicy,
  });
  client.addRequestInterceptor((request) => ({ ...request, body: { n: 1n } }), {
    phases: ['retry'],
  });
  const builder = client.put('https://api.example/start').json({ a: 1 });

  const response = await builder.send();

  expect(response.status).toBe(200);
  expect(builder.error).toBeNull();
  expect(builder.attemptCount).toBe(3);
  expect(sentToTarget.map((request) => request.body)).toEqual([
    JSON.stringify({ a: 1 }),
    JSON.stringify({ a: 1 }),
  ]);
});

test("a parent client's and a sub-client's retry interceptors share one copy of a cross-origin hop's body", async () => {
  const { adapter, sentToTarget } = crossOriginReplayAdapter(
    'https://evil.example/next',
  );
  const parent = new HTTPClient({
    adapter,
    followRedirects: true,
    retryPolicy: crossOriginRetryPolicy,
  });
  const seen: unknown[] = [];
  parent.addRequestInterceptor(
    (request) => {
      (request.body as Record<string, unknown>).p = 'P';
      return request;
    },
    { phases: ['retry'] },
  );
  const sub = parent.createSubClient();
  sub.addRequestInterceptor(
    (request) => {
      seen.push(structuredClone(request.body));
      (request.body as Record<string, unknown>).s = 'S';
      return request;
    },
    { phases: ['retry'] },
  );
  const json = { a: 1 };

  await sub.put('https://api.example/start').json(json).send();

  // The sub-client's interceptor saw the parent's edit to the one copy.
  expect(seen).toEqual([{ a: 1, p: 'P' }]);
  expect(sentToTarget.map((request) => request.body)).toEqual([
    JSON.stringify({ a: 1 }),
    JSON.stringify({ a: 1 }),
  ]);
  expect(json).toEqual({ a: 1 });
});

test('a factory that answered a cancel leaves an abandoned attempt the timeout it is, retried', async () => {
  const { adapter, sends } = factoryThenHangAdapter();
  const builder = new HTTPClient({
    adapter,
    baseURL: 'http://x.test',
    timeout: 30,
    retryPolicy: { strategy: 'fixed', maxRetryAttempts: 1, delayMS: 1 },
  })
    .get('/file')
    .streamResponse(() => ({ cancel: true }));

  await builder.send();

  expect(sends()).toBe(2);
  expect(builder.error?.code).toBe('timeout');
});

test('a retry interceptor may upgrade a cross-origin http hop to https, and nothing else of its URL', async () => {
  const cases: Array<{
    target: string;
    rewrite: (url: URL) => void;
    expected: string;
  }> = [
    // The upgrade alone, with the default ports.
    {
      target: 'http://evil.example/next?hop=1',
      rewrite: (url) => {
        url.protocol = 'https:';
      },
      expected: 'https://evil.example/next?hop=1',
    },
    // An unchanged explicit port is kept; the rest of the URL is the hop's own.
    {
      target: 'http://evil.example:8080/next?hop=1',
      rewrite: (url) => {
        url.protocol = 'https:';
        url.searchParams.set('access_token', 'SECRET');
        url.username = 'user';
      },
      expected: 'https://evil.example:8080/next?hop=1',
    },
    // The same port number, however each URL writes it.
    {
      target: 'http://evil.example:443/next',
      rewrite: (url) => {
        url.protocol = 'https:';
      },
      expected: 'https://evil.example/next',
    },
    {
      target: 'http://evil.example/next',
      rewrite: (url) => {
        url.protocol = 'https:';
        url.port = '80';
      },
      expected: 'https://evil.example:80/next',
    },
    // An upgrade that also changes the port is discarded.
    {
      target: 'http://evil.example/next',
      rewrite: (url) => {
        url.protocol = 'https:';
        url.port = '8443';
      },
      expected: 'http://evil.example/next',
    },
    // A downgrade is discarded.
    {
      target: 'https://evil.example/next',
      rewrite: (url) => {
        url.protocol = 'http:';
      },
      expected: 'https://evil.example/next',
    },
  ];

  for (const { target, rewrite, expected } of cases) {
    // As `crossOriginReplayAdapter`, matching the target by hostname: an upgrade may
    // write its port differently.
    const sentToTarget: AdapterRequest[] = [];
    const adapter: HTTPAdapter = {
      getType: () => 'node',
      send: (request) => {
        const url = new URL(request.requestURL);
        if (url.hostname === 'api.example') {
          return Promise.resolve({
            status: 307,
            headers: { location: target },
            body: null,
          });
        }
        sentToTarget.push(request);
        return Promise.resolve({
          status: sentToTarget.length === 1 ? 503 : 200,
          headers: {},
          body: null,
        });
      },
    };
    const client = new HTTPClient({
      adapter,
      followRedirects: true,
      retryPolicy: crossOriginRetryPolicy,
    });
    client.addRequestInterceptor(
      (request) => {
        const url = new URL(request.requestURL);
        rewrite(url);
        return {
          ...request,
          requestURL: url.href,
          headers: { ...request.headers, authorization: 'Bearer SECRET' },
        };
      },
      { phases: ['retry'] },
    );

    const response = await client.get('https://api.example/start').send();

    expect(response.status).toBe(200);
    expect(sentToTarget).toHaveLength(2);
    expect(sentToTarget[0]?.requestURL).toBe(target);
    expect(sentToTarget[1]?.requestURL).toBe(expected);
    // The headers rule is unchanged by an upgrade.
    expect(sentToTarget[1]?.headers).not.toHaveProperty('authorization');
  }
});

test('bodyContainsKeys matches a cross-origin hop body as it does a same-origin one', async () => {
  class Inner {
    public x = 1;
  }

  // One interceptor per request: what a later one's filter reads is the result of the
  // one before it, whatever that returned.
  const matched = async (target: string): Promise<string[]> => {
    const calls: string[] = [];
    for (const key of ['opt', 'inner.x', 'inner']) {
      const { adapter, sentToTarget } = crossOriginReplayAdapter(target);
      const client = new HTTPClient({
        adapter,
        followRedirects: true,
        retryPolicy: crossOriginRetryPolicy,
      });
      client.addRequestInterceptor(
        (request) => {
          calls.push(key);
          return request;
        },
        { phases: ['retry'], bodyContainsKeys: [key] },
      );

      await client
        .put('https://api.example/start')
        .json({ inner: new Inner(), opt: undefined })
        .send();

      expect(sentToTarget).toHaveLength(2);
    }
    return calls;
  };

  const sameOrigin = await matched('https://api.example/next');
  const crossOrigin = await matched('https://evil.example/next');

  // The body is the data it serializes to, copied as it was handed to `.json()`: the
  // `undefined` member is dropped, and the class instance is a plain object.
  expect(sameOrigin).toEqual(['inner.x', 'inner']);
  expect(crossOrigin).toEqual(sameOrigin);
});

test('an abandoned attempt that had a body is not retried; a bodiless one is', async () => {
  const run = async (
    send: (client: HTTPClient) => ReturnType<HTTPClient['get']>,
  ) => {
    let sends = 0;
    // Ignores its abort and never settles.
    const adapter: HTTPAdapter = {
      getType: () => 'node',
      send: () => {
        sends++;
        return new Promise<AdapterResponse>(() => {});
      },
    };
    const ends: Array<{ willRetry: boolean; reason: unknown }> = [];
    const builder = send(
      new HTTPClient({
        adapter,
        baseURL: 'http://x.test',
        timeout: 50,
        retryPolicy: { strategy: 'fixed', maxRetryAttempts: 1, delayMS: 1 },
      }),
    ).onAttemptEnd((event) => {
      ends.push({
        willRetry: event.willRetry,
        reason: event.retrySuppressedReason,
      });
    });
    const response = await builder.send();
    return { sends, ends, response };
  };

  const bodied = await run((client) => client.put('/a').json({ a: 1 }));
  expect(bodied.sends).toBe(1);
  expect(bodied.ends).toEqual([
    { willRetry: false, reason: 'upload_unsettled' },
  ]);
  expect(bodied.response.isTimeout).toBe(true);

  const bodiless = await run((client) => client.get('/a'));
  expect(bodiless.sends).toBe(2);
  expect(bodiless.ends[0]).toEqual({ willRetry: true, reason: undefined });
  expect(bodiless.response.isTimeout).toBe(true);
}, 15_000);

test('an abandoned POST with a body reports non_idempotent_method, the rule that would have stopped it anyway', async () => {
  let sends = 0;
  const ends: unknown[] = [];
  const builder = new HTTPClient({
    adapter: {
      getType: () => 'node',
      send: () => {
        sends++;
        return new Promise<AdapterResponse>(() => {});
      },
    },
    baseURL: 'http://x.test',
    timeout: 50,
    retryPolicy: { strategy: 'fixed', maxRetryAttempts: 1, delayMS: 1 },
  })
    .post('/a')
    .json({ a: 1 })
    .onAttemptEnd((event) => {
      ends.push(event.retrySuppressedReason);
    });
  const response = await builder.send();

  expect(sends).toBe(1);
  expect(ends).toEqual(['non_idempotent_method']);
  expect(response.isTimeout).toBe(true);
  expect(builder.error?.isRetriesExhausted).toBe(false);
});

test("retry interceptors' filters on a cross-origin hop read the hop's body, and the sub-client's first matching interceptor edits a copy of it, not what the hop sends", async () => {
  class Inner {
    public x = 1;
  }
  const { adapter, sentToTarget } = crossOriginReplayAdapter(
    'https://evil.example/next',
  );
  const parent = new HTTPClient({
    adapter,
    followRedirects: true,
    retryPolicy: crossOriginRetryPolicy,
  });
  const calls: string[] = [];
  // Declines the hop's own body.
  parent.addRequestInterceptor(
    (request) => {
      calls.push('parent');
      return request;
    },
    { phases: ['retry'], bodyContainsKeys: ['missing'] },
  );
  const child = parent.createSubClient();
  // Matches the hop's own body, and its function is handed the copy.
  child.addRequestInterceptor(
    (request) => {
      calls.push('child');
      (request.body as Record<string, unknown>).token = 'SECRET';
      return request;
    },
    { phases: ['retry'], bodyContainsKeys: ['inner.x'] },
  );
  const body = { inner: new Inner(), opt: undefined as unknown };

  await child.put('https://api.example/start').json(body).send();

  expect(calls).toEqual(['child']);
  expect(sentToTarget).toHaveLength(2);
  // The edit went to the copy: the hop sends its own body, and the caller's is untouched.
  expect(sentToTarget[1]?.body).toBe(JSON.stringify({ inner: { x: 1 } }));
  expect(body).not.toHaveProperty('token');
});

test('an abandoned attempt whose retry interceptor removed the body is retried', async () => {
  let sends = 0;
  const sentBodies: unknown[] = [];
  const client = new HTTPClient({
    adapter: {
      getType: () => 'node',
      send: (request) => {
        sends++;
        sentBodies.push(request.body);
        if (sends === 1) {
          return Promise.resolve({
            status: 503,
            headers: {},
            body: null,
            requestBodySettled: Promise.resolve(undefined),
          });
        }
        // The bodiless retry hangs, ignoring its abort; the next one answers.
        return sends === 2
          ? new Promise<AdapterResponse>(() => {})
          : Promise.resolve({ status: 200, headers: {}, body: null });
      },
    },
    baseURL: 'http://x.test',
    timeout: 50,
    retryPolicy: { strategy: 'fixed', maxRetryAttempts: 2, delayMS: 1 },
  });
  client.addRequestInterceptor((request) => ({ ...request, body: undefined }), {
    phases: ['retry'],
  });

  const response = await client.put('/a').json({ a: 1 }).send();

  expect(sends).toBe(3);
  expect(sentBodies[0]).not.toBeNull();
  expect(sentBodies[1]).toBeNull();
  expect(response.status).toBe(200);
});

test('a retry body of an unsupported type fails a cross-origin redirect hop as a same-origin one, its attempt ended', async () => {
  for (const target of [
    'https://api.example/next',
    'https://evil.example/next',
  ]) {
    const { adapter, sentToTarget } = crossOriginReplayAdapter(target);
    const client = new HTTPClient({
      adapter,
      followRedirects: true,
      retryPolicy: crossOriginRetryPolicy,
    });
    // A `Proxy` over a form: no form by its internal slot, so an unsupported body.
    const form = new FormData();
    form.append('field', 'value');
    client.addRequestInterceptor(
      (request) => ({ ...request, body: new Proxy(form, {}) }),
      { phases: ['retry'] },
    );
    const started: number[] = [];
    const ended: number[] = [];

    const builder = client
      .put('https://api.example/start')
      .json({ a: 1 })
      .onAttemptStart((event) => started.push(event.attemptNumber))
      .onAttemptEnd((event) => ended.push(event.attemptNumber));
    const response = await builder.send();

    expect(response.status).toBe(0);
    expect(builder.error?.code).toBe('interceptor_error');
    expect(sentToTarget).toHaveLength(1);
    expect(started).toEqual([1, 2, 3]);
    expect(ended).toEqual([1, 2, 3]);
  }
});

test('a cross-origin retry whose body is of an unsupported type reports the hop request, not what the interceptor added', async () => {
  const { adapter, sentToTarget } = crossOriginReplayAdapter(
    'https://evil.example/next',
  );
  const client = new HTTPClient({
    adapter,
    followRedirects: true,
    retryPolicy: crossOriginRetryPolicy,
  });
  const form = new FormData();
  form.append('field', 'value');
  client.addRequestInterceptor(
    (request) => {
      const url = new URL(request.requestURL);
      url.searchParams.set('access_token', 'SECRET');
      return {
        ...request,
        requestURL: url.href,
        headers: { ...request.headers, authorization: 'Bearer SECRET' },
        body: new Proxy(form, {}),
      };
    },
    { phases: ['retry'] },
  );
  const observed: Array<{
    requestURL: string;
    headers: Record<string, string | string[]>;
    rawBody: unknown;
  }> = [];
  client.addErrorObserver(
    (_error, request) => {
      observed.push({
        requestURL: request.requestURL,
        headers: request.headers,
        rawBody: request.rawBody,
      });
    },
    { hosts: ['evil.example'] },
  );

  const builder = client.put('https://api.example/start').json({ a: 1 });
  const response = await builder.send();

  expect(builder.error?.code).toBe('interceptor_error');
  expect(sentToTarget).toHaveLength(1);
  expect(response.requestURL).toBe('https://evil.example/next');
  expect(builder.error?.requestURL).toBe('https://evil.example/next');
  expect(observed).toHaveLength(1);
  expect(observed[0]?.requestURL).toBe('https://evil.example/next');
  expect(observed[0]?.headers).not.toHaveProperty('authorization');
  // The hop's own JSON body, not the interceptor's form.
  expect(observed[0]?.rawBody).toEqual({ a: 1 });
});

test('a retry interceptor that empties a cross-origin 307 replay into an empty form sends that, not the hop body', async () => {
  const { adapter, sentToTarget } = crossOriginReplayAdapter(
    'https://evil.example/next',
  );
  const client = new HTTPClient({
    adapter,
    followRedirects: true,
    retryPolicy: crossOriginRetryPolicy,
  });
  client.addRequestInterceptor(
    (request) => ({ ...request, body: new FormData() }),
    { phases: ['retry'] },
  );

  const response = await client
    .put('https://api.example/start')
    .json({ a: 1 })
    .send();

  expect(response.status).toBe(200);
  expect(sentToTarget).toHaveLength(2);
  expect(sentToTarget[0]?.body).toBe(JSON.stringify({ a: 1 }));
  const sentBody = sentToTarget[1]?.body;
  expect(sentBody).toBeInstanceOf(FormData);
  expect([...(sentBody as FormData).entries()]).toEqual([]);
  // The hop's JSON headers do not describe it: a form owns its own type.
  expect(sentToTarget[1]?.headers).not.toHaveProperty('content-type');
});

test('retry bytes that claim to be empty do not reach a cross-origin redirect target', async () => {
  // A `byteLength` of `0` over bytes that are there.
  class LyingBytes extends Uint8Array {
    public override get byteLength(): number {
      return 0;
    }
  }
  const { adapter, sentToTarget } = crossOriginReplayAdapter(
    'https://evil.example/next',
  );
  const client = new HTTPClient({
    adapter,
    followRedirects: true,
    retryPolicy: crossOriginRetryPolicy,
  });
  client.addRequestInterceptor(
    (request) => ({
      ...request,
      body: new LyingBytes(new TextEncoder().encode('SECRET')),
    }),
    { phases: ['retry'] },
  );

  const response = await client
    .put('https://api.example/start')
    .json({ a: 1 })
    .send();

  expect(response.status).toBe(200);
  expect(sentToTarget).toHaveLength(2);
  // The hop's own body, with the headers that describe it.
  expect(sentToTarget[1]?.body).toBe(JSON.stringify({ a: 1 }));
  expect(sentToTarget[1]?.headers['content-type']).toBe(
    sentToTarget[0]?.headers['content-type'],
  );
});

test("an abandoned attempt with a body reports its upload's outcome unknown, not none", async () => {
  const run = async (
    send: (client: HTTPClient) => ReturnType<HTTPClient['get']>,
  ) => {
    // Ignores its abort and never settles.
    const adapter: HTTPAdapter = {
      getType: () => 'node',
      send: () => new Promise<AdapterResponse>(() => {}),
    };
    return send(
      new HTTPClient({ adapter, baseURL: 'http://x.test', timeout: 50 }),
    ).send();
  };

  const bodied = await run((client) => client.put('/a').json({ a: 1 }));
  expect(bodied.isTimeout).toBe(true);
  expect(bodied.requestBodySettled).toBeInstanceOf(Promise);
  const outcome = await bodied.requestBodySettled;
  expect(outcome).toBeInstanceOf(Error);
  expect(outcome?.message).toContain('unknown');

  const bodiless = await run((client) => client.get('/a'));
  expect(bodiless.isTimeout).toBe(true);
  expect(bodiless).not.toHaveProperty('requestBodySettled');
}, 15_000);

test('a custom adapter throw that carries no upload outcome still reports none', async () => {
  const adapter: HTTPAdapter = {
    getType: () => 'node',
    send: () => Promise.reject(new Error('boom')),
  };
  const response = await new HTTPClient({ adapter, baseURL: 'http://x.test' })
    .put('/a')
    .json({ a: 1 })
    .send();

  expect(response.isFailed).toBe(true);
  expect(response).not.toHaveProperty('requestBodySettled');
});

test("a cross-origin retry the client refuses reports the hop's request, not what the interceptor added", async () => {
  for (const requestURL of [
    // An unsupported body, on the hop's own URL with a token added.
    (hopURL: string) => {
      const url = new URL(hopURL);
      url.searchParams.set('access_token', 'SECRET');
      return url.href;
    },
    // A URL the client refuses, naming no host.
    () => '/next?access_token=SECRET',
  ]) {
    const { adapter, sentToTarget } = crossOriginReplayAdapter(
      'https://evil.example/next',
    );
    const client = new HTTPClient({
      adapter,
      followRedirects: true,
      retryPolicy: crossOriginRetryPolicy,
    });
    client.addRequestInterceptor(
      (request) => ({
        ...request,
        requestURL: requestURL(request.requestURL),
        headers: { ...request.headers, authorization: 'Bearer SECRET' },
        body: new URLSearchParams({ token: 'SECRET' }),
      }),
      { phases: ['retry'] },
    );
    const observed: Array<{
      requestURL: string;
      headers: Record<string, string | string[]>;
    }> = [];
    client.addErrorObserver(
      (_error, request) => {
        observed.push({
          requestURL: request.requestURL,
          headers: request.headers,
        });
      },
      { hosts: ['evil.example'] },
    );

    const builder = client.put('https://api.example/start').json({ a: 1 });
    const response = await builder.send();

    expect(builder.error?.code).toBe('interceptor_error');
    expect(sentToTarget).toHaveLength(1);
    expect(response.requestURL).toBe('https://evil.example/next');
    expect(builder.error?.requestURL).toBe('https://evil.example/next');
    expect(observed).toHaveLength(1);
    expect(observed[0]?.requestURL).toBe('https://evil.example/next');
    expect(observed[0]?.headers).not.toHaveProperty('authorization');
  }
});

test('an abandoned attempt whose body sends nothing is retried, and reports no upload outcome', async () => {
  for (const body of ['', new Uint8Array(0), new FormData()]) {
    let sends = 0;
    // Ignores its abort and never settles.
    const adapter: HTTPAdapter = {
      getType: () => 'node',
      send: () => {
        sends++;
        return new Promise<AdapterResponse>(() => {});
      },
    };
    const ends: Array<{ willRetry: boolean; reason: unknown }> = [];
    const response = await new HTTPClient({
      adapter,
      baseURL: 'http://x.test',
      timeout: 50,
      retryPolicy: { strategy: 'fixed', maxRetryAttempts: 1, delayMS: 1 },
    })
      .put('/a')
      .body(body)
      .onAttemptEnd((event) => {
        ends.push({
          willRetry: event.willRetry,
          reason: event.retrySuppressedReason,
        });
      })
      .send();

    expect(sends).toBe(2);
    expect(ends[0]).toEqual({ willRetry: true, reason: undefined });
    expect(response.isTimeout).toBe(true);
    expect(response).not.toHaveProperty('requestBodySettled');
  }
}, 30_000);

test('a retry interceptor that empties the body leaves the upload outcome of the attempt that had one', async () => {
  for (const emptyBody of ['', new Uint8Array(0), new FormData()]) {
    const sent: AdapterRequest[] = [];
    const cut = new Error('cut');
    const adapter: HTTPAdapter = {
      getType: () => 'node',
      send: (request) => {
        sent.push(request);
        return Promise.resolve(
          sent.length === 1
            ? {
                status: 503,
                headers: {},
                body: null,
                requestBodySettled: Promise.resolve(cut),
              }
            : { status: 200, headers: {}, body: null },
        );
      },
    };
    const client = new HTTPClient({
      adapter,
      baseURL: 'http://x.test',
      retryPolicy: { strategy: 'fixed', maxRetryAttempts: 1, delayMS: 1 },
    });
    client.addRequestInterceptor(
      (request) => ({ ...request, body: emptyBody }),
      { phases: ['retry'] },
    );

    const response = await client.put('/a').json({ a: 1 }).send();

    expect(sent).toHaveLength(2);
    expect(response.status).toBe(200);
    const outcome = await response.requestBodySettled;
    expect(outcome?.message).toBe('cut');
  }
});

test('a retry interceptor that drops a cross-origin 307 replay sends none of the headers that describe a body', async () => {
  for (const variant of [
    { body: undefined, addedHeaders: {}, contentType: undefined },
    // An empty string goes out with the client's own type for a string, as anywhere else.
    {
      body: '',
      addedHeaders: { 'content-type': 'application/json' },
      contentType: 'text/plain; charset=utf-8',
    },
  ]) {
    const { adapter, sentToTarget } = crossOriginReplayAdapter(
      'https://evil.example/next',
    );
    const client = new HTTPClient({
      adapter,
      followRedirects: true,
      retryPolicy: crossOriginRetryPolicy,
    });
    client.addRequestInterceptor(
      (request) => ({
        ...request,
        headers: { ...request.headers, ...variant.addedHeaders },
        body: variant.body,
      }),
      { phases: ['retry'] },
    );

    const response = await client
      .put('https://api.example/start')
      .headers({
        'content-type': 'application/octet-stream',
        'content-encoding': 'gzip',
        'content-language': 'en',
      })
      .body('payload')
      .send();

    expect(response.status).toBe(200);
    expect(sentToTarget).toHaveLength(2);
    expect(sentToTarget[0]?.headers['content-encoding']).toBe('gzip');
    const retryHeaders: Record<string, string | string[] | undefined> =
      sentToTarget[1]?.headers ?? {};
    expect(retryHeaders['content-type']).toBe(variant.contentType);
    for (const name of [
      'content-length',
      'content-encoding',
      'content-language',
      'content-location',
    ]) {
      expect(retryHeaders).not.toHaveProperty(name);
    }
  }
});

test('a retry interceptor on a cross-origin hop with no body to send keeps the headers that describe it', async () => {
  for (const body of [undefined, '', new Uint8Array(0)]) {
    const { adapter, sentToTarget } = crossOriginReplayAdapter(
      'https://evil.example/next',
    );
    const client = new HTTPClient({
      adapter,
      followRedirects: true,
      retryPolicy: crossOriginRetryPolicy,
    });
    client.addRequestInterceptor((request) => request, { phases: ['retry'] });

    let builder = client.put('https://api.example/start').headers({
      'content-type': 'application/json',
      'content-language': 'en',
    });
    if (body !== undefined) {
      builder = builder.body(body);
    }
    const response = await builder.send();

    expect(response.status).toBe(200);
    expect(sentToTarget).toHaveLength(2);
    const [first, retry] = sentToTarget;
    expect(retry?.headers['content-type']).toBe(first?.headers['content-type']);
    expect(retry?.headers['content-language']).toBe('en');
  }
});

test("an internal throw after a later hop's bodied attempt reports that attempt's upload outcome, not an earlier hop's", async () => {
  const cut = new Error('cut');
  const sent: AdapterRequest[] = [];
  const adapter: HTTPAdapter = {
    getType: () => 'node',
    send: (request) => {
      sent.push(request);
      return Promise.resolve<AdapterResponse>(
        sent.length === 1
          ? {
              status: 307,
              headers: { location: '/next' },
              body: null,
              requestBodySettled: Promise.resolve(cut),
            }
          : // The replay's answer reports no upload outcome.
            { status: 503, headers: {}, body: null },
      );
    },
  };
  const client = new HTTPClient({
    adapter,
    baseURL: 'http://x.test',
    followRedirects: true,
    retryPolicy: { strategy: 'fixed', maxRetryAttempts: 1, delayMS: 1 },
  });
  // A failure of the client's own code that escapes the attempt runner, after the replay
  // went out: composing the retry's signal (the third attempt's) throwing.
  const internals = client as unknown as {
    _composeSignals: (...args: unknown[]) => AbortSignal;
  };
  const composeSignals = internals._composeSignals.bind(client);
  let composed = 0;
  internals._composeSignals = (...args) => {
    composed++;
    if (composed === 3) {
      throw new Error('internal');
    }
    return composeSignals(...args);
  };

  const response = await client.put('/start').json({ a: 1 }).send();

  expect(composed).toBe(3);
  expect(sent).toHaveLength(2);
  expect(sent[1]?.requestURL).toBe('http://x.test/next');
  expect(response.isFailed).toBe(true);
  expect(response).not.toHaveProperty('requestBodySettled');
});

test('listRequests reads its filter label once', async () => {
  const releases: Array<() => void> = [];
  const adapter: HTTPAdapter = {
    getType: () => 'node',
    send: () =>
      new Promise<AdapterResponse>((resolve) => {
        releases.push(() => resolve({ status: 200, headers: {}, body: null }));
      }),
  };
  const client = new HTTPClient({ adapter, baseURL: 'http://x.test' });
  const pending = [
    client.get('/a').label('poll').send(),
    client.get('/b').label('other').send(),
  ];
  await new Promise((resolve) => setTimeout(resolve, 5));

  let reads = 0;
  const filter = {
    get label(): string | undefined {
      reads++;
      return reads === 1 ? 'poll' : undefined;
    },
  };
  const listed = client.listRequests(filter);

  expect(reads).toBe(1);
  expect(listed.requests.map((request) => request.label)).toEqual(['poll']);

  for (const release of releases) {
    release();
  }
  await Promise.all(pending);
});

test('a retry interceptor on a cross-origin hop keeps a __proto__ header the hop carried', async () => {
  for (const value of ['v', ['a', 'b']]) {
    const { adapter, sentToTarget } = crossOriginReplayAdapter(
      'https://evil.example/next',
    );
    const client = new HTTPClient({
      adapter,
      followRedirects: true,
      retryPolicy: crossOriginRetryPolicy,
    });
    // The redirect phase adds it for the hop, so the hop carries it into the retry.
    client.addRequestInterceptor(
      (request) => {
        const headers = { ...request.headers };
        Object.defineProperty(headers, '__proto__', {
          value,
          enumerable: true,
          writable: true,
          configurable: true,
        });
        return { ...request, headers };
      },
      { phases: ['redirect'] },
    );
    client.addRequestInterceptor((request) => request, { phases: ['retry'] });

    const response = await client.get('https://api.example/start').send();

    expect(response.status).toBe(200);
    expect(sentToTarget).toHaveLength(2);
    for (const sent of sentToTarget) {
      expect(Object.getPrototypeOf(sent.headers)).toBe(Object.prototype);
      expect(
        Object.getOwnPropertyDescriptor(sent.headers, '__proto__')?.value,
      ).toEqual(value);
    }
  }
});

test('a Uint8Array body from another realm is sent as its bytes; a Proxy over one is refused', async () => {
  const adapter = new MockAdapter();
  const received: unknown[] = [];
  adapter.routes.post('/upload', (request) => {
    received.push(request.body);
    return {
      status: 200,
      body: { contentType: request.headers['content-type'] },
    };
  });
  const client = new HTTPClient({ adapter, baseURL: 'http://api.test' });
  const observed: unknown[] = [];
  client.addResponseObserver((_response, request) => {
    observed.push(request.rawBody);
  });

  const foreign = vm.runInNewContext('new Uint8Array([1, 2, 3])') as Uint8Array;
  expect(foreign instanceof Uint8Array).toBe(false);

  const response = await client.post('/upload').body(foreign).send();

  expect(response.status).toBe(200);
  expect(response.body).toEqual({ contentType: 'application/octet-stream' });
  expect(received).toHaveLength(1);
  expect(received[0]).toBeInstanceOf(Uint8Array);
  expect(Array.from(received[0] as Uint8Array)).toEqual([1, 2, 3]);
  expect(observed).toHaveLength(1);
  expect(Array.from(observed[0] as Uint8Array)).toEqual([1, 2, 3]);

  // No internal slot, so no bytes to copy: refused as it is handed over.
  expect(() =>
    client.post('/upload').body(new Proxy(new Uint8Array([1, 2, 3]), {})),
  ).toThrow(/Unsupported request body type/);
  expect(received).toHaveLength(1);
});

const roundSeventyTwoARetryPolicy = {
  strategy: 'fixed',
  maxRetryAttempts: 1,
  delayMS: 0,
} as const;

test('a retry-phase error observer that redacts an array header in place does not change the retry', async () => {
  const sent: string[] = [];
  let attempts = 0;
  const adapter: HTTPAdapter = {
    getType: () => 'mock',
    send: (request) => {
      sent.push(JSON.stringify(request.headers['x-api-keys']));
      attempts++;
      if (attempts === 1) {
        return Promise.reject(new TypeError('socket hang up'));
      }
      return Promise.resolve({ status: 200, headers: {}, body: null });
    },
  };
  const client = new HTTPClient({
    adapter,
    retryPolicy: roundSeventyTwoARetryPolicy,
  });
  const reported: unknown[] = [];
  client.addErrorObserver(
    (_error, request) => {
      const value = request.headers['x-api-keys'];
      if (Array.isArray(value)) {
        value.fill('[REDACTED]');
      }
      reported.push(request.headers['x-api-keys']);
    },
    { phases: ['retry'] },
  );

  const response = await client
    .get('http://api.test/x')
    .headers({ 'x-api-keys': ['k1', 'k2'] })
    .send();

  expect(response.status).toBe(200);
  expect(sent).toEqual(['["k1","k2"]', '["k1","k2"]']);
  expect(reported).toEqual([['[REDACTED]', '[REDACTED]']]);
});

test('a retry interceptor that pushes onto an array header does not accumulate across retries', async () => {
  const adapter = new MockAdapter();
  const seen: unknown[] = [];
  adapter.routes.get('/x', (request) => {
    seen.push(request.headers['x-multi']);
    return { status: seen.length < 3 ? 503 : 200, body: 'ok' };
  });
  const client = new HTTPClient({
    adapter,
    baseURL: 'http://api.test',
    retryPolicy: { strategy: 'fixed', maxRetryAttempts: 2, delayMS: 0 },
  });
  client.addRequestInterceptor(
    (request) => {
      const value = request.headers['x-multi'];
      if (Array.isArray(value)) {
        value.push('retry');
      }
      return request;
    },
    { phases: ['retry'] },
  );

  await client
    .get('/x')
    .headers({ 'x-multi': ['a', 'b'] })
    .send();

  expect(seen).toEqual(['a, b', 'a, b, retry', 'a, b, retry']);
});

test('the request an earlier attempt was reported as keeps its array headers after a later attempt changes its own', async () => {
  const adapter = new MockAdapter();
  let attempts = 0;
  adapter.routes.get('/x', () => {
    attempts++;
    return { status: attempts === 1 ? 503 : 200, body: 'ok' };
  });
  const client = new HTTPClient({
    adapter,
    baseURL: 'http://api.test',
    retryPolicy: roundSeventyTwoARetryPolicy,
  });
  const kept: Array<{ headers: Record<string, string | string[]> }> = [];
  client.addResponseObserver(
    (_response, request) => {
      kept.push(request);
    },
    { phases: ['retry', 'final'] },
  );
  client.addRequestInterceptor(
    (request) => {
      (request.headers['x-multi'] as string[]).push('r');
      return request;
    },
    { phases: ['retry'] },
  );

  await client
    .get('/x')
    .headers({ 'x-multi': ['a', 'b'] })
    .send();

  expect(kept).toHaveLength(2);
  expect(kept[0].headers['x-multi']).toEqual(['a', 'b']);
  expect(kept[1].headers['x-multi']).toEqual(['a', 'b', 'r']);
});

test('a custom adapter that pushes onto an array header reaches neither the observers nor the retry', async () => {
  const inner = new MockAdapter();
  const seen: unknown[] = [];
  inner.routes.get('/x', (request) => {
    seen.push(request.headers.accept);
    return { status: seen.length === 1 ? 503 : 200, body: 'ok' };
  });
  const adapter: HTTPAdapter = {
    getType: () => 'mock',
    send: (request) => {
      const accept = request.headers.accept;
      if (Array.isArray(accept)) {
        accept.push('application/x-adapter');
      }
      return inner.send(request);
    },
  };
  const client = new HTTPClient({
    adapter,
    baseURL: 'http://api.test',
    retryPolicy: roundSeventyTwoARetryPolicy,
  });
  const observed: unknown[] = [];
  client.addResponseObserver(
    (_response, request) => {
      observed.push(request.headers.accept);
    },
    { phases: ['retry', 'final'] },
  );

  await client
    .get('/x')
    .headers({ accept: ['text/plain', 'application/json'] })
    .send();

  expect(seen).toEqual([
    'text/plain, application/json, application/x-adapter',
    'text/plain, application/json, application/x-adapter',
  ]);
  expect(observed).toEqual([
    ['text/plain', 'application/json'],
    ['text/plain', 'application/json'],
  ]);
});

test('a redirect-phase response observer that pushes onto an array header does not change the next hop', async () => {
  const adapter = new MockAdapter();
  const seen: unknown[] = [];
  adapter.routes.get('/a', (request) => {
    seen.push(request.headers['x-multi']);
    return { status: 302, headers: { location: '/b' } };
  });
  adapter.routes.get('/b', (request) => {
    seen.push(request.headers['x-multi']);
    return { status: 200, body: 'ok' };
  });
  const client = new HTTPClient({
    adapter,
    baseURL: 'http://api.test',
    followRedirects: true,
  });
  client.addResponseObserver(
    (_response, request) => {
      const value = request.headers['x-multi'];
      if (Array.isArray(value)) {
        value.push('from-observer');
      }
    },
    { phases: ['redirect'] },
  );

  const response = await client
    .get('/a')
    .headers({ 'x-multi': ['a', 'b'] })
    .send();

  expect(response.status).toBe(200);
  expect(seen).toEqual(['a, b', 'a, b']);
});

/**
 * An adapter that answers each attempt from `answers`, by its place in the request, and
 * records what each attempt sent: a string as it is, bytes as their numbers, and a form
 * as its entries.
 */
function roundSeventyTwoBAdapter(
  answers: Array<{ status: number; location?: string }>,
): { adapter: HTTPAdapter; sent: unknown[]; urls: string[] } {
  const sent: unknown[] = [];
  const urls: string[] = [];
  const adapter: HTTPAdapter = {
    getType: () => 'node',
    send: (request) => {
      const { body } = request;
      sent.push(
        body instanceof Uint8Array
          ? Array.from(body)
          : body instanceof FormData
            ? [...body.entries()]
            : body,
      );
      urls.push(request.requestURL);
      const answer = answers[sent.length - 1] ?? { status: 200 };
      const headers: Record<string, string> = {};
      if (answer.location !== undefined) {
        headers.location = answer.location;
      }
      return Promise.resolve({ status: answer.status, headers, body: null });
    },
  };
  return { adapter, sent, urls };
}

const roundSeventyTwoBRetryPolicy = {
  strategy: 'fixed',
  maxRetryAttempts: 2,
  delayMS: 0,
} as const;

test('a body changed after it is handed to the builder and before send() is not sent', async () => {
  const { adapter, sent } = roundSeventyTwoBAdapter([]);
  const client = new HTTPClient({ adapter, baseURL: 'http://api.test' });

  const json = { a: 1, nested: { b: 2 } };
  const jsonBuilder = client.post('/x').json(json);
  json.a = 99;
  json.nested.b = 99;
  (json as Record<string, unknown>).added = true;

  const optionJSON = { a: 1 };
  const optionBuilder = client.post('/x', { body: optionJSON });
  optionJSON.a = 99;

  const bytes = new Uint8Array([1, 2, 3]);
  const bytesBuilder = client.post('/x').body(bytes);
  bytes[0] = 99;

  const form = new FormData();
  form.append('a', '1');
  const formBuilder = client.post('/x').formData(form);
  form.append('token', 'SECRET');
  form.set('a', 'changed');

  await jsonBuilder.send();
  await optionBuilder.send();
  await bytesBuilder.send();
  await formBuilder.send();

  expect(sent).toEqual([
    '{"a":1,"nested":{"b":2}}',
    '{"a":1}',
    [1, 2, 3],
    [['a', '1']],
  ]);
});

test('a body changed from onAttemptEnd between attempts is not sent on the retry, nor reported', async () => {
  const { adapter, sent } = roundSeventyTwoBAdapter([
    { status: 503 },
    { status: 200 },
  ]);
  const client = new HTTPClient({
    adapter,
    baseURL: 'http://api.test',
    retryPolicy: roundSeventyTwoBRetryPolicy,
  });
  const reported: unknown[] = [];
  client.addResponseObserver((_response, request) => {
    reported.push(request.rawBody);
  });
  const json = { a: 1 };
  const bytes = new Uint8Array([1, 2, 3]);

  await client
    .put('/x')
    .json(json)
    .onAttemptEnd(() => {
      json.a++;
    })
    .send();
  await client
    .put('/x')
    .body(bytes)
    .onAttemptEnd(() => {
      bytes[0] = 99;
    })
    .send();

  expect(sent).toEqual(['{"a":1}', '{"a":1}', [1, 2, 3]]);
  expect(reported[0]).toEqual({ a: 1 });
});

test('a 307 replay sends the body as it was handed over, whatever the caller changed since', async () => {
  for (const status of [307, 308]) {
    const { adapter, sent, urls } = roundSeventyTwoBAdapter([
      { status, location: '/next' },
      { status: 200 },
    ]);
    const client = new HTTPClient({
      adapter,
      baseURL: 'http://api.test',
      followRedirects: true,
    });
    const json = { a: 1 };

    await client
      .post('/start')
      .json(json)
      .onAttemptEnd(() => {
        json.a = 99;
      })
      .send();

    expect(urls).toEqual(['http://api.test/start', 'http://api.test/next']);
    expect(sent).toEqual(['{"a":1}', '{"a":1}']);
  }
});

test('a retry interceptor that edits the body in place does not add to it again on each retry', async () => {
  const { adapter, sent } = roundSeventyTwoBAdapter([
    { status: 503 },
    { status: 503 },
    { status: 200 },
  ]);
  const client = new HTTPClient({
    adapter,
    baseURL: 'http://api.test',
    retryPolicy: roundSeventyTwoBRetryPolicy,
  });
  client.addRequestInterceptor(
    (request) => {
      const body = request.body as { a: number; retries?: number };
      body.retries = (body.retries ?? 0) + 1;
      return request;
    },
    { phases: ['retry'] },
  );
  const json = { a: 1 };

  await client.put('/x').json(json).send();

  expect(sent).toEqual([
    '{"a":1}',
    '{"a":1,"retries":1}',
    '{"a":1,"retries":1}',
  ]);
  expect(json).toEqual({ a: 1 });
});

test('a body an interceptor returns and changes later does not reach a later attempt or a replay', async () => {
  // An initial-phase interceptor's body, changed before the retry.
  const initial = roundSeventyTwoBAdapter([{ status: 503 }, { status: 200 }]);
  const initialClient = new HTTPClient({
    adapter: initial.adapter,
    baseURL: 'http://api.test',
    retryPolicy: roundSeventyTwoBRetryPolicy,
  });
  const initialBody = { token: 'first' };
  initialClient.addRequestInterceptor((request) => ({
    ...request,
    body: initialBody,
  }));

  await initialClient
    .put('/x')
    .json({ a: 1 })
    .onAttemptEnd(() => {
      initialBody.token = 'changed';
    })
    .send();

  expect(initial.sent).toEqual(['{"token":"first"}', '{"token":"first"}']);

  // A retry-phase interceptor's body, changed before the 307 replay of that retry.
  const retry = roundSeventyTwoBAdapter([
    { status: 503 },
    { status: 307, location: '/next' },
    { status: 200 },
  ]);
  const retryClient = new HTTPClient({
    adapter: retry.adapter,
    baseURL: 'http://api.test',
    followRedirects: true,
    retryPolicy: roundSeventyTwoBRetryPolicy,
  });
  const retryBody = { token: 'retry' };
  retryClient.addRequestInterceptor(
    (request) => ({ ...request, body: retryBody }),
    { phases: ['retry'] },
  );

  await retryClient
    .put('/start')
    .json({ a: 1 })
    .onAttemptEnd((event) => {
      // After the retry that sent it, which the server answered with the 307.
      if (event.attemptNumber === 2) {
        retryBody.token = 'changed';
      }
    })
    .send();

  expect(retry.urls).toEqual([
    'http://api.test/start',
    'http://api.test/start',
    'http://api.test/next',
  ]);
  expect(retry.sent).toEqual([
    '{"a":1}',
    '{"token":"retry"}',
    '{"token":"retry"}',
  ]);
  // A redirect-phase interceptor's body, changed before the hop's retry.
  const redirect = roundSeventyTwoBAdapter([
    { status: 307, location: '/next' },
    { status: 503 },
    { status: 200 },
  ]);
  const redirectClient = new HTTPClient({
    adapter: redirect.adapter,
    baseURL: 'http://api.test',
    followRedirects: true,
    retryPolicy: roundSeventyTwoBRetryPolicy,
  });
  const redirectBody = { token: 'hop' };
  redirectClient.addRequestInterceptor(
    (request) => ({ ...request, body: redirectBody }),
    { phases: ['redirect'] },
  );

  await redirectClient
    .put('/start')
    .json({ a: 1 })
    .onAttemptEnd((event) => {
      if (event.attemptNumber === 2) {
        redirectBody.token = 'changed';
      }
    })
    .send();

  expect(redirect.urls).toEqual([
    'http://api.test/start',
    'http://api.test/next',
    'http://api.test/next',
  ]);
  expect(redirect.sent).toEqual([
    '{"a":1}',
    '{"token":"hop"}',
    '{"token":"hop"}',
  ]);
});

test('a body whose getter or toJSON throws throws from the setter, and nothing is sent', () => {
  const { adapter, sent } = roundSeventyTwoBAdapter([]);
  const client = new HTTPClient({ adapter, baseURL: 'http://api.test' });

  expect(() =>
    client.post('/x').json({
      toJSON(): never {
        throw new Error('toJSON failed');
      },
    }),
  ).toThrow('toJSON failed');
  expect(() =>
    client.post('/x', {
      body: {
        get token(): string {
          throw new Error('getter failed');
        },
      },
    }),
  ).toThrow('getter failed');
  expect(sent).toEqual([]);
});

test('a Date in a JSON body reaches interceptors as its ISO string and is sent as before', async () => {
  const { adapter, sent } = roundSeventyTwoBAdapter([]);
  const client = new HTTPClient({ adapter, baseURL: 'http://api.test' });
  const seen: unknown[] = [];
  client.addRequestInterceptor((request) => {
    seen.push((request.body as { when: unknown }).when);
    return request;
  });
  const when = new Date('2020-01-02T03:04:05.000Z');

  await client.post('/x').json({ when }).send();

  expect(seen).toEqual(['2020-01-02T03:04:05.000Z']);
  expect(sent).toEqual([JSON.stringify({ when })]);
});

test('an interceptor that edits the body it is handed in place sends its edit, in the initial and redirect phases', async () => {
  const { adapter, sent } = roundSeventyTwoBAdapter([
    { status: 307, location: '/next' },
    { status: 200 },
  ]);
  const client = new HTTPClient({
    adapter,
    baseURL: 'http://api.test',
    followRedirects: true,
  });
  client.addRequestInterceptor(
    (request, phase) => {
      (request.body as Record<string, unknown>)[phase.type] = true;
      return request;
    },
    { phases: ['initial', 'redirect'] },
  );

  await client.put('/start').json({ a: 1 }).send();

  expect(sent).toEqual([
    '{"a":1,"initial":true}',
    '{"a":1,"initial":true,"redirect":true}',
  ]);
});

test('a request an interceptor edits in place and then ends is reported with its edit', async () => {
  // The initial phase hands its interceptors the builder's own body, so an edit made in
  // place is in the request it reports.
  for (const end of ['throw', 'cancel'] as const) {
    const { adapter, sent } = roundSeventyTwoBAdapter([]);
    const client = new HTTPClient({ adapter, baseURL: 'http://api.test' });
    const reported: unknown[] = [];
    client.addErrorObserver((_error, request) => {
      reported.push(request.body, request.rawBody);
    });
    client.addRequestInterceptor((request) => {
      (request.body as Record<string, unknown>).edited = true;
      if (end === 'throw') {
        throw new Error('interceptor failed');
      }
      return null;
    });

    await client.post('/x').json({ a: 1 }).send();

    expect(sent).toEqual([]);
    expect(reported).toEqual(['{"a":1,"edited":true}', { a: 1, edited: true }]);
  }

  // Returned and then refused: the result is reported, its text read from the edited
  // body rather than the text of the copy it was handed.
  const { adapter, sent } = roundSeventyTwoBAdapter([]);
  const client = new HTTPClient({ adapter, baseURL: 'http://api.test' });
  const reported: unknown[] = [];
  client.addErrorObserver((error, request) => {
    reported.push(error.code, request.body, request.rawBody);
  });
  client.addRequestInterceptor((request) => {
    (request.body as Record<string, unknown>).edited = true;
    request.method = 'CONNECT';
    return request;
  });

  await client.post('/x').json({ a: 1 }).send();

  expect(sent).toEqual([]);
  expect(reported).toEqual([
    'interceptor_error',
    '{"a":1,"edited":true}',
    { a: 1, edited: true },
  ]);
});

test('a JSON body is serialized once, when it is handed over, however many attempts send or replay it', async () => {
  const { adapter, sent } = roundSeventyTwoBAdapter([
    { status: 503 },
    { status: 307, location: '/next' },
    { status: 200 },
  ]);
  const client = new HTTPClient({
    adapter,
    baseURL: 'http://api.test',
    followRedirects: true,
    retryPolicy: roundSeventyTwoBRetryPolicy,
  });
  client.addResponseObserver(() => {});
  const stringify = spyOn(JSON, 'stringify');

  try {
    await client.put('/start').json({ marker: 1 }).send();

    const bodySerializations = stringify.mock.calls.filter(
      ([value]) =>
        typeof value === 'object' && value !== null && 'marker' in value,
    );
    expect(bodySerializations).toHaveLength(1);
  } finally {
    stringify.mockRestore();
  }

  expect(sent).toEqual(['{"marker":1}', '{"marker":1}', '{"marker":1}']);
});

test("a parent client's interceptor body changed later does not reach a later attempt", async () => {
  const { adapter, sent } = roundSeventyTwoBAdapter([
    { status: 503 },
    { status: 200 },
  ]);
  const parent = new HTTPClient({
    adapter,
    baseURL: 'http://api.test',
    retryPolicy: roundSeventyTwoBRetryPolicy,
  });
  const parentBody = { token: 'parent' };
  parent.addRequestInterceptor(
    (request) => ({ ...request, body: parentBody }),
    { phases: ['initial'] },
  );
  const child = parent.createSubClient();
  // Declines, so no sub-client interceptor's function is called.
  child.addRequestInterceptor((request) => request, {
    phases: ['initial'],
    bodyContainsKeys: ['missing'],
  });

  await child
    .put('/x')
    .json({ a: 1 })
    .onAttemptEnd(() => {
      parentBody.token = 'changed';
    })
    .send();

  expect(sent).toEqual(['{"token":"parent"}', '{"token":"parent"}']);
});

test("a built-in adapter is handed the request's bytes uncopied, and a retry and a 307 replay still send the same bytes and form", async () => {
  const received: Array<{ url: string | undefined; body: Buffer }> = [];
  let startCalls = 0;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      received.push({ url: req.url, body: Buffer.concat(chunks) });
      if (req.url === '/start') {
        startCalls++;
        res.writeHead(startCalls % 2 === 1 ? 503 : 307, {
          location: '/next',
        });
        res.end();
        return;
      }
      res.end('ok');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const client = new HTTPClient({
      adapter: new NodeAdapter(),
      baseURL,
      followRedirects: true,
      retryPolicy: roundSeventyTwoBRetryPolicy,
    });
    const form = new FormData();
    form.set('a', 'form-value');

    const bytesResponse = await client
      .put('/start')
      .body(new Uint8Array([1, 2, 3, 4]))
      .send();
    const formResponse = await client.put('/start').formData(form).send();

    expect(bytesResponse.status).toBe(200);
    expect(formResponse.status).toBe(200);
    expect(received.map((entry) => entry.url)).toEqual([
      '/start',
      '/start',
      '/next',
      '/start',
      '/start',
      '/next',
    ]);
    for (const { body } of received.slice(0, 3)) {
      expect([...body]).toEqual([1, 2, 3, 4]);
    }
    for (const { body } of received.slice(3)) {
      expect(body.toString('utf8')).toContain('\r\n\r\nform-value\r\n');
    }
  } finally {
    server.close();
  }
});

test('an adapter that is not a built-in one, or a built-in one whose send a subclass overrides or the instance replaces, cannot change what a retry or a replay sends', async () => {
  const makeSend = (seen: unknown[]): HTTPAdapter['send'] => {
    const answers = [503, 307, 200];
    return (request) => {
      const { body } = request;
      if (body instanceof Uint8Array) {
        seen.push(Array.from(body));
        body.fill(9);
      } else if (body instanceof FormData) {
        seen.push([...body.entries()]);
        body.set('a', 'changed');
        body.append('token', 'SECRET');
      }
      const status = answers[(seen.length - 1) % answers.length] ?? 200;
      const headers: Record<string, string> =
        status === 307 ? { location: '/next' } : {};
      return Promise.resolve({ status, headers, body: null });
    };
  };

  class MutatingNodeAdapter extends NodeAdapter {
    public readonly seen: unknown[] = [];
    private readonly mutatingSend = makeSend(this.seen);

    public override send(request: AdapterRequest): Promise<AdapterResponse> {
      return this.mutatingSend(request);
    }
  }

  const plainSeen: unknown[] = [];
  const replacedSeen: unknown[] = [];
  const replaced = new NodeAdapter();
  replaced.send = makeSend(replacedSeen);
  const subclass = new MutatingNodeAdapter();
  const cases: Array<{ adapter: HTTPAdapter; seen: unknown[] }> = [
    {
      adapter: { getType: () => 'node', send: makeSend(plainSeen) },
      seen: plainSeen,
    },
    { adapter: subclass, seen: subclass.seen },
    { adapter: replaced, seen: replacedSeen },
  ];

  for (const { adapter, seen } of cases) {
    const client = new HTTPClient({
      adapter,
      baseURL: 'http://api.test',
      followRedirects: true,
      retryPolicy: roundSeventyTwoBRetryPolicy,
    });
    const form = new FormData();
    form.set('a', '1');

    await client
      .put('/start')
      .body(new Uint8Array([1, 2, 3]))
      .send();
    await client.put('/start').formData(form).send();

    expect(seen).toEqual([
      [1, 2, 3],
      [1, 2, 3],
      [1, 2, 3],
      [['a', '1']],
      [['a', '1']],
      [['a', '1']],
    ]);
  }
});

test('a nested param read once decides both whether it overrides the path query and what is sent', async () => {
  const { adapter, urls } = roundSeventyTwoBAdapter([]);
  const client = new HTTPClient({ adapter, baseURL: 'http://api.test' });
  const answering = (first: unknown, then: unknown) => {
    let calls = 0;
    return {
      get number() {
        return calls++ === 0 ? first : then;
      },
    };
  };

  // Absent when first read: the path's `page` is kept, and nothing is added.
  await client
    .get('/x?page=1')
    .params({ page: answering(undefined, 2) })
    .send();
  // Present when first read: it replaces the path's `page`.
  await client
    .get('/x?page=1')
    .params({ page: answering(2, undefined) })
    .send();

  expect(urls).toEqual([
    'http://api.test/x?page=1',
    'http://api.test/x?page%5Bnumber%5D=2',
  ]);
});

test('on a cross-origin hop, a JSON body that serializes to nothing is read as no body, as the attempt sends it', async () => {
  const sendHop = async (
    hopBody: object | undefined,
    retryBody: unknown,
  ): Promise<AdapterRequest[]> => {
    const { adapter, sentToTarget } = crossOriginReplayAdapter(
      'https://evil.example/next',
    );
    const client = new HTTPClient({
      adapter,
      followRedirects: true,
      retryPolicy: crossOriginRetryPolicy,
    });
    client.addRequestInterceptor(
      (request) => ({ ...request, body: retryBody }),
      { phases: ['retry'] },
    );
    const builder = client.put('https://api.example/start');
    await (hopBody === undefined ? builder : builder.json(hopBody)).send();
    return sentToTarget;
  };
  const describeSent = (
    sent: AdapterRequest[],
  ): Array<{ body: unknown; contentType: unknown }> =>
    sent.map((request) => ({
      body: request.body ?? null,
      contentType: request.headers['content-type'],
    }));

  // A hop that sends nothing has nothing to drop: the interceptors' empty string is not
  // sent as an empty `text/plain` body, as it is not on a hop with no body at all.
  const bodiless = describeSent(await sendHop(undefined, ''));
  expect(bodiless).toEqual([
    { body: null, contentType: undefined },
    { body: null, contentType: undefined },
  ]);
  expect(describeSent(await sendHop({ toJSON: () => undefined }, ''))).toEqual(
    bodiless,
  );

  // And the interceptors' body that serializes to nothing drops the hop's, as an empty
  // one does: nothing is sent, and nothing describes a body.
  expect(
    describeSent(await sendHop({ a: 1 }, { toJSON: () => undefined })),
  ).toEqual([
    { body: '{"a":1}', contentType: 'application/json; charset=utf-8' },
    { body: null, contentType: undefined },
  ]);
});

test('a redirect-phase interceptor that edits the body in place changes the next hop, not an upload of the hop that answered still under way', async () => {
  // Answers `/start` with a 307 as soon as its head arrives, then reads nothing for a
  // while, so NodeAdapter is still writing that hop's body when the redirect phase runs.
  // The 307 keeps the connection open (a `Connection: close` there would end that upload),
  // so the client may send its next request on it: each connection is read as a run of
  // requests.
  const received = new Map<string, Buffer>();
  const server = net.createServer((socket) => {
    let buffered = Buffer.alloc(0);
    let head: { path: string; length: number; start: number } | undefined;
    socket.on('error', () => {});
    socket.on('data', (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      for (;;) {
        if (!head) {
          const end = buffered.indexOf('\r\n\r\n');
          if (end < 0) {
            return;
          }
          const text = buffered.subarray(0, end).toString('latin1');
          head = {
            path: text.split(' ')[1] ?? '',
            length: Number(/content-length: (\d+)/i.exec(text)?.[1] ?? 0),
            start: end + 4,
          };
          if (head.path === '/start') {
            socket.write(
              'HTTP/1.1 307 Temporary Redirect\r\nLocation: /next\r\nContent-Length: 0\r\n\r\n',
            );
            socket.pause();
            setTimeout(() => socket.resume(), 300);
          }
        }
        const bodyEnd = head.start + head.length;
        if (buffered.length < bodyEnd) {
          return;
        }
        received.set(head.path, buffered.subarray(head.start, bodyEnd));
        if (head.path !== '/start') {
          socket.end(
            'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok',
          );
          return;
        }
        buffered = buffered.subarray(bodyEnd);
        head = undefined;
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const bigPart = 4 << 20;

  try {
    const client = new HTTPClient({
      adapter: new NodeAdapter(),
      baseURL,
      followRedirects: true,
    });
    client.addRequestInterceptor(
      (request) => {
        const { body } = request;
        if (body instanceof FormData) {
          body.set('tail', 'BBBB');
        } else if (body instanceof Uint8Array) {
          body.fill(0x42, bigPart);
        }
        return request;
      },
      { phases: ['redirect'] },
    );

    const form = new FormData();
    form.append('big', new Blob([new Uint8Array(bigPart)]), 'big.bin');
    form.append('tail', 'AAAA');
    const formResponse = await client.post('/start').formData(form).send();

    expect(formResponse.status).toBe(200);
    expect(received.get('/start')?.toString('latin1')).toContain('AAAA');
    expect(received.get('/start')?.toString('latin1')).not.toContain('BBBB');
    expect(received.get('/next')?.toString('latin1')).toContain('BBBB');
    // The caller's form is its own throughout.
    expect(form.get('tail')).toBe('AAAA');

    received.clear();
    const bytes = new Uint8Array(bigPart + 4).fill(0x41, bigPart);
    const bytesResponse = await client.post('/start').body(bytes).send();

    expect(bytesResponse.status).toBe(200);
    expect(received.get('/start')?.subarray(bigPart).toString('latin1')).toBe(
      'AAAA',
    );
    expect(received.get('/next')?.subarray(bigPart).toString('latin1')).toBe(
      'BBBB',
    );
  } finally {
    server.close();
  }
});

test("a redirect-phase interceptor is handed a copy of the hop's body, never the bytes a built-in adapter was handed", async () => {
  const handed: Uint8Array[] = [];
  // In place of the built-in `send` before the adapter is built, so the adapter records it
  // as its own and the client hands it the request's bytes uncopied.
  const sendSpy = spyOn(NodeAdapter.prototype, 'send').mockImplementation(
    (request: AdapterRequest) => {
      if (request.body instanceof Uint8Array) {
        handed.push(request.body);
      }
      return Promise.resolve<AdapterResponse>(
        handed.length === 1
          ? { status: 307, headers: { location: '/next' }, body: null }
          : { status: 200, headers: {}, body: null },
      );
    },
  );

  try {
    const client = new HTTPClient({
      adapter: new NodeAdapter(),
      baseURL: 'http://api.test',
      followRedirects: true,
    });
    client.addRequestInterceptor(
      (request) => {
        (request.body as Uint8Array).fill(9);
        return request;
      },
      { phases: ['redirect'] },
    );

    await client
      .post('/start')
      .body(new Uint8Array([1, 2, 3, 4]))
      .send();
  } finally {
    sendSpy.mockRestore();
  }

  expect(handed.map((body) => Array.from(body))).toEqual([
    [1, 2, 3, 4],
    [9, 9, 9, 9],
  ]);
});

test('a nested array param is serialized by the keys qs reads, with or without a query in the path', () => {
  const sparse: string[] = [];
  sparse[2] = 'z';
  const params = (): Record<string, unknown> => ({
    a: { b: Object.assign(['x'], { extra: 'y' }), c: sparse },
  });
  const expected = 'a%5Bb%5D%5B0%5D=x&a%5Bb%5D%5Bextra%5D=y&a%5Bc%5D%5B2%5D=z';

  expect(buildURL('http://x', '/s', params())).toBe(`http://x/s?${expected}`);
  expect(buildURL('http://x', '/s?q=1', params())).toBe(
    `http://x/s?q=1&${expected}`,
  );
});

test('FetchAdapter sends a GET whose JSON body serializes to nothing bodiless, and still refuses a GET with an empty body', async () => {
  const sentBodies: unknown[] = [];
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(((
    _url: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    sentBodies.push(init?.body ?? null);
    return Promise.resolve(new Response('ok'));
  }) as unknown as typeof fetch);

  try {
    const client = new HTTPClient({
      adapter: new FetchAdapter(),
      baseURL: 'http://api.test',
    });

    const response = await client
      .get('/x')
      .json({ toJSON: () => undefined })
      .send();

    expect(response.status).toBe(200);
    expect(sentBodies).toEqual([null]);

    // Each of these is a body `fetch` refuses on a GET: refused before any attempt.
    for (const body of ['', new Uint8Array(0), new FormData()]) {
      const builder = client.request('GET', '/x', { body });
      await builder.send();

      expect(builder.error?.code).toBe('request_setup_error');
    }
    expect(sentBodies).toEqual([null]);
  } finally {
    fetchSpy.mockRestore();
  }
});

test('a GET body an interceptor returns is refused on FetchAdapter, though its toJSON answers nothing when asked again', async () => {
  const sentBodies: unknown[] = [];
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(((
    _url: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    sentBodies.push(init?.body ?? null);
    return Promise.resolve(new Response('ok'));
  }) as unknown as typeof fetch);

  try {
    const client = new HTTPClient({
      adapter: new FetchAdapter(),
      baseURL: 'http://api.test',
    });
    // A body the first time it is asked, nothing every time after.
    let calls = 0;
    client.addRequestInterceptor((request) => ({
      ...request,
      body: { toJSON: () => (calls++ === 0 ? { a: 1 } : undefined) },
    }));

    const builder = client.get('/x');
    await builder.send();

    expect(builder.error?.code).toBe('interceptor_error');
    // Asked once, by the copy the rule reads.
    expect(calls).toBe(1);
    expect(sentBodies).toEqual([]);
  } finally {
    fetchSpy.mockRestore();
  }
});

test('a 307 replay of a GET whose JSON body serializes to nothing drops the headers that describe a body', async () => {
  const sentHeaders: Array<Record<string, unknown>> = [];
  const client = new HTTPClient({
    adapter: {
      getType: () => 'node',
      send: (request) => {
        sentHeaders.push(request.headers);
        return Promise.resolve<AdapterResponse>(
          sentHeaders.length % 2 === 1
            ? { status: 307, headers: { location: '/next' }, body: null }
            : { status: 200, headers: {}, body: null },
        );
      },
    },
    baseURL: 'http://api.test',
    followRedirects: true,
  });
  const send = (body: object) =>
    client
      .get('/start')
      .headers({
        'content-type': 'application/json',
        'content-language': 'en',
      })
      .json(body)
      .send();

  await send({ toJSON: () => undefined });
  await send({ a: 1 });

  const replayed = sentHeaders.map((headers) => ({
    type: headers['content-type'],
    language: headers['content-language'],
  }));
  expect(replayed[1]).toEqual({ type: undefined, language: undefined });
  // A body that is sent is replayed with the headers that describe it.
  expect(replayed[3]).toEqual({ type: 'application/json', language: 'en' });
});

/** A `fetch` that answers by path, recording each request's body and headers as sent. */
function spyOnScriptedFetch(answer: (url: URL, call: number) => Response): {
  sent: Array<{ url: string; body: unknown; headers: Headers }>;
  restore: () => void;
} {
  const sent: Array<{ url: string; body: unknown; headers: Headers }> = [];
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(((
    url: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const href =
      typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    sent.push({
      url: href,
      body: init?.body ?? null,
      headers: new Headers(init?.headers),
    });
    return Promise.resolve(answer(new URL(href), sent.length));
  }) as unknown as typeof fetch);
  return { sent, restore: () => fetchSpy.mockRestore() };
}

test('a GET whose JSON body serializes to nothing is sent bodiless on FetchAdapter after an interceptor passes it on, in every phase', async () => {
  const sendGET = async (
    path: string,
    phase: 'initial' | 'retry' | 'redirect',
  ): Promise<{ status: number; code: unknown; bodies: unknown[] }> => {
    let retryCalls = 0;
    const { sent, restore } = spyOnScriptedFetch((url) => {
      if (url.pathname === '/retry' && retryCalls++ === 0) {
        return new Response(null, { status: 503 });
      }
      if (url.pathname === '/redirect') {
        return new Response(null, {
          status: 307,
          headers: { location: '/target' },
        });
      }
      return new Response('ok');
    });
    try {
      const client = new HTTPClient({
        adapter: new FetchAdapter(),
        baseURL: 'http://api.test',
        followRedirects: true,
        retryPolicy: { strategy: 'fixed', maxRetryAttempts: 1, delayMS: 0 },
      });
      client.addRequestInterceptor((request) => request, { phases: [phase] });

      const builder = client.get(path).json({ toJSON: () => undefined });
      const response = await builder.send();
      return {
        status: response.status,
        code: builder.error?.code,
        bodies: sent.map((request) => request.body),
      };
    } finally {
      restore();
    }
  };

  expect(await sendGET('/x', 'initial')).toEqual({
    status: 200,
    code: undefined,
    bodies: [null],
  });
  expect(await sendGET('/retry', 'retry')).toEqual({
    status: 200,
    code: undefined,
    bodies: [null, null],
  });
  expect(await sendGET('/redirect', 'redirect')).toEqual({
    status: 200,
    code: undefined,
    bodies: [null, null],
  });
});

test("an interceptor's GET body on FetchAdapter is judged by the copy that is sent, its type and its serialization failing as before", async () => {
  const { sent, restore } = spyOnScriptedFetch(() => new Response('ok'));
  try {
    const sendGET = async (body: unknown) => {
      const client = new HTTPClient({
        adapter: new FetchAdapter(),
        baseURL: 'http://api.test',
      });
      client.addRequestInterceptor((request) => ({ ...request, body }));
      const builder = client.get('/x');
      const response = await builder.send();
      return { status: response.status, code: builder.error?.code };
    };

    // Nothing the first time it is asked, a body every time after: asked once, by the
    // copy, which serializes to nothing and is what is sent.
    let calls = 0;
    expect(
      await sendGET({ toJSON: () => (calls++ === 0 ? undefined : { a: 1 }) }),
    ).toEqual({ status: 200, code: undefined });
    expect(calls).toBe(1);
    expect(sent.map((request) => request.body)).toEqual([null]);

    // A body the client cannot send is the interceptor's failure, and so, on a GET, is
    // one that cannot be serialized: it cannot serialize to nothing, so the GET is
    // refused whatever it holds.
    expect(await sendGET(new URLSearchParams('a=1'))).toEqual({
      status: 0,
      code: 'interceptor_error',
    });
    expect(
      await sendGET({
        toJSON: () => {
          throw new Error('unserializable');
        },
      }),
    ).toEqual({ status: 0, code: 'interceptor_error' });
    expect(await sendGET({ n: BigInt(1) })).toEqual({
      status: 0,
      code: 'interceptor_error',
    });
    // And a body that is sent is still refused on a GET.
    expect(await sendGET({ a: 1 })).toEqual({
      status: 0,
      code: 'interceptor_error',
    });
    expect(sent).toHaveLength(1);
  } finally {
    restore();
  }
});

test('a 307 replay of a GET on FetchAdapter drops the headers that describe a body for an interceptor-passed JSON body that serializes to nothing', async () => {
  const { sent, restore } = spyOnScriptedFetch((url) =>
    url.pathname === '/start'
      ? new Response(null, { status: 307, headers: { location: '/next' } })
      : new Response('ok'),
  );
  try {
    const client = new HTTPClient({
      adapter: new FetchAdapter(),
      baseURL: 'http://api.test',
      followRedirects: true,
    });
    client.addRequestInterceptor((request) => request);

    const response = await client
      .get('/start')
      .headers({ 'content-type': 'application/json', 'content-language': 'en' })
      .json({ toJSON: () => undefined })
      .send();

    expect(response.status).toBe(200);
    expect(sent.map((request) => request.body)).toEqual([null, null]);
    expect({
      type: sent[1].headers.get('content-type'),
      language: sent[1].headers.get('content-language'),
    }).toEqual({ type: null, language: null });
  } finally {
    restore();
  }
});

test("a retry held to a cross-origin hop's own body is checked on FetchAdapter as it is sent", async () => {
  const sendHop = async (
    method: 'GET' | 'PUT',
    hopBody: object,
    retry: (request: InterceptedRequest) => InterceptedRequest,
  ) => {
    let targetCalls = 0;
    const { sent, restore } = spyOnScriptedFetch((url) => {
      if (url.host === 'api.example') {
        return new Response(null, {
          status: 307,
          headers: { location: 'https://evil.example/next' },
        });
      }
      return new Response(null, { status: targetCalls++ === 0 ? 503 : 200 });
    });
    try {
      const client = new HTTPClient({
        adapter: new FetchAdapter(),
        followRedirects: true,
        retryPolicy: crossOriginRetryPolicy,
        retryNonIdempotentMethods: true,
      });
      client.addRequestInterceptor(retry, { phases: ['retry'] });
      const builder = client
        .request(method, 'https://api.example/start')
        .json(hopBody);
      const response = await builder.send();
      return {
        status: response.status,
        code: builder.error?.code,
        bodies: sent.map((request) => request.body),
      };
    } finally {
      restore();
    }
  };

  // The hop sends nothing, so the retry does, whatever body the interceptors returned:
  // the one they passed on, or one of their own that is not sent.
  for (const retry of [
    (request: InterceptedRequest) => request,
    (request: InterceptedRequest) => ({ ...request, body: { a: 1 } }),
    (request: InterceptedRequest) => ({ ...request, body: '' }),
  ]) {
    expect(await sendHop('GET', { toJSON: () => undefined }, retry)).toEqual({
      status: 200,
      code: undefined,
      bodies: [null, null, null],
    });
  }

  // A method they rewrote to GET over the hop's own body is refused, as theirs.
  expect(
    await sendHop('PUT', { a: 1 }, (request) => ({
      ...request,
      method: 'GET',
    })),
  ).toEqual({
    status: 0,
    code: 'interceptor_error',
    bodies: ['{"a":1}', '{"a":1}'],
  });
});

test("an interceptor's method on FetchAdapter is refused before its body is copied, in every phase", async () => {
  const sendTRACE = async (
    path: string,
    phase: 'initial' | 'retry' | 'redirect',
    body: unknown,
  ) => {
    let retryCalls = 0;
    const { sent, restore } = spyOnScriptedFetch((url) => {
      if (url.pathname === '/retry' && retryCalls++ === 0) {
        return new Response(null, { status: 503 });
      }
      if (url.pathname === '/redirect') {
        return new Response(null, {
          status: 307,
          headers: { location: '/target' },
        });
      }
      return new Response('ok');
    });
    try {
      const client = new HTTPClient({
        adapter: new FetchAdapter(),
        baseURL: 'http://api.test',
        followRedirects: true,
        retryPolicy: { strategy: 'fixed', maxRetryAttempts: 1, delayMS: 0 },
        retryNonIdempotentMethods: true,
      });
      client.addRequestInterceptor(
        (request) => ({ ...request, method: 'TRACE', body }),
        { phases: [phase] },
      );

      const builder = client.post(path).json({ a: 1 });
      await builder.send();
      return {
        code: builder.error?.code,
        attemptCount: builder.attemptCount,
        sent: sent.length,
      };
    } finally {
      restore();
    }
  };

  // A body that cannot be copied does not turn the interceptor's refused method into the
  // body's failure.
  expect(await sendTRACE('/x', 'initial', { n: BigInt(1) })).toEqual({
    code: 'interceptor_error',
    attemptCount: null,
    sent: 0,
  });
  expect(await sendTRACE('/retry', 'retry', { n: BigInt(1) })).toEqual({
    code: 'interceptor_error',
    attemptCount: 2,
    sent: 1,
  });
  expect(await sendTRACE('/redirect', 'redirect', { n: BigInt(1) })).toEqual({
    code: 'interceptor_error',
    attemptCount: 1,
    sent: 1,
  });

  // Nor is a body serialized for a request that is refused.
  let calls = 0;
  const counted = {
    toJSON: () => {
      calls++;
      return { a: 1 };
    },
  };
  for (const [path, phase] of [
    ['/x', 'initial'],
    ['/retry', 'retry'],
    ['/redirect', 'redirect'],
  ] as const) {
    expect((await sendTRACE(path, phase, counted)).code).toBe(
      'interceptor_error',
    );
  }
  expect(calls).toBe(0);
});

test('in a browser, a header an interceptor adds that FetchAdapter refuses is its failure, though its body cannot be copied', async () => {
  const saved = {
    window: Object.getOwnPropertyDescriptor(globalThis, 'window'),
    document: Object.getOwnPropertyDescriptor(globalThis, 'document'),
  };
  for (const name of ['window', 'document']) {
    Object.defineProperty(globalThis, name, {
      value: {},
      configurable: true,
      writable: true,
    });
  }
  const { sent, restore } = spyOnScriptedFetch(() => new Response('ok'));

  try {
    const client = new HTTPClient({
      adapter: new FetchAdapter(),
      baseURL: 'http://api.test',
    });
    client.addRequestInterceptor((request) => ({
      ...request,
      headers: { ...request.headers, 'sec-test': '1' },
      body: { n: BigInt(1) },
    }));

    const builder = client.post('/x').json({ a: 1 });
    await builder.send();

    expect({
      code: builder.error?.code,
      attemptCount: builder.attemptCount,
    }).toEqual({ code: 'interceptor_error', attemptCount: null });
    expect(sent).toEqual([]);
  } finally {
    restore();
    for (const [name, descriptor] of Object.entries(saved)) {
      if (descriptor === undefined) {
        delete (globalThis as Record<string, unknown>)[name];
      } else {
        Object.defineProperty(globalThis, name, descriptor);
      }
    }
  }
});

test("an interceptor's URL that cannot be sent is its failure on FetchAdapter, though the caller's GET carries a body", async () => {
  const { sent, restore } = spyOnScriptedFetch(() => new Response('ok'));
  try {
    const client = new HTTPClient({
      adapter: new FetchAdapter(),
      baseURL: 'http://api.test',
    });
    client.addRequestInterceptor((request) => ({
      ...request,
      requestURL: 'ftp://x/',
    }));

    const builder = client.get('/x').json({ a: 1 });
    await builder.send();

    expect({
      code: builder.error?.code,
      attemptCount: builder.attemptCount,
    }).toEqual({ code: 'interceptor_error', attemptCount: null });
    expect(sent).toEqual([]);
  } finally {
    restore();
  }
});

test("an interceptor's GET or HEAD on FetchAdapter is refused, not the body's failure, though its body cannot be copied, in every phase", async () => {
  const send = async (
    path: string,
    phase: 'initial' | 'retry' | 'redirect',
    method: string,
    body: unknown,
  ) => {
    let retryCalls = 0;
    const { sent, restore } = spyOnScriptedFetch((url) => {
      if (url.pathname === '/retry' && retryCalls++ === 0) {
        return new Response(null, { status: 503 });
      }
      if (url.pathname === '/redirect') {
        return new Response(null, {
          status: 307,
          headers: { location: '/target' },
        });
      }
      return new Response('ok');
    });
    try {
      const client = new HTTPClient({
        adapter: new FetchAdapter(),
        baseURL: 'http://api.test',
        followRedirects: true,
        retryPolicy: { strategy: 'fixed', maxRetryAttempts: 1, delayMS: 0 },
        retryNonIdempotentMethods: true,
      });
      client.addRequestInterceptor(
        (request) => ({ ...request, method, body }),
        { phases: [phase] },
      );

      const builder = client.post(path).json({ a: 1 });
      await builder.send();
      return {
        code: builder.error?.code,
        attemptCount: builder.attemptCount,
        sent: sent.length,
        message: String(builder.error?.cause?.message),
      };
    } finally {
      restore();
    }
  };

  const unserializable = {
    toJSON: () => {
      throw new Error('unserializable');
    },
  };
  for (const method of ['GET', 'HEAD']) {
    for (const body of [{ n: BigInt(1) }, unserializable]) {
      const refusal = `[FetchAdapter] Cannot send a ${method} request with a body: fetch refuses one. Use NodeAdapter, or send the body with POST.`;
      expect(await send('/x', 'initial', method, body)).toEqual({
        code: 'interceptor_error',
        attemptCount: null,
        sent: 0,
        message: refusal,
      });
      expect(await send('/retry', 'retry', method, body)).toEqual({
        code: 'interceptor_error',
        attemptCount: 2,
        sent: 1,
        message: refusal,
      });
      expect(await send('/redirect', 'redirect', method, body)).toEqual({
        code: 'interceptor_error',
        attemptCount: 1,
        sent: 1,
        message: refusal,
      });
    }
  }

  // On any other method it is still the body's failure.
  expect(await send('/x', 'initial', 'POST', { n: BigInt(1) })).toMatchObject({
    code: 'request_setup_error',
    attemptCount: 0,
    sent: 0,
  });
  expect(await send('/retry', 'retry', 'PUT', { n: BigInt(1) })).toMatchObject({
    code: 'request_setup_error',
    attemptCount: 2,
    sent: 1,
  });
  expect(
    await send('/redirect', 'redirect', 'POST', { n: BigInt(1) }),
  ).toMatchObject({ code: 'request_setup_error', attemptCount: 1, sent: 1 });
});

test("a caller's own TRACE on FetchAdapter whose body serializes to nothing is its setup error through a pass-through interceptor, as without one", async () => {
  const { sent, restore } = spyOnScriptedFetch(() => new Response('ok'));
  try {
    const sendTRACE = async (hasInterceptor: boolean) => {
      const client = new HTTPClient({
        adapter: new FetchAdapter(),
        baseURL: 'http://api.test',
      });
      if (hasInterceptor) {
        client.addRequestInterceptor((request) => request);
      }
      const builder = client
        .request('TRACE', '/x')
        .json({ toJSON: () => undefined });
      await builder.send();
      return { code: builder.error?.code, attemptCount: builder.attemptCount };
    };

    const expected = { code: 'request_setup_error', attemptCount: 0 } as const;
    expect(await sendTRACE(false)).toEqual(expected);
    expect(await sendTRACE(true)).toEqual(expected);
    expect(sent).toEqual([]);
  } finally {
    restore();
  }
});

test('a filter list is read by index, not through its own iterator', async () => {
  // An array whose own iterator yields entries other than those it holds.
  const withIterator = <T>(entries: T[], yields: unknown[]): T[] => {
    Object.defineProperty(entries, Symbol.iterator, {
      value: () => yields[Symbol.iterator](),
    });
    return entries;
  };
  const thrown = (run: () => unknown): string => {
    try {
      run();
    } catch (error) {
      return (error as Error).message;
    }
    return 'nothing thrown';
  };

  // The entries checked are the ones held, whatever the iterator yields.
  expect(
    thrown(() =>
      new HTTPClient().addRequestInterceptor((request) => request, {
        hosts: withIterator([7 as never], ['a.test']),
      }),
    ),
  ).toBe(
    'HTTPClient request interceptor filter hosts[0] must be a string (got number)',
  );
  expect(
    thrown(() =>
      new HTTPClient().addRequestInterceptor((request) => request, {
        methods: withIterator(['GET, POST'], ['GET']),
      }),
    ),
  ).toBe(
    'HTTPClient request interceptor filter methods[0] is not a valid HTTP method name (got a string with characters an HTTP token does not allow)',
  );
  // A hole is still read as the `undefined` it is, and refused.
  expect(
    thrown(() =>
      new HTTPClient().addRequestInterceptor((request) => request, {
        // eslint-disable-next-line no-sparse-arrays
        hosts: ['a.test', , 'b.test'] as string[],
      }),
    ),
  ).toBe(
    'HTTPClient request interceptor filter hosts[1] must be a string (got undefined)',
  );

  // And the entries held are the ones matched.
  const adapter = new MockAdapter();
  adapter.routes.get('/x', () => ({ status: 200 }));
  adapter.routes.post('/x', () => ({ status: 200 }));
  const client = new HTTPClient({ adapter, baseURL: 'http://mock.test' });
  const seen: string[] = [];
  client.addRequestInterceptor(
    (request) => {
      seen.push(`${request.method} ${request.requestURL}`);
      return request;
    },
    {
      methods: withIterator(['GET'], ['POST']),
      hosts: withIterator(['mock.test'], ['other.test']),
    },
  );
  await client.get('/x').send();
  await client.post('/x').send();

  expect(seen).toEqual(['GET http://mock.test/x']);
});

test('every refusal XHRAdapter makes in a browser names it as XHRAdapter', async () => {
  const names = ['window', 'document', 'XMLHttpRequest'] as const;
  const saved = names.map(
    (name) =>
      [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
  );
  let xhrCount = 0;
  const globals: Record<string, unknown> = {
    window: {},
    document: {},
    XMLHttpRequest: class {
      constructor() {
        xhrCount++;
      }
    },
  };
  for (const name of names) {
    Object.defineProperty(globalThis, name, {
      value: globals[name],
      configurable: true,
      writable: true,
    });
  }

  try {
    const client = new HTTPClient({
      adapter: new XHRAdapter(),
      baseURL: 'http://api.test',
      followRedirects: false,
    });
    const refusalOf = async (
      builder: ReturnType<typeof client.get>,
    ): Promise<string | undefined> => {
      await builder.send();
      return builder.error?.cause?.message;
    };

    expect(
      await refusalOf(client.get('/x', { headers: { 'sec-test': '1' } })),
    ).toStartWith("[XHRAdapter] Cannot set header 'sec-test'");
    expect(await refusalOf(client.request('TRACE', '/x'))).toStartWith(
      '[XHRAdapter] Cannot send a TRACE request',
    );
    expect(await refusalOf(client.get('/x').json({ a: 1 }))).toStartWith(
      '[XHRAdapter] Cannot send a GET request with a body',
    );
    expect(xhrCount).toBe(0);
  } finally {
    for (const [name, descriptor] of saved) {
      if (descriptor === undefined) {
        delete (globalThis as Record<string, unknown>)[name];
      } else {
        Object.defineProperty(globalThis, name, descriptor);
      }
    }
  }
});

test("a retry interceptor's body on a cross-origin hop held to its own is not serialized to learn whether it sends nothing", async () => {
  const sendHop = async (retryBody: unknown) => {
    const { adapter, sentToTarget } = crossOriginReplayAdapter(
      'https://evil.example/next',
    );
    const client = new HTTPClient({
      adapter,
      followRedirects: true,
      retryPolicy: crossOriginRetryPolicy,
    });
    client.addRequestInterceptor(
      (request) => ({ ...request, body: retryBody }),
      { phases: ['retry'] },
    );
    const builder = client.put('https://api.example/start').json({ a: 1 });
    await builder.send();
    return {
      code: builder.error?.code,
      bodies: sentToTarget.map((request) => request.body ?? null),
    };
  };
  const held = { code: undefined, bodies: ['{"a":1}', '{"a":1}'] };
  const dropped = { code: undefined, bodies: ['{"a":1}', null] };

  // A large body that sends something: the hop's own is sent, and the interceptors' is
  // never handed to `JSON.stringify`.
  const large = {
    items: Array.from({ length: 10_000 }, (_, index) => ({ index })),
  };
  const stringify = spyOn(JSON, 'stringify');
  try {
    expect(await sendHop(large)).toEqual(held);
    expect(stringify.mock.calls.some(([value]) => value === large)).toBe(false);
  } finally {
    stringify.mockRestore();
  }

  // What it serializes to is still read by its top-level `toJSON`, as `JSON.stringify`
  // reads it: an answer it writes nothing for drops the hop's body, any other is held,
  // and a `toJSON` that throws holds it as before.
  let toJSONCalls: unknown[][] = [];
  const answering = (answer: () => unknown): object => ({
    toJSON(...args: unknown[]) {
      toJSONCalls.push(args);
      return answer();
    },
  });
  for (const answer of [() => undefined, () => Symbol('s'), () => () => 1]) {
    toJSONCalls = [];
    expect(await sendHop(answering(answer))).toEqual(dropped);
    expect(toJSONCalls).toEqual([['']]);
  }
  for (const answer of [
    () => null,
    () => '',
    () => ({ n: BigInt(1) }),
    () => {
      throw new Error('toJSON failed');
    },
  ]) {
    expect(await sendHop(answering(answer))).toEqual(held);
  }
  const array = Object.assign([1, 2], { toJSON: () => undefined });
  expect(await sendHop(array)).toEqual(dropped);
  expect(await sendHop([1, 2])).toEqual(held);
  // An inherited one is read as an own one is.
  class Silent extends Array<number> {
    public toJSON(): undefined {
      return undefined;
    }
  }
  expect(await sendHop(Silent.from([1, 2]))).toEqual(dropped);
});

test('a Buffer body reaches every request interceptor and observer as a Buffer, and other bytes as a plain Uint8Array', async () => {
  const contentTypes: unknown[] = [];
  const { adapter, sent } = roundSeventyTwoBAdapter([
    { status: 307, location: '/next' },
    { status: 503 },
    { status: 200 },
  ]);
  const recordingAdapter: HTTPAdapter = {
    getType: () => adapter.getType(),
    send: (request) => {
      contentTypes.push(request.headers['content-type']);
      return adapter.send(request);
    },
  };
  const client = new HTTPClient({
    adapter: recordingAdapter,
    baseURL: 'http://api.test',
    followRedirects: true,
    retryPolicy: roundSeventyTwoBRetryPolicy,
    retryNonIdempotentMethods: true,
  });
  const seen: Array<{ phase: string; isBuffer: boolean; text: string }> = [];
  for (const phase of ['initial', 'redirect', 'retry'] as const) {
    client.addRequestInterceptor(
      (request) => {
        const body = request.body as Buffer;
        seen.push({
          phase,
          isBuffer: Buffer.isBuffer(body),
          text: body.toString('base64'),
        });
        return request;
      },
      { phases: [phase] },
    );
  }
  const observed: Array<{ body: boolean; rawBody: boolean }> = [];
  client.addResponseObserver((_response, request) => {
    observed.push({
      body: Buffer.isBuffer(request.body),
      rawBody: Buffer.isBuffer(request.rawBody),
    });
  });

  const buffer = Buffer.from('hello');
  await client.post('/x').body(buffer).send();
  expect(seen).toEqual([
    { phase: 'initial', isBuffer: true, text: 'aGVsbG8=' },
    { phase: 'redirect', isBuffer: true, text: 'aGVsbG8=' },
    { phase: 'retry', isBuffer: true, text: 'aGVsbG8=' },
  ]);
  expect(observed).toEqual([{ body: true, rawBody: true }]);
  const hello = Array.from(Buffer.from('hello'));
  expect(sent).toEqual([hello, hello, hello]);
  expect(contentTypes).toEqual([
    'application/octet-stream',
    'application/octet-stream',
    'application/octet-stream',
  ]);

  // Any other bytes - a subclass, or another realm's - are a plain `Uint8Array`.
  class Tagged extends Uint8Array {}
  const others: unknown[] = [
    new Uint8Array([1, 2]),
    new Tagged([1, 2]),
    vm.runInNewContext('new Uint8Array([1, 2])'),
  ];
  for (const bytes of others) {
    const handed: unknown[] = [];
    const plain = new HTTPClient({
      adapter: roundSeventyTwoBAdapter([]).adapter,
      baseURL: 'http://api.test',
    });
    plain.addRequestInterceptor((request) => {
      handed.push(request.body);
      return request;
    });
    await plain.post('/x').body(bytes).send();
    expect(handed).toHaveLength(1);
    expect(Object.getPrototypeOf(handed[0])).toBe(Uint8Array.prototype);
    expect(Array.from(handed[0] as Uint8Array)).toEqual([1, 2]);
  }
});

test('a content coding is read in ASCII case and trimmed of HTTP whitespace only', () => {
  expect(isIdentityContentEncoding('IDENTITY,\t ')).toBe(true);
  // NO-BREAK SPACE is not HTTP whitespace: `\u00A0identity` is not a coding `fetch` knows.
  expect(isIdentityContentEncoding('\u00A0identity')).toBe(false);

  const decoded = createResponseBodySource(stubResponse(), ' GZIP\t');
  decoded.release();
  expect(decoded.isDecoded).toBe(true);

  const unknown = createResponseBodySource(stubResponse(), '\u00A0gzip');
  unknown.release();
  expect(unknown.isDecoded).toBe(false);
});

test('a contentTypeHeaders entry trimmed of a no-break space is refused, since no header could match it', () => {
  const client = new HTTPClient();
  expect(() =>
    client.addResponseObserver(() => {}, {
      contentTypeHeaders: ['\u00A0application/json'],
    }),
  ).toThrow(TypeError);
  expect(() =>
    client.addResponseObserver(() => {}, {
      contentTypeHeaders: [' application/json\t'],
    }),
  ).not.toThrow();
});

test('a hosts entry with a no-break space beside * is refused, not read as the global *', async () => {
  const client = new HTTPClient();
  for (const entry of [' *', '* ', '  api.example.com']) {
    expect(() =>
      client.addRequestInterceptor((request) => request, { hosts: [entry] }),
    ).toThrow(TypeError);
  }
  // A filter not registered through a client matches no host with one either.
  expect(
    matchesFilter(
      { hosts: [' *'] },
      { requestURL: 'https://other.test/x' },
      'request',
    ),
  ).toBe(false);

  const adapter = new MockAdapter();
  adapter.routes.get('/x', () => ({ status: 200 }));
  const scoped = new HTTPClient({ adapter });
  const seen: string[] = [];
  scoped.addRequestInterceptor(
    (request) => {
      seen.push('*');
      return request;
    },
    { hosts: ['*'] },
  );
  scoped.addRequestInterceptor(
    (request) => {
      seen.push('spaced');
      return request;
    },
    { hosts: [' *\t'] },
  );
  await scoped.get('http://other.test/x').send();
  expect(seen).toEqual(['*', 'spaced']);
});

test('a Content-Length is trimmed of HTTP whitespace only', () => {
  expect(parseContentLength(' 10\t')).toBe(10);
  expect(parseContentLength(['10 ', '\t10'])).toBe(10);
  // NO-BREAK SPACE is not HTTP whitespace: Fetch and Node read no length from these.
  expect(parseContentLength('10\u00A0')).toBeUndefined();
  expect(parseContentLength('\u00A010')).toBeUndefined();
});

test('repeated Content-Length values agree by their digits, not as numbers', () => {
  // 2^53 + 1 and 2^53 convert to the same number.
  expect(
    parseContentLength('9007199254740993, 9007199254740992'),
  ).toBeUndefined();
  expect(
    parseContentLength(['9007199254740993', '9007199254740992']),
  ).toBeUndefined();
  // Leading zeros state the same length.
  expect(parseContentLength('010, 10')).toBe(10);
  expect(parseContentLength('0, 000')).toBe(0);
  expect(parseContentLength('9007199254740993, 9007199254740993')).toBe(
    9007199254740992,
  );
});
