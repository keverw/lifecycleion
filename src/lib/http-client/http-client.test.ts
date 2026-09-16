import {
  afterEach,
  afterAll,
  beforeAll,
  describe,
  expect,
  spyOn,
  test,
} from 'bun:test';
import { HTTPClient } from './http-client';
import {
  muteConsoleError,
  restoreConsoleError,
} from '../internal/console-test-utils';
import { CookieJar } from './cookie-jar';
import { startTestServer, type TestServer } from './test-helpers/test-server';
import { scalarHeader } from './utils';
import {
  DEFAULT_REQUEST_ATTEMPT_HEADER,
  DEFAULT_REQUEST_ID_HEADER,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_USER_AGENT,
  MAX_TIMER_MS,
  NON_RETRYABLE_HTTP_CLIENT_CALLBACK_ERROR_FLAG,
  REQUEST_BODY_SETTLED_KEY,
  RESPONSE_STREAM_ABORT_FLAG,
  STREAM_FACTORY_CANCEL_KEY,
  STREAM_FACTORY_ERROR_FLAG,
  XHR_BROWSER_TIMEOUT_FLAG,
} from './consts';
import { MockAdapter } from './adapters/mock-adapter';
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
const originalXMLHttpRequest = (globalThis as Record<string, unknown>)
  .XMLHttpRequest;
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

  if (originalXMLHttpRequest === undefined) {
    delete (globalThis as Record<string, unknown>).XMLHttpRequest;
  } else {
    (globalThis as Record<string, unknown>).XMLHttpRequest =
      originalXMLHttpRequest;
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
    ).toThrow(/maxRedirects requires followRedirects: true/i);
  });

  test('rejects maxRedirects without followRedirects: true', () => {
    expect(() =>
      makeClient({
        maxRedirects: 3,
      }),
    ).toThrow(/maxRedirects requires followRedirects: true/i);
  });

  test('server-side fetch rejects baseURL without a protocol', () => {
    expect(() => new HTTPClient({ baseURL: 'example.com' })).toThrow(
      /baseURL must be an absolute http\(s\) URL/i,
    );
  });

  test('server-side fetch rejects baseURL with a non-http protocol', () => {
    expect(() => new HTTPClient({ baseURL: 'ftp://example.com' })).toThrow(
      /baseURL must be an absolute http\(s\) URL/i,
    );
  });

  test('server-side fetch allows absolute https baseURL with a path prefix', () => {
    expect(
      () => new HTTPClient({ baseURL: 'https://example.com/api/v1' }),
    ).not.toThrow();
  });

  test('MockAdapter rejects relative baseURL prefixes', () => {
    expect(
      () => new HTTPClient({ adapter: new MockAdapter(), baseURL: '/api' }),
    ).toThrow(/baseURL must be an absolute http\(s\) URL/i);
  });

  test('browser fetch allows relative baseURL prefixes', () => {
    const originalWindow = (globalThis as Record<string, unknown>).window;
    const originalDocument = (globalThis as Record<string, unknown>).document;

    (globalThis as Record<string, unknown>).window = {};
    (globalThis as Record<string, unknown>).document = {};

    try {
      expect(() => new HTTPClient({ baseURL: '/api' })).not.toThrow();
    } finally {
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
    }
  });

  test('browser fetch resolves relative baseURL requests against document.baseURI', async () => {
    (globalThis as Record<string, unknown>).window = {
      location: { href: 'https://app.test/shell/index.html' },
    };
    (globalThis as Record<string, unknown>).document = {
      baseURI: 'https://cdn.test/base/',
    };

    let capturedURL: string | undefined;
    globalThis.fetch = ((
      url: string | URL | Request,
      _init?: RequestInit,
    ): Promise<Response> => {
      capturedURL =
        typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      return Promise.resolve(new Response('ok'));
    }) as unknown as typeof fetch;

    const client = new HTTPClient({ baseURL: '/api' });
    const response = await client.get('/users').send<string>();

    expect(response.status).toBe(200);
    expect(capturedURL).toBe('https://cdn.test/api/users');
  });

  test('browser fetch resolves protocol-relative paths against the page scheme', async () => {
    (globalThis as Record<string, unknown>).window = {
      location: { href: 'https://app.test/shell/index.html' },
    };
    (globalThis as Record<string, unknown>).document = {
      baseURI: 'https://app.test/base/',
    };

    let capturedURL: string | undefined;
    globalThis.fetch = ((
      url: string | URL | Request,
      _init?: RequestInit,
    ): Promise<Response> => {
      capturedURL =
        typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      return Promise.resolve(new Response('ok'));
    }) as unknown as typeof fetch;

    const client = new HTTPClient();
    const response = await client
      .get('//cdn.test/assets/app.js')
      .send<string>();

    expect(response.status).toBe(200);
    expect(capturedURL).toBe('https://cdn.test/assets/app.js');
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
    expect(response.isFailed).toBe(true);
    expect(response.isNetworkError).toBe(false);
    expect(builder.error).not.toBeNull();
    expect(builder.error?.code).toBe('redirect_disabled');
    expect(builder.error?.requestURL).toBe('https://local.test/redirect');
    expect(builder.error?.wasRedirectDetected).toBe(true);
    expect(builder.error?.wasRedirectFollowed).toBe(false);
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
    expect(res.isFailed).toBe(true);
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
    expect(res.isFailed).toBe(true);
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

  test('carries `requestBodySettled` through without failing the response', async () => {
    // The upload outcome is advisory: it reaches the caller on an otherwise ordinary
    // success, and touches nothing the client decides. Carried on the response as a
    // transport failure instead, a `413` that stopped reading mid-upload would have
    // arrived as a network error with the server's own explanation dropped.
    const settled = Promise.resolve(new Error('upload cut short'));

    const adapter: HTTPAdapter = {
      getType: () => 'node',
      send: (_request: AdapterRequest): Promise<AdapterResponse> =>
        Promise.resolve({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode('{"ok":true}'),
          requestBodySettled: settled,
        }),
    };

    const response = await new HTTPClient({
      adapter,
      baseURL: 'http://example.test',
    })
      .post('/upload')
      .send<{ ok: boolean }>();

    expect(response.status).toBe(200);
    expect(response.isFailed).toBe(false);
    expect(response.isNetworkError).toBe(false);
    expect(response.body).toEqual({ ok: true });
    expect(await response.requestBodySettled).toBeInstanceOf(Error);
  });

  test('adopts a rejecting `requestBodySettled` from an adapter that resolves', async () => {
    // `HTTPAdapter` is a public extension point, and the resolve path handed the adapter's
    // promise straight through with none of the normalization the throw path gets. An
    // adapter answering with a rejecting promise therefore put it on a field documented
    // never to reject: an unhandled rejection for a caller that ignores the field, and a
    // throw for one that awaits it as the docs say to.
    const adapter: HTTPAdapter = {
      getType: () => 'node',
      send: (_request: AdapterRequest): Promise<AdapterResponse> =>
        Promise.resolve({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode('{"ok":true}'),
          requestBodySettled: Promise.reject(new Error('upload blew up')),
        }),
    };

    const response = await new HTTPClient({
      adapter,
      baseURL: 'http://example.test',
    })
      .post('/upload')
      .send<{ ok: boolean }>();

    expect(response.status).toBe(200);

    const settled = await response.requestBodySettled;

    expect(settled).toBeInstanceOf(Error);
    expect((settled as Error).message).toContain('upload blew up');
  });

  test('a cancelled bodied request carries the upload outcome, not a silent success', async () => {
    // The hole this closes: a cancel settles with no adapter response, so the field was
    // omitted - and `await undefined` is `undefined`, which is the documented value for an
    // upload that went out *in full*. A caller following the docs concluded its upload
    // completed for a body that was cut off mid-flight, on the one path where it would
    // think to ask. The adapter tags the throw instead; the client reads it off there.
    const uploadFailure = new Error('upload cut short');
    const controller = new AbortController();

    const adapter: HTTPAdapter = {
      getType: () => 'node',
      send: (_request: AdapterRequest): Promise<AdapterResponse> => {
        // Aborted from inside the adapter: aborting first returns before `send` is ever
        // called, which is not the shape this is about.
        controller.abort();

        const abortErr = new Error('Request aborted');

        abortErr.name = 'AbortError';
        Object.assign(abortErr, {
          [REQUEST_BODY_SETTLED_KEY]: Promise.resolve(uploadFailure),
        });

        return Promise.reject(abortErr);
      },
    };

    const response = await new HTTPClient({
      adapter,
      baseURL: 'http://example.test',
    })
      .post('/upload')
      .json({ a: 1 })
      .signal(controller.signal)
      .send();

    expect(response.isCancelled).toBe(true);
    expect(response.status).toBe(0);

    // Presence first: the documented contract is that a bodied request has the field, and
    // an absent one answers `undefined` through `await` without ever being missing.
    expect(response.requestBodySettled).toBeDefined();
    expect(await response.requestBodySettled).toBe(uploadFailure);
  });

  test('a followed redirect keeps the upload outcome from the hop that had the body', async () => {
    // A followed `302` rewrites a `POST` to a bodiless `GET`, and the outcome was
    // recomputed per hop off the final hop's own response - which has no writer and
    // nothing to report. `await response.requestBodySettled` then answered `undefined`,
    // the documented "the body went out" value, for exactly the early-ack
    // `POST` -> `302` -> `GET` shape the field exists to expose.
    const uploadFailure = new Error('server answered before the body finished');
    const sent: Array<{ method: string; hasBody: boolean }> = [];

    const adapter: HTTPAdapter = {
      getType: () => 'node',
      send: (request: AdapterRequest): Promise<AdapterResponse> => {
        sent.push({
          method: request.method,
          hasBody: request.body !== undefined && request.body !== null,
        });

        if (sent.length === 1) {
          return Promise.resolve({
            status: 302,
            headers: { location: '/done' },
            body: null,
            requestBodySettled: Promise.resolve(uploadFailure),
          });
        }

        return Promise.resolve({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode('{"ok":true}'),
        });
      },
    };

    const response = await new HTTPClient({
      adapter,
      baseURL: 'http://example.test',
      followRedirects: true,
    })
      .post('/upload')
      .json({ a: 1 })
      .send<{ ok: boolean }>();

    expect(sent).toEqual([
      { method: 'POST', hasBody: true },
      { method: 'GET', hasBody: false },
    ]);
    expect(response.status).toBe(200);
    expect(response.wasRedirectFollowed).toBe(true);
    expect(response.requestBodySettled).toBeDefined();
    expect(await response.requestBodySettled).toBe(uploadFailure);
  });

  test('a terminal 3xx with no Location after a bodied hop still carries the upload outcome', async () => {
    // The one terminal redirect branch that built from the hop's own response and passed
    // nothing explicit. After `POST` -> `302` -> `GET` -> `302` with no `Location`, the
    // last hop is bodiless, so the response had nothing to adopt and `await
    // response.requestBodySettled` answered `undefined` for the upload hop one cut short.
    const uploadFailure = new Error('cut short on hop one');
    let hop = 0;

    const adapter: HTTPAdapter = {
      getType: () => 'node',
      send: (_request: AdapterRequest): Promise<AdapterResponse> => {
        hop++;

        if (hop === 1) {
          return Promise.resolve({
            status: 302,
            headers: { location: '/next' },
            body: null,
            requestBodySettled: Promise.resolve(uploadFailure),
          });
        }

        return Promise.resolve({
          status: 302,
          headers: {},
          body: null,
        });
      },
    };

    const response = await new HTTPClient({
      adapter,
      baseURL: 'http://example.test',
      followRedirects: true,
    })
      .post('/upload')
      .json({ a: 1 })
      .send();

    expect(hop).toBe(2);
    expect(response.status).toBe(302);
    expect(response.wasRedirectFollowed).toBe(true);
    expect(response.requestBodySettled).toBeDefined();
    expect(await response.requestBodySettled).toBe(uploadFailure);
  });

  test('a throw between hops still carries the upload outcome', async () => {
    // The `catch` around the whole of `send()` was the one terminal path that built with
    // nothing. A cookie jar that throws while the redirect request is being prepared
    // lands there after a hop that had a body, and the response it built answered
    // `undefined` - the documented success value - for an upload that was cut short.
    const uploadFailure = new Error('cut short');

    const adapter: HTTPAdapter = {
      getType: () => 'node',
      send: (_request: AdapterRequest): Promise<AdapterResponse> =>
        Promise.resolve({
          status: 302,
          headers: { location: '/next' },
          body: null,
          requestBodySettled: Promise.resolve(uploadFailure),
        }),
    };

    const jar = new CookieJar();

    jar.getCookieHeaderString = (url: string): string => {
      if (url.includes('/next')) {
        throw new Error('jar refused');
      }

      return '';
    };

    const response = await new HTTPClient({
      adapter,
      baseURL: 'http://example.test',
      followRedirects: true,
      cookieJar: jar,
    })
      .post('/upload')
      .json({ a: 1 })
      .send();

    expect(response.isFailed).toBe(true);
    expect(response.status).toBe(0);
    expect(await response.requestBodySettled).toBe(uploadFailure);
  });

  test("a followed redirect waits for the hop's upload to settle first", async () => {
    // `NodeAdapter.send()` resolves when the response is consumed, so an early `3xx`
    // arrives with the writer still running - and the next hop went out beside it. A
    // `307` then uploaded the same body twice at once. The hop's upload settles first.
    let settledAt = 0;
    let secondHopStartedAt = 0;
    let hop = 0;

    const adapter: HTTPAdapter = {
      getType: () => 'node',
      send: (_request: AdapterRequest): Promise<AdapterResponse> => {
        hop++;

        if (hop === 1) {
          return Promise.resolve({
            status: 307,
            headers: { location: '/again' },
            body: null,
            requestBodySettled: new Promise((resolve) => {
              setTimeout(() => {
                settledAt = Date.now();
                resolve(undefined);
              }, 60);
            }),
          });
        }

        secondHopStartedAt = Date.now();

        return Promise.resolve({ status: 200, headers: {}, body: null });
      },
    };

    const response = await new HTTPClient({
      adapter,
      baseURL: 'http://example.test',
      followRedirects: true,
    })
      .post('/upload')
      .json({ a: 1 })
      .send();

    expect(response.status).toBe(200);
    expect(hop).toBe(2);
    expect(settledAt).toBeGreaterThan(0);
    expect(secondHopStartedAt).toBeGreaterThanOrEqual(settledAt);
  });

  test('a cancel during that wait is not held for the upload', async () => {
    const controller = new AbortController();
    let hop = 0;

    const adapter: HTTPAdapter = {
      getType: () => 'node',
      send: (_request: AdapterRequest): Promise<AdapterResponse> => {
        hop++;

        return Promise.resolve({
          status: 307,
          headers: { location: '/again' },
          body: null,
          // Never settles on its own: the wait must end with the cancel.
          requestBodySettled: new Promise(() => {}),
        });
      },
    };

    const pending = new HTTPClient({
      adapter,
      baseURL: 'http://example.test',
      followRedirects: true,
    })
      .post('/upload')
      .json({ a: 1 })
      .signal(controller.signal)
      .send();

    setTimeout(() => controller.abort('gave up waiting'), 30);

    const startedAt = Date.now();
    const response = await pending;

    expect(Date.now() - startedAt).toBeLessThan(2000);
    expect(response.isCancelled).toBe(true);
    expect(hop).toBe(1);
    // Carried off the hop the cancel interrupted: the upload was still going out, and
    // `undefined` here would read as "the body went out in full".
    expect(response.requestBodySettled).toBeDefined();
  });

  test("a cancel during that wait keeps the caller's abort reason", async () => {
    // Every other abort path reads the signal's reason onto the error; this one built
    // the cancelled response and broke to the failure block with the reason unset.
    const controller = new AbortController();

    const adapter: HTTPAdapter = {
      getType: () => 'node',
      send: (_request: AdapterRequest): Promise<AdapterResponse> =>
        Promise.resolve({
          status: 307,
          headers: { location: '/again' },
          body: null,
          requestBodySettled: new Promise(() => {}),
        }),
    };

    const builder = new HTTPClient({
      adapter,
      baseURL: 'http://example.test',
      followRedirects: true,
    })
      .post('/upload')
      .json({ a: 1 })
      .signal(controller.signal);

    const pending = builder.send();

    setTimeout(() => controller.abort('gave up waiting'), 30);

    const response = await pending;

    expect(response.isCancelled).toBe(true);
    expect(builder.error?.cancelReason).toBe('gave up waiting');
  });

  test('an adapter whose requestBodySettled never settles fails the redirect as a timeout at the request timeout', async () => {
    // `NodeAdapter` bounds its own promise through the upload stall watchdog. A custom
    // adapter is a public extension point, and one that set the field and never settled
    // it held a followed `307`/`308` until the caller aborted - no timeout, no error,
    // nothing on any channel. Bounded now by the caller's own `timeout`, and what
    // happens at the bound is a failed request, not a second hop: dispatching the body
    // again beside an upload nobody can say has finished is the double-send the wait
    // exists to prevent.
    let hop = 0;

    const signals: AbortSignal[] = [];

    const adapter: HTTPAdapter = {
      getType: () => 'fetch',
      send: (request: AdapterRequest): Promise<AdapterResponse> => {
        hop++;

        if (request.signal) {
          signals.push(request.signal);
        }

        return Promise.resolve({
          status: 307,
          headers: { location: '/again' },
          body: null,
          requestBodySettled: new Promise(() => {}),
        });
      },
    };

    const reports: ErrorEvent[] = [];
    const onGlobalError = (event: Event): void => {
      reports.push(event as ErrorEvent);
      event.preventDefault();
    };

    globalThis.addEventListener('error', onGlobalError);

    try {
      const startedAt = Date.now();
      const response = await new HTTPClient({
        adapter,
        baseURL: 'http://example.test',
        followRedirects: true,
        timeout: 100,
      })
        .post('/upload')
        .json({ a: 1 })
        .send();

      expect(Date.now() - startedAt).toBeLessThan(2000);
      expect(hop).toBe(1);
      expect(response.isTimeout).toBe(true);
      expect(response.isCancelled).toBe(false);
      // Still carried, so the caller can await the adapter's word if it ever comes.
      expect(response.requestBodySettled).toBeDefined();
      // And the hop given up on is torn down, as a per-attempt timeout tears one down:
      // the request has been reported as timed out, so its upload must not go on
      // putting bytes on the wire. `NodeAdapter` answers this signal by destroying the
      // request; a custom adapter is expected to.
      expect(signals).toHaveLength(1);
      expect(signals[0]?.aborted).toBe(true);

      // The timeout error cannot say why; this does, and names the adapter.
      expect(reports).toHaveLength(1);
      expect((reports[0]?.error as Error).message).toContain(
        "'fetch' adapter's requestBodySettled must settle in bounded time",
      );
      expect((reports[0]?.error as Error).message).toContain('redirect');
    } finally {
      globalThis.removeEventListener('error', onGlobalError);
    }
  });

  test('an adapter whose requestBodySettled never settles fails the retry as a timeout at the request timeout', async () => {
    // The retry path waits the same way, after the backoff, and is bounded the same
    // way: a `503` answered mid-upload must not have its next attempt dispatched beside
    // the first attempt's body.
    let attempts = 0;
    const signals: AbortSignal[] = [];

    const adapter: HTTPAdapter = {
      getType: () => 'fetch',
      send: (request: AdapterRequest): Promise<AdapterResponse> => {
        attempts++;

        if (request.signal) {
          signals.push(request.signal);
        }

        return Promise.resolve({
          status: 503,
          headers: {},
          body: null,
          requestBodySettled: new Promise(() => {}),
        });
      },
    };

    const reports: ErrorEvent[] = [];
    const onGlobalError = (event: Event): void => {
      reports.push(event as ErrorEvent);
      event.preventDefault();
    };

    globalThis.addEventListener('error', onGlobalError);

    try {
      const response = await new HTTPClient({
        adapter,
        baseURL: 'http://example.test',
        timeout: 100,
        retryPolicy: { strategy: 'fixed', maxRetryAttempts: 2, delayMS: 0 },
      })
        .put('/upload')
        .json({ a: 1 })
        .send();

      expect(attempts).toBe(1);
      expect(response.isTimeout).toBe(true);
      expect(response.requestBodySettled).toBeDefined();
      expect(reports).toHaveLength(1);
      expect((reports[0]?.error as Error).message).toContain('retry');
      // The attempt given up on is torn down with the request; see the redirect test.
      expect(signals[0]?.aborted).toBe(true);
    } finally {
      globalThis.removeEventListener('error', onGlobalError);
    }
  });

  test('silence before the wait began counts toward the stall bound', async () => {
    // The first arm always slept for the whole bound, so an upload that had gone quiet
    // long before the early response arrived was given a further full bound from the
    // moment the wait began. The clock is read on entry now: a hop that answers 200ms
    // after dispatch and never reports progress has 200ms of silence already, and the
    // wait under a 300ms bound expires about 100ms later, not 300ms. The margins are
    // wide because a loaded runner adds latency; the old behaviour lands near 500ms.
    let hop = 0;

    const adapter: HTTPAdapter = {
      getType: () => 'fetch',
      send: async (_request: AdapterRequest): Promise<AdapterResponse> => {
        hop++;
        await new Promise((resolve) => setTimeout(resolve, 200));

        return {
          status: 307,
          headers: { location: '/again' },
          body: null,
          requestBodySettled: new Promise(() => {}),
        };
      },
    };

    const onGlobalError = (event: Event): void => {
      event.preventDefault();
    };

    globalThis.addEventListener('error', onGlobalError);

    try {
      const startedAt = Date.now();
      const response = await new HTTPClient({
        adapter,
        baseURL: 'http://example.test',
        followRedirects: true,
        timeout: 300,
      })
        .post('/upload')
        .json({ a: 1 })
        .send();

      const elapsed = Date.now() - startedAt;

      expect(hop).toBe(1);
      expect(response.isTimeout).toBe(true);
      // One bound from dispatch, not one bound from the response: ~300ms, not ~500ms.
      expect(elapsed).toBeGreaterThanOrEqual(280);
      expect(elapsed).toBeLessThan(450);
    } finally {
      globalThis.removeEventListener('error', onGlobalError);
    }
  });

  test('an upload still reporting progress past the request timeout is not cut', async () => {
    // A stall bound, not a deadline. The adapter here keeps reporting progress every
    // 30ms for 250ms after answering the `307`, against a `timeout` of 100ms, and only
    // then settles: the wait must follow it to the end and dispatch the second hop, not
    // fail at 100ms with the body still moving.
    let hop = 0;
    let settleFirst!: () => void;

    const adapter: HTTPAdapter = {
      getType: () => 'fetch',
      send: (request: AdapterRequest): Promise<AdapterResponse> => {
        hop++;

        if (hop === 2) {
          return Promise.resolve({ status: 200, headers: {}, body: null });
        }

        const settled = new Promise<Error | undefined>((resolve) => {
          settleFirst = () => resolve(undefined);
        });

        let ticks = 0;
        const ticker = setInterval(() => {
          ticks++;
          request.onUploadProgress?.({
            loaded: ticks,
            total: 10,
            progress: ticks / 10,
          });

          if (ticks >= 8) {
            clearInterval(ticker);
            settleFirst();
          }
        }, 30);

        return Promise.resolve({
          status: 307,
          headers: { location: '/again' },
          body: null,
          requestBodySettled: settled,
        });
      },
    };

    const response = await new HTTPClient({
      adapter,
      baseURL: 'http://example.test',
      followRedirects: true,
      timeout: 100,
    })
      .post('/upload')
      .json({ a: 1 })
      .send();

    expect(hop).toBe(2);
    expect(response.status).toBe(200);
    expect(response.isTimeout).toBe(false);
  });

  test('a timeout of 0 leaves the wait unbounded, as it leaves the per-attempt timer', async () => {
    const controller = new AbortController();
    let hop = 0;

    const adapter: HTTPAdapter = {
      getType: () => 'fetch',
      send: (_request: AdapterRequest): Promise<AdapterResponse> => {
        hop++;

        return Promise.resolve({
          status: 307,
          headers: { location: '/again' },
          body: null,
          requestBodySettled: new Promise(() => {}),
        });
      },
    };

    const pending = new HTTPClient({
      adapter,
      baseURL: 'http://example.test',
      followRedirects: true,
      timeout: 0,
    })
      .post('/upload')
      .json({ a: 1 })
      .signal(controller.signal)
      .send();

    const stillWaiting = Symbol('still waiting');
    const outcome = await Promise.race([
      pending,
      new Promise<typeof stillWaiting>((resolve) => {
        setTimeout(() => resolve(stillWaiting), 150);
      }),
    ]);

    expect(outcome).toBe(stillWaiting);
    expect(hop).toBe(1);

    controller.abort('gave up');

    const response = await pending;

    expect(response.isCancelled).toBe(true);
    expect(response.isTimeout).toBe(false);
  });

  test('a 307 that resends the body reports the resent upload, not the first', async () => {
    // The latest hop that had a body is the answer: a `307` puts the body on the wire
    // again, and its outcome is the one behind the final response.
    const firstFailure = new Error('first hop cut short');
    let hop = 0;

    const adapter: HTTPAdapter = {
      getType: () => 'node',
      send: (_request: AdapterRequest): Promise<AdapterResponse> => {
        hop++;

        if (hop === 1) {
          return Promise.resolve({
            status: 307,
            headers: { location: '/again' },
            body: null,
            requestBodySettled: Promise.resolve(firstFailure),
          });
        }

        return Promise.resolve({
          status: 200,
          headers: {},
          body: null,
          requestBodySettled: Promise.resolve(undefined),
        });
      },
    };

    const response = await new HTTPClient({
      adapter,
      baseURL: 'http://example.test',
      followRedirects: true,
    })
      .post('/upload')
      .json({ a: 1 })
      .send();

    expect(hop).toBe(2);
    expect(response.requestBodySettled).toBeDefined();
    expect(await response.requestBodySettled).toBeUndefined();
  });

  test('a redirect loop after a bodied hop still carries the upload outcome', async () => {
    const uploadFailure = new Error('cut short');

    const adapter: HTTPAdapter = {
      getType: () => 'node',
      send: (_request: AdapterRequest): Promise<AdapterResponse> =>
        Promise.resolve({
          status: 307,
          headers: { location: '/loop' },
          body: null,
          requestBodySettled: Promise.resolve(uploadFailure),
        }),
    };

    const response = await new HTTPClient({
      adapter,
      baseURL: 'http://example.test',
      followRedirects: true,
      maxRedirects: 2,
    })
      .post('/upload')
      .json({ a: 1 })
      .send();

    expect(response.isFailed).toBe(true);
    expect(await response.requestBodySettled).toBe(uploadFailure);
  });

  test('a timed-out bodied request carries the upload outcome', async () => {
    const uploadFailure = new Error('upload never finished');

    const adapter: HTTPAdapter = {
      getType: () => 'node',
      send: (request: AdapterRequest): Promise<AdapterResponse> =>
        new Promise((_resolve, reject) => {
          request.signal?.addEventListener('abort', () => {
            const abortErr = new Error('Request aborted');

            abortErr.name = 'AbortError';
            Object.assign(abortErr, {
              [REQUEST_BODY_SETTLED_KEY]: Promise.resolve(uploadFailure),
            });

            reject(abortErr);
          });
        }),
    };

    const response = await new HTTPClient({
      adapter,
      baseURL: 'http://example.test',
      timeout: 20,
    })
      .post('/upload')
      .json({ a: 1 })
      .send();

    expect(response.isTimeout).toBe(true);
    expect(response.requestBodySettled).toBeDefined();
    expect(await response.requestBodySettled).toBe(uploadFailure);
  });

  test('a requestBodySettled whose thenable check throws does not fail the response', async () => {
    // Deciding whether the field is a thenable reads `.then` on a value the adapter made.
    // A `Proxy` that throws on that read threw out of `_buildResponse`, after the request
    // had already succeeded - a `200` turned into a synthetic failed status-0 response
    // over a field documented as advisory. Unusable is treated as absent.
    const hostile = new Proxy(
      {},
      {
        get: () => {
          throw new Error('no then for you');
        },
      },
    );

    const adapter: HTTPAdapter = {
      getType: () => 'node',
      send: (_request: AdapterRequest): Promise<AdapterResponse> =>
        Promise.resolve({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode('{"ok":true}'),
          requestBodySettled: hostile as unknown as Promise<Error | undefined>,
        }),
    };

    const response = await new HTTPClient({
      adapter,
      baseURL: 'http://example.test',
    })
      .post('/upload')
      .json({ a: 1 })
      .send<{ ok: boolean }>();

    expect(response.status).toBe(200);
    expect(response.isFailed).toBe(false);
    expect(response.body).toEqual({ ok: true });
    expect(response.requestBodySettled).toBeUndefined();
  });

  test('a tagged value whose thenable check throws is ignored on the throw path too', async () => {
    // The same read on the tag an adapter puts on the error it throws.
    const hostile = new Proxy(
      {},
      {
        get: () => {
          throw new Error('no then for you');
        },
      },
    );
    const controller = new AbortController();

    const adapter: HTTPAdapter = {
      getType: () => 'node',
      send: (_request: AdapterRequest): Promise<AdapterResponse> => {
        controller.abort();

        const abortErr = new Error('Request aborted');

        abortErr.name = 'AbortError';
        Object.assign(abortErr, { [REQUEST_BODY_SETTLED_KEY]: hostile });

        return Promise.reject(abortErr);
      },
    };

    const response = await new HTTPClient({
      adapter,
      baseURL: 'http://example.test',
    })
      .post('/upload')
      .json({ a: 1 })
      .signal(controller.signal)
      .send();

    expect(response.isCancelled).toBe(true);
    expect(response.requestBodySettled).toBeUndefined();
  });

  test('a tagged value that is not a promise is ignored rather than awaited', async () => {
    // The tag is an ordinary property on an object this client did not create. `await` on
    // a non-thenable resolves to the value itself, so trusting it would report the tag as
    // the upload's own outcome - a string, or anything else a caller's `Error` subclass
    // happens to carry under that name.
    const controller = new AbortController();

    const adapter: HTTPAdapter = {
      getType: () => 'node',
      send: (_request: AdapterRequest): Promise<AdapterResponse> => {
        controller.abort();

        const abortErr = new Error('Request aborted');

        abortErr.name = 'AbortError';
        Object.assign(abortErr, {
          [REQUEST_BODY_SETTLED_KEY]: 'not a promise',
        });

        return Promise.reject(abortErr);
      },
    };

    const response = await new HTTPClient({
      adapter,
      baseURL: 'http://example.test',
    })
      .post('/upload')
      .json({ a: 1 })
      .signal(controller.signal)
      .send();

    expect(response.isCancelled).toBe(true);
    expect(response.requestBodySettled).toBeUndefined();
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
      /redirect handling is not supported with XHR adapter/i,
    );
  });

  test('allows browser XHR adapter when followRedirects is false', () => {
    (globalThis as Record<string, unknown>).window = {};
    (globalThis as Record<string, unknown>).document = {};
    (globalThis as Record<string, unknown>).XMLHttpRequest = class {};

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

  test('rejects browser XHR maxRedirects without followRedirects: true', () => {
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
    ).toThrow(/maxRedirects requires followRedirects: true/i);
  });

  test('rejects cookieJar with browser XHR adapter at construction time', () => {
    (globalThis as Record<string, unknown>).window = {};
    (globalThis as Record<string, unknown>).document = {};
    (globalThis as Record<string, unknown>).XMLHttpRequest = class {};

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
    (globalThis as Record<string, unknown>).XMLHttpRequest = class {};

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
    (globalThis as Record<string, unknown>).XMLHttpRequest = class {};

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

  test('does not include x-local-client-request-id by default', async () => {
    const client = makeClient();
    const res = await client
      .get('/api/test')
      .send<{ headers: Record<string, string> }>();
    expect(res.body.headers['x-local-client-request-id']).toBeUndefined();
    expect(res.requestID).toBeDefined();
  });

  test('includes x-local-client-request-id when includeRequestID is enabled', async () => {
    const client = makeClient({ includeRequestID: true });
    const res = await client
      .get('/api/test')
      .send<{ headers: Record<string, string> }>();
    expect(res.body.headers['x-local-client-request-id']).toBeDefined();
  });

  test('applies explicit userAgent to mock adapters', async () => {
    let capturedHeaders: Record<string, string | string[]> = {};

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
    let capturedHeaders: Record<string, string | string[]> = {};

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
    expect(res.isFailed).toBe(true);
  });

  test('AbortSignal aborted with string reason surfaces cancelReason on the error', async () => {
    const client = makeClient();
    const controller = new AbortController();
    controller.abort('user_navigated_away');

    const builder = client.get('/api/slow').signal(controller.signal);
    const res = await builder.send();

    expect(res.isCancelled).toBe(true);
    expect(builder.error?.cancelReason).toBe('user_navigated_away');
  });

  test('AbortSignal aborted without a reason produces no cancelReason', async () => {
    const client = makeClient();
    const controller = new AbortController();
    controller.abort();

    const builder = client.get('/api/slow').signal(controller.signal);
    await builder.send();

    expect(builder.error?.cancelReason).toBeUndefined();
  });

  test('a throwing AbortSignal reason getter cannot replace cancellation', async () => {
    const client = makeClient();
    const controller = new AbortController();

    Object.defineProperty(controller.signal, 'reason', {
      configurable: true,
      get: () => {
        throw new Error('reason getter');
      },
    });
    controller.abort('hidden');

    const builder = client.get('/api/slow').signal(controller.signal);
    const response = await builder.send();

    expect(response.isCancelled).toBe(true);
    expect(builder.error?.code).toBe('cancelled');
    expect(builder.error?.cancelReason).toBeUndefined();
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
    expect(res.isFailed).toBe(true);
    expect(res.initialURL).toBe('https://example.com/slow');
    expect(res.requestURL).toBe('https://example.com/slow');
    expect(res.wasRedirectDetected).toBe(false);
    expect(res.wasRedirectFollowed).toBe(false);
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
    expect(res.isFailed).toBe(true);
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
    expect(res.isFailed).toBe(true);
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
      expect(res.isFailed).toBe(true);
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
    expect(res1.isFailed).toBe(true);
    // unlabeled may or may not finish — just check it didn't get cancelled by the label stop
    expect(res2.isCancelled).toBe(false);
  });

  test('builder.cancel(reason) surfaces cancelReason on the error', async () => {
    const client = makeClient();
    const builder = client.get('/api/slow');
    const promise = builder.send();
    setTimeout(() => builder.cancel('user_navigated_away'), 10);
    const res = await promise;

    expect(res.isCancelled).toBe(true);
    expect(builder.error?.cancelReason).toBe('user_navigated_away');
  });

  test('builder.cancel() without reason produces no cancelReason', async () => {
    const client = makeClient();
    const builder = client.get('/api/slow');
    const promise = builder.send();
    setTimeout(() => builder.cancel(), 10);
    await promise;

    expect(builder.error?.cancelReason).toBeUndefined();
  });

  test('client.cancel(requestID, reason) surfaces cancelReason on the error', async () => {
    const client = makeClient();
    const builder = client.get('/api/slow');
    const promise = builder.send();
    client.cancel(builder.requestID, 'shutdown');
    const res = await promise;

    expect(res.isCancelled).toBe(true);
    expect(builder.error?.cancelReason).toBe('shutdown');
  });

  test('client.cancelAll(reason) surfaces cancelReason on all cancelled requests', async () => {
    const client = makeClient();
    const b1 = client.get('/api/slow');
    const b2 = client.get('/api/slow');
    const [p1, p2] = [b1.send(), b2.send()];
    setTimeout(() => client.cancelAll('app_shutdown'), 10);
    await Promise.all([p1, p2]);

    expect(b1.error?.cancelReason).toBe('app_shutdown');
    expect(b2.error?.cancelReason).toBe('app_shutdown');
  });

  test('client.cancelAllWithLabel(label, reason) surfaces cancelReason on matching requests', async () => {
    const client = makeClient();
    const labeled = client.get('/api/slow').label('upload');
    const unlabeled = client.get('/api/slow');
    const [p1, p2] = [labeled.send(), unlabeled.send()];
    setTimeout(() => client.cancelAllWithLabel('upload', 'quota_exceeded'), 10);
    const [res1] = await Promise.all([p1, p2]);

    expect(res1.isCancelled).toBe(true);
    expect(labeled.error?.cancelReason).toBe('quota_exceeded');
  });

  test('client.cancelOwn(reason) surfaces cancelReason on the client own requests', async () => {
    const client = makeClient();
    const builder = client.get('/api/slow');
    const promise = builder.send();
    setTimeout(() => client.cancelOwn('component_unmounted'), 10);
    const res = await promise;

    expect(res.isCancelled).toBe(true);
    expect(builder.error?.cancelReason).toBe('component_unmounted');
  });

  test('client.cancelOwnWithLabel(label, reason) surfaces cancelReason on matching requests', async () => {
    const client = makeClient();
    const labeled = client.get('/api/slow').label('poll');
    const unlabeled = client.get('/api/slow');
    const [p1, p2] = [labeled.send(), unlabeled.send()];
    setTimeout(() => client.cancelOwnWithLabel('poll', 'tab_hidden'), 10);
    const [res1] = await Promise.all([p1, p2]);

    expect(res1.isCancelled).toBe(true);
    expect(labeled.error?.cancelReason).toBe('tab_hidden');
  });
});

describe('HTTPClient — cancel reason via AbortError-throwing adapters', () => {
  // These tests use a mock adapter that delays and throws a real AbortError
  // (the same pattern as XHRAdapter and NodeAdapter) to confirm that cancel
  // reasons are surfaced via cancelSignal.reason even when the adapter does
  // NOT propagate signal.reason through the thrown error.
  function makeAbortErrorAdapter() {
    const adapter: HTTPAdapter = {
      getType: () => 'mock' as const,
      send: (_request: AdapterRequest): Promise<AdapterResponse> => {
        if (_request.signal?.aborted) {
          const err = new Error('Request aborted');
          err.name = 'AbortError';
          return Promise.reject(err);
        }

        return new Promise<AdapterResponse>((_resolve, reject) => {
          _request.signal?.addEventListener('abort', () => {
            // Always throw a plain AbortError — does NOT include signal.reason,
            // matching what XHRAdapter and NodeAdapter do.
            const err = new Error('Request aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      },
    };

    return { adapter };
  }

  test('string cancel reason surfaces via cancelSignal.reason even when adapter throws plain AbortError', async () => {
    const { adapter } = makeAbortErrorAdapter();
    const client = new HTTPClient({ adapter });
    const builder = client.get('https://example.com/slow');
    const promise = builder.send();
    setTimeout(() => builder.cancel('user_navigated_away'), 10);
    const res = await promise;

    expect(res.isCancelled).toBe(true);
    expect(builder.error?.cancelReason).toBe('user_navigated_away');
  });

  test('cancelAll with reason surfaces via cancelSignal.reason for AbortError-throwing adapter', async () => {
    const { adapter } = makeAbortErrorAdapter();
    const client = new HTTPClient({ adapter });
    const b1 = client.get('https://example.com/slow');
    const b2 = client.get('https://example.com/slow');
    const [p1, p2] = [b1.send(), b2.send()];
    setTimeout(() => client.cancelAll('app_shutdown'), 10);
    await Promise.all([p1, p2]);

    expect(b1.error?.cancelReason).toBe('app_shutdown');
    expect(b2.error?.cancelReason).toBe('app_shutdown');
  });

  test('external AbortSignal reason is preserved when AbortSignal.any is unavailable', async () => {
    const { adapter } = makeAbortErrorAdapter();
    const client = new HTTPClient({ adapter });
    const controller = new AbortController();
    const originalAnyDescriptor = Object.getOwnPropertyDescriptor(
      AbortSignal,
      'any',
    );

    Object.defineProperty(AbortSignal, 'any', {
      value: undefined,
      configurable: true,
    });

    try {
      const builder = client
        .get('https://example.com/slow')
        .signal(controller.signal);
      const promise = builder.send();
      setTimeout(() => controller.abort('user_navigated_away'), 10);
      const res = await promise;

      expect(res.isCancelled).toBe(true);
      expect(builder.error?.cancelReason).toBe('user_navigated_away');
    } finally {
      if (originalAnyDescriptor) {
        Object.defineProperty(AbortSignal, 'any', originalAnyDescriptor);
      }
    }
  });

  test('an unreadable abort reason yields the platform default', async () => {
    // A reason whose getter throws is read as `undefined` and forwarded as
    // such. That is the correct end state, not a degradation: `abort(undefined)`
    // does not pin the reason to `undefined` — the spec normalizes it to a
    // freshly minted AbortError, the same value a bare `abort()` produces. This
    // pins that down, so nobody "fixes" the guarded read into forwarding a
    // sentinel or a reason the source signal never had.
    let observedReason: unknown = 'not captured';

    const adapter: HTTPAdapter = {
      getType: () => 'mock',
      send: async (request: AdapterRequest): Promise<AdapterResponse> => {
        await new Promise<void>((resolve) => {
          request.signal?.addEventListener('abort', () => {
            observedReason = request.signal?.reason;
            resolve();
          });
        });

        const error = new Error('Aborted');
        error.name = 'AbortError';
        throw error;
      },
    };

    const client = new HTTPClient({ adapter });
    const controller = new AbortController();
    const originalAnyDescriptor = Object.getOwnPropertyDescriptor(
      AbortSignal,
      'any',
    );

    // Force the manual composition path — AbortSignal.any does its own
    // propagation and never consults this code.
    Object.defineProperty(AbortSignal, 'any', {
      value: undefined,
      configurable: true,
    });

    try {
      const builder = client
        .get('https://example.com/slow')
        .signal(controller.signal);
      const promise = builder.send();

      setTimeout(() => {
        // A reason nobody can read: the getter throws on every access.
        Object.defineProperty(controller.signal, 'reason', {
          get: () => {
            throw new Error('reason is not readable');
          },
          configurable: true,
        });
        controller.abort();
      }, 10);

      const res = await promise;

      expect(res.isCancelled).toBe(true);
      // The composed signal carries a real AbortError, never a bare `undefined`
      // and never a stand-in of the client's own invention.
      expect(observedReason).toBeInstanceOf(Error);
      expect((observedReason as Error).name).toBe('AbortError');
      expect(builder.error?.cancelReason).toBeUndefined();
    } finally {
      if (originalAnyDescriptor) {
        Object.defineProperty(AbortSignal, 'any', originalAnyDescriptor);
      }
    }
  });

  test('a caller signal reused across sends is left with no abort listener when AbortSignal.any is unavailable', async () => {
    // The fallback composition used to add a `{ once: true }` listener to the caller's
    // signal per `send()`, and never remove it on success - so a signal reused for the
    // life of a page or a worker accumulated one listener per request until the
    // runtime's listener-count warning fired. Every request now releases the listeners
    // it added when it ends, so the count is measured net of removals.
    const adapter: HTTPAdapter = {
      getType: () => 'mock',
      send: async (request: AdapterRequest): Promise<AdapterResponse> => {
        if (request.requestURL.endsWith('/slow')) {
          await new Promise<void>((resolve) => {
            request.signal?.addEventListener('abort', () => resolve(), {
              once: true,
            });
          });

          const error = new Error('Aborted');
          error.name = 'AbortError';
          throw error;
        }

        return { status: 200, headers: {}, body: null };
      },
    };
    const client = new HTTPClient({ adapter });
    const controller = new AbortController();
    const originalAnyDescriptor = Object.getOwnPropertyDescriptor(
      AbortSignal,
      'any',
    );
    const addEventListenerSpy = spyOn(controller.signal, 'addEventListener');
    const removeEventListenerSpy = spyOn(
      controller.signal,
      'removeEventListener',
    );
    const countAbortCalls = (calls: unknown[][]): number =>
      calls.filter((call) => call[0] === 'abort').length;
    const abortListenersAdded = (): number =>
      countAbortCalls(addEventListenerSpy.mock.calls);
    const abortListenersOutstanding = (): number =>
      abortListenersAdded() -
      countAbortCalls(removeEventListenerSpy.mock.calls);

    Object.defineProperty(AbortSignal, 'any', {
      value: undefined,
      configurable: true,
    });

    try {
      for (let i = 0; i < 25; i += 1) {
        const res = await client
          .get(`https://example.com/ok/${i}`)
          .signal(controller.signal)
          .send();

        expect(res.status).toBe(200);
      }

      // One per request while it ran, none left behind after.
      expect(abortListenersAdded()).toBe(25);
      expect(abortListenersOutstanding()).toBe(0);

      // And the next request still hears the abort, with the caller's reason intact.
      const builder = client
        .get('https://example.com/slow')
        .signal(controller.signal);
      const promise = builder.send();
      setTimeout(() => controller.abort('user_navigated_away'), 10);
      const res = await promise;

      expect(res.isCancelled).toBe(true);
      expect(builder.error?.cancelReason).toBe('user_navigated_away');
      expect(abortListenersOutstanding()).toBe(0);
    } finally {
      addEventListenerSpy.mockRestore();
      removeEventListenerSpy.mockRestore();

      if (originalAnyDescriptor) {
        Object.defineProperty(AbortSignal, 'any', originalAnyDescriptor);
      }
    }
  });

  test('a retry chain leaves no abort listener on any signal when AbortSignal.any is unavailable', async () => {
    // The same release covers the per-attempt composition: every attempt composes the
    // request's cancel signal - itself a composition, so the caller's signal never sees
    // these - with its own timeout signal, and used to leave one listener per attempt
    // on that cancel signal for as long as the signal lived. Counted per signal across
    // the whole send, at the prototype, since the cancel signal is internal, and net of
    // removals: the old code left fifteen on it, and the request now takes every one
    // of them off when it ends. Within a request the count still grows by one per
    // attempt, which is the bounded case this accepts.
    let attempts = 0;
    const adapter: HTTPAdapter = {
      getType: () => 'mock',
      send: (): Promise<AdapterResponse> => {
        attempts += 1;

        return Promise.resolve({
          status: attempts < 15 ? 503 : 200,
          headers: {},
          body: null,
        });
      },
    };
    const client = new HTTPClient({ adapter });
    const controller = new AbortController();
    const originalAnyDescriptor = Object.getOwnPropertyDescriptor(
      AbortSignal,
      'any',
    );
    const addDescriptor = Object.getOwnPropertyDescriptor(
      EventTarget.prototype,
      'addEventListener',
    );
    const removeDescriptor = Object.getOwnPropertyDescriptor(
      EventTarget.prototype,
      'removeEventListener',
    );

    if (addDescriptor === undefined || removeDescriptor === undefined) {
      throw new Error('EventTarget.prototype listener methods are missing');
    }

    const abortListenersPerSignal = new Map<AbortSignal, number>();
    const originalAdd = addDescriptor.value as (
      this: EventTarget,
      ...args: Parameters<EventTarget['addEventListener']>
    ) => void;
    const originalRemove = removeDescriptor.value as (
      this: EventTarget,
      ...args: Parameters<EventTarget['removeEventListener']>
    ) => void;
    const count = (signal: EventTarget, delta: number): void => {
      if (signal instanceof AbortSignal) {
        abortListenersPerSignal.set(
          signal,
          (abortListenersPerSignal.get(signal) ?? 0) + delta,
        );
      }
    };

    Object.defineProperty(EventTarget.prototype, 'addEventListener', {
      ...addDescriptor,
      value: function countingAddEventListener(
        this: EventTarget,
        ...args: Parameters<EventTarget['addEventListener']>
      ): void {
        if (args[0] === 'abort') {
          count(this, 1);
        }

        Reflect.apply(originalAdd, this, args);
      },
    });
    Object.defineProperty(EventTarget.prototype, 'removeEventListener', {
      ...removeDescriptor,
      value: function countingRemoveEventListener(
        this: EventTarget,
        ...args: Parameters<EventTarget['removeEventListener']>
      ): void {
        if (args[0] === 'abort') {
          count(this, -1);
        }

        Reflect.apply(originalRemove, this, args);
      },
    });

    Object.defineProperty(AbortSignal, 'any', {
      value: undefined,
      configurable: true,
    });

    try {
      const res = await client
        .get('https://example.com/flaky')
        .signal(controller.signal)
        .retryPolicy({ strategy: 'fixed', maxRetryAttempts: 20, delayMS: 0 })
        .send();

      expect(res.status).toBe(200);
      expect(attempts).toBe(15);
      // Some signal was composed into every attempt, so the release was exercised.
      expect(abortListenersPerSignal.size).toBeGreaterThanOrEqual(15);
      expect(Math.max(...abortListenersPerSignal.values())).toBe(0);
    } finally {
      Object.defineProperty(
        EventTarget.prototype,
        'addEventListener',
        addDescriptor,
      );
      Object.defineProperty(
        EventTarget.prototype,
        'removeEventListener',
        removeDescriptor,
      );

      if (originalAnyDescriptor) {
        Object.defineProperty(AbortSignal, 'any', originalAnyDescriptor);
      }
    }
  });

  test('a caller signal that outlives hundreds of requests still delivers an abort', async () => {
    // A source that outlives hundreds of finished requests, each of which released
    // its listener, with a full collection forced in between where the runtime offers
    // one: the request still in flight must still be cancelled, with the caller's
    // reason, and nothing released earlier may interfere.
    const adapter: HTTPAdapter = {
      getType: () => 'mock',
      send: async (request: AdapterRequest): Promise<AdapterResponse> => {
        if (request.requestURL.endsWith('/slow')) {
          await new Promise<void>((resolve) => {
            request.signal?.addEventListener('abort', () => resolve(), {
              once: true,
            });
          });

          const error = new Error('Aborted');
          error.name = 'AbortError';
          throw error;
        }

        return { status: 200, headers: {}, body: null };
      },
    };
    const client = new HTTPClient({ adapter });
    const controller = new AbortController();
    const originalAnyDescriptor = Object.getOwnPropertyDescriptor(
      AbortSignal,
      'any',
    );

    Object.defineProperty(AbortSignal, 'any', {
      value: undefined,
      configurable: true,
    });

    try {
      for (let i = 0; i < 300; i += 1) {
        await client
          .get(`https://example.com/ok/${i}`)
          .signal(controller.signal)
          .send();
      }

      const bun = (globalThis as { Bun?: { gc?: (force: boolean) => void } })
        .Bun;

      bun?.gc?.(true);

      const builder = client
        .get('https://example.com/slow')
        .signal(controller.signal);
      const promise = builder.send();

      setTimeout(() => controller.abort('after_gc'), 10);

      const res = await promise;

      expect(res.isCancelled).toBe(true);
      expect(builder.error?.cancelReason).toBe('after_gc');
    } finally {
      if (originalAnyDescriptor) {
        Object.defineProperty(AbortSignal, 'any', originalAnyDescriptor);
      }
    }
  });

  test('a caller signal whose listener registration throws leaves nothing attached when AbortSignal.any is unavailable', async () => {
    // Two gaps the release list had: the caller's signal was composed before the `try`
    // whose `finally` runs the releasers, and the releaser was pushed only after both
    // listeners were attached. A signal that accepts the first listener and throws on
    // the second - here the internal controller's signal is the second - therefore left
    // the first attached forever. The throw itself surfaces to the caller - a signal
    // that refuses listeners is not something the client papers over - and the caller's
    // signal is left exactly as it was found.
    const adapter: HTTPAdapter = {
      getType: () => 'mock',
      send: (): Promise<AdapterResponse> =>
        Promise.resolve({ status: 200, headers: {}, body: null }),
    };
    const client = new HTTPClient({ adapter });
    const controller = new AbortController();
    const originalAnyDescriptor = Object.getOwnPropertyDescriptor(
      AbortSignal,
      'any',
    );
    const addDescriptor = Object.getOwnPropertyDescriptor(
      EventTarget.prototype,
      'addEventListener',
    );

    if (addDescriptor === undefined) {
      throw new Error('EventTarget.prototype.addEventListener is missing');
    }

    const originalAdd = addDescriptor.value as (
      this: EventTarget,
      ...args: Parameters<EventTarget['addEventListener']>
    ) => void;
    const addSpy = spyOn(controller.signal, 'addEventListener');
    const removeSpy = spyOn(controller.signal, 'removeEventListener');
    let abortListenersAttachedElsewhere = 0;

    // Every signal other than the caller's refuses an abort listener, so the second
    // attach inside `_composeSignals` throws after the first has landed on the caller's.
    Object.defineProperty(EventTarget.prototype, 'addEventListener', {
      ...addDescriptor,
      value: function refusingAddEventListener(
        this: EventTarget,
        ...args: Parameters<EventTarget['addEventListener']>
      ): void {
        if (
          args[0] === 'abort' &&
          this instanceof AbortSignal &&
          this !== controller.signal
        ) {
          abortListenersAttachedElsewhere += 1;
          throw new Error('no listeners here');
        }

        Reflect.apply(originalAdd, this, args);
      },
    });

    Object.defineProperty(AbortSignal, 'any', {
      value: undefined,
      configurable: true,
    });

    try {
      let thrown: unknown;

      try {
        await client
          .get('https://example.com/ok')
          .signal(controller.signal)
          .send();
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toBe('no listeners here');

      expect(abortListenersAttachedElsewhere).toBeGreaterThan(0);

      const added = addSpy.mock.calls.filter((call) => call[0] === 'abort');
      const removed = removeSpy.mock.calls.filter(
        (call) => call[0] === 'abort',
      );

      expect(added.length).toBe(1);
      expect(removed.length).toBe(added.length);
      // The listener taken off is the one put on.
      expect(removed[0]?.[1]).toBe(added[0]?.[1]);
    } finally {
      Object.defineProperty(
        EventTarget.prototype,
        'addEventListener',
        addDescriptor,
      );
      addSpy.mockRestore();
      removeSpy.mockRestore();

      if (originalAnyDescriptor) {
        Object.defineProperty(AbortSignal, 'any', originalAnyDescriptor);
      }
    }
  });

  test('no cancelReason when cancel called without reason via AbortError-throwing adapter', async () => {
    const { adapter } = makeAbortErrorAdapter();
    const client = new HTTPClient({ adapter });
    const builder = client.get('https://example.com/slow');
    const promise = builder.send();
    setTimeout(() => builder.cancel(), 10);
    await promise;

    expect(builder.error?.cancelReason).toBeUndefined();
  });
});

describe('HTTPClient — adapter marker flags', () => {
  // A marker is the only thing standing between an arbitrary thrown value and a
  // branch meant for a tag an adapter deliberately set — for the stream-abort
  // one, that branch also writes to the cookie jar. So a marker is trusted only
  // when it reads exactly `true`, which is what every adapter writes.
  // Throws rather than rejecting, so the parameter can stay `unknown`: what an
  // adapter hands back is not always an Error, and that is part of what these
  // tests cover.
  function makeThrowingAdapter(error: unknown): HTTPAdapter {
    return {
      getType: () => 'mock' as const,
      send: (): Promise<AdapterResponse> =>
        Promise.resolve().then(() => {
          throw error;
        }),
    };
  }

  /** Response metadata of the kind a genuine tagged abort carries. */
  const staleMetadata = {
    streamAbortStatus: 503,
    streamAbortHeaders: { 'set-cookie': ['stale=1; Path=/'] },
  };

  test('a marker set to false is not a stream abort, and its cookies are not stored', async () => {
    const jar = new CookieJar();
    const client = new HTTPClient({
      adapter: makeThrowingAdapter(
        Object.assign(new Error('boom'), {
          [RESPONSE_STREAM_ABORT_FLAG]: false,
          ...staleMetadata,
        }),
      ),
      baseURL: 'http://api.test',
      cookieJar: jar,
    });

    const response = await client.get('/x').send();

    // Testing for the property rather than its value classified an ordinary
    // adapter error as a terminal stream failure, and filed the Set-Cookie it
    // happened to carry under this request's URL.
    expect(response.isStreamError).toBe(false);
    expect(response.status).toBe(0);
    expect(jar.getCookiesFor('http://api.test/')).toHaveLength(0);
  });

  test('a marker whose getter throws is treated as untagged', async () => {
    const hostile = new Error('boom');

    Object.defineProperty(hostile, RESPONSE_STREAM_ABORT_FLAG, {
      get() {
        throw new Error('nope');
      },
    });
    Object.assign(hostile, staleMetadata);

    const jar = new CookieJar();
    const client = new HTTPClient({
      adapter: makeThrowingAdapter(hostile),
      baseURL: 'http://api.test',
      cookieJar: jar,
    });

    // An unguarded read would let the getter escape the classifier that exists
    // to normalize the failure.
    const response = await client.get('/x').send();

    expect(response.isStreamError).toBe(false);
    expect(response.status).toBe(0);
    expect(jar.getCookiesFor('http://api.test/')).toHaveLength(0);
  });

  test('a throwing Error.name getter does not escape abort classification', async () => {
    const hostile = new Error('adapter failed');
    Object.defineProperty(hostile, 'name', {
      get(): never {
        throw new Error('hostile name getter');
      },
    });

    const builder = new HTTPClient({
      adapter: makeThrowingAdapter(hostile),
    }).get('https://example.com/x');
    const response = await builder.send();

    expect(response.isCancelled).toBe(false);
    expect(builder.error?.code).toBe('adapter_error');
    expect(builder.error?.cause).toBe(hostile);
  });

  test('a hostile Proxy rejection cannot escape error normalization', async () => {
    const hostile = new Proxy(
      {},
      {
        get(): never {
          throw new Error('hostile get trap');
        },
        getPrototypeOf(): never {
          throw new Error('hostile prototype trap');
        },
      },
    );
    const builder = new HTTPClient({
      adapter: makeThrowingAdapter(hostile),
    }).get('https://example.com/x');
    const response = await builder.send();

    expect(response.isCancelled).toBe(false);
    expect(builder.error?.code).toBe('adapter_error');
    expect(builder.error?.cause?.message).toBe(
      'Non-error value thrown: unknown value',
    );
  });

  test('throwing stream metadata getters cannot replace a caller cancellation', async () => {
    const hostileFields = [
      'streamAbortStatus',
      'streamAbortHeaders',
      'effectiveRequestHeaders',
    ] as const;

    for (const hostileField of hostileFields) {
      const controller = new AbortController();
      const abortError = Object.assign(new Error('Request aborted'), {
        name: 'AbortError',
        [RESPONSE_STREAM_ABORT_FLAG]: true,
        streamAbortStatus: 200,
        streamAbortHeaders: {},
      });

      Object.defineProperty(abortError, hostileField, {
        get(): never {
          throw new Error(`hostile ${hostileField} getter`);
        },
        configurable: true,
      });

      const adapter: HTTPAdapter = {
        getType: () => 'mock',
        send: (): Promise<AdapterResponse> => {
          controller.abort('stop');
          return Promise.reject(abortError);
        },
      };
      const client = new HTTPClient({ adapter });
      const builder = client
        .get('https://example.com/x')
        .signal(controller.signal);
      const response = await builder.send();

      // Metadata is supplementary. A getter failure must not replace the
      // already-settled cancellation with request_setup_error.
      expect(response.isCancelled).toBe(true);
      expect(builder.error?.code).toBe('cancelled');
      expect(builder.error?.cancelReason).toBe('stop');
    }
  });

  test('throwing getters inside stream header metadata are treated as absent', async () => {
    const hostileHeaders = {};
    Object.defineProperty(hostileHeaders, 'set-cookie', {
      enumerable: true,
      get(): never {
        throw new Error('hostile header getter');
      },
    });

    const tagged = Object.assign(new Error('body aborted'), {
      name: 'AbortError',
      [RESPONSE_STREAM_ABORT_FLAG]: true,
      streamAbortStatus: 503,
      streamAbortHeaders: hostileHeaders,
    });
    const client = new HTTPClient({
      adapter: makeThrowingAdapter(tagged),
      baseURL: 'http://api.test',
      cookieJar: new CookieJar(),
    });
    const builder = client.get('/x');
    const response = await builder.send();

    // The marker still identifies a post-header abort, but unreadable evidence
    // cannot supply a trustworthy status/header pair.
    expect(response.isStreamError).toBe(true);
    expect(response.status).toBe(0);
    expect(builder.error?.code).toBe('stream_response_error');
  });

  test('a marker set to true is trusted, keeping the real status and its cookies', async () => {
    const jar = new CookieJar();
    const client = new HTTPClient({
      adapter: makeThrowingAdapter(
        Object.assign(new Error('boom'), {
          [RESPONSE_STREAM_ABORT_FLAG]: true,
          ...staleMetadata,
        }),
      ),
      baseURL: 'http://api.test',
      cookieJar: jar,
    });

    const response = await client.get('/x').send();

    expect(response.isStreamError).toBe(true);
    expect(response.status).toBe(503);
    expect(jar.getCookieHeaderString('http://api.test/next')).toBe('stale=1');
  });

  test('a tagged non-Error still routes, and its cause is normalized', async () => {
    const jar = new CookieJar();
    const client = new HTTPClient({
      // Nothing obliges an adapter to reject with an Error, and the marker is
      // readable on any object — so the branch has to survive one that is not.
      adapter: makeThrowingAdapter({
        [RESPONSE_STREAM_ABORT_FLAG]: true,
        ...staleMetadata,
      }),
      baseURL: 'http://api.test',
      cookieJar: jar,
    });

    const builder = client.get('/x');
    const response = await builder.send();

    expect(response.isStreamError).toBe(true);
    expect(response.status).toBe(503);
    expect(jar.getCookieHeaderString('http://api.test/next')).toBe('stale=1');

    // The cause slots are typed `Error`, so the raw value must not reach them.
    expect(builder.error?.code).toBe('stream_response_error');
    expect(builder.error?.cause).toBeInstanceOf(Error);
  });

  test('the XHR browser-timeout marker turns a bare AbortError into a timeout', async () => {
    const client = new HTTPClient({
      // What XHRAdapter throws when the browser fires its own hard timeout: an
      // AbortError, indistinguishable from a cancel without the marker.
      adapter: makeThrowingAdapter(
        Object.assign(new Error('Request aborted'), {
          name: 'AbortError',
          [XHR_BROWSER_TIMEOUT_FLAG]: true,
        }),
      ),
      baseURL: 'http://api.test',
      timeout: 0,
    });

    const response = await client.get('/x').send();

    expect(response.isTimeout).toBe(true);
    expect(response.isCancelled).toBe(false);
  });

  test('an XHR browser-timeout marker set to false stays a cancel', async () => {
    const client = new HTTPClient({
      adapter: makeThrowingAdapter(
        Object.assign(new Error('Request aborted'), {
          name: 'AbortError',
          [XHR_BROWSER_TIMEOUT_FLAG]: false,
        }),
      ),
      baseURL: 'http://api.test',
      timeout: 0,
    });

    const response = await client.get('/x').send();

    expect(response.isCancelled).toBe(true);
    expect(response.isTimeout).toBe(false);
  });

  test('throwing callback marker getters stay on the normalized error path', async () => {
    const hostileNonRetryable = new Error('adapter failed');
    Object.defineProperty(
      hostileNonRetryable,
      NON_RETRYABLE_HTTP_CLIENT_CALLBACK_ERROR_FLAG,
      {
        get(): never {
          throw new Error('hostile non-retryable marker');
        },
      },
    );

    const ordinaryBuilder = new HTTPClient({
      adapter: makeThrowingAdapter(hostileNonRetryable),
    }).get('https://example.com/x');
    await ordinaryBuilder.send();

    expect(ordinaryBuilder.error?.code).toBe('adapter_error');
    expect(ordinaryBuilder.error?.cause).toBe(hostileNonRetryable);

    const hostileFactoryMarker = Object.assign(new Error('callback failed'), {
      [NON_RETRYABLE_HTTP_CLIENT_CALLBACK_ERROR_FLAG]: true,
    });
    Object.defineProperty(hostileFactoryMarker, STREAM_FACTORY_ERROR_FLAG, {
      get(): never {
        throw new Error('hostile stream-factory marker');
      },
    });

    const callbackBuilder = new HTTPClient({
      adapter: makeThrowingAdapter(hostileFactoryMarker),
    }).get('https://example.com/x');
    await callbackBuilder.send();

    expect(callbackBuilder.error?.code).toBe('interceptor_error');
    expect(callbackBuilder.error?.cause).toBe(hostileFactoryMarker);
  });

  test('a throwing stream-cancel reason getter does not escape AbortError handling', async () => {
    const abortError = Object.assign(new Error('factory cancelled'), {
      name: 'AbortError',
    });
    Object.defineProperty(abortError, STREAM_FACTORY_CANCEL_KEY, {
      get(): never {
        throw new Error('hostile cancel-reason getter');
      },
    });

    const client = new HTTPClient({
      adapter: makeThrowingAdapter(abortError),
      timeout: 0,
    });
    const builder = client.get('https://example.com/x');
    const response = await builder.send();

    expect(response.isCancelled).toBe(true);
    expect(builder.error?.code).toBe('cancelled');
    expect(builder.error?.cancelReason).toBeUndefined();
  });
});

describe('HTTPClient — interceptor cancel reason', () => {
  test('interceptor returning { cancel: true } sets isCancelled with no cancelReason', async () => {
    const client = makeClient();
    client.addRequestInterceptor(() => ({ cancel: true as const }));

    const builder = client.get('/api/test');
    const res = await builder.send();

    expect(res.isCancelled).toBe(true);
    expect(builder.error?.cancelReason).toBeUndefined();
  });

  test('interceptor returning null is treated as cancel with no reason', async () => {
    const client = makeClient();
    client.addRequestInterceptor(() => null);

    const builder = client.get('/api/test');
    const res = await builder.send();

    expect(res.isCancelled).toBe(true);
    expect(builder.error?.cancelReason).toBeUndefined();
  });

  test('interceptor returning { cancel: true, reason } surfaces cancelReason on the error', async () => {
    const client = makeClient();
    client.addRequestInterceptor(() => ({
      cancel: true as const,
      reason: 'auth_missing',
    }));

    const builder = client.get('/api/test');
    const res = await builder.send();

    expect(res.isCancelled).toBe(true);
    expect(builder.error?.cancelReason).toBe('auth_missing');
  });

  test('retry-phase interceptor cancel reason surfaces on the error', async () => {
    const client = makeClient({
      retryPolicy: { strategy: 'fixed', maxRetryAttempts: 1, delayMS: 0 },
    });
    client.addRequestInterceptor(
      () => ({ cancel: true as const, reason: 'no_more_retries' }),
      { phases: ['retry'] },
    );

    const builder = client.get('/api/error'); // 500 triggers retry
    const res = await builder.send();

    expect(res.isCancelled).toBe(true);
    expect(builder.error?.cancelReason).toBe('no_more_retries');
  });
});

describe('HTTPClient — timeout', () => {
  test('isTimeout: true when request exceeds per-request timeout', async () => {
    const client = makeClient();
    const builder = client.get('/api/slow').timeout(100);
    const res = await builder.send(); // server delays 500ms
    expect(res.status).toBe(0);
    expect(res.isTimeout).toBe(true);
    expect(res.isFailed).toBe(true);
    expect(builder.error?.code).toBe('timeout');
    // Timeouts must never produce a cancelReason
    expect(builder.error?.cancelReason).toBeUndefined();
  });

  test('timeout(0) disables the per-attempt timeout', async () => {
    const client = makeClient();
    const builder = client.get('/api/slow').timeout(0);
    const res = await builder.send();

    expect(res.status).toBe(200);
    expect(res.isTimeout).toBe(false);
    expect(res.isFailed).toBe(false);
    expect(builder.error).toBeNull();
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
    expect(res.isFailed).toBe(true);
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
    expect(res.wasRedirectDetected).toBe(true);
    expect(res.wasRedirectFollowed).toBe(true);

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
        cookiesSent.push(scalarHeader(request.headers, 'cookie') ?? '');
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
            JSON.stringify({
              cookie: scalarHeader(request.headers, 'cookie') ?? '',
            }),
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

describe('HTTPClient — cookies across a scheme-crossing redirect', () => {
  test('an http hop in the chain cannot replace the Secure cookie the https hop set', async () => {
    // The real-world shape of the jar's store-time rule, driven through the client's
    // redirect loop rather than the jar alone: `https://` logs in and sets a Secure
    // session, redirects to an `http://` page that tries to plant its own `session`,
    // which redirects back to `https://`. MockAdapter matches routes by path, so one
    // adapter serves both schemes.
    const adapter = new MockAdapter();
    const seenCookies: Array<{ path: string; cookie: string | undefined }> = [];
    const record = (req: {
      path: string;
      headers: Record<string, string>;
    }): void => {
      seenCookies.push({ path: req.path, cookie: req.headers['cookie'] });
    };

    adapter.routes.get('/login', (req) => {
      record(req);

      return {
        status: 302,
        headers: {
          location: 'http://api.test/plain',
          'set-cookie': 'session=real; Secure; Path=/',
        },
      };
    });
    adapter.routes.get('/plain', (req) => {
      record(req);

      return {
        status: 302,
        headers: {
          location: 'https://api.test/me',
          'set-cookie': ['session=evil; Path=/', 'session=; Max-Age=0; Path=/'],
        },
      };
    });
    adapter.routes.get('/me', (req) => {
      record(req);

      return { status: 200, body: { ok: true } };
    });

    const jar = new CookieJar();
    const client = new HTTPClient({
      adapter,
      baseURL: 'https://api.test',
      cookieJar: jar,
      followRedirects: true,
    });

    const res = await client.get('/login').send();

    expect(res.status).toBe(200);
    expect(res.redirectHistory).toEqual([
      'http://api.test/plain',
      'https://api.test/me',
    ]);
    expect(seenCookies.map((entry) => entry.path)).toEqual([
      '/login',
      '/plain',
      '/me',
    ]);
    // Nothing went to the plain-text hop, and the https hop got the real session only.
    expect(seenCookies[1]?.cookie).toBeUndefined();
    expect(seenCookies[2]?.cookie).toBe('session=real');
    expect(jar.getAllCookies()).toHaveLength(1);
    expect(jar.getCookieFor('session', 'https://api.test/')?.value).toBe(
      'real',
    );
  });
});

describe('HTTPClient — redirect scheme downgrade', () => {
  test('a 307 from https to http resends the body, with credentials stripped', async () => {
    // Pinned as policy rather than found as a bug: curl and Node's clients follow a
    // downgrade with the body intact, and this client matches them. What it must not do
    // is carry credentials across: the hop is cross-origin, so `Authorization` and the
    // jar's Secure cookie stay behind. See the redirect docs.
    const adapter = new MockAdapter();
    const seen: Array<{
      path: string;
      body: unknown;
      authorization: string | undefined;
      cookie: string | undefined;
    }> = [];

    adapter.routes.post('/upload', (req) => {
      seen.push({
        path: req.path,
        body: req.body,
        authorization: req.headers['authorization'],
        cookie: req.headers['cookie'],
      });

      return {
        status: 307,
        headers: { location: 'http://api.test/upload-plain' },
      };
    });
    adapter.routes.post('/upload-plain', (req) => {
      seen.push({
        path: req.path,
        body: req.body,
        authorization: req.headers['authorization'],
        cookie: req.headers['cookie'],
      });

      return { status: 200, body: { ok: true } };
    });

    const jar = new CookieJar();
    jar.parseSetCookieHeader('session=real; Secure', 'https://api.test/');

    const res = await new HTTPClient({
      adapter,
      baseURL: 'https://api.test',
      cookieJar: jar,
      followRedirects: true,
    })
      .post('/upload')
      .headers({ authorization: 'Bearer token' })
      .json({ a: 1 })
      .send();

    expect(res.status).toBe(200);
    expect(seen.map((entry) => entry.path)).toEqual([
      '/upload',
      '/upload-plain',
    ]);
    expect(seen[0]?.authorization).toBe('Bearer token');
    expect(seen[0]?.cookie).toBe('session=real');
    expect(seen[1]?.body).toEqual({ a: 1 });
    expect(seen[1]?.authorization).toBeUndefined();
    expect(seen[1]?.cookie).toBeUndefined();
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

  test('response observer receives the effective request timeout', async () => {
    const client = makeClient({ followRedirects: true });
    let observedTimeout: number | undefined;

    client.addResponseObserver((_res, req) => {
      observedTimeout = req.timeout;
    });

    await client.get('/api/users/1').timeout(4_321).send();

    expect(observedTimeout).toBe(4_321);
  });

  test('response observer receives attemptNumber and requestID on AttemptRequest', async () => {
    const client = makeClient();
    let observedAttemptNumber: number | undefined;
    let observedRequestID: string | undefined;

    client.addResponseObserver((_res, req) => {
      observedAttemptNumber = req.attemptNumber;
      observedRequestID = req.requestID;
    });

    const res = await client.get('/api/users/1').send();

    expect(observedAttemptNumber).toBe(1);
    expect(observedRequestID).toBe(res.requestID);
  });

  test('response observer AttemptRequest.attemptNumber increments on retries, requestID stays consistent', async () => {
    let callCount = 0;
    const adapter: HTTPAdapter = {
      getType: () => 'mock',
      send: (): Promise<AdapterResponse> => {
        callCount++;
        if (callCount < 3) {
          return Promise.resolve({ status: 503, headers: {}, body: null });
        }
        return Promise.resolve({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode('{}'),
        });
      },
    };

    const client = new HTTPClient({ adapter });
    const seen: Array<{
      attemptNumber: number | undefined;
      requestID: string | undefined;
    }> = [];

    client.addResponseObserver(
      (_res, req) => {
        seen.push({
          attemptNumber: req.attemptNumber,
          requestID: req.requestID,
        });
      },
      { phases: ['retry', 'final'] },
    );

    const res = await client
      .get('https://example.com/flaky')
      .retryPolicy({ strategy: 'fixed', maxRetryAttempts: 3, delayMS: 0 })
      .send();

    expect(seen).toHaveLength(3); // two retry phases + final
    expect(seen[0].attemptNumber).toBe(1);
    expect(seen[1].attemptNumber).toBe(2);
    expect(seen[2].attemptNumber).toBe(3);
    // requestID is the same for all three
    expect(seen[0].requestID).toBe(res.requestID);
    expect(seen[1].requestID).toBe(res.requestID);
    expect(seen[2].requestID).toBe(res.requestID);
  });

  test('error observer receives requestID on best-effort snapshot for pre-dispatch failures', async () => {
    const client = makeClient();
    let observedRequestID: string | undefined;
    let observedAttemptNumber: number | undefined;

    client.addErrorObserver((err, req) => {
      observedRequestID = req.requestID;
      observedAttemptNumber = req.attemptNumber;
    });

    client.addRequestInterceptor(() => {
      throw new Error('interceptor boom');
    });

    const res = await client.get('/api/users/1').send();

    expect(res.isFailed).toBe(true);
    expect(observedRequestID).toBe(res.requestID);
    // No adapter attempt was dispatched — attemptNumber is undefined
    expect(observedAttemptNumber).toBeUndefined();
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
    expect(res.isFailed).toBe(true);
    expect(res.initialURL).toBe('https://example.com/users');
    expect(res.requestURL).toBe('https://example.com/users');
    expect(builder.state).toBe('failed');
    expect(builder.attemptCount).toBe(null);
    expect(builder.error?.code).toBe('interceptor_error');
    expect(builder.error?.initialURL).toBe('https://example.com/users');
    expect(builder.error?.requestURL).toBe('https://example.com/users');
    expect(builder.error?.wasRedirectDetected).toBe(false);
    expect(builder.error?.wasRedirectFollowed).toBe(false);
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

    const finalCodes: string[] = [];

    client.addErrorObserver(
      (err) => {
        finalCodes.push(err.code);
      },
      { phases: ['final'] },
    );

    await client.get('https://example.com/x').send();

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

  test('removes an inherited Content-Type so the adapter can add the multipart boundary', async () => {
    const client = makeClient({
      followRedirects: true,
      defaultHeaders: { 'Content-Type': 'application/json' },
    });
    const fd = new FormData();
    fd.append('username', 'alice');
    let contentType: string | string[] | undefined;

    client.addResponseObserver((_response, request) => {
      contentType = request.headers['content-type'];
    });

    await client.post('/api/upload').formData(fd).send();

    expect(contentType).toBeUndefined();
  });
});

describe('HTTPClient — timeout resolution', () => {
  // `Number(process.env.UNSET)` is `NaN`, and taken literally it passed the `> 0` check
  // that arms the per-attempt timer *and* the `<= 0` check that disables the
  // upload-settle wait: no timer on the attempt, and a wait that re-armed a `NaN` timer
  // every millisecond and could never expire. `Infinity` fired the attempt timer after
  // 1 ms, since the timer coerces anything past 2^31 - 1 to 1. `NaN` now takes the
  // default and `Infinity` disables the timer, on the config and the per-request override.
  const observed = async (
    config: { timeout?: number },
    perRequest?: number,
  ): Promise<number | undefined> => {
    const client = makeClient(config);
    let seen: number | undefined;

    client.addResponseObserver((_res, req) => {
      seen = req.timeout;
    });

    const builder = client.get('/api/users/1');

    if (perRequest !== undefined) {
      builder.timeout(perRequest);
    }

    await builder.send();

    return seen;
  };

  test('NaN takes the default, on the config and per request', async () => {
    expect(await observed({ timeout: Number.NaN })).toBe(DEFAULT_TIMEOUT_MS);
    expect(await observed({ timeout: 4_321 }, Number.NaN)).toBe(4_321);
  });

  test('Infinity means no timeout, the same as 0', async () => {
    expect(await observed({ timeout: Number.POSITIVE_INFINITY })).toBe(0);
    expect(await observed({}, Number.POSITIVE_INFINITY)).toBe(0);
  });

  test('a finite value past the timer ceiling is clamped to it', async () => {
    expect(await observed({ timeout: MAX_TIMER_MS + 1 })).toBe(MAX_TIMER_MS);
  });

  test('zero and a negative value still disable the per-attempt timer', async () => {
    expect(await observed({ timeout: 0 })).toBe(0);
    expect(await observed({ timeout: -5 })).toBe(0);
    expect(await observed({ timeout: 4_321 }, 0)).toBe(0);
  });

  test('a NaN timeout no longer leaves a never-settling upload wait spinning', async () => {
    // The redirect variant of the settle-wait test above, under the misconfiguration.
    // `NaN` is the per-request value here, over a 100ms client default, so the number the
    // wait runs under is the one `NaN` resolved to: taken literally it re-armed a `NaN`
    // timer every millisecond and never failed, and this test would hang at its own
    // deadline rather than fail at 100ms.
    let hop = 0;

    const adapter: HTTPAdapter = {
      getType: () => 'fetch',
      send: (_request: AdapterRequest): Promise<AdapterResponse> => {
        hop++;

        return Promise.resolve({
          status: 307,
          headers: { location: '/again' },
          body: null,
          requestBodySettled: new Promise(() => {}),
        });
      },
    };

    const reports: ErrorEvent[] = [];
    const onGlobalError = (event: Event): void => {
      reports.push(event as ErrorEvent);
      event.preventDefault();
    };

    globalThis.addEventListener('error', onGlobalError);

    try {
      const startedAt = Date.now();
      const response = await new HTTPClient({
        adapter,
        baseURL: 'http://example.test',
        followRedirects: true,
        timeout: 100,
      })
        .post('/upload')
        .json({ a: 1 })
        .timeout(Number.NaN)
        .send();

      expect(Date.now() - startedAt).toBeLessThan(2000);
      expect(hop).toBe(1);
      expect(response.isTimeout).toBe(true);
      expect(reports).toHaveLength(1);
    } finally {
      globalThis.removeEventListener('error', onGlobalError);
    }
  });
});

describe('HTTPClient — redirect', () => {
  test('passes through detectedRedirectURL for relative redirect targets', async () => {
    const adapter: HTTPAdapter = {
      getType: () => 'node',
      send: (_request: AdapterRequest): Promise<AdapterResponse> =>
        Promise.resolve({
          status: 302,
          detectedRedirectURL: 'https://example.com/next',
          headers: { location: '/next' },
          body: null,
        }),
    };

    const client = new HTTPClient({
      adapter,
      baseURL: 'https://example.com',
      followRedirects: false,
    });

    const builder = client.get('/start');
    const res = await builder.send();

    expect(res.requestURL).toBe('https://example.com/start');
    expect(res.detectedRedirectURL).toBe('https://example.com/next');
    expect(builder.error?.detectedRedirectURL).toBe('https://example.com/next');
  });

  test.each(['https://other.test/next', 'https://user:pass@other.test/next'])(
    'preserves an unfollowed absolute redirect target %s in the response and error',
    async (target) => {
      const adapter: HTTPAdapter = {
        getType: () => 'node',
        send: (_request: AdapterRequest): Promise<AdapterResponse> =>
          Promise.resolve({
            status: 302,
            detectedRedirectURL: target,
            headers: { location: target },
            body: null,
          }),
      };

      const client = new HTTPClient({
        adapter,
        baseURL: 'https://example.com',
        followRedirects: false,
      });

      const builder = client.get('/start');
      const res = await builder.send();

      expect(res.requestURL).toBe('https://example.com/start');
      expect(res.detectedRedirectURL).toBe(target);
      expect(builder.error?.detectedRedirectURL).toBe(target);
    },
  );

  test('does not retain detectedRedirectURL on the final followed response', async () => {
    let callCount = 0;

    const adapter: HTTPAdapter = {
      getType: () => 'node',
      send: (request: AdapterRequest): Promise<AdapterResponse> => {
        callCount++;

        if (callCount === 1) {
          return Promise.resolve({
            status: 302,
            detectedRedirectURL: 'https://example.com/next',
            headers: { location: '/next' },
            body: null,
          });
        }

        expect(request.requestURL).toBe('https://example.com/next');

        return Promise.resolve({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode('{"ok":true}'),
        });
      },
    };

    const client = new HTTPClient({
      adapter,
      baseURL: 'https://example.com',
      followRedirects: true,
    });

    const res = await client.get('/start').send<{ ok: boolean }>();

    expect(res.status).toBe(200);
    expect(res.requestURL).toBe('https://example.com/next');
    expect(res.detectedRedirectURL).toBeUndefined();
    expect(res.redirectHistory).toEqual(['https://example.com/next']);
  });

  test('XHR-style redirect detection keeps requestURL and exposes detectedRedirectURL', async () => {
    (globalThis as Record<string, unknown>).XMLHttpRequest = class {};

    const adapter: HTTPAdapter = {
      getType: () => 'xhr',
      send: () =>
        Promise.resolve({
          status: 0,
          wasRedirectDetected: true,
          detectedRedirectURL: 'https://example.com/redirected',
          headers: {},
          body: null,
        }),
    };

    const client = new HTTPClient({
      baseURL: 'https://example.com',
      adapter,
      followRedirects: false,
    });

    const builder = client.get('/start');
    const res = await builder.send();

    expect(res.status).toBe(0);
    expect(res.requestURL).toBe('https://example.com/start');
    expect(res.wasRedirectDetected).toBe(true);
    expect(res.wasRedirectFollowed).toBe(false);
    expect(res.detectedRedirectURL).toBe('https://example.com/redirected');
    expect(builder.error?.code).toBe('redirect_disabled');
    expect(builder.error?.requestURL).toBe('https://example.com/start');
    expect(builder.error?.detectedRedirectURL).toBe(
      'https://example.com/redirected',
    );
  });

  test('disabled redirects settle as redirect_disabled on server responses', async () => {
    const client = makeClient();
    const builder = client.get('/api/redirect/301');
    const res = await builder.send();

    expect(res.status).toBe(0);
    expect(res.isNetworkError).toBe(false);
    expect(res.isFailed).toBe(true);
    expect(res.initialURL).toBe(`${server.url}/api/redirect/301`);
    expect(res.requestURL).toBe(`${server.url}/api/redirect/301`);
    expect(res.wasRedirectDetected).toBe(true);
    expect(res.wasRedirectFollowed).toBe(false);
    expect(res.detectedRedirectURL).toBe(`${server.url}/api/test`);
    expect(res.redirectHistory).toEqual([]);
    expect(builder.error?.code).toBe('redirect_disabled');
    expect(builder.error?.wasRedirectDetected).toBe(true);
    expect(builder.error?.wasRedirectFollowed).toBe(false);
    expect(builder.error?.detectedRedirectURL).toBe(`${server.url}/api/test`);
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
    expect(res.wasRedirectDetected).toBe(true);
    expect(res.wasRedirectFollowed).toBe(true);
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
    const followUpHeaders: Array<Record<string, string | string[]>> = [];

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

    const client = new HTTPClient({
      adapter,
      followRedirects: true,
      includeRequestID: true,
    });

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

  test('cross-origin redirect strips userinfo from the Location URL', async () => {
    // `user:pass@` in a URL is `Authorization: Basic` by another name - `NodeAdapter`
    // copies it onto `options.auth` and `fetch` sends it. A hop that has the caller's
    // `Authorization` stripped for crossing origins must not get credentials handed back
    // by the very response that redirected it.
    const followUps: string[] = [];

    const adapter: HTTPAdapter = {
      getType: () => 'mock',
      send: (request: AdapterRequest): Promise<AdapterResponse> => {
        if (request.requestURL === 'https://api.example/start') {
          return Promise.resolve({
            status: 302,
            headers: { location: 'https://admin:secret@internal.other/admin' },
            body: null,
          });
        }

        followUps.push(request.requestURL);
        return Promise.resolve({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode('{}'),
        });
      },
    };

    const client = new HTTPClient({ adapter, followRedirects: true });

    const res = await client
      .get('https://api.example/start', {
        headers: { authorization: 'Bearer caller-token' },
      })
      .send();

    expect(followUps).toEqual(['https://internal.other/admin']);
    // The hop is recorded without the credentials too: observers and errors read this.
    expect(res.redirectHistory).toEqual(['https://internal.other/admin']);
    expect(JSON.stringify(res.redirectHistory)).not.toContain('secret');
  });

  test('same-origin redirect keeps userinfo in the Location URL', async () => {
    // Same origin is the one the caller addressed, and may already have been carrying
    // credentials; only a *cross-origin* hop has them taken away.
    const followUps: string[] = [];

    const adapter: HTTPAdapter = {
      getType: () => 'mock',
      send: (request: AdapterRequest): Promise<AdapterResponse> => {
        if (request.requestURL === 'https://api.example/start') {
          return Promise.resolve({
            status: 302,
            headers: { location: 'https://admin:secret@api.example/next' },
            body: null,
          });
        }

        followUps.push(request.requestURL);
        return Promise.resolve({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode('{}'),
        });
      },
    };

    const client = new HTTPClient({ adapter, followRedirects: true });

    await client.get('https://api.example/start').send();

    expect(followUps).toEqual(['https://admin:secret@api.example/next']);
  });

  test('a non-http(s) Location is a request_setup_error, not an interceptor_error', async () => {
    // No interceptor ran, so a message saying one rewrote the URL - and a code monitors
    // key on for *their own* interceptors - named the wrong thing entirely.
    const adapter: HTTPAdapter = {
      getType: () => 'mock',
      send: (): Promise<AdapterResponse> =>
        Promise.resolve({
          status: 302,
          headers: { location: 'file:///etc/passwd' },
          body: null,
        }),
    };

    const client = new HTTPClient({ adapter, followRedirects: true });

    const builder = client.get('https://api.example/start');
    const res = await builder.send();

    expect(res.isFailed).toBe(true);
    expect(builder.error?.code).toBe('request_setup_error');
    expect(builder.error?.cause?.message).toContain('file:///etc/passwd');
  });

  test('a redirect interceptor still sees a non-http(s) Location and can rescue it', async () => {
    // Refusing the scheme *before* the interceptors would take the hop away from them
    // entirely - and rewriting `requestURL` in the redirect phase is the documented way
    // to steer or reject a hop. The refusal happens after they run, so an interceptor
    // that fixes the target still gets to.
    const seen: string[] = [];
    const followUps: string[] = [];

    const adapter: HTTPAdapter = {
      getType: () => 'mock',
      send: (request: AdapterRequest): Promise<AdapterResponse> => {
        if (request.requestURL === 'https://api.example/start') {
          return Promise.resolve({
            status: 302,
            headers: { location: 'ftp://files.example/dump' },
            body: null,
          });
        }

        followUps.push(request.requestURL);
        return Promise.resolve({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode('{}'),
        });
      },
    };

    const client = new HTTPClient({ adapter, followRedirects: true });

    client.addRequestInterceptor(
      (req) => {
        seen.push(req.requestURL);

        return { ...req, requestURL: 'https://api.example/rescued' };
      },
      { phases: ['redirect'] },
    );

    const res = await client.get('https://api.example/start').send();

    expect(seen).toEqual(['ftp://files.example/dump']);
    expect(followUps).toEqual(['https://api.example/rescued']);
    expect(res.status).toBe(200);
  });

  test('a redirect interceptor can cancel a non-http(s) Location as a cancel', async () => {
    const adapter: HTTPAdapter = {
      getType: () => 'mock',
      send: (): Promise<AdapterResponse> =>
        Promise.resolve({
          status: 302,
          headers: { location: 'file:///etc/passwd' },
          body: null,
        }),
    };

    const client = new HTTPClient({ adapter, followRedirects: true });

    client.addRequestInterceptor(
      () => ({ cancel: true, reason: 'bad scheme' }),
      {
        phases: ['redirect'],
      },
    );

    const res = await client.get('https://api.example/start').send();

    expect(res.isCancelled).toBe(true);
  });

  test('same-origin redirect preserves caller-supplied Cookie header without a jar', async () => {
    const followUpHeaders: Array<Record<string, string | string[]>> = [];

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

  test('cross-host redirects store response cookies at the source and send only target cookies', async () => {
    const jar = new CookieJar();
    jar.parseSetCookieHeader('target=2; Secure', 'https://other.example/');
    const seen: Array<Record<string, string | string[]>> = [];
    const adapter: HTTPAdapter = {
      getType: () => 'mock',
      send: (request): Promise<AdapterResponse> => {
        seen.push({ ...request.headers });
        if (request.requestURL === 'https://example.com/start') {
          return Promise.resolve({
            status: 302,
            headers: {
              location: 'https://other.example/dest',
              'set-cookie': ['source=1; Secure; Path=/'],
            },
            body: null,
          });
        }
        return Promise.resolve({ status: 200, headers: {}, body: null });
      },
    };
    const client = new HTTPClient({
      adapter,
      cookieJar: jar,
      followRedirects: true,
    });
    await client.get('https://example.com/start').send();
    expect(seen).toHaveLength(2);
    expect(seen[1].cookie).toBe('target=2');
    expect(jar.getCookieHeaderString('https://example.com/')).toBe('source=1');
    expect(jar.getCookieHeaderString('https://other.example/')).toBe(
      'target=2',
    );
  });

  test('cross-origin redirect strips caller-supplied Cookie without a jar or interceptor', async () => {
    const followUpHeaders: Array<Record<string, string | string[]>> = [];

    const adapter: HTTPAdapter = {
      getType: () => 'mock',
      send: (request: AdapterRequest): Promise<AdapterResponse> => {
        if (request.requestURL === 'https://example.com/start') {
          return Promise.resolve({
            status: 302,
            headers: { location: 'https://other.example/dest' },
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
    expect(followUpHeaders[0].cookie).toBeUndefined();
  });

  test('redirect interceptor cannot leak sensitive headers after rewriting to a cross-origin target', async () => {
    const followUpHeaders: Array<Record<string, string | string[]>> = [];

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
    expect(res.wasRedirectDetected).toBe(true);
    expect(res.wasRedirectFollowed).toBe(true);
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
    expect(res.isFailed).toBe(true);
    expect(builder.error?.code).toBe('timeout');
    expect(res.initialURL).toBe(`${server.url}/api/redirect/302-slow`);
    expect(res.requestURL).toBe(`${server.url}/api/slow`);
    expect(res.wasRedirectDetected).toBe(true);
    expect(res.wasRedirectFollowed).toBe(true);
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
        });
        request.onDownloadProgress?.({
          loaded: 6,
          total: 8,
          progress: 0.75,
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
    expect(res.wasRedirectDetected).toBe(true);
    expect(res.wasRedirectFollowed).toBe(true);
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
    expect(res.isFailed).toBe(true);
    expect(res.initialURL).toBe(`${server.url}/api/redirect/loop-a`);
    expect(res.requestURL).toBe(`${server.url}/api/redirect/loop-b`);
    expect(res.wasRedirectDetected).toBe(true);
    expect(res.wasRedirectFollowed).toBe(true);
    expect(res.redirectHistory).toEqual([`${server.url}/api/redirect/loop-b`]);
    expect(builder.state).toBe('failed');
    expect(builder.error?.code).toBe('redirect_loop');
    expect(builder.error?.message).toBe('Redirect limit exceeded');
    expect(builder.error?.initialURL).toBe(`${server.url}/api/redirect/loop-a`);
    expect(builder.error?.requestURL).toBe(`${server.url}/api/redirect/loop-b`);
    expect(builder.error?.wasRedirectDetected).toBe(true);
    expect(builder.error?.wasRedirectFollowed).toBe(true);
    expect(builder.error?.redirectHistory).toEqual([
      `${server.url}/api/redirect/loop-b`,
    ]);
    expect(errorCodes).toEqual(['redirect_loop']);
  });

  test('does not follow a 3xx whose body failed after headers arrived', async () => {
    const requestedPaths: string[] = [];

    const adapter: HTTPAdapter = {
      getType: () => 'node',
      send: (request: AdapterRequest): Promise<AdapterResponse> => {
        requestedPaths.push(new URL(request.requestURL).pathname);

        if (requestedPaths.length === 1) {
          return Promise.resolve({
            status: 302,
            wasRedirectDetected: true,
            detectedRedirectURL: 'https://example.com/next',
            headers: { location: '/next' },
            body: null,
            isStreamError: true,
            streamErrorCode: 'stream_response_error',
            errorCause: new Error('terminated'),
          });
        }

        return Promise.resolve({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode('{"ok":true}'),
        });
      },
    };

    const client = new HTTPClient({
      adapter,
      baseURL: 'https://example.com',
      followRedirects: true,
    });

    const builder = client.get('/start');
    const res = await builder.send();

    // The healthy destination must never be reached — following it would have
    // resolved a terminal stream failure as a 200.
    expect(requestedPaths).toEqual(['/start']);
    expect(res.status).toBe(302);
    expect(res.isStreamError).toBe(true);
    expect(res.isFailed).toBe(true);
    expect(res.wasRedirectFollowed).toBe(false);
    // The Location header survived the truncation, so the target is still reported.
    expect(res.wasRedirectDetected).toBe(true);
    expect(res.detectedRedirectURL).toBe('https://example.com/next');
    expect(builder.error?.code).toBe('stream_response_error');
  });

  test('keeps isTimeout on a 3xx truncated by a per-attempt timeout', async () => {
    let callCount = 0;

    const adapter: HTTPAdapter = {
      getType: () => 'node',
      send: async (request: AdapterRequest): Promise<AdapterResponse> => {
        callCount++;

        if (callCount === 1) {
          // Headers arrived, then the attempt signal fired mid-body — the shape
          // adapters hand back for a timeout that strikes during the body read.
          await new Promise<void>((resolve) => {
            request.signal?.addEventListener('abort', () => {
              resolve();
            });
          });

          const error = new Error('Request aborted during response streaming');
          error.name = 'AbortError';

          throw Object.assign(error, {
            [RESPONSE_STREAM_ABORT_FLAG]: true,
            streamAbortStatus: 302,
            streamAbortHeaders: { location: '/next' },
          });
        }

        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode('{"ok":true}'),
        };
      },
    };

    const client = new HTTPClient({
      adapter,
      baseURL: 'https://example.com',
      followRedirects: true,
      timeout: 25,
    });

    const builder = client.get('/start');
    const res = await builder.send();

    expect(callCount).toBe(1);
    expect(res.status).toBe(302);
    expect(res.isStreamError).toBe(true);
    // The whole point: a followed hop would have reported its own isTimeout.
    expect(res.isTimeout).toBe(true);
    expect(res.isFailed).toBe(true);
    expect(res.wasRedirectFollowed).toBe(false);
    // Nothing follows the hop any more, so the rebuilt response is the only
    // thing left that can say where it pointed. The client resolves it from the
    // headers the adapter tagged onto the throw.
    expect(res.wasRedirectDetected).toBe(true);
    expect(res.detectedRedirectURL).toBe('https://example.com/next');
    expect(builder.error?.code).toBe('stream_response_error');
  });

  test('reports the redirect target of a truncated 3xx when following is off', async () => {
    const adapter: HTTPAdapter = {
      getType: () => 'node',
      send: async (request: AdapterRequest): Promise<AdapterResponse> => {
        await new Promise<void>((resolve) => {
          request.signal?.addEventListener('abort', () => {
            resolve();
          });
        });

        const error = new Error('Request aborted during response streaming');
        error.name = 'AbortError';

        throw Object.assign(error, {
          [RESPONSE_STREAM_ABORT_FLAG]: true,
          streamAbortStatus: 302,
          streamAbortHeaders: { location: '/next' },
        });
      },
    };

    const client = new HTTPClient({
      adapter,
      baseURL: 'https://example.com',
      followRedirects: false,
      timeout: 25,
    });

    const builder = client.get('/start');
    const res = await builder.send();

    // redirect_disabled hardcodes wasRedirectDetected, so without the resolved
    // target this branch reported "there was a redirect" and no destination.
    expect(builder.error?.code).toBe('redirect_disabled');
    expect(res.wasRedirectDetected).toBe(true);
    expect(res.detectedRedirectURL).toBe('https://example.com/next');

    // Deliberate, and worth pinning because it surprises: a timeout DID fire
    // mid-body, and the identical failure with following enabled reports
    // isTimeout: true and code 'stream_response_error'. Here the timeout is
    // incidental — the request ends at the redirect either way — so the code
    // stays 'redirect_disabled'. Reporting the timeout instead would make the
    // classification depend on whether the body happened to finish.
    expect(res.isTimeout).toBe(false);

    // Same reason the status is synthetic: every disabled redirect reports
    // status 0 and no stream error, intact ones included.
    expect(res.status).toBe(0);
    expect(res.isStreamError).toBe(false);
  });

  test('still reports redirect_disabled for a truncated 3xx when following is off', async () => {
    const adapter: HTTPAdapter = {
      getType: () => 'node',
      send: (_request: AdapterRequest): Promise<AdapterResponse> =>
        Promise.resolve({
          status: 302,
          wasRedirectDetected: true,
          detectedRedirectURL: 'https://example.com/next',
          headers: { location: '/next' },
          body: null,
          isStreamError: true,
          streamErrorCode: 'stream_response_error',
          errorCause: new Error('terminated'),
        }),
    };

    const client = new HTTPClient({
      adapter,
      baseURL: 'https://example.com',
      followRedirects: false,
    });

    const builder = client.get('/start');
    const res = await builder.send();

    // That branch follows nothing, so it reports a truncated 3xx exactly as it
    // reports an intact one.
    expect(builder.error?.code).toBe('redirect_disabled');
    expect(res.wasRedirectDetected).toBe(true);
    expect(res.detectedRedirectURL).toBe('https://example.com/next');
  });
});

describe('HTTPClient — sub-clients', () => {
  test('exposes client IDs and adapter types on root and sub-clients', () => {
    const rootAdapter: HTTPAdapter = {
      getType: () => 'mock',
      send: () =>
        Promise.resolve({
          status: 200,
          headers: {},
          body: null,
        }),
    };
    const subAdapter: HTTPAdapter = {
      getType: () => 'fetch',
      send: () =>
        Promise.resolve({
          status: 200,
          headers: {},
          body: null,
        }),
    };
    const root = new HTTPClient({ adapter: rootAdapter });
    const sub = root.createSubClient({ adapter: subAdapter });

    expect(root.clientID).toEqual(expect.any(String));
    expect(sub.clientID).toEqual(expect.any(String));
    expect(sub.clientID).not.toBe(root.clientID);
    expect(root.adapterType).toBe('mock');
    expect(sub.adapterType).toBe('fetch');
  });

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

  test('sub-client parent response observers run before sub-client observers', async () => {
    const root = makeClient();
    const order: string[] = [];

    root.addResponseObserver(() => {
      order.push('root');
    });

    const sub = root.createSubClient();
    sub.addResponseObserver(() => {
      order.push('sub');
    });

    await sub.get('/api/test').send();
    expect(order).toEqual(['root', 'sub']);
  });

  test('sub-client parent error observers run before sub-client observers', async () => {
    const root = new HTTPClient({ timeout: 100 });
    const order: string[] = [];

    root.addErrorObserver(() => {
      order.push('root');
    });

    const sub = root.createSubClient();
    sub.addErrorObserver(() => {
      order.push('sub');
    });

    // Use a port nothing is listening on to guarantee a transport failure
    await sub.get('http://127.0.0.1:1').send();
    expect(order).toEqual(['root', 'sub']);
  });

  test('sub-client does not expose createSubClient()', () => {
    const root = makeClient();
    const sub = root.createSubClient();
    expect('createSubClient' in sub).toBe(false);
  });

  test('sub-client can use a different adapter', async () => {
    let didUseRootAdapter = false;
    let didUseSubAdapter = false;

    const rootAdapter: HTTPAdapter = {
      getType: () => 'mock',
      send: () => {
        didUseRootAdapter = true;

        return Promise.resolve({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode('{"source":"root"}'),
        });
      },
    };
    const subAdapter: HTTPAdapter = {
      getType: () => 'mock',
      send: () => {
        didUseSubAdapter = true;

        return Promise.resolve({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode('{"source":"sub"}'),
        });
      },
    };
    const root = new HTTPClient({ adapter: rootAdapter });
    const sub = root.createSubClient({ adapter: subAdapter });

    const [rootRes, subRes] = await Promise.all([
      root.get('https://example.com/root').send<{ source: string }>(),
      sub.get('https://example.com/sub').send<{ source: string }>(),
    ]);

    expect(didUseRootAdapter).toBe(true);
    expect(didUseSubAdapter).toBe(true);
    expect(rootRes.body.source).toBe('root');
    expect(subRes.body.source).toBe('sub');
  });

  test('sub-client rejects browser-incompatible adapter overrides', () => {
    (globalThis as Record<string, unknown>).window = {};
    (globalThis as Record<string, unknown>).document = {};

    const root = new HTTPClient();
    const nodeAdapter: HTTPAdapter = {
      getType: () => 'node',
      send: () =>
        Promise.resolve({
          status: 200,
          headers: {},
          body: null,
        }),
    };

    expect(() => root.createSubClient({ adapter: nodeAdapter })).toThrow(
      /Node adapter is not supported in browser environments/i,
    );
  });

  test('cancelAll() on sub-client cancels parent requests too', async () => {
    const root = makeClient();
    const sub = root.createSubClient();

    const rootReq = root.get('/api/slow').send();
    setTimeout(() => sub.cancelAll(), 10);

    const res = await rootReq;
    expect(res.isCancelled).toBe(true);
    expect(res.isFailed).toBe(true);
  });

  test('cancelOwn() only cancels own requests', async () => {
    const root = makeClient();
    const sub = root.createSubClient();

    const rootReq = root.get('/api/slow').send();
    const subReq = sub.get('/api/slow').send();

    setTimeout(() => sub.cancelOwn(), 10);

    const [rootRes, subRes] = await Promise.all([rootReq, subReq]);
    expect(subRes.isCancelled).toBe(true);
    expect(subRes.isFailed).toBe(true);
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
    expect(subLabeledRes.isFailed).toBe(true);
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
    expect(
      root
        .listRequests({ scope: 'all' })
        .requests.map((request) => request.clientID)
        .sort(),
    ).toEqual([root.clientID, sub.clientID].sort());

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
    expect(res.isFailed).toBe(true);
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

  test('builder.requestID is available before send()', () => {
    const client = makeClient();
    const builder = client.get('/api/test');

    expect(typeof builder.requestID).toBe('string');
    expect(builder.requestID.length).toBeGreaterThan(0);
  });

  test('builder.requestID matches response.requestID after send()', async () => {
    const client = makeClient();
    const builder = client.get('/api/test');
    const idBeforeSend = builder.requestID;
    const res = await builder.send();

    expect(builder.requestID).toBe(idBeforeSend);
    expect(res.requestID).toBe(idBeforeSend);
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
    expect(res.isFailed).toBe(true);
    expect(elapsed).toBeLessThan(1000);
  });

  test('cancel during retry delay keeps requestBodySettled from the retried response', async () => {
    // The resolved-response retry path nulled `adapterResponse` on a cancel during the
    // backoff and carried no upload promise of its own, so the hop loop had nowhere to
    // read it: a bodied `POST` early-acked with a `503` and cancelled while waiting to
    // retry answered `undefined` - the documented "the body went out" - for an upload the
    // adapter had torn down. The throw path already carried it; this is the other half.
    const uploadFailure = new Error('upload torn down');

    const adapter: HTTPAdapter = {
      getType: () => 'node',
      send: (_request: AdapterRequest): Promise<AdapterResponse> =>
        Promise.resolve({
          status: 503,
          headers: {},
          body: null,
          requestBodySettled: Promise.resolve(uploadFailure),
        }),
    };

    const client = new HTTPClient({ adapter });
    // `PUT`, not `POST`: a non-idempotent method is never replayed on a real response,
    // so a `POST` would not have entered the retry wait at all.
    const builder = client
      .put('https://example.com/always-503')
      .json({ payload: 'x' })
      .retryPolicy({ strategy: 'fixed', maxRetryAttempts: 3, delayMS: 5000 })
      .onAttemptEnd((e) => {
        if (e.willRetry) {
          builder.cancel();
        }
      });

    const res = await builder.send();

    expect(res.isCancelled).toBe(true);
    expect(res.requestBodySettled).toBeDefined();
    expect(await res.requestBodySettled).toBe(uploadFailure);
  });

  for (const outcome of ['response', 'throw'] as const) {
    for (const isCompleted of [true, false]) {
      test(`${outcome} retry after long backoff ${isCompleted ? 'accepts a completed upload' : 'times out a stalled upload'}`, async () => {
        let attempts = 0;
        const signals: AbortSignal[] = [];
        const reports: ErrorEvent[] = [];
        const onGlobalError = (event: Event): void => {
          reports.push(event as ErrorEvent);
          event.preventDefault();
        };
        const upload = isCompleted
          ? Promise.resolve(undefined)
          : new Promise<Error | undefined>(() => {});
        const adapter: HTTPAdapter = {
          getType: () => 'node',
          send: (request: AdapterRequest): Promise<AdapterResponse> => {
            attempts++;
            if (request.signal) {
              signals.push(request.signal);
            }
            if (attempts > 1) {
              return Promise.resolve({ status: 200, headers: {}, body: null });
            }
            if (outcome === 'throw') {
              return Promise.reject(
                Object.assign(new Error('connection closed'), {
                  [REQUEST_BODY_SETTLED_KEY]: upload,
                }),
              );
            }
            return Promise.resolve({
              status: 503,
              headers: {},
              body: null,
              requestBodySettled: upload,
            });
          },
        };

        globalThis.addEventListener('error', onGlobalError);
        try {
          // Backoff outlasts the stall window even though send() answers immediately.
          const response = await new HTTPClient({
            adapter,
            timeout: 20,
            retryPolicy: {
              strategy: 'fixed',
              maxRetryAttempts: 1,
              delayMS: 60,
            },
          })
            .put('https://example.com/upload')
            .json({ a: 1 })
            .send();

          expect(attempts).toBe(isCompleted ? 2 : 1);
          expect(response.status).toBe(isCompleted ? 200 : 0);
          expect(response.isTimeout).toBe(!isCompleted);
          expect(response.isCancelled).toBe(false);
          expect(signals[0]?.aborted).toBe(!isCompleted);
          expect(reports).toHaveLength(isCompleted ? 0 : 1);
        } finally {
          globalThis.removeEventListener('error', onGlobalError);
        }
      });
    }
  }

  test("a retry waits for the previous attempt's upload to settle first", async () => {
    // The redirect loop waits on `requestBodySettled` before the next hop; the retry
    // loop did not. `NodeAdapter.send()` resolves when the response is consumed, so an
    // early `503` to a bodied `PUT` arrives with the writer still running, the backoff
    // elapsed, and attempt two was dispatched beside attempt one's upload - the same
    // double-send the redirect wait exists to prevent.
    let settledAt = 0;
    let secondAttemptStartedAt = 0;
    let attempt = 0;

    const adapter: HTTPAdapter = {
      getType: () => 'node',
      send: (_request: AdapterRequest): Promise<AdapterResponse> => {
        attempt++;

        if (attempt === 1) {
          return Promise.resolve({
            status: 503,
            headers: {},
            body: null,
            requestBodySettled: new Promise((resolve) => {
              setTimeout(() => {
                settledAt = Date.now();
                resolve(undefined);
              }, 80);
            }),
          });
        }

        secondAttemptStartedAt = Date.now();

        return Promise.resolve({ status: 200, headers: {}, body: null });
      },
    };

    const response = await new HTTPClient({ adapter })
      .put('https://example.com/upload')
      .json({ a: 1 })
      .retryPolicy({ strategy: 'fixed', maxRetryAttempts: 2, delayMS: 10 })
      .send();

    expect(response.status).toBe(200);
    expect(attempt).toBe(2);
    expect(settledAt).toBeGreaterThan(0);
    expect(secondAttemptStartedAt).toBeGreaterThanOrEqual(settledAt);
  });

  test("a retry after a thrown attempt waits for that attempt's upload to settle first", async () => {
    // The resolve path waits; the throw path did not, on the grounds that a hop that
    // threw has no socket left. True of `NodeAdapter`, not of a custom adapter that
    // rejects `send()` while its upload is still going out and tags the error with the
    // still-open outcome - the backoff elapsed and attempt two was dispatched beside
    // attempt one's body.
    let settledAt = 0;
    let secondAttemptStartedAt = 0;
    let attempt = 0;

    const adapter: HTTPAdapter = {
      getType: () => 'node',
      send: (_request: AdapterRequest): Promise<AdapterResponse> => {
        attempt++;

        if (attempt === 1) {
          const failure = new Error('socket reset mid-upload');

          Object.assign(failure, {
            [REQUEST_BODY_SETTLED_KEY]: new Promise<Error | undefined>(
              (resolve) => {
                setTimeout(() => {
                  settledAt = Date.now();
                  resolve(failure);
                }, 80);
              },
            ),
          });

          return Promise.reject(failure);
        }

        secondAttemptStartedAt = Date.now();

        return Promise.resolve({ status: 200, headers: {}, body: null });
      },
    };

    const response = await new HTTPClient({ adapter })
      .put('https://example.com/upload')
      .json({ a: 1 })
      .retryPolicy({ strategy: 'fixed', maxRetryAttempts: 2, delayMS: 10 })
      .send();

    expect(response.status).toBe(200);
    expect(attempt).toBe(2);
    expect(settledAt).toBeGreaterThan(0);
    expect(secondAttemptStartedAt).toBeGreaterThanOrEqual(settledAt);
  });

  test('a cancel during the throw-path retry upload wait is not held for the upload', async () => {
    const controller = new AbortController();
    let attempt = 0;

    const adapter: HTTPAdapter = {
      getType: () => 'node',
      send: (_request: AdapterRequest): Promise<AdapterResponse> => {
        attempt++;

        const failure = new Error('socket reset mid-upload');

        Object.assign(failure, {
          // Never settles: the wait must end on the cancel alone.
          [REQUEST_BODY_SETTLED_KEY]: new Promise(() => {}),
        });

        return Promise.reject(failure);
      },
    };

    const builder = new HTTPClient({ adapter })
      .put('https://example.com/upload')
      .json({ a: 1 })
      .signal(controller.signal)
      .retryPolicy({ strategy: 'fixed', maxRetryAttempts: 2, delayMS: 10 })
      .onAttemptEnd((e) => {
        if (e.willRetry) {
          setTimeout(() => controller.abort('gave up'), 30);
        }
      });

    const start = Date.now();
    const res = await builder.send();

    expect(res.isCancelled).toBe(true);
    expect(builder.error?.cancelReason).toBe('gave up');
    expect(attempt).toBe(1);
    expect(Date.now() - start).toBeLessThan(2000);
    expect(res.requestBodySettled).toBeDefined();
  });

  test('a cancel during the retry upload wait is not held for the upload', async () => {
    const controller = new AbortController();
    let attempt = 0;

    const adapter: HTTPAdapter = {
      getType: () => 'node',
      send: (_request: AdapterRequest): Promise<AdapterResponse> => {
        attempt++;

        return Promise.resolve({
          status: 503,
          headers: {},
          body: null,
          // Never settles: the wait must end on the cancel alone.
          requestBodySettled: new Promise(() => {}),
        });
      },
    };

    const client = new HTTPClient({ adapter });
    const builder = client
      .put('https://example.com/upload')
      .json({ a: 1 })
      .signal(controller.signal)
      .retryPolicy({ strategy: 'fixed', maxRetryAttempts: 2, delayMS: 10 })
      .onAttemptEnd((e) => {
        if (e.willRetry) {
          // After the backoff, during the upload wait.
          setTimeout(() => controller.abort('gave up'), 30);
        }
      });

    const start = Date.now();
    const res = await builder.send();

    expect(res.isCancelled).toBe(true);
    expect(builder.error?.cancelReason).toBe('gave up');
    expect(attempt).toBe(1);
    expect(Date.now() - start).toBeLessThan(2000);
    // Carried off the response the attempt did get, as the cancel-during-delay exit
    // carries it.
    expect(res.requestBodySettled).toBeDefined();
  });

  test('a retry-phase interceptor cancel carries the previous upload outcome', async () => {
    // The interceptor runs at the top of the next attempt, where the previous
    // attempt's response was already out of scope, so its exit carried no upload
    // outcome: an early-acked `503` whose upload the adapter tore down reported the
    // documented "the body went out in full".
    const uploadFailure = new Error('upload torn down');

    const adapter: HTTPAdapter = {
      getType: () => 'node',
      send: (_request: AdapterRequest): Promise<AdapterResponse> =>
        Promise.resolve({
          status: 503,
          headers: {},
          body: null,
          requestBodySettled: Promise.resolve(uploadFailure),
        }),
    };

    const client = new HTTPClient({ adapter });

    client.addRequestInterceptor(
      () => ({ cancel: true as const, reason: 'no more retries' }),
      { phases: ['retry'] },
    );

    const res = await client
      .put('https://example.com/upload')
      .json({ a: 1 })
      .retryPolicy({ strategy: 'fixed', maxRetryAttempts: 3, delayMS: 10 })
      .send();

    expect(res.isCancelled).toBe(true);
    expect(res.requestBodySettled).toBeDefined();
    expect(await res.requestBodySettled).toBe(uploadFailure);
  });

  test('a retry-phase interceptor throw carries the previous upload outcome', async () => {
    const uploadFailure = new Error('upload torn down');

    const adapter: HTTPAdapter = {
      getType: () => 'node',
      send: (_request: AdapterRequest): Promise<AdapterResponse> =>
        Promise.resolve({
          status: 503,
          headers: {},
          body: null,
          requestBodySettled: Promise.resolve(uploadFailure),
        }),
    };

    const client = new HTTPClient({ adapter });

    client.addRequestInterceptor(
      () => {
        throw new Error('retry interceptor failed');
      },
      { phases: ['retry'] },
    );

    const res = await client
      .put('https://example.com/upload')
      .json({ a: 1 })
      .retryPolicy({ strategy: 'fixed', maxRetryAttempts: 3, delayMS: 10 })
      .send();

    expect(res.isFailed).toBe(true);
    expect(res.requestBodySettled).toBeDefined();
    expect(await res.requestBodySettled).toBe(uploadFailure);
  });

  test('a response with no upload outcome has no requestBodySettled property at all', async () => {
    // Absence is the documented signal for "no adapter reported an upload outcome". The
    // buffered, streamed, and failure branches of `_buildResponse` assigned the field
    // unconditionally, so a bodiless `GET` carried an own property holding `undefined`:
    // `'requestBodySettled' in response` said an outcome was reported where none was.
    const adapter: HTTPAdapter = {
      getType: () => 'node',
      send: (_request: AdapterRequest): Promise<AdapterResponse> =>
        Promise.resolve({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode('{"ok":true}'),
        }),
    };

    const ok = await new HTTPClient({ adapter })
      .get('https://example.com/plain')
      .send();

    expect(ok.status).toBe(200);
    expect('requestBodySettled' in ok).toBe(false);

    const failing: HTTPAdapter = {
      getType: () => 'node',
      send: (_request: AdapterRequest): Promise<AdapterResponse> =>
        Promise.resolve({ status: 0, headers: {}, body: null }),
    };

    const failed = await new HTTPClient({ adapter: failing })
      .get('https://example.com/down')
      .send();

    expect(failed.isFailed).toBe(true);
    expect('requestBodySettled' in failed).toBe(false);
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
    expect(res.isFailed).toBe(true);
    expect(elapsed).toBeLessThan(1000);
  });
});

describe('HTTPClient — phase-aware interceptors', () => {
  test('retry-phase interceptor injects header on retries only', async () => {
    let callCount = 0;
    const sentHeaders: Array<Record<string, string | string[]>> = [];

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

  test('retry-phase interceptor context carries correct attemptNumber and consistent requestID', async () => {
    let callCount = 0;
    const adapter: HTTPAdapter = {
      getType: () => 'mock',
      send: (): Promise<AdapterResponse> => {
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

    const client = new HTTPClient({ adapter });
    const retryContexts: Array<{ attemptNumber: number; requestID: string }> =
      [];

    client.addRequestInterceptor(
      (req, _phase, context) => {
        retryContexts.push({
          attemptNumber: context.attemptNumber,
          requestID: context.requestID,
        });
        return req;
      },
      { phases: ['retry'] },
    );

    const builder = client
      .get('https://example.com/flaky')
      .retryPolicy({ strategy: 'fixed', maxRetryAttempts: 2, delayMS: 0 });

    const res = await builder.send();

    expect(retryContexts).toHaveLength(1);
    expect(retryContexts[0].attemptNumber).toBe(2); // retry is always attempt >= 2
    expect(retryContexts[0].requestID).toBe(res.requestID);
    expect(retryContexts[0].requestID).toBe(builder.requestID);
  });

  test('initial-phase interceptor context carries attemptNumber: 1 and requestID matching builder', async () => {
    const client = makeClient();
    let capturedContext: RequestInterceptorContext | undefined;

    client.addRequestInterceptor((req, _phase, context) => {
      capturedContext = context;
      return req;
    }); // default phases: ['initial']

    const builder = client.get('/api/users/1');
    await builder.send();

    expect(capturedContext?.attemptNumber).toBe(1);
    expect(capturedContext?.requestID).toBe(builder.requestID);
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

    // This test is about retry-phase interceptors, not replay safety — POST is
    // used because body rewrites are the point, so it opts in to retrying a
    // non-idempotent method.
    const client = new HTTPClient({
      adapter,
      followRedirects: true,
      retryNonIdempotentMethods: true,
    });
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

  test('retry-phase interceptor rewriting requestURL to unresolvable value gets interceptor_error', async () => {
    let adapterCalls = 0;

    const adapter: HTTPAdapter = {
      getType: () => 'mock',
      send: (_request: AdapterRequest): Promise<AdapterResponse> => {
        adapterCalls++;

        if (adapterCalls === 1) {
          return Promise.resolve({ status: 503, headers: {}, body: null });
        }

        return Promise.resolve({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode('{}'),
        });
      },
    };

    const client = new HTTPClient({
      adapter,
      retryPolicy: { strategy: 'fixed', maxRetryAttempts: 1, delayMS: 0 },
    });

    const errorCodes: string[] = [];

    client.addRequestInterceptor(
      (request, phase) =>
        phase.type === 'retry'
          ? {
              ...request,
              requestURL: '//bad-retry-rewrite.example.com/path',
            }
          : request,
      { phases: ['retry'] },
    );

    client.addErrorObserver((err) => {
      errorCodes.push(err.code);
    });

    const builder = client.get('https://example.com/users');
    const res = await builder.send();

    expect(adapterCalls).toBe(1);
    expect(res.status).toBe(0);
    expect(res.isFailed).toBe(true);
    expect(res.isNetworkError).toBe(false);
    expect(builder.state).toBe('failed');
    expect(builder.attemptCount).toBe(2);
    expect(builder.error?.code).toBe('interceptor_error');
    expect(builder.error?.cause?.message).toMatch(/could not be resolved/i);
    expect(errorCodes).toEqual(['interceptor_error']);
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
    expect(res.wasRedirectFollowed).toBe(true);
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
    const finalObserverRequestURLs: string[] = [];

    // Same pattern as retry-phase interceptor throw: settlement is `final` only.
    client.addErrorObserver((err, request) => {
      finalCodes.push(err.code);
      finalObserverRequestURLs.push(request.requestURL);
    });

    client.addRequestInterceptor(
      () => {
        throw new Error('redirect interceptor failed');
      },
      { phases: ['redirect'] },
    );

    const builder = client.get(start);
    const res = await builder.send();

    expect(res.status).toBe(0);
    expect(res.isFailed).toBe(true);
    expect(builder.error?.code).toBe('interceptor_error');
    expect(finalCodes).toEqual(['interceptor_error']);
    expect(finalObserverRequestURLs).toEqual([target]);
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
    expect(res.isFailed).toBe(true);
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

  test('redirect-phase interceptor rewriting requestURL to unresolvable value gets interceptor_error', async () => {
    let adapterCalls = 0;

    const adapter: HTTPAdapter = {
      getType: () => 'mock',
      send: (request: AdapterRequest): Promise<AdapterResponse> => {
        adapterCalls++;

        if (request.requestURL === 'https://example.com/start') {
          return Promise.resolve({
            status: 302,
            headers: { location: 'https://example.com/redirected' },
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
    const errorCodes: string[] = [];

    client.addRequestInterceptor(
      (request, phase) =>
        phase.type === 'redirect'
          ? {
              ...request,
              requestURL: '//bad-redirect-rewrite.example.com/path',
            }
          : request,
      { phases: ['redirect'] },
    );
    client.addErrorObserver((err) => {
      errorCodes.push(err.code);
    });

    const builder = client.get('https://example.com/start');
    const res = await builder.send();

    expect(adapterCalls).toBe(1);
    expect(res.status).toBe(0);
    expect(res.isFailed).toBe(true);
    expect(res.isNetworkError).toBe(false);
    expect(builder.state).toBe('failed');
    expect(builder.attemptCount).toBe(1);
    expect(builder.error?.code).toBe('interceptor_error');
    expect(builder.error?.cause?.message).toMatch(/could not be resolved/i);
    expect(errorCodes).toEqual(['interceptor_error']);
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
    const observedHeaders: Array<Record<string, string | string[]>> = [];
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

    const res = await client.get(a).send();

    expect(contexts).toHaveLength(3);
    // All phases share the same requestID
    expect(contexts[0].requestID).toBe(res.requestID);
    expect(contexts[1].requestID).toBe(res.requestID);
    expect(contexts[2].requestID).toBe(res.requestID);
    // Initial phase: attempt 1, no redirects yet
    expect(contexts[0].initialURL).toBe(a);
    expect(contexts[0].redirectHistory).toEqual([]);
    expect(contexts[0].attemptNumber).toBe(1);
    // First redirect hop: attempt 2 (continues from attempt 1)
    expect(contexts[1].initialURL).toBe(a);
    expect(contexts[1].redirectHistory).toEqual([b]);
    expect(contexts[1].attemptNumber).toBe(2);
    // Second redirect hop: attempt 3
    expect(contexts[2].initialURL).toBe(a);
    expect(contexts[2].redirectHistory).toEqual([b, c]);
    expect(contexts[2].attemptNumber).toBe(3);
  });

  test('one request can traverse initial, redirect, retry, and final phases in order', async () => {
    const start = 'https://example.com/start';
    const target = 'https://example.com/target';
    let targetCalls = 0;
    const phaseLog: string[] = [];
    const sentSnapshots: Array<{
      url: string;
      headers: Record<string, string | string[]>;
    }> = [];

    const adapter: HTTPAdapter = {
      getType: () => 'mock',
      send: (request: AdapterRequest): Promise<AdapterResponse> => {
        sentSnapshots.push({
          url: request.requestURL,
          headers: { ...request.headers },
        });

        if (request.requestURL === start) {
          return Promise.resolve({
            status: 302,
            headers: { location: target },
            body: null,
          });
        }

        if (request.requestURL === target) {
          targetCalls++;

          if (targetCalls === 1) {
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

    client.addRequestInterceptor((req, phase) => {
      phaseLog.push(`request:${phase.type}:${req.requestURL}`);
      return {
        ...req,
        headers: { ...req.headers, 'x-initial-phase': 'yes' },
      };
    });

    client.addRequestInterceptor(
      (req, phase) => {
        if (phase.type !== 'redirect') {
          throw new Error(`unexpected phase: ${phase.type}`);
        }

        phaseLog.push(`request:${phase.type}:${req.requestURL}`);
        return {
          ...req,
          headers: { ...req.headers, 'x-redirect-phase': String(phase.hop) },
        };
      },
      { phases: ['redirect'] },
    );

    client.addRequestInterceptor(
      (req, phase) => {
        if (phase.type !== 'retry') {
          throw new Error(`unexpected phase: ${phase.type}`);
        }

        phaseLog.push(
          `request:${phase.type}:${req.requestURL}:attempt:${phase.attempt}/${phase.maxAttempts}`,
        );
        return {
          ...req,
          headers: { ...req.headers, 'x-retry-phase': String(phase.attempt) },
        };
      },
      { phases: ['retry'] },
    );

    client.addResponseObserver(
      (res, _req, phase) => {
        if (phase.type !== 'redirect') {
          throw new Error(`unexpected phase: ${phase.type}`);
        }

        phaseLog.push(`response:${phase.type}:${res.status}:hop:${phase.hop}`);
      },
      { phases: ['redirect'] },
    );

    client.addResponseObserver(
      (res, _req, phase) => {
        if (phase.type !== 'retry') {
          throw new Error(`unexpected phase: ${phase.type}`);
        }

        phaseLog.push(
          `response:${phase.type}:${res.status}:attempt:${phase.attempt}/${phase.maxAttempts}`,
        );
      },
      { phases: ['retry'] },
    );

    client.addResponseObserver((res, request, phase) => {
      phaseLog.push(
        `response:${phase.type}:${res.status}:${request.requestURL}`,
      );
    });

    const res = await client
      .get(start)
      .retryPolicy({ strategy: 'fixed', maxRetryAttempts: 1, delayMS: 10 })
      .send<{ ok: boolean }>();

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.requestURL).toBe(target);
    expect(res.redirectHistory).toEqual([target]);

    expect(phaseLog).toEqual([
      `request:initial:${start}`,
      'response:redirect:302:hop:1',
      `request:redirect:${target}`,
      'response:retry:503:attempt:2/3',
      `request:retry:${target}:attempt:3/3`,
      `response:final:200:${target}`,
    ]);

    expect(sentSnapshots).toEqual([
      {
        url: start,
        headers: expect.objectContaining({
          'x-initial-phase': 'yes',
        }),
      },
      {
        url: target,
        headers: expect.objectContaining({
          'x-initial-phase': 'yes',
          'x-redirect-phase': '1',
        }),
      },
      {
        url: target,
        headers: expect.objectContaining({
          'x-initial-phase': 'yes',
          'x-redirect-phase': '1',
          'x-retry-phase': '3',
        }),
      },
    ]);
  });

  test('retry phase numbering accounts for retries spent before a redirect', async () => {
    const start = 'https://example.com/start';
    const target = 'https://example.com/target';
    let startCalls = 0;
    let targetCalls = 0;
    const phases: string[] = [];

    const adapter: HTTPAdapter = {
      getType: () => 'mock',
      send: (request: AdapterRequest): Promise<AdapterResponse> => {
        if (request.requestURL === start) {
          startCalls++;

          if (startCalls === 1) {
            return Promise.resolve({ status: 503, headers: {}, body: null });
          }

          return Promise.resolve({
            status: 302,
            headers: { location: target },
            body: null,
          });
        }

        targetCalls++;

        if (targetCalls === 1) {
          return Promise.resolve({ status: 503, headers: {}, body: null });
        }

        return Promise.resolve({ status: 200, headers: {}, body: null });
      },
    };

    const client = new HTTPClient({ adapter, followRedirects: true });

    client.addRequestInterceptor(
      (request, phase) => {
        if (phase.type === 'retry') {
          phases.push(`request:${phase.attempt}/${phase.maxAttempts}`);
        }

        return request;
      },
      { phases: ['retry'] },
    );
    client.addResponseObserver(
      (_response, _request, phase) => {
        if (phase.type === 'retry') {
          phases.push(`response:${phase.attempt}/${phase.maxAttempts}`);
        }
      },
      { phases: ['retry'] },
    );

    const response = await client
      .get(start)
      .retryPolicy({ strategy: 'fixed', maxRetryAttempts: 2, delayMS: 1 })
      .send();

    expect(response.status).toBe(200);
    expect(phases).toEqual([
      'response:1/3',
      'request:2/3',
      'response:3/4',
      'request:4/4',
    ]);
  });

  test('one request can traverse initial, redirect, retry, and final error phases in order', async () => {
    const start = 'https://example.com/start';
    const target = 'https://example.com/target';
    let targetCalls = 0;
    const phaseLog: string[] = [];
    const sentSnapshots: Array<{
      url: string;
      headers: Record<string, string | string[]>;
    }> = [];

    const adapter: HTTPAdapter = {
      getType: () => 'mock',
      send: (request: AdapterRequest): Promise<AdapterResponse> => {
        sentSnapshots.push({
          url: request.requestURL,
          headers: { ...request.headers },
        });

        if (request.requestURL === start) {
          return Promise.resolve({
            status: 302,
            headers: { location: target },
            body: null,
          });
        }

        if (request.requestURL === target) {
          targetCalls++;

          if (targetCalls <= 2) {
            throw new Error(`transient target failure ${targetCalls}`);
          }
        }

        throw new Error(`unexpected URL: ${request.requestURL}`);
      },
    };

    const client = new HTTPClient({ adapter, followRedirects: true });

    client.addRequestInterceptor((req, phase) => {
      phaseLog.push(`request:${phase.type}:${req.requestURL}`);
      return {
        ...req,
        headers: { ...req.headers, 'x-initial-phase': 'yes' },
      };
    });

    client.addRequestInterceptor(
      (req, phase) => {
        if (phase.type !== 'redirect') {
          throw new Error(`unexpected phase: ${phase.type}`);
        }

        phaseLog.push(`request:${phase.type}:${req.requestURL}`);
        return {
          ...req,
          headers: { ...req.headers, 'x-redirect-phase': String(phase.hop) },
        };
      },
      { phases: ['redirect'] },
    );

    client.addRequestInterceptor(
      (req, phase) => {
        if (phase.type !== 'retry') {
          throw new Error(`unexpected phase: ${phase.type}`);
        }

        phaseLog.push(
          `request:${phase.type}:${req.requestURL}:attempt:${phase.attempt}`,
        );
        return {
          ...req,
          headers: { ...req.headers, 'x-retry-phase': String(phase.attempt) },
        };
      },
      { phases: ['retry'] },
    );

    client.addResponseObserver(
      (res, _req, phase) => {
        if (phase.type !== 'redirect') {
          throw new Error(`unexpected phase: ${phase.type}`);
        }

        phaseLog.push(`response:${phase.type}:${res.status}:hop:${phase.hop}`);
      },
      { phases: ['redirect'] },
    );

    client.addErrorObserver(
      (err, request, phase) => {
        if (phase.type !== 'retry') {
          throw new Error(`unexpected phase: ${phase.type}`);
        }

        phaseLog.push(
          `error:${phase.type}:${err.code}:${request.requestURL}:attempt:${phase.attempt}`,
        );
      },
      { phases: ['retry'] },
    );

    client.addErrorObserver((err, request, phase) => {
      phaseLog.push(`error:${phase.type}:${err.code}:${request.requestURL}`);
    });

    const builder = client
      .get(start)
      .retryPolicy({ strategy: 'fixed', maxRetryAttempts: 1, delayMS: 10 });
    const res = await builder.send();

    expect(res.status).toBe(0);
    expect(res.isFailed).toBe(true);
    expect(res.requestURL).toBe(target);
    expect(res.redirectHistory).toEqual([target]);
    expect(builder.error?.code).toBe('adapter_error');
    expect(builder.error?.isRetriesExhausted).toBe(true);

    expect(phaseLog).toEqual([
      `request:initial:${start}`,
      'response:redirect:302:hop:1',
      `request:redirect:${target}`,
      `error:retry:adapter_error:${target}:attempt:2`,
      `request:retry:${target}:attempt:3`,
      `error:final:adapter_error:${target}`,
    ]);

    expect(sentSnapshots).toEqual([
      {
        url: start,
        headers: expect.objectContaining({
          'x-initial-phase': 'yes',
        }),
      },
      {
        url: target,
        headers: expect.objectContaining({
          'x-initial-phase': 'yes',
          'x-redirect-phase': '1',
        }),
      },
      {
        url: target,
        headers: expect.objectContaining({
          'x-initial-phase': 'yes',
          'x-redirect-phase': '1',
          'x-retry-phase': '3',
        }),
      },
    ]);
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
    expect(res.isFailed).toBe(true);
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
    expect(res.isFailed).toBe(true);
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
    expect(res.isFailed).toBe(true);
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
    expect(res.wasRedirectDetected).toBe(true);
    expect(res.wasRedirectFollowed).toBe(true);
    expect(res.isFailed).toBe(true);
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
    let capturedHeaders: Record<string, string | string[]> = {};

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
    expect(res.isFailed).toBe(true);
    expect(builder.state).toBe('failed');
    expect(builder.error?.code).toBe('network_error');
    expect(builder.error?.message).toBe('Network error');
    expect(builder.error?.cause).toBeUndefined();
    expect(errorCodes).toEqual(['network_error']);
  });

  test('adapter that marks transport error with status: 0 gets network_error code', async () => {
    const adapter: HTTPAdapter = {
      getType: () => 'mock',
      send: (_request: AdapterRequest): Promise<AdapterResponse> =>
        Promise.resolve({
          status: 0,
          isTransportError: true,
          headers: {},
          body: null,
          errorCause: new Error('socket hang up'),
        }),
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
    expect(res.isFailed).toBe(true);
    expect(builder.state).toBe('failed');
    expect(builder.error?.code).toBe('network_error');
    expect(builder.error?.message).toBe('Network error');
    expect(builder.error?.cause?.message).toBe('socket hang up');
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
    expect(res.wasRedirectDetected).toBe(true);
    expect(res.wasRedirectFollowed).toBe(true);
    expect(res.isFailed).toBe(true);
    expect(res.requestURL).toBe('https://example.com/redirected');
    expect(res.redirectHistory).toEqual(['https://example.com/redirected']);
    expect(builder.state).toBe('failed');
    expect(builder.error?.code).toBe('network_error');
    expect(builder.error?.message).toBe('Network error');
    expect(builder.error?.cause).toBeUndefined();
    expect(builder.error?.wasRedirectDetected).toBe(true);
    expect(builder.error?.wasRedirectFollowed).toBe(true);
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
    expect(res.isFailed).toBe(true);
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

  test('error observer receives the effective request timeout on setup failures', async () => {
    let wasAdapterCalled = false;
    let observedTimeout: number | undefined;

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

    client.addErrorObserver((_err, req) => {
      observedTimeout = req.timeout;
    });

    const res = await client
      .post('https://example.com/test')
      .timeout(6_789)
      .body(new URLSearchParams({ a: '1' }))
      .send();

    expect(wasAdapterCalled).toBe(false);
    expect(res.isFailed).toBe(true);
    expect(observedTimeout).toBe(6_789);
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
    expect(res.isFailed).toBe(true);
    expect(builder.state).toBe('failed');
    expect(builder.error?.code).toBe('interceptor_error');
    expect(builder.error?.cause?.message).toMatch(
      /Unsupported request body type/i,
    );
    expect(errorCodes).toEqual(['interceptor_error']);
  });

  test('non-mock protocol-relative URL without baseURL gets request_setup_error', async () => {
    let wasAdapterCalled = false;

    const adapter: HTTPAdapter = {
      getType: () => 'node',
      send: (_request: AdapterRequest): Promise<AdapterResponse> => {
        wasAdapterCalled = true;
        return Promise.resolve({ status: 200, headers: {}, body: null });
      },
    };

    const client = new HTTPClient({ adapter });
    const errorCodes: string[] = [];

    client.addErrorObserver((err) => {
      errorCodes.push(err.code);
    });

    const builder = client.get('//example.com/users');
    const res = await builder.send();

    expect(wasAdapterCalled).toBe(false);
    expect(res.status).toBe(0);
    expect(res.isFailed).toBe(true);
    expect(res.isNetworkError).toBe(false);
    expect(builder.state).toBe('failed');
    expect(builder.attemptCount).toBe(0);
    expect(builder.error?.code).toBe('request_setup_error');
    expect(builder.error?.cause?.message).toMatch(/could not be resolved/i);
    expect(errorCodes).toEqual(['request_setup_error']);
  });

  test('MockAdapter without baseURL resolves path-only requests to http://localhost', async () => {
    const adapter = new MockAdapter();
    let interceptedURL: string | undefined;

    adapter.routes.get('/users', () => ({
      status: 200,
      body: { ok: true },
    }));

    const client = new HTTPClient({ adapter });

    client.addRequestInterceptor((request) => {
      interceptedURL = request.requestURL;
      return request;
    });

    const res = await client.get('/users').send<{ ok: boolean }>();

    expect(interceptedURL).toBe('http://localhost/users');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  test('a response or error observer that throws or rejects does not reject send()', async () => {
    // Observers run through `safeHandleCallbackAndWait`, so a throw is reported and the
    // request outcome stands. Progress and attempt hooks have this integration test;
    // observers did not, and a regression here turns a 200 into a rejected `send()`.
    // The console is muted only to keep the output clean: the failures go out on the
    // global `'error'` channel, and where they land depends on what else is listening.
    muteConsoleError();
    const adapter = new MockAdapter();

    adapter.routes.get('/ok', () => ({ status: 200, body: { ok: true } }));

    const client = new HTTPClient({ adapter });
    let responseObserverCalls = 0;
    let errorObserverCalls = 0;

    client.addResponseObserver(() => {
      responseObserverCalls++;

      throw new Error('response observer boom');
    });
    client.addResponseObserver(async () => {
      responseObserverCalls++;
      await Promise.resolve();

      throw new Error('response observer rejected');
    });
    try {
      const ok = await client.get('/ok').send<{ ok: boolean }>();

      expect(ok.status).toBe(200);
      expect(ok.body).toEqual({ ok: true });
      expect(responseObserverCalls).toBe(2);

      // Error observers run on a transport failure, not on a status: an adapter that
      // rejects `send()`.
      const failing: HTTPAdapter = {
        getType: () => 'node',
        send: () => Promise.reject(new Error('socket hang up')),
      };
      const failingClient = new HTTPClient({ adapter: failing });

      failingClient.addErrorObserver(() => {
        errorObserverCalls++;

        throw new Error('error observer boom');
      });
      failingClient.addErrorObserver(async () => {
        errorObserverCalls++;
        await Promise.resolve();

        throw new Error('error observer rejected');
      });

      const broken = await failingClient
        .get('https://example.com/broken')
        .send();

      expect(broken.isFailed).toBe(true);
      expect(errorObserverCalls).toBe(2);
    } finally {
      restoreConsoleError();
    }
  });

  test('MockAdapter without baseURL resolves slashless relative requests to http://localhost', async () => {
    const adapter = new MockAdapter();
    let interceptedURL: string | undefined;

    adapter.routes.get('/users', () => ({
      status: 200,
      body: { ok: true },
    }));

    const client = new HTTPClient({ adapter });

    client.addRequestInterceptor((request) => {
      interceptedURL = request.requestURL;
      return request;
    });

    const res = await client.get('users').send<{ ok: boolean }>();

    expect(interceptedURL).toBe('http://localhost/users');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  test('MockAdapter without baseURL resolves protocol-relative request paths to http', async () => {
    const adapter = new MockAdapter();
    let wasRouteCalled = false;
    let interceptedURL: string | undefined;

    adapter.routes.get('/users', () => {
      wasRouteCalled = true;
      return { status: 200, body: { ok: true } };
    });

    const client = new HTTPClient({ adapter });
    client.addRequestInterceptor((request) => {
      interceptedURL = request.requestURL;
      return request;
    });
    const builder = client.get('//example.com/users');
    const res = await builder.send();

    expect(wasRouteCalled).toBe(true);
    expect(interceptedURL).toBe('http://example.com/users');
    expect(res.status).toBe(200);
    expect(res.isFailed).toBe(false);
    expect(builder.error).toBeNull();
  });

  test('MockAdapter without baseURL still rejects non-http absolute-like paths', async () => {
    const adapter = new MockAdapter();
    let wasRouteCalled = false;

    adapter.routes.get('/ftp://files.test/x', () => {
      wasRouteCalled = true;
      return { status: 200, body: { ok: true } };
    });

    const client = new HTTPClient({ adapter });
    const builder = client.get('ftp://files.test/x');
    const res = await builder.send();

    expect(wasRouteCalled).toBe(false);
    expect(res.status).toBe(0);
    expect(res.isFailed).toBe(true);
    expect(builder.error?.code).toBe('request_setup_error');
    expect(builder.error?.cause?.message).toMatch(/could not be resolved/i);
  });

  test('MockAdapter interceptor rejects path-only requestURL rewrites without baseURL', async () => {
    const adapter = new MockAdapter();
    let wasRouteCalled = false;

    adapter.routes.get('/rewritten', () => {
      wasRouteCalled = true;
      return {
        status: 200,
        body: { ok: true },
      };
    });

    const client = new HTTPClient({ adapter });

    client.addRequestInterceptor((request) => ({
      ...request,
      requestURL: '/rewritten',
    }));

    const builder = client.get('/users');
    const res = await builder.send();

    expect(wasRouteCalled).toBe(false);
    expect(res.status).toBe(0);
    expect(res.isFailed).toBe(true);
    expect(builder.error?.code).toBe('interceptor_error');
    expect(builder.error?.cause?.message).toMatch(
      /interceptor rewrote requestURL/i,
    );
  });

  test('MockAdapter interceptor still rejects protocol-relative rewrites without baseURL', async () => {
    const adapter = new MockAdapter();
    let wasRouteCalled = false;

    adapter.routes.get('/users', () => {
      wasRouteCalled = true;
      return {
        status: 200,
        body: { ok: true },
      };
    });

    const client = new HTTPClient({ adapter });

    client.addRequestInterceptor((request) => ({
      ...request,
      requestURL: '//bad-rewrite.example.com/path',
    }));

    const builder = client.get('/users');
    const res = await builder.send();

    expect(wasRouteCalled).toBe(false);
    expect(res.status).toBe(0);
    expect(res.isFailed).toBe(true);
    expect(builder.error?.code).toBe('interceptor_error');
  });

  test('interceptor rewriting requestURL to unresolvable value gets interceptor_error', async () => {
    let wasAdapterCalled = false;

    const adapter: HTTPAdapter = {
      getType: () => 'mock',
      send: (_request: AdapterRequest): Promise<AdapterResponse> => {
        wasAdapterCalled = true;
        return Promise.resolve({ status: 200, headers: {}, body: null });
      },
    };

    const client = new HTTPClient({ adapter });
    const errorCodes: string[] = [];

    client.addRequestInterceptor((request) => ({
      ...request,
      requestURL: '//bad-rewrite.example.com/path',
    }));
    client.addErrorObserver((err) => {
      errorCodes.push(err.code);
    });

    const builder = client.get('https://example.com/users');
    const res = await builder.send();

    expect(wasAdapterCalled).toBe(false);
    expect(res.status).toBe(0);
    expect(res.isFailed).toBe(true);
    expect(res.isNetworkError).toBe(false);
    expect(builder.state).toBe('failed');
    expect(builder.error?.code).toBe('interceptor_error');
    expect(builder.error?.cause?.message).toMatch(
      /interceptor rewrote requestURL/i,
    );
    expect(errorCodes).toEqual(['interceptor_error']);
  });

  test('interceptor rewriting requestURL to uppercase-scheme absolute URL remains valid', async () => {
    const adapter = new MockAdapter();
    adapter.routes.get('/users', () => ({
      status: 200,
      body: { ok: true },
    }));

    const client = new HTTPClient({ adapter });

    client.addRequestInterceptor((request) => ({
      ...request,
      requestURL: 'HTTPS://example.com/users',
    }));

    const builder = client.get('https://example.com/original');
    const res = await builder.send<{ ok: boolean }>();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(builder.error).toBeNull();
  });
});
describe('observational callbacks never change the outcome', () => {
  // The rule, in one place. `onUploadProgress`, `onDownloadProgress`, `onAttemptStart` and
  // `onAttemptEnd` exist to *describe* a request, so a bug in one must not be able to
  // decide whether that request succeeded. Two of them could: called bare, a throw from
  // `onAttemptStart`/`onAttemptEnd` escaped into the attempt loop and came back as
  // `status: 0`, and a throwing progress callback was classified as `isNetworkError`. A
  // caller's telemetry bug was reported to them as a network problem, which is worse than
  // silence - silence leaves you looking at your own code.
  //
  // Rejections are covered as well as throws: an `async` hook that rejects slips past any
  // local `try`/`catch`, which is why these go through `safeHandleCallback` rather than a
  // hand-rolled guard.
  const hooks = [
    'onUploadProgress',
    'onDownloadProgress',
    'onAttemptStart',
    'onAttemptEnd',
  ] as const;

  const failures = [
    [
      'throws',
      () => {
        throw new Error('telemetry bug');
      },
    ],
    ['rejects', () => Promise.reject(new Error('telemetry bug'))],
  ] as const;

  for (const hook of hooks) {
    for (const [how, misbehave] of failures) {
      test(`a ${hook} that ${how} leaves the response untouched`, async () => {
        const adapter = new MockAdapter();

        adapter.routes.get('/x', () => ({ status: 200, body: { ok: true } }));

        const client = new HTTPClient({
          adapter,
          baseURL: 'https://x.test',
        });

        const builder = client.get('/x');

        (builder as unknown as Record<string, (fn: unknown) => unknown>)[hook](
          misbehave,
        );

        const response = await builder.send();

        expect(response.status).toBe(200);
        expect(response.isNetworkError).toBe(false);
      });
    }
  }
});

test('303 redirect preserves HEAD', async () => {
  const methods: string[] = [];
  const adapter: HTTPAdapter = {
    getType: () => 'node',
    send: (request): Promise<AdapterResponse> => {
      methods.push(request.method);
      return Promise.resolve<AdapterResponse>(
        methods.length === 1
          ? { status: 303, headers: { location: '/done' }, body: null }
          : { status: 200, headers: {}, body: null },
      );
    },
  };
  const response = await new HTTPClient({
    adapter,
    baseURL: 'http://example.test',
    followRedirects: true,
  })
    .head('/start')
    .send();
  expect(response.status).toBe(200);
  expect(methods).toEqual(['HEAD', 'HEAD']);
});

test('retry interceptor destinations are caller-authorized but redirect destinations remain guarded', async () => {
  const requests: AdapterRequest[] = [];
  const adapter: HTTPAdapter = {
    getType: () => 'node',
    send: (request): Promise<AdapterResponse> => {
      requests.push(request);
      if (requests.length === 1) {
        return Promise.resolve({ status: 503, headers: {}, body: null });
      }
      if (requests.length === 2 || requests.length === 3) {
        return Promise.resolve({
          status: 302,
          headers: {
            location:
              requests.length === 2
                ? 'https://retry.example/next'
                : 'https://redirect.example/',
          },
          body: null,
        });
      }
      return Promise.resolve({ status: 200, headers: {}, body: null });
    },
  };
  const client = new HTTPClient({ adapter, followRedirects: true });
  client.addRequestInterceptor(
    (request) => ({ ...request, requestURL: 'https://retry.example/' }),
    { phases: ['retry'] },
  );
  const response = await client
    .get('https://original.example/')
    .retryPolicy({ strategy: 'fixed', maxRetryAttempts: 1, delayMS: 1 })
    .send();
  expect(response.status).toBe(200);
  expect(requests[1].initialURL).toBe('https://retry.example/');
  expect(requests[2].requestURL).toBe('https://retry.example/next');
  expect(requests[2].initialURL).toBe('https://retry.example/');
  expect(requests[3].requestURL).toBe('https://redirect.example/');
  expect(requests[3].initialURL).toBe('https://retry.example/');
});

test.each(['query', 'path', 'fragment', 'origin'] as const)(
  'a %s rewrite on a redirected retry only authorizes a new origin when explicitly changed',
  async (rewrite) => {
    const requests: AdapterRequest[] = [];
    const adapter: HTTPAdapter = {
      getType: () => 'node',
      send: (request): Promise<AdapterResponse> => {
        requests.push(request);
        if (requests.length === 1) {
          return Promise.resolve({
            status: 302,
            headers: { location: 'https://attacker.example/resource' },
            body: null,
          });
        }
        return Promise.resolve({
          status: requests.length === 2 ? 503 : 200,
          headers: {},
          body: null,
        });
      },
    };
    const client = new HTTPClient({ adapter, followRedirects: true });
    client.addRequestInterceptor(
      (request) => {
        const url = new URL(request.requestURL);
        if (rewrite === 'query') {
          url.searchParams.set('retry', '2');
        } else if (rewrite === 'path') {
          url.pathname = '/retry';
        } else if (rewrite === 'fragment') {
          url.hash = 'retry';
        } else {
          url.hostname = 'caller-selected.example';
        }
        return { ...request, requestURL: url.href };
      },
      { phases: ['retry'] },
    );
    const response = await client
      .get('https://original.example/')
      .retryPolicy({ strategy: 'fixed', maxRetryAttempts: 1, delayMS: 1 })
      .send();
    expect(response.status).toBe(200);
    expect(requests).toHaveLength(3);
    expect(requests[1].initialURL).toBe('https://original.example/');
    expect(requests[2].requestURL).not.toBe(requests[1].requestURL);
    expect(requests[2].initialURL).toBe(
      rewrite === 'origin'
        ? 'https://caller-selected.example/resource'
        : 'https://original.example/',
    );
  },
);
