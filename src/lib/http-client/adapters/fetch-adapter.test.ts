import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test';
import { FetchAdapter } from './fetch-adapter';
import { HTTPClient } from '../http-client';
import { startTestServer, type TestServer } from '../test-helpers/test-server';
import { RESPONSE_STREAM_ABORT_FLAG } from '../consts';

let server: TestServer;
const decoder = new TextDecoder();
const originalFetch = globalThis.fetch;
const originalWindow = (globalThis as any).window;
const originalDocument = (globalThis as any).document;
const originalSelf = (globalThis as any).self;
const originalWorkerGlobalScope = (globalThis as any).WorkerGlobalScope;

afterEach(() => {
  (globalThis as any).fetch = originalFetch;

  if (originalWindow === undefined) {
    delete (globalThis as any).window;
  } else {
    (globalThis as any).window = originalWindow;
  }

  if (originalDocument === undefined) {
    delete (globalThis as any).document;
  } else {
    (globalThis as any).document = originalDocument;
  }

  if (originalSelf === undefined) {
    delete (globalThis as any).self;
  } else {
    (globalThis as any).self = originalSelf;
  }

  if (originalWorkerGlobalScope === undefined) {
    delete (globalThis as any).WorkerGlobalScope;
  } else {
    (globalThis as any).WorkerGlobalScope = originalWorkerGlobalScope;
  }
});

