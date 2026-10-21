import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import vm from 'node:vm';
import * as http from 'node:http';
import * as zlib from 'node:zlib';
import { PassThrough, Writable } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { HTTPClient } from './http-client';
import {
  buildURL,
  extractFetchHeaders,
  matchesFilter,
  normalizeHostPatterns,
  mergeHeaders,
  parseContentType,
  stripCrossOriginURLCredentials,
} from './utils';
import { deepClone } from '../deep-clone';
import {
  DEFAULT_MAX_RESPONSE_BYTES,
  RESPONSE_STREAM_ABORT_FLAG,
  STREAM_ABORT_HEADERS_KEY,
  STREAM_ABORT_STATUS_KEY,
} from './consts';
import { CookieJar } from './cookie-jar';
import {
  isBrowserRestrictedHeader,
  materializeRequestHeaders,
} from './internal/header-utils';
import { knownBodyByteLength } from './internal/progress';
import { createResponseBodySource } from './internal/response-decoding';
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
import type { MockRequest } from './adapters/mock-adapter';
import { NodeAdapter } from './adapters/node-adapter';
import { getRevocationFixtures } from './test-helpers/https-test-server';
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

test('round 99: extension and other single-label opaque origins can be allowlisted; opaque hosts keep their dots', () => {
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

test('round 100: an opaque origin with Unicode dots is refused before the IP branch', () => {
  for (const entry of ['foo://1。2。3。4', 'chrome-extension://1。2。3。4']) {
    expect(validateConfigEntry(entry, 'origin').valid).toBe(false);
    expect(matchesOriginList(entry, [entry])).toBe(false);
  }
  expect(validateConfigEntry('foo://1.2.3.4', 'origin').valid).toBe(true);
  expect(matchesOriginList('foo://1.2.3.4', ['foo://1.2.3.4'])).toBe(true);
});

test('round 101: a decoded trailing dot after an IPv4 address, file: origins, percent-encoded origin hosts', () => {
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

test('round 102: one trailing empty label in all, the scheme after leading whitespace, percent hosts in the wildcard matcher', () => {
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

test('round 103: origins read as the parser reads their text, in the scheme:// form only', () => {
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

test('round 104: extra slashes or a backslash after scheme:// are refused', () => {
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

test('round 105: Unicode dots are folded in the authority only', () => {
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

test('round 106: NodeAdapter drops a bodiless Content-Length, refuses Upgrade/CONNECT and unsendable bodies, sends no progress after a cancel', async () => {
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

test('round 107: an adapter answer without a body field is delivered; a dropped Content-Length is not reported as sent', async () => {
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

test('round 108: a shared factory error does not mix requests; cancel and timeout are exclusive; detectedRedirectURL as written', async () => {
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
  expect(refused.error?.detectedRedirectURL).toBe(
    'https://admin:secret@other.test/y',
  );
});

test("round 109: an adapter never flags the caller's own error in place", async () => {
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

test('round 110: underscore suffix overrides; a sub-second mock maxAge keeps the cookie', async () => {
  const jar = new CookieJar({ publicSuffixes: { add: ['svc.my_net'] } });
  jar.parseSetCookieHeader('t=1; Domain=svc.my_net', 'http://a.svc.my_net/');
  expect(jar.getCookieHeaderString('http://b.svc.my_net/')).toBe('');

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

test('round 111: FetchAdapter refusals at dispatch are not retried; terminal upload events count bytes; browser adapters never flag the caller error', async () => {
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

test('round 112: decoded bodies hold their end/error for a streamed reader; a Range request asks for identity', async () => {
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

test('round 113: decoding stops on a timeout, a truncated body is a stream error, stacked codings decode', async () => {
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

test('round 114: host-only and domain cookies are two cookies; header order, trimming, attribute size, nameless cookies', () => {
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

test('round 115: a long content-coding chain is refused; the adapter Accept-Encoding is not carried to a redirect hop', async () => {
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
    test(`${name}: a buffered body over the limit fails as response_too_large, keeping its status, and is not retried`, async () => {
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
      expect(builder.error?.isRetriesExhausted).toBe(false);
      expect(hits.get('/big-503')).toBe(1);
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

test('round 117: redirect_disabled carries no cause from the hop body', async () => {
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

test("round 118: a custom adapter's stream code is held to the stream codes; attribute size counts wire octets", async () => {
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

test('round 119: polyfilled fetch bodies, custom adapter bodies over the limit, caller Accept-Encoding across origins', async () => {
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

test('round 120: polyfilled fetch bodies are read incrementally and released; an inner raw deflate decodes', async () => {
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

test('round 121: bytes after a compressed stream are a stream error for every coding, and a stacked deflate does not hang', async () => {
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

test('round 122: trailing bytes in the last chunk of an ended response are a stream error too', async () => {
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

test('round 123: a large stacked deflate with trailing bytes fails; gzip zero padding is accepted', async () => {
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

test('round 126: a redirect whose body only fails to decode is followed; a cut-off 3xx is not', async () => {
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

test('round 127: a followed decode-failed redirect leaves no error behind; a 503 that only fails to decode is retried', async () => {
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

test('round 128: a plain ArrayBuffer body is held to maxResponseBytes', async () => {
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

test("round 128: an earlier hop's cause is not the next hop's", async () => {
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

test('round 128: a jar that throws for the redirect target still names the redirect', async () => {
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

test('round 128: a tab inside a cookie value is kept', () => {
  // A tab inside a cookie value is kept.
  const jar = new CookieJar();
  jar.processResponseHeaders(
    { 'set-cookie': ['a=x\ty', 'b=x y'] },
    'https://example.com/',
  );
  expect(jar.getCookieHeaderString('https://example.com/')).toContain('a=x\ty');
});

test('round 128: `*.` is no global wildcard', () => {
  // `*.` is no global wildcard.
  expect(matchesWildcardDomain('evil.com', '*.')).toBe(false);
  expect(matchesDomainList('evil.com', ['*.'])).toBe(false);
  expect(matchesOriginList('https://evil.com', ['*.'])).toBe(false);
});

test('round 128: credentials go from every network-path spelling when the initial URL is relative', () => {
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

test('round 128: one bracket is no IPv6 literal', () => {
  // One bracket is no IPv6 literal.
  expect(isIPv6('[::1')).toBe(false);
  expect(normalizeDomain('[::1')).toBe('');
  expect(matchesDomainList('::1', ['[::1'])).toBe(false);
});

test('round 128: FetchAdapter reads a lowercase head as bodiless; a caller refusal counts 0 attempts with an interceptor', async () => {
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
  'round 129: a zstd body cut short is a stream error, as gzip, br and deflate are',
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

test('round 129: a cancel between hops carries no cause from the 3xx it leaves', async () => {
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

test('round 129: a jar that throws for the redirect target reports the target as requestURL', async () => {
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

test('round 129: a string body from a custom adapter is held to maxResponseBytes', async () => {
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

test('round 129: cookie names refuse a tab; values keep one', () => {
  const jar = new CookieJar();
  const base = { domain: 'example.com', path: '/', value: '1' };
  expect(jar.setCookie({ ...base, name: 'a\tb' })).toBe(false);
  jar.processResponseHeaders(
    { 'set-cookie': ['c\td=1', 'e=x\ty'] },
    'https://example.com/',
  );
  expect(jar.getCookieHeaderString('https://example.com/')).toBe('e=x\ty');
});

test('round 129: Domain=..example.com and SameSite=None without Secure are ignored', () => {
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

test('round 129: a cookie replacing an expired one takes its own place in the header', async () => {
  const jar = new CookieJar();
  // Stored already expired, and not yet purged; host-only, so `a=new` replaces it.
  expect(
    jar.setCookie({
      name: 'a',
      value: 'old',
      domain: 'example.com',
      hostOnly: true,
      path: '/',
      maxAge: 0,
      createdAt: Date.now() - 10_000,
    }),
  ).toBe(true);
  await sleep(2);
  jar.processResponseHeaders({ 'set-cookie': 'b=1' }, 'https://example.com/');
  await sleep(2);
  jar.processResponseHeaders({ 'set-cookie': 'a=new' }, 'https://example.com/');
  expect(jar.getCookieHeaderString('https://example.com/')).toBe('b=1; a=new');
});

test('round 129: MockAdapter drops a path-only URL fragment and a 1xx body', async () => {
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

test('round 129: credentials-list trailing-dot wildcards and whitespace in origin patterns', () => {
  expect(
    matchesCORSCredentialsList(
      'https://a.example.com',
      ['https://*.example.com.'],
      { allowWildcardSubdomains: true },
    ),
  ).toBe(true);
  expect(matchesOriginList('https://evil.com', ['https:// *'])).toBe(false);
});

test('round 130: a status-0 answer carries its errorCause without isTransportError', async () => {
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

test('round 130: origin matchers agree with validateConfigEntry on whitespace and empty extras', () => {
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

test('round 130: MockAdapter never serializes a streamError route body', async () => {
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

test('round 130: each callback is handed its own copy of the redirect hop', async () => {
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

test('round 131: each observer and interceptor in a chain gets its own phase', async () => {
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

test('round 131: a trailing space after a protocol wildcard still matches; a Unicode dot in a Set-Cookie Domain is non-ASCII', () => {
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
  // Ignored whole, as RFC 6265bis ignores a non-ASCII Domain (round 132).
  expect(jar.getAllCookies()).toEqual([]);
});

test('round 132: a coding chain refused as too long is a decode failure, so a 503 is retried', async () => {
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

test('round 132: a nameless cookie posing as a prefix is ignored whole', () => {
  const jar = new CookieJar();
  jar.parseSetCookieHeader('flag', 'https://n.example/');
  jar.parseSetCookieHeader('__Host-x; Max-Age=0', 'https://n.example/');
  expect(jar.getCookieHeaderString('https://n.example/')).toBe('flag');
});

test('round 132: the last SameSite wins, an unrecognized one included', () => {
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

test('round 132: each interceptor gets its own context', async () => {
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

test('round 132: the credentials list and wildcard origins trim as the validator does', () => {
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

test('round 132: whitespace inside a wildcard pattern is refused, as in an exact entry', () => {
  for (const pattern of ['*.example .com', '*. example.com']) {
    expect(validateConfigEntry(pattern, 'domain').valid).toBe(false);
    expect(matchesDomainList('a.example.com', [pattern])).toBe(false);
  }
});

test('round 132: a name is at most 253 characters', () => {
  const label = 'a'.repeat(63);
  const tooLong = [label, label, label, label].join('.'); // 255 characters
  const longest = [label, label, label, 'a'.repeat(61)].join('.'); // 253
  expect(normalizeDomain(tooLong)).toBe('');
  expect(normalizeDomain(longest)).toBe(longest);
});

test('round 133: no wildcard over a tail a PSL wildcard rule makes every child of a suffix', () => {
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

test('round 133: a trailing dot is not a label toward the 127-label cap', () => {
  expect(checkDNSLength('x.'.repeat(127))).toBe(true);
  expect(checkDNSLength(`${'x.'.repeat(126)}x`)).toBe(true);
  // 128 labels, refused - by the 253-character limit, which no 128-label name meets.
  expect(checkDNSLength(`${'x.'.repeat(127)}x`)).toBe(false);
});

test('round 134: every IPv6 form the URL parser reads is an IPv6 literal, brackets kept', () => {
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

test('round 134: a bare cookie attribute reads as one with an empty value', () => {
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

test('round 134: a publicSuffixes entry ending in a number is refused', () => {
  for (const entry of ['10.0.0.1', 'corp.123']) {
    expect(() => new CookieJar({ publicSuffixes: { add: [entry] } })).toThrow(
      TypeError,
    );
  }
  expect(
    () => new CookieJar({ publicSuffixes: { add: ['corp.internal'] } }),
  ).not.toThrow();
});

test('round 134: MockAdapter echoes req.params; NodeAdapter joins case-variant header names', async () => {
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

test('round 134: a redirect hop cancelled before it went out is detected, not followed', async () => {
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

test('round 134: an observer rawBody keeps an own __proto__ key; builder.response is set for final observers', async () => {
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

test('round 135: FetchAdapter keeps a __proto__ header beside a Content-Length and joins case-variant cookies', async () => {
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

test('round 135: setCookie refuses a non-boolean flag; fromJSON reads a null one as absent', () => {
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

test('round 135: setCookie accepts a Date from another realm', () => {
  const jar = new CookieJar();
  const expires = vm.runInNewContext('new Date(Date.now() + 3600000)') as Date;
  expect(
    jar.setCookie({ name: 'a', value: '1', domain: 'example.com', expires }),
  ).toBe(true);
  expect(jar.getAllCookies()[0]?.expires).toBeInstanceOf(Date);
  expect(jar.getCookieHeaderString('https://example.com/')).toBe('a=1');
});

test('round 135: a malformed publicSuffixes config throws', () => {
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

test('round 135: a trailing dot IDNA mapping exposes is one trailing dot', () => {
  expect(normalizeDomain('example.com.\u00AD')).toBe('example.com');
  expect(normalizeDomain('example.com.\u00AD.')).toBe('');
  expect(validateConfigEntry('com.\u00AD', 'domain').valid).toBe(false);
  expect(matchesDomainList('example.com', ['example.com.\u00AD'])).toBe(true);
});

test('round 135: a same-scheme URL without slashes is read on its own for credentials', () => {
  expect(
    stripCrossOriginURLCredentials('https:u:p@b.com/x', 'https://a.com/'),
  ).toBe('https://b.com/x');
});

test('round 135: header names are lowercased in ASCII only', () => {
  const kelvin = 'X-Key';
  expect(mergeHeaders({ [kelvin]: 'v' })).toEqual({ [`x-Key`]: 'v' });
});

test('round 135: deepClone copies a Buffer, a DataView and an ArrayBuffer', () => {
  const buffer = Buffer.from('abc');
  const copy = deepClone(buffer);
  copy[0] = 0x7a;
  expect(buffer.toString()).toBe('abc');

  const view = new DataView(new ArrayBuffer(2));
  view.setUint8(1, 9);
  const viewCopy = deepClone({ view }).view;
  expect(viewCopy).toBeInstanceOf(DataView);
  expect(viewCopy.getUint8(1)).toBe(9);

  const arrayBuffer = new ArrayBuffer(3);
  expect(deepClone(arrayBuffer)).toBeInstanceOf(ArrayBuffer);
  expect(deepClone(arrayBuffer)).not.toBe(arrayBuffer);
});

test('round 135: NodeAdapter refuses a non-http scheme and does not retry a malformed userinfo escape', async () => {
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

test('round 135: a late cancel keeps a redirect detected with no target to name', async () => {
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

test('round 136: a word-final Σ is read as the URL parser reads it; "null" is never a domain match; hex suffix tails refused', () => {
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

test('round 136: a Kelvin-sign header name is not grouped with a real one on the way out', () => {
  expect(materializeRequestHeaders({ 'x-key': 'a', 'X-Key': 'b' })).toEqual({
    'x-key': 'a',
    'X-Key': 'b',
  });
});

test('round 136: a CRL with a leading byte-order mark, or in a view at an offset, is read', () => {
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

test('round 136: a cross-origin Location password never reaches redirect-phase observers or interceptors', async () => {
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

test('round 136: a thrown failure on a POST names the method as why it was not retried', async () => {
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

test('round 137: a combining mark that maps to a letter is read in the URL parser order', () => {
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

test('round 137: MockAdapter groups request header names in ASCII case only', async () => {
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

test('round 137: a cookie domain whose trailing dot only IDNA mapping exposes is stored as the domain', () => {
  const jar = new CookieJar();
  jar.setCookie({ name: 'sid', value: 'a', domain: 'example.com' });
  jar.setCookie({ name: 'sid', value: 'b', domain: 'example.com.\u00AD' });
  expect(jar.getStoredDomains()).toEqual([{ domain: 'example.com', count: 1 }]);
  expect(jar.getCookieHeaderString('https://example.com/')).toBe('sid=b');
});

test('round 137: NodeAdapter refuses an Expect header; a decode failure during stream setup keeps its cause', async () => {
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

test('round 137: maxRedirects must be a whole number; a request path must be a string', () => {
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

test('round 138: a decomposed Unicode label is measured composed; an Expect header is refused even without a body; a hostile path value is described', async () => {
  const label = 'é'.repeat(35); // 70 code units, 35 once composed
  expect(normalizeDomain(`${label}.example.com`)).not.toBe('');
  expect(validateConfigEntry(`*.${label}.example.com`, 'domain').valid).toBe(
    true,
  );

  // Refused bodiless too (round 139): Node sent it chunked rather than with no length.
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

  // A label TR46 shortens (soft hyphens map to nothing) is no longer refused before it.
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

test('round 140: a decode failure after the raw body ended reaches a pending stream setup', async () => {
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

test('round 140: a hostile body is of unknown size, not a throw; header names are matched in ASCII case on the way out', () => {
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

test('round 140 review: a throwing failure listener stays contained; a body torn down by one holds nothing', async () => {
  const res = stubResponse();
  const { source } = createResponseBodySource(res, 'GET', 200, 'gzip');
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

test('round 140 review: onFailure replays a failure held before it subscribed', async () => {
  const res = stubResponse();
  const { source } = createResponseBodySource(
    res,
    'GET',
    200,
    Array.from({ length: 6 }, () => 'gzip').join(','),
  );
  const told: Error[] = [];
  source.onFailure?.((error) => told.push(error));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(told).toHaveLength(1);
});

test('round 140 review 2: exact and wildcard entries agree on an over-long label; onFailure hears decoding failures only', async () => {
  const label = `a${'\u00AD'.repeat(1100)}b`;
  expect(normalizeDomain(`${label}.example.com`)).toBe('');
  expect(validateConfigEntry(`*.${label}.example.com`, 'domain').valid).toBe(
    false,
  );

  const res = stubResponse();
  const { source } = createResponseBodySource(res, 'GET', 200, 'gzip');
  const told: Error[] = [];
  source.onFailure?.((error) => told.push(error));
  source.on('error', () => undefined);
  source.on('data', () => undefined);
  (res as unknown as PassThrough).emit('error', new Error('socket reset'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(told).toEqual([]);
});

test('round 140 review 3: a raw error held before onFailure subscribes is not replayed to it', async () => {
  const res = stubResponse();
  const { source } = createResponseBodySource(res, 'GET', 200, 'gzip');
  // No reader: the raw error is held.
  (res as unknown as PassThrough).emit('error', new Error('socket reset'));
  const told: Error[] = [];
  source.onFailure?.((error) => told.push(error));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(told).toEqual([]);
});

test('round 140 review 3: a decoding failure after the raw end reaches the reader before close', async () => {
  const res = stubResponse();
  const { source } = createResponseBodySource(res, 'GET', 200, 'gzip');
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

test('round 140 review 4: a held decoding failure is told once per subscription, and setup reads the same one', async () => {
  // A refused coding chain: the one failure held when NodeAdapter subscribes.
  const res = stubResponse();
  const { source } = createResponseBodySource(
    res,
    'GET',
    200,
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

test('round 140 review 6: a throwing failure listener is reported on the live and replay paths; subscriptions are separate records', async () => {
  const reports: unknown[] = [];
  const onReport = (event: Event) => {
    reports.push((event as ErrorEvent).error);
    event.preventDefault();
  };
  globalThis.addEventListener('error', onReport);
  try {
    // Live: a corrupt body found failing after subscribing.
    const live = stubResponse();
    const liveBody = createResponseBodySource(live, 'GET', 200, 'gzip').source;
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
      'GET',
      200,
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
    'GET',
    200,
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

test('round 140 review 6: a long run of dots is refused in linear time', () => {
  const started = performance.now();
  expect(normalizeDomain(`${'.'.repeat(40_000)}x`)).toBe('');
  expect(normalizeDomain(`${'a'.repeat(1000)}.`.repeat(5000))).toBe('');
  expect(performance.now() - started).toBeLessThan(200);
});

test('round 140 review 7: an oversized wildcard pattern or bracketed host is refused', () => {
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

test('round 140 review 8: a pause asked before the first byte holds the decoded body', async () => {
  const res = stubResponse();
  const { source } = createResponseBodySource(res, 'GET', 200, 'gzip');
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

test('round 140 review 9: an empty body paused before it ends holds its end until resumed', async () => {
  const res = stubResponse();
  const { source } = createResponseBodySource(res, 'GET', 200, 'gzip');
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

test('round 140 review 9: an error after a held end does not overtake it', async () => {
  const res = stubResponse();
  const { source } = createResponseBodySource(res, 'GET', 200, 'gzip');
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

test('round 140 review 9: a hosts list changed in place is matched as it now reads', () => {
  const filter = { hosts: ['a.com'] };
  expect(
    matchesFilter(
      filter,
      { requestURL: 'https://a.com/' },
      'final',
      'response',
    ),
  ).toBe(true);
  filter.hosts[0] = 'b.com';
  expect(
    matchesFilter(
      filter,
      { requestURL: 'https://b.com/' },
      'final',
      'response',
    ),
  ).toBe(true);
});

test('round 140 review 9: the length guard reads Unicode dots as dots on every path', () => {
  // Two 601-character labels that normalize to `a` (soft hyphens map to nothing), joined
  // by an ideographic full stop: one 1,203-character run if that dot is not read as one.
  const label = `a${'\u00AD'.repeat(600)}`;
  const pattern = `*.${label}\u3002${label}.example.com`;
  expect(validateConfigEntry(pattern, 'domain').valid).toBe(true);
  expect(
    validateConfigEntry(pattern.replace('\u3002', '.'), 'domain').valid,
  ).toBe(true);
});

test('round 140 review 10: a paused body cut short delivers its close without a resume', async () => {
  const res = stubResponse();
  const { source } = createResponseBodySource(res, 'GET', 200, 'gzip');
  const events: string[] = [];
  source.pause();
  source.on('data', () => undefined);
  source.on('close', () => events.push('close'));
  (res as unknown as PassThrough).destroy();
  await new Promise((resolve) => setImmediate(resolve));
  expect(events).toEqual(['close']);
});

test('round 140 review 10: an error held behind a paused end is read by heldError, and let go on destroy', async () => {
  const res = stubResponse();
  const { source } = createResponseBodySource(res, 'GET', 200, 'gzip');
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

test('round 140 review 10: a registered host filter matches by its normalized pattern', async () => {
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

test('round 140 review 10: an error held before a reader attaches is not overtaken by a paused end', async () => {
  const res = stubResponse();
  const { source } = createResponseBodySource(res, 'GET', 200, 'gzip');
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

test('round 140 review 10: a body paused again before the release holds its end again', async () => {
  const res = stubResponse();
  const { source } = createResponseBodySource(res, 'GET', 200, 'gzip');
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

test('round 140 review 11: a paused gzip body cut short mid-body delivers its close without a resume', async () => {
  const res = stubResponse();
  const { source } = createResponseBodySource(res, 'GET', 200, 'gzip');
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
    const normalizedHosts = normalizeHostPatterns([pattern]);
    for (const host of hosts) {
      const context = { requestURL: `https://${host}/` };
      expect([
        pattern,
        host,
        matchesFilter(
          { hosts: [pattern], normalizedHosts },
          context,
          'final',
          'response',
        ),
      ]).toEqual([
        pattern,
        host,
        matchesFilter({ hosts: [pattern] }, context, 'final', 'response'),
      ]);
    }
  }
});
