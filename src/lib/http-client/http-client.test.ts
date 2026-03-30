import {
  afterEach,
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test';
import { HTTPClient } from './http-client';
import { CookieJar } from './cookie-jar';
import { startTestServer, type TestServer } from './test-helpers/test-server';
import {
  DEFAULT_REQUEST_ATTEMPT_HEADER,
  DEFAULT_REQUEST_ID_HEADER,
  DEFAULT_USER_AGENT,
} from './consts';
import type {
  AdapterRequest,
  AdapterResponse,
  HTTPAdapter,
  HTTPClientConfig,
  RedirectHopInfo,
  RequestInterceptorContext,
  SubClientConfig,
} from './types';

let server: TestServer;
const originalFetch = globalThis.fetch;
const originalWindow = (globalThis as Record<string, unknown>).window;
const originalDocument = (globalThis as Record<string, unknown>).document;
const originalSelf = (globalThis as Record<string, unknown>).self;
const originalWorkerGlobalScope = (globalThis as Record<string, unknown>)
  .WorkerGlobalScope;

beforeAll(() => {
  server = startTestServer();
});

afterAll(async () => {
  await server.stop();
});

afterEach(() => {
  globalThis.fetch = originalFetch;

  if (originalWindow === undefined) {
    delete (globalThis as Record<string, unknown>).window;
  } else {
    (globalThis as Record<string, unknown>).window = originalWindow;
  }

  if (originalDocument === undefined) {
    delete (globalThis as Record<string, unknown>).document;
  } else {
    (globalThis as Record<string, unknown>).document = originalDocument;
  }

  if (originalSelf === undefined) {
    delete (globalThis as Record<string, unknown>).self;
  } else {
    (globalThis as Record<string, unknown>).self = originalSelf;
  }

  if (originalWorkerGlobalScope === undefined) {
    delete (globalThis as Record<string, unknown>).WorkerGlobalScope;
  } else {
    (globalThis as Record<string, unknown>).WorkerGlobalScope =
      originalWorkerGlobalScope;
  }
});

function makeClient(overrides = {}) {
  return new HTTPClient({ baseURL: server.url, ...overrides });
}

class InspectableHTTPClient extends HTTPClient {
  public buildSubConfig(overrides: SubClientConfig = {}): HTTPClientConfig {
    return this._buildSubClientConfig(overrides);
  }
}

describe('HTTPClient — basic HTTP methods', () => {
  test('GET returns 200 with JSON body', async () => {
    const client = makeClient({ followRedirects: true });
    const res = await client
      .get('/api/users/1')
      .send<{ id: string; name: string }>();

    expect(res.status).toBe(200);
    expect(res.isJSON).toBe(true);
    expect(res.body.id).toBe('1');
  });

  test('POST sends JSON and returns 201', async () => {
    const client = makeClient({ followRedirects: true });
    const res = await client
      .post('/api/users')
      .json({ name: 'Alice' })
      .send<{ created: boolean }>();
    expect(res.status).toBe(201);
    expect(res.body.created).toBe(true);
  });

  test('PUT echoes body', async () => {
    const client = makeClient({ followRedirects: true });
    const res = await client
      .put('/api/update')
      .json({ value: 42 })
      .send<{ updated: boolean; data: unknown }>();
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(true);
    expect((res.body.data as { value: number }).value).toBe(42);
  });

  test('PATCH echoes body', async () => {
    const client = makeClient({ followRedirects: true });
    const res = await client
      .patch('/api/patch')
      .json({ delta: 1 })
      .send<{ patched: boolean }>();
    expect(res.status).toBe(200);
    expect(res.body.patched).toBe(true);
  });

  test('DELETE returns deleted:true', async () => {
    const client = makeClient();
    const res = await client
      .delete('/api/users/5')
      .send<{ deleted: boolean; id: string }>();
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
    expect(res.body.id).toBe('5');
  });

  test('HEAD returns headers, null body', async () => {
    const client = makeClient();
    const res = await client.head('/api/head').send();
    expect(res.status).toBe(200);
    expect(res.headers['x-head-ok']).toBe('true');
  });

  test('absolute https path is sent as-is even when baseURL is set', async () => {
    let capturedURL = '';

    const adapter: HTTPAdapter = {
      getType: () => 'mock',
      send: (request: AdapterRequest) => {
        capturedURL = request.requestURL;
        return Promise.resolve({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode('{}'),
        });
      },
    };

    const client = new HTTPClient({
      baseURL: server.url,
      adapter,
    });

    await client.get('https://other-origin.test/api/z').send();
    expect(capturedURL).toBe('https://other-origin.test/api/z');
  });

  test('rejects cookieJar with browser FetchAdapter at construction time', () => {
    (globalThis as Record<string, unknown>).window = {};
    (globalThis as Record<string, unknown>).document = {};

    expect(() => new HTTPClient({ cookieJar: new CookieJar() })).toThrow(
      /cookieJar is not supported with FetchAdapter in browser environments/i,
    );
  });

  test('rejects userAgent with browser FetchAdapter at construction time', () => {
    (globalThis as Record<string, unknown>).window = {};
    (globalThis as Record<string, unknown>).document = {};

    expect(() => new HTTPClient({ userAgent: 'test-agent/1.0' })).toThrow(
      /userAgent is not supported with FetchAdapter in browser environments/i,
    );
  });

  test('allows browser FetchAdapter by default', () => {
    (globalThis as Record<string, unknown>).window = {};
    (globalThis as Record<string, unknown>).document = {};

    expect(() => new HTTPClient()).not.toThrow();
  });

  test('rejects browser FetchAdapter redirect handling when explicitly enabled', () => {
    (globalThis as Record<string, unknown>).window = {};
    (globalThis as Record<string, unknown>).document = {};

    expect(() => new HTTPClient({ followRedirects: true })).toThrow(
      /redirect handling is not supported with FetchAdapter in browser environments/i,
    );
  });

  test('allows browser FetchAdapter when followRedirects is false', () => {
    (globalThis as Record<string, unknown>).window = {};
    (globalThis as Record<string, unknown>).document = {};

    expect(
      () =>
        new HTTPClient({
          followRedirects: false,
        }),
    ).not.toThrow();
  });

  test('rejects non-positive maxRedirects when followRedirects is true', () => {
    expect(() =>
      makeClient({
        followRedirects: true,
        maxRedirects: -1,
      }),
    ).toThrow(
      /maxRedirects must be greater than or equal to 1 when followRedirects is true/i,
    );

    expect(() =>
      makeClient({
        followRedirects: true,
        maxRedirects: 0,
      }),
    ).toThrow(
      /maxRedirects must be greater than or equal to 1 when followRedirects is true/i,
    );
  });

  test('rejects maxRedirects when followRedirects is false', () => {
    expect(() =>
      makeClient({
        followRedirects: false,
        maxRedirects: 1,
      }),
    ).toThrow(/maxRedirects cannot be set when followRedirects is false/i);
  });

  test('browser FetchAdapter with followRedirects false treats opaque redirects as disabled', async () => {
    (globalThis as Record<string, unknown>).window = {};
    (globalThis as Record<string, unknown>).document = {};

    let capturedRedirectMode: RequestInit['redirect'] | undefined;

    globalThis.fetch = ((
      _url: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      capturedRedirectMode = init?.redirect;
      return Promise.resolve({
        status: 0,
        type: 'opaqueredirect',
        headers: new Headers(),
      } as Response);
    }) as unknown as typeof fetch;

    const client = new HTTPClient({
      baseURL: 'https://local.test',
      followRedirects: false,
    });
    const builder = client.get('/redirect');
    const response = await builder.send();

    expect(capturedRedirectMode).toBe('manual');
    expect(response.status).toBe(0);
    expect(builder.error).not.toBeNull();
    expect(builder.error?.code).toBe('redirect_disabled');
    expect(builder.error?.requestURL).toBe('https://local.test/redirect');
    expect(builder.error?.redirected).toBe(false);
    expect(builder.error?.redirectHistory).toEqual([]);
  });

  test('browser-restricted header from caller input becomes request_setup_error', async () => {
    (globalThis as Record<string, unknown>).window = {};
    (globalThis as Record<string, unknown>).document = {};

    let isFetchCalled = false;
    globalThis.fetch = (() => {
      isFetchCalled = true;
      return Promise.resolve(new Response('ok'));
    }) as unknown as typeof fetch;

    const client = new HTTPClient({ baseURL: 'https://local.test' });
    const errorCodes: string[] = [];

    client.addErrorObserver((err) => {
      errorCodes.push(err.code);
    });

    const builder = client.get('/users', {
      headers: { host: 'local.test' },
    });
    const res = await builder.send();

    expect(isFetchCalled).toBe(false);
    expect(res.status).toBe(0);
    expect(res.isNetworkError).toBe(false);
    expect(builder.state).toBe('failed');
    expect(builder.error?.code).toBe('request_setup_error');
    expect(builder.error?.cause?.message).toMatch(
      /browser-restricted header "host"/i,
    );
    expect(errorCodes).toEqual(['request_setup_error']);
  });

  test('browser-restricted header from interceptor becomes interceptor_error', async () => {
    (globalThis as Record<string, unknown>).window = {};
    (globalThis as Record<string, unknown>).document = {};

    let isFetchCalled = false;
    globalThis.fetch = (() => {
      isFetchCalled = true;
      return Promise.resolve(new Response('ok'));
    }) as unknown as typeof fetch;

    const client = new HTTPClient({ baseURL: 'https://local.test' });
    const errorCodes: string[] = [];

    client.addRequestInterceptor((request) => ({
      ...request,
      headers: {
        ...request.headers,
        host: 'local.test',
      },
    }));
    client.addErrorObserver((err) => {
      errorCodes.push(err.code);
    });

    const builder = client.get('/users');
    const res = await builder.send();

    expect(isFetchCalled).toBe(false);
    expect(res.status).toBe(0);
    expect(res.isNetworkError).toBe(false);
    expect(builder.state).toBe('failed');
    expect(builder.error?.code).toBe('interceptor_error');
    expect(builder.error?.cause?.message).toMatch(
      /browser-restricted header "host"/i,
    );
    expect(errorCodes).toEqual(['interceptor_error']);
  });

  test('rejects browser-only unsupported FetchAdapter config in worker-like runtimes', () => {
    class FakeWorkerGlobalScope {}

    delete (globalThis as Record<string, unknown>).window;
    delete (globalThis as Record<string, unknown>).document;
    (globalThis as Record<string, unknown>).WorkerGlobalScope =
      FakeWorkerGlobalScope;
    (globalThis as Record<string, unknown>).self = Object.create(
      FakeWorkerGlobalScope.prototype,
    );

    expect(() => new HTTPClient({ cookieJar: new CookieJar() })).toThrow(
      /cookieJar is not supported with FetchAdapter in browser environments/i,
    );
  });

  test('rejects browser XHR redirect handling when explicitly enabled', () => {
    (globalThis as Record<string, unknown>).window = {};
    (globalThis as Record<string, unknown>).document = {};

    const adapter: HTTPAdapter = {
      getType: () => 'xhr',
      send: (_request: AdapterRequest): Promise<AdapterResponse> =>
        Promise.resolve({
          status: 200,
          headers: {},
          body: null,
        }),
    };

    expect(() => new HTTPClient({ adapter, followRedirects: true })).toThrow(
      /redirect handling is not supported with XHR adapter in browser environments/i,
    );
  });

  test('allows browser XHR adapter when followRedirects is false', () => {
    (globalThis as Record<string, unknown>).window = {};
    (globalThis as Record<string, unknown>).document = {};

    const adapter: HTTPAdapter = {
      getType: () => 'xhr',
      send: (_request: AdapterRequest): Promise<AdapterResponse> =>
        Promise.resolve({
          status: 200,
          headers: {},
          body: null,
        }),
    };

    expect(
      () =>
        new HTTPClient({
          adapter,
          followRedirects: false,
        }),
    ).not.toThrow();
  });

  test('rejects browser XHR maxRedirects when followRedirects is false', () => {
    (globalThis as Record<string, unknown>).window = {};
    (globalThis as Record<string, unknown>).document = {};

    const adapter: HTTPAdapter = {
      getType: () => 'xhr',
      send: (_request: AdapterRequest): Promise<AdapterResponse> =>
        Promise.resolve({
          status: 200,
          headers: {},
          body: null,
        }),
    };

    expect(
      () =>
        new HTTPClient({
          adapter,
          followRedirects: false,
          maxRedirects: -1,
        }),
    ).toThrow(/maxRedirects cannot be set when followRedirects is false/i);
  });

  test('rejects cookieJar with browser XHR adapter at construction time', () => {
    (globalThis as Record<string, unknown>).window = {};
    (globalThis as Record<string, unknown>).document = {};

    const adapter: HTTPAdapter = {
      getType: () => 'xhr',
      send: (_request: AdapterRequest): Promise<AdapterResponse> =>
        Promise.resolve({
          status: 200,
          headers: {},
          body: null,
        }),
    };

    expect(
      () => new HTTPClient({ adapter, cookieJar: new CookieJar() }),
    ).toThrow(/cookieJar is not supported with XHR adapter/i);
  });

  test('rejects userAgent with browser XHR adapter at construction time', () => {
    (globalThis as Record<string, unknown>).window = {};
    (globalThis as Record<string, unknown>).document = {};

    const adapter: HTTPAdapter = {
      getType: () => 'xhr',
      send: (_request: AdapterRequest): Promise<AdapterResponse> =>
        Promise.resolve({
          status: 200,
          headers: {},
          body: null,
        }),
    };

    expect(
      () => new HTTPClient({ adapter, userAgent: 'test-agent/1.0' }),
    ).toThrow(/userAgent is not supported with XHR adapter/i);
  });

  test('rejects Node adapter in browser environments at construction time', () => {
    (globalThis as Record<string, unknown>).window = {};
    (globalThis as Record<string, unknown>).document = {};

    const adapter: HTTPAdapter = {
      getType: () => 'node',
      send: (_request: AdapterRequest): Promise<AdapterResponse> =>
        Promise.resolve({
          status: 200,
          headers: {},
          body: null,
        }),
    };

    expect(() => new HTTPClient({ adapter })).toThrow(
      /Node adapter is not supported in browser environments/i,
    );
  });

  test('allows Mock adapter in browser environments', () => {
    (globalThis as Record<string, unknown>).window = {};
    (globalThis as Record<string, unknown>).document = {};

    const adapter: HTTPAdapter = {
      getType: () => 'mock',
      send: (_request: AdapterRequest): Promise<AdapterResponse> =>
        Promise.resolve({
          status: 200,
          headers: {},
          body: null,
        }),
    };

    expect(
      () =>
        new HTTPClient({
          adapter,
          cookieJar: new CookieJar(),
          userAgent: 'test-agent/1.0',
        }),
    ).not.toThrow();
  });

  test('still allows cookieJar and userAgent outside browser environments', () => {
    const fetchAdapter: HTTPAdapter = {
      getType: () => 'fetch',
      send: (_request: AdapterRequest): Promise<AdapterResponse> =>
        Promise.resolve({
          status: 200,
          headers: {},
          body: null,
        }),
    };

    const xhrAdapter: HTTPAdapter = {
      getType: () => 'xhr',
      send: (_request: AdapterRequest): Promise<AdapterResponse> =>
        Promise.resolve({
          status: 200,
          headers: {},
          body: null,
        }),
    };

    expect(
      () =>
        new HTTPClient({
          adapter: fetchAdapter,
          cookieJar: new CookieJar(),
          userAgent: 'test-agent/1.0',
        }),
    ).not.toThrow();

    expect(
      () =>
        new HTTPClient({
          adapter: xhrAdapter,
          cookieJar: new CookieJar(),
          userAgent: 'test-agent/1.0',
        }),
    ).not.toThrow();
  });
});

describe('HTTPClient — query params', () => {
  test('sends query params via .params()', async () => {
    const client = makeClient();
    const res = await client
      .get('/api/query')
      .params({ foo: 'bar', num: 42 })
      .send<{ params: Record<string, unknown> }>();

    expect(res.body.params.foo).toBe('bar');
    expect(res.body.params.num).toBe('42');
  });

  test('preserves array query params serialized by qs', async () => {
    const client = makeClient();
    const res = await client
      .get('/api/query')
      .params({ tags: ['alpha', 'beta'], filter: { state: 'open' } })
      .send<{
        params: { tags: string[]; filter: { state: string } };
      }>();

    expect(res.body.params.tags).toEqual(['alpha', 'beta']);
    expect(res.body.params.filter.state).toBe('open');
  });

  test('serializes array and object params before they reach the adapter', async () => {
    let capturedURL = '';

    const adapter: HTTPAdapter = {
      getType: () => 'mock',
      send: (request: AdapterRequest): Promise<AdapterResponse> => {
        capturedURL = request.requestURL;

        return Promise.resolve({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode('{"ok":true}'),
        });
      },
    };

    const client = new HTTPClient({
      baseURL: 'https://example.com',
      adapter,
    });

    await client
      .get('/api/query')
      .params({ tags: ['alpha', 'beta'], filter: { state: 'open' } })
      .send();

    expect(capturedURL).toStartWith('https://example.com/api/query?');
    expect(capturedURL).toContain('tags%5B0%5D=alpha');
    expect(capturedURL).toContain('tags%5B1%5D=beta');
    expect(capturedURL).toContain('filter%5Bstate%5D=open');
  });

  test('keeps string params as strings even when they look like JSON', async () => {
    let capturedURL = '';

    const adapter: HTTPAdapter = {
      getType: () => 'mock',
      send: (request: AdapterRequest): Promise<AdapterResponse> => {
        capturedURL = request.requestURL;

        return Promise.resolve({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode('{"ok":true}'),
        });
      },
    };

    const client = new HTTPClient({
      baseURL: 'https://example.com',
      adapter,
    });

    await client
      .get('/api/query')
      .params({
        maybeArray: '["alpha","beta"]',
        maybeObject: '{"state":"open"}',
      })
      .send();

    expect(capturedURL).toContain('maybeArray=%5B%22alpha%22%2C%22beta%22%5D');
    expect(capturedURL).toContain('maybeObject=%7B%22state%22%3A%22open%22%7D');
  });
});

describe('HTTPClient — headers', () => {
  test('sends default headers', async () => {
    const client = makeClient({ defaultHeaders: { 'x-app': 'test-suite' } });
    const res = await client
      .get('/api/test')
      .send<{ headers: Record<string, string> }>();
    expect(res.body.headers['x-app']).toBe('test-suite');
  });

  test('per-request headers override defaults', async () => {
    const client = makeClient({ defaultHeaders: { 'x-version': '1' } });
    const res = await client
      .get('/api/test')
      .headers({ 'x-version': '2' })
      .send<{ headers: Record<string, string> }>();
    expect(res.body.headers['x-version']).toBe('2');
  });

  test('includes x-request-id by default', async () => {
    const client = makeClient();
    const res = await client
      .get('/api/test')
      .send<{ headers: Record<string, string> }>();
    expect(res.body.headers['x-request-id']).toBeDefined();
    expect(res.requestID).toBeDefined();
  });

  test('x-request-id can be disabled', async () => {
    const client = makeClient({ includeRequestID: false });
    const res = await client
      .get('/api/test')
      .send<{ headers: Record<string, string> }>();
    expect(res.body.headers['x-request-id']).toBeUndefined();
  });

  test('applies explicit userAgent to mock adapters', async () => {
    let capturedHeaders: Record<string, string> = {};

    const adapter: HTTPAdapter = {
      getType: () => 'mock',
      send: (request: AdapterRequest): Promise<AdapterResponse> => {
        capturedHeaders = request.headers;

        return Promise.resolve({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode('{"ok":true}'),
        });
      },
    };

    const client = new HTTPClient({
      adapter,
      userAgent: 'test-suite-agent/1.0',
    });

    await client.get('https://example.com/users').send();

    expect(capturedHeaders['user-agent']).toBe('test-suite-agent/1.0');
  });

  test('applies the default user-agent to mock adapters when none is configured', async () => {
    let capturedHeaders: Record<string, string> = {};

    const adapter: HTTPAdapter = {
      getType: () => 'mock',
      send: (request: AdapterRequest): Promise<AdapterResponse> => {
        capturedHeaders = request.headers;

        return Promise.resolve({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode('{"ok":true}'),
        });
      },
    };

    const client = new HTTPClient({ adapter, followRedirects: true });

    await client.get('https://example.com/users').send();

    expect(capturedHeaders['user-agent']).toBe(DEFAULT_USER_AGENT);
  });
});

describe('HTTPClient — response flags', () => {
  test('non-JSON response — isText: true, isJSON: false', async () => {
    const client = makeClient();
    const res = await client.get('/api/text').send<string>();
    expect(res.isText).toBe(true);
    expect(res.isJSON).toBe(false);
    expect(res.body).toBe('hello world');
  });

  test('204 no content — null body', async () => {
    const client = makeClient();
    const res = await client.get('/api/no-content').send();
    expect(res.status).toBe(204);
  });

  test('parses JSON from adapter bytes', async () => {
    const adapter: HTTPAdapter = {
      getType: () => 'mock',
      send: (_request: AdapterRequest): Promise<AdapterResponse> =>
        Promise.resolve({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode('{"ok":true}'),
        }),
    };

    const client = new HTTPClient({ adapter, followRedirects: true });
    const res = await client
      .get('https://example.com/json')
      .send<{ ok: boolean }>();

    expect(res.isJSON).toBe(true);
    expect(res.isText).toBe(false);
    expect(res.body.ok).toBe(true);
  });

  test('returns decoded text for invalid JSON bytes and marks parse error', async () => {
    const adapter: HTTPAdapter = {
      getType: () => 'mock',
      send: (_request: AdapterRequest): Promise<AdapterResponse> =>
        Promise.resolve({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode('{"ok":'),
        }),
    };

    const client = new HTTPClient({ adapter, followRedirects: true });
    const res = await client.get('https://example.com/bad-json').send<string>();

    expect(res.isJSON).toBe(false);
    expect(res.isParseError).toBe(true);
    expect(res.body).toBe('{"ok":');
  });

  test('keeps binary bytes untouched', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const adapter: HTTPAdapter = {
      getType: () => 'mock',
      send: (_request: AdapterRequest): Promise<AdapterResponse> =>
        Promise.resolve({
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
          body: bytes,
        }),
    };

    const client = new HTTPClient({ adapter, followRedirects: true });
    const res = await client
      .get('https://example.com/binary')
      .send<Uint8Array>();

    expect(res.contentType).toBe('binary');
    expect(res.isText).toBe(false);
    expect(res.isJSON).toBe(false);
    expect(res.body).toEqual(bytes);
  });
});

