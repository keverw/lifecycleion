import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { XHRAdapter } from './xhr-adapter';

// ---------------------------------------------------------------------------
// Fake XMLHttpRequest
// ---------------------------------------------------------------------------

interface ProgressEventLike {
  loaded: number;
  total: number;
  lengthComputable: boolean;
}

class FakeXHRUpload {
  private handlers: Record<string, Array<(e: ProgressEventLike) => void>> = {};

  public addEventListener(
    type: string,
    handler: (e: ProgressEventLike) => void,
  ) {
    if (!this.handlers[type]) {
      this.handlers[type] = [];
    }
    this.handlers[type].push(handler);
  }

  public dispatch(type: string, event: ProgressEventLike) {
    for (const h of this.handlers[type] ?? []) {
      h(event);
    }
  }
}

class FakeXHR {
  public static instances: FakeXHR[] = [];

  public responseType: XMLHttpRequestResponseType =
    '' as XMLHttpRequestResponseType;
  public timeout = 0;
  public status = 0;
  public response: ArrayBuffer | null = null;
  public responseURL = '';

  public readonly upload = new FakeXHRUpload();

  // Captured call data
  public openArgs: { method: string; url: string } | null = null;
  public readonly requestHeaders: Record<string, string[]> = {};
  public sentBody: XMLHttpRequestBodyInit | null = null;
  public abortCalled = false;
  public getAllResponseHeadersResult = '';

  private handlers: Record<string, Array<(e: unknown) => void>> = {};

  constructor() {
    FakeXHR.instances.push(this);
  }

  public open(method: string, url: string) {
    this.openArgs = { method, url };
  }

  public setRequestHeader(name: string, value: string) {
    const lower = name.toLowerCase();
    if (!this.requestHeaders[lower]) {
      this.requestHeaders[lower] = [];
    }
    this.requestHeaders[lower].push(value);
  }

  public addEventListener(type: string, handler: (e: unknown) => void) {
    if (!this.handlers[type]) {
      this.handlers[type] = [];
    }
    this.handlers[type].push(handler);
  }

  public send(body?: XMLHttpRequestBodyInit | null) {
    this.sentBody = body ?? null;
  }

  public abort() {
    this.abortCalled = true;
  }

  public getAllResponseHeaders(): string {
    return this.getAllResponseHeadersResult;
  }

  // ---------------------------------------------------------------------------
  // Simulation helpers — called by tests to drive event flow
  // ---------------------------------------------------------------------------

  public simulateLoad() {
    for (const h of this.handlers['load'] ?? []) {
      h(new Event('load'));
    }
  }

  public simulateError() {
    for (const h of this.handlers['error'] ?? []) {
      h(new Event('error'));
    }
  }

  public simulateTimeout() {
    for (const h of this.handlers['timeout'] ?? []) {
      h(new Event('timeout'));
    }
  }

  public simulateAbort() {
    for (const h of this.handlers['abort'] ?? []) {
      h(new Event('abort'));
    }
  }

  public simulateUploadProgress(loaded: number, total: number) {
    this.upload.dispatch('progress', {
      loaded,
      total,
      lengthComputable: total > 0,
    });
  }

  public simulateUploadLoad() {
    this.upload.dispatch('load', {
      loaded: 0,
      total: 0,
      lengthComputable: false,
    });
  }