describe('FetchAdapter', () => {
  test('getType returns fetch', () => {
    expect(new FetchAdapter().getType()).toBe('fetch');
  });

  test('passes manual redirect, null signal, and body through to fetch', async () => {
    let capturedURL = '';
    let capturedInit: RequestInit | undefined;

    (globalThis as any).fetch = (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      capturedURL =
        typeof url === 'string'
          ? url
          : url instanceof Request
            ? url.url
            : url.toString();
      capturedInit = init;
      return Promise.resolve(
        new Response('hello', {
          status: 200,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        }),
      );
    };

    const response = await new FetchAdapter().send({
      requestURL: 'https://local.test/users',
      method: 'POST',
      headers: { 'x-test': 'yes' },
      body: 'payload',
    });

    expect(response.status).toBe(200);
    expect(response.body).toBeInstanceOf(Uint8Array);
    expect(decoder.decode(response.body as Uint8Array)).toBe('hello');
    expect(capturedURL).toBe('https://local.test/users');
    expect(capturedInit?.method).toBe('POST');
    expect(capturedInit?.headers).toEqual({ 'x-test': 'yes' });
    expect(capturedInit?.body).toBe('payload');
    expect(capturedInit?.signal).toBeNull();
    expect(capturedInit?.redirect).toBe('manual');
  });

  test('materializes repeated request headers with Headers.append', async () => {
    let capturedInit: RequestInit | undefined;

    (globalThis as any).fetch = (
      _url: string | URL | Request,
      init?: RequestInit,
    ) => {
      capturedInit = init;
      return Promise.resolve(
        new Response('ok', {
          status: 200,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        }),
      );
    };

    await new FetchAdapter().send({
      requestURL: 'https://local.test/users',
      method: 'GET',
      headers: { accept: ['application/json', 'text/plain'] },
    });

    expect(capturedInit?.headers).toBeInstanceOf(Headers);
    expect((capturedInit?.headers as Headers).get('accept')).toBe(
      'application/json, text/plain',
    );
  });

  test('materializes single and repeated headers together', async () => {
    let capturedInit: RequestInit | undefined;

    (globalThis as any).fetch = (
      _url: string | URL | Request,
      init?: RequestInit,
    ) => {
      capturedInit = init;
      return Promise.resolve(
        new Response('ok', {
          status: 200,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        }),
      );
    };

    await new FetchAdapter().send({
      requestURL: 'https://local.test/users',
      method: 'GET',
      headers: {
        accept: ['application/json', 'text/plain'],
        'x-single': 'one',
      },
    });

    // One array value switches the whole set to a Headers object, so the
    // plain string values have to survive that switch too.
    const materialized = capturedInit?.headers as Headers;
    expect(materialized).toBeInstanceOf(Headers);
    expect(materialized.get('accept')).toBe('application/json, text/plain');
    expect(materialized.get('x-single')).toBe('one');
  });

  test('materializes repeated Cookie headers with cookie delimiters', async () => {
    let capturedInit: RequestInit | undefined;

    (globalThis as any).fetch = (
      _url: string | URL | Request,
      init?: RequestInit,
    ) => {
      capturedInit = init;
      return Promise.resolve(
        new Response('ok', {
          status: 200,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        }),
      );
    };

    await new FetchAdapter().send({
      requestURL: 'https://local.test/users',
      method: 'GET',
      headers: { cookie: ['session=abc123', 'theme=dark'] },
    });

    expect(capturedInit?.headers).toBeInstanceOf(Headers);
    expect((capturedInit?.headers as Headers).get('cookie')).toBe(
      'session=abc123; theme=dark',
    );
  });

  test('uses manual redirect mode for fetch requests', async () => {
    let capturedInit: RequestInit | undefined;

    (globalThis as any).fetch = (
      _url: string | URL | Request,
      init?: RequestInit,
    ) => {
      capturedInit = init;
      return Promise.resolve(
        new Response('ok', {
          status: 200,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        }),
      );
    };

    await new FetchAdapter().send({
      requestURL: 'https://local.test/users',
      method: 'GET',
      headers: {},
    });

    expect(capturedInit?.redirect).toBe('manual');
  });

  test('converts opaque redirects into status 0 responses', async () => {
    const uploadEvents: Array<{
      loaded: number;
      total: number;
      progress: number;
    }> = [];
    const downloadEvents: Array<{
      loaded: number;
      total: number;
      progress: number;
    }> = [];

    (globalThis as any).fetch = () =>
      Promise.resolve({
        status: 0,
        type: 'opaqueredirect',
        headers: new Headers(),
      } as Response);

    const response = await new FetchAdapter().send({
      requestURL: 'https://local.test/users',
      method: 'GET',
      headers: {},
      onUploadProgress: (e) => uploadEvents.push(e),
      onDownloadProgress: (e) => downloadEvents.push(e),
    });

    expect(response).toEqual({
      status: 0,
      wasRedirectDetected: true,
      headers: {},
      body: null,
    });
    expect(response.detectedRedirectURL).toBeUndefined();
    expect(uploadEvents).toEqual([
      { loaded: 0, total: 0, progress: 0 },
      { loaded: 1, total: 1, progress: 1 },
    ]);
    expect(downloadEvents).toEqual([{ loaded: 0, total: 0, progress: 1 }]);
  });

  test('delegates browser-restricted headers to fetch in browser environments', async () => {
    let isFetchCalled = false;
    let capturedInit: RequestInit | undefined;

    (globalThis as any).window = {};
    (globalThis as any).document = {};
    (globalThis as any).fetch = (
      _url: string | URL | Request,
      init?: RequestInit,
    ) => {
      isFetchCalled = true;
      capturedInit = init;
      return Promise.resolve(
        new Response('ok', {
          status: 200,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        }),
      );
    };

    const response = await new FetchAdapter().send({
      requestURL: 'https://local.test/users',
      method: 'GET',
      headers: { host: 'local.test' },
    });

    expect(isFetchCalled).toBe(true);
    expect(capturedInit?.headers).toEqual({ host: 'local.test' });
    expect(response.status).toBe(200);
  });

  test('allows safe headers in browser environments and still calls fetch', async () => {
    let isFetchCalled = false;

    (globalThis as any).window = {};
    (globalThis as any).document = {};
    (globalThis as any).fetch = () => {
      isFetchCalled = true;
      return Promise.resolve(
        new Response('ok', {
          status: 200,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        }),
      );
    };

    const response = await new FetchAdapter().send({
      requestURL: 'https://local.test/users',
      method: 'GET',
      headers: { authorization: 'Bearer token' },
    });

    expect(isFetchCalled).toBe(true);
    expect(response.status).toBe(200);
    expect(decoder.decode(response.body as Uint8Array)).toBe('ok');
  });

  test('delegates browser-restricted headers to fetch in worker-like runtimes', async () => {
    class FakeWorkerGlobalScope {}

    let isFetchCalled = false;
    let capturedInit: RequestInit | undefined;

    delete (globalThis as any).window;
    delete (globalThis as any).document;
    (globalThis as any).WorkerGlobalScope = FakeWorkerGlobalScope;
    (globalThis as any).self = Object.create(FakeWorkerGlobalScope.prototype);
    (globalThis as any).fetch = (
      _url: string | URL | Request,
      init?: RequestInit,
    ) => {
      isFetchCalled = true;
      capturedInit = init;
      return Promise.resolve(
        new Response('ok', {
          status: 200,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        }),
      );
    };

    const response = await new FetchAdapter().send({
      requestURL: 'https://local.test/users',
      method: 'GET',
      headers: { host: 'local.test' },
    });

    expect(isFetchCalled).toBe(true);
    expect(capturedInit?.headers).toEqual({ host: 'local.test' });
    expect(response.status).toBe(200);
  });

  test('converts ordinary fetch failures into status 0 responses', async () => {
    (globalThis as any).fetch = () => {
      throw new Error('fetch failed');
    };

    const response = await new FetchAdapter().send({
      requestURL: 'https://local.test/users',
      method: 'GET',
      headers: {},
    });

    expect(response).toEqual({
      status: 0,
      isTransportError: true,
      headers: {},
      body: null,
      errorCause: expect.objectContaining({ message: 'fetch failed' }),
    });
  });

  test('rethrows AbortError unchanged', () => {
    (globalThis as any).fetch = () => {
      throw new DOMException('aborted', 'AbortError');
    };

    expect(
      new FetchAdapter().send({
        requestURL: 'https://local.test/users',
        method: 'GET',
        headers: {},
      }),
    ).rejects.toThrow(/aborted/i);
  });

  test('HEAD responses skip reading the body', async () => {
    let isArrayBufferCalled = false;

    (globalThis as any).fetch = () =>
      Promise.resolve({
        status: 200,
        headers: new Headers({ 'content-type': 'text/plain' }),
        arrayBuffer: () => {
          isArrayBufferCalled = true;
          return Promise.resolve(new TextEncoder().encode('ignored').buffer);
        },
      } as Response);

    const response = await new FetchAdapter().send({
      requestURL: 'https://local.test/head',
      method: 'HEAD',
      headers: {},
    });

    expect(response.status).toBe(200);
    expect(response.body).toBeNull();
    expect(isArrayBufferCalled).toBe(false);
  });

  test('304 responses skip reading the body', async () => {
    let isArrayBufferCalled = false;

    (globalThis as any).fetch = () =>
      Promise.resolve({
        status: 304,
        headers: new Headers({ etag: 'abc123' }),
        arrayBuffer: () => {
          isArrayBufferCalled = true;
          return Promise.resolve(new ArrayBuffer(0));
        },
      } as Response);

    const response = await new FetchAdapter().send({
      requestURL: 'https://local.test/cache',
      method: 'GET',
      headers: {},
    });

    expect(response.status).toBe(304);
    expect(response.body).toBeNull();
    expect(isArrayBufferCalled).toBe(false);
  });

  test('fires progress callbacks', async () => {
    const uploadEvents: Array<{
      loaded: number;
      total: number;
      progress: number;
    }> = [];
    const downloadEvents: Array<{
      loaded: number;
      total: number;
      progress: number;
    }> = [];

    (globalThis as any).fetch = () =>
      Promise.resolve(
        new Response('hello', {
          status: 200,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        }),
      );

    await new FetchAdapter().send({
      requestURL: 'https://local.test/test',
      method: 'GET',
      headers: {},
      onUploadProgress: (e) => uploadEvents.push(e),
      onDownloadProgress: (e) => downloadEvents.push(e),
    });

    expect(uploadEvents).toEqual([
      { loaded: 0, total: 0, progress: 0 },
      { loaded: 1, total: 1, progress: 1 },
    ]);

    expect(downloadEvents).toEqual([{ loaded: 5, total: 5, progress: 1 }]);
  });

  test('server-side manual redirects expose detectedRedirectURL when Location is available', async () => {
    (globalThis as any).fetch = () =>
      Promise.resolve(
        new Response(null, {
          status: 301,
          headers: { location: 'https://other.test/next' },
        }),
      );

    const response = await new FetchAdapter().send({
      requestURL: 'https://local.test/start',
      method: 'GET',
      headers: {},
    });

    expect(response.status).toBe(301);
    expect(response.wasRedirectDetected).toBe(true);
    expect(response.detectedRedirectURL).toBe('https://other.test/next');
  });

  describe('integration requests', () => {
    let adapter: FetchAdapter;

    beforeAll(() => {
      server = startTestServer();
      adapter = new FetchAdapter();
    });

    afterAll(async () => {
      await server?.stop();
    });

    test('GET request returns status and body', async () => {
      const response = await adapter.send({
        requestURL: `${server.url}/api/users/42`,
        method: 'GET',
        headers: {},
      });

      expect(response.status).toBe(200);
      expect(response.body).toBeInstanceOf(Uint8Array);
      const body = JSON.parse(decoder.decode(response.body as Uint8Array));
      expect(body.id).toBe('42');
    });

    test('POST request sends JSON body', async () => {
      const response = await adapter.send({
        requestURL: `${server.url}/api/users`,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Alice' }),
      });

      expect(response.status).toBe(201);
      const body = JSON.parse(decoder.decode(response.body as Uint8Array));
      expect(body.data.name).toBe('Alice');
    });

    test('returns headers as lowercase keys', async () => {
      const response = await adapter.send({
        requestURL: `${server.url}/api/test`,
        method: 'GET',
        headers: {},
      });

      expect(response.headers).toBeDefined();

      for (const key of Object.keys(response.headers)) {
        expect(key).toBe(key.toLowerCase());
      }
    });

    test('404 returns correct status', async () => {
      const response = await adapter.send({
        requestURL: `${server.url}/api/nonexistent`,
        method: 'GET',
        headers: {},
      });

      expect(response.status).toBe(404);
    });

    test('plain text response body is returned as utf-8 bytes', async () => {
      const response = await adapter.send({
        requestURL: `${server.url}/api/text`,
        method: 'GET',
        headers: {},
      });

      expect(response.status).toBe(200);
      expect(response.body).toBeInstanceOf(Uint8Array);
      expect(decoder.decode(response.body as Uint8Array)).toBe('hello world');
    });

    test('204 response has null body', async () => {
      const response = await adapter.send({
        requestURL: `${server.url}/api/no-content`,
        method: 'GET',
        headers: {},
      });

      expect(response.status).toBe(204);
      expect(response.body).toBeNull();
    });

    test('does NOT throw on browser-restricted headers in non-browser (Bun/Node) environment', async () => {
      const response = await adapter.send({
        requestURL: `${server.url}/api/test`,
        method: 'GET',
        headers: {},
      });

      expect(response.status).toBe(200);
    });

    test('manual redirect — does not follow 301 automatically', async () => {
      const response = await adapter.send({
        requestURL: `${server.url}/api/redirect/301`,
        method: 'GET',
        headers: {},
      });

      expect([0, 301]).toContain(response.status);
    });

    test('server-side redirect_disabled: followRedirects false settles with redirect_disabled', async () => {
      const client = new HTTPClient({
        adapter,
        baseURL: server.url,
        followRedirects: false,
      });
      const builder = client.get('/api/redirect/301');
      const res = await builder.send();

      expect(res.status).toBe(0);
      expect(res.isFailed).toBe(true);
      expect(res.isNetworkError).toBe(false);
      expect(res.wasRedirectDetected).toBe(true);
      expect(res.wasRedirectFollowed).toBe(false);
      expect(res.detectedRedirectURL).toBe(`${server.url}/api/test`);
      expect(builder.error?.code).toBe('redirect_disabled');
      expect(builder.error?.wasRedirectDetected).toBe(true);
      expect(builder.error?.wasRedirectFollowed).toBe(false);
      expect(builder.error?.detectedRedirectURL).toBe(`${server.url}/api/test`);
    });

    test('respects AbortSignal cancellation', () => {
      const controller = new AbortController();
      controller.abort();

      expect(
        adapter.send({
          requestURL: `${server.url}/api/slow`,
          method: 'GET',
          headers: {},
          signal: controller.signal,
        }),
      ).rejects.toThrow();
    });

    test('timeout via AbortSignal causes abort', () => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 100);

      expect(
        adapter.send({
          requestURL: `${server.url}/api/slow`,
          method: 'GET',
          headers: {},
          signal: controller.signal,
        }),
      ).rejects.toThrow();
    });
  });
});