describe('HTTPClient — error responses', () => {
  test('400 is not a network error — returns status 400', async () => {
    const client = makeClient({ followRedirects: true });
    const res = await client.get('/api/bad-request').send<{ error: string }>();
    expect(res.status).toBe(400);
    expect(res.isNetworkError).toBe(false);
    expect(res.isJSON).toBe(true);
  });

  test('500 is not a network error — returns status 500', async () => {
    const client = makeClient({ followRedirects: true });
    const res = await client.get('/api/error').send<{ error: string }>();
    expect(res.status).toBe(500);
    expect(res.isNetworkError).toBe(false);
  });
});

describe('HTTPClient — cancellation', () => {
  test('AbortSignal cancellation — isCancelled: true, status: 0', async () => {
    const client = makeClient({ followRedirects: true });
    const controller = new AbortController();
    controller.abort();

    const res = await client.get('/api/slow').signal(controller.signal).send();
    expect(res.status).toBe(0);
    expect(res.isCancelled).toBe(true);
  });

  test('pre-aborted AbortSignal short-circuits before interceptors and adapter dispatch', async () => {
    let adapterCalls = 0;
    let interceptorCalls = 0;
    const errorCodes: string[] = [];

    const adapter: HTTPAdapter = {
      getType: () => 'mock',
      send: (_request: AdapterRequest): Promise<AdapterResponse> => {
        adapterCalls++;
        return Promise.resolve({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode('{"ok":true}'),
        });
      },
    };

    const client = new HTTPClient({ adapter, followRedirects: true });
    client.addRequestInterceptor((req) => {
      interceptorCalls++;
      return req;
    });
    client.addErrorObserver((err) => {
      errorCodes.push(err.code);
    });

    const controller = new AbortController();
    controller.abort();

    const builder = client
      .get('https://example.com/slow')
      .signal(controller.signal);
    const res = await builder.send();

    expect(res.status).toBe(0);
    expect(res.isCancelled).toBe(true);
    expect(res.initialURL).toBe('https://example.com/slow');
    expect(res.requestURL).toBe('https://example.com/slow');
    expect(res.redirected).toBe(false);
    expect(res.redirectHistory).toEqual([]);
    expect(adapterCalls).toBe(0);
    expect(interceptorCalls).toBe(0);
    expect(builder.attemptCount).toBe(0);
    expect(builder.state).toBe('cancelled');
    expect(errorCodes).toEqual(['cancelled']);
  });

  test('client.cancel(requestID) cancels a specific in-flight request', async () => {
    const client = makeClient();
    const builder = client.get('/api/slow');
    const promise = builder.send();

    client.cancel(builder.requestID);

    const res = await promise;
    expect(res.status).toBe(0);
    expect(res.isCancelled).toBe(true);
  });

  test('builder.cancel() cancels the request', async () => {
    const client = makeClient();
    const builder = client.get('/api/slow');
    const promise = builder.send();

    // Cancel immediately after sending
    setTimeout(() => builder.cancel(), 10);

    const res = await promise;
    expect(res.status).toBe(0);
    expect(res.isCancelled).toBe(true);
  });

  test('client.cancelAll() cancels all in-flight requests', async () => {
    const client = makeClient();
    const builders = [client.get('/api/slow'), client.get('/api/slow')];

    const promises = builders.map((b) => b.send());
    setTimeout(() => client.cancelAll(), 10);

    const results = await Promise.all(promises);
    for (const res of results) {
      expect(res.status).toBe(0);
      expect(res.isCancelled).toBe(true);
    }
  });

  test('client.cancelAllWithLabel() cancels labeled requests only', async () => {
    const client = makeClient();
    const labeled = client.get('/api/slow').label('cancel-me');
    const unlabeled = client.get('/api/slow');

    const [p1, p2] = [labeled.send(), unlabeled.send()];

    setTimeout(() => client.cancelAllWithLabel('cancel-me'), 10);

    const [res1, res2] = await Promise.all([p1, p2]);
    expect(res1.isCancelled).toBe(true);
    // unlabeled may or may not finish — just check it didn't get cancelled by the label stop
    expect(res2.isCancelled).toBe(false);
  });
});