  public simulateDownloadProgress(loaded: number, total: number) {
    for (const h of this.handlers['progress'] ?? []) {
      h({ loaded, total, lengthComputable: total > 0 });
    }
  }
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

const originalXHR = (globalThis as Record<string, unknown>).XMLHttpRequest;

let lastXHR: FakeXHR;

beforeEach(() => {
  FakeXHR.instances = [];

  (globalThis as Record<string, unknown>).XMLHttpRequest = class extends (
    FakeXHR
  ) {
    constructor() {
      super();
      const currentXHR = FakeXHR.instances[FakeXHR.instances.length - 1];
      if (!currentXHR) {
        throw new Error('FakeXHR instance was not initialized');
      }
      lastXHR = currentXHR;
    }
  };
});

afterEach(() => {
  if (originalXHR === undefined) {
    delete (globalThis as Record<string, unknown>).XMLHttpRequest;
  } else {
    (globalThis as Record<string, unknown>).XMLHttpRequest = originalXHR;
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textBody(text: string): ArrayBuffer {
  // Explicitly copy into a fresh ArrayBuffer so instanceof ArrayBuffer is
  // reliable in Bun — TextEncoder can return a Buffer-backed Uint8Array whose
  // .buffer is the pooled SharedArrayBuffer, which would fail the check.
  const encoded = new TextEncoder().encode(text);
  const buf = new ArrayBuffer(encoded.byteLength);
  new Uint8Array(buf).set(encoded);
  return buf;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('XHRAdapter', () => {
  test('getType returns xhr', () => {
    expect(new XHRAdapter().getType()).toBe('xhr');
  });

  test('opens XHR with correct method and URL', async () => {
    const adapter = new XHRAdapter();
    const promise = adapter.send({
      requestURL: 'https://api.test/data',
      method: 'POST',
      headers: {},
      timeout: 5000,
    });

    lastXHR.status = 200;
    lastXHR.response = textBody('{}');
    lastXHR.simulateLoad();

    await promise;

    expect(lastXHR.openArgs).toEqual({
      method: 'POST',
      url: 'https://api.test/data',
    });
  });

  test('sets responseType to arraybuffer', async () => {
    const adapter = new XHRAdapter();
    const promise = adapter.send({
      requestURL: 'https://api.test/data',
      method: 'GET',
      headers: {},
      timeout: 5000,
    });

    lastXHR.status = 200;
    lastXHR.response = textBody('ok');
    lastXHR.simulateLoad();

    await promise;

    expect(lastXHR.responseType).toBe('arraybuffer');
  });

  test('sets timeout on XHR', async () => {
    const adapter = new XHRAdapter();
    const promise = adapter.send({
      requestURL: 'https://api.test/data',
      method: 'GET',
      headers: {},
      timeout: 12_000,
    });

    lastXHR.status = 200;
    lastXHR.response = textBody('ok');
    lastXHR.simulateLoad();

    await promise;

    expect(lastXHR.timeout).toBe(12_000);
  });

  test('sets scalar request headers', async () => {
    const adapter = new XHRAdapter();
    const promise = adapter.send({
      requestURL: 'https://api.test/data',
      method: 'GET',
      headers: { authorization: 'Bearer token', 'x-custom': 'value' },
      timeout: 5000,
    });

    lastXHR.status = 200;
    lastXHR.response = textBody('ok');
    lastXHR.simulateLoad();

    await promise;

    expect(lastXHR.requestHeaders['authorization']).toEqual(['Bearer token']);
    expect(lastXHR.requestHeaders['x-custom']).toEqual(['value']);
  });

  test('materializes array headers with multiple setRequestHeader calls', async () => {
    const adapter = new XHRAdapter();
    const promise = adapter.send({
      requestURL: 'https://api.test/data',
      method: 'GET',
      headers: { accept: ['application/json', 'text/plain'] },
      timeout: 5000,
    });

    lastXHR.status = 200;
    lastXHR.response = textBody('ok');
    lastXHR.simulateLoad();

    await promise;

    // XHR combines multiple calls for the same key with ", "
    expect(lastXHR.requestHeaders['accept']).toEqual([
      'application/json',
      'text/plain',
    ]);
  });

  test('returns status and body on successful load', async () => {
    const adapter = new XHRAdapter();
    const promise = adapter.send({
      requestURL: 'https://api.test/data',
      method: 'GET',
      headers: {},
      timeout: 5000,
    });

    lastXHR.status = 200;
    lastXHR.response = textBody('hello world');
    lastXHR.simulateLoad();

    const response = await promise;

    expect(response.status).toBe(200);
    expect(response.body).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(response.body as Uint8Array)).toBe(
      'hello world',
    );
  });

  test('parses response headers as lowercase keys', async () => {
    const adapter = new XHRAdapter();
    const promise = adapter.send({
      requestURL: 'https://api.test/data',
      method: 'GET',
      headers: {},
      timeout: 5000,
    });

    lastXHR.status = 200;
    lastXHR.response = textBody('{}');
    lastXHR.getAllResponseHeadersResult =
      'Content-Type: application/json\r\nX-Custom: value\r\n';
    lastXHR.simulateLoad();

    const response = await promise;

    expect(response.headers['content-type']).toBe('application/json');
    expect(response.headers['x-custom']).toBe('value');
    // No uppercase keys
    for (const key of Object.keys(response.headers)) {
      expect(key).toBe(key.toLowerCase());
    }
  });

  test('collects set-cookie headers as string[]', async () => {
    const adapter = new XHRAdapter();
    const promise = adapter.send({
      requestURL: 'https://api.test/data',
      method: 'GET',
      headers: {},
      timeout: 5000,
    });

    lastXHR.status = 200;
    lastXHR.response = textBody('ok');
    lastXHR.getAllResponseHeadersResult =
      'set-cookie: session=abc\r\nset-cookie: theme=dark\r\n';
    lastXHR.simulateLoad();

    const response = await promise;

    expect(response.headers['set-cookie']).toEqual([
      'session=abc',
      'theme=dark',
    ]);
  });

  test('returns null body for HEAD requests', async () => {
    const adapter = new XHRAdapter();
    const promise = adapter.send({
      requestURL: 'https://api.test/data',
      method: 'HEAD',
      headers: {},
      timeout: 5000,
    });

    lastXHR.status = 200;
    lastXHR.response = textBody('ignored');
    lastXHR.simulateLoad();

    const response = await promise;

    expect(response.body).toBeNull();
  });

  test('returns null body for 204 responses', async () => {
    const adapter = new XHRAdapter();
    const promise = adapter.send({
      requestURL: 'https://api.test/data',
      method: 'DELETE',
      headers: {},
      timeout: 5000,
    });

    lastXHR.status = 204;
    lastXHR.simulateLoad();

    const response = await promise;

    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
  });

  test('returns null body for 304 responses', async () => {
    const adapter = new XHRAdapter();
    const promise = adapter.send({
      requestURL: 'https://api.test/data',
      method: 'GET',
      headers: {},
      timeout: 5000,
    });

    lastXHR.status = 304;
    lastXHR.simulateLoad();

    const response = await promise;

    expect(response.status).toBe(304);
    expect(response.body).toBeNull();
  });

  test('returns null body when xhr.response is null for a non-empty status', async () => {
    // Covers the readResponseBody fallback: method is not HEAD, status is not
    // 204/304, but response is null (e.g. browser populated no body).
    const adapter = new XHRAdapter();
    const promise = adapter.send({
      requestURL: 'https://api.test/data',
      method: 'GET',
      headers: {},
      timeout: 5000,
    });

    lastXHR.status = 200;
    // Intentionally leave lastXHR.response as null
    lastXHR.simulateLoad();

    const response = await promise;
    expect(response.body).toBeNull();
  });

  test('returns status 0 transport error on network failure', async () => {
    const adapter = new XHRAdapter();
    const promise = adapter.send({
      requestURL: 'https://api.test/data',
      method: 'GET',
      headers: {},
      timeout: 5000,
    });

    lastXHR.simulateError();

    const response = await promise;

    expect(response.status).toBe(0);
    expect(response.isTransportError).toBe(true);
    expect(response.headers).toEqual({});
    expect(response.body).toBeNull();
    expect(response.errorCause).toBeInstanceOf(Error);
  });

  test('rejects with AbortError on timeout', () => {
    const adapter = new XHRAdapter();
    const promise = adapter.send({
      requestURL: 'https://api.test/data',
      method: 'GET',
      headers: {},
      timeout: 100,
    });

    lastXHR.simulateTimeout();

    return expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('rejects with AbortError on XHR abort event', () => {
    const adapter = new XHRAdapter();
    const promise = adapter.send({
      requestURL: 'https://api.test/data',
      method: 'GET',
      headers: {},
      timeout: 5000,
    });

    lastXHR.simulateAbort();

    return expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('calls xhr.abort() when AbortSignal fires', () => {
    const controller = new AbortController();

    const adapter = new XHRAdapter();
    const promise = adapter.send({
      requestURL: 'https://api.test/data',
      method: 'GET',
      headers: {},
      timeout: 5000,
      signal: controller.signal,
    });

    controller.abort();
    lastXHR.simulateAbort(); // XHR fires abort event after xhr.abort() is called

    expect(lastXHR.abortCalled).toBe(true);
    return expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('rejects immediately when AbortSignal is already aborted', () => {
    const controller = new AbortController();
    controller.abort();

    const adapter = new XHRAdapter();
    const promise = adapter.send({
      requestURL: 'https://api.test/data',
      method: 'GET',
      headers: {},
      timeout: 5000,
      signal: controller.signal,
    });

    return expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('sends string body', async () => {
    const adapter = new XHRAdapter();
    const promise = adapter.send({
      requestURL: 'https://api.test/data',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"name":"Alice"}',
      timeout: 5000,
    });

    lastXHR.status = 201;
    lastXHR.response = textBody('{}');
    lastXHR.simulateLoad();

    await promise;

    expect(lastXHR.sentBody).toBe('{"name":"Alice"}');
  });

  test('sends null body when body is omitted', async () => {
    const adapter = new XHRAdapter();
    const promise = adapter.send({
      requestURL: 'https://api.test/data',
      method: 'GET',
      headers: {},
      timeout: 5000,
    });

    lastXHR.status = 200;
    lastXHR.response = textBody('ok');
    lastXHR.simulateLoad();

    await promise;

    expect(lastXHR.sentBody).toBeNull();
  });

  test('sends null body when body is explicitly null', async () => {
    const adapter = new XHRAdapter();
    const promise = adapter.send({
      requestURL: 'https://api.test/data',
      method: 'POST',
      headers: {},
      body: null,
      timeout: 5000,
    });

    lastXHR.status = 200;
    lastXHR.response = textBody('ok');
    lastXHR.simulateLoad();

    await promise;

    expect(lastXHR.sentBody).toBeNull();
  });

  test('sends Uint8Array body', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const adapter = new XHRAdapter();
    const promise = adapter.send({
      requestURL: 'https://api.test/upload',
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: bytes,
      timeout: 5000,
    });

    lastXHR.status = 200;
    lastXHR.response = textBody('ok');
    lastXHR.simulateLoad();

    await promise;

    expect(lastXHR.sentBody).toBe(bytes);
  });

  test('fires 0% upload progress before send, then 100% on upload load', async () => {
    const uploadEvents: Array<{
      loaded: number;
      total: number;
      progress: number;
    }> = [];

    const adapter = new XHRAdapter();
    const promise = adapter.send({
      requestURL: 'https://api.test/data',
      method: 'POST',
      headers: {},
      body: 'payload',
      timeout: 5000,
      onUploadProgress: (e) => uploadEvents.push(e),
    });

    lastXHR.simulateUploadLoad(); // upload complete
    lastXHR.status = 200;
    lastXHR.response = textBody('ok');
    lastXHR.simulateLoad();

    await promise;

    expect(uploadEvents[0]).toEqual({ loaded: 0, total: 0, progress: 0 });
    expect(uploadEvents[uploadEvents.length - 1]).toEqual({
      loaded: 1,
      total: 1,
      progress: 1,
    });
  });

  test('fires intermediate upload progress events', async () => {
    const uploadEvents: Array<{
      loaded: number;
      total: number;
      progress: number;
    }> = [];

    const adapter = new XHRAdapter();
    const promise = adapter.send({
      requestURL: 'https://api.test/upload',
      method: 'POST',
      headers: {},
      body: 'data',
      timeout: 5000,
      onUploadProgress: (e) => uploadEvents.push(e),
    });

    lastXHR.simulateUploadProgress(500, 1000);
    lastXHR.simulateUploadProgress(1000, 1000);
    lastXHR.simulateUploadLoad();

    lastXHR.status = 200;
    lastXHR.response = textBody('ok');
    lastXHR.simulateLoad();

    await promise;

    // Event order: 0% (pre-send) → 50% → 100% (from progress event, not upload load)
    expect(uploadEvents.length).toBe(3);
    expect(uploadEvents[0]).toEqual({ loaded: 0, total: 0, progress: 0 });
    expect(uploadEvents[1]).toEqual({
      loaded: 500,
      total: 1000,
      progress: 0.5,
    });
    expect(uploadEvents[2]).toEqual({ loaded: 1000, total: 1000, progress: 1 });
  });

  test('upload fallback reports 0/0 for requests with no body', async () => {
    const uploadEvents: Array<{
      loaded: number;
      total: number;
      progress: number;
    }> = [];

    const adapter = new XHRAdapter();
    const promise = adapter.send({
      requestURL: 'https://api.test/data',
      method: 'GET',
      headers: {},
      timeout: 5000,
      onUploadProgress: (e) => uploadEvents.push(e),
    });

    lastXHR.status = 200;
    lastXHR.response = textBody('ok');
    lastXHR.simulateLoad();

    await promise;

    expect(uploadEvents).toEqual([
      { loaded: 0, total: 0, progress: 0 },
      { loaded: 0, total: 0, progress: 1 },
    ]);
  });

  test('fires 100% download progress on load', async () => {
    const downloadEvents: Array<{
      loaded: number;
      total: number;
      progress: number;
    }> = [];

    const adapter = new XHRAdapter();
    const promise = adapter.send({
      requestURL: 'https://api.test/data',
      method: 'GET',
      headers: {},
      timeout: 5000,
      onDownloadProgress: (e) => downloadEvents.push(e),
    });

    lastXHR.status = 200;
    lastXHR.response = textBody('hello');
    lastXHR.simulateLoad();

    await promise;

    const last = downloadEvents[downloadEvents.length - 1];
    expect(last.progress).toBe(1);
    expect(last.loaded).toBe(5); // 'hello' is 5 bytes
    expect(last.total).toBe(5);
  });

  test('deduplicates download 100%: progress event at 100% prevents duplicate from load', async () => {
    const events: number[] = [];
    const adapter = new XHRAdapter();
    const promise = adapter.send({
      requestURL: 'https://api.test/data',
      method: 'GET',
      headers: {},
      timeout: 5000,
      onDownloadProgress: (e) => events.push(e.progress),
    });

    lastXHR.simulateDownloadProgress(1024, 1024); // fires exactly 100%
    lastXHR.status = 200;
    lastXHR.response = textBody('ok');
    lastXHR.simulateLoad();

    await promise;

    // load handler sees didFireDownload100 = true and skips — exactly one 100%
    expect(events).toEqual([1]);
  });

  test('fires intermediate download progress events', async () => {
    const downloadEvents: Array<{
      loaded: number;
      total: number;
      progress: number;
    }> = [];

    const adapter = new XHRAdapter();
    const promise = adapter.send({
      requestURL: 'https://api.test/data',
      method: 'GET',
      headers: {},
      timeout: 5000,
      onDownloadProgress: (e) => downloadEvents.push(e),
    });

    lastXHR.simulateDownloadProgress(256, 1024);
    lastXHR.simulateDownloadProgress(512, 1024);

    lastXHR.status = 200;
    lastXHR.response = textBody('ok');
    lastXHR.simulateLoad();

    await promise;

    // Event order: 25% → 50% from progress events, then 100% from load handler
    expect(downloadEvents.length).toBe(3);
    expect(downloadEvents[0]).toEqual({
      loaded: 256,
      total: 1024,
      progress: 0.25,
    });
    expect(downloadEvents[1]).toEqual({
      loaded: 512,
      total: 1024,
      progress: 0.5,
    });
    expect(downloadEvents[2]).toEqual({ loaded: 2, total: 2, progress: 1 }); // 'ok' is 2 bytes
  });

  test('download progress reports -1 when length is not computable', async () => {
    const downloadEvents: Array<{
      loaded: number;
      total: number;
      progress: number;
    }> = [];

    const adapter = new XHRAdapter();
    const promise = adapter.send({
      requestURL: 'https://api.test/data',
      method: 'GET',
      headers: {},
      timeout: 5000,
      onDownloadProgress: (e) => downloadEvents.push(e),
    });

    // total=0 → FakeXHR sets lengthComputable:false → adapter reports progress:-1
    lastXHR.simulateDownloadProgress(100, 0);

    lastXHR.status = 200;
    lastXHR.response = textBody('ok');
    lastXHR.simulateLoad();

    await promise;

    expect(downloadEvents[0]).toEqual({ loaded: 100, total: 0, progress: -1 });
  });

  test('preserves 4xx/5xx status codes', async () => {
    const adapter = new XHRAdapter();
    const promise = adapter.send({
      requestURL: 'https://api.test/data',
      method: 'GET',
      headers: {},
      timeout: 5000,
    });

    lastXHR.status = 404;
    lastXHR.response = textBody('not found');
    lastXHR.simulateLoad();

    const response = await promise;

    expect(response.status).toBe(404);
    expect(response.isTransportError).toBeUndefined();
  });

  test('sets wasRedirectDetected and wasRedirectFollowed when responseURL differs', async () => {
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
    const adapter = new XHRAdapter();
    const promise = adapter.send({
      requestURL: 'https://api.test/original',
      method: 'GET',
      headers: {},
      timeout: 5000,
      onUploadProgress: (e) => uploadEvents.push(e),
      onDownloadProgress: (e) => downloadEvents.push(e),
    });

    lastXHR.status = 200;
    lastXHR.response = textBody('ok');
    // Simulate a browser-followed redirect to a different URL
    lastXHR.responseURL = 'https://api.test/redirected';
    lastXHR.simulateLoad();

    const response = await promise;

    expect(response).toEqual({
      status: 0,
      wasRedirectDetected: true,
      detectedRedirectURL: 'https://api.test/redirected',
      headers: {},
      body: null,
    });
    expect(uploadEvents).toEqual([
      { loaded: 0, total: 0, progress: 0 },
      { loaded: 0, total: 0, progress: 1 },
    ]);
    expect(downloadEvents).toEqual([{ loaded: 0, total: 0, progress: 1 }]);
  });

  test('does not set wasRedirectDetected when responseURL matches request URL', async () => {
    const adapter = new XHRAdapter();
    const promise = adapter.send({
      requestURL: 'https://api.test/data',
      method: 'GET',
      headers: {},
      timeout: 5000,
    });

    lastXHR.status = 200;
    lastXHR.response = textBody('ok');
    lastXHR.responseURL = 'https://api.test/data'; // same URL — no redirect
    lastXHR.simulateLoad();

    const response = await promise;

    expect(response.wasRedirectDetected).toBeUndefined();
    expect(response.status).toBe(200);
  });

  test('does not treat fragment-only URL differences as redirect', async () => {
    const adapter = new XHRAdapter();
    const promise = adapter.send({
      requestURL: 'https://api.test/data#client-fragment',
      method: 'GET',
      headers: {},
      timeout: 5000,
    });

    lastXHR.status = 200;
    lastXHR.response = textBody('ok');
    // Browsers do not include fragments in HTTP requests, so this should not be
    // interpreted as a redirect.
    lastXHR.responseURL = 'https://api.test/data';
    lastXHR.simulateLoad();

    const response = await promise;

    expect(response.wasRedirectDetected).toBeUndefined();
    expect(response.status).toBe(200);
  });

  test('resolves relative request URLs against document.baseURI for redirect detection', async () => {
    const originalWindow = (globalThis as Record<string, unknown>).window;
    const originalDocument = (globalThis as Record<string, unknown>).document;

    (globalThis as Record<string, unknown>).window = {
      location: { href: 'https://app.test/shell/index.html' },
    };
    (globalThis as Record<string, unknown>).document = {
      baseURI: 'https://cdn.test/base/',
    };

    try {
      const adapter = new XHRAdapter();
      const promise = adapter.send({
        requestURL: '/api/data',
        method: 'GET',
        headers: {},
        timeout: 5000,
      });

      lastXHR.status = 200;
      lastXHR.response = textBody('ok');
      lastXHR.responseURL = 'https://cdn.test/api/data';
      lastXHR.simulateLoad();

      const response = await promise;

      expect(response.wasRedirectDetected).toBeUndefined();
      expect(response.status).toBe(200);
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

  test('returns empty headers object when getAllResponseHeaders returns empty string', async () => {
    const adapter = new XHRAdapter();
    const promise = adapter.send({
      requestURL: 'https://api.test/data',
      method: 'GET',
      headers: {},
      timeout: 5000,
    });

    lastXHR.status = 200;
    lastXHR.response = textBody('ok');
    lastXHR.getAllResponseHeadersResult = '';
    lastXHR.simulateLoad();

    const response = await promise;

    expect(response.headers).toEqual({});
  });
});
