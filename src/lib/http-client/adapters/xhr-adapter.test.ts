import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import vm from 'node:vm';
import { XHRAdapter } from './xhr-adapter';
import type { AdapterRequest } from '../types';
import { materializeRequestHeaders } from '../internal/header-utils';
import {
  NON_RETRYABLE_HTTP_ADAPTER_ERROR_FLAG,
  RESPONSE_STREAM_ABORT_FLAG,
  STREAM_ABORT_STATUS_KEY,
  XHR_BROWSER_TIMEOUT_FLAG,
} from '../consts';
import { HTTPClient } from '../http-client';
import { errorText } from '../test-helpers/error-text';

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

  public responseType: XMLHttpRequestResponseType = '';
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
  public readyState = 0;
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

  public getResponseHeader(name: string): string | null {
    for (const line of this.getAllResponseHeadersResult.split('\r\n')) {
      const colon = line.indexOf(':');
      if (colon > 0 && line.slice(0, colon).trim().toLowerCase() === name) {
        return line.slice(colon + 1).trim();
      }
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Simulation helpers — called by tests to drive event flow
  // ---------------------------------------------------------------------------

  public simulateLoad() {
    for (const h of this.handlers['load'] ?? []) {
      h(new Event('load'));
    }
  }

  public simulateLoadEnd() {
    for (const h of this.handlers['loadend'] ?? []) {
      h(new Event('loadend'));
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

/** Runs `fn` with the global `key` set to `value`, and restores it after. */
async function withGlobal<T>(
  key: string,
  value: unknown,
  fn: () => Promise<T>,
): Promise<T> {
  const scope = globalThis as Record<string, unknown>;
  const didHaveKey = Object.hasOwn(scope, key);
  const originalValue = scope[key];
  scope[key] = value;

  try {
    return await fn();
  } finally {
    if (didHaveKey) {
      scope[key] = originalValue;
    } else {
      delete scope[key];
    }
  }
}

/**
 * Runs `fn` with `globalThis.origin` set to `origin`, as a page's or worker's is, and
 * restores it after.
 */
async function withPageOrigin<T>(
  origin: string,
  fn: () => Promise<T>,
): Promise<T> {
  return await withGlobal('origin', origin, fn);
}

/**
 * Sends a `GET` under a 1,000-byte limit, reports 1,001 bytes of a body with no
 * `Content-Encoding`, then loads 1,000 - whether the adapter stopped it on the way in
 * shows in `abortCalled`.
 */
async function sendPastLimitWithoutCoding(
  requestURL: string,
  responseURL = '',
): Promise<{ abortCalled: boolean; streamErrorCode: string | undefined }> {
  const promise = new XHRAdapter().send({
    requestURL,
    method: 'GET',
    headers: {},
    maxResponseBytes: 1000,
  });

  const xhr = lastXHR;
  xhr.readyState = 3;
  xhr.status = 200;
  xhr.responseURL = responseURL;
  xhr.getAllResponseHeadersResult = 'content-type: text/plain\r\n';
  xhr.simulateDownloadProgress(1001, 0);
  xhr.response = textBody('x'.repeat(1000));
  xhr.simulateLoad();
  const response = await promise;

  return {
    abortCalled: xhr.abortCalled,
    streamErrorCode: response.streamErrorCode,
  };
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

  test('withholds URL userinfo on a cross-origin hop', async () => {
    const promise = new XHRAdapter().send({
      requestURL: 'https://user:hunter2@evil.test/collect',
      initialURL: 'https://api.example.test/start',
      method: 'GET',
      headers: {},
    });

    lastXHR.status = 204;
    lastXHR.responseURL = 'https://evil.test/collect';
    lastXHR.simulateLoad();
    const response = await promise;

    expect(lastXHR.openArgs?.url).toBe('https://evil.test/collect');
    expect(response.wasRedirectDetected).toBe(false);
  });

  test('keeps URL userinfo when the initial and request origins match', async () => {
    const promise = new XHRAdapter().send({
      requestURL: 'https://user:hunter2@api.example.test/next',
      initialURL: 'https://api.example.test/start',
      method: 'GET',
      headers: {},
    });

    lastXHR.status = 204;
    lastXHR.responseURL = 'https://api.example.test/next';
    lastXHR.simulateLoad();
    const response = await promise;

    expect(response.status).toBe(204);
    expect(response.wasRedirectDetected).toBe(false);

    expect(lastXHR.openArgs?.url).toBe(
      'https://user:hunter2@api.example.test/next',
    );
  });

  test('withholds userinfo from a protocol-relative cross-origin URL', async () => {
    const originalDocument = (globalThis as Record<string, unknown>).document;
    (globalThis as Record<string, unknown>).document = {
      baseURI: 'https://api.example.test/start',
    };

    try {
      const promise = new XHRAdapter().send({
        requestURL: '//user:hunter2@evil.test/collect',
        initialURL: 'https://api.example.test/start',
        method: 'GET',
        headers: {},
      });

      lastXHR.status = 204;
      lastXHR.responseURL = 'https://evil.test/collect';
      lastXHR.simulateLoad();
      const response = await promise;

      expect(lastXHR.openArgs?.url).toBe('https://evil.test/collect');
      expect(response.wasRedirectDetected).toBe(false);
    } finally {
      if (originalDocument === undefined) {
        delete (globalThis as Record<string, unknown>).document;
      } else {
        (globalThis as Record<string, unknown>).document = originalDocument;
      }
    }
  });

  test('sets responseType to arraybuffer', async () => {
    const adapter = new XHRAdapter();
    const promise = adapter.send({
      requestURL: 'https://api.test/data',
      method: 'GET',
      headers: {},
    });

    lastXHR.status = 200;
    lastXHR.response = textBody('ok');
    lastXHR.simulateLoad();

    await promise;

    expect(lastXHR.responseType).toBe('arraybuffer');
  });

  test('sets XHR timeout to 0 (timeout managed via abort signal)', async () => {
    const adapter = new XHRAdapter();
    const promise = adapter.send({
      requestURL: 'https://api.test/data',
      method: 'GET',
      headers: {},
    });

    lastXHR.status = 200;
    lastXHR.response = textBody('ok');
    lastXHR.simulateLoad();

    await promise;

    expect(lastXHR.timeout).toBe(0);
  });

  test('sets scalar request headers', async () => {
    const adapter = new XHRAdapter();
    const promise = adapter.send({
      requestURL: 'https://api.test/data',
      method: 'GET',
      headers: { authorization: 'Bearer token', 'x-custom': 'value' },
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

  test('round 129: joins a repeated cookie header with "; " as the other adapters do', async () => {
    const adapter = new XHRAdapter();
    const promise = adapter.send({
      requestURL: 'https://api.test/data',
      method: 'GET',
      headers: { cookie: ['a=1', 'b=2'] },
    });

    lastXHR.status = 200;
    lastXHR.response = textBody('ok');
    lastXHR.simulateLoad();

    await promise;

    expect(lastXHR.requestHeaders['cookie']).toEqual(['a=1; b=2']);
  });

  test('PR review round 2: a Cookie given under two spellings is set once, joined with "; "', async () => {
    const promise = new XHRAdapter().send({
      requestURL: 'https://api.test/data',
      method: 'GET',
      headers: { Cookie: 'a=1', cookie: ['b=2', 'c=3'] },
    });

    expect(lastXHR.requestHeaders['cookie']).toEqual(['a=1; b=2; c=3']);
    lastXHR.status = 200;
    lastXHR.response = textBody('ok');
    lastXHR.simulateLoad();
    await promise;
  });

  test('PR review round 4: an empty Cookie part is left out', async () => {
    const promise = new XHRAdapter().send({
      requestURL: 'https://api.test/data',
      method: 'GET',
      headers: { Cookie: [], cookie: 'b=2' },
    });

    expect(lastXHR.requestHeaders['cookie']).toEqual(['b=2']);
    lastXHR.status = 200;
    lastXHR.response = textBody('ok');
    lastXHR.simulateLoad();
    await promise;
  });

  test('PR review round 5: the Cookie header is the one NodeAdapter sends', async () => {
    for (const headers of [
      { Cookie: [], cookie: 'b=2' },
      { cookie: ['a=1', ''] },
      { Cookie: '', cookie: 'b=2' },
      { Cookie: 'a=1', cookie: ['b=2', 'c=3'], accept: ['x', 'y'] },
    ] as Array<Record<string, string | string[]>>) {
      const expected = Object.entries(materializeRequestHeaders(headers)).find(
        ([name]) => name.toLowerCase() === 'cookie',
      )?.[1];
      const promise = new XHRAdapter().send({
        requestURL: 'https://api.test/data',
        method: 'GET',
        headers,
      });

      expect(lastXHR.requestHeaders['cookie'] as string[] | undefined).toEqual(
        expected === undefined ? undefined : [expected],
      );
      lastXHR.status = 200;
      lastXHR.response = textBody('ok');
      lastXHR.simulateLoad();
      await promise;
    }
  });

  test('PR review round 10: a 205 is bodiless, as in the other adapters', async () => {
    const promise = new XHRAdapter().send({
      requestURL: 'https://api.test/reset',
      method: 'POST',
      headers: {},
      maxResponseBytes: 1,
    });

    lastXHR.status = 205;
    lastXHR.response = textBody('stray');
    lastXHR.simulateLoad();
    const response = await promise;

    expect(response.body).toBeNull();
    expect(response.streamErrorCode).toBeUndefined();
  });

  test('PR review round 10: the final upload event is sent before an oversized answer is refused', async () => {
    const uploads: number[] = [];
    const promise = new XHRAdapter().send({
      requestURL: 'https://api.test/big',
      method: 'GET',
      headers: {},
      maxResponseBytes: 1,
      onUploadProgress: (event) => {
        uploads.push(event.progress);
      },
    });

    lastXHR.status = 200;
    lastXHR.response = textBody('too large');
    lastXHR.simulateLoad();
    const response = await promise;

    expect(response.streamErrorCode).toBe('response_too_large');
    expect(uploads.at(-1)).toBe(1);
  });

  test('PR review round 11: a body refused mid-download still ends with the final upload event', async () => {
    const uploads: number[] = [];
    const promise = new XHRAdapter().send({
      requestURL: 'https://api.test/big',
      method: 'GET',
      headers: {},
      maxResponseBytes: 10,
      onUploadProgress: (event) => {
        uploads.push(event.progress);
      },
    });

    lastXHR.status = 200;
    // Known to carry no coding, so its bytes are the body's own.
    lastXHR.getAllResponseHeadersResult = 'content-encoding: identity\r\n';
    lastXHR.simulateDownloadProgress(5000, 5000);
    const response = await promise;

    expect(response.streamErrorCode).toBe('response_too_large');
    expect(uploads.at(-1)).toBe(1);
  });

  test('PR review round 12: a mid-download refusal keeps the answer an upload callback cancels over', async () => {
    const controller = new AbortController();
    const uploads: Array<{ loaded: number; progress: number }> = [];
    const promise = new XHRAdapter().send({
      requestURL: 'https://api.test/big',
      method: 'POST',
      headers: {},
      body: 'hello',
      signal: controller.signal,
      maxResponseBytes: 10,
      onUploadProgress: (event) => {
        uploads.push({ loaded: event.loaded, progress: event.progress });
        if (event.progress === 1) {
          controller.abort();
        }
      },
    });
    // `abort()` resets an XHR, as a browser's does.
    lastXHR.abort = function (this: FakeXHR) {
      this.abortCalled = true;
      this.status = 0;
      this.getAllResponseHeadersResult = '';
    };

    lastXHR.status = 200;
    lastXHR.getAllResponseHeadersResult =
      'x-kept: yes\r\ncontent-encoding: identity\r\n';
    lastXHR.simulateDownloadProgress(5000, 5000);
    const response = await promise;

    expect(response.streamErrorCode).toBe('response_too_large');
    expect(response.status).toBe(200);
    expect(response.headers['x-kept']).toBe('yes');
    // The body's own size, the browser having reported none.
    expect(uploads.at(-1)).toEqual({ loaded: 5, progress: 1 });
  });

  test("PR review round 13: a browser-followed redirect reports the body's own upload size", async () => {
    const uploads: Array<{ loaded: number; progress: number }> = [];
    const promise = new XHRAdapter().send({
      requestURL: 'https://api.test/start',
      method: 'POST',
      headers: {},
      body: 'hello',
      onUploadProgress: (event) => {
        uploads.push({ loaded: event.loaded, progress: event.progress });
      },
    });

    lastXHR.status = 200;
    lastXHR.responseURL = 'https://api.test/elsewhere';
    lastXHR.response = textBody('ok');
    lastXHR.simulateLoad();
    await promise;

    expect(uploads.at(-1)).toEqual({ loaded: 5, progress: 1 });
  });

  test('PR review round 15: the final upload event never reports more bytes than its total', async () => {
    const uploads: Array<{ loaded: number; total: number; progress: number }> =
      [];
    const body = new FormData();
    body.append('field', 'value');
    const promise = new XHRAdapter().send({
      requestURL: 'https://api.test/form',
      method: 'POST',
      headers: {},
      body,
      onUploadProgress: (event) => {
        uploads.push({
          loaded: event.loaded,
          total: event.total,
          progress: event.progress,
        });
      },
    });

    // Bytes reported, but no total, and no `upload.load` after them.
    lastXHR.simulateUploadProgress(500, 0);
    lastXHR.status = 200;
    lastXHR.response = textBody('ok');
    lastXHR.simulateLoad();
    await promise;

    expect(uploads.at(-1)).toEqual({ loaded: 500, total: 500, progress: 1 });
  });

  test('PR review round 15: the final upload event reports a total the browser gave without bytes as sent', async () => {
    const uploads: Array<{ loaded: number; total: number }> = [];
    const body = new FormData();
    body.append('field', 'value');
    const promise = new XHRAdapter().send({
      requestURL: 'https://api.test/form',
      method: 'POST',
      headers: {},
      body,
      onUploadProgress: (event) => {
        uploads.push({ loaded: event.loaded, total: event.total });
      },
    });

    lastXHR.simulateUploadProgress(0, 1200);
    lastXHR.status = 200;
    lastXHR.response = textBody('ok');
    lastXHR.simulateLoad();
    await promise;

    expect(uploads.at(-1)).toEqual({ loaded: 1200, total: 1200 });
  });

  test('PR review round 16: an upload whose last throttled progress event fell short ends at its total', async () => {
    const uploads: Array<{ loaded: number; total: number; progress: number }> =
      [];
    const promise = new XHRAdapter().send({
      requestURL: 'https://api.test/upload',
      method: 'POST',
      headers: {},
      body: new Uint8Array(10_000),
      onUploadProgress: (event) => {
        uploads.push({
          loaded: event.loaded,
          total: event.total,
          progress: event.progress,
        });
      },
    });

    // Sent whole, but the last event the browser let through said 9,000, and
    // `upload.load` never fired.
    lastXHR.simulateUploadProgress(9000, 10_000);
    lastXHR.status = 200;
    lastXHR.response = textBody('ok');
    lastXHR.simulateLoad();
    await promise;

    expect(uploads.at(-1)).toEqual({
      loaded: 10_000,
      total: 10_000,
      progress: 1,
    });
  });

  test('PR review round 16: a browser-followed redirect of unknown length reports the bytes read as its total', async () => {
    const downloads: Array<{ loaded: number; total: number }> = [];
    const promise = new XHRAdapter().send({
      requestURL: 'https://api.test/start',
      method: 'GET',
      headers: {},
      onDownloadProgress: (event) => {
        downloads.push({ loaded: event.loaded, total: event.total });
      },
    });

    lastXHR.simulateDownloadProgress(5000, 0);
    lastXHR.status = 200;
    lastXHR.responseURL = 'https://api.test/elsewhere';
    lastXHR.response = textBody('ok');
    lastXHR.simulateLoad();
    await promise;

    expect(downloads.at(-1)).toEqual({ loaded: 5000, total: 5000 });

    // A known length the last throttled event fell short of: the length, for both.
    const known: Array<{ loaded: number; total: number }> = [];
    const second = new XHRAdapter().send({
      requestURL: 'https://api.test/start',
      method: 'GET',
      headers: {},
      onDownloadProgress: (event) => {
        known.push({ loaded: event.loaded, total: event.total });
      },
    });
    lastXHR.simulateDownloadProgress(4000, 5000);
    lastXHR.status = 200;
    lastXHR.responseURL = 'https://api.test/elsewhere';
    lastXHR.response = textBody('ok');
    lastXHR.simulateLoad();
    await second;

    expect(known.at(-1)).toEqual({ loaded: 5000, total: 5000 });
  });

  test('PR review round 16: an unset header value is not sent as "null", and a Headers is refused', async () => {
    const promise = new XHRAdapter().send({
      requestURL: 'https://api.test/x',
      method: 'GET',
      headers: {
        'x-kept': 'yes',
        'x-unset': null as unknown as string,
      },
    });
    expect(lastXHR.requestHeaders).toEqual({ 'x-kept': ['yes'] });
    lastXHR.status = 200;
    lastXHR.response = textBody('ok');
    lastXHR.simulateLoad();
    await promise;

    const refused = await new XHRAdapter()
      .send({
        requestURL: 'https://api.test/x',
        method: 'GET',
        headers: new Headers({
          authorization: 'Bearer x',
        }) as unknown as Record<string, string>,
      })
      .then(
        () => undefined,
        (error: unknown) => error as Error,
      );
    expect(refused?.message).toContain('must be a plain object');
  });

  test('PR review round 17: upload progress of unknown length reports the bytes sent as its total', async () => {
    const uploads: Array<{ loaded: number; total: number; progress: number }> =
      [];
    const body = new FormData();
    body.append('field', 'value');
    const promise = new XHRAdapter().send({
      requestURL: 'https://api.test/form',
      method: 'POST',
      headers: {},
      body,
      onUploadProgress: (event) => {
        uploads.push({
          loaded: event.loaded,
          total: event.total,
          progress: event.progress,
        });
      },
    });

    lastXHR.simulateUploadProgress(5000, 0);
    expect(uploads.at(-1)).toEqual({ loaded: 5000, total: 5000, progress: -1 });

    lastXHR.status = 200;
    lastXHR.response = textBody('ok');
    lastXHR.simulateLoad();
    await promise;
  });

  test('PR review round 17: a polyfill reporting a computable length of 0 gets progress -1, not NaN', async () => {
    const uploads: Array<{ loaded: number; total: number; progress: number }> =
      [];
    const promise = new XHRAdapter().send({
      requestURL: 'https://api.test/form',
      method: 'POST',
      headers: {},
      body: 'hello',
      onUploadProgress: (event) => {
        uploads.push({
          loaded: event.loaded,
          total: event.total,
          progress: event.progress,
        });
      },
    });

    lastXHR.upload.dispatch('progress', {
      loaded: 3,
      total: 0,
      lengthComputable: true,
    });
    expect(uploads.at(-1)).toEqual({ loaded: 3, total: 3, progress: -1 });

    lastXHR.status = 200;
    lastXHR.response = textBody('ok');
    lastXHR.simulateLoad();
    await promise;
  });

  test('PR review round 18: a signal whose aborted or addEventListener throws is refused as non-retryable', async () => {
    const signals = [
      {
        get aborted(): boolean {
          throw new Error('aborted getter failed');
        },
        addEventListener() {},
        removeEventListener() {},
      },
      {
        aborted: false,
        addEventListener() {
          throw new Error('addEventListener failed');
        },
        removeEventListener() {},
      },
    ];

    for (const signal of signals) {
      const outcome = await new XHRAdapter()
        .send({
          requestURL: 'https://api.test/x',
          method: 'GET',
          headers: {},
          signal: signal as unknown as AbortSignal,
        })
        .then(
          () => undefined,
          (error: unknown) => error as Record<PropertyKey, unknown>,
        );

      expect(outcome?.[NON_RETRYABLE_HTTP_ADAPTER_ERROR_FLAG]).toBe(true);
    }
  });

  test('PR review round 18: a send the XHR refuses is non-retryable and takes its abort listener off the signal', async () => {
    let added = 0;
    let removed = 0;
    const signal = {
      aborted: false,
      addEventListener() {
        added++;
      },
      removeEventListener() {
        removed++;
      },
    };
    // eslint-disable-next-line @typescript-eslint/unbound-method -- put back as it was, below
    const originalSend = FakeXHR.prototype.send;
    FakeXHR.prototype.send = () => {
      throw new DOMException('refused', 'InvalidStateError');
    };

    try {
      const outcome = await new XHRAdapter()
        .send({
          requestURL: 'https://api.test/x',
          method: 'POST',
          headers: {},
          body: 'hello',
          signal: signal as unknown as AbortSignal,
        })
        .then(
          () => undefined,
          (error: unknown) => error as Record<PropertyKey, unknown>,
        );

      expect(outcome?.[NON_RETRYABLE_HTTP_ADAPTER_ERROR_FLAG]).toBe(true);
      expect(added).toBe(1);
      expect(removed).toBe(1);

      // A body the XHR cannot convert - a `toString` that throws - fails the same way.
      FakeXHR.prototype.send = (body?: XMLHttpRequestBodyInit | null) => {
        // eslint-disable-next-line @typescript-eslint/no-base-to-string -- converted as a real XHR converts it
        String(body);
      };
      const unconvertible = await new XHRAdapter()
        .send({
          requestURL: 'https://api.test/x',
          method: 'POST',
          headers: {},
          body: {
            toString() {
              throw new Error('body unconvertible');
            },
          } as unknown as string,
          signal: signal as unknown as AbortSignal,
        })
        .then(
          () => undefined,
          (error: unknown) => error as Record<PropertyKey, unknown>,
        );

      expect(unconvertible?.[NON_RETRYABLE_HTTP_ADAPTER_ERROR_FLAG]).toBe(true);
      expect(removed).toBe(2);
    } finally {
      FakeXHR.prototype.send = originalSend;
    }
  });

  test('PR review round 27: a compressed body is not refused by its encoded bytes on the way in', async () => {
    const promise = new XHRAdapter().send({
      requestURL: 'https://api.test/x',
      method: 'GET',
      headers: {},
      maxResponseBytes: 1000,
    });

    // An incompressible body is a little larger gzipped than decoded.
    lastXHR.readyState = 3;
    lastXHR.status = 200;
    lastXHR.getAllResponseHeadersResult =
      'content-type: text/plain\r\ncontent-encoding: gzip\r\n';
    lastXHR.simulateDownloadProgress(1020, 0);
    lastXHR.response = new TextEncoder().encode('x'.repeat(990)).buffer;
    lastXHR.simulateLoad();
    const response = await promise;

    expect(response.isStreamError).toBeUndefined();
    expect(response.status).toBe(200);
  });

  test('PR review round 29: a body whose coding is hidden is not refused by its encoded bytes', async () => {
    const response = await withPageOrigin('https://app.test', async () => {
      const promise = new XHRAdapter().send({
        requestURL: 'https://other.test/x',
        method: 'GET',
        headers: {},
        maxResponseBytes: 1000,
      });

      // Cross-origin, `Content-Encoding` not exposed: a few bytes over encoded, within
      // the limit decoded.
      lastXHR.readyState = 3;
      lastXHR.status = 200;
      lastXHR.getAllResponseHeadersResult = 'content-type: text/plain\r\n';
      lastXHR.simulateDownloadProgress(1020, 0);
      lastXHR.response = new TextEncoder().encode('x'.repeat(1000)).buffer;
      lastXHR.simulateLoad();
      return await promise;
    });

    expect(response.isStreamError).toBeUndefined();
    expect(response.status).toBe(200);
  });

  test('PR review round 34: a 3xx the XHR hands over unfollowed is reported as a redirect, as FetchAdapter reports one', async () => {
    const cases: Array<
      [
        string,
        {
          wasRedirectDetected: boolean;
          detectedRedirectURL: string | undefined;
        },
      ]
    > = [
      [
        'location: /next\r\n',
        {
          wasRedirectDetected: true,
          detectedRedirectURL: 'https://api.test/next',
        },
      ],
      ['', { wasRedirectDetected: true, detectedRedirectURL: undefined }],
    ];

    for (const [rawHeaders, expected] of cases) {
      const promise = new XHRAdapter().send({
        requestURL: 'https://api.test/start',
        method: 'GET',
        headers: {},
      });

      lastXHR.status = 301;
      lastXHR.responseURL = 'https://api.test/start';
      lastXHR.getAllResponseHeadersResult = rawHeaders;
      lastXHR.response = textBody('');
      lastXHR.simulateLoad();
      const response = await promise;

      expect(response.status).toBe(301);
      expect({
        wasRedirectDetected: response.wasRedirectDetected,
        detectedRedirectURL: response.detectedRedirectURL,
      }).toEqual(expected);
    }
  });

  test('PR review round 36: a repeated Location keeps its first value, joined or on lines of its own', async () => {
    for (const rawHeaders of [
      'location: /a, /b\r\n',
      'location: /a\r\nLocation: /b\r\n',
    ]) {
      const promise = new XHRAdapter().send({
        requestURL: 'https://api.test/start',
        method: 'GET',
        headers: {},
      });

      lastXHR.status = 302;
      lastXHR.responseURL = 'https://api.test/start';
      lastXHR.getAllResponseHeadersResult = rawHeaders;
      lastXHR.response = textBody('');
      lastXHR.simulateLoad();
      const response = await promise;

      expect(response.headers.location).toBe('/a');
      expect(response.detectedRedirectURL).toBe('https://api.test/a');
    }
  });

  test('PR review round 36: a header on lines of its own is joined, as a browser joins it', async () => {
    const promise = new XHRAdapter().send({
      requestURL: 'https://api.test/data',
      method: 'GET',
      headers: {},
    });

    lastXHR.status = 200;
    lastXHR.response = textBody('ok');
    lastXHR.getAllResponseHeadersResult = 'x-multi: a\r\nX-Multi: b\r\n';
    lastXHR.simulateLoad();
    const response = await promise;

    expect(response.headers['x-multi']).toBe('a, b');
  });

  test('PR review round 36: an unfollowed redirect of a relative request URL reports its target', async () => {
    const originalDocument = (globalThis as Record<string, unknown>).document;
    (globalThis as Record<string, unknown>).document = {
      baseURI: 'https://app.test/dir/page',
    };

    try {
      const promise = new XHRAdapter().send({
        requestURL: '/api/start',
        method: 'GET',
        headers: {},
      });

      lastXHR.status = 302;
      lastXHR.responseURL = 'https://app.test/api/start';
      lastXHR.getAllResponseHeadersResult = 'location: next\r\n';
      lastXHR.response = textBody('');
      lastXHR.simulateLoad();
      const response = await promise;

      expect(response.wasRedirectDetected).toBe(true);
      expect(response.detectedRedirectURL).toBe('https://app.test/api/next');
    } finally {
      if (originalDocument === undefined) {
        delete (globalThis as Record<string, unknown>).document;
      } else {
        (globalThis as Record<string, unknown>).document = originalDocument;
      }
    }
  });

  test('PR review round 36: a path-relative request URL is not taken for a followed redirect', async () => {
    const originalDocument = (globalThis as Record<string, unknown>).document;
    (globalThis as Record<string, unknown>).document = {
      baseURI: 'https://app.test/dir/page',
    };

    try {
      const promise = new XHRAdapter().send({
        requestURL: 'api/start',
        method: 'GET',
        headers: {},
      });

      // Where the browser sent it: resolved against the page as a document, not a directory.
      lastXHR.status = 200;
      lastXHR.responseURL = 'https://app.test/dir/api/start';
      lastXHR.response = textBody('ok');
      lastXHR.simulateLoad();
      const response = await promise;

      expect(response.status).toBe(200);
      expect(response.wasRedirectDetected).toBe(false);
    } finally {
      if (originalDocument === undefined) {
        delete (globalThis as Record<string, unknown>).document;
      } else {
        (globalThis as Record<string, unknown>).document = originalDocument;
      }
    }
  });

  test('PR review round 15: a missing method is refused rather than sent as "undefined"', async () => {
    const outcome = await new XHRAdapter()
      .send({
        requestURL: 'https://api.test/x',
        method: undefined as unknown as 'GET',
        headers: {},
      })
      .then(
        () => undefined,
        (error: unknown) => error as Error,
      );

    expect(outcome).toBeInstanceOf(TypeError);
    expect(outcome?.message).toContain('method is required');
  });

  test('round 136: an abort once the headers are in carries the real status', async () => {
    const controller = new AbortController();
    const adapter = new XHRAdapter();
    const promise = adapter.send({
      requestURL: 'https://api.test/slow',
      method: 'GET',
      headers: {},
      signal: controller.signal,
    });

    lastXHR.readyState = 3; // LOADING: headers received, body arriving
    lastXHR.status = 200;
    lastXHR.getAllResponseHeadersResult = 'content-type: text/plain\r\n';
    controller.abort();
    lastXHR.simulateAbort();

    const failure = (await promise.catch((error: unknown) => error)) as Record<
      PropertyKey,
      unknown
    >;
    expect(failure[RESPONSE_STREAM_ABORT_FLAG]).toBe(true);
    expect(failure[STREAM_ABORT_STATUS_KEY]).toBe(200);
  });

  test('round 137: an abort after a redirect the browser followed resolves the redirect', async () => {
    const controller = new AbortController();
    const adapter = new XHRAdapter();
    const promise = adapter.send({
      requestURL: 'https://api.test/redir',
      method: 'GET',
      headers: {},
      signal: controller.signal,
    });

    lastXHR.readyState = 3;
    lastXHR.status = 200;
    lastXHR.responseURL = 'https://api.test/slow';
    controller.abort();
    lastXHR.simulateAbort();

    const response = await promise;
    expect(response.wasRedirectDetected).toBe(true);
    expect(response.detectedRedirectURL).toBe('https://api.test/slow');
    expect(response.status).toBe(0);
  });

  test('round 137: HTTPClient refuses a GET with a body through XHRAdapter in a browser', async () => {
    const browserGlobals = globalThis as {
      window?: unknown;
      document?: unknown;
    };
    browserGlobals.window = globalThis;
    browserGlobals.document = {};
    try {
      const client = new HTTPClient({
        adapter: new XHRAdapter(),
        baseURL: 'https://api.test',
      });
      const builder = client.get('/echo').json({ a: 1 });
      await builder.send();
      expect(builder.error?.code).toBe('request_setup_error');
    } finally {
      delete browserGlobals.window;
      delete browserGlobals.document;
    }
  });

  test('round 138: outside a browser an XHR GET with a body is sent', async () => {
    const client = new HTTPClient({
      adapter: new XHRAdapter(),
      baseURL: 'https://api.test',
    });
    const sending = client.get('/echo').json({ a: 1 }).send();
    await new Promise((resolve) => setTimeout(resolve, 0));
    lastXHR.status = 200;
    lastXHR.response = textBody('ok');
    lastXHR.simulateLoad();
    const response = await sending;
    expect(response.status).toBe(200);
    expect(lastXHR.sentBody).not.toBeNull();
  });

  test('round 137: a cancel after a browser-followed redirect still ends cancelled', async () => {
    const client = new HTTPClient({
      adapter: new XHRAdapter(),
      baseURL: 'https://api.test',
    });
    const builder = client.get('/redir');
    const sending = builder.send();
    await new Promise((resolve) => setTimeout(resolve, 0));
    lastXHR.readyState = 3;
    lastXHR.status = 200;
    lastXHR.responseURL = 'https://api.test/slow';
    builder.cancel();
    lastXHR.simulateAbort();
    const response = await sending;
    expect(response.isCancelled).toBe(true);
    expect(builder.error?.code).toBe('cancelled');
  });

  test('round 140 review 2: response header names are lowercased in ASCII only', async () => {
    const adapter = new XHRAdapter();
    const promise = adapter.send({
      requestURL: 'https://api.test/data',
      method: 'GET',
      headers: {},
    });
    lastXHR.status = 200;
    lastXHR.response = textBody('ok');
    lastXHR.getAllResponseHeadersResult = 'x-key: a\r\nX-\u212Aey: b\r\n';
    lastXHR.simulateLoad();
    const response = await promise;
    expect(response.headers['x-key']).toBe('a');
    // Kept under its own name, not folded in or dropped.
    expect(response.headers['x-\u212Aey']).toBe('b');
  });

  test('audit: request fields are read once, so a listener never reads one again', async () => {
    let methodReads = 0;
    const request = {
      requestURL: 'https://api.test/data',
      headers: {},
      get method() {
        methodReads++;
        if (methodReads > 1) {
          throw new Error('method read again');
        }
        return 'GET';
      },
    } as unknown as AdapterRequest;
    const promise = new XHRAdapter().send(request);

    lastXHR.status = 200;
    lastXHR.response = textBody('ok');
    expect(() => lastXHR.simulateLoad()).not.toThrow();

    expect((await promise).status).toBe(200);
    expect(methodReads).toBe(1);
  });

  test('audit: a method open takes as a number is read as the string it sent', async () => {
    const promise = new XHRAdapter().send({
      requestURL: 'https://api.test/data',
      method: 1 as unknown as 'GET',
      headers: {},
    });

    expect(lastXHR.openArgs?.method).toBe('1');
    lastXHR.status = 200;
    lastXHR.response = textBody('ok');
    expect(() => lastXHR.simulateLoad()).not.toThrow();
    expect((await promise).status).toBe(200);
  });

  test('audit: a request field that throws when read rejects rather than throwing', async () => {
    const request = {
      requestURL: 'https://api.test/data',
      method: 'GET',
      headers: {},
      get onUploadProgress() {
        throw new Error('getter failed');
      },
    } as unknown as AdapterRequest;
    let thrown: unknown;
    let promise: Promise<unknown> = Promise.resolve();
    try {
      promise = new XHRAdapter().send(request);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeUndefined();
    const outcome = await promise.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect((outcome as Error).message).toBe('getter failed');
    expect(
      (outcome as Record<string, unknown>)[
        NON_RETRYABLE_HTTP_ADAPTER_ERROR_FLAG
      ],
    ).toBe(true);
  });

  test('audit: a signal that throws on removal does not throw out of loadend', async () => {
    const controller = new AbortController();
    const signal = controller.signal;
    signal.removeEventListener = () => {
      throw new Error('removal refused');
    };
    const promise = new XHRAdapter().send({
      requestURL: 'https://api.test/data',
      method: 'GET',
      headers: {},
      signal,
    });

    lastXHR.status = 200;
    lastXHR.response = textBody('ok');
    lastXHR.simulateLoad();
    expect(() => lastXHR.simulateLoadEnd()).not.toThrow();
    expect((await promise).status).toBe(200);
  });

  test('returns status and body on successful load', async () => {
    const adapter = new XHRAdapter();
    const promise = adapter.send({
      requestURL: 'https://api.test/data',
      method: 'GET',
      headers: {},
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

  test('keeps a __proto__ response header as an own key', async () => {
    const adapter = new XHRAdapter();
    const promise = adapter.send({
      requestURL: 'https://api.test/data',
      method: 'GET',
      headers: {},
    });

    lastXHR.status = 200;
    lastXHR.response = textBody('{}');
    lastXHR.getAllResponseHeadersResult = '__proto__: x\r\nX-Custom: value\r\n';
    lastXHR.simulateLoad();

    const response = await promise;

    expect(Object.hasOwn(response.headers, '__proto__')).toBe(true);
    expect(
      Object.getOwnPropertyDescriptor(response.headers, '__proto__')?.value,
    ).toBe('x');
    expect(Object.getPrototypeOf(response.headers)).toBe(Object.prototype);
    expect(response.headers['x-custom']).toBe('value');
  });

  test('collects set-cookie headers as string[]', async () => {
    const adapter = new XHRAdapter();
    const promise = adapter.send({
      requestURL: 'https://api.test/data',
      method: 'GET',
      headers: {},
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
    });

    lastXHR.simulateError();

    const response = await promise;

    expect(response.status).toBe(0);
    expect(response.isTransportError).toBe(true);
    expect(response.headers).toEqual({});
    expect(response.body).toBeNull();
    expect(response.errorCause).toBeInstanceOf(Error);
  });

  test('round 133: an empty upload completes as 0 of 0 bytes, not a stand-in 1', async () => {
    const adapter = new XHRAdapter();
    const events: unknown[] = [];
    const promise = adapter.send({
      requestURL: 'https://api.test/data',
      method: 'POST',
      headers: {},
      body: '',
      onUploadProgress: (event) => events.push(event),
    });

    lastXHR.upload.dispatch('load', {
      loaded: 0,
      total: 0,
      lengthComputable: true,
    });
    lastXHR.status = 200;
    lastXHR.response = textBody('ok');
    lastXHR.simulateLoad();
    await promise;

    expect(events.at(-1)).toEqual({ loaded: 0, total: 0, progress: 1 });
  });

  test('leaves both replay signals unset after an upload progressed', async () => {
    const adapter = new XHRAdapter();
    const promise = adapter.send({
      requestURL: 'https://api.test/data',
      method: 'PUT',
      headers: {},
      body: 'payload',
    });

    lastXHR.simulateUploadProgress(64, 128);
    lastXHR.simulateError();

    const response = await promise;

    expect(response.status).toBe(0);
    expect(response.isTransportError).toBe(true);
    // `isRetryable: false` blocks a retry for every method, so it is not
    // inferred from upload progress — an idempotent PUT stays retryable after
    // an ordinary network error.
    expect(response.isRetryable).toBeUndefined();
    expect(response.wasDefinitelyNotSent).toBeUndefined();
  });

  test('leaves both replay signals unset after a completed zero-byte upload', async () => {
    const adapter = new XHRAdapter();
    const promise = adapter.send({
      requestURL: 'https://api.test/data',
      method: 'POST',
      headers: {},
      body: '',
    });

    // upload.load fires with loaded: 0 for an empty request body, so neither
    // the byte count nor completion says anything usable about delivery.
    lastXHR.simulateUploadLoad();
    lastXHR.simulateError();

    const response = await promise;

    expect(response.isRetryable).toBeUndefined();
    expect(response.wasDefinitelyNotSent).toBeUndefined();
  });

  test('never claims non-delivery when no upload progress was observed', async () => {
    const adapter = new XHRAdapter();
    const promise = adapter.send({
      requestURL: 'https://api.test/data',
      method: 'POST',
      headers: {},
      body: 'payload',
    });

    lastXHR.simulateError();

    const response = await promise;

    // Upload progress is suppressed for cross-origin requests CORS does not
    // grant access to, and such a request may still have been delivered.
    // Absence of progress is not evidence that nothing was sent, so this
    // adapter never claims replay safety.
    expect(response.wasDefinitelyNotSent).toBeUndefined();
    expect(response.isRetryable).toBeUndefined();
  });

  test('rejects with AbortError on timeout', () => {
    const adapter = new XHRAdapter();
    const promise = adapter.send({
      requestURL: 'https://api.test/data',
      method: 'GET',
      headers: {},
    });

    lastXHR.simulateTimeout();

    return expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('browser-fired timeout event sets XHR_BROWSER_TIMEOUT_FLAG so client classifies as timeout not cancel', async () => {
    const adapter = new XHRAdapter();
    const promise = adapter.send({
      requestURL: 'https://api.test/data',
      method: 'GET',
      headers: {},
    });

    lastXHR.simulateTimeout();

    const err = await promise.catch((error: unknown) => error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Record<string, unknown>)[XHR_BROWSER_TIMEOUT_FLAG]).toBe(
      true,
    );
  });

  test('rejects with AbortError on XHR abort event', () => {
    const adapter = new XHRAdapter();
    const promise = adapter.send({
      requestURL: 'https://api.test/data',
      method: 'GET',
      headers: {},
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
      onUploadProgress: (e) => uploadEvents.push(e),
    });

    lastXHR.simulateUploadLoad(); // upload complete
    lastXHR.status = 200;
    lastXHR.response = textBody('ok');
    lastXHR.simulateLoad();

    await promise;

    expect(uploadEvents[0]).toEqual({ loaded: 0, total: 0, progress: 0 });
    // The browser reported no bytes, so the body's own size: `payload` is 7.
    expect(uploadEvents[uploadEvents.length - 1]).toEqual({
      loaded: 7,
      total: 7,
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
      onDownloadProgress: (e) => downloadEvents.push(e),
    });

    // total=0 → FakeXHR sets lengthComputable:false → adapter reports progress:-1
    lastXHR.simulateDownloadProgress(100, 0);

    lastXHR.status = 200;
    lastXHR.response = textBody('ok');
    lastXHR.simulateLoad();

    await promise;

    // An unknown length reports what has arrived as the total, as NodeAdapter does.
    expect(downloadEvents[0]).toEqual({
      loaded: 100,
      total: 100,
      progress: -1,
    });
  });

  test('preserves 4xx/5xx status codes', async () => {
    const adapter = new XHRAdapter();
    const promise = adapter.send({
      requestURL: 'https://api.test/data',
      method: 'GET',
      headers: {},
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
    });

    lastXHR.status = 200;
    lastXHR.response = textBody('ok');
    lastXHR.responseURL = 'https://api.test/data'; // same URL — no redirect
    lastXHR.simulateLoad();

    const response = await promise;

    expect(response.wasRedirectDetected).toBe(false);
    expect(response.status).toBe(200);
  });

  test('does not treat fragment-only URL differences as redirect', async () => {
    const adapter = new XHRAdapter();
    const promise = adapter.send({
      requestURL: 'https://api.test/data#client-fragment',
      method: 'GET',
      headers: {},
    });

    lastXHR.status = 200;
    lastXHR.response = textBody('ok');
    // Browsers do not include fragments in HTTP requests, so this should not be
    // interpreted as a redirect.
    lastXHR.responseURL = 'https://api.test/data';
    lastXHR.simulateLoad();

    const response = await promise;

    expect(response.wasRedirectDetected).toBe(false);
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
      });

      lastXHR.status = 200;
      lastXHR.response = textBody('ok');
      lastXHR.responseURL = 'https://cdn.test/api/data';
      lastXHR.simulateLoad();

      const response = await promise;

      expect(response.wasRedirectDetected).toBe(false);
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

  test('detects browser-followed redirect when a relative request URL lands on a different final URL', async () => {
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
      });

      lastXHR.status = 200;
      lastXHR.response = textBody('ok');
      // Simulate the browser auto-following a redirect away from the original
      // same-origin request target resolved from document.baseURI.
      lastXHR.responseURL = 'https://cdn.test/login';
      lastXHR.simulateLoad();

      const response = await promise;

      expect(response).toEqual({
        status: 0,
        wasRedirectDetected: true,
        detectedRedirectURL: 'https://cdn.test/login',
        headers: {},
        body: null,
      });
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

  test('PR review round 40: a responseURL that does not parse is taken for a redirect, with no detectedRedirectURL', async () => {
    const adapter = new XHRAdapter();
    const promise = adapter.send({
      requestURL: 'https://api.test/data',
      method: 'GET',
      headers: {},
    });

    lastXHR.status = 200;
    lastXHR.response = textBody('ok');
    // An absolute URL is what was opened, and a value that does not parse cannot name it.
    lastXHR.responseURL = 'not a url at all';
    lastXHR.simulateLoad();

    const response = await promise;

    expect(response).toEqual({
      status: 0,
      wasRedirectDetected: true,
      headers: {},
      body: null,
    });
    expect(Object.hasOwn(response, 'detectedRedirectURL')).toBe(false);
  });

  test('returns empty headers object when getAllResponseHeaders returns empty string', async () => {
    const adapter = new XHRAdapter();
    const promise = adapter.send({
      requestURL: 'https://api.test/data',
      method: 'GET',
      headers: {},
    });

    lastXHR.status = 200;
    lastXHR.response = textBody('ok');
    lastXHR.getAllResponseHeadersResult = '';
    lastXHR.simulateLoad();

    const response = await promise;

    expect(response.headers).toEqual({});
  });

  test('PR review round 39: an XHR with no upload sends without per-chunk upload progress', async () => {
    const uploads: number[] = [];
    (globalThis as Record<string, unknown>).XMLHttpRequest = class extends (
      FakeXHR
    ) {
      constructor() {
        super();
        Object.defineProperty(this, 'upload', { value: undefined });
      }
    };

    const promise = new XHRAdapter().send({
      requestURL: 'https://api.test/x',
      method: 'POST',
      headers: {},
      body: 'hello',
      onUploadProgress: (event) => {
        uploads.push(event.progress);
      },
    });

    const xhr = FakeXHR.instances[0];
    if (!xhr) {
      throw new Error('FakeXHR instance was not initialized');
    }
    expect(xhr.sentBody).toBe('hello');
    xhr.status = 200;
    xhr.response = textBody('ok');
    xhr.simulateLoad();
    const response = await promise;

    expect(response.status).toBe(200);
    expect(uploads).toEqual([0, 1]);
  });

  test('PR review round 39: an XHR whose upload throws is refused as non-retryable and takes its abort listener off the signal', async () => {
    let added = 0;
    let removed = 0;
    const signal = {
      aborted: false,
      addEventListener() {
        added++;
      },
      removeEventListener() {
        removed++;
      },
    };
    (globalThis as Record<string, unknown>).XMLHttpRequest = class extends (
      FakeXHR
    ) {
      constructor() {
        super();
        Object.defineProperty(this, 'upload', {
          get() {
            throw new Error('upload getter failed');
          },
        });
      }
    };

    const outcome = await new XHRAdapter()
      .send({
        requestURL: 'https://api.test/x',
        method: 'POST',
        headers: {},
        body: 'hello',
        signal: signal as unknown as AbortSignal,
        // Read and listened on only when upload progress is asked for.
        onUploadProgress: () => {},
      })
      .then(
        () => undefined,
        (error: unknown) => error as Record<PropertyKey, unknown>,
      );

    expect((outcome as unknown as Error).message).toBe('upload getter failed');
    expect(outcome?.[NON_RETRYABLE_HTTP_ADAPTER_ERROR_FLAG]).toBe(true);
    expect(added).toBe(1);
    expect(removed).toBe(1);
    expect(FakeXHR.instances[0]?.sentBody).toBeNull();
  });

  test('PR review round 39: an XHR whose upload addEventListener throws is refused as non-retryable and takes its abort listener off the signal', async () => {
    let added = 0;
    let removed = 0;
    const signal = {
      aborted: false,
      addEventListener() {
        added++;
      },
      removeEventListener() {
        removed++;
      },
    };
    (globalThis as Record<string, unknown>).XMLHttpRequest = class extends (
      FakeXHR
    ) {
      constructor() {
        super();
        Object.defineProperty(this, 'upload', {
          value: {
            addEventListener() {
              throw new Error('upload listener refused');
            },
          },
        });
      }
    };

    const outcome = await new XHRAdapter()
      .send({
        requestURL: 'https://api.test/x',
        method: 'POST',
        headers: {},
        body: 'hello',
        signal: signal as unknown as AbortSignal,
        // Read and listened on only when upload progress is asked for.
        onUploadProgress: () => {},
      })
      .then(
        () => undefined,
        (error: unknown) => error as Record<PropertyKey, unknown>,
      );

    expect((outcome as unknown as Error).message).toBe(
      'upload listener refused',
    );
    expect(outcome?.[NON_RETRYABLE_HTTP_ADAPTER_ERROR_FLAG]).toBe(true);
    expect(added).toBe(1);
    expect(removed).toBe(1);
    expect(FakeXHR.instances[0]?.sentBody).toBeNull();
  });

  test('PR review round 40: a relative request URL with no base to resolve it against is refused as non-retryable', async () => {
    // No `document` or `location`: nothing to resolve the URL against.
    expect((globalThis as Record<string, unknown>).document).toBeUndefined();
    expect((globalThis as Record<string, unknown>).location).toBeUndefined();

    for (const requestURL of [
      '/start',
      '//h.test/start',
      'api/x',
      'not a url',
      'http://[::1',
    ]) {
      FakeXHR.instances = [];

      const outcome = await new XHRAdapter()
        .send({ requestURL, method: 'GET', headers: {} })
        .then(
          () => undefined,
          (error: unknown) => error as Record<PropertyKey, unknown>,
        );

      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as unknown as Error).name).toBe('TypeError');
      expect((outcome as unknown as Error).message).toBe(
        'XHRAdapter request URL could not be resolved to an absolute URL (no document or location base, or not a valid URL)',
      );
      expect(outcome?.[NON_RETRYABLE_HTTP_ADAPTER_ERROR_FLAG]).toBe(true);
      // Neither opened nor sent.
      expect(FakeXHR.instances[0]?.openArgs ?? null).toBeNull();
      expect(FakeXHR.instances[0]?.sentBody ?? null).toBeNull();
    }
  });

  test('PR review round 40: userinfo is withheld from a protocol-relative URL that resolves to another origin', async () => {
    const originalDocument = (globalThis as Record<string, unknown>).document;
    // An `http:` page: `//u:p@api.test/x` is `http://api.test/x`, not the `https:` origin
    // the request started on.
    (globalThis as Record<string, unknown>).document = {
      baseURI: 'http://api.test/page',
    };

    try {
      const promise = new XHRAdapter().send({
        requestURL: '//u:p@api.test/x',
        initialURL: 'https://api.test/start',
        method: 'GET',
        headers: {},
      });

      lastXHR.status = 204;
      lastXHR.responseURL = 'http://api.test/x';
      lastXHR.simulateLoad();
      const response = await promise;

      expect(lastXHR.openArgs?.url).toBe('http://api.test/x');
      expect(response.wasRedirectDetected).toBe(false);
    } finally {
      if (originalDocument === undefined) {
        delete (globalThis as Record<string, unknown>).document;
      } else {
        (globalThis as Record<string, unknown>).document = originalDocument;
      }
    }
  });

  test('PR review round 40: same-origin userinfo is kept once resolved against the page', async () => {
    const originalDocument = (globalThis as Record<string, unknown>).document;
    (globalThis as Record<string, unknown>).document = {
      baseURI: 'https://api.test/page',
    };

    try {
      const promise = new XHRAdapter().send({
        requestURL: '//u:p@api.test/x',
        initialURL: 'https://api.test/start',
        method: 'GET',
        headers: {},
      });

      lastXHR.status = 204;
      lastXHR.responseURL = 'https://api.test/x';
      lastXHR.simulateLoad();
      const response = await promise;

      expect(lastXHR.openArgs?.url).toBe('https://u:p@api.test/x');
      expect(response.wasRedirectDetected).toBe(false);
    } finally {
      if (originalDocument === undefined) {
        delete (globalThis as Record<string, unknown>).document;
      } else {
        (globalThis as Record<string, unknown>).document = originalDocument;
      }
    }
  });

  test('PR review round 40: a root-relative request URL redirected to another host is detected', async () => {
    const originalDocument = (globalThis as Record<string, unknown>).document;
    (globalThis as Record<string, unknown>).document = {
      baseURI: 'https://app.test/dir/page',
    };

    try {
      const promise = new XHRAdapter().send({
        requestURL: '/x',
        method: 'GET',
        headers: {},
      });

      // Same path and scheme, another host: only the host was redirected.
      lastXHR.status = 200;
      lastXHR.responseURL = 'https://other.test/x';
      lastXHR.response = textBody('elsewhere');
      lastXHR.simulateLoad();
      const response = await promise;

      expect(lastXHR.openArgs?.url).toBe('https://app.test/x');
      expect(response.status).toBe(0);
      expect(response.wasRedirectDetected).toBe(true);
      expect(response.detectedRedirectURL).toBe('https://other.test/x');
    } finally {
      if (originalDocument === undefined) {
        delete (globalThis as Record<string, unknown>).document;
      } else {
        (globalThis as Record<string, unknown>).document = originalDocument;
      }
    }
  });

  test('PR review round 41: a URL that is not http(s) is refused as non-retryable before it is opened', async () => {
    for (const requestURL of [
      'file:///etc/hosts',
      'data:text/plain,hi',
      'blob:https://app.test/0b2c',
      'ftp://files.test/x',
    ]) {
      FakeXHR.instances = [];

      const outcome = await new XHRAdapter()
        .send({ requestURL, method: 'GET', headers: {} })
        .then(
          () => undefined,
          (error: unknown) => error as Record<PropertyKey, unknown>,
        );

      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as unknown as Error).message).toBe(
        `XHRAdapter sends http: and https: URLs only (got ${requestURL.slice(0, requestURL.indexOf(':') + 1)})`,
      );
      expect(outcome?.[NON_RETRYABLE_HTTP_ADAPTER_ERROR_FLAG]).toBe(true);
      // Neither opened nor sent.
      expect(FakeXHR.instances[0]?.openArgs ?? null).toBeNull();
      expect(FakeXHR.instances[0]?.sentBody ?? null).toBeNull();
    }
  });

  test('PR review round 41: a relative initial URL is resolved against the page before credentials are judged', async () => {
    const originalDocument = (globalThis as Record<string, unknown>).document;
    const openedURL = async (
      requestURL: string,
      initialURL: string,
    ): Promise<string | undefined> => {
      const promise = new XHRAdapter().send({
        requestURL,
        initialURL,
        method: 'GET',
        headers: {},
      });
      lastXHR.status = 204;
      lastXHR.responseURL = requestURL.replace('u:p@', '');
      lastXHR.simulateLoad();
      await promise;
      return lastXHR.openArgs?.url;
    };

    try {
      (globalThis as Record<string, unknown>).document = {
        baseURI: 'https://api.test/page',
      };
      // `/start` on this page is `https://api.test/start`: same origin, kept.
      expect(await openedURL('https://u:p@api.test/x', '/start')).toBe(
        'https://u:p@api.test/x',
      );
      // Another origin than the page's: withheld.
      expect(await openedURL('https://u:p@evil.test/x', '/start')).toBe(
        'https://evil.test/x',
      );

      // No base: the initial URL cannot be resolved, so it still fails closed.
      delete (globalThis as Record<string, unknown>).document;
      expect(await openedURL('https://u:p@api.test/x', '/start')).toBe(
        'https://api.test/x',
      );
    } finally {
      if (originalDocument === undefined) {
        delete (globalThis as Record<string, unknown>).document;
      } else {
        (globalThis as Record<string, unknown>).document = originalDocument;
      }
    }
  });

  test('PR review round 42: an initial URL that names no origin fails closed rather than naming the page', async () => {
    // Resolved against the page, `''`, `#top`, `?q` or `start` is the page itself: the
    // request URL's userinfo was kept with nothing to show it belonged to that origin. A
    // root- or protocol-relative one names an origin, and is resolved.
    const originalDocument = (globalThis as Record<string, unknown>).document;
    const openedURL = async (
      initialURL: string,
    ): Promise<string | undefined> => {
      const promise = new XHRAdapter().send({
        requestURL: 'https://u:p@app.test/x',
        initialURL,
        method: 'GET',
        headers: {},
      });
      lastXHR.status = 204;
      lastXHR.responseURL = 'https://app.test/x';
      lastXHR.simulateLoad();
      await promise;
      return lastXHR.openArgs?.url;
    };

    try {
      (globalThis as Record<string, unknown>).document = {
        baseURI: 'https://app.test/page',
      };

      for (const initialURL of ['', ' \t\n', '#top', '?q', '.', 'start']) {
        expect(await openedURL(initialURL)).toBe('https://app.test/x');
      }

      for (const initialURL of ['/start', '//app.test/start']) {
        expect(await openedURL(initialURL)).toBe('https://u:p@app.test/x');
      }
    } finally {
      if (originalDocument === undefined) {
        delete (globalThis as Record<string, unknown>).document;
      } else {
        (globalThis as Record<string, unknown>).document = originalDocument;
      }
    }
  });

  test('PR review round 42: a request refused before it is sent reports no upload start', async () => {
    (globalThis as Record<string, unknown>).XMLHttpRequest = class extends (
      FakeXHR
    ) {
      constructor() {
        super();
        Object.defineProperty(this, 'upload', {
          get() {
            throw new Error('upload getter failed');
          },
        });
      }
    };

    const events: unknown[] = [];
    const outcome = await new XHRAdapter()
      .send({
        requestURL: 'https://api.test/x',
        method: 'POST',
        headers: {},
        body: 'hello',
        onUploadProgress: (event) => events.push(event),
      })
      .then(
        () => undefined,
        (error: unknown) => error as Record<PropertyKey, unknown>,
      );

    expect((outcome as unknown as Error).message).toBe('upload getter failed');
    expect(outcome?.[NON_RETRYABLE_HTTP_ADAPTER_ERROR_FLAG]).toBe(true);
    expect(FakeXHR.instances[0]?.sentBody).toBeNull();
    expect(events).toEqual([]);
  });
});

describe('XHRAdapter - PR review round 43', () => {
  test("PR review round 43: a header or method the runtime refuses is reported without the runtime's error, which quotes the value", async () => {
    const secret = 'secret-token';
    // As Chrome refuses one, its message quoting what it refused.
    (globalThis as Record<string, unknown>).XMLHttpRequest = class extends (
      FakeXHR
    ) {
      public override open(method: string, url: string) {
        if (method !== 'GET') {
          throw new DOMException(
            `Failed to execute 'open' on 'XMLHttpRequest': '${method}' is not a valid HTTP method.`,
            'SyntaxError',
          );
        }
        super.open(method, url);
      }

      public override setRequestHeader(name: string, value: string) {
        if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) {
          throw new DOMException(
            `Failed to execute 'setRequestHeader' on 'XMLHttpRequest': '${name}' is not a valid HTTP header field name.`,
            'SyntaxError',
          );
        }
        if (value.includes('\n')) {
          throw new DOMException(
            `Failed to execute 'setRequestHeader' on 'XMLHttpRequest': '${value}' is not a valid HTTP header field value.`,
            'SyntaxError',
          );
        }
        super.setRequestHeader(name, value);
      }
    };
    const send = (request: Partial<AdapterRequest>) =>
      new XHRAdapter()
        .send({
          requestURL: 'https://api.test/x',
          method: 'GET',
          headers: {},
          ...request,
        })
        .then(
          () => undefined,
          (error: unknown) => error as Record<PropertyKey, unknown>,
        );

    const header = await send({
      headers: { authorization: `Bearer ${secret}\nx` },
    });
    expect(String(header?.message)).toBe(
      "XHRAdapter refused header 'authorization'",
    );
    expect(header?.[NON_RETRYABLE_HTTP_ADAPTER_ERROR_FLAG]).toBe(true);
    expect(errorText(header)).not.toContain(secret);

    // A name that is not a token - a whole header line pasted in as one - is not written.
    const name = await send({
      headers: { [`Authorization: Bearer ${secret}`]: 'x' },
    });
    expect(String(name?.message)).toBe('XHRAdapter refused a header name');
    expect(name?.[NON_RETRYABLE_HTTP_ADAPTER_ERROR_FLAG]).toBe(true);
    expect(errorText(name)).not.toContain(secret);

    const method = await send({ method: `X-${secret}` });
    expect(String(method?.message)).toBe(
      'XHRAdapter could not open the request: the runtime refused its method or URL',
    );
    expect(method?.[NON_RETRYABLE_HTTP_ADAPTER_ERROR_FLAG]).toBe(true);
    expect(errorText(method)).not.toContain(secret);
  });
});

describe('XHRAdapter - PR review round 44', () => {
  test('PR review round 44: a header the runtime refuses by a token name is not reported as a refused value', async () => {
    // An XHR outside a browser may refuse a name that is a token, which a browser never
    // does, so the refusal names the header without claiming which part of it failed.
    (globalThis as Record<string, unknown>).XMLHttpRequest = class extends (
      FakeXHR
    ) {
      public override setRequestHeader(name: string, value: string) {
        if (name === 'x-blocked') {
          throw new TypeError('header name not allowed');
        }
        super.setRequestHeader(name, value);
      }
    };

    const outcome = await new XHRAdapter()
      .send({
        requestURL: 'https://api.test/x',
        method: 'GET',
        headers: { 'x-blocked': 'ok' },
      })
      .then(
        () => undefined,
        (error: unknown) => error as Record<PropertyKey, unknown>,
      );

    expect(String(outcome?.message)).toBe(
      "XHRAdapter refused header 'x-blocked'",
    );
    expect(outcome?.[NON_RETRYABLE_HTTP_ADAPTER_ERROR_FLAG]).toBe(true);
  });
});

describe('XHRAdapter - round 58', () => {
  test('a cancel from the 0% upload progress callback stops the request before it is sent', async () => {
    const controller = new AbortController();
    const promise = new XHRAdapter().send({
      requestURL: 'https://api.test/orders',
      method: 'POST',
      headers: {},
      body: 'x',
      signal: controller.signal,
      onUploadProgress: (event) => {
        if (event.progress === 0) {
          controller.abort('stop');
        }
      },
    });

    const rejection = await promise.then(
      () => undefined,
      (error: unknown) => error as Error,
    );

    expect(rejection?.name).toBe('AbortError');
    expect(lastXHR.sentBody).toBeNull();
  });

  test('a response buffer from another realm is read as the body', async () => {
    const promise = new XHRAdapter().send({
      requestURL: 'https://api.test/x',
      method: 'GET',
      headers: {},
    });
    lastXHR.status = 200;
    lastXHR.response = vm.runInNewContext(
      'new Uint8Array([104, 105]).buffer',
    ) as ArrayBuffer;
    lastXHR.simulateLoad();

    const response = await promise;

    expect(response.body).toEqual(new Uint8Array([104, 105]));
  });

  test('an abort from a final progress callback does not wipe the status and headers', async () => {
    const controller = new AbortController();
    const promise = new XHRAdapter().send({
      requestURL: 'https://api.test/x',
      method: 'GET',
      headers: {},
      signal: controller.signal,
      onDownloadProgress: (event) => {
        if (event.progress === 1) {
          controller.abort();
        }
      },
    });
    const xhr = lastXHR;
    xhr.status = 200;
    xhr.getAllResponseHeadersResult = 'content-type: text/plain\r\n';
    xhr.response = new Uint8Array([104, 105]).buffer;
    // As a real XHR does when aborted once done: reset to UNSENT.
    xhr.abort = () => {
      xhr.status = 0;
      xhr.getAllResponseHeadersResult = '';
    };
    xhr.simulateLoad();

    const response = await promise;

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('text/plain');
  });
});

test('XHRAdapter keeps the redirect target when a final progress callback aborts', async () => {
  const controller = new AbortController();
  const promise = new XHRAdapter().send({
    requestURL: 'https://api.test/a',
    method: 'GET',
    headers: {},
    signal: controller.signal,
    onDownloadProgress: (event) => {
      if (event.progress === 1) {
        controller.abort();
      }
    },
  });
  const xhr = lastXHR;
  xhr.status = 200;
  xhr.responseURL = 'https://api.test/b';
  xhr.abort = () => {
    xhr.status = 0;
    xhr.responseURL = '';
  };
  xhr.simulateLoad();

  const response = await promise;

  expect(response.wasRedirectDetected).toBe(true);
  expect(response.detectedRedirectURL).toBe('https://api.test/b');
});

describe('XHRAdapter - maxResponseBytes', () => {
  test('a download passing the limit is aborted and fails as response_too_large with its status and headers', async () => {
    const onDownloadProgress: number[] = [];
    const promise = new XHRAdapter().send({
      requestURL: 'https://api.test/big',
      method: 'GET',
      headers: {},
      maxResponseBytes: 100,
      onDownloadProgress: (event) => {
        onDownloadProgress.push(event.loaded);
      },
    });
    const xhr = lastXHR;
    xhr.status = 503;
    xhr.getAllResponseHeadersResult =
      'content-type: text/plain\r\ncontent-encoding: identity\r\n';
    // As a real XHR does: reset to UNSENT and fire `abort` synchronously.
    xhr.abort = () => {
      xhr.abortCalled = true;
      xhr.status = 0;
      xhr.getAllResponseHeadersResult = '';
      xhr.simulateAbort();
    };

    xhr.simulateDownloadProgress(60, 0);
    // Past the limit, on a body known to carry no coding.
    xhr.simulateDownloadProgress(2000, 0);
    // A late event after the abort changes nothing.
    xhr.simulateDownloadProgress(3000, 0);

    const response = await promise;

    expect(xhr.abortCalled).toBe(true);
    expect(response.status).toBe(503);
    expect(response.headers['content-type']).toBe('text/plain');
    expect(response.body).toBeNull();
    expect(response.isStreamError).toBe(true);
    expect(response.streamErrorCode).toBe('response_too_large');
    expect(response.errorCause?.message).toBe(
      'Response body exceeds maxResponseBytes (100); raise maxResponseBytes',
    );
    // Only the progress under the limit was reported.
    expect(onDownloadProgress).toEqual([60]);
  });

  test('a loaded body over the limit fails as response_too_large', async () => {
    const promise = new XHRAdapter().send({
      requestURL: 'https://api.test/big',
      method: 'GET',
      headers: {},
      maxResponseBytes: 4,
    });
    lastXHR.status = 200;
    lastXHR.response = textBody('hello world');
    lastXHR.simulateLoad();

    const response = await promise;

    expect(response.status).toBe(200);
    expect(response.body).toBeNull();
    expect(response.isStreamError).toBe(true);
    expect(response.streamErrorCode).toBe('response_too_large');
  });

  test('a body within the limit, or with Infinity, is delivered', async () => {
    for (const maxResponseBytes of [11, Infinity]) {
      const promise = new XHRAdapter().send({
        requestURL: 'https://api.test/ok',
        method: 'GET',
        headers: {},
        maxResponseBytes,
      });
      lastXHR.status = 200;
      lastXHR.simulateDownloadProgress(11, 11);
      lastXHR.response = textBody('hello world');
      lastXHR.simulateLoad();

      const response = await promise;

      expect(response.isStreamError).toBeUndefined();
      expect(new TextDecoder().decode(response.body as Uint8Array)).toBe(
        'hello world',
      );
    }
  });
});

describe('XHRAdapter - PR review round 53', () => {
  test('PR review round 53: a compressed body many times its decoded size on the wire is delivered when it decodes within the limit', async () => {
    const response = await withPageOrigin('https://api.test', async () => {
      const promise = new XHRAdapter().send({
        requestURL: 'https://api.test/stream',
        method: 'GET',
        headers: {},
        maxResponseBytes: 1000,
      });

      lastXHR.readyState = 3;
      lastXHR.status = 200;
      lastXHR.getAllResponseHeadersResult =
        'content-type: text/plain\r\ncontent-encoding: gzip\r\n';
      // Gzip flushed after every byte: 512 decoded bytes arrive as 3,604.
      lastXHR.simulateDownloadProgress(3604, 0);
      lastXHR.response = textBody('x'.repeat(512));
      lastXHR.simulateLoad();
      return await promise;
    });

    expect(lastXHR.abortCalled).toBe(false);
    expect(response.isStreamError).toBeUndefined();
    expect(response.status).toBe(200);
    expect((response.body as Uint8Array).length).toBe(512);
  });

  test('PR review round 53: a body known to carry no coding is refused as soon as its bytes pass the limit', async () => {
    const cases: Array<[string, string, string]> = [
      // Same-origin, no `Content-Encoding`: none was applied.
      ['https://api.test', 'https://api.test/big', ''],
      [
        'https://api.test',
        'https://api.test/big',
        'content-encoding: identity\r\n',
      ],
      // Cross-origin, with `Content-Encoding` exposed.
      [
        'https://app.test',
        'https://api.test/big',
        'content-encoding: identity\r\n',
      ],
    ];

    for (const [pageOrigin, requestURL, encodingLine] of cases) {
      const progress: number[] = [];
      const response = await withPageOrigin(pageOrigin, async () => {
        const promise = new XHRAdapter().send({
          requestURL,
          method: 'GET',
          headers: {},
          maxResponseBytes: 1000,
          onDownloadProgress: (event) => {
            progress.push(event.loaded);
          },
        });

        lastXHR.readyState = 3;
        lastXHR.status = 200;
        lastXHR.getAllResponseHeadersResult = `content-type: text/plain\r\n${encodingLine}`;
        lastXHR.simulateDownloadProgress(1000, 0);
        // One byte past the limit, no slack.
        lastXHR.simulateDownloadProgress(1001, 0);
        // Settles the request either way; refused above, this changes nothing.
        lastXHR.response = textBody('x'.repeat(1001));
        lastXHR.simulateLoad();
        return await promise;
      });

      expect(lastXHR.abortCalled).toBe(true);
      expect(response.streamErrorCode).toBe('response_too_large');
      expect(response.status).toBe(200);
      expect(progress).toEqual([1000]);
    }
  });

  test('PR review round 53: a compressed body is not cut on its encoded bytes, and is refused at load when it decodes past the limit', async () => {
    const progress: number[] = [];
    const response = await withPageOrigin('https://api.test', async () => {
      const promise = new XHRAdapter().send({
        requestURL: 'https://api.test/x',
        method: 'GET',
        headers: {},
        maxResponseBytes: 1000,
        onDownloadProgress: (event) => {
          progress.push(event.loaded);
        },
      });

      lastXHR.readyState = 3;
      lastXHR.status = 200;
      lastXHR.getAllResponseHeadersResult =
        'content-type: text/plain\r\ncontent-encoding: br, identity\r\n';
      lastXHR.simulateDownloadProgress(5000, 0);
      lastXHR.response = textBody('x'.repeat(1500));
      lastXHR.simulateLoad();
      return await promise;
    });

    expect(lastXHR.abortCalled).toBe(false);
    expect(progress[0]).toBe(5000);
    expect(response.streamErrorCode).toBe('response_too_large');
    expect(response.status).toBe(200);
  });

  test('PR review round 53: a cross-origin body whose coding is hidden is not cut mid-download', async () => {
    // A cross-origin page, and a sandboxed one (`'null'`, the same origin as none).
    for (const pageOrigin of ['https://app.test', 'null']) {
      const response = await withPageOrigin(pageOrigin, async () => {
        const promise = new XHRAdapter().send({
          requestURL: 'https://api.test/x',
          method: 'GET',
          headers: {},
          maxResponseBytes: 1000,
        });

        lastXHR.readyState = 3;
        lastXHR.status = 200;
        lastXHR.getAllResponseHeadersResult = 'content-type: text/plain\r\n';
        lastXHR.simulateDownloadProgress(3604, 0);
        lastXHR.response = textBody('x'.repeat(1000));
        lastXHR.simulateLoad();
        return await promise;
      });

      expect(lastXHR.abortCalled).toBe(false);
      expect(response.isStreamError).toBeUndefined();
      expect(response.status).toBe(200);
    }
  });
});

describe('XHRAdapter - PR review round 53 follow-up', () => {
  test('PR review round 53: with no page origin, an absent Content-Encoding is not taken as none - the runtime may have decoded the body and dropped it', async () => {
    // React Native's Android networking counts bytes off the wire, still gzip, and hands
    // over the body decoded with `Content-Encoding` removed.
    const result = await sendPastLimitWithoutCoding('https://api.test/x');

    expect(result.abortCalled).toBe(false);
    expect(result.streamErrorCode).toBeUndefined();
  });

  test('PR review round 53: a cross-origin request redirected back to the page origin is not cut on its bytes', async () => {
    const result = await withPageOrigin('https://app.test', async () => {
      return await sendPastLimitWithoutCoding(
        'https://api.test/x',
        'https://app.test/y',
      );
    });

    // Not stopped mid-download; reported as the redirect the browser followed.
    expect(result.abortCalled).toBe(false);
  });

  test('PR review round 53: a same-origin request whose response URL is on another origin is not cut on its bytes', async () => {
    const result = await withPageOrigin('https://api.test', async () => {
      return await sendPastLimitWithoutCoding(
        'https://api.test/x',
        'https://other.test/y',
      );
    });

    expect(result.abortCalled).toBe(false);
  });

  test('PR review round 53: the page origin is read from location, and from window and self, as a worker or page has it', async () => {
    const shapes: Array<[string, unknown]> = [
      // A worker's shape: `location.origin`, no `origin`.
      ['location', { origin: 'https://api.test' }],
      ['window', { origin: 'https://api.test' }],
      ['self', { location: { origin: 'https://api.test' } }],
    ];

    for (const [key, value] of shapes) {
      const result = await withGlobal(key, value, async () => {
        return await sendPastLimitWithoutCoding('https://api.test/x');
      });

      // Same-origin, so the absent header is proof: stopped on the way in.
      expect(result.abortCalled).toBe(true);
      expect(result.streamErrorCode).toBe('response_too_large');
    }
  });
});

/** Runs `fn` with no global `DOMException`, as some runtimes outside a browser have, and restores it. */
async function withoutDOMException<T>(fn: () => Promise<T>): Promise<T> {
  const scope = globalThis as Record<string, unknown>;
  const descriptor = Object.getOwnPropertyDescriptor(scope, 'DOMException');
  delete scope.DOMException;

  try {
    return await fn();
  } finally {
    if (descriptor !== undefined) {
      Object.defineProperty(scope, 'DOMException', descriptor);
    }
  }
}

/** How `promise` settles within a few event-loop turns: its rejection, or `'pending'`. */
async function settlement(promise: Promise<unknown>): Promise<unknown> {
  return await Promise.race([
    promise.then(
      () => 'resolved',
      (error: unknown) => error,
    ),
    new Promise((resolve) => setTimeout(() => resolve('pending'), 50)),
  ]);
}

describe('XHRAdapter - PR review round 56', () => {
  test('PR review round 56: without DOMException, a cancel during the request settles as an AbortError', async () => {
    await withoutDOMException(async () => {
      expect(typeof (globalThis as Record<string, unknown>).DOMException).toBe(
        'undefined',
      );
      const controller = new AbortController();
      const promise = new XHRAdapter().send({
        requestURL: 'https://api.test/data',
        method: 'GET',
        headers: {},
        signal: controller.signal,
      });

      controller.abort();
      expect(lastXHR.abortCalled).toBe(true);
      // A real XHR reports a listener's throw and carries on; the fake rethrows it.
      try {
        lastXHR.simulateAbort();
      } catch {
        // The settlement below is what is checked.
      }

      const outcome = await settlement(promise);
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).name).toBe('AbortError');
    });
  });

  test('PR review round 56: without DOMException, an already-aborted signal rejects as an AbortError', async () => {
    const controller = new AbortController();
    controller.abort();

    await withoutDOMException(async () => {
      const outcome = await settlement(
        new XHRAdapter().send({
          requestURL: 'https://api.test/data',
          method: 'GET',
          headers: {},
          signal: controller.signal,
        }),
      );

      expect((outcome as Error).name).toBe('AbortError');
      expect(
        (outcome as Record<string, unknown>)[
          NON_RETRYABLE_HTTP_ADAPTER_ERROR_FLAG
        ],
      ).toBeUndefined();
    });
  });

  test('PR review round 56: without DOMException, a cancel from the 0% upload progress callback rejects as an AbortError', async () => {
    await withoutDOMException(async () => {
      const controller = new AbortController();
      const outcome = await settlement(
        new XHRAdapter().send({
          requestURL: 'https://api.test/data',
          method: 'POST',
          headers: {},
          body: 'payload',
          signal: controller.signal,
          onUploadProgress: () => {
            controller.abort();
          },
        }),
      );

      expect((outcome as Error).name).toBe('AbortError');
      expect(
        (outcome as Record<string, unknown>)[
          NON_RETRYABLE_HTTP_ADAPTER_ERROR_FLAG
        ],
      ).toBeUndefined();
      expect(lastXHR.sentBody).toBeNull();
    });
  });

  test('PR review round 56: without DOMException, a browser-fired timeout rejects as an AbortError carrying the timeout flag', async () => {
    await withoutDOMException(async () => {
      const promise = new XHRAdapter().send({
        requestURL: 'https://api.test/data',
        method: 'GET',
        headers: {},
      });

      try {
        lastXHR.simulateTimeout();
      } catch {
        // The settlement below is what is checked.
      }

      const outcome = await settlement(promise);
      expect((outcome as Error).name).toBe('AbortError');
      expect(
        (outcome as Record<string, unknown>)[XHR_BROWSER_TIMEOUT_FLAG],
      ).toBe(true);
    });
  });

  test('PR review round 56: through the client, a cancel without DOMException ends cancelled', async () => {
    await withoutDOMException(async () => {
      const client = new HTTPClient({
        adapter: new XHRAdapter(),
        baseURL: 'https://api.test',
      });
      const builder = client.get('/data');
      const sending = builder.send();
      await new Promise((resolve) => setTimeout(resolve, 0));
      builder.cancel();
      try {
        lastXHR.simulateAbort();
      } catch {
        // The settlement below is what is checked.
      }

      const outcome = await Promise.race([
        sending,
        new Promise((resolve) => setTimeout(() => resolve('pending'), 50)),
      ]);
      expect(outcome).not.toBe('pending');
      expect((outcome as { isCancelled: boolean }).isCancelled).toBe(true);
      expect(builder.error?.code).toBe('cancelled');
    });
  });

  test("PR review round 56: a caller's Content-Length is not sent", async () => {
    const promise = new XHRAdapter().send({
      requestURL: 'https://api.test/data',
      method: 'POST',
      headers: { 'Content-Length': '999', 'x-kept': '1' },
      body: 'hi',
    });

    lastXHR.status = 204;
    lastXHR.simulateLoad();
    await promise;

    expect(lastXHR.requestHeaders['content-length']).toBeUndefined();
    expect(lastXHR.requestHeaders['x-kept']).toEqual(['1']);
  });

  test('PR review round 56: an empty Cookie value sends no Cookie header', async () => {
    const promise = new XHRAdapter().send({
      requestURL: 'https://api.test/data',
      method: 'GET',
      headers: { cookie: '', Cookie: [''] },
    });

    lastXHR.status = 204;
    lastXHR.simulateLoad();
    await promise;

    expect(lastXHR.requestHeaders.cookie).toBeUndefined();
  });
});

describe('XHRAdapter - PR review round 64', () => {
  /** The listeners registered on the fake XHR's `upload`, by event type. */
  function uploadListenerCount(xhr: FakeXHR): number {
    const handlers = (
      xhr.upload as unknown as { handlers: Record<string, unknown[]> }
    ).handlers;

    return Object.values(handlers).reduce(
      (count, list) => count + list.length,
      0,
    );
  }

  test('PR review round 64: a request with no body to send listens on no upload, and still ends with its final upload event', async () => {
    for (const body of [undefined, '', new Uint8Array(0)]) {
      const uploads: Array<{
        loaded: number;
        total: number;
        progress: number;
      }> = [];
      const promise = new XHRAdapter().send({
        requestURL: 'https://api.test/data',
        method: body === undefined ? 'GET' : 'POST',
        headers: {},
        body,
        onUploadProgress: (event) => {
          uploads.push({
            loaded: event.loaded,
            total: event.total,
            progress: event.progress,
          });
        },
      });

      expect(uploadListenerCount(lastXHR)).toBe(0);

      lastXHR.status = 204;
      lastXHR.simulateLoad();
      await promise;

      expect(uploads).toEqual([
        { loaded: 0, total: 0, progress: 0 },
        { loaded: 0, total: 0, progress: 1 },
      ]);
    }
  });

  test('PR review round 64: a request with a body to send listens on its upload', async () => {
    const promise = new XHRAdapter().send({
      requestURL: 'https://api.test/data',
      method: 'POST',
      headers: {},
      body: 'hello',
      onUploadProgress: () => {},
    });

    expect(uploadListenerCount(lastXHR)).toBe(2);

    lastXHR.status = 204;
    lastXHR.simulateLoad();
    await promise;
  });

  test('PR review round 64: an abort after a redirect the browser followed ends with the final upload event', async () => {
    const controller = new AbortController();
    const uploads: Array<{ loaded: number; progress: number }> = [];
    const promise = new XHRAdapter().send({
      requestURL: 'https://api.test/redir',
      method: 'POST',
      headers: {},
      body: 'hello',
      signal: controller.signal,
      onUploadProgress: (event) => {
        uploads.push({ loaded: event.loaded, progress: event.progress });
      },
    });

    lastXHR.readyState = 3;
    lastXHR.status = 200;
    lastXHR.responseURL = 'https://api.test/slow';
    controller.abort();
    lastXHR.simulateAbort();

    const response = await promise;
    expect(response.wasRedirectDetected).toBe(true);
    expect(uploads).toEqual([
      { loaded: 0, progress: 0 },
      { loaded: 5, progress: 1 },
    ]);
  });

  test("PR review round 65: a Blob body's size is read once, deciding the listeners and its final upload event", async () => {
    for (const size of [0, 7]) {
      let reads = 0;
      const body = new (class extends Blob {
        public override get size(): number {
          reads++;
          return size;
        }
      })();
      const uploads: Array<{ loaded: number; progress: number }> = [];
      const promise = new XHRAdapter().send({
        requestURL: 'https://api.test/data',
        method: 'POST',
        headers: {},
        // A Blob reaches an adapter driven directly, as XHR sends one natively.
        body: body as unknown as AdapterRequest['body'],
        onUploadProgress: (event) => {
          uploads.push({ loaded: event.loaded, progress: event.progress });
        },
      });

      expect(uploadListenerCount(lastXHR)).toBe(size === 0 ? 0 : 2);

      lastXHR.status = 204;
      lastXHR.simulateLoad();
      await promise;

      expect(reads).toBe(1);
      expect(uploads.at(-1)).toEqual({ loaded: size, progress: 1 });
    }
  });
});

describe('XHRAdapter - PR review round 67', () => {
  /** The listeners registered on the fake XHR's `upload`, by event type. */
  function uploadListenerCount(xhr: FakeXHR): number {
    const handlers = (
      xhr.upload as unknown as { handlers: Record<string, unknown[]> }
    ).handlers;

    return Object.values(handlers).reduce(
      (count, list) => count + list.length,
      0,
    );
  }

  test('PR review round 67: an adapter driven without onUploadProgress listens on no upload', async () => {
    const promise = new XHRAdapter().send({
      requestURL: 'https://api.test/data',
      method: 'POST',
      headers: {},
      body: 'hello',
    });

    expect(uploadListenerCount(lastXHR)).toBe(0);

    lastXHR.status = 204;
    lastXHR.simulateLoad();
    await promise;
  });

  test("PR review round 69: a request without onUploadProgress never reads its Blob body's size", async () => {
    let reads = 0;
    const body = new (class extends Blob {
      public override get size(): number {
        reads++;
        return 7;
      }
    })();
    const promise = new XHRAdapter().send({
      requestURL: 'https://api.test/data',
      method: 'POST',
      headers: {},
      // A Blob reaches an adapter driven directly, as XHR sends one natively.
      body: body as unknown as AdapterRequest['body'],
    });

    lastXHR.status = 204;
    lastXHR.simulateLoad();
    expect((await promise).status).toBe(204);
    expect(reads).toBe(0);
  });

  test('PR review round 67: a request without onUploadProgress never reads an upload that throws', async () => {
    (globalThis as Record<string, unknown>).XMLHttpRequest = class extends (
      FakeXHR
    ) {
      constructor() {
        super();
        Object.defineProperty(this, 'upload', {
          get() {
            throw new Error('upload getter failed');
          },
        });
      }
    };

    const promise = new XHRAdapter().send({
      requestURL: 'https://api.test/data',
      method: 'POST',
      headers: {},
      body: 'hello',
    });

    const xhr = FakeXHR.instances[0];
    expect(xhr?.sentBody).toBe('hello');
    if (xhr) {
      xhr.status = 204;
      xhr.simulateLoad();
    }
    expect((await promise).status).toBe(204);
  });

  test('PR review round 67: through the client, a bodied request listens on its upload only when it asks for upload progress', async () => {
    const client = new HTTPClient({
      adapter: new XHRAdapter(),
      baseURL: 'https://api.test',
    });

    // No hook: no listener on `upload`, which would make a browser preflight it.
    const plain = client.post('/data').body('hello').send();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(uploadListenerCount(lastXHR)).toBe(0);
    lastXHR.status = 204;
    lastXHR.simulateLoad();
    expect((await plain).status).toBe(204);

    // A hook: listened on, and its events delivered.
    const uploads: Array<{ loaded: number; progress: number }> = [];
    const tracked = client
      .post('/data')
      .body('hello')
      .onUploadProgress((event) => {
        uploads.push({ loaded: event.loaded, progress: event.progress });
      })
      .send();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(uploadListenerCount(lastXHR)).toBe(2);
    lastXHR.simulateUploadProgress(3, 5);
    lastXHR.simulateUploadProgress(5, 5);
    lastXHR.status = 204;
    lastXHR.simulateLoad();
    expect((await tracked).status).toBe(204);

    expect(uploads).toEqual([
      { loaded: 0, progress: 0 },
      { loaded: 3, progress: 0.6 },
      { loaded: 5, progress: 1 },
    ]);
  });
});

describe('XHRAdapter - PR review round 80', () => {
  test('PR review round 80: a response header value keeps a trailing 0xA0 byte, trimmed of HTTP whitespace only', async () => {
    const promise = new XHRAdapter().send({
      requestURL: 'https://api.test/data',
      method: 'GET',
      headers: {},
    });
    lastXHR.status = 200;
    lastXHR.response = textBody('ok');
    // `à` in UTF-8 is 0xC3 0xA0, which a header read as latin1 gives as `\u00C3\u00A0`.
    lastXHR.getAllResponseHeadersResult =
      'content-disposition: attachment; filename=\u00C3\u00A0\r\nx-padded:\t value \t\r\n';
    lastXHR.simulateLoad();
    const response = await promise;
    expect(response.headers['content-disposition']).toBe(
      'attachment; filename=\u00C3\u00A0',
    );
    expect(response.headers['x-padded']).toBe('value');
  });
});

describe('XHRAdapter - PR review round 74', () => {
  test('PR review round 74: the bytes it is handed are given to xhr.send() before send() returns, which copies them there', async () => {
    const body = new Uint8Array([1, 2, 3, 4]);
    const promise = new XHRAdapter().send({
      requestURL: 'https://api.test/upload',
      method: 'POST',
      headers: {},
      body,
    });

    // Read before anything is awaited: the client hands a built-in adapter the request's
    // bytes uncopied, relying on `XMLHttpRequest.send()` copying them as it is called.
    expect(lastXHR.sentBody).toBe(body);

    lastXHR.status = 204;
    lastXHR.simulateLoad();
    expect((await promise).status).toBe(204);
  });
});

describe('XHRAdapter - PR review round 82', () => {
  test('PR review round 82: response header lines ended with a bare LF are read as CRLF ones are', async () => {
    const promise = new XHRAdapter().send({
      requestURL: 'https://api.test/start',
      method: 'GET',
      headers: {},
    });
    lastXHR.status = 302;
    lastXHR.responseURL = 'https://api.test/start';
    lastXHR.response = textBody('');
    lastXHR.getAllResponseHeadersResult =
      'content-type: text/plain\nset-cookie: a=1\nset-cookie: b=2\nlocation: /next\n';
    lastXHR.simulateLoad();
    const response = await promise;

    expect(response.headers).toEqual({
      'content-type': 'text/plain',
      'set-cookie': ['a=1', 'b=2'],
      location: '/next',
    });
    expect(response.wasRedirectDetected).toBe(true);
    expect(response.detectedRedirectURL).toBe('https://api.test/next');
  });
});

describe('XHRAdapter - PR review round 83', () => {
  test('PR review round 83: a download counted past its declared length reports an unknown length, and the final event still fires at load', async () => {
    const downloadEvents: Array<{
      loaded: number;
      total: number;
      progress: number;
    }> = [];

    const promise = new XHRAdapter().send({
      requestURL: 'https://api.test/data',
      method: 'GET',
      headers: {},
      onDownloadProgress: (e) => downloadEvents.push(e),
    });

    // A gzip body counted decoded against its encoded Content-Length: it reaches the
    // total partway and counts on past it.
    lastXHR.simulateDownloadProgress(5120, 10240);
    lastXHR.simulateDownloadProgress(10240, 10240);
    lastXHR.simulateDownloadProgress(40960, 10240);
    lastXHR.status = 200;
    lastXHR.response = textBody('x'.repeat(40960));
    lastXHR.simulateLoad();
    await promise;

    expect(downloadEvents.every((e) => e.progress <= 1)).toBe(true);
    expect(downloadEvents[2]).toEqual({
      loaded: 40960,
      total: 40960,
      progress: -1,
    });
    expect(downloadEvents.slice(3)).toEqual([
      { loaded: 40960, total: 40960, progress: 1 },
    ]);
  });

  test('PR review round 83: an upload counted past its reported total reports an unknown length', async () => {
    const uploadEvents: Array<{
      loaded: number;
      total: number;
      progress: number;
    }> = [];

    const promise = new XHRAdapter().send({
      requestURL: 'https://api.test/data',
      method: 'POST',
      headers: {},
      body: 'payload',
      onUploadProgress: (e) => uploadEvents.push(e),
    });

    lastXHR.simulateUploadProgress(4, 2);
    lastXHR.status = 200;
    lastXHR.response = textBody('ok');
    lastXHR.simulateLoad();
    await promise;

    expect(uploadEvents).toContainEqual({ loaded: 4, total: 4, progress: -1 });
    expect(uploadEvents.every((e) => e.progress <= 1)).toBe(true);
  });
});