describe('HTTPClient — timeout', () => {
  test('isTimeout: true when request exceeds per-request timeout', async () => {
    const client = makeClient();
    const builder = client.get('/api/slow').timeout(100);
    const res = await builder.send(); // server delays 500ms
    expect(res.status).toBe(0);
    expect(res.isTimeout).toBe(true);
    expect(builder.error?.code).toBe('timeout');
  });

  test('per-attempt timeout is retried when retry policy has budget', async () => {
    let callCount = 0;

    const adapter: HTTPAdapter = {
      getType: () => 'mock',
      send: (request: AdapterRequest): Promise<AdapterResponse> => {
        callCount++;

        if (callCount < 3) {
          return new Promise((_resolve, reject) => {
            const onAbort = () => {
              const err = new Error('The operation was aborted');
              err.name = 'AbortError';
              reject(err);
            };

            if (request.signal?.aborted) {
              onAbort();
              return;
            }

            request.signal?.addEventListener('abort', onAbort, { once: true });
          });
        }

        return Promise.resolve({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode('{"ok":true}'),
        });
      },
    };

    const client = new HTTPClient({ adapter, followRedirects: true });
    const attemptEnds: number[] = [];

    const res = await client
      .get('https://example.com/flaky-timeout')
      .timeout(50)
      .retryPolicy({ strategy: 'fixed', maxRetryAttempts: 3, delayMS: 0 })
      .onAttemptEnd((e) => attemptEnds.push(e.status))
      .send<{ ok: boolean }>();

    expect(callCount).toBe(3);
    expect(attemptEnds).toEqual([0, 0, 200]);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.isTimeout).toBe(false);
  });

  test('when every attempt times out, retries until policy is exhausted', async () => {
    let callCount = 0;

    const adapter: HTTPAdapter = {
      getType: () => 'mock',
      send: (request: AdapterRequest): Promise<AdapterResponse> => {
        callCount++;

        return new Promise((_resolve, reject) => {
          const onAbort = () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          };

          if (request.signal?.aborted) {
            onAbort();
            return;
          }

          request.signal?.addEventListener('abort', onAbort, { once: true });
        });
      },
    };

    const client = new HTTPClient({ adapter, followRedirects: true });
    const builder = client
      .get('https://example.com/always-slow')
      .timeout(50)
      .retryPolicy({ strategy: 'fixed', maxRetryAttempts: 2, delayMS: 0 });

    const res = await builder.send();

    // Initial try + 2 retries = 3 adapter calls when maxRetryAttempts is 2
    expect(callCount).toBe(3);
    expect(res.status).toBe(0);
    expect(res.isTimeout).toBe(true);
    expect(res.isNetworkError).toBe(false);
    expect(builder.error?.code).toBe('timeout');
    expect(builder.error?.isRetriesExhausted).toBe(true);
    expect(builder.error?.isTimeout).toBe(true);
  });
});

describe('HTTPClient — retry', () => {
  test('retries on 503, succeeds on 3rd attempt', async () => {
    // Reset flaky counter first
    await fetch(`${server.url}/api/reset-flaky`, { method: 'POST' });

    const client = makeClient();
    const attemptEnds: number[] = [];

    const res = await client
      .get('/api/flaky')
      .retryPolicy({ strategy: 'fixed', maxRetryAttempts: 3, delayMS: 10 })
      .onAttemptEnd((e) => attemptEnds.push(e.status))
      .send<{ attempt: number; ok: boolean }>();

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(attemptEnds.length).toBe(3); // 503, 503, 200
    expect(attemptEnds[0]).toBe(503);
    expect(attemptEnds[2]).toBe(200);
  });

  test('does not retry on 400', async () => {
    const client = makeClient();
    const attemptEnds: number[] = [];

    await client
      .get('/api/bad-request')
      .retryPolicy({ strategy: 'fixed', maxRetryAttempts: 3, delayMS: 10 })
      .onAttemptEnd((e) => attemptEnds.push(e.status))
      .send();

    expect(attemptEnds.length).toBe(1); // no retries
    expect(attemptEnds[0]).toBe(400);
  });

  test('retries a plain status 0 response when retry policy allows it', async () => {
    const attemptEnds: number[] = [];
    let callCount = 0;

    const adapter: HTTPAdapter = {
      getType: () => 'mock',
      send: (_request: AdapterRequest): Promise<AdapterResponse> => {
        callCount++;

        if (callCount < 3) {
          return Promise.resolve({
            status: 0,
            headers: {},
            body: null,
          });
        }

        return Promise.resolve({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode('{"ok":true}'),
        });
      },
    };

    const client = new HTTPClient({ adapter, followRedirects: true });
    const res = await client
      .get('https://example.com/status-0')
      .retryPolicy({ strategy: 'fixed', maxRetryAttempts: 3, delayMS: 10 })
      .onAttemptEnd((e) => attemptEnds.push(e.status))
      .send();

    expect(res.status).toBe(200);
    expect(attemptEnds).toEqual([0, 0, 200]);
  });

  test('attempt header carries count through redirect after retries', async () => {
    await fetch(`${server.url}/api/reset-flaky`, { method: 'POST' });

    const client = makeClient({
      includeAttemptHeader: true,
      followRedirects: true,
    });

    // /api/flaky-redirect returns 503 twice, then 302 → /api/test (which echoes headers)
    const res = await client
      .get('/api/flaky-redirect')
      .retryPolicy({ strategy: 'fixed', maxRetryAttempts: 3, delayMS: 10 })
      .send();

    expect(res.status).toBe(200);

    const body = res.body as { headers: Record<string, string> };
    // Three attempts on the initial URL, then the redirect follow-up is attempt 4.
    expect(body.headers[DEFAULT_REQUEST_ATTEMPT_HEADER]).toBe('4');
  });

  test('redirect hop retries on 503 from target', async () => {
    await fetch(`${server.url}/api/reset-flaky`, { method: 'POST' });

    const client = makeClient({ followRedirects: true });

    // /api/redirect/301-flaky-target → 301 → /api/flaky-target
    // /api/flaky-target returns 503 once, then 200 on retry
    const res = await client
      .get('/api/redirect/301-flaky-target')
      .retryPolicy({ strategy: 'fixed', maxRetryAttempts: 3, delayMS: 10 })
      .send();

    expect(res.status).toBe(200);
    expect(res.redirected).toBe(true);

    const body = res.body as { ok: boolean; attempt: number };
    expect(body.ok).toBe(true);
    expect(body.attempt).toBe(2);
  });

  test('per-request retryPolicy: null disables retry', async () => {
    await fetch(`${server.url}/api/reset-flaky`, { method: 'POST' });

    const client = makeClient({
      retryPolicy: { strategy: 'fixed', maxRetryAttempts: 3, delayMS: 10 },
    });

    const attempts: number[] = [];

    await client
      .get('/api/flaky')
      .retryPolicy(null)
      .onAttemptEnd((e) => attempts.push(e.status))
      .send();

    expect(attempts.length).toBe(1); // retry disabled per-request
  });
});

describe('HTTPClient — cookies', () => {
  test('stores Set-Cookie from response and sends on next request', async () => {
    const jar = new CookieJar();
    const client = makeClient({ cookieJar: jar });

    await client.get('/api/set-cookie').send();
    expect(jar.getCookieFor('session', server.url)?.value).toBe('abc123');

    const echoRes = await client
      .get('/api/echo-cookies')
      .send<{ cookies: string }>();
    expect(echoRes.body.cookies).toContain('session=abc123');
  });

  test('two clients share the same cookie jar', async () => {
    const jar = new CookieJar();
    const client1 = new HTTPClient({ baseURL: server.url, cookieJar: jar });
    const client2 = new HTTPClient({ baseURL: server.url, cookieJar: jar });

    await client1.get('/api/set-cookie').send();
    expect(jar.getCookieFor('session', server.url)).toBeDefined();

    const res = await client2
      .get('/api/echo-cookies')
      .send<{ cookies: string }>();
    expect(res.body.cookies).toContain('session=abc123');
  });

  test('stores multiple Set-Cookie headers from one response', async () => {
    const jar = new CookieJar();
    const client = makeClient({ cookieJar: jar });

    const res = await client.get('/api/set-cookies').send<{ ok: boolean }>();

    expect(res.status).toBe(200);
    expect(res.headers['set-cookie']).toEqual([
      'session=abc123; Path=/; HttpOnly',
      'theme=dark; Path=/',
    ]);
    expect(jar.getCookieFor('session', server.url)?.value).toBe('abc123');
    expect(jar.getCookieFor('theme', server.url)?.value).toBe('dark');

    const echoRes = await client
      .get('/api/echo-cookies')
      .send<{ cookies: string }>();
    expect(echoRes.body.cookies).toContain('session=abc123');
    expect(echoRes.body.cookies).toContain('theme=dark');
  });

  test('each retry attempt re-reads the cookie jar', async () => {
    const jar = new CookieJar();
    jar.setCookie({
      name: 'token',
      value: 'first',
      domain: 'example.com',
      path: '/',
      createdAt: Date.now(),
    });

    const cookiesSent: string[] = [];
    let call = 0;

    const adapter: HTTPAdapter = {
      getType: () => 'mock',
      send: (request: AdapterRequest) => {
        call++;
        cookiesSent.push(request.headers.cookie ?? '');
        if (call === 1) {
          return Promise.resolve({
            status: 503,
            headers: {},
            body: null,
          });
        }
        return Promise.resolve({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode('{}'),
        });
      },
    };

    const client = new HTTPClient({
      baseURL: 'https://example.com',
      adapter,
      cookieJar: jar,
      retryPolicy: { strategy: 'fixed', maxRetryAttempts: 2, delayMS: 0 },
    });

    await client
      .get('/api/r')
      .onAttemptEnd((e) => {
        if (e.willRetry && e.attemptNumber === 1) {
          jar.setCookie({
            name: 'token',
            value: 'second',
            domain: 'example.com',
            path: '/',
            createdAt: Date.now(),
          });
        }
      })
      .send();

    expect(cookiesSent[0]).toContain('token=first');
    expect(cookiesSent[1]).toContain('token=second');
  });

  test('Set-Cookie on a retryable error response is applied before the next attempt', async () => {
    const jar = new CookieJar();
    let call = 0;

    const adapter: HTTPAdapter = {
      getType: () => 'mock',
      send: (request: AdapterRequest) => {
        call++;
        if (call === 1) {
          return Promise.resolve({
            status: 503,
            headers: {
              'set-cookie': 'session=from503; Path=/',
              'content-type': 'text/plain',
            },
            body: new TextEncoder().encode('unavailable'),
          });
        }
        return Promise.resolve({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode(
            JSON.stringify({ cookie: request.headers.cookie ?? '' }),
          ),
        });
      },
    };

    const client = new HTTPClient({
      baseURL: 'https://example.com',
      adapter,
      cookieJar: jar,
      retryPolicy: { strategy: 'fixed', maxRetryAttempts: 2, delayMS: 0 },
    });

    const res = await client.get('/api/r').send<{ cookie: string }>();

    expect(res.status).toBe(200);
    expect(res.body.cookie).toContain('session=from503');
    expect(
      jar.getCookieFor('session', 'https://example.com/api/r')?.value,
    ).toBe('from503');
  });
});

describe('HTTPClient — interceptors', () => {
  test('request interceptor runs before request', async () => {
    const client = makeClient({ followRedirects: true });
    client.addRequestInterceptor((req) => ({
      ...req,
      headers: { ...req.headers, 'x-injected': 'yes' },
    }));

    const res = await client
      .get('/api/test')
      .send<{ headers: Record<string, string> }>();
    expect(res.body.headers['x-injected']).toBe('yes');
  });

  test('request interceptor can rewrite the initial method before dispatch', async () => {
    const sentRequests: AdapterRequest[] = [];

    const adapter: HTTPAdapter = {
      getType: () => 'mock',
      send: (request: AdapterRequest): Promise<AdapterResponse> => {
        sentRequests.push(request);
        return Promise.resolve({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode('{}'),
        });
      },
    };

    const client = new HTTPClient({ adapter, followRedirects: true });
    client.addRequestInterceptor((req) => ({
      ...req,
      method: 'POST',
      body: 'rewritten-body',
    }));

    await client.get('https://example.com/original').send();

    expect(sentRequests).toHaveLength(1);
    expect(sentRequests[0]?.method).toBe('POST');
    expect(sentRequests[0]?.body).toBe('rewritten-body');
  });

  test('response observer fires after JSON response', async () => {
    const client = makeClient({ followRedirects: true });
    const statuses: number[] = [];
    client.addResponseObserver((res) => {
      statuses.push(res.status);
    });

    await client.get('/api/users/1').send();
    expect(statuses).toEqual([200]);
  });

  test('response observer receives finalized body and cloned rawBody', async () => {
    const client = makeClient({ followRedirects: true });
    const payload = { nested: { value: 1 } };
    let seenRequest: { body: unknown; rawBody: unknown } | undefined;
    let seenRawValue: number | undefined;

    client.addResponseObserver((_res, req) => {
      seenRequest = {
        body: req.body,
        rawBody: req.rawBody,
      };

      const raw = req.rawBody as { nested: { value: number } };
      seenRawValue = raw.nested.value;
      raw.nested.value = 99;
    });

    await client.post('/api/echo').json(payload).send();

    expect(seenRequest?.body).toBe(JSON.stringify({ nested: { value: 1 } }));
    expect(seenRequest?.rawBody).not.toBe(payload);
    expect(seenRawValue).toBe(1);
    expect(payload.nested.value).toBe(1);
  });

  test('request interceptor failures are normalized as interceptor errors', async () => {
    const adapterCalls: string[] = [];
    const errorCodes: string[] = [];

    const adapter: HTTPAdapter = {
      getType: () => 'mock',
      send: (request: AdapterRequest): Promise<AdapterResponse> => {
        adapterCalls.push(request.requestURL);
        return Promise.resolve({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode('{"ok":true}'),
        });
      },
    };

    const client = new HTTPClient({ adapter, followRedirects: true });
    client.addRequestInterceptor(() => {
      throw new Error('request interceptor blew up');
    });
    client.addErrorObserver((err) => {
      errorCodes.push(err.code);
    });

    const builder = client.get('https://example.com/users');
    const res = await builder.send();

    expect(res.status).toBe(0);
    expect(res.isNetworkError).toBe(false);
    expect(res.isCancelled).toBe(false);
    expect(res.isTimeout).toBe(false);
    expect(res.initialURL).toBe('https://example.com/users');
    expect(res.requestURL).toBe('https://example.com/users');
    expect(builder.state).toBe('failed');
    expect(builder.attemptCount).toBe(null);
    expect(builder.error?.code).toBe('interceptor_error');
    expect(builder.error?.initialURL).toBe('https://example.com/users');
    expect(builder.error?.requestURL).toBe('https://example.com/users');
    expect(builder.error?.redirected).toBe(false);
    expect(builder.error?.redirectHistory).toEqual([]);
    expect(builder.error?.cause?.message).toBe('request interceptor blew up');
    expect(adapterCalls).toEqual([]);
    expect(errorCodes).toEqual(['interceptor_error']);
  });

  test('initial-phase interceptor throw notifies default (final-phase) error observers', async () => {
    const adapter: HTTPAdapter = {
      getType: () => 'mock',
      send: () =>
        Promise.resolve({
          status: 200,
          headers: {},
          body: null,
        }),
    };

    const client = new HTTPClient({ adapter, followRedirects: true });
    client.addRequestInterceptor(() => {
      throw new Error('boom');
    });

    const initialOnlyCodes: string[] = [];
    const finalCodes: string[] = [];

    // Error observers use request phase names for filtering; `initial` does not apply here
    // (interceptor errors settle as `final` only).
    client.addErrorObserver(
      (err) => {
        initialOnlyCodes.push(err.code);
      },
      { phases: ['initial'] },
    );
    client.addErrorObserver(
      (err) => {
        finalCodes.push(err.code);
      },
      { phases: ['final'] },
    );

    await client.get('https://example.com/x').send();

    expect(initialOnlyCodes).toEqual([]);
    expect(finalCodes).toEqual(['interceptor_error']);
  });

  test('response observer filtered by statusCode', async () => {
    const client = makeClient({ followRedirects: true });
    const statuses: number[] = [];

    client.addResponseObserver(
      (res) => {
        statuses.push(res.status);
      },
      { statusCodes: [400] },
    );

    await client.get('/api/users/1').send();
    expect(statuses).toHaveLength(0);

    await client.get('/api/bad-request').send();
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toBe(400);
  });

  test('error observer fires on cancelled request', async () => {
    const client = makeClient({ followRedirects: true });
    const codes: string[] = [];

    client.addErrorObserver((err) => {
      codes.push(err.code);
    });

    const controller = new AbortController();
    controller.abort();

    await client.get('/api/slow').signal(controller.signal).send();
    expect(codes.length).toBeGreaterThan(0);
  });

  test('remove() stops interceptor from running', async () => {
    const client = makeClient({ followRedirects: true });
    const calls: number[] = [];
    const remove = client.addRequestInterceptor((req) => {
      calls.push(1);
      return req;
    });

    await client.get('/api/test').send();
    expect(calls).toHaveLength(1);

    remove();
    await client.get('/api/test').send();
    expect(calls).toHaveLength(1); // no new call
  });
});

