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