describe('FetchAdapter body-stream failures', () => {
  const adapter = new FetchAdapter();

  /**
   * Builds a stubbed fetch that resolves headers normally, then fails the body
   * read — the shape of a peer reset / premature close / short read after
   * headers have already arrived.
   */
  function stubTruncatedBody(status: number, error: unknown): void {
    (globalThis as any).fetch = () =>
      Promise.resolve({
        status,
        type: 'default',
        headers: new Headers({ 'content-type': 'application/json' }),
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- a truncated body can reject with a non-Error, which is the point of one of these cases
        arrayBuffer: () => Promise.reject(error),
      });
  }

  test('resolves with isStreamError and the real status instead of throwing', async () => {
    const cause = new Error('terminated');
    stubTruncatedBody(200, cause);

    const response = await adapter.send({
      requestURL: 'http://api.test/api/test',
      method: 'GET',
      headers: {},
    });

    // The status is the point: a transport failure would report 0 and lose the
    // fact that the server answered at all.
    expect(response.status).toBe(200);
    expect(response.isStreamError).toBe(true);
    expect(response.streamErrorCode).toBe('stream_response_error');
    expect(response.body).toBeNull();
    expect(response.errorCause).toBe(cause);
    expect(response.isTransportError).toBeUndefined();
    expect(response.headers['content-type']).toBe('application/json');
  });

  test('preserves a non-2xx status when the body is truncated', async () => {
    stubTruncatedBody(503, new Error('terminated'));

    const response = await adapter.send({
      requestURL: 'http://api.test/api/test',
      method: 'GET',
      headers: {},
    });

    expect(response.status).toBe(503);
    expect(response.isStreamError).toBe(true);
  });

  test('a truncated 3xx still reports where it was pointing', async () => {
    // Not covered by stubTruncatedBody: this one needs a Location header. The
    // headers arrived before the body failed, so the redirect target is known
    // just as well as on an intact 3xx — and a caller running with
    // followRedirects disabled reads it off the response to decide what to do.
    (globalThis as any).fetch = () =>
      Promise.resolve({
        status: 302,
        type: 'default',
        headers: new Headers({ location: '/next' }),
        arrayBuffer: () => Promise.reject(new Error('terminated')),
      });

    const response = await adapter.send({
      requestURL: 'https://local.test/start',
      method: 'GET',
      headers: {},
    });

    expect(response.status).toBe(302);
    expect(response.isStreamError).toBe(true);

    // Resolved against the request URL, exactly as the intact path resolves it.
    expect(response.wasRedirectDetected).toBe(true);
    expect(response.detectedRedirectURL).toBe('https://local.test/next');
  });

  test('wraps a non-Error rejection in an Error', async () => {
    stubTruncatedBody(200, 'socket hang up');

    const response = await adapter.send({
      requestURL: 'http://api.test/api/test',
      method: 'GET',
      headers: {},
    });

    expect(response.isStreamError).toBe(true);
    expect(response.errorCause).toBeInstanceOf(Error);
    expect(response.errorCause?.message).toBe('socket hang up');
  });

  test('re-throws a caller abort rather than reporting a stream error', () => {
    const controller = new AbortController();
    const abortError = new DOMException('Request aborted', 'AbortError');

    (globalThis as any).fetch = () =>
      Promise.resolve({
        status: 200,
        type: 'default',
        headers: new Headers(),
        arrayBuffer: () => {
          controller.abort();
          return Promise.reject(abortError);
        },
      });

    // A deliberate cancellation must stay a cancellation — marking it a stream
    // error would make it look like a network fault and hide the caller's intent.
    expect(
      adapter.send({
        requestURL: 'http://api.test/api/test',
        method: 'GET',
        headers: {},
        signal: controller.signal,
      }),
    ).rejects.toThrow('Request aborted');
  });

  test('a complete 206 Partial Content body is not a stream error', async () => {
    // Range requests are the case worth guarding: a 206 body is short by
    // design, but it arrives complete, so arrayBuffer() resolves and nothing
    // here fires. Truncation is detected only by an actual failed read — there
    // is no length heuristic that a legitimately short body could trip.
    (globalThis as any).fetch = () =>
      Promise.resolve(
        new Response('partial-bytes', {
          status: 206,
          headers: {
            'content-type': 'video/mp4',
            'content-range': 'bytes 0-12/1024',
          },
        }),
      );

    const response = await adapter.send({
      requestURL: 'http://api.test/video.mp4',
      method: 'GET',
      headers: { range: 'bytes=0-12' },
    });

    expect(response.status).toBe(206);
    expect(response.isStreamError).toBeUndefined();
    expect(response.body).not.toBeNull();
    expect(decoder.decode(response.body as Uint8Array)).toBe('partial-bytes');
  });

  test('reports a stream error in a browser environment too', async () => {
    // Headers have already arrived when the body read starts, so the status is
    // readable in a browser exactly as it is under Node/Bun. This is not a
    // server-runtime-only capability.
    (globalThis as any).window = {};
    (globalThis as any).document = {};
    stubTruncatedBody(200, new Error('network error'));

    const response = await adapter.send({
      requestURL: 'http://api.test/api/test',
      method: 'GET',
      headers: {},
    });

    expect(response.status).toBe(200);
    expect(response.isStreamError).toBe(true);
  });

  test('a stream error is terminal — HTTPClient does not retry it', async () => {
    let attempts = 0;

    (globalThis as any).fetch = () => {
      attempts++;
      return Promise.resolve({
        status: 200,
        type: 'default',
        headers: new Headers({ 'content-type': 'application/json' }),
        arrayBuffer: () => Promise.reject(new Error('terminated')),
      });
    };

    const client = new HTTPClient({
      adapter: new FetchAdapter(),
      baseURL: 'http://api.test',
      retryPolicy: { strategy: 'fixed', maxRetryAttempts: 3, delayMS: 1 },
    });

    const response = await client.get('/api/test').send();

    // Headers arrived, so the server received and processed the request.
    // Replaying it is unsafe, which is exactly what the flag is for.
    expect(attempts).toBe(1);
    expect(response.isStreamError).toBe(true);
    expect(response.status).toBe(200);
    expect(response.isFailed).toBe(true);
  });
});