describe('HTTPClient — FormData upload', () => {
  test('sends FormData body', async () => {
    const client = makeClient({ followRedirects: true });
    const fd = new FormData();
    fd.append('username', 'alice');

    const res = await client
      .post('/api/upload')
      .formData(fd)
      .send<{ received: boolean; fields: Record<string, string> }>();

    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
    expect(res.body.fields.username).toBe('alice');
  });
});

describe('HTTPClient — redirect', () => {
  test('disabled redirects settle as redirect_disabled on server responses', async () => {
    const client = makeClient();
    const builder = client.get('/api/redirect/301');
    const res = await builder.send();

    expect(res.status).toBe(0);
    expect(res.isNetworkError).toBe(false);
    expect(res.initialURL).toBe(`${server.url}/api/redirect/301`);
    expect(res.requestURL).toBe(`${server.url}/api/redirect/301`);
    expect(res.redirected).toBe(false);
    expect(res.redirectHistory).toEqual([]);
    expect(builder.error?.code).toBe('redirect_disabled');
    expect(builder.error?.message).toBe(
      'Redirect encountered while redirects are disabled',
    );
  });

  test('follows 301 redirect by default and exposes initialURL and requestURL', async () => {
    const client = makeClient({ followRedirects: true });
    const res = await client
      .get('/api/redirect/301')
      .send<{ headers: Record<string, string> }>();

    expect(res.status).toBe(200);
    expect(res.initialURL).toBe(`${server.url}/api/redirect/301`);
    expect(res.requestURL).toBe(`${server.url}/api/test`);
    expect(res.redirected).toBe(true);
    expect(res.redirectHistory).toEqual([`${server.url}/api/test`]);
  });

  test('onAttemptStart/onAttemptEnd cover redirect follow-up with hopNumber and RedirectHopInfo', async () => {
    const client = makeClient({ followRedirects: true });
    const requested = `${server.url}/api/redirect/301`;
    const starts: Array<{
      attemptNumber: number;
      isRetry: boolean;
      hopNumber?: number;
      initialURL?: string;
    }> = [];
    const ends: Array<{
      attemptNumber: number;
      status: number;
      hopNumber?: number;
      redirect?: { hop: number; statusCode: number };
    }> = [];

    const res = await client
      .get('/api/redirect/301')
      .onAttemptStart((e) =>
        starts.push({
          attemptNumber: e.attemptNumber,
          isRetry: e.isRetry,
          hopNumber: e.hopNumber,
          initialURL: e.initialURL,
        }),
      )
      .onAttemptEnd((e) =>
        ends.push({
          attemptNumber: e.attemptNumber,
          status: e.status,
          hopNumber: e.hopNumber,
          redirect: e.redirect
            ? { hop: e.redirect.hop, statusCode: e.redirect.statusCode }
            : undefined,
        }),
      )
      .send<{ headers: Record<string, string> }>();

    expect(res.status).toBe(200);
    expect(starts).toEqual([
      {
        attemptNumber: 1,
        isRetry: false,
        hopNumber: undefined,
        initialURL: requested,
      },
      {
        attemptNumber: 2,
        isRetry: false,
        hopNumber: 1,
        initialURL: requested,
      },
    ]);
    expect(ends).toEqual([
      {
        attemptNumber: 1,
        status: 301,
        hopNumber: undefined,
        redirect: undefined,
      },
      {
        attemptNumber: 2,
        status: 200,
        hopNumber: 1,
        redirect: { hop: 1, statusCode: 301 },
      },
    ]);
  });

  test('cross-origin redirect preserves safelisted headers under lowercase keys', async () => {
    const followUpHeaders: Record<string, string>[] = [];

    const adapter: HTTPAdapter = {
      getType: () => 'mock',
      send: (request: AdapterRequest): Promise<AdapterResponse> => {
        if (request.requestURL === 'https://alpha.example/start') {
          return Promise.resolve({
            status: 307,
            headers: { location: 'https://beta.other/dest' },
            body: null,
          });
        }

        followUpHeaders.push({ ...request.headers });
        return Promise.resolve({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode('{}'),
        });
      },
    };

    const client = new HTTPClient({ adapter, followRedirects: true });
    client.addRequestInterceptor((req) => ({
      ...req,
      headers: {
        ...req.headers,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Api-Key': 'leak-test',
      },
    }));

    const res = await client
      .post('https://alpha.example/start')
      .text('{}')
      .send();

    expect(followUpHeaders).toHaveLength(1);
    const h = followUpHeaders[0];
    expect(Object.keys(h).every((k) => k === k.toLowerCase())).toBe(true);
    expect(h.accept).toBe('application/json');
    // Interceptor safelisted Content-Type (any casing) must not be overwritten by serializeBody.
    expect(h['content-type']).toMatch(/^application\/json/);
    expect(h['x-api-key']).toBeUndefined();
    expect(h[DEFAULT_REQUEST_ID_HEADER]).toBe(res.requestID);
  });

  test('same-origin redirect preserves caller-supplied Cookie header without a jar', async () => {
    const followUpHeaders: Record<string, string>[] = [];

    const adapter: HTTPAdapter = {
      getType: () => 'mock',
      send: (request: AdapterRequest): Promise<AdapterResponse> => {
        if (request.requestURL === 'https://example.com/start') {
          return Promise.resolve({
            status: 307,
            headers: { location: 'https://example.com/dest' },
            body: null,
          });
        }

        followUpHeaders.push({ ...request.headers });
        return Promise.resolve({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode('{}'),
        });
      },
    };

    const client = new HTTPClient({ adapter, followRedirects: true });

    await client
      .get('https://example.com/start', {
        headers: { cookie: 'sid=123' },
      })
      .send();

    expect(followUpHeaders).toHaveLength(1);
    expect(followUpHeaders[0].cookie).toBe('sid=123');
  });

  test('redirect interceptor cannot leak sensitive headers after rewriting to a cross-origin target', async () => {
    const followUpHeaders: Record<string, string>[] = [];

    const adapter: HTTPAdapter = {
      getType: () => 'mock',
      send: (request: AdapterRequest): Promise<AdapterResponse> => {
        if (request.requestURL === 'https://example.com/start') {
          return Promise.resolve({
            status: 307,
            headers: { location: 'https://example.com/dest' },
            body: null,
          });
        }

        followUpHeaders.push({ ...request.headers });
        return Promise.resolve({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode('{}'),
        });
      },
    };

    const client = new HTTPClient({ adapter, followRedirects: true });
    client.addRequestInterceptor(
      (req, phase) => {
        if (phase.type !== 'redirect') {
          return req;
        }

        return {
          ...req,
          requestURL: 'https://other.example/dest',
          headers: {
            ...req.headers,
            authorization: 'Bearer secret',
            cookie: 'sid=123',
            'x-api-key': 'should-not-leak',
          },
        };
      },
      { phases: ['redirect'] },
    );

    await client
      .get('https://example.com/start', {
        headers: {
          accept: 'application/json',
          authorization: 'Bearer root',
          cookie: 'sid=orig',
        },
      })
      .send();

    expect(followUpHeaders).toHaveLength(1);
    expect(followUpHeaders[0].accept).toBe('application/json');
    expect(followUpHeaders[0].authorization).toBeUndefined();
    expect(followUpHeaders[0].cookie).toBeUndefined();
    expect(followUpHeaders[0]['x-api-key']).toBeUndefined();
  });

  test('rewrites POST to GET on a 302 redirect and updates builder state', async () => {
    const client = makeClient({ followRedirects: true });
    const builder = client
      .post<{ method: string; body: string }>('/api/redirect/302-post')
      .text('original-body');
    const res = await builder.send();

    expect(res.status).toBe(200);
    expect(res.body.method).toBe('GET');
    expect(res.body.body).toBe('');
    expect(res.initialURL).toBe(`${server.url}/api/redirect/302-post`);
    expect(res.requestURL).toBe(`${server.url}/api/redirect/echo-method`);
    expect(res.redirected).toBe(true);
    expect(res.redirectHistory).toEqual([
      `${server.url}/api/redirect/echo-method`,
    ]);
    expect(builder.state).toBe('completed');
    expect(builder.response?.requestURL).toBe(
      `${server.url}/api/redirect/echo-method`,
    );
  });

  test('response observers receive the final redirected request URL', async () => {
    const client = makeClient({ followRedirects: true });
    const seenUrls: string[] = [];

    client.addResponseObserver((_res, req) => {
      seenUrls.push(req.requestURL);
    });

    await client.get('/api/redirect/301').send();
    expect(seenUrls).toEqual([`${server.url}/api/test`]);
  });

  test('response observer with phases redirect sees each redirect HTTP response', async () => {
    const client = makeClient({ followRedirects: true });
    const snapshots: Array<{
      status: number;
      hop: number;
      from: string;
      to: string;
    }> = [];

    client.addResponseObserver(
      (res, _req, phase) => {
        if (phase.type === 'redirect') {
          snapshots.push({
            status: res.status,
            hop: phase.hop,
            from: phase.from,
            to: phase.to,
          });
        }
      },
      { phases: ['redirect'] },
    );

    const res = await client.get('/api/redirect/301').send();

    expect(res.status).toBe(200);
    expect(snapshots).toEqual([
      {
        status: 301,
        hop: 1,
        from: `${server.url}/api/redirect/301`,
        to: `${server.url}/api/test`,
      },
    ]);
  });

  test('response observer with phases redirect fires once per hop in a chain', async () => {
    const base = 'https://example.com';
    const adapter: HTTPAdapter = {
      getType: () => 'mock',
      send: (request: AdapterRequest): Promise<AdapterResponse> => {
        if (request.requestURL === `${base}/a`) {
          return Promise.resolve({
            status: 301,
            headers: { location: `${base}/b` },
            body: null,
          });
        }

        if (request.requestURL === `${base}/b`) {
          return Promise.resolve({
            status: 302,
            headers: { location: '/c' },
            body: null,
          });
        }

        return Promise.resolve({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode('{}'),
        });
      },
    };

    const client = new HTTPClient({ adapter, followRedirects: true });
    const hops: number[] = [];

    client.addResponseObserver(
      (_res, _req, phase) => {
        if (phase.type === 'redirect') {
          hops.push(phase.hop);
        }
      },
      { phases: ['redirect'] },
    );

    await client.get(`${base}/a`).send();

    expect(hops).toEqual([1, 2]);
  });

  test('single response observer with retry+redirect phases fires once per event not per phase', async () => {
    let targetCalls = 0;

    const adapter: HTTPAdapter = {
      getType: () => 'mock',
      send: (request: AdapterRequest): Promise<AdapterResponse> => {
        if (request.requestURL === 'https://example.com/a') {
          return Promise.resolve({
            status: 301,
            headers: { location: 'https://example.com/b' },
            body: null,
          });
        }

        targetCalls++;
        if (targetCalls < 2) {
          return Promise.resolve({ status: 503, headers: {}, body: null });
        }

        return Promise.resolve({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode('{}'),
        });
      },
    };

    const client = new HTTPClient({ adapter, followRedirects: true });
    const phaseTypes: string[] = [];

    // One registration; `phases` is OR — same callback runs for each matching event
    // (here: redirect response, then retryable 503), not for `final`.
    client.addResponseObserver(
      (_res, _req, phase) => {
        phaseTypes.push(phase.type);
      },
      { phases: ['retry', 'redirect'] },
    );

    await client
      .get('https://example.com/a')
      .retryPolicy({ strategy: 'fixed', maxRetryAttempts: 3, delayMS: 10 })
      .send();

    expect(phaseTypes).toEqual(['redirect', 'retry']);
  });

  test('retry-phase response observer during redirect includes redirect hop info', async () => {
    let targetCalls = 0;
    const adapter: HTTPAdapter = {
      getType: () => 'mock',
      send: (request: AdapterRequest): Promise<AdapterResponse> => {
        if (request.requestURL === 'https://example.com/a') {
          return Promise.resolve({
            status: 301,
            headers: { location: 'https://example.com/b' },
            body: null,
          });
        }
        targetCalls++;
        if (targetCalls < 2) {
          return Promise.resolve({ status: 503, headers: {}, body: null });
        }
        return Promise.resolve({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode('{}'),
        });
      },
    };

    const client = new HTTPClient({ adapter, followRedirects: true });
    const retryPhases: Array<{ redirect?: RedirectHopInfo }> = [];

    client.addResponseObserver(
      (_res, _req, phase) => {
        if (phase.type === 'retry') {
          retryPhases.push(
            phase.redirect !== undefined ? { redirect: phase.redirect } : {},
          );
        }
      },
      { phases: ['retry'] },
    );

    await client
      .get('https://example.com/a')
      .retryPolicy({ strategy: 'fixed', maxRetryAttempts: 3, delayMS: 10 })
      .send();

    expect(retryPhases).toEqual([
      {
        redirect: {
          hop: 1,
          from: 'https://example.com/a',
          to: 'https://example.com/b',
          statusCode: 301,
        },
      },
    ]);
  });

  test('redirect hop policy retry runs retry-phase request interceptors when redirect set', async () => {
    let targetCalls = 0;

    const adapter: HTTPAdapter = {
      getType: () => 'mock',
      send: (request: AdapterRequest): Promise<AdapterResponse> => {
        if (request.requestURL === 'https://example.com/a') {
          return Promise.resolve({
            status: 301,
            headers: { location: 'https://example.com/b' },
            body: null,
          });
        }
        targetCalls++;
        if (targetCalls < 2) {
          return Promise.resolve({ status: 503, headers: {}, body: null });
        }
        expect(request.headers['x-retry-redirect']).toBe('1');
        return Promise.resolve({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode('{}'),
        });
      },
    };

    const client = new HTTPClient({ adapter, followRedirects: true });
    const redirectHopSeen: number[] = [];

    client.addRequestInterceptor(
      (req, phase) => {
        if (phase.type === 'retry' && phase.redirect !== undefined) {
          redirectHopSeen.push(phase.redirect.hop);

          return {
            ...req,
            headers: {
              ...req.headers,
              'x-retry-redirect': String(phase.redirect.hop),
            },
          };
        }
        return req;
      },
      { phases: ['retry'] },
    );

    await client
      .get('https://example.com/a')
      .retryPolicy({ strategy: 'fixed', maxRetryAttempts: 3, delayMS: 10 })
      .send();

    expect(redirectHopSeen).toEqual([1]);
  });

  test('redirect follow-up respects timeout and returns a timeout response', async () => {
    const client = makeClient({ followRedirects: true });
    const builder = client.get('/api/redirect/302-slow').timeout(100);
    const res = await builder.send();

    expect(res.status).toBe(0);
    expect(res.isTimeout).toBe(true);
    expect(res.isCancelled).toBe(false);
    expect(builder.error?.code).toBe('timeout');
    expect(res.initialURL).toBe(`${server.url}/api/redirect/302-slow`);
    expect(res.requestURL).toBe(`${server.url}/api/slow`);
    expect(res.redirected).toBe(true);
    expect(res.redirectHistory).toEqual([`${server.url}/api/slow`]);
  });

  test('redirect progress callbacks inject redirect attempt and hop metadata', async () => {
    const uploadEvents: Array<{
      loaded: number;
      total: number;
      progress: number;
      attemptNumber: number;
      hopNumber?: number;
    }> = [];
    const downloadEvents: Array<{
      loaded: number;
      total: number;
      progress: number;
      attemptNumber: number;
      hopNumber?: number;
    }> = [];
    let callCount = 0;

    const adapter: HTTPAdapter = {
      getType: () => 'mock',
      send: (request: AdapterRequest): Promise<AdapterResponse> => {
        callCount++;

        if (callCount === 1) {
          return Promise.resolve({
            status: 301,
            headers: { location: 'https://example.com/redirected' },
            body: null,
          });
        }

        request.onUploadProgress?.({
          loaded: 2,
          total: 4,
          progress: 0.5,
          attemptNumber: 99,
        });
        request.onDownloadProgress?.({
          loaded: 6,
          total: 8,
          progress: 0.75,
          attemptNumber: 100,
        });

        return Promise.resolve({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode('{"ok":true}'),
        });
      },
    };

    const client = new HTTPClient({ adapter, followRedirects: true });
    const res = await client
      .get('https://example.com/start')
      .onUploadProgress((event) => uploadEvents.push(event))
      .onDownloadProgress((event) => downloadEvents.push(event))
      .send<{ ok: boolean }>();

    expect(res.status).toBe(200);
    expect(res.redirected).toBe(true);
    expect(uploadEvents).toEqual([
      { loaded: 2, total: 4, progress: 0.5, attemptNumber: 2, hopNumber: 1 },
    ]);
    expect(downloadEvents).toEqual([
      {
        loaded: 6,
        total: 8,
        progress: 0.75,
        attemptNumber: 2,
        hopNumber: 1,
      },
    ]);
  });

  test('returns redirect_loop when maxRedirects is exceeded', async () => {
    const client = makeClient({ followRedirects: true, maxRedirects: 1 });
    const errorCodes: string[] = [];

    client.addErrorObserver((err) => {
      errorCodes.push(err.code);
    });

    const builder = client.get('/api/redirect/loop-a');
    const res = await builder.send();

    expect(res.status).toBe(0);
    expect(res.isNetworkError).toBe(true);
    expect(res.isCancelled).toBe(false);
    expect(res.isTimeout).toBe(false);
    expect(res.initialURL).toBe(`${server.url}/api/redirect/loop-a`);
    expect(res.requestURL).toBe(`${server.url}/api/redirect/loop-b`);
    expect(res.redirected).toBe(true);
    expect(res.redirectHistory).toEqual([`${server.url}/api/redirect/loop-b`]);
    expect(builder.state).toBe('failed');
    expect(builder.error?.code).toBe('redirect_loop');
    expect(builder.error?.message).toBe('Redirect limit exceeded');
    expect(builder.error?.initialURL).toBe(`${server.url}/api/redirect/loop-a`);
    expect(builder.error?.requestURL).toBe(`${server.url}/api/redirect/loop-b`);
    expect(builder.error?.redirected).toBe(true);
    expect(builder.error?.redirectHistory).toEqual([
      `${server.url}/api/redirect/loop-b`,
    ]);
    expect(errorCodes).toEqual(['redirect_loop']);
  });
});

describe('HTTPClient — sub-clients', () => {
  test('sub-client defaultHeaders override inherited headers by default', () => {
    const root = new InspectableHTTPClient({
      defaultHeaders: { 'x-root': 'yes', authorization: 'root-token' },
    });

    const subConfig = root.buildSubConfig({
      defaultHeaders: { 'x-sub': 'yes', authorization: 'sub-token' },
    });

    expect(subConfig.defaultHeaders).toEqual({
      'x-sub': 'yes',
      authorization: 'sub-token',
    });
  });

  test('sub-client defaultHeaders can be merged explicitly', () => {
    const root = new InspectableHTTPClient({
      defaultHeaders: { 'x-root': 'yes', authorization: 'root-token' },
    });

    const subConfig = root.buildSubConfig({
      defaultHeaders: { 'x-sub': 'yes', authorization: 'sub-token' },
      defaultHeadersStrategy: 'merge',
    });

    expect(subConfig.defaultHeaders).toEqual({
      'x-root': 'yes',
      'x-sub': 'yes',
      authorization: 'sub-token',
    });
  });

  test('sub-client cookieJar inherits by default', () => {
    const jar = new CookieJar();
    const root = new InspectableHTTPClient({ cookieJar: jar });

    const subConfig = root.buildSubConfig();

    expect(subConfig.cookieJar).toBe(jar);
  });

  test('sub-client cookieJar can be explicitly disabled with null', () => {
    const jar = new CookieJar();
    const root = new InspectableHTTPClient({ cookieJar: jar });

    const subConfig = root.buildSubConfig({ cookieJar: null });

    expect(subConfig.cookieJar).toBeNull();
  });

  test('sub-client inherits baseURL and headers', async () => {
    const root = makeClient({ defaultHeaders: { 'x-root': 'yes' } });
    const sub = root.createSubClient({ defaultHeaders: { 'x-sub': 'yes' } });

    const res = await sub
      .get('/api/test')
      .send<{ headers: Record<string, string> }>();

    expect(res.body.headers['x-sub']).toBe('yes');
    // Note: sub-client defaultHeaders override root's for same key
  });

  test('sub-client parent interceptors run before sub-client interceptors', async () => {
    const root = makeClient();
    const order: string[] = [];

    root.addRequestInterceptor((req) => {
      order.push('root');
      return req;
    });

    const sub = root.createSubClient();
    sub.addRequestInterceptor((req) => {
      order.push('sub');
      return req;
    });

    await sub.get('/api/test').send();
    expect(order).toEqual(['root', 'sub']);
  });

  test('sub-client does not expose createSubClient()', () => {
    const root = makeClient();
    const sub = root.createSubClient();
    expect('createSubClient' in sub).toBe(false);
  });

  test('cancelAll() on sub-client cancels parent requests too', async () => {
    const root = makeClient();
    const sub = root.createSubClient();

    const rootReq = root.get('/api/slow').send();
    setTimeout(() => sub.cancelAll(), 10);

    const res = await rootReq;
    expect(res.isCancelled).toBe(true);
  });

  test('cancelOwn() only cancels own requests', async () => {
    const root = makeClient();
    const sub = root.createSubClient();

    const rootReq = root.get('/api/slow').send();
    const subReq = sub.get('/api/slow').send();

    setTimeout(() => sub.cancelOwn(), 10);

    const [rootRes, subRes] = await Promise.all([rootReq, subReq]);
    expect(subRes.isCancelled).toBe(true);
    // root request continues (or completes normally)
    expect(rootRes.isCancelled).toBe(false);
  });

  test('cancelOwnWithLabel() cancels only own requests with that label', async () => {
    const root = makeClient();
    const sub = root.createSubClient();

    const rootLabeled = root.get('/api/slow').label('target').send();
    const subLabeled = sub.get('/api/slow').label('target').send();
    const subOther = sub.get('/api/slow').label('other').send();

    setTimeout(() => sub.cancelOwnWithLabel('target'), 10);

    const [rootRes, subLabeledRes, subOtherRes] = await Promise.all([
      rootLabeled,
      subLabeled,
      subOther,
    ]);

    expect(subLabeledRes.isCancelled).toBe(true);
    expect(rootRes.isCancelled).toBe(false);
    expect(subOtherRes.isCancelled).toBe(false);
  });
});

describe('HTTPClient — listRequests', () => {
  test('listRequests() defaults to own scope', async () => {
    const root = makeClient();
    const sub = root.createSubClient();

    const rootReq = root.get('/api/slow').label('root-req').send();
    const subReq = sub.get('/api/slow').label('sub-req').send();

    await new Promise((r) => setTimeout(r, 5));

    expect(root.listRequests().requests.map((r) => r.label)).toEqual([
      'root-req',
    ]);
    expect(sub.listRequests().requests.map((r) => r.label)).toEqual([
      'sub-req',
    ]);

    await Promise.all([rootReq, subReq]);
  });

  test('listRequests({ scope: "all" }) returns all clients', async () => {
    const root = makeClient();
    const sub = root.createSubClient();

    const rootReq = root.get('/api/slow').send();
    const subReq = sub.get('/api/slow').send();

    await new Promise((r) => setTimeout(r, 5));

    expect(root.listRequests({ scope: 'all' }).count).toBe(2);

    await Promise.all([rootReq, subReq]);
  });

  test('listRequests({ label }) filters by label', async () => {
    const client = makeClient();

    const a = client.get('/api/slow').label('keep').send();
    const b = client.get('/api/slow').label('drop').send();

    await new Promise((r) => setTimeout(r, 5));

    const result = client.listRequests({ label: 'keep' });
    expect(result.count).toBe(1);
    expect(result.requests[0]?.label).toBe('keep');

    await Promise.all([a, b]);
  });

  test('listRequests() reflects waiting_for_retry while backoff is pending', async () => {
    let callCount = 0;

    const adapter: HTTPAdapter = {
      getType: () => 'mock',
      send: (): Promise<AdapterResponse> => {
        callCount++;

        if (callCount === 1) {
          return Promise.resolve({ status: 503, headers: {}, body: null });
        }

        return Promise.resolve({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode('{}'),
        });
      },
    };

    const client = new HTTPClient({ adapter, followRedirects: true });
    const builder = client
      .get('https://example.com/flaky')
      .retryPolicy({ strategy: 'fixed', maxRetryAttempts: 1, delayMS: 50 });

    const pending = builder.send();

    await new Promise((r) => setTimeout(r, 10));

    const result = client.listRequests();
    expect(builder.state).toBe('waiting_for_retry');
    expect(result.count).toBe(1);
    expect(result.requests[0]?.state).toBe('waiting_for_retry');

    await pending;
  });

  test('count matches requests array length', async () => {
    const client = makeClient();

    const a = client.get('/api/slow').send();
    const b = client.get('/api/slow').send();

    await new Promise((r) => setTimeout(r, 5));

    const result = client.listRequests();
    expect(result.count).toBe(result.requests.length);
    expect(result.count).toBe(2);

    await Promise.all([a, b]);
  });
});