describe('FetchAdapter TLS certificate failures', () => {
  test('classifies an untrusted certificate as 495 and not retryable', async () => {
    const { startTlsTestServer } =
      await import('../test-helpers/https-test-server');

    const server = await startTlsTestServer();

    try {
      // No CA configured, so the self-signed chain is rejected.
      const response = await new FetchAdapter().send({
        requestURL: `${server.url}/api/test`,
        method: 'GET',
        headers: {},
      });

      // A rejected certificate is deterministic — retrying burns attempts on a
      // failure that cannot change. Status 0 would have been retryable.
      expect(response.status).toBe(495);
      expect(response.isTransportError).toBe(true);
      expect(response.isRetryable).toBe(false);
      expect(response.errorCause).toBeInstanceOf(Error);
    } finally {
      await server.stop();
    }
  }, 30_000);
});

describe('FetchAdapter aborts while reading the body', () => {
  /** Hangs the body read, then rejects with the signal's reason verbatim. */
  function stubBodyRejectingWithReason(headers: Record<string, string> = {}) {
    (globalThis as any).fetch = (_url: string, init?: RequestInit) =>
      Promise.resolve({
        status: 200,
        type: 'default',
        headers: new Headers(headers),
        arrayBuffer: () =>
          new Promise((_resolve, reject) => {
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- rejecting with the abort reason is the behaviour under test
            const fail = () => reject(init?.signal?.reason);

            if (init?.signal?.aborted) {
              fail();
              return;
            }

            init?.signal?.addEventListener('abort', fail, { once: true });
          }),
      });
  }

  /** Resolves headers, then hangs the body read until the signal aborts. */
  function stubHangingBody(status: number, headers: Record<string, string>) {
    (globalThis as any).fetch = (_url: string, init?: RequestInit) =>
      Promise.resolve({
        status,
        type: 'default',
        headers: new Headers(headers),
        arrayBuffer: () =>
          new Promise((_resolve, reject) => {
            const fail = () => {
              reject(
                new DOMException('The operation was aborted', 'AbortError'),
              );
            };

            // An already-aborted signal never fires the event, so check first
            // or the read hangs forever.
            if (init?.signal?.aborted) {
              fail();
              return;
            }

            init?.signal?.addEventListener('abort', fail, { once: true });
          }),
      });
  }

  test('a per-attempt timeout keeps the real status and is not retried', async () => {
    let attempts = 0;

    (globalThis as any).fetch = (_url: string, init?: RequestInit) => {
      attempts++;
      return Promise.resolve({
        status: 500,
        type: 'default',
        headers: new Headers({ 'content-type': 'application/json' }),
        arrayBuffer: () =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(
                new DOMException('The operation was aborted', 'AbortError'),
              );
            });
          }),
      });
    };

    const client = new HTTPClient({
      adapter: new FetchAdapter(),
      baseURL: 'http://api.test',
      timeout: 40,
      retryPolicy: { strategy: 'fixed', maxRetryAttempts: 2, delayMS: 1 },
    });

    const response = await client.get('/slow-body').send();

    // Headers arrived, so this is a post-header failure: terminal, with the
    // real status. Rethrowing bare would report status 0 and retry it — which
    // is exactly the fetch-versus-Node divergence this adapter was fixed for.
    expect(attempts).toBe(1);
    expect(response.status).toBe(500);
    expect(response.isStreamError).toBe(true);
    expect(response.isFailed).toBe(true);
  }, 15_000);

  test('a per-attempt timeout is terminal even when the rejection is not an AbortError', async () => {
    let attempts = 0;

    (globalThis as any).fetch = (_url: string, init?: RequestInit) => {
      attempts++;
      return Promise.resolve({
        status: 503,
        type: 'default',
        headers: new Headers({ 'content-type': 'application/json' }),
        arrayBuffer: () =>
          new Promise((_resolve, reject) => {
            // undici surfaces a timeout during the body read this way: the
            // signal aborts, but what comes back is a TypeError, not an
            // AbortError. The adapter tags it all the same, and the marker —
            // not the name — is what the client routes on.
            init?.signal?.addEventListener('abort', () => {
              reject(new TypeError('terminated'));
            });
          }),
      });
    };

    const client = new HTTPClient({
      adapter: new FetchAdapter(),
      baseURL: 'http://api.test',
      timeout: 40,
      retryPolicy: { strategy: 'fixed', maxRetryAttempts: 2, delayMS: 1 },
    });

    const response = await client.get('/slow-body').send();

    // Requiring the name here dropped the tagged status and headers and let
    // the throw reach the generic network path as a retryable status 0 — so
    // the request was replayed twice against a server that had answered.
    expect(attempts).toBe(1);
    expect(response.status).toBe(503);
    expect(response.isStreamError).toBe(true);
    expect(response.isTimeout).toBe(true);
  }, 15_000);

  test('a string abort reason keeps the response headers and its reason', async () => {
    const { CookieJar } = await import('../cookie-jar');
    const jar = new CookieJar();
    const controller = new AbortController();

    (globalThis as any).fetch = (_url: string, init?: RequestInit) =>
      Promise.resolve({
        status: 200,
        type: 'default',
        headers: new Headers({ 'set-cookie': 'session=abc123; Path=/' }),
        arrayBuffer: () =>
          new Promise((_resolve, reject) => {
            // Per the Fetch Standard the rejection is the abort reason itself,
            // so this is a bare string rather than an AbortError.
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- rejecting with a non-Error is the behaviour under test
            const fail = () => reject(init?.signal?.reason);

            if (init?.signal?.aborted) {
              fail();
              return;
            }

            init?.signal?.addEventListener('abort', fail, { once: true });
          }),
      });

    const client = new HTTPClient({
      adapter: new FetchAdapter(),
      baseURL: 'http://api.test',
      cookieJar: jar,
    });

    const builder = client.get('/slow-body').signal(controller.signal);
    const pending = builder.send();

    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort('stop');

    const response = await pending;

    // Cancelled, with the caller's own reason preserved...
    expect(response.isCancelled).toBe(true);
    expect(builder.error?.cancelReason).toBe('stop');

    // ...and the headers still arrived, so the cookie belongs in the jar.
    expect(jar.getCookieHeaderString('http://api.test/next')).toBe(
      'session=abc123',
    );
  }, 15_000);

  test('an Error abort reason keeps the response headers too', async () => {
    const { CookieJar } = await import('../cookie-jar');
    const jar = new CookieJar();
    const controller = new AbortController();

    (globalThis as any).fetch = (_url: string, init?: RequestInit) =>
      Promise.resolve({
        status: 200,
        type: 'default',
        headers: new Headers({ 'set-cookie': 'session=abc123; Path=/' }),
        arrayBuffer: () =>
          new Promise((_resolve, reject) => {
            // An abort reason may be an Error whose name is not 'AbortError'.
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- signal.reason is untyped; this test aborts with a real Error
            const fail = () => reject(init?.signal?.reason);

            if (init?.signal?.aborted) {
              fail();
              return;
            }

            init?.signal?.addEventListener('abort', fail, { once: true });
          }),
      });

    const client = new HTTPClient({
      adapter: new FetchAdapter(),
      baseURL: 'http://api.test',
      cookieJar: jar,
    });

    const pending = client.get('/slow-body').signal(controller.signal).send();

    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort(new Error('stop'));

    const response = await pending;

    expect(response.isCancelled).toBe(true);
    expect(jar.getCookieHeaderString('http://api.test/next')).toBe(
      'session=abc123',
    );
  }, 15_000);

  test('never writes metadata onto the shared abort reason', async () => {
    const controller = new AbortController();
    const sharedReason = new Error('stop');

    stubBodyRejectingWithReason({ 'content-type': 'application/json' });

    const pending = new FetchAdapter().send({
      requestURL: 'http://api.test/slow-body',
      method: 'GET',
      headers: {},
      signal: controller.signal,
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort(sharedReason);

    await pending.catch(() => undefined);

    // A signal hands the same reason to every consumer, so tagging it in place
    // would let concurrent requests overwrite each other's response metadata.
    expect(RESPONSE_STREAM_ABORT_FLAG in sharedReason).toBe(false);
    expect('streamAbortHeaders' in sharedReason).toBe(false);
  }, 15_000);

  test('survives a frozen abort reason', async () => {
    const controller = new AbortController();

    stubBodyRejectingWithReason({ 'content-type': 'application/json' });

    const pending = new FetchAdapter().send({
      requestURL: 'http://api.test/slow-body',
      method: 'GET',
      headers: {},
      signal: controller.signal,
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort(Object.freeze(new Error('frozen')));

    // Writing to a frozen reason would throw a TypeError out of send().
    const thrown = await pending.then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe('frozen');
  }, 15_000);

  test('a caller cancellation is still a cancellation', async () => {
    const controller = new AbortController();

    stubHangingBody(200, { 'content-type': 'application/json' });

    const client = new HTTPClient({
      adapter: new FetchAdapter(),
      baseURL: 'http://api.test',
    });

    const pending = client.get('/slow-body').signal(controller.signal).send();

    // Let the body read start before cancelling, so this exercises the
    // post-header abort path rather than a pre-flight one.
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();

    const response = await pending;

    // Tagging the error must not turn a deliberate cancel into a stream error.
    expect(response.isCancelled).toBe(true);
    expect(response.isStreamError).toBe(false);
  }, 15_000);
});