describe('HTTPClient — options shorthand', () => {
  test('get with params option', async () => {
    const client = makeClient();
    const res = await client
      .get('/api/query', { params: { foo: 'bar', num: 42 } })
      .send<{ params: Record<string, string> }>();
    expect(res.body.params.foo).toBe('bar');
    expect(res.body.params.num).toBe('42');
  });

  test('get with headers option', async () => {
    const client = makeClient();
    const res = await client
      .get('/api/test', { headers: { 'x-shorthand': 'yes' } })
      .send<{ headers: Record<string, string> }>();
    expect(res.body.headers['x-shorthand']).toBe('yes');
  });

  test('post with body option', async () => {
    const client = makeClient();
    const res = await client
      .post('/api/users', { body: { name: 'Alice' } })
      .send<{ created: boolean }>();
    expect(res.status).toBe(201);
    expect(res.body.created).toBe(true);
  });

  test('get with timeout option', async () => {
    const client = makeClient();
    const res = await client.get('/api/slow', { timeout: 100 }).send();
    expect(res.isTimeout).toBe(true);
  });

  test('options and fluent chain can be mixed', async () => {
    const client = makeClient();
    const res = await client
      .get('/api/query', { params: { foo: 'bar' } })
      .headers({ 'x-extra': 'yes' })
      .send<{ params: Record<string, string> }>();
    expect(res.body.params.foo).toBe('bar');
  });
});

describe('HTTPClient — disable/enable', () => {
  test('disabled client throws on .send()', () => {
    const client = makeClient();
    client.disable();

    expect(client.get('/api/test').send()).rejects.toThrow(/disabled/);
    client.enable();
  });

  test('disabled parent causes sub-client to throw', () => {
    const root = makeClient();
    const sub = root.createSubClient();
    root.disable();

    expect(sub.get('/api/test').send()).rejects.toThrow(/disabled/);
    root.enable();
  });
});

describe('HTTPClient — builder state', () => {
  test('builder state transitions: pending → sending → completed', async () => {
    const client = makeClient();
    const builder = client.get('/api/test');

    expect(builder.state).toBe('pending');

    const promise = builder.send();
    // State should be 'sending' while in-flight (best-effort check)

    await promise;
    expect(builder.state).toBe('completed');
  });

  test('calling .send() twice throws', async () => {
    const client = makeClient();
    const builder = client.get('/api/test');
    await builder.send();

    expect(() => builder.send()).toThrow(/once/);
  });

  test('builder.requestID is available after send()', async () => {
    const client = makeClient();
    const builder = client.get('/api/test');
    await builder.send();

    expect(typeof builder.requestID).toBe('string');
    expect(builder.requestID.length).toBeGreaterThan(0);
  });

  test('startedAt is set after send()', async () => {
    const before = Date.now();
    const client = makeClient();
    const builder = client.get('/api/test');
    await builder.send();
    const after = Date.now();

    expect(builder.startedAt).toBeGreaterThanOrEqual(before);
    expect(builder.startedAt).toBeLessThanOrEqual(after);
  });

  test('elapsedMS is non-null after send()', async () => {
    const client = makeClient();
    const builder = client.get('/api/test');
    await builder.send();

    expect(builder.elapsedMS).toBeGreaterThanOrEqual(0);
  });

  test('startedAt and elapsedMS are null before send()', () => {
    const client = makeClient();
    const builder = client.get('/api/test');

    expect(builder.startedAt).toBeNull();
    expect(builder.elapsedMS).toBeNull();
  });

  test('state transitions through waiting_for_retry during retries', async () => {
    const states: string[] = [];
    let callCount = 0;

    const adapter: HTTPAdapter = {
      getType: () => 'mock',
      send: (_request: AdapterRequest): Promise<AdapterResponse> => {
        callCount++;

        if (callCount < 3) {
          return Promise.resolve({
            status: 503,
            headers: {},
            body: null,
          });
        }

        return Promise.resolve({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode('{"ok":true}'),
        });
      },
    };

    const client = new HTTPClient({ adapter, followRedirects: true });
    const builder = client
      .get('https://example.com/flaky')
      .retryPolicy({ strategy: 'fixed', maxRetryAttempts: 3, delayMS: 10 })
      .onAttemptEnd(() => states.push(builder.state));

    await builder.send();

    expect(states[0]).toBe('waiting_for_retry');
    expect(states[1]).toBe('waiting_for_retry');
    expect(builder.state).toBe('completed');
  });

  test('elapsedMS includes retry wait time', async () => {
    let callCount = 0;

    const adapter: HTTPAdapter = {
      getType: () => 'mock',
      send: (_request: AdapterRequest): Promise<AdapterResponse> => {
        callCount++;

        if (callCount < 2) {
          return Promise.resolve({
            status: 503,
            headers: {},
            body: null,
          });
        }

        return Promise.resolve({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode('{"ok":true}'),
        });
      },
    };

    const client = new HTTPClient({ adapter, followRedirects: true });
    const builder = client
      .get('https://example.com/flaky')
      .retryPolicy({ strategy: 'fixed', maxRetryAttempts: 2, delayMS: 50 });

    await builder.send();

    expect(builder.elapsedMS).toBeGreaterThanOrEqual(50);
  });

  test('cancel during retry delay resolves immediately', async () => {
    const adapter: HTTPAdapter = {
      getType: () => 'mock',
      send: (_request: AdapterRequest): Promise<AdapterResponse> =>
        Promise.resolve({
          status: 503,
          headers: {},
          body: null,
        }),
    };

    const client = new HTTPClient({ adapter, followRedirects: true });
    const builder = client
      .get('https://example.com/always-503')
      .retryPolicy({ strategy: 'fixed', maxRetryAttempts: 3, delayMS: 5000 })
      .onAttemptEnd((e) => {
        if (e.willRetry) {
          builder.cancel();
        }
      });

    const start = Date.now();
    const res = await builder.send();
    const elapsed = Date.now() - start;

    expect(res.isCancelled).toBe(true);
    expect(elapsed).toBeLessThan(1000);
  });

  test('cancel after retry delay begins resolves via the abort listener', async () => {
    const adapter: HTTPAdapter = {
      getType: () => 'mock',
      send: (_request: AdapterRequest): Promise<AdapterResponse> =>
        Promise.resolve({
          status: 503,
          headers: {},
          body: null,
        }),
    };

    const client = new HTTPClient({ adapter, followRedirects: true });
    const builder = client
      .get('https://example.com/always-503')
      .retryPolicy({ strategy: 'fixed', maxRetryAttempts: 3, delayMS: 5000 })
      .onAttemptEnd((e) => {
        if (e.willRetry) {
          setTimeout(() => builder.cancel(), 10);
        }
      });

    const start = Date.now();
    const res = await builder.send();
    const elapsed = Date.now() - start;

    expect(res.isCancelled).toBe(true);
    expect(elapsed).toBeLessThan(1000);
  });
});

describe('HTTPClient — phase-aware interceptors', () => {
  test('retry-phase interceptor injects header on retries only', async () => {
    let callCount = 0;
    const sentHeaders: Record<string, string>[] = [];

    const adapter: HTTPAdapter = {
      getType: () => 'mock',
      send: (request: AdapterRequest): Promise<AdapterResponse> => {
        callCount++;
        sentHeaders.push({ ...request.headers });

        if (callCount < 2) {
          return Promise.resolve({ status: 503, headers: {}, body: null });
        }

        return Promise.resolve({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode('{"ok":true}'),
        });
      },
    };

    const client = new HTTPClient({ adapter, followRedirects: true });

    // Only runs on retry phase
    client.addRequestInterceptor(
      (req) => ({
        ...req,
        headers: { ...req.headers, 'x-retry-token': 'refreshed' },
      }),
      { phases: ['retry'] },
    );

    await client
      .get('https://example.com/flaky')
      .retryPolicy({ strategy: 'fixed', maxRetryAttempts: 2, delayMS: 10 })
      .send();

    // First attempt (initial phase) should NOT have the header
    expect(sentHeaders[0]['x-retry-token']).toBeUndefined();
    // Second attempt (retry phase) should have it
    expect(sentHeaders[1]['x-retry-token']).toBe('refreshed');
  });

  test('retry-phase interceptor can rewrite method and body for the retried attempt', async () => {
    let callCount = 0;
    const sentRequests: AdapterRequest[] = [];

    const adapter: HTTPAdapter = {
      getType: () => 'mock',
      send: (request: AdapterRequest): Promise<AdapterResponse> => {
        callCount++;
        sentRequests.push(request);

        if (callCount === 1) {
          return Promise.resolve({ status: 503, headers: {}, body: null });
        }

        return Promise.resolve({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode('{"ok":true}'),
        });
      },
    };

    const client = new HTTPClient({ adapter, followRedirects: true });
    client.addRequestInterceptor(
      (req) => ({
        ...req,
        method: 'POST',
        body: 'retry-body',
      }),
      { phases: ['retry'] },
    );

    await client
      .get('https://example.com/flaky')
      .retryPolicy({ strategy: 'fixed', maxRetryAttempts: 1, delayMS: 10 })
      .send();

    expect(sentRequests).toHaveLength(2);
    expect(sentRequests[0]?.method).toBe('GET');
    expect(sentRequests[1]?.method).toBe('POST');
    expect(sentRequests[1]?.body).toBe('retry-body');
  });

  test('retry-phase interceptor filters and body rewrites use the original structured body', async () => {
    let callCount = 0;
    const sentRequests: AdapterRequest[] = [];

    const adapter: HTTPAdapter = {
      getType: () => 'mock',
      send: (request: AdapterRequest): Promise<AdapterResponse> => {
        callCount++;
        sentRequests.push(request);

        if (callCount === 1) {
          return Promise.resolve({ status: 503, headers: {}, body: null });
        }

        return Promise.resolve({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode('{"ok":true}'),
        });
      },
    };

    const client = new HTTPClient({ adapter, followRedirects: true });
    client.addRequestInterceptor(
      (req) => ({
        ...req,
        headers: { ...req.headers, 'x-retry-body': 'seen' },
        body: { a: 2 },
      }),
      { phases: ['retry'], bodyContainsKeys: ['a'] },
    );

    await client
      .post('https://example.com/flaky')
      .json({ a: 1 })
      .retryPolicy({ strategy: 'fixed', maxRetryAttempts: 1, delayMS: 10 })
      .send();

    expect(sentRequests).toHaveLength(2);
    expect(sentRequests[1]?.headers['x-retry-body']).toBe('seen');
    expect(sentRequests[1]?.body).toBe(JSON.stringify({ a: 2 }));
    expect(sentRequests[1]?.headers['content-type']).toMatch(
      /^application\/json/,
    );
  });

  test('retry-phase interceptor throw stops further attempts and notifies default (final) error observers only', async () => {
    let adapterCalls = 0;

    const adapter: HTTPAdapter = {
      getType: () => 'mock',
      send: () => {
        adapterCalls++;
        return Promise.resolve({ status: 503, headers: {}, body: null });
      },
    };

    const client = new HTTPClient({ adapter, followRedirects: true });
    const finalCodes: string[] = [];
    const retryOnlyCodes: string[] = [];

    client.addRequestInterceptor(
      () => {
        throw new Error('retry interceptor failed');
      },
      { phases: ['retry'] },
    );

    // Default = `final` only — interceptor throws always settle there, not as `retry`.
    client.addErrorObserver((err) => {
      finalCodes.push(err.code);
    });
    // Explicit `retry` — must stay empty; proves we do not emit error observers on the
    // interceptor’s RequestPhase name when it throws.
    client.addErrorObserver(
      (err) => {
        retryOnlyCodes.push(err.code);
      },
      {
        phases: ['retry'],
      },
    );

    const attemptLifecycle: string[] = [];

    const res = await client
      .get('https://example.com/flaky')
      .retryPolicy({ strategy: 'fixed', maxRetryAttempts: 3, delayMS: 10 })
      .onAttemptStart((e) => attemptLifecycle.push(`start:${e.attemptNumber}`))
      .onAttemptEnd((e) => attemptLifecycle.push(`end:${e.attemptNumber}`))
      .send();

    expect(adapterCalls).toBe(1);
    expect(res.status).toBe(0);
    expect(res.isNetworkError).toBe(false);
    expect(finalCodes).toEqual(['interceptor_error']);
    expect(retryOnlyCodes).toEqual([]);
    expect(attemptLifecycle).toEqual(['start:1', 'end:1', 'start:2', 'end:2']);
  });

  test('redirect-phase interceptor injects header on redirects', async () => {
    const client = makeClient({ followRedirects: true });

    client.addRequestInterceptor(
      (req) => ({
        ...req,
        headers: { ...req.headers, 'x-redirect-auth': 'bearer-xyz' },
      }),
      { phases: ['redirect'] },
    );

    const res = await client
      .get('/api/redirect/301')
      .send<{ headers: Record<string, string> }>();

    expect(res.status).toBe(200);
    expect(res.redirected).toBe(true);
    // The redirect-phase interceptor should have injected the header on the redirect hop
    expect(res.body.headers['x-redirect-auth']).toBe('bearer-xyz');
  });

  test('redirect-phase interceptor rewrite uses the sent URL in redirect metadata', async () => {
    const start = 'https://example.com/start';
    const originalTarget = 'https://example.com/original';
    const rewrittenTarget = 'https://example.com/rewritten';
    let rewrittenCalls = 0;

    const adapter: HTTPAdapter = {
      getType: () => 'mock',
      send: (request: AdapterRequest): Promise<AdapterResponse> => {
        if (request.requestURL === start) {
          return Promise.resolve({
            status: 302,
            headers: { location: originalTarget },
            body: null,
          });
        }

        if (request.requestURL === rewrittenTarget) {
          rewrittenCalls++;

          if (rewrittenCalls === 1) {
            return Promise.resolve({ status: 503, headers: {}, body: null });
          }

          return Promise.resolve({
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: new TextEncoder().encode('{"ok":true}'),
          });
        }

        throw new Error(`unexpected URL: ${request.requestURL}`);
      },
    };

    const client = new HTTPClient({ adapter, followRedirects: true });
    const retryRedirectTargets: string[] = [];

    client.addRequestInterceptor(
      (req, phase) =>
        phase.type === 'redirect'
          ? {
              ...req,
              requestURL: rewrittenTarget,
            }
          : req,
      { phases: ['redirect'] },
    );

    client.addResponseObserver(
      (_res, _req, phase) => {
        if (phase.type === 'retry' && phase.redirect) {
          retryRedirectTargets.push(phase.redirect.to);
        }
      },
      { phases: ['retry'] },
    );

    const res = await client
      .get(start)
      .retryPolicy({ strategy: 'fixed', maxRetryAttempts: 1, delayMS: 10 })
      .send();

    expect(res.status).toBe(200);
    expect(res.requestURL).toBe(rewrittenTarget);
    expect(res.redirectHistory).toEqual([rewrittenTarget]);
    expect(retryRedirectTargets).toEqual([rewrittenTarget]);
  });

  test('redirect-phase interceptor throw sets requestURL and redirectHistory to redirect target', async () => {
    const start = 'https://example.com/start';
    const target = 'https://example.com/target';

    const adapter: HTTPAdapter = {
      getType: () => 'mock',
      send: (request: AdapterRequest): Promise<AdapterResponse> => {
        if (request.requestURL === start) {
          return Promise.resolve({
            status: 301,
            headers: { location: '/target' },
            body: null,
          });
        }
        return Promise.resolve({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode('{}'),
        });
      },
    };

    const client = new HTTPClient({ adapter, followRedirects: true });
    const finalCodes: string[] = [];
    const redirectOnlyCodes: string[] = [];
    const finalObserverRequestURLs: string[] = [];

    // Same pattern as retry-phase interceptor throw: settlement is `final` only.
    client.addErrorObserver((err, request) => {
      finalCodes.push(err.code);
      finalObserverRequestURLs.push(request.requestURL);
    });

    client.addErrorObserver(
      (err) => {
        redirectOnlyCodes.push(err.code);
      },
      {
        phases: ['redirect'],
      },
    );

    client.addRequestInterceptor(
      () => {
        throw new Error('redirect interceptor failed');
      },
      { phases: ['redirect'] },
    );

    const builder = client.get(start);
    const res = await builder.send();

    expect(res.status).toBe(0);
    expect(builder.error?.code).toBe('interceptor_error');
    expect(finalCodes).toEqual(['interceptor_error']);
    expect(finalObserverRequestURLs).toEqual([target]);
    expect(redirectOnlyCodes).toEqual([]);
    expect(res.initialURL).toBe(start);
    expect(res.requestURL).toBe(target);
    expect(res.redirectHistory).toEqual([target]);
    expect(builder.error?.requestURL).toBe(target);
    expect(builder.error?.redirectHistory).toEqual([target]);
  });

  test('redirect-phase interceptor cancel sets requestURL and redirectHistory to redirect target', async () => {
    const start = 'https://example.com/a';
    const target = 'https://example.com/b';

    const adapter: HTTPAdapter = {
      getType: () => 'mock',
      send: (request: AdapterRequest): Promise<AdapterResponse> => {
        if (request.requestURL === start) {
          return Promise.resolve({
            status: 302,
            headers: { location: target },
            body: null,
          });
        }
        return Promise.resolve({
          status: 200,
          headers: {},
          body: null,
        });
      },
    };

    const client = new HTTPClient({ adapter, followRedirects: true });
    const finalObserverRequestURLs: string[] = [];
    client.addErrorObserver((_err, request) => {
      finalObserverRequestURLs.push(request.requestURL);
    });
    client.addRequestInterceptor(
      () => ({ cancel: true as const, reason: 'no redirect' }),
      { phases: ['redirect'] },
    );

    const res = await client.get(start).send();

    expect(res.isCancelled).toBe(true);
    expect(finalObserverRequestURLs).toEqual([target]);
    expect(res.initialURL).toBe(start);
    expect(res.requestURL).toBe(target);
    expect(res.redirectHistory).toEqual([target]);
  });

  test('redirect-phase interceptor throw on second hop preserves original initialURL and full history', async () => {
    const a = 'https://example.com/a';
    const b = 'https://example.com/b';
    const c = 'https://example.com/c';

    const adapter: HTTPAdapter = {
      getType: () => 'mock',
      send: (request: AdapterRequest): Promise<AdapterResponse> => {
        if (request.requestURL === a) {
          return Promise.resolve({
            status: 301,
            headers: { location: b },
            body: null,
          });
        }
        if (request.requestURL === b) {
          return Promise.resolve({
            status: 301,
            headers: { location: c },
            body: null,
          });
        }
        return Promise.resolve({
          status: 200,
          headers: {},
          body: null,
        });
      },
    };

    let redirectHop = 0;
    const client = new HTTPClient({ adapter, followRedirects: true });
    client.addRequestInterceptor(
      (_req, phase) => {
        if (phase.type !== 'redirect') {
          return _req;
        }
        redirectHop++;
        if (redirectHop === 2) {
          throw new Error('fail on second redirect');
        }
        return _req;
      },
      { phases: ['redirect'] },
    );

    const res = await client.get(a).send();

    expect(res.initialURL).toBe(a);
    expect(res.requestURL).toBe(c);
    expect(res.redirectHistory).toEqual([b, c]);
  });

  test('redirect-phase response observer sees post-interceptor request on subsequent hops', async () => {
    const a = 'https://example.com/a';
    const b = 'https://example.com/b';
    const c = 'https://example.com/c';

    const adapter: HTTPAdapter = {
      getType: () => 'mock',
      send: (request: AdapterRequest): Promise<AdapterResponse> => {
        if (request.requestURL === a) {
          return Promise.resolve({
            status: 301,
            headers: { location: b },
            body: null,
          });
        }

        if (request.requestURL === b) {
          return Promise.resolve({
            status: 301,
            headers: { location: c },
            body: null,
          });
        }
        return Promise.resolve({ status: 200, headers: {}, body: null });
      },
    };

    const client = new HTTPClient({ adapter, followRedirects: true });

    // Redirect interceptor stamps a header on every redirect hop it processes
    client.addRequestInterceptor(
      (req) => ({
        ...req,
        headers: { ...req.headers, 'x-intercepted': 'yes' },
      }),
      { phases: ['redirect'] },
    );

    // Collect the `request` argument passed to the redirect-phase response observer
    const observedHeaders: Array<Record<string, string>> = [];
    client.addResponseObserver(
      (_res, request) => {
        observedHeaders.push({ ...request.headers });
      },
      { phases: ['redirect'] },
    );

    await client.get(a).send();

    // Hop 1 (a→b): observer fires with currentInterceptedRequest = finalRequest
    // (post-initial-interceptor). The redirect interceptor for hop a→b hasn't run
    // yet — no x-intercepted header.
    expect(observedHeaders[0]['x-intercepted']).toBeUndefined();
    // Hop 2 (b→c): observer fires with currentInterceptedRequest = redirectIntercept
    // from hop a→b (post-interceptor). Before the fix it used redirectRequest
    // (pre-interceptor) and x-intercepted would be absent.
    expect(observedHeaders[1]['x-intercepted']).toBe('yes');
  });

  test('interceptor context contains initialURL and redirectHistory during redirect', async () => {
    const a = 'https://example.com/a';
    const b = 'https://example.com/b';
    const c = 'https://example.com/c';

    const adapter: HTTPAdapter = {
      getType: () => 'mock',
      send: (request: AdapterRequest): Promise<AdapterResponse> => {
        if (request.requestURL === a) {
          return Promise.resolve({
            status: 301,
            headers: { location: b },
            body: null,
          });
        }
        if (request.requestURL === b) {
          return Promise.resolve({
            status: 302,
            headers: { location: c },
            body: null,
          });
        }
        return Promise.resolve({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode('{}'),
        });
      },
    };

    const client = new HTTPClient({ adapter, followRedirects: true });
    const contexts: RequestInterceptorContext[] = [];

    client.addRequestInterceptor(
      (req, _phase, context) => {
        contexts.push({
          ...context,
          redirectHistory: [...context.redirectHistory],
        });
        return req;
      },
      { phases: ['initial', 'redirect'] },
    );

    await client.get(a).send();

    expect(contexts).toHaveLength(3);
    // Initial phase: no redirects yet
    expect(contexts[0].initialURL).toBe(a);
    expect(contexts[0].redirectHistory).toEqual([]);
    // First redirect hop: a → b
    expect(contexts[1].initialURL).toBe(a);
    expect(contexts[1].redirectHistory).toEqual([b]);
    // Second redirect hop: b → c
    expect(contexts[2].initialURL).toBe(a);
    expect(contexts[2].redirectHistory).toEqual([b, c]);
  });

  test('cancel from initial-phase interceptor returns cancelled response', async () => {
    const adapterCalls: string[] = [];

    const adapter: HTTPAdapter = {
      getType: () => 'mock',
      send: (request: AdapterRequest): Promise<AdapterResponse> => {
        adapterCalls.push(request.requestURL);
        return Promise.resolve({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode('{"ok":true}'),
        });
      },
    };

    const client = new HTTPClient({ adapter, followRedirects: true });
    const errorCodes: string[] = [];

    client.addRequestInterceptor(() => ({
      cancel: true as const,
      reason: 'blocked by policy',
    }));

    client.addErrorObserver((err) => {
      errorCodes.push(err.code);
    });

    const builder = client.get('https://example.com/blocked');
    const res = await builder.send();

    expect(res.status).toBe(0);
    expect(res.isCancelled).toBe(true);
    expect(builder.state).toBe('cancelled');

    // Adapter should never have been called
    expect(adapterCalls).toEqual([]);
    expect(errorCodes.length).toBeGreaterThan(0);
  });

  test('cancel from retry-phase interceptor stops retries', async () => {
    let callCount = 0;

    const adapter: HTTPAdapter = {
      getType: () => 'mock',
      send: (_request: AdapterRequest): Promise<AdapterResponse> => {
        callCount++;
        return Promise.resolve({ status: 503, headers: {}, body: null });
      },
    };

    const client = new HTTPClient({ adapter, followRedirects: true });

    // Cancel on the second attempt (retry phase)
    client.addRequestInterceptor(
      () => ({ cancel: true as const, reason: 'no more retries' }),
      { phases: ['retry'] },
    );

    const attemptLifecycle: string[] = [];

    const res = await client
      .get('https://example.com/flaky')
      .retryPolicy({ strategy: 'fixed', maxRetryAttempts: 3, delayMS: 10 })
      .onAttemptStart((e) => attemptLifecycle.push(`start:${e.attemptNumber}`))
      .onAttemptEnd((e) => attemptLifecycle.push(`end:${e.attemptNumber}`))
      .send();

    expect(res.isCancelled).toBe(true);
    // Only one adapter call — the initial attempt. Retry was cancelled by interceptor.
    expect(callCount).toBe(1);
    expect(attemptLifecycle).toEqual(['start:1', 'end:1', 'start:2', 'end:2']);
  });

  test('interceptor registered for initial phase only does not run on retry', async () => {
    let callCount = 0;
    let interceptorCalls = 0;

    const adapter: HTTPAdapter = {
      getType: () => 'mock',
      send: (_request: AdapterRequest): Promise<AdapterResponse> => {
        callCount++;

        if (callCount < 2) {
          return Promise.resolve({ status: 503, headers: {}, body: null });
        }

        return Promise.resolve({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode('{"ok":true}'),
        });
      },
    };

    const client = new HTTPClient({ adapter, followRedirects: true });

    // Default phase = initial only
    client.addRequestInterceptor((req) => {
      interceptorCalls++;
      return req;
    });

    await client
      .get('https://example.com/flaky')
      .retryPolicy({ strategy: 'fixed', maxRetryAttempts: 2, delayMS: 10 })
      .send();

    // Interceptor only ran once (initial), not on the retry
    expect(interceptorCalls).toBe(1);
    expect(callCount).toBe(2);
  });

  test('default response observer fires once after retries finish (final phase only)', async () => {
    let callCount = 0;
    const observedStatuses: number[] = [];

    const adapter: HTTPAdapter = {
      getType: () => 'mock',
      send: (_request: AdapterRequest): Promise<AdapterResponse> => {
        callCount++;

        if (callCount < 2) {
          return Promise.resolve({ status: 503, headers: {}, body: null });
        }

        return Promise.resolve({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode('{"ok":true}'),
        });
      },
    };

    const client = new HTTPClient({ adapter, followRedirects: true });

    // Only observe final phase (default)
    client.addResponseObserver((res) => {
      observedStatuses.push(res.status);
    });

    const res = await client
      .get('https://example.com/flaky')
      .retryPolicy({ strategy: 'fixed', maxRetryAttempts: 2, delayMS: 10 })
      .send();

    expect(res.status).toBe(200);
    // Observer should only fire once — on the final successful response
    expect(observedStatuses).toEqual([200]);
  });

  test('response observer with phases retry fires once per retryable HTTP response before final', async () => {
    let callCount = 0;
    const finalStatuses: number[] = [];
    const retrySnapshots: Array<{
      status: number;
      phase:
        | { type: 'retry'; attempt: number; redirect?: RedirectHopInfo }
        | { type: string; attempt: number };
    }> = [];

    const adapter: HTTPAdapter = {
      getType: () => 'mock',
      send: (_request: AdapterRequest): Promise<AdapterResponse> => {
        callCount++;

        if (callCount < 3) {
          return Promise.resolve({ status: 503, headers: {}, body: null });
        }

        return Promise.resolve({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode('{"ok":true}'),
        });
      },
    };

    const client = new HTTPClient({ adapter });

    // Default = `final` only — one call with the successful 200 after retries complete.
    client.addResponseObserver((res) => {
      finalStatuses.push(res.status);
    });
    // Opt in to `retry` — one call per retryable 503 before the next attempt.
    client.addResponseObserver(
      (res, _req, phase) => {
        retrySnapshots.push({
          status: res.status,
          phase:
            phase.type === 'retry'
              ? {
                  type: phase.type,
                  attempt: phase.attempt,
                  ...(phase.redirect !== undefined
                    ? { redirect: phase.redirect }
                    : {}),
                }
              : { type: phase.type, attempt: -1 },
        });
      },
      { phases: ['retry'] },
    );

    const res = await client
      .get('https://example.com/flaky')
      .retryPolicy({ strategy: 'fixed', maxRetryAttempts: 3, delayMS: 10 })
      .send();

    expect(res.status).toBe(200);
    expect(finalStatuses).toEqual([200]);
    expect(retrySnapshots).toEqual([
      {
        status: 503,
        phase: { type: 'retry', attempt: 1 },
      },
      {
        status: 503,
        phase: { type: 'retry', attempt: 2 },
      },
    ]);
  });

  test('error observer with phases retry fires when adapter throws and a retry follows', async () => {
    let callCount = 0;
    const finalOnlyCodes: string[] = [];
    const retryOutcomes: Array<{ code: string; attempt: number }> = [];

    const adapter: HTTPAdapter = {
      getType: () => 'mock',
      send: (_request: AdapterRequest): Promise<AdapterResponse> => {
        callCount++;
        if (callCount < 2) {
          throw new Error('transient');
        }
        return Promise.resolve({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode('{}'),
        });
      },
    };

    const client = new HTTPClient({ adapter });

    // Default error observers only run on phase `final`. The first throw is retried, so
    // `send()` must not notify them yet — we assert `finalOnlyCodes` stays empty.
    client.addErrorObserver((err) => {
      finalOnlyCodes.push(err.code);
    });

    // Opt in to `retry` to observe the intermediate adapter_error (same code shape as
    // terminal failures, but phase is `retry` while another attempt will run).
    client.addErrorObserver(
      (err, _req, phase) => {
        if (phase.type === 'retry') {
          retryOutcomes.push({ code: err.code, attempt: phase.attempt });
        }
      },
      { phases: ['retry'] },
    );

    const res = await client
      .get('https://example.com/flaky')
      .retryPolicy({ strategy: 'fixed', maxRetryAttempts: 2, delayMS: 10 })
      .send();

    expect(res.status).toBe(200);
    expect(finalOnlyCodes).toEqual([]);
    expect(retryOutcomes).toEqual([{ code: 'adapter_error', attempt: 1 }]);
  });

  test('adapter that throws gets adapter_error code', async () => {
    const adapter: HTTPAdapter = {
      getType: () => 'mock',
      send: (_request: AdapterRequest): Promise<AdapterResponse> => {
        throw new Error('DNS lookup failed');
      },
    };

    const client = new HTTPClient({ adapter });
    const errorCodes: string[] = [];

    client.addErrorObserver((err) => {
      errorCodes.push(err.code);
    });

    const builder = client.get('https://example.com/test');
    const res = await builder.send();

    expect(res.status).toBe(0);
    expect(res.isNetworkError).toBe(true);
    expect(builder.state).toBe('failed');
    expect(builder.error?.code).toBe('adapter_error');
    expect(builder.error?.message).toBe('Adapter error');
    expect(builder.error?.cause?.message).toBe('DNS lookup failed');
    expect(errorCodes).toEqual(['adapter_error']);
  });

  test('adapter that throws during redirect gets adapter_error code', async () => {
    let callCount = 0;

    const adapter: HTTPAdapter = {
      getType: () => 'mock',
      send: (_request: AdapterRequest): Promise<AdapterResponse> => {
        callCount++;

        // First call returns redirect
        if (callCount === 1) {
          return Promise.resolve({
            status: 301,
            headers: { location: 'https://example.com/redirected' },
            body: null,
          });
        }

        // Second call (redirect hop) throws
        throw new Error('Connection refused');
      },
    };

    const client = new HTTPClient({ adapter, followRedirects: true });
    const errorCodes: string[] = [];

    client.addErrorObserver((err) => {
      errorCodes.push(err.code);
    });

    const builder = client.get('https://example.com/test');
    const res = await builder.send();

    expect(res.status).toBe(0);
    expect(res.isNetworkError).toBe(true);
    expect(res.redirected).toBe(true);
    expect(builder.state).toBe('failed');
    expect(builder.error?.code).toBe('adapter_error');
    expect(builder.error?.message).toBe('Adapter error');
    expect(builder.error?.cause?.message).toBe('Connection refused');
    expect(errorCodes).toEqual(['adapter_error']);
  });

  test('redirect hop sets isRetriesExhausted when shared retry budget is exhausted', async () => {
    let callCount = 0;

    const adapter: HTTPAdapter = {
      getType: () => 'mock',
      send: (_request: AdapterRequest): Promise<AdapterResponse> => {
        callCount++;

        if (callCount === 1) {
          return Promise.resolve({
            status: 301,
            headers: { location: 'https://example.com/redirected' },
            body: null,
          });
        }

        throw new Error('fail');
      },
    };

    const client = new HTTPClient({
      adapter,
      followRedirects: true,
      retryPolicy: { strategy: 'fixed', maxRetryAttempts: 1, delayMS: 1 },
    });

    const builder = client.get('https://example.com/start');
    const res = await builder.send();

    expect(res.status).toBe(0);
    expect(builder.error?.code).toBe('adapter_error');
    expect(builder.error?.isRetriesExhausted).toBe(true);
  });

  test('redirect hop sets isRetriesExhausted when status 0 exhausts retry policy', async () => {
    let callCount = 0;

    const adapter: HTTPAdapter = {
      getType: () => 'mock',
      send: (_request: AdapterRequest): Promise<AdapterResponse> => {
        callCount++;

        if (callCount === 1) {
          return Promise.resolve({
            status: 301,
            headers: { location: 'https://example.com/redirected' },
            body: null,
          });
        }

        return Promise.resolve({
          status: 0,
          headers: {},
          body: null,
        });
      },
    };

    const client = new HTTPClient({
      adapter,
      followRedirects: true,
      retryPolicy: { strategy: 'fixed', maxRetryAttempts: 1, delayMS: 1 },
    });

    const builder = client.get('https://example.com/start');
    const res = await builder.send();

    expect(res.status).toBe(0);
    expect(builder.error?.code).toBe('network_error');
    expect(builder.error?.isRetriesExhausted).toBe(true);
  });

  test('does not add inferred text/plain when interceptor sets Content-Type with mixed-case key', async () => {
    let capturedHeaders: Record<string, string> = {};

    const adapter: HTTPAdapter = {
      getType: () => 'mock',
      send: (request: AdapterRequest): Promise<AdapterResponse> => {
        capturedHeaders = request.headers;
        return Promise.resolve({
          status: 200,
          headers: {},
          body: null,
        });
      },
    };

    const client = new HTTPClient({ adapter, followRedirects: true });

    client.addRequestInterceptor(
      (req) => ({
        ...req,
        headers: { ...req.headers, 'Content-Type': 'application/json' },
      }),
      { phases: ['initial'] },
    );

    await client.post('https://example.com/api').body('"hi"').send();

    expect(capturedHeaders['content-type']).toBe('application/json');
  });

  test('adapter that returns status: 0 cleanly gets network_error code', async () => {
    const adapter: HTTPAdapter = {
      getType: () => 'mock',
      send: (_request: AdapterRequest): Promise<AdapterResponse> => {
        // Well-behaved adapter that handles network error gracefully
        return Promise.resolve({
          status: 0,
          headers: {},
          body: null,
        });
      },
    };

    const client = new HTTPClient({ adapter });
    const errorCodes: string[] = [];

    client.addErrorObserver((err) => {
      errorCodes.push(err.code);
    });

    const builder = client.get('https://example.com/test');
    const res = await builder.send();

    expect(res.status).toBe(0);
    expect(res.isNetworkError).toBe(true);
    expect(builder.state).toBe('failed');
    expect(builder.error?.code).toBe('network_error');
    expect(builder.error?.message).toBe('Network error');
    expect(builder.error?.cause).toBeUndefined();
    expect(errorCodes).toEqual(['network_error']);
  });

  test('adapter that returns status: 0 during redirect gets network_error code', async () => {
    let callCount = 0;

    const adapter: HTTPAdapter = {
      getType: () => 'mock',
      send: (_request: AdapterRequest): Promise<AdapterResponse> => {
        callCount++;

        if (callCount === 1) {
          return Promise.resolve({
            status: 301,
            headers: { location: 'https://example.com/redirected' },
            body: null,
          });
        }

        return Promise.resolve({
          status: 0,
          headers: {},
          body: null,
        });
      },
    };

    const client = new HTTPClient({ adapter, followRedirects: true });
    const errorCodes: string[] = [];

    client.addErrorObserver((err) => {
      errorCodes.push(err.code);
    });

    const builder = client.get('https://example.com/test');
    const res = await builder.send();

    expect(res.status).toBe(0);
    expect(res.isNetworkError).toBe(true);
    expect(res.redirected).toBe(true);
    expect(res.requestURL).toBe('https://example.com/redirected');
    expect(res.redirectHistory).toEqual(['https://example.com/redirected']);
    expect(builder.state).toBe('failed');
    expect(builder.error?.code).toBe('network_error');
    expect(builder.error?.message).toBe('Network error');
    expect(builder.error?.cause).toBeUndefined();
    expect(builder.error?.redirected).toBe(true);
    expect(builder.error?.requestURL).toBe('https://example.com/redirected');
    expect(builder.error?.redirectHistory).toEqual([
      'https://example.com/redirected',
    ]);
    expect(errorCodes).toEqual(['network_error']);
  });

  test('interceptor that throws gets interceptor_error code', async () => {
    const adapter: HTTPAdapter = {
      getType: () => 'mock',
      send: (_request: AdapterRequest): Promise<AdapterResponse> => {
        return Promise.resolve({
          status: 200,
          headers: {},
          body: null,
        });
      },
    };

    const client = new HTTPClient({ adapter });
    const errorCodes: string[] = [];

    client.addErrorObserver((err) => {
      errorCodes.push(err.code);
    });

    // Add interceptor that throws
    client.addRequestInterceptor(
      () => {
        throw new Error('Interceptor bug');
      },
      { phases: ['initial'] },
    );

    const builder = client.get('https://example.com/test');
    const res = await builder.send();

    expect(res.status).toBe(0);
    expect(res.isNetworkError).toBe(false);
    expect(builder.state).toBe('failed');
    expect(builder.error?.code).toBe('interceptor_error');
    expect(builder.error?.message).toBe('Interceptor error');
    expect(builder.error?.cause?.message).toBe('Interceptor bug');
    expect(errorCodes).toEqual(['interceptor_error']);
  });

  test('unsupported request body gets request_setup_error code', async () => {
    let wasAdapterCalled = false;

    const adapter: HTTPAdapter = {
      getType: () => 'mock',
      send: (_request: AdapterRequest): Promise<AdapterResponse> => {
        wasAdapterCalled = true;
        return Promise.resolve({
          status: 200,
          headers: {},
          body: null,
        });
      },
    };

    const client = new HTTPClient({
      adapter,
      retryPolicy: { strategy: 'fixed', maxRetryAttempts: 2, delayMS: 1 },
    });
    const errorCodes: string[] = [];

    client.addErrorObserver((err) => {
      errorCodes.push(err.code);
    });

    const builder = client
      .post('https://example.com/test')
      .body(new URLSearchParams({ a: '1' }));
    const res = await builder.send();

    expect(wasAdapterCalled).toBe(false);
    expect(res.status).toBe(0);
    expect(res.isNetworkError).toBe(false);
    expect(builder.state).toBe('failed');
    expect(builder.attemptCount).toBe(0);
    expect(builder.error?.code).toBe('request_setup_error');
    expect(builder.error?.message).toBe('Request setup failed');
    expect(builder.error?.cause?.message).toMatch(
      /Unsupported request body type/i,
    );
    expect(builder.error?.isRetriesExhausted).toBe(false);
    expect(errorCodes).toEqual(['request_setup_error']);
  });

  test('unsupported request body from interceptor gets interceptor_error code', async () => {
    let wasAdapterCalled = false;

    const adapter: HTTPAdapter = {
      getType: () => 'mock',
      send: (_request: AdapterRequest): Promise<AdapterResponse> => {
        wasAdapterCalled = true;
        return Promise.resolve({
          status: 200,
          headers: {},
          body: null,
        });
      },
    };

    const client = new HTTPClient({ adapter });
    const errorCodes: string[] = [];

    client.addRequestInterceptor((request) => ({
      ...request,
      body: new URLSearchParams({ a: '1' }),
    }));
    client.addErrorObserver((err) => {
      errorCodes.push(err.code);
    });

    const builder = client.post('https://example.com/test').json({
      ok: true,
    });
    const res = await builder.send();

    expect(wasAdapterCalled).toBe(false);
    expect(res.status).toBe(0);
    expect(res.isNetworkError).toBe(false);
    expect(builder.state).toBe('failed');
    expect(builder.error?.code).toBe('interceptor_error');
    expect(builder.error?.cause?.message).toMatch(
      /Unsupported request body type/i,
    );
    expect(errorCodes).toEqual(['interceptor_error']);
  });
});
