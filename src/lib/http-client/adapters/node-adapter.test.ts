import { describe, expect, test, beforeAll, afterAll, spyOn } from 'bun:test';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as http from 'node:http';
import * as https from 'node:https';
import { Writable } from 'node:stream';
import { NodeAdapter } from './node-adapter';
import type { NodeAdapterConfig } from './node-adapter';
import { HTTPClient } from '../http-client';
import { CookieJar } from '../cookie-jar';
import {
  NON_RETRYABLE_HTTP_CLIENT_CALLBACK_ERROR_FLAG,
  RESPONSE_STREAM_ABORT_FLAG,
  STREAM_FACTORY_ERROR_FLAG,
} from '../consts';
import type {
  AdapterRequest,
  AdapterResponse,
  HTTPAdapter,
  StreamResponseInfo,
  WritableLike,
} from '../types';
import { startTestServer } from '../test-helpers/test-server';
import type { TestServer } from '../test-helpers/test-server';
import {
  startTlsTestServer,
  startTlsTestServerDnsOnly,
  startTlsTestServerWith,
  getRevocationFixtures,
  detectCRLEnforcement,
  getTestCACert,
} from '../test-helpers/https-test-server';
import type { TlsTestServer } from '../test-helpers/https-test-server';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeClient(
  config: NodeAdapterConfig = {},
  baseURL?: string,
  extra: Record<string, unknown> = {},
) {
  return new HTTPClient({
    adapter: new NodeAdapter(config),
    baseURL: baseURL ?? '',
    ...extra,
  });
}

// Minimal AdapterRequest for low-level adapter.send() tests. Unlike the mock
// adapter, NodeAdapter requires a full URL (it calls new URL(requestURL)) so
// these tests pass the server URL at construction time and splice it in here.
function makeAdapterRequest(
  url: string,
  overrides: Partial<AdapterRequest> = {},
): AdapterRequest {
  return {
    requestURL: url,
    method: 'GET',
    headers: {},
    body: null,
    ...overrides,
  };
}

// In-memory Writable that satisfies WritableLike. Used to capture streamed
// bytes without touching the filesystem. Node's Writable satisfies the
// structural WritableLike interface (write/end/once/on) so it can be returned
// directly from a streamResponse factory. Arrow functions prevent
// `unbound-method` lint errors when members are destructured.
function makeMemoryWritable() {
  const chunks: Buffer[] = [];

  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      callback();
    },
  });

  return {
    stream,
    getBytes: () => Buffer.concat(chunks),
  };
}

// Writable that errors after receiving the specified number of bytes. Used to
// test the isStreamError path (disk full, stream destroyed mid-download, etc.)
function makeErrorWritable(errorAfterBytes: number) {
  let received = 0;

  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      if (received >= errorAfterBytes) {
        callback(new Error('Simulated write failure (disk full)'));
      } else {
        callback();
      }
    },
  });
}

class MockClientRequest extends EventEmitter {
  public destroyed = false;
  public headers: Record<string, string> = {};
  public ended = false;
  private _writeImpl: (
    data: string | Buffer | Uint8Array,
    callback?: (error: Error | null | undefined) => void,
  ) => boolean;

  constructor(
    writeImpl: (
      data: string | Buffer | Uint8Array,
      callback?: (error: Error | null | undefined) => void,
    ) => boolean = (_data, callback) => {
      callback?.(null);
      return true;
    },
  ) {
    super();
    this._writeImpl = writeImpl;
  }

  public setHeader(name: string, value: string): void {
    this.headers[name.toLowerCase()] = value;
  }

  public getHeaders(): Record<string, string> {
    return { ...this.headers };
  }

  public write(
    data: string | Buffer | Uint8Array,
    callback?: (error: Error | null | undefined) => void,
  ): boolean {
    return this._writeImpl(data, callback);
  }

  public end(): void {
    this.ended = true;
  }

  public destroy(): this {
    this.destroyed = true;
    return this;
  }
}

class MockIncomingMessage extends EventEmitter {
  public statusCode: number;
  public headers: http.IncomingHttpHeaders;
  public pauseCalls = 0;
  public resumeCalls = 0;

  constructor(
    statusCode = 200,
    headers: http.IncomingHttpHeaders = { 'content-type': 'text/plain' },
  ) {
    super();
    this.statusCode = statusCode;
    this.headers = headers;
  }

  public pause(): void {
    this.pauseCalls++;
  }

  public resume(): void {
    this.resumeCalls++;
  }
}

// ---------------------------------------------------------------------------
// HTTPClient-level tests (primary — reflects real usage)
// ---------------------------------------------------------------------------

describe('NodeAdapter observer request headers', () => {
  test('response observers see adapter-added effective request headers', async () => {
    let capturedAdapterHeaders: Record<string, string | string[]> | undefined;
    let observedHeaders: Record<string, string | string[]> | undefined;

    const adapter: HTTPAdapter = {
      getType: () => 'mock',
      send: (request: AdapterRequest): Promise<AdapterResponse> => {
        capturedAdapterHeaders = { ...request.headers };

        return Promise.resolve({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode('{"ok":true}'),
          effectiveRequestHeaders: {
            ...request.headers,
            'content-type': 'multipart/form-data; boundary=test-boundary',
            'content-length': '123',
          },
        });
      },
    };

    const client = new HTTPClient({ adapter });
    client.addResponseObserver((_response, request) => {
      observedHeaders = { ...request.headers };
    });

    const fd = new FormData();
    fd.append('field', 'value');

    await client.post('https://example.com/upload').formData(fd).send();

    expect(capturedAdapterHeaders?.['content-type']).toBeUndefined();
    expect(capturedAdapterHeaders?.['content-length']).toBeUndefined();
    expect(observedHeaders?.['content-type']).toBe(
      'multipart/form-data; boundary=test-boundary',
    );
    expect(observedHeaders?.['content-length']).toBe('123');
  });

  test('cancelled response-stream aborts still pass effective request headers to error observers', async () => {
    let observedHeaders: Record<string, string | string[]> | undefined;
    const controller = new AbortController();

    const adapter: HTTPAdapter = {
      getType: () => 'node',
      send: (request: AdapterRequest): Promise<AdapterResponse> => {
        const abortError = new Error(
          'Request aborted during response streaming',
        );
        abortError.name = 'AbortError';
        Object.assign(abortError, {
          [RESPONSE_STREAM_ABORT_FLAG]: true,
          effectiveRequestHeaders: {
            ...request.headers,
            'content-type': 'multipart/form-data; boundary=simulated',
            'content-length': '999',
          },
        });

        controller.abort();
        return Promise.reject(abortError);
      },
    };

    const client = new HTTPClient({ adapter });
    client.addErrorObserver((_err, req) => {
      observedHeaders = { ...req.headers };
    });

    const res = await client
      .post('https://example.com/upload')
      .signal(controller.signal)
      .send();

    expect(res.isCancelled).toBe(true);
    expect(res.isFailed).toBe(true);
    expect(observedHeaders?.['content-type']).toBe(
      'multipart/form-data; boundary=simulated',
    );
    expect(observedHeaders?.['content-length']).toBe('999');
  });

  test('response-stream aborts without stream metadata are not misclassified as user cancellation', async () => {
    const adapter: HTTPAdapter = {
      getType: () => 'node',
      send: (): Promise<AdapterResponse> => {
        const abortError = new Error(
          'Request aborted during response streaming',
        );
        abortError.name = 'AbortError';
        Object.assign(abortError, {
          [RESPONSE_STREAM_ABORT_FLAG]: true,
        });
        return Promise.reject(abortError);
      },
    };

    const client = new HTTPClient({ adapter });
    const builder = client.get('https://example.com/download');
    const res = await builder.send();

    expect(res.isCancelled).toBe(false);
    expect(res.isFailed).toBe(true);
    expect(res.isStreamError).toBe(true);
    expect(builder.error?.code).toBe('stream_response_error');
  });
});

describe('post-header stream aborts report why the retry stopped', () => {
  const policy = {
    strategy: 'fixed' as const,
    maxRetryAttempts: 2,
    delayMS: 1,
  };

  /** Rejects the way NodeAdapter does when a stream aborts after headers. */
  function abortingAdapter(metadata?: {
    status: number;
    headers: Record<string, string | string[]>;
  }): HTTPAdapter {
    return {
      getType: () => 'node',
      send: (): Promise<AdapterResponse> => {
        const abortError = new Error(
          'Request aborted during response streaming',
        );
        abortError.name = 'AbortError';
        Object.assign(abortError, {
          [RESPONSE_STREAM_ABORT_FLAG]: true,
          ...(metadata
            ? {
                streamAbortStatus: metadata.status,
                streamAbortHeaders: metadata.headers,
              }
            : {}),
        });

        return Promise.reject(abortError);
      },
    };
  }

  test('names the stream failure when no metadata came back', async () => {
    const client = new HTTPClient({
      adapter: abortingAdapter(),
      retryPolicy: policy,
    });

    const reasons: Array<string | undefined> = [];

    await client
      .get('https://example.com/download')
      .onAttemptEnd((e) => reasons.push(e.retrySuppressedReason))
      .send();

    // This path throws out of the adapter rather than resolving a response, so
    // it misses the suppression bookkeeping the resolved path does — but it is
    // still a stream failure, and status 0 would otherwise be retryable.
    expect(reasons).toEqual(['stream_error']);
  });

  test('names the stream failure when a real status came back', async () => {
    const client = new HTTPClient({
      adapter: abortingAdapter({ status: 500, headers: {} }),
      retryPolicy: policy,
    });

    const reasons: Array<string | undefined> = [];

    const res = await client
      .get('https://example.com/download')
      .onAttemptEnd((e) => reasons.push(e.retrySuppressedReason))
      .send();

    expect(res.status).toBe(500);
    expect(reasons).toEqual(['stream_error']);
  });

  test('stores Set-Cookie from the response that then aborted', async () => {
    const jar = new CookieJar();

    const client = new HTTPClient({
      adapter: abortingAdapter({
        status: 200,
        headers: { 'set-cookie': 'session=abc123; Path=/' },
      }),
      cookieJar: jar,
    });

    await client.get('https://example.com/download').send();

    // Headers arrived, so a real response carried this cookie. Dropping it
    // would make the jar depend on whether the failure resolved or threw.
    expect(jar.getCookieHeaderString('https://example.com/next')).toBe(
      'session=abc123',
    );
  });

  test('is absent with no retry policy, since nothing was suppressed', async () => {
    const client = new HTTPClient({ adapter: abortingAdapter() });

    const reasons: Array<string | undefined> = [];

    await client
      .get('https://example.com/download')
      .onAttemptEnd((e) => reasons.push(e.retrySuppressedReason))
      .send();

    expect(reasons).toEqual([undefined]);
  });
});

describe('NodeAdapter streamResponse factory failures', () => {
  test('streamResponse on other adapters becomes request_setup_error', async () => {
    const adapter: HTTPAdapter = {
      getType: () => 'mock',
      send: (): Promise<AdapterResponse> =>
        Promise.resolve({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode('{"ok":true}'),
        }),
    };

    const client = new HTTPClient({ adapter });
    const finalErrorCodes: string[] = [];
    client.addErrorObserver((error) => {
      finalErrorCodes.push(error.code);
    });

    // Returning null would mean "cancel" on NodeAdapter, but this callback is
    // never reached here. The failure is using streamResponse with a non-node
    // adapter, which the client rejects during request setup.
    const builder = client
      .get('https://example.com/test')
      .streamResponse(() => null);

    const res = await builder.send();

    expect(res.status).toBe(0);
    expect(res.isFailed).toBe(true);
    expect(builder.state).toBe('failed');
    expect(builder.error?.code).toBe('request_setup_error');
    expect(builder.error?.cause?.message).toMatch(
      /streamResponse.*NodeAdapter/i,
    );
    expect(finalErrorCodes).toEqual(['request_setup_error']);
  });

  test('streamResponse factory throw is not retried and is classified as stream_setup_error', async () => {
    let adapterCalls = 0;
    const retryOutcomes: Array<{ code: string; attempt: number }> = [];
    const finalCodes: string[] = [];

    const adapter: HTTPAdapter = {
      getType: () => 'node',
      send: async (request: AdapterRequest): Promise<AdapterResponse> => {
        adapterCalls++;

        try {
          await request.streamResponse?.(
            {
              status: 200,
              headers: { 'content-type': 'application/octet-stream' },
              url: request.requestURL,
              attempt: request.attemptNumber ?? 1,
              requestID: request.requestID ?? '',
            },
            { signal: new AbortController().signal },
          );
        } catch (error) {
          const normalized =
            error instanceof Error ? error : new Error(String(error));
          const tagged = normalized as Error &
            Partial<
              Record<
                typeof NON_RETRYABLE_HTTP_CLIENT_CALLBACK_ERROR_FLAG,
                boolean
              >
            >;
          tagged[NON_RETRYABLE_HTTP_CLIENT_CALLBACK_ERROR_FLAG] = true;
          Object.assign(normalized, { [STREAM_FACTORY_ERROR_FLAG]: true });
          throw normalized;
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
      retryPolicy: { strategy: 'fixed', maxRetryAttempts: 2, delayMS: 10 },
    });

    client.addErrorObserver((err) => {
      finalCodes.push(err.code);
    });
    client.addErrorObserver(
      (err, _req, phase) => {
        if (phase.type === 'retry') {
          retryOutcomes.push({ code: err.code, attempt: phase.attempt });
        }
      },
      { phases: ['retry'] },
    );

    const builder = client
      .get('https://example.com/stream')
      .streamResponse(() => {
        throw new Error('factory failed: no space left on device');
      });

    const res = await builder.send();

    expect(adapterCalls).toBe(1);
    expect(res.status).toBe(0);
    expect(res.isFailed).toBe(true);
    expect(builder.error?.code).toBe('stream_setup_error');
    expect(builder.error?.cause?.message).toBe(
      'factory failed: no space left on device',
    );
    expect(finalCodes).toEqual(['stream_setup_error']);
    expect(retryOutcomes).toEqual([]);
  });

  test('streamResponse factory throw passes effective request headers to error observers', async () => {
    let observedHeaders: Record<string, string | string[]> | undefined;

    const adapter: HTTPAdapter = {
      getType: () => 'node',
      send: async (request: AdapterRequest): Promise<AdapterResponse> => {
        try {
          await request.streamResponse?.(
            {
              status: 200,
              headers: { 'content-type': 'application/octet-stream' },
              url: request.requestURL,
              attempt: request.attemptNumber ?? 1,
              requestID: request.requestID ?? '',
            },
            { signal: new AbortController().signal },
          );
        } catch (error) {
          const normalized =
            error instanceof Error ? error : new Error(String(error));
          const tagged = normalized as Error &
            Partial<
              Record<
                typeof NON_RETRYABLE_HTTP_CLIENT_CALLBACK_ERROR_FLAG,
                boolean
              >
            >;
          tagged[NON_RETRYABLE_HTTP_CLIENT_CALLBACK_ERROR_FLAG] = true;
          Object.assign(normalized, { [STREAM_FACTORY_ERROR_FLAG]: true });
          Object.assign(normalized, {
            effectiveRequestHeaders: {
              ...request.headers,
              'content-type': 'multipart/form-data; boundary=simulated',
              'content-length': '999',
            },
          });
          throw normalized;
        }

        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode('{"ok":true}'),
        };
      },
    };

    const client = new HTTPClient({ adapter });
    client.addErrorObserver((_err, req) => {
      observedHeaders = { ...req.headers };
    });

    await client
      .get('https://example.com/stream')
      .streamResponse(() => {
        throw new Error('factory failed');
      })
      .send();

    expect(observedHeaders?.['content-type']).toBe(
      'multipart/form-data; boundary=simulated',
    );
    expect(observedHeaders?.['content-length']).toBe('999');
  });

  test('factory throw on a retry attempt is still stream_setup_error and not retried further', async () => {
    // Attempt 1: adapter returns 503 (retryable) — factory is skipped because
    // status !== 200. Attempt 2: adapter returns 200 and invokes the factory,
    // which throws. Should emit stream_setup_error and stop immediately
    // without a third attempt.
    let adapterCalls = 0;
    const retryStatuses: number[] = [];
    const finalCodes: string[] = [];

    const adapter: HTTPAdapter = {
      getType: () => 'node',
      send: async (request: AdapterRequest): Promise<AdapterResponse> => {
        adapterCalls++;

        if (adapterCalls === 1) {
          return {
            status: 503,
            headers: { 'content-type': 'application/json' },
            body: new TextEncoder().encode('{"error":"unavailable"}'),
          };
        }

        // Attempt 2: 200 — invoke the factory
        try {
          await request.streamResponse?.(
            {
              status: 200,
              headers: { 'content-type': 'application/octet-stream' },
              url: request.requestURL,
              attempt: request.attemptNumber ?? 2,
              requestID: request.requestID ?? '',
            },
            { signal: new AbortController().signal },
          );
        } catch (error) {
          const normalized =
            error instanceof Error ? error : new Error(String(error));
          const tagged = normalized as Error &
            Partial<
              Record<
                typeof NON_RETRYABLE_HTTP_CLIENT_CALLBACK_ERROR_FLAG,
                boolean
              >
            >;
          tagged[NON_RETRYABLE_HTTP_CLIENT_CALLBACK_ERROR_FLAG] = true;
          Object.assign(normalized, { [STREAM_FACTORY_ERROR_FLAG]: true });
          throw normalized;
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
      retryPolicy: { strategy: 'fixed', maxRetryAttempts: 2, delayMS: 10 },
    });

    client.addResponseObserver(
      (response) => {
        retryStatuses.push(response.status);
      },
      { phases: ['retry'] },
    );

    client.addErrorObserver(
      (err) => {
        finalCodes.push(err.code);
      },
      { phases: ['final'] },
    );

    const builder = client
      .get('https://example.com/stream')
      .streamResponse(() => {
        throw new Error('factory failed: no space left on device');
      });

    const res = await builder.send();

    // The 503 on attempt 1 fires the retry response observer — confirms the
    // retry happened and the factory was not invoked on that attempt.
    expect(retryStatuses).toEqual([503]);
    // adapterCalls === 2 confirms attempt 2 ran; factory throw stops it there.
    expect(adapterCalls).toBe(2);
    expect(res.status).toBe(0);
    expect(res.isFailed).toBe(true);
    expect(builder.error?.code).toBe('stream_setup_error');
    expect(builder.error?.cause?.message).toBe(
      'factory failed: no space left on device',
    );
    expect(finalCodes).toEqual(['stream_setup_error']);
  });

  test('stream write failures stay on the failed path even with status 200', async () => {
    const adapter: HTTPAdapter = {
      getType: () => 'node',
      send: (_request: AdapterRequest): Promise<AdapterResponse> =>
        Promise.resolve({
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
          body: null,
          isStreamError: true,
          errorCause: new Error('disk full'),
        }),
    };

    const client = new HTTPClient({ adapter });
    const finalErrorCodes: string[] = [];
    client.addErrorObserver((error) => {
      finalErrorCodes.push(error.code);
    });

    const builder = client
      .get('https://example.com/binary')
      .streamResponse(() => {
        throw new Error('unreachable');
      });

    const res = await builder.send();

    expect(res.status).toBe(200);
    expect(res.isStreamError).toBe(true);
    expect(res.isCancelled).toBe(false);
    expect(res.isFailed).toBe(true);
    expect(builder.state).toBe('failed');
    expect(builder.error?.code).toBe('stream_write_error');
    expect(builder.error?.cause?.message).toBe('disk full');
    expect(finalErrorCodes).toEqual(['stream_write_error']);
  });

  test('resolved stream errors with status 0 are terminal and are not retried', async () => {
    let adapterCalls = 0;
    const retryErrorCodes: string[] = [];
    const finalErrorCodes: string[] = [];

    const adapter: HTTPAdapter = {
      getType: () => 'node',
      send: (): Promise<AdapterResponse> => {
        adapterCalls++;
        return Promise.resolve({
          status: 0,
          headers: {},
          body: null,
          isStreamError: true,
          streamErrorCode: 'stream_response_error',
          errorCause: new Error('stream aborted after headers'),
        });
      },
    };

    const client = new HTTPClient({
      adapter,
      retryPolicy: { strategy: 'fixed', maxRetryAttempts: 2, delayMS: 10 },
    });

    client.addErrorObserver(
      (error) => {
        retryErrorCodes.push(error.code);
      },
      { phases: ['retry'] },
    );
    client.addErrorObserver((error) => {
      finalErrorCodes.push(error.code);
    });

    const builder = client.get('https://example.com/stream');
    const res = await builder.send();

    expect(adapterCalls).toBe(1);
    expect(retryErrorCodes).toEqual([]);
    expect(res.status).toBe(0);
    expect(res.isFailed).toBe(true);
    expect(res.isStreamError).toBe(true);
    expect(builder.error?.code).toBe('stream_response_error');
    expect(finalErrorCodes).toEqual(['stream_response_error']);
  });
});

describe('NodeAdapter.send() — unit branches without server', () => {
  test('materializes repeated Cookie headers before calling http.request', async () => {
    const req = new MockClientRequest();
    let capturedOptions: http.RequestOptions | undefined;
    const requestSpy = spyOn(http, 'request').mockImplementation(
      (options, _callback) => {
        capturedOptions = options as http.RequestOptions;
        queueMicrotask(() => {
          req.emit('error', new Error('stop after options capture'));
        });
        return req as unknown as http.ClientRequest;
      },
    );

    try {
      await new NodeAdapter().send({
        requestURL: 'http://example.test/data',
        method: 'GET',
        headers: { cookie: ['session=abc123', 'theme=dark'] },
      });

      expect(capturedOptions?.headers).toMatchObject({
        cookie: 'session=abc123; theme=dark',
      });
    } finally {
      requestSpy.mockRestore();
    }
  });

  test('unix socket requests preserve the URL host for Host header generation', async () => {
    const req = new MockClientRequest();
    let capturedOptions: http.RequestOptions | undefined;
    const requestSpy = spyOn(http, 'request').mockImplementation(
      (options, _callback) => {
        capturedOptions = options as http.RequestOptions;
        queueMicrotask(() => {
          req.emit('error', new Error('stop after options capture'));
        });
        return req as unknown as http.ClientRequest;
      },
    );

    try {
      await new NodeAdapter({ socketPath: '/tmp/test.sock' }).send({
        requestURL: 'http://example.test:8080/data?x=1',
        method: 'GET',
        headers: {},
      });

      expect(capturedOptions?.socketPath).toBe('/tmp/test.sock');
      expect(capturedOptions?.hostname).toBe('example.test');
      expect(capturedOptions?.port).toBe(8080);
      expect(capturedOptions?.path).toBe('/data?x=1');
    } finally {
      requestSpy.mockRestore();
    }
  });

  test('literal IPv6 URLs strip brackets before reaching http.request', async () => {
    const req = new MockClientRequest();
    let capturedOptions: http.RequestOptions | undefined;
    const requestSpy = spyOn(http, 'request').mockImplementation(
      (options, _callback) => {
        capturedOptions = options as http.RequestOptions;
        queueMicrotask(() => {
          req.emit('error', new Error('stop after options capture'));
        });
        return req as unknown as http.ClientRequest;
      },
    );

    try {
      await new NodeAdapter().send({
        requestURL: 'http://[::1]:8080/data?x=1',
        method: 'GET',
        headers: {},
      });

      expect(capturedOptions?.hostname).toBe('::1');
      expect(capturedOptions?.port).toBe(8080);
      expect(capturedOptions?.path).toBe('/data?x=1');
    } finally {
      requestSpy.mockRestore();
    }
  });

  test('percent-encoded URL credentials are decoded before reaching http.request', async () => {
    const req = new MockClientRequest();
    let capturedOptions: http.RequestOptions | undefined;
    const requestSpy = spyOn(http, 'request').mockImplementation(
      (options, _callback) => {
        capturedOptions = options as http.RequestOptions;
        queueMicrotask(() => {
          req.emit('error', new Error('stop after options capture'));
        });
        return req as unknown as http.ClientRequest;
      },
    );

    try {
      await new NodeAdapter().send({
        requestURL: 'http://us%3Aer:p%40ss@example.test/data',
        method: 'GET',
        headers: {},
      });

      expect(capturedOptions?.auth).toBe('us:er:p@ss');
    } finally {
      requestSpy.mockRestore();
    }
  });

  test('3xx response resolves detectedRedirectURL for relative locations', async () => {
    const req = new MockClientRequest();
    const res = new MockIncomingMessage(302, {
      location: '/next',
      'content-type': 'text/plain',
    });
    const requestSpy = spyOn(http, 'request').mockImplementation(
      (_options, callback) => {
        const cb = callback as
          ((res: http.IncomingMessage) => void) | undefined;
        queueMicrotask(() => {
          cb?.(res as unknown as http.IncomingMessage);
          queueMicrotask(() => {
            res.emit('end');
          });
        });
        return req as unknown as http.ClientRequest;
      },
    );

    try {
      const result = await new NodeAdapter().send({
        requestURL: 'http://example.test/start',
        method: 'GET',
        headers: {},
      });

      expect(result.wasRedirectDetected).toBe(true);
      expect(result.detectedRedirectURL).toBe('http://example.test/next');
    } finally {
      requestSpy.mockRestore();
    }
  });

  test('3xx response preserves absolute detectedRedirectURL', async () => {
    const req = new MockClientRequest();
    const res = new MockIncomingMessage(302, {
      location: 'https://other.test/next',
      'content-type': 'text/plain',
    });
    const requestSpy = spyOn(http, 'request').mockImplementation(
      (_options, callback) => {
        const cb = callback as
          ((res: http.IncomingMessage) => void) | undefined;
        queueMicrotask(() => {
          cb?.(res as unknown as http.IncomingMessage);
          queueMicrotask(() => {
            res.emit('end');
          });
        });
        return req as unknown as http.ClientRequest;
      },
    );

    try {
      const result = await new NodeAdapter().send({
        requestURL: 'http://example.test/start',
        method: 'GET',
        headers: {},
      });

      expect(result.wasRedirectDetected).toBe(true);
      expect(result.detectedRedirectURL).toBe('https://other.test/next');
    } finally {
      requestSpy.mockRestore();
    }
  });

  test('FormData serialization write failure resolves status 0 without a replay claim', async () => {
    const req = new MockClientRequest((_data, callback) => {
      callback?.(new Error('write failed'));
      return true;
    });

    const requestSpy = spyOn(http, 'request').mockImplementation(
      (_options, _callback) => req as unknown as http.ClientRequest,
    );

    try {
      const fd = new FormData();
      fd.append('field', 'value');

      const res = await new NodeAdapter().send({
        requestURL: 'http://example.test/upload',
        method: 'POST',
        headers: {},
        body: fd,
      });

      expect(res.status).toBe(0);
      expect(res.isTransportError).toBe(true);
      // Neither replay signal: delivery is unproven rather than disproven, so
      // the client's method rule decides. A blanket veto here would also stop
      // retrying an idempotent PUT or DELETE.
      expect(res.isRetryable).toBeUndefined();
      expect(res.wasDefinitelyNotSent).toBeUndefined();
      expect(res.errorCause?.message).toBe('write failed');
      expect(req.destroyed).toBe(true);
      expect(req.headers['content-type']).toContain('multipart/form-data');
      expect(req.headers['content-length']).toBeDefined();
    } finally {
      requestSpy.mockRestore();
    }
  });

  test('FormData upload abort rejects with AbortError even if a write is in flight', async () => {
    let pendingCallback:
      ((error: Error | null | undefined) => void) | undefined;

    const req = new MockClientRequest((_data, callback) => {
      pendingCallback = callback;
      return true;
    });

    const requestSpy = spyOn(http, 'request').mockImplementation(
      (_options, _callback) => req as unknown as http.ClientRequest,
    );

    try {
      const fd = new FormData();
      fd.append(
        'file',
        new File([new Uint8Array(32 * 1024)], 'upload.bin', {
          type: 'application/octet-stream',
        }),
      );

      const controller = new AbortController();
      const sendPromise = new NodeAdapter().send({
        requestURL: 'http://example.test/upload',
        method: 'POST',
        headers: {},
        body: fd,
        signal: controller.signal,
      });

      expect(pendingCallback).toBeDefined();
      controller.abort();

      // Let the in-flight write finish after the abort to confirm the adapter
      // still classifies the request as cancelled rather than a write failure.
      pendingCallback?.(null);

      let caught: Error | undefined;
      try {
        await sendPromise;
      } catch (error) {
        caught = error as Error;
      }

      expect(caught?.name).toBe('AbortError');
      expect(req.destroyed).toBe(true);
    } finally {
      requestSpy.mockRestore();
    }
  });

  test('chunked string body write failure resolves status 0 without a replay claim', async () => {
    const req = new MockClientRequest((_data, callback) => {
      callback?.(new Error('write failed'));
      return true;
    });
    const requestSpy = spyOn(http, 'request').mockImplementation(
      (_options, _callback) => req as unknown as http.ClientRequest,
    );

    try {
      const res = await new NodeAdapter().send({
        requestURL: 'http://example.test/upload',
        method: 'POST',
        headers: {},
        body: 'payload',
      });

      expect(res.status).toBe(0);
      expect(res.isTransportError).toBe(true);
      // Neither replay signal: delivery is unproven rather than disproven, so
      // the client's method rule decides. A blanket veto here would also stop
      // retrying an idempotent PUT or DELETE.
      expect(res.isRetryable).toBeUndefined();
      expect(res.wasDefinitelyNotSent).toBeUndefined();
      expect(res.errorCause?.message).toBe('write failed');
      expect(req.destroyed).toBe(true);
    } finally {
      requestSpy.mockRestore();
    }
  });

  test('chunked string body sets Content-Length before writing', async () => {
    const req = new MockClientRequest();
    const requestSpy = spyOn(http, 'request').mockImplementation(
      (_options, _callback) => req as unknown as http.ClientRequest,
    );

    try {
      const sendPromise = new NodeAdapter().send({
        requestURL: 'http://example.test/upload',
        method: 'POST',
        headers: {},
        body: 'payload',
      });

      expect(req.headers['content-length']).toBe(
        Buffer.byteLength('payload').toString(),
      );

      req.emit('error', new Error('stop after header assertion'));
      await sendPromise;
    } finally {
      requestSpy.mockRestore();
    }
  });

  test('chunked Uint8Array body sets Content-Length before writing', async () => {
    const req = new MockClientRequest();
    const body = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const requestSpy = spyOn(http, 'request').mockImplementation(
      (_options, _callback) => req as unknown as http.ClientRequest,
    );

    try {
      const sendPromise = new NodeAdapter().send({
        requestURL: 'http://example.test/upload',
        method: 'POST',
        headers: {},
        body,
      });

      expect(req.headers['content-length']).toBe(body.byteLength.toString());

      req.emit('error', new Error('stop after header assertion'));
      await sendPromise;
    } finally {
      requestSpy.mockRestore();
    }
  });

  test('chunked body reaches upload progress 1 before the response ends', async () => {
    const req = new MockClientRequest();
    const res = new MockIncomingMessage(200, {
      'content-type': 'application/json',
    });
    const uploadEvents: number[] = [];
    let markResponseReady: (() => void) | undefined;
    const responseReady = new Promise<void>((resolve) => {
      markResponseReady = resolve;
    });
    let responseCallback: ((res: http.IncomingMessage) => void) | undefined;
    const requestSpy = spyOn(http, 'request').mockImplementation(
      (_options, callback) => {
        responseCallback = callback as
          ((res: http.IncomingMessage) => void) | undefined;
        return req as unknown as http.ClientRequest;
      },
    );

    req.end = () => {
      req.ended = true;
      queueMicrotask(() => {
        responseCallback?.(res as unknown as http.IncomingMessage);
        markResponseReady?.();
      });
    };

    try {
      const sendPromise = new NodeAdapter().send({
        requestURL: 'http://example.test/upload',
        method: 'POST',
        headers: {},
        body: 'x'.repeat(32 * 1024),
        onUploadProgress: (e) => {
          uploadEvents.push(e.progress);
        },
      });

      await Promise.resolve();
      await Promise.resolve();

      expect(uploadEvents.length).toBeGreaterThan(1);
      expect(uploadEvents[uploadEvents.length - 1]).toBe(1);

      await responseReady;
      res.emit('data', Buffer.from('{"ok":true}'));
      res.emit('end');

      await sendPromise;
    } finally {
      requestSpy.mockRestore();
    }
  });

  test('empty string body still reaches upload progress 1 before the response ends', async () => {
    const req = new MockClientRequest();
    const res = new MockIncomingMessage(200, {
      'content-type': 'application/json',
    });
    const uploadEvents: number[] = [];
    let markResponseReady: (() => void) | undefined;
    const responseReady = new Promise<void>((resolve) => {
      markResponseReady = resolve;
    });
    let responseCallback: ((res: http.IncomingMessage) => void) | undefined;
    const requestSpy = spyOn(http, 'request').mockImplementation(
      (_options, callback) => {
        responseCallback = callback as
          ((res: http.IncomingMessage) => void) | undefined;
        return req as unknown as http.ClientRequest;
      },
    );

    req.end = () => {
      req.ended = true;
      queueMicrotask(() => {
        responseCallback?.(res as unknown as http.IncomingMessage);
        markResponseReady?.();
      });
    };

    try {
      const sendPromise = new NodeAdapter().send({
        requestURL: 'http://example.test/upload',
        method: 'POST',
        headers: {},
        body: '',
        onUploadProgress: (e) => {
          uploadEvents.push(e.progress);
        },
      });

      await Promise.resolve();
      await Promise.resolve();

      // Empty explicit bodies still go through the chunked writer path rather
      // than the no-body shortcut, so they need their own terminal 100% event.
      expect(uploadEvents).toEqual([0, 1]);

      await responseReady;
      res.emit('data', Buffer.from('{"ok":true}'));
      res.emit('end');

      await sendPromise;
    } finally {
      requestSpy.mockRestore();
    }
  });

  test('empty Uint8Array body still reaches upload progress 1 before the response ends', async () => {
    const req = new MockClientRequest();
    const res = new MockIncomingMessage(200, {
      'content-type': 'application/json',
    });
    const uploadEvents: number[] = [];
    let markResponseReady: (() => void) | undefined;
    const responseReady = new Promise<void>((resolve) => {
      markResponseReady = resolve;
    });
    let responseCallback: ((res: http.IncomingMessage) => void) | undefined;
    const requestSpy = spyOn(http, 'request').mockImplementation(
      (_options, callback) => {
        responseCallback = callback as
          ((res: http.IncomingMessage) => void) | undefined;
        return req as unknown as http.ClientRequest;
      },
    );

    req.end = () => {
      req.ended = true;
      queueMicrotask(() => {
        responseCallback?.(res as unknown as http.IncomingMessage);
        markResponseReady?.();
      });
    };

    try {
      const sendPromise = new NodeAdapter().send({
        requestURL: 'http://example.test/upload',
        method: 'POST',
        headers: {},
        body: new Uint8Array(0),
        onUploadProgress: (e) => {
          uploadEvents.push(e.progress);
        },
      });

      await Promise.resolve();
      await Promise.resolve();

      expect(uploadEvents).toEqual([0, 1]);

      await responseReady;
      res.emit('data', Buffer.from('{"ok":true}'));
      res.emit('end');

      await sendPromise;
    } finally {
      requestSpy.mockRestore();
    }
  });

  test('non-empty Uint8Array body reaches upload progress 1 before the response ends', async () => {
    const req = new MockClientRequest();
    const res = new MockIncomingMessage(200, {
      'content-type': 'application/json',
    });
    const uploadEvents: number[] = [];
    let markResponseReady: (() => void) | undefined;
    const responseReady = new Promise<void>((resolve) => {
      markResponseReady = resolve;
    });
    let responseCallback: ((res: http.IncomingMessage) => void) | undefined;
    const requestSpy = spyOn(http, 'request').mockImplementation(
      (_options, callback) => {
        responseCallback = callback as
          ((res: http.IncomingMessage) => void) | undefined;
        return req as unknown as http.ClientRequest;
      },
    );

    req.end = () => {
      req.ended = true;
      queueMicrotask(() => {
        responseCallback?.(res as unknown as http.IncomingMessage);
        markResponseReady?.();
      });
    };

    try {
      const sendPromise = new NodeAdapter().send({
        requestURL: 'http://example.test/upload',
        method: 'POST',
        headers: {},
        body: new Uint8Array(32 * 1024),
        onUploadProgress: (e) => {
          uploadEvents.push(e.progress);
        },
      });

      await Promise.resolve();
      await Promise.resolve();

      expect(uploadEvents.length).toBeGreaterThan(1);
      expect(uploadEvents[uploadEvents.length - 1]).toBe(1);

      await responseReady;
      res.emit('data', Buffer.from('{"ok":true}'));
      res.emit('end');

      await sendPromise;
    } finally {
      requestSpy.mockRestore();
    }
  });

  test('multipart body reaches upload progress 1 before the response ends', async () => {
    const req = new MockClientRequest();
    const res = new MockIncomingMessage(200, {
      'content-type': 'application/json',
    });
    const uploadEvents: number[] = [];
    let markResponseReady: (() => void) | undefined;
    const responseReady = new Promise<void>((resolve) => {
      markResponseReady = resolve;
    });
    let responseCallback: ((res: http.IncomingMessage) => void) | undefined;
    const requestSpy = spyOn(http, 'request').mockImplementation(
      (_options, callback) => {
        responseCallback = callback as
          ((res: http.IncomingMessage) => void) | undefined;
        return req as unknown as http.ClientRequest;
      },
    );

    req.end = () => {
      req.ended = true;
      queueMicrotask(() => {
        responseCallback?.(res as unknown as http.IncomingMessage);
        markResponseReady?.();
      });
    };

    try {
      const fd = new FormData();
      fd.append('field', 'value');

      const sendPromise = new NodeAdapter().send({
        requestURL: 'http://example.test/upload',
        method: 'POST',
        headers: {},
        body: fd,
        onUploadProgress: (e) => {
          uploadEvents.push(e.progress);
        },
      });

      await Promise.resolve();
      await Promise.resolve();

      expect(uploadEvents.length).toBeGreaterThan(0);
      expect(uploadEvents[uploadEvents.length - 1]).toBe(1);

      await responseReady;
      res.emit('data', Buffer.from('{"ok":true}'));
      res.emit('end');

      await sendPromise;
    } finally {
      requestSpy.mockRestore();
    }
  });

  test('no-body request reaches upload progress 1 before the response ends', async () => {
    const req = new MockClientRequest();
    const res = new MockIncomingMessage(200, {
      'content-type': 'application/json',
    });
    const uploadEvents: number[] = [];
    let responseCallback: ((res: http.IncomingMessage) => void) | undefined;
    const requestSpy = spyOn(http, 'request').mockImplementation(
      (_options, callback) => {
        responseCallback = callback as
          ((res: http.IncomingMessage) => void) | undefined;
        return req as unknown as http.ClientRequest;
      },
    );

    req.end = () => {
      req.ended = true;
      queueMicrotask(() => {
        responseCallback?.(res as unknown as http.IncomingMessage);
      });
    };

    try {
      const sendPromise = new NodeAdapter().send({
        requestURL: 'http://example.test/data',
        method: 'GET',
        headers: {},
        onUploadProgress: (e) => {
          uploadEvents.push(e.progress);
        },
      });

      await Promise.resolve();

      expect(uploadEvents).toEqual([0, 1]);

      res.emit('data', Buffer.from('{"ok":true}'));
      res.emit('end');

      await sendPromise;
    } finally {
      requestSpy.mockRestore();
    }
  });

  test('failed upload can report partial progress before write failure', async () => {
    let writeCount = 0;
    const req = new MockClientRequest((_data, callback) => {
      writeCount++;

      if (writeCount === 1) {
        callback?.(null);
      } else {
        callback?.(new Error('write failed after partial upload'));
      }

      return true;
    });
    const uploadEvents: number[] = [];
    const requestSpy = spyOn(http, 'request').mockImplementation(
      (_options, _callback) => req as unknown as http.ClientRequest,
    );

    try {
      const res = await new NodeAdapter().send({
        requestURL: 'http://example.test/upload',
        method: 'POST',
        headers: {},
        body: 'x'.repeat(32 * 1024),
        onUploadProgress: (e) => {
          uploadEvents.push(e.progress);
        },
      });

      expect(res.status).toBe(0);
      expect(uploadEvents.length).toBeGreaterThan(1);
      expect(uploadEvents[uploadEvents.length - 1]).toBeLessThan(1);
      expect(uploadEvents.some((progress) => progress > 0)).toBe(true);
    } finally {
      requestSpy.mockRestore();
    }
  });

  test('buffered response stream error after headers resolves as stream_response_error', async () => {
    const req = new MockClientRequest();
    const res = new MockIncomingMessage(200, {
      'content-type': 'text/plain',
      'content-length': '3',
    });
    const requestSpy = spyOn(http, 'request').mockImplementation(
      (_options, callback) => {
        const cb = callback as
          ((res: http.IncomingMessage) => void) | undefined;
        queueMicrotask(() => {
          cb?.(res as unknown as http.IncomingMessage);
          queueMicrotask(() => {
            res.emit('error', new Error('simulated stream error'));
          });
        });
        return req as unknown as http.ClientRequest;
      },
    );

    try {
      const result = await new NodeAdapter().send({
        requestURL: 'http://example.test/data',
        method: 'GET',
        headers: {},
      });

      expect(result.status).toBe(200);
      expect(result.isStreamError).toBe(true);
      expect(result.streamErrorCode).toBe('stream_response_error');
      expect(result.body).toBeNull();
      expect(result.errorCause?.message).toBe('Response stream error');
      expect((result.errorCause?.cause as Error | undefined)?.message).toBe(
        'simulated stream error',
      );
    } finally {
      requestSpy.mockRestore();
    }
  });

  test('aborted buffered responses settle as stream_response_error', async () => {
    const req = new MockClientRequest();
    const res = new MockIncomingMessage(200, {
      'content-type': 'text/plain',
      'content-length': '10',
    });
    const requestSpy = spyOn(http, 'request').mockImplementation(
      (_options, callback) => {
        const cb = callback as
          ((res: http.IncomingMessage) => void) | undefined;
        queueMicrotask(() => {
          cb?.(res as unknown as http.IncomingMessage);
          queueMicrotask(() => {
            res.emit('data', Buffer.from('hello'));
            res.emit('aborted');
            res.emit('close');
          });
        });
        return req as unknown as http.ClientRequest;
      },
    );

    try {
      const result = await new NodeAdapter().send({
        requestURL: 'http://example.test/data',
        method: 'GET',
        headers: {},
      });

      expect(result.status).toBe(200);
      expect(result.isStreamError).toBe(true);
      expect(result.streamErrorCode).toBe('stream_response_error');
      expect(result.body).toBeNull();
      expect(result.errorCause?.message).toBe('Response stream aborted');
    } finally {
      requestSpy.mockRestore();
    }
  });

  test('TLS cert error resolves with status 495 and errorCause set', async () => {
    const certError = Object.assign(new Error('certificate has expired'), {
      code: 'CERT_HAS_EXPIRED',
    });

    const req = new MockClientRequest();
    const requestSpy = spyOn(http, 'request').mockImplementation(
      (_options, _callback) => {
        queueMicrotask(() => {
          req.emit('error', certError);
        });
        return req as unknown as http.ClientRequest;
      },
    );

    try {
      const res = await new NodeAdapter().send({
        requestURL: 'http://example.test/data',
        method: 'GET',
        headers: {},
      });

      expect(res.status).toBe(495);
      expect(res.isTransportError).toBe(true);
      expect(res.errorCause).toBe(certError);
    } finally {
      requestSpy.mockRestore();
    }
  });

  test('HTTPClient treats transport-marked 495 responses as failed requests', async () => {
    const certError = Object.assign(new Error('certificate has expired'), {
      code: 'CERT_HAS_EXPIRED',
    });
    const adapter: HTTPAdapter = {
      getType: () => 'node',
      send: (): Promise<AdapterResponse> =>
        Promise.resolve({
          status: 495,
          isTransportError: true,
          headers: {},
          body: null,
          errorCause: certError,
        }),
    };

    const client = new HTTPClient({ adapter });
    const builder = client.get('https://example.com/data');
    const res = await builder.send();

    expect(res.status).toBe(495);
    expect(res.isFailed).toBe(true);
    expect(res.isNetworkError).toBe(true);
    expect(builder.state).toBe('failed');
    expect(builder.response?.isFailed).toBe(true);
    expect(builder.error?.code).toBe('network_error');
    expect(builder.error?.cause).toBe(certError);
  });

  test('pre-response transport errors still retry when retry policy allows it', async () => {
    let requestCalls = 0;
    const requestSpy = spyOn(http, 'request').mockImplementation(
      (_options, callback) => {
        requestCalls++;

        const req = new MockClientRequest();

        if (requestCalls === 1) {
          queueMicrotask(() => {
            req.emit(
              'error',
              Object.assign(new Error('connect ECONNREFUSED'), {
                code: 'ECONNREFUSED',
              }),
            );
          });

          return req as unknown as http.ClientRequest;
        }

        const res = new MockIncomingMessage(200, {
          'content-type': 'application/json',
        });
        const cb = callback as
          ((res: http.IncomingMessage) => void) | undefined;

        queueMicrotask(() => {
          cb?.(res as unknown as http.IncomingMessage);
          queueMicrotask(() => {
            res.emit('data', Buffer.from('{"ok":true}'));
            res.emit('end');
          });
        });

        return req as unknown as http.ClientRequest;
      },
    );

    try {
      const attemptEnds: number[] = [];
      const client = new HTTPClient({
        adapter: new NodeAdapter(),
        retryPolicy: { strategy: 'fixed', maxRetryAttempts: 1, delayMS: 1 },
      });

      const res = await client
        .get('http://example.test/data')
        .onAttemptEnd((event) => {
          attemptEnds.push(event.status);
        })
        .send<{ ok: boolean }>();

      expect(requestCalls).toBe(2);
      expect(attemptEnds).toEqual([0, 200]);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    } finally {
      requestSpy.mockRestore();
    }
  });

  test('buffered response errors after headers are not retried', async () => {
    let requestCalls = 0;
    const requestSpy = spyOn(http, 'request').mockImplementation(
      (_options, callback) => {
        requestCalls++;
        const req = new MockClientRequest();
        const res = new MockIncomingMessage(200, {
          'content-type': 'text/plain',
          'content-length': '3',
        });
        const cb = callback as
          ((res: http.IncomingMessage) => void) | undefined;

        queueMicrotask(() => {
          cb?.(res as unknown as http.IncomingMessage);
          queueMicrotask(() => {
            res.emit('data', Buffer.from('a'));
            res.emit('error', new Error('mid-stream boom'));
          });
        });

        return req as unknown as http.ClientRequest;
      },
    );

    try {
      const client = new HTTPClient({
        adapter: new NodeAdapter(),
        retryPolicy: { strategy: 'fixed', maxRetryAttempts: 1, delayMS: 1 },
      });
      const builder = client.get('http://example.test/data');
      const response = await builder.send();

      expect(requestCalls).toBe(1);
      expect(response.status).toBe(200);
      expect(response.isStreamError).toBe(true);
      expect(response.isFailed).toBe(true);
      expect(builder.error?.code).toBe('stream_response_error');
      expect(builder.error?.message).toBe('Response download stream failed');
      expect(builder.error?.cause?.message).toBe('Response stream error');
      expect((builder.error?.cause?.cause as Error | undefined)?.message).toBe(
        'mid-stream boom',
      );
    } finally {
      requestSpy.mockRestore();
    }
  });

  test('buffered response timeouts after headers are not retried', async () => {
    let requestCalls = 0;
    const requestSpy = spyOn(http, 'request').mockImplementation(
      (_options, callback) => {
        requestCalls++;
        const req = new MockClientRequest();
        const res = new MockIncomingMessage(200, {
          'content-type': 'text/plain',
          'content-length': '3',
        });
        const cb = callback as
          ((res: http.IncomingMessage) => void) | undefined;

        queueMicrotask(() => {
          cb?.(res as unknown as http.IncomingMessage);
          queueMicrotask(() => {
            res.emit('data', Buffer.from('a'));
          });
        });

        return req as unknown as http.ClientRequest;
      },
    );

    try {
      const client = new HTTPClient({
        adapter: new NodeAdapter(),
        retryPolicy: { strategy: 'fixed', maxRetryAttempts: 1, delayMS: 1 },
      });
      const builder = client.get('http://example.test/data').timeout(10);
      const response = await builder.send();

      expect(requestCalls).toBe(1);
      expect(response.status).toBe(200);
      expect(response.isStreamError).toBe(true);
      expect(response.isTimeout).toBe(true);
      expect(response.isFailed).toBe(true);
      expect(builder.error?.code).toBe('stream_response_error');
      expect(builder.error?.isTimeout).toBe(true);
      expect(builder.error?.cancelReason).toBeUndefined();
    } finally {
      requestSpy.mockRestore();
    }
  });

  test('mid-upload write failures are not retried', async () => {
    let requestCalls = 0;
    const requestSpy = spyOn(http, 'request').mockImplementation(
      (_options, _callback) => {
        requestCalls++;
        const req = new MockClientRequest((_data, callback) => {
          callback?.(new Error('write failed'));
          return true;
        });

        return req as unknown as http.ClientRequest;
      },
    );

    try {
      const client = new HTTPClient({
        adapter: new NodeAdapter(),
        retryPolicy: { strategy: 'fixed', maxRetryAttempts: 1, delayMS: 1 },
      });
      const builder = client.post('http://example.test/upload').text('payload');
      const response = await builder.send();

      expect(requestCalls).toBe(1);
      expect(response.status).toBe(0);
      expect(response.isFailed).toBe(true);
      expect(builder.error?.code).toBe('network_error');
      expect(builder.error?.cause?.message).toBe('write failed');
    } finally {
      requestSpy.mockRestore();
    }
  });

  test('an idempotent PUT is retried after a body-write failure', async () => {
    let requestCalls = 0;
    const requestSpy = spyOn(http, 'request').mockImplementation(
      (_options, callback) => {
        requestCalls++;

        if (requestCalls > 1) {
          const req = new MockClientRequest();
          const res = new MockIncomingMessage(200, {
            'content-type': 'application/json',
          });
          const cb = callback as
            ((res: http.IncomingMessage) => void) | undefined;

          queueMicrotask(() => {
            cb?.(res as unknown as http.IncomingMessage);
            queueMicrotask(() => {
              res.emit('data', Buffer.from('{"ok":true}'));
              res.emit('end');
            });
          });

          return req as unknown as http.ClientRequest;
        }

        const req = new MockClientRequest((_data, writeCallback) => {
          writeCallback?.(new Error('write failed'));
          return false;
        });

        return req as unknown as http.ClientRequest;
      },
    );

    try {
      const client = new HTTPClient({
        adapter: new NodeAdapter(),
        retryPolicy: { strategy: 'fixed', maxRetryAttempts: 1, delayMS: 1 },
      });

      const response = await client
        .put('http://example.test/doc')
        .text('payload')
        .send();

      // PUT is idempotent, so a half-written body is no reason to stop trying —
      // a blanket veto here used to suppress this.
      expect(requestCalls).toBe(2);
      expect(response.status).toBe(200);
    } finally {
      requestSpy.mockRestore();
    }
  });

  test('a pre-connection error is replayable despite buffered upload progress', async () => {
    let requestCalls = 0;
    const requestSpy = spyOn(http, 'request').mockImplementation(
      (_options, callback) => {
        requestCalls++;

        if (requestCalls > 1) {
          const req = new MockClientRequest();
          const res = new MockIncomingMessage(200, {
            'content-type': 'application/json',
          });
          const cb = callback as
            ((res: http.IncomingMessage) => void) | undefined;

          queueMicrotask(() => {
            cb?.(res as unknown as http.IncomingMessage);
            queueMicrotask(() => {
              res.emit('data', Buffer.from('{"ok":true}'));
              res.emit('end');
            });
          });

          return req as unknown as http.ClientRequest;
        }

        let didEmitError = false;
        const req = new MockClientRequest((_data, writeCallback) => {
          // Body bytes are accepted by the stream before any connection
          // exists, so the upload counter moves even though nothing reached
          // the wire.
          writeCallback?.(null);

          if (!didEmitError) {
            didEmitError = true;
            queueMicrotask(() => {
              req.emit(
                'error',
                Object.assign(new Error('connect ECONNREFUSED'), {
                  code: 'ECONNREFUSED',
                }),
              );
            });
          }

          return true;
        });

        return req as unknown as http.ClientRequest;
      },
    );

    try {
      const client = new HTTPClient({
        adapter: new NodeAdapter(),
        retryPolicy: { strategy: 'fixed', maxRetryAttempts: 1, delayMS: 1 },
      });

      const response = await client
        .post('http://example.test/upload')
        .text('payload')
        .retryNonIdempotentMethods(true)
        .send();

      // The error code proves nothing was delivered, so the buffered-upload
      // veto must not fire and cancel the retry it authorized.
      expect(requestCalls).toBe(2);
      expect(response.status).toBe(200);
    } finally {
      requestSpy.mockRestore();
    }
  });

  test('socket errors after partial upload progress are not retried', async () => {
    let requestCalls = 0;
    const requestSpy = spyOn(http, 'request').mockImplementation(
      (_options, callback) => {
        requestCalls++;

        if (requestCalls > 1) {
          const req = new MockClientRequest();
          const res = new MockIncomingMessage(200, {
            'content-type': 'application/json',
          });
          const cb = callback as
            ((res: http.IncomingMessage) => void) | undefined;

          queueMicrotask(() => {
            cb?.(res as unknown as http.IncomingMessage);
            queueMicrotask(() => {
              res.emit('data', Buffer.from('{"ok":true}'));
              res.emit('end');
            });
          });

          return req as unknown as http.ClientRequest;
        }

        let didEmitError = false;
        const req = new MockClientRequest((_data, writeCallback) => {
          writeCallback?.(null);

          if (!didEmitError) {
            didEmitError = true;
            queueMicrotask(() => {
              req.emit(
                'error',
                Object.assign(new Error('socket hang up'), {
                  code: 'ECONNRESET',
                }),
              );
            });
          }

          return true;
        });

        return req as unknown as http.ClientRequest;
      },
    );

    try {
      const client = new HTTPClient({
        adapter: new NodeAdapter(),
        retryPolicy: { strategy: 'fixed', maxRetryAttempts: 1, delayMS: 1 },
      });
      const builder = client.post('http://example.test/upload').text('payload');
      const response = await builder.send();

      expect(requestCalls).toBe(1);
      expect(response.status).toBe(0);
      expect(response.isFailed).toBe(true);
      expect(builder.error?.code).toBe('network_error');
      expect(builder.error?.cause?.message).toBe('socket hang up');
    } finally {
      requestSpy.mockRestore();
    }
  });

  test('streamed response error after headers resolves as isStreamError with chained cause', async () => {
    const req = new MockClientRequest();
    const res = new MockIncomingMessage(200, {
      'content-type': 'application/octet-stream',
      'content-length': '3',
    });
    const writable = new EventEmitter() as unknown as WritableLike;
    let destroyCalls = 0;
    writable.write = () => true;
    writable.end = (callback?: () => void) => {
      callback?.();
    };
    writable.destroy = () => {
      destroyCalls++;
      return writable;
    };
    const requestSpy = spyOn(http, 'request').mockImplementation(
      (_options, callback) => {
        const cb = callback as
          ((res: http.IncomingMessage) => void) | undefined;
        queueMicrotask(() => {
          cb?.(res as unknown as http.IncomingMessage);
          queueMicrotask(() => {
            res.emit('error', new Error('simulated stream error'));
          });
        });
        return req as unknown as http.ClientRequest;
      },
    );

    try {
      const response = await new NodeAdapter().send({
        requestURL: 'http://example.test/data',
        method: 'GET',
        headers: {},
        streamResponse: () => writable,
      });

      expect(response.status).toBe(200);
      expect(response.isStreamError).toBe(true);
      expect(response.streamErrorCode).toBe('stream_response_error');
      expect(response.isStreamed).toBeUndefined();
      expect(response.errorCause?.message).toBe('Response stream error');
      expect((response.errorCause?.cause as Error | undefined)?.message).toBe(
        'simulated stream error',
      );
      expect(destroyCalls).toBe(1);
    } finally {
      requestSpy.mockRestore();
    }
  });

  test('aborted streamed responses settle as stream_response_error', async () => {
    const req = new MockClientRequest();
    const res = new MockIncomingMessage(200, {
      'content-type': 'application/octet-stream',
      'content-length': '10',
    });
    const writable = new EventEmitter() as unknown as WritableLike;
    let destroyCalls = 0;
    writable.write = () => true;
    writable.end = (callback?: () => void) => {
      callback?.();
    };
    writable.destroy = () => {
      destroyCalls++;
      return writable;
    };
    const requestSpy = spyOn(http, 'request').mockImplementation(
      (_options, callback) => {
        const cb = callback as
          ((res: http.IncomingMessage) => void) | undefined;
        queueMicrotask(() => {
          cb?.(res as unknown as http.IncomingMessage);
          queueMicrotask(() => {
            res.emit('data', Buffer.from('12345'));
            res.emit('aborted');
            res.emit('close');
          });
        });
        return req as unknown as http.ClientRequest;
      },
    );

    try {
      const result = await Promise.race([
        new NodeAdapter().send({
          requestURL: 'http://example.test/data',
          method: 'GET',
          headers: {},
          streamResponse: () => writable,
        }),
        new Promise((resolve) => setTimeout(() => resolve('timeout'), 50)),
      ]);

      expect(result).not.toBe('timeout');

      const response = result as AdapterResponse;
      expect(response.status).toBe(200);
      expect(response.isStreamError).toBe(true);
      expect(response.streamErrorCode).toBe('stream_response_error');
      expect(response.errorCause?.message).toBe('Response stream aborted');
      expect(destroyCalls).toBe(1);
    } finally {
      requestSpy.mockRestore();
    }
  });

  test('close-only streamed truncation settles as stream_response_error', async () => {
    const req = new MockClientRequest();
    const res = new MockIncomingMessage(200, {
      'content-type': 'application/octet-stream',
      'content-length': '10',
    });
    const writable = new EventEmitter() as unknown as WritableLike;
    let destroyCalls = 0;
    writable.write = () => true;
    writable.end = (callback?: () => void) => {
      callback?.();
    };
    writable.destroy = () => {
      destroyCalls++;
      return writable;
    };
    const requestSpy = spyOn(http, 'request').mockImplementation(
      (_options, callback) => {
        const cb = callback as
          ((res: http.IncomingMessage) => void) | undefined;
        queueMicrotask(() => {
          cb?.(res as unknown as http.IncomingMessage);
          queueMicrotask(() => {
            res.emit('data', Buffer.from('12345'));
            res.emit('close');
          });
        });
        return req as unknown as http.ClientRequest;
      },
    );

    try {
      const result = await Promise.race([
        new NodeAdapter().send({
          requestURL: 'http://example.test/data',
          method: 'GET',
          headers: {},
          streamResponse: () => writable,
        }),
        new Promise((resolve) => setTimeout(() => resolve('timeout'), 50)),
      ]);

      expect(result).not.toBe('timeout');

      const response = result as AdapterResponse;
      expect(response.status).toBe(200);
      expect(response.isStreamError).toBe(true);
      expect(response.streamErrorCode).toBe('stream_response_error');
      expect(response.errorCause?.message).toBe(
        'Response stream closed before completion',
      );
      expect(destroyCalls).toBe(1);
    } finally {
      requestSpy.mockRestore();
    }
  });

  test('synchronous writable.write throws resolve as stream_write_error', async () => {
    const req = new MockClientRequest();
    const res = new MockIncomingMessage(200, {
      'content-type': 'application/octet-stream',
      'content-length': '1',
    });
    const writable = new EventEmitter() as unknown as WritableLike;
    writable.write = () => {
      throw new Error('sync write boom');
    };
    writable.end = (callback?: () => void) => {
      callback?.();
    };
    writable.destroy = () => writable;
    const requestSpy = spyOn(http, 'request').mockImplementation(
      (_options, callback) => {
        const cb = callback as
          ((res: http.IncomingMessage) => void) | undefined;
        queueMicrotask(() => {
          cb?.(res as unknown as http.IncomingMessage);
          queueMicrotask(() => {
            res.emit('data', Buffer.from('a'));
          });
        });
        return req as unknown as http.ClientRequest;
      },
    );

    try {
      const response = await new NodeAdapter().send({
        requestURL: 'http://example.test/data',
        method: 'GET',
        headers: {},
        streamResponse: () => writable,
      });

      expect(response.status).toBe(200);
      expect(response.isStreamError).toBe(true);
      expect(response.streamErrorCode).toBe('stream_write_error');
      expect(response.errorCause?.message).toBe('sync write boom');
    } finally {
      requestSpy.mockRestore();
    }
  });

  test('synchronous writable.end throws resolve as stream_write_error', async () => {
    const req = new MockClientRequest();
    const res = new MockIncomingMessage(200, {
      'content-type': 'application/octet-stream',
      'content-length': '1',
    });
    const writable = new EventEmitter() as unknown as WritableLike;
    writable.write = () => true;
    writable.end = () => {
      throw new Error('sync end boom');
    };
    writable.destroy = () => writable;
    const requestSpy = spyOn(http, 'request').mockImplementation(
      (_options, callback) => {
        const cb = callback as
          ((res: http.IncomingMessage) => void) | undefined;
        queueMicrotask(() => {
          cb?.(res as unknown as http.IncomingMessage);
          queueMicrotask(() => {
            res.emit('data', Buffer.from('a'));
            res.emit('end');
          });
        });
        return req as unknown as http.ClientRequest;
      },
    );

    try {
      const response = await new NodeAdapter().send({
        requestURL: 'http://example.test/data',
        method: 'GET',
        headers: {},
        streamResponse: () => writable,
      });

      expect(response.status).toBe(200);
      expect(response.isStreamError).toBe(true);
      expect(response.streamErrorCode).toBe('stream_write_error');
      expect(response.errorCause?.message).toBe('sync end boom');
    } finally {
      requestSpy.mockRestore();
    }
  });

  test('async streamResponse factory rejection rejects the promise', async () => {
    const req = new MockClientRequest();
    const res = new MockIncomingMessage(200, {
      'content-type': 'application/octet-stream',
      'content-length': '3',
    });
    const requestSpy = spyOn(http, 'request').mockImplementation(
      (_options, callback) => {
        const cb = callback as
          ((res: http.IncomingMessage) => void) | undefined;
        queueMicrotask(() => {
          cb?.(res as unknown as http.IncomingMessage);
        });
        return req as unknown as http.ClientRequest;
      },
    );

    try {
      let caught: Error | undefined;

      try {
        await new NodeAdapter().send({
          requestURL: 'http://example.test/data',
          method: 'GET',
          headers: {},
          streamResponse: async () => {
            // Simulate some async work before throwing
            await new Promise((resolve) => setTimeout(resolve, 10));
            throw new Error('factory async rejection');
          },
        });
      } catch (error) {
        caught = error as Error;
      }

      expect(caught?.message).toContain('factory async rejection');
    } finally {
      requestSpy.mockRestore();
    }
  });

  test('async streamResponse factory destroys late writable after abort', async () => {
    const req = new MockClientRequest();
    const res = new MockIncomingMessage(200, {
      'content-type': 'application/octet-stream',
      'content-length': '3',
    });
    const requestSpy = spyOn(http, 'request').mockImplementation(
      (_options, callback) => {
        const cb = callback as
          ((res: http.IncomingMessage) => void) | undefined;
        queueMicrotask(() => {
          cb?.(res as unknown as http.IncomingMessage);
        });
        return req as unknown as http.ClientRequest;
      },
    );

    let wasDestroyed = false;
    const writable: WritableLike = {
      write: () => true,
      end: () => {},
      on: () => writable,
      once: () => writable,
      destroy: () => {
        wasDestroyed = true;
      },
    };

    const controller = new AbortController();

    try {
      const promise = new NodeAdapter().send({
        requestURL: 'http://example.test/data',
        method: 'GET',
        headers: {},
        signal: controller.signal,
        streamResponse: async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return writable;
        },
      });

      controller.abort();

      let caught: Error | undefined;

      try {
        await promise;
      } catch (error) {
        caught = error as Error;
      }

      expect(caught?.message).toContain('Request aborted');
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(wasDestroyed).toBe(true);
    } finally {
      requestSpy.mockRestore();
    }
  });

  test('timeout while async streamResponse factory is pending becomes stream_setup_error', async () => {
    const req = new MockClientRequest();
    const res = new MockIncomingMessage(200, {
      'content-type': 'application/octet-stream',
      'content-length': '3',
    });
    const requestSpy = spyOn(http, 'request').mockImplementation(
      (_options, callback) => {
        const cb = callback as
          ((res: http.IncomingMessage) => void) | undefined;
        queueMicrotask(() => {
          cb?.(res as unknown as http.IncomingMessage);
        });
        return req as unknown as http.ClientRequest;
      },
    );

    try {
      const client = new HTTPClient({
        adapter: new NodeAdapter(),
        retryPolicy: { strategy: 'fixed', maxRetryAttempts: 1, delayMS: 1 },
      });

      const builder = client
        .get('http://example.test/data')
        .timeout(5)
        .streamResponse(async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return makeMemoryWritable().stream;
        });

      const res = await builder.send();

      expect(res.status).toBe(0);
      expect(res.isFailed).toBe(true);
      expect(res.isTimeout).toBe(true);
      expect(builder.attemptCount).toBe(1);
      expect(builder.error?.code).toBe('stream_setup_error');
      expect(builder.error?.isRetriesExhausted).toBe(false);
      expect(builder.error?.cancelReason).toBeUndefined();
    } finally {
      requestSpy.mockRestore();
    }
  });

  test('response stream errors after headers are not retried once streaming starts', async () => {
    let adapterCalls = 0;
    const stream = new EventEmitter() as unknown as WritableLike;
    const writtenChunks: string[] = [];

    stream.write = (chunk: Uint8Array | string) => {
      writtenChunks.push(Buffer.from(chunk).toString('utf8'));
      return true;
    };
    stream.end = (callback?: () => void) => {
      callback?.();
    };
    stream.destroy = () => stream;

    const requestSpy = spyOn(http, 'request').mockImplementation(
      (_options, callback) => {
        adapterCalls++;
        const req = new MockClientRequest();
        const res = new MockIncomingMessage(200, {
          'content-type': 'application/octet-stream',
          'content-length': '3',
        });

        const cb = callback as
          ((res: http.IncomingMessage) => void) | undefined;

        queueMicrotask(() => {
          cb?.(res as unknown as http.IncomingMessage);
          queueMicrotask(() => {
            res.emit('data', Buffer.from('a'));
            res.emit('error', new Error('mid-stream boom'));
          });
        });

        return req as unknown as http.ClientRequest;
      },
    );

    try {
      const client = new HTTPClient({
        adapter: new NodeAdapter(),
        retryPolicy: { strategy: 'fixed', maxRetryAttempts: 1, delayMS: 1 },
      });
      const builder = client
        .get('http://example.test/data')
        .streamResponse(() => stream);
      const response = await builder.send();

      expect(adapterCalls).toBe(1);
      expect(writtenChunks).toEqual(['a']);
      expect(response.status).toBe(200);
      expect(response.isStreamError).toBe(true);
      expect(response.isFailed).toBe(true);
      expect(builder.error?.code).toBe('stream_response_error');
      expect(builder.error?.message).toBe('Response download stream failed');
      expect(builder.error?.cause?.message).toBe('Response stream error');
      expect((builder.error?.cause?.cause as Error | undefined)?.message).toBe(
        'mid-stream boom',
      );
    } finally {
      requestSpy.mockRestore();
    }
  });

  test('abort during active response streaming destroys the request and stops later writes', async () => {
    const req = new MockClientRequest();
    const res = new MockIncomingMessage(200, {
      'content-type': 'application/octet-stream',
      'content-length': '3',
    });
    const requestSpy = spyOn(http, 'request').mockImplementation(
      (_options, callback) => {
        const cb = callback as
          ((res: http.IncomingMessage) => void) | undefined;

        queueMicrotask(() => {
          cb?.(res as unknown as http.IncomingMessage);
          queueMicrotask(() => {
            res.emit('data', Buffer.from('a'));
          });
          queueMicrotask(() => {
            res.emit('data', Buffer.from('b'));
          });
          queueMicrotask(() => {
            res.emit('end');
          });
        });

        return req as unknown as http.ClientRequest;
      },
    );

    const controller = new AbortController();
    const writtenChunks: string[] = [];
    let wasWritableDestroyed = false;

    const writable: WritableLike = {
      write(chunk: Uint8Array | string) {
        if (wasWritableDestroyed) {
          return false;
        }

        writtenChunks.push(Buffer.from(chunk).toString('utf8'));
        controller.abort();
        return true;
      },
      end(callback?: () => void) {
        callback?.();
      },
      on() {
        return writable;
      },
      once() {
        return writable;
      },
      destroy() {
        wasWritableDestroyed = true;
      },
    };

    try {
      const sendPromise = new NodeAdapter().send({
        requestURL: 'http://example.test/data',
        method: 'GET',
        headers: {},
        signal: controller.signal,
        streamResponse: () => writable,
      });

      let caught: Error | undefined;

      try {
        await sendPromise;
      } catch (error) {
        caught = error as Error;
      }

      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(caught?.message).toBe('Request aborted during response streaming');
      expect(req.destroyed).toBe(true);
      expect(wasWritableDestroyed).toBe(true);
      expect(writtenChunks).toEqual(['a']);
    } finally {
      requestSpy.mockRestore();
    }
  });

  test('streaming timeouts after headers are not retried', async () => {
    let adapterCalls = 0;
    const stream = new EventEmitter() as unknown as WritableLike;
    const writtenChunks: string[] = [];

    stream.write = (chunk: Uint8Array | string) => {
      writtenChunks.push(Buffer.from(chunk).toString('utf8'));
      return true;
    };
    stream.end = (callback?: () => void) => {
      callback?.();
    };
    stream.destroy = () => stream;

    const requestSpy = spyOn(http, 'request').mockImplementation(
      (_options, callback) => {
        adapterCalls++;
        const req = new MockClientRequest();
        const res = new MockIncomingMessage(200, {
          'content-type': 'application/octet-stream',
          'content-length': '3',
        });

        const cb = callback as
          ((res: http.IncomingMessage) => void) | undefined;

        queueMicrotask(() => {
          cb?.(res as unknown as http.IncomingMessage);
          queueMicrotask(() => {
            res.emit('data', Buffer.from('a'));
          });
        });

        return req as unknown as http.ClientRequest;
      },
    );

    try {
      const client = new HTTPClient({
        adapter: new NodeAdapter(),
        retryPolicy: { strategy: 'fixed', maxRetryAttempts: 1, delayMS: 1 },
      });
      const builder = client
        .get('http://example.test/data')
        .timeout(10)
        .streamResponse(() => stream);
      const response = await builder.send();

      expect(adapterCalls).toBe(1);
      expect(writtenChunks).toEqual(['a']);
      expect(response.status).toBe(200);
      expect(response.isStreamError).toBe(true);
      expect(response.isTimeout).toBe(true);
      expect(response.isFailed).toBe(true);
      expect(builder.error?.code).toBe('stream_response_error');
      expect(builder.error?.isTimeout).toBe(true);
      expect(builder.error?.cancelReason).toBeUndefined();
    } finally {
      requestSpy.mockRestore();
    }
  });

  test('streamed response backpressure pauses until drain then resumes', async () => {
    const req = new MockClientRequest();
    const res = new MockIncomingMessage(200, {
      'content-type': 'application/octet-stream',
      'content-length': '3',
    });
    let writeCalls = 0;
    const writable = new EventEmitter() as unknown as WritableLike;
    writable.write = () => {
      writeCalls++;
      return false;
    };
    writable.end = (callback?: () => void) => {
      callback?.();
    };
    writable.destroy = () => writable;
    const requestSpy = spyOn(http, 'request').mockImplementation(
      (_options, callback) => {
        const cb = callback as
          ((res: http.IncomingMessage) => void) | undefined;
        queueMicrotask(() => {
          cb?.(res as unknown as http.IncomingMessage);
          queueMicrotask(() => {
            res.emit('data', Buffer.from('abc'));
            queueMicrotask(() => {
              (writable as unknown as EventEmitter).emit('drain');
              res.emit('end');
            });
          });
        });
        return req as unknown as http.ClientRequest;
      },
    );

    try {
      const result = await new NodeAdapter().send({
        requestURL: 'http://example.test/data',
        method: 'GET',
        headers: {},
        streamResponse: () => writable,
      });

      expect(result.status).toBe(200);
      expect(result.isStreamed).toBe(true);
      expect(writeCalls).toBe(1);
      expect(res.pauseCalls).toBe(1);
      expect(res.resumeCalls).toBe(1);
    } finally {
      requestSpy.mockRestore();
    }
  });

  test('reused streamResponse writables do not retain listeners between requests', async () => {
    const writable = new EventEmitter() as EventEmitter & WritableLike;
    writable.write = () => true;
    writable.end = (callback?: () => void) => {
      callback?.();
    };
    writable.destroy = () => {};

    const requestSpy = spyOn(http, 'request').mockImplementation(
      (_options, callback) => {
        const req = new MockClientRequest();
        const res = new MockIncomingMessage(200, {
          'content-type': 'application/octet-stream',
          'content-length': '3',
        });
        const cb = callback as
          ((res: http.IncomingMessage) => void) | undefined;

        queueMicrotask(() => {
          cb?.(res as unknown as http.IncomingMessage);
          queueMicrotask(() => {
            res.emit('data', Buffer.from('abc'));
            res.emit('end');
          });
        });

        return req as unknown as http.ClientRequest;
      },
    );

    try {
      const adapter = new NodeAdapter();

      for (let i = 0; i < 3; i++) {
        const result = await adapter.send({
          requestURL: 'http://example.test/data',
          method: 'GET',
          headers: {},
          streamResponse: () => writable,
        });

        expect(result.isStreamed).toBe(true);
        expect(writable.listenerCount('drain')).toBe(0);
        expect(writable.listenerCount('error')).toBe(0);
      }
    } finally {
      requestSpy.mockRestore();
    }
  });
});

describe('NodeAdapter via HTTPClient', () => {
  let server: TestServer;
  let client: HTTPClient;

  beforeAll(() => {
    server = startTestServer();
    client = makeClient({}, server.url);
  });

  afterAll(async () => {
    await server.stop();
  });

  // --- HTTP methods ---

  test('GET returns JSON response', async () => {
    const res = await client
      .get('/api/users/1')
      .send<{ id: string; name: string }>();

    expect(res.status).toBe(200);
    expect(res.isJSON).toBe(true);
    expect(res.body.id).toBe('1');
  });

  test('POST with JSON body is echoed back', async () => {
    const res = await client
      .post('/api/users')
      .json({ name: 'Alice' })
      .send<{ created: boolean; data: { name: string } }>();

    expect(res.status).toBe(201);
    expect(res.body.created).toBe(true);
    expect(res.body.data.name).toBe('Alice');
  });

  test('text response is parsed as text', async () => {
    const res = await client.get('/api/text').send<string>();
    expect(res.isText).toBe(true);
    expect(res.body).toBe('hello world');
  });

  test('malformed JSON is surfaced as text with isParseError', async () => {
    const res = await client.get('/api/invalid-json').send<string>();

    expect(res.status).toBe(200);
    expect(res.isJSON).toBe(false);
    expect(res.isText).toBe(false);
    expect(res.isParseError).toBe(true);
    expect(res.body).toBe('{"broken":');
  });

  test('PUT echoes body', async () => {
    const res = await client
      .put('/api/update')
      .json({ value: 42 })
      .send<{ updated: boolean; data: { value: number } }>();

    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(true);
    expect(res.body.data.value).toBe(42);
  });

  test('HEAD request returns headers without body', async () => {
    const res = await client.head('/api/head').send();
    expect(res.status).toBe(200);
    expect(res.headers['x-head-ok']).toBe('true');
    expect(res.body).toBeNull();
  });

  test('204 no-content response has null body', async () => {
    const res = await client.get('/api/no-content').send();
    expect(res.status).toBe(204);
    expect(res.body).toBeNull();
  });

  test('500 response returns status 500 with body', async () => {
    const res = await client.get('/api/error').send<{ error: string }>();
    expect(res.status).toBe(500);
    expect(res.isFailed).toBe(false);
    expect(res.body.error).toBe('internal server error');
  });

  test('response headers pass through', async () => {
    const res = await client.get('/api/set-cookie').send();
    // set-cookie is multi-value — check the header key exists
    expect(res.headers['set-cookie']).toBeDefined();
  });

  test('repeated request headers are accepted and materialized by Node', async () => {
    const res = await client
      .get('/api/test')
      .headers({
        accept: ['application/json', 'text/plain'],
      })
      .send<{ headers: Record<string, string> }>();

    expect(res.status).toBe(200);
    expect(res.body.headers.accept).toBe('application/json, text/plain');
  });

  test('basic-auth credentials in the request URL become Authorization headers', async () => {
    const res = await client
      .get(`http://alice:secret@localhost:${new URL(server.url).port}/api/test`)
      .send<{ headers: Record<string, string> }>();

    expect(res.status).toBe(200);
    expect(res.body.headers.authorization).toBe('Basic YWxpY2U6c2VjcmV0');
  });

  // --- FormData ---

  test('FormData with string fields is uploaded correctly', async () => {
    const fd = new FormData();
    fd.append('username', 'alice');
    fd.append('role', 'admin');

    const res = await client
      .post('/api/upload')
      .formData(fd)
      .send<{ received: boolean; fields: Record<string, string> }>();

    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
    expect(res.body.fields.username).toBe('alice');
    expect(res.body.fields.role).toBe('admin');
  });

  test('FormData file upload integrity: server hash matches client hash', async () => {
    // Build a 64 KB in-memory buffer with a recognizable pattern so random
    // chance can't mask a byte-mangling bug (truncation, encoding corruption).
    const bytes = new Uint8Array(64 * 1024);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = i % 256;
    }

    const clientHash = crypto
      .createHash('sha256')
      .update(Buffer.from(bytes.buffer))
      .digest('hex');

    const fd = new FormData();
    fd.append(
      'file',
      new File([bytes], 'integrity.bin', { type: 'application/octet-stream' }),
    );

    const res = await client
      .post('/api/upload-hash')
      .formData(fd)
      .send<{ hash: string }>();

    expect(res.status).toBe(200);
    expect(res.body.hash).toBe(clientHash);
  });

  test('raw Uint8Array upload integrity: server hash matches client hash', async () => {
    // Same pattern as the FormData integrity test but sends raw binary body
    // directly (content-type: application/octet-stream) to verify the bytes
    // arrive intact without FormData framing.
    const bytes = new Uint8Array(64 * 1024);

    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = i % 256;
    }

    const clientHash = crypto
      .createHash('sha256')
      .update(Buffer.from(bytes.buffer))
      .digest('hex');

    const res = await client
      .post('/api/raw-upload-hash')
      .headers({ 'content-type': 'application/octet-stream' })
      .body(bytes)
      .send<{ hash: string }>();

    expect(res.status).toBe(200);
    expect(res.body.hash).toBe(clientHash);
  });

  test('FormData with file is uploaded and echoed as file reference', async () => {
    const fd = new FormData();
    fd.append(
      'avatar',
      new File(['hello file'], 'avatar.png', { type: 'image/png' }),
    );

    const res = await client
      .post('/api/upload')
      .formData(fd)
      .send<{ received: boolean; fields: Record<string, string> }>();

    expect(res.status).toBe(200);
    expect(res.body.fields.avatar).toBe('[File: avatar.png]');
  });

  test('FormData with non-ASCII filename falls back to sanitized filename in Bun parser', async () => {
    const fd = new FormData();
    fd.append(
      'cv',
      new File(['hello file'], 'résumé.pdf', { type: 'application/pdf' }),
    );

    const res = await client
      .post('/api/upload')
      .formData(fd)
      .send<{ received: boolean; fields: Record<string, string> }>();

    expect(res.status).toBe(200);
    expect(res.body.fields.cv).toBe('[File: resume.pdf]');
  });

  // --- redirects ---

  test('followRedirects false settles with redirect_disabled on 301', async () => {
    const redirectClient = makeClient({}, server.url, {
      followRedirects: false,
    });

    const builder = redirectClient.get('/api/redirect/301');
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

  test('followRedirects true follows 301 and sets wasRedirectFollowed', async () => {
    const redirectClient = makeClient({}, server.url, {
      followRedirects: true,
    });

    const res = await redirectClient
      .get('/api/redirect/301')
      .send<{ headers: Record<string, string> }>();

    expect(res.status).toBe(200);
    expect(res.wasRedirectDetected).toBe(true);
    expect(res.wasRedirectFollowed).toBe(true);
    expect(res.redirectHistory).toEqual([`${server.url}/api/test`]);
  });

  // --- upload progress ---

  test('upload progress fires on POST with large body', async () => {
    const events: number[] = [];
    // Body exceeds CHUNK_SIZE (16 KB) so at least two progress events fire,
    // confirming chunked write is working rather than one bulk upload event.
    const largeBody = 'x'.repeat(32 * 1024);

    await client
      .post('/api/users')
      .text(largeBody)
      .onUploadProgress((e) => {
        events.push(e.progress);
      })
      .send();

    expect(events.length).toBeGreaterThan(1);
    expect(events[events.length - 1]).toBe(1);
  });

  test('upload progress fires for FormData body', async () => {
    const events: number[] = [];
    const fd = new FormData();
    fd.append('field', 'value');

    await client
      .post('/api/upload')
      .formData(fd)
      .onUploadProgress((e) => {
        events.push(e.progress);
      })
      .send();

    expect(events.length).toBeGreaterThan(0);
    expect(events[events.length - 1]).toBe(1);
  });

  // --- download progress ---

  test('download progress fires on response with content-length', async () => {
    const events: Array<{ loaded: number; total: number; progress: number }> =
      [];

    await client
      .get('/api/binary')
      .onDownloadProgress((e) => {
        events.push(e);
      })
      .send();

    expect(events.length).toBeGreaterThan(0);
    expect(events[events.length - 1].progress).toBe(1);

    // Final loaded should equal the full 2048-byte payload
    expect(events[events.length - 1].loaded).toBe(2048);
  });

  test('buffered download reports progress: -1 when Content-Length is absent', async () => {
    const events: Array<{ loaded: number; total: number; progress: number }> =
      [];

    await client
      .get('/api/chunked')
      .onDownloadProgress((e) => events.push(e))
      .send();

    // At least one intermediate event should carry progress: -1 (no
    // Content-Length so total is unknown until the stream ends).
    expect(events.some((e) => e.progress === -1)).toBe(true);
    // total falls back to loaded when unknown — must be > 0.
    const unknownEvents = events.filter((e) => e.progress === -1);
    expect(unknownEvents.every((e) => e.total === e.loaded)).toBe(true);
    // Final event is always 1.
    expect(events[events.length - 1].progress).toBe(1);
  });

  // --- streaming ---

  test('streamResponse pipes body into writable and resolves with isStreamed: true', async () => {
    const { stream, getBytes } = makeMemoryWritable();

    const res = await client
      .get('/api/binary')
      .streamResponse((_info, _ctx) => stream)
      .send();

    expect(res.isStreamed).toBe(true);
    expect(res.isStreamError).toBe(false);
    expect(res.isCancelled).toBe(false);
    expect(res.body).toBeNull();
    // All 2048 bytes should have arrived in the writable
    expect(getBytes().length).toBe(2048);
    // Verify byte content is correct (0-255 repeating)
    const bytes = getBytes();
    for (let i = 0; i < 2048; i++) {
      expect(bytes[i]).toBe(i % 256);
    }
  });

  test('streamResponse fires download progress during streaming', async () => {
    const events: number[] = [];
    const { stream } = makeMemoryWritable();

    await client
      .get('/api/binary')
      .streamResponse((_info, _ctx) => stream)
      .onDownloadProgress((e) => {
        events.push(e.progress);
      })
      .send();

    expect(events.length).toBeGreaterThan(0);
    expect(events[events.length - 1]).toBe(1);
  });

  test('streaming download reports progress: -1 when Content-Length is absent', async () => {
    const events: Array<{ loaded: number; total: number; progress: number }> =
      [];
    const { stream } = makeMemoryWritable();

    await client
      .get('/api/chunked')
      .streamResponse((_info, _ctx) => stream)
      .onDownloadProgress((e) => events.push(e))
      .send();

    // At least one event should carry progress: -1 (no Content-Length).
    expect(events.some((e) => e.progress === -1)).toBe(true);
    // total falls back to loaded when unknown — must be > 0.
    const unknownEvents = events.filter((e) => e.progress === -1);
    expect(unknownEvents.every((e) => e.total === e.loaded)).toBe(true);
    // Final event is always 1.
    expect(events[events.length - 1].progress).toBe(1);
  });

  test('streamResponse returning null cancels the request (isCancelled: true)', async () => {
    // null from factory = user-initiated cancel (e.g. not enough disk space,
    // or decided post-headers that this response should not be written).
    const attemptEnds: Array<{ status: number; willRetry: boolean }> = [];

    const res = await client
      .get('/api/binary')
      .streamResponse(() => null)
      .onAttemptEnd((e) => {
        attemptEnds.push({ status: e.status, willRetry: e.willRetry });
      })
      .send();

    expect(res.isCancelled).toBe(true);
    expect(res.isFailed).toBe(true);
    expect(attemptEnds).toEqual([{ status: 0, willRetry: false }]);
  });

  test('streamResponse returning null produces no cancelReason on the error', async () => {
    const builder = client.get('/api/binary').streamResponse(() => null);
    const res = await builder.send();

    expect(res.isCancelled).toBe(true);
    expect(builder.error?.cancelReason).toBeUndefined();
  });

  test('streamResponse returning { cancel: true } cancels without a reason', async () => {
    const builder = client
      .get('/api/binary')
      .streamResponse(() => ({ cancel: true as const }));
    const res = await builder.send();

    expect(res.isCancelled).toBe(true);
    expect(res.isFailed).toBe(true);
    expect(builder.error?.cancelReason).toBeUndefined();
  });

  test('streamResponse returning { cancel: true, reason } surfaces cancelReason on the error', async () => {
    const builder = client.get('/api/binary').streamResponse(() => ({
      cancel: true as const,
      reason: 'not enough disk space',
    }));
    const res = await builder.send();

    expect(res.isCancelled).toBe(true);
    expect(res.isFailed).toBe(true);
    expect(builder.error?.cancelReason).toBe('not enough disk space');
  });

  test('streamResponse is only called on 200, not on error status codes', async () => {
    // The factory must not be invoked for non-200 responses — error bodies
    // should be buffered normally so callers can inspect them.
    let wasFactoryCalled = false;

    const res = await client
      .get('/api/error')
      .streamResponse(() => {
        wasFactoryCalled = true;
        return null;
      })
      .send<{ error: string }>();

    expect(wasFactoryCalled).toBe(false);
    expect(res.status).toBe(500);
    expect(res.isStreamed).toBe(false);
    expect(res.body.error).toBe('internal server error');
  });

  test('writable error during streaming resolves as a failed stream error', async () => {
    // Errors mid-stream (disk full, stream destroyed) should fail the request
    // while preserving the real HTTP status so callers do not treat a partial
    // streamed download as success.
    const errorWritable = makeErrorWritable(1); // error on first byte
    const progressEvents: number[] = [];
    const attemptEnds: Array<{ status: number; willRetry: boolean }> = [];
    const finalErrorCodes: string[] = [];

    client.addErrorObserver((error) => {
      finalErrorCodes.push(error.code);
    });

    const builder = client
      .get('/api/binary')
      .streamResponse(() => errorWritable)
      .onDownloadProgress((e) => {
        progressEvents.push(e.progress);
      })
      .onAttemptEnd((e) => {
        attemptEnds.push({ status: e.status, willRetry: e.willRetry });
      });

    const res = await builder.send();

    expect(res.isCancelled).toBe(false);
    expect(res.isStreamError).toBe(true);
    expect(res.isFailed).toBe(true);
    expect(builder.state).toBe('failed');
    expect(builder.error?.code).toBe('stream_write_error');
    expect(builder.error?.cause?.message).toBe(
      'Simulated write failure (disk full)',
    );
    expect(progressEvents).toEqual([]);

    // Real HTTP status preserved — server responded correctly, local write broke
    expect(res.status).toBe(200);
    expect(attemptEnds).toEqual([{ status: 200, willRetry: false }]);
    expect(finalErrorCodes).toEqual(['stream_write_error']);
  });

  test('streamResponse throws if used with a non-node adapter', async () => {
    // Client-level guard: streamResponse is NodeAdapter-only. Using it with
    // any other adapter (Mock, Fetch, XHR) throws before the request is sent.
    const { MockAdapter } = await import('./mock-adapter');
    const mockAdapter = new MockAdapter();
    mockAdapter.routes.get('/test', () => ({ status: 200 }));

    const mockClient = new HTTPClient({
      adapter: mockAdapter,
      baseURL: 'http://mock.test',
    });

    const finalErrorCodes: string[] = [];
    mockClient.addErrorObserver((error) => {
      finalErrorCodes.push(error.code);
    });

    const builder = mockClient.get('/test').streamResponse(() => null);
    const res = await builder.send();

    expect(res.status).toBe(0);
    expect(res.isFailed).toBe(true);
    expect(builder.state).toBe('failed');
    expect(builder.error?.code).toBe('request_setup_error');
    expect(builder.error?.cause?.message).toMatch(/streamResponse.*node/i);
    expect(finalErrorCodes).toEqual(['request_setup_error']);
  });

  // --- cancellation ---

  test('cancelled request resolves with isCancelled: true', async () => {
    const controller = new AbortController();
    const promise = client.get('/api/slow').signal(controller.signal).send();

    setTimeout(() => {
      controller.abort();
    }, 30);

    const res = await promise;
    expect(res.isCancelled).toBe(true);
    expect(res.isFailed).toBe(true);
  });

  test('builder.cancel(reason) surfaces cancelReason via NodeAdapter', async () => {
    const builder = client.get('/api/slow');
    const promise = builder.send();
    setTimeout(() => builder.cancel('user_navigated_away'), 30);
    const res = await promise;
    expect(res.isCancelled).toBe(true);
    expect(builder.error?.cancelReason).toBe('user_navigated_away');
  });

  test('builder.cancel() without reason produces no cancelReason via NodeAdapter', async () => {
    const builder = client.get('/api/slow');
    const promise = builder.send();
    setTimeout(() => builder.cancel(), 30);
    await promise;
    expect(builder.error?.cancelReason).toBeUndefined();
  });

  // --- transport errors ---

  test('connection refused resolves with status 0', async () => {
    // Port 1 is effectively always refused — OS-level TCP rejection, not HTTP.
    // The adapter catches ECONNREFUSED and resolves with status 0 so retry
    // logic and observers get a consistent response object (no thrown errors).
    const errorClient = makeClient({}, 'http://localhost:1');

    const builder = errorClient.get('/test').timeout(2000);
    const res = await builder.send();
    expect(res.status).toBe(0);
    expect(res.isNetworkError).toBe(true);
    expect(res.isFailed).toBe(true);
    expect(builder.error?.cause?.message).toMatch(/ECONNREFUSED/i);
  });

  test('a GET is still retried after a connection reset', async () => {
    const net = await import('node:net');

    let connections = 0;
    const server = net.createServer((socket) => {
      connections++;

      if (connections === 1) {
        socket.on('data', () => socket.destroy());
        return;
      }

      socket.on('data', () => {
        socket.end(
          'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\n\r\n{"ok":true}',
        );
      });
    });

    await new Promise<void>((done) => {
      server.listen(0, '127.0.0.1', done);
    });

    const { port } = server.address() as { port: number };

    try {
      const client = new HTTPClient({
        adapter: new NodeAdapter(),
        baseURL: `http://127.0.0.1:${port}`,
        retryPolicy: { strategy: 'fixed', maxRetryAttempts: 2, delayMS: 1 },
      });

      const res = await client.get('/thing').send();

      // A reset mid-flight says nothing about replay safety for an idempotent
      // method — repeating a GET is always safe, so the retry must survive.
      expect(connections).toBe(2);
      expect(res.status).toBe(200);
    } finally {
      server.close();
    }
  });

  test('an empty-body POST whose headers reached the server is not replayable', async () => {
    const net = await import('node:net');

    // A raw TCP server so the connection can be killed the moment the request
    // arrives — Bun.serve gives no handle on the socket.
    const server = net.createServer((socket) => {
      socket.on('data', () => {
        // The request line and headers have landed; the server has it. Die
        // before answering.
        socket.destroy();
      });
    });

    await new Promise<void>((done) => {
      server.listen(0, '127.0.0.1', done);
    });

    const { port } = server.address() as { port: number };

    try {
      const res = await new NodeAdapter().send({
        requestURL: `http://127.0.0.1:${port}/thing`,
        method: 'POST',
        headers: {},
        body: null,
      });

      expect(res.status).toBe(0);
      expect(res.isTransportError).toBe(true);

      // Zero body bytes were written — there was no body — yet the headers
      // reached the server, so the request may already have been acted on.
      // A body-byte counter would have called this safe to replay.
      expect(res.wasDefinitelyNotSent).toBe(false);

      // And nothing claims the stronger "unsafe for every method" verdict: a
      // reset says nothing about replaying an idempotent request.
      expect(res.isRetryable).toBeUndefined();
    } finally {
      server.close();
    }
  });

  test('a refused connection is still replayable', async () => {
    // Port 1 is refused at the TCP level, so nothing was ever written.
    const res = await new NodeAdapter().send({
      requestURL: 'http://localhost:1/thing',
      method: 'POST',
      headers: {},
      body: 'payload',
    });

    expect(res.status).toBe(0);
    expect(res.isTransportError).toBe(true);
    expect(res.wasDefinitelyNotSent).toBe(true);
  });

  // --- query params ---

  test('query params are serialized and echoed back', async () => {
    const res = await client
      .get('/api/query')
      .params({ q: 'hello', page: '2' })
      .send<{ params: Record<string, string> }>();

    expect(res.status).toBe(200);
    expect(res.body.params).toMatchObject({ q: 'hello', page: '2' });
  });
});

// ---------------------------------------------------------------------------
// Low-level adapter.send() tests — contract details the client layer would
// obscure (StreamResponseInfo shape, abort timing, status pass-through, etc.)
// ---------------------------------------------------------------------------

describe('NodeAdapter.send() — low-level contract', () => {
  let server: TestServer;
  let adapter: NodeAdapter;

  beforeAll(() => {
    server = startTestServer();
    adapter = new NodeAdapter();
  });

  afterAll(async () => {
    await server.stop();
  });

  test('getType returns node', () => {
    expect(adapter.getType()).toBe('node');
  });

  test('status codes pass through correctly', async () => {
    const res404 = await adapter.send(
      makeAdapterRequest(`${server.url}/api/does-not-exist`),
    );
    expect(res404.status).toBe(404);

    const res500 = await adapter.send(
      makeAdapterRequest(`${server.url}/api/error`),
    );
    expect(res500.status).toBe(500);
  });

  test('pre-aborted signal throws AbortError', async () => {
    const controller = new AbortController();
    controller.abort();

    let caught: Error | undefined;

    try {
      await adapter.send(
        makeAdapterRequest(`${server.url}/api/test`, {
          signal: controller.signal,
        }),
      );
    } catch (error) {
      caught = error as Error;
    }

    expect(caught?.name).toBe('AbortError');
  });

  test('upload progress fires to 100% for no-body request', async () => {
    const events: number[] = [];

    await adapter.send(
      makeAdapterRequest(`${server.url}/api/test`, {
        onUploadProgress: (e) => {
          events.push(e.progress);
        },
      }),
    );

    // No-body requests fire 0% before send and 100% after response headers
    expect(events).toContain(1);
  });

  test('download progress fires with final loaded === content-length', async () => {
    const events: Array<{ loaded: number; total: number; progress: number }> =
      [];

    await adapter.send(
      makeAdapterRequest(`${server.url}/api/binary`, {
        onDownloadProgress: (e) => {
          events.push(e);
        },
      }),
    );

    expect(events.length).toBeGreaterThan(0);
    expect(events[events.length - 1].progress).toBe(1);
    expect(events[events.length - 1].loaded).toBe(2048);
    expect(events[events.length - 1].total).toBe(2048);
  });

  test('streamResponse factory receives correct StreamResponseInfo fields', async () => {
    let capturedInfo: StreamResponseInfo | undefined;
    const { stream } = makeMemoryWritable();

    await adapter.send(
      makeAdapterRequest(`${server.url}/api/set-cookies`, {
        streamResponse: (info, _ctx) => {
          capturedInfo = info;
          return stream;
        },
        attemptNumber: 2,
        requestID: 'test-req-abc',
      }),
    );

    expect(capturedInfo?.status).toBe(200);
    expect(capturedInfo?.attempt).toBe(2);
    expect(capturedInfo?.requestID).toBe('test-req-abc');
    expect(capturedInfo?.url).toContain('/api/set-cookies');
    expect(typeof capturedInfo?.headers['content-type']).toBe('string');
    expect(Array.isArray(capturedInfo?.headers['set-cookie'])).toBe(true);
  });

  test('streamResponse factory throwing rejects the promise', async () => {
    // Factory errors are non-retryable setup failures — treated like interceptor
    // errors. The adapter rejects rather than resolving with an error status so
    // the client can distinguish this from a server-side failure.
    let caught: Error | undefined;

    try {
      await adapter.send(
        makeAdapterRequest(`${server.url}/api/binary`, {
          streamResponse: () => {
            throw new Error('factory failed: no space left on device');
          },
        }),
      );
    } catch (error) {
      caught = error as Error;
    }

    expect(caught?.message).toBe('factory failed: no space left on device');
  });

  test('streamResponse returning null rejects with AbortError', async () => {
    // null = factory-initiated cancel. The adapter fires the stream's abort
    // signal (so cleanup listeners run) then rejects as AbortError, which the
    // client catches and turns into isCancelled: true.
    let caught: Error | undefined;

    try {
      await adapter.send(
        makeAdapterRequest(`${server.url}/api/binary`, {
          streamResponse: () => null,
        }),
      );
    } catch (error) {
      caught = error as Error;
    }

    expect(caught?.name).toBe('AbortError');
  });

  test('streamResponse context signal fires when factory returns null', async () => {
    // The attempt-scoped AbortSignal passed to the factory fires in all
    // terminal cases so cleanup code co-located with stream setup always runs.
    // When the factory returns null (cancel), streamAbort.abort() is called
    // immediately — this is the most direct way to verify the signal propagates.
    let wasStreamSignalFired = false;

    const promise = adapter.send(
      makeAdapterRequest(`${server.url}/api/binary`, {
        streamResponse: (_info, ctx) => {
          ctx.signal.addEventListener('abort', () => {
            wasStreamSignalFired = true;
          });
          // null = cancel; adapter calls streamAbort.abort() before rejecting
          return null;
        },
      }),
    );

    await promise.catch(() => {
      // swallow AbortError from null cancel
    });

    expect(wasStreamSignalFired).toBe(true);
  });

  test('response body is correct Uint8Array bytes', async () => {
    const res = await adapter.send(
      makeAdapterRequest(`${server.url}/api/binary`),
    );

    expect(res.body).toBeInstanceOf(Uint8Array);
    expect((res.body as Uint8Array).length).toBe(2048);

    // Spot-check byte content (0-255 repeating)
    for (let i = 0; i < 256; i++) {
      expect((res.body as Uint8Array)[i]).toBe(i % 256);
    }
  });
});

describe('NodeAdapter — custom CA (ca option)', () => {
  let tlsServer: TlsTestServer;

  beforeAll(async () => {
    tlsServer = await startTlsTestServer();
  });

  afterAll(async () => {
    await tlsServer.stop();
  });

  test('succeeds when ca matches server certificate chain', async () => {
    const client = new HTTPClient({
      adapter: new NodeAdapter({ ca: getTestCACert() }),
      baseURL: tlsServer.url,
    });

    const res = await client.get('/api/test').send<{ ok: boolean }>();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  test('fails with network_error when no ca is provided (untrusted cert)', async () => {
    const client = new HTTPClient({
      adapter: new NodeAdapter(),
      baseURL: tlsServer.url,
    });

    const res = await client.get('/api/test').send();

    expect(res.isFailed).toBe(true);
    expect(res.isNetworkError).toBe(true);
  });

  test('succeeds with rejectUnauthorized:false even without ca', async () => {
    const client = new HTTPClient({
      adapter: new NodeAdapter({ rejectUnauthorized: false }),
      baseURL: tlsServer.url,
    });

    const res = await client.get('/api/test').send<{ ok: boolean }>();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  test('ca as Buffer is accepted', async () => {
    const client = new HTTPClient({
      adapter: new NodeAdapter({ ca: Buffer.from(getTestCACert()) }),
      baseURL: tlsServer.url,
    });

    const res = await client.get('/api/test').send<{ ok: boolean }>();

    expect(res.status).toBe(200);
  });

  test('ca as array is accepted', async () => {
    const client = new HTTPClient({
      adapter: new NodeAdapter({ ca: [getTestCACert()] }),
      baseURL: tlsServer.url,
    });

    const res = await client.get('/api/test').send<{ ok: boolean }>();

    expect(res.status).toBe(200);
  });
});

describe('NodeAdapter — servername option', () => {
  // Uses a cert with only DNS:localhost SAN — no IP SAN. Dialing 127.0.0.1
  // without servername fails because the IP doesn't match the DNS SAN.
  let tlsServer: TlsTestServer;

  beforeAll(async () => {
    tlsServer = await startTlsTestServerDnsOnly();
  });

  afterAll(async () => {
    await tlsServer.stop();
  });

  test('fails when dialing by IP without servername (IP not in cert SAN)', async () => {
    const client = new HTTPClient({
      adapter: new NodeAdapter({ ca: getTestCACert() }),
      baseURL: tlsServer.url,
    });

    const res = await client.get('/api/test').send();

    expect(res.isFailed).toBe(true);
    expect(res.isNetworkError).toBe(true);
  });

  test('succeeds when servername matches the cert DNS SAN', async () => {
    const client = new HTTPClient({
      adapter: new NodeAdapter({
        ca: getTestCACert(),
        servername: 'localhost',
      }),
      baseURL: tlsServer.url,
    });

    const res = await client.get('/api/test').send<{ ok: boolean }>();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});

// Asked once, of this runtime, using the same fixtures the tests use. Bun
// ignored `crl` entirely through 1.3.14 and implemented it in 1.4.0, so on an
// older runtime these would pass for the wrong reason or fail for a reason
// that is not ours. The normalization suite below is not gated — that part is
// our code and has to hold everywhere.
const doesRuntimeEnforceCRL = await detectCRLEnforcement();

describe('NodeAdapter — crl option (enforcement)', () => {
  const fixtures = getRevocationFixtures();

  // Trust both roots so the unrelated one can be used to exercise bundles and
  // CRL coverage without changing whether the chain itself validates.
  const ca = [fixtures.caCert, fixtures.unrelatedCACert];

  let revokedServer: TlsTestServer;
  let goodServer: TlsTestServer;

  beforeAll(async () => {
    revokedServer = await startTlsTestServerWith(fixtures.revoked);
    goodServer = await startTlsTestServerWith(fixtures.good);
  });

  afterAll(async () => {
    await revokedServer.stop();
    await goodServer.stop();
  });

  const get = async (config: NodeAdapterConfig, server: TlsTestServer) =>
    new HTTPClient({
      adapter: new NodeAdapter(config),
      baseURL: server.url,
    })
      .get('/api/test')
      .send();

  test.skipIf(!doesRuntimeEnforceCRL)(
    'a revoked certificate is rejected once its CRL is supplied',
    async () => {
      // Baseline first: without the CRL the certificate is perfectly valid, so
      // the CRL is demonstrably what changes the outcome rather than some other
      // property of this leaf.
      const withoutCRL = await get({ ca }, revokedServer);

      expect(withoutCRL.status).toBe(200);

      const withCRL = await get(
        { ca, crl: fixtures.crlRevoked },
        revokedServer,
      );

      expect(withCRL.isFailed).toBe(true);
      expect(withCRL.status).toBe(495);
    },
  );

  test.skipIf(!doesRuntimeEnforceCRL)(
    'a certificate that was not revoked still connects',
    async () => {
      const res = await get({ ca, crl: fixtures.crlRevoked }, goodServer);

      expect(res.status).toBe(200);
    },
  );

  test.skipIf(!doesRuntimeEnforceCRL)(
    'a CRL listing nothing revokes nothing',
    async () => {
      const res = await get({ ca, crl: fixtures.crlEmpty }, revokedServer);

      expect(res.status).toBe(200);
    },
  );

  test.skipIf(!doesRuntimeEnforceCRL)(
    'a concatenated CRL bundle is split, not truncated',
    async () => {
      // THE point of the option. Node reads only the first CRL of a PEM string,
      // so this bundle — unrelated root first, the revoking CRL second — would
      // enforce nothing and fail with UNABLE_TO_GET_CRL instead. Ordering is
      // deliberate: putting the revoking CRL first would pass even unsplit.
      const bundle = fixtures.unrelatedCRL + fixtures.crlRevoked;

      const res = await get({ ca, crl: bundle }, revokedServer);

      expect(res.status).toBe(495);
    },
  );

  test.skipIf(!doesRuntimeEnforceCRL)(
    'a bundle supplied as a Buffer still enforces',
    async () => {
      // The end-to-end counterpart of the normalization test: readFileSync
      // without an encoding is the default way to load a bundle, and Node
      // reads only its first CRL. Unrelated root first, so the revoking CRL is
      // the one that would be lost.
      const res = await get(
        { ca, crl: Buffer.from(fixtures.unrelatedCRL + fixtures.crlRevoked) },
        revokedServer,
      );

      expect(res.status).toBe(495);
    },
  );

  test.skipIf(!doesRuntimeEnforceCRL)(
    'a bundle INSIDE an array is split too',
    async () => {
      // The truncation is per string, not per argument, so an array element that
      // is itself a bundle loses everything after its first CRL. A string in an
      // array has to behave exactly like a string passed on its own.
      const res = await get(
        { ca, crl: [fixtures.unrelatedCRL + fixtures.crlRevoked] },
        revokedServer,
      );

      expect(res.status).toBe(495);
    },
  );

  test.skipIf(!doesRuntimeEnforceCRL)(
    'an array of individual CRLs works unchanged',
    async () => {
      const res = await get(
        { ca, crl: [fixtures.unrelatedCRL, fixtures.crlRevoked] },
        revokedServer,
      );

      expect(res.status).toBe(495);
    },
  );

  test.skipIf(!doesRuntimeEnforceCRL)(
    'a single CRL and a Buffer are passed through',
    async () => {
      const asString = await get(
        { ca, crl: fixtures.crlRevoked },
        revokedServer,
      );
      const asBuffer = await get(
        { ca, crl: Buffer.from(fixtures.crlRevoked) },
        revokedServer,
      );

      expect(asString.status).toBe(495);
      expect(asBuffer.status).toBe(495);
    },
  );

  test.skipIf(!doesRuntimeEnforceCRL)(
    'a chain with no covering CRL is refused, even unrevoked',
    async () => {
      // X509_V_FLAG_CRL_CHECK_ALL: supplying any CRL demands one for every
      // element of the chain. This certificate was never revoked and its own
      // root has a CRL available — it is refused because the CRL supplied covers
      // a different root. Documented because it is an availability cliff, not a
      // bug: a partial CRL set takes out every root it does not cover.
      const res = await get({ ca, crl: fixtures.unrelatedCRL }, goodServer);

      expect(res.isFailed).toBe(true);
      expect(res.status).toBe(495);
    },
  );

  test.skipIf(!doesRuntimeEnforceCRL)(
    'the CRL is read per request, not captured at construction',
    async () => {
      // The refresh story depends on this: re-passing a CRL has to take effect
      // without rebuilding the adapter, since a revocation set changes far more
      // often than a client does.
      const config: NodeAdapterConfig = { ca, crl: fixtures.crlEmpty };
      const client = new HTTPClient({
        adapter: new NodeAdapter(config),
        baseURL: revokedServer.url,
      });

      expect((await client.get('/api/test').send()).status).toBe(200);

      config.crl = fixtures.crlRevoked;

      expect((await client.get('/api/test').send()).status).toBe(495);
    },
  );
});

describe('NodeAdapter — crl option (normalization)', () => {
  // Not gated on the runtime. Whether a CRL is ENFORCED is the runtime's job;
  // handing Node the shape it can actually read is ours, and that has to hold
  // everywhere — including on a runtime that ignores the option entirely,
  // where an enforcement test would pass for the wrong reason.
  const fixtures = getRevocationFixtures();

  const captureCRL = async (config: NodeAdapterConfig): Promise<unknown> => {
    let captured: unknown;

    const spy = spyOn(https, 'request').mockImplementation(((
      options: https.RequestOptions,
    ) => {
      captured = options.crl;

      // Minimal stand-in for ClientRequest: capture the options, then fail the
      // request immediately so send() settles without a socket. Only the
      // members the adapter actually touches are provided.
      const req = new EventEmitter();
      const stub = req as unknown as Record<string, unknown>;

      stub.setHeader = () => {};
      stub.getHeaders = () => ({});
      stub.destroy = () => {};
      stub.end = () => {
        queueMicrotask(() =>
          req.emit(
            'error',
            Object.assign(new Error('captured'), { code: 'ECONNRESET' }),
          ),
        );
      };

      return req as unknown as http.ClientRequest;
    }) as unknown as typeof https.request);

    try {
      await new NodeAdapter(config).send({
        requestURL: 'https://crl.test/api',
        method: 'GET',
        headers: {},
      });
    } finally {
      spy.mockRestore();
    }

    return captured;
  };

  const countCRLs = (value: unknown): number => {
    const blocks = (text: unknown) =>
      typeof text === 'string'
        ? (text.match(/-----BEGIN X509 CRL-----/g) ?? []).length
        : 1;

    return Array.isArray(value)
      ? value.reduce<number>((total, entry) => total + blocks(entry), 0)
      : blocks(value);
  };

  test('a two-CRL bundle becomes a two-element array', async () => {
    const captured = await captureCRL({
      crl: fixtures.unrelatedCRL + fixtures.crlRevoked,
    });

    expect(Array.isArray(captured)).toBe(true);
    expect(captured).toHaveLength(2);
    expect(countCRLs(captured)).toBe(2);
  });

  test('a bundle inside an array is flattened, not left truncated', async () => {
    const captured = await captureCRL({
      crl: [fixtures.unrelatedCRL + fixtures.crlRevoked, fixtures.crlEmpty],
    });

    // Two from the bundle plus the standalone one. Without the per-element
    // split this stays length 2 and silently carries only two of the three.
    expect(captured).toHaveLength(3);
    expect(countCRLs(captured)).toBe(3);
  });

  test('a single CRL string is left exactly as it was', async () => {
    const captured = await captureCRL({ crl: fixtures.crlRevoked });

    // Not wrapped in an array: passing it through unchanged keeps Node's own
    // error reporting intact for a malformed value rather than masking it.
    expect(captured).toBe(fixtures.crlRevoked);
  });

  test('a PEM bundle in a Buffer is split, not truncated', async () => {
    // fs.readFileSync('bundle.pem') without an encoding returns a Buffer, and
    // that is the default way to load a file. Its contents are PEM like any
    // other bundle, so Node reads only the first CRL from it — passing Buffers
    // straight through would leave the most ordinary usage silently truncated.
    const captured = await captureCRL({
      crl: Buffer.from(fixtures.unrelatedCRL + fixtures.crlRevoked),
    });

    expect(Array.isArray(captured)).toBe(true);
    expect(captured).toHaveLength(2);
  });

  test('a Buffer holding one CRL is handed back unchanged', async () => {
    // Nothing to split, so return what the caller gave rather than a
    // re-encoded copy.
    const buffer = Buffer.from(fixtures.crlRevoked);
    const captured = await captureCRL({ crl: buffer });

    expect(captured).toBe(buffer);
  });

  test('a DER Buffer is passed through untouched', async () => {
    // DER has no armour to look for and encodes exactly one CRL, so there is
    // nothing to split. The question is PEM-or-DER, not string-or-Buffer.
    const der = Buffer.from([0x30, 0x82, 0x01, 0x2a, 0x30, 0x81, 0xd1]);
    const captured = await captureCRL({ crl: der });

    expect(captured).toBe(der);
  });

  test('a Buffer bundle inside an array is split too', async () => {
    const captured = await captureCRL({
      crl: [Buffer.from(fixtures.unrelatedCRL + fixtures.crlRevoked)],
    });

    expect(captured).toHaveLength(2);
  });

  test('a damaged Buffer bundle is refused like a damaged string', async () => {
    let rejection: unknown;

    try {
      await captureCRL({
        crl: Buffer.from(`${fixtures.crlEmpty}\n-----BEGIN X509 CRL----\nQkJC`),
      });
    } catch (error) {
      rejection = error;
    }

    expect((rejection as Error | undefined)?.message).toMatch(
      /outside any complete/,
    );
  });

  test('an array of single CRLs keeps its entries', async () => {
    const captured = await captureCRL({
      crl: [fixtures.crlRevoked, fixtures.unrelatedCRL],
    });

    expect(captured).toEqual([fixtures.crlRevoked, fixtures.unrelatedCRL]);
  });

  test('a string with no CRL armour at all is refused', async () => {
    // Previously passed through so Node could reject it with
    // ERR_CRYPTO_OPERATION_FAILED. It is still refused, just with a message
    // that names the actual problem. A non-PEM string is never valid here —
    // DER belongs in a Buffer, which skips this path entirely.
    let rejection: unknown;

    try {
      await captureCRL({ crl: 'NOT-A-CRL' });
    } catch (error) {
      rejection = error;
    }

    expect((rejection as Error | undefined)?.message).toMatch(
      /outside any complete/,
    );
  });

  test('a truncated CRL in a bundle is refused, not dropped', async () => {
    // Splitting returns only the COMPLETE blocks, so a cut-short entry would
    // otherwise disappear and the caller would enforce a set they never
    // supplied — with the intact CRLs still applied, which is what makes it
    // silent. Passing the string through unsplit is no better: Node reads the
    // first CRL and ignores the damage just as quietly.
    const truncated =
      fixtures.crlEmpty +
      '-----BEGIN X509 CRL-----\nMIIBzzCCAXUCAQEwCgYIKoZIzj0EAwIw';

    let rejection: unknown;

    try {
      await captureCRL({ crl: truncated });
    } catch (error) {
      rejection = error;
    }

    expect((rejection as Error | undefined)?.message).toMatch(
      /outside any complete/,
    );
  });

  test('a DAMAGED delimiter is refused, not just an exact one', async () => {
    // The check cannot be a search for well-formed armour. A delimiter that
    // lost or gained a hyphen still marks a CRL that was cut short, but it
    // matches no exact-string search — so the entry would be dropped and the
    // bundle would enforce silently with one CRL missing. Every one of these
    // produced blocks.length === 1 and passed an exact-armour check.
    const damaged = [
      '----BEGIN X509 CRL-----\nQkJCQg==', // one hyphen short
      '------BEGIN X509 CRL-----\nQkJCQg==', // one too many
      '-----BEGIN X509 CRL----\nQkJCQg==', // clipped tail
      '-----END X509 CRL-----', // footer with no header
      '-----BEG1N X509 CRL-----\nQkJCQg==', // mangled keyword
    ];

    for (const suffix of damaged) {
      let rejection: unknown;

      try {
        await captureCRL({ crl: `${fixtures.crlEmpty}\n${suffix}` });
      } catch (error) {
        rejection = error;
      }

      expect((rejection as Error | undefined)?.message).toMatch(
        /outside any complete/,
      );
    }
  });

  test('a lone truncated CRL is refused too', async () => {
    // No complete block at all, so nothing would be split — but the caller
    // still handed over something broken, and saying so beats letting it
    // through for Node to reject with a less specific error.
    let rejection: unknown;

    try {
      await captureCRL({ crl: '-----BEGIN X509 CRL-----\nMIIBzzCCAXUCAQEw' });
    } catch (error) {
      rejection = error;
    }

    expect((rejection as Error | undefined)?.message).toMatch(
      /outside any complete/,
    );
  });

  test('anything outside a complete block is refused', async () => {
    // The rule is exact: PEM blocks separated by whitespace, nothing else.
    // Earlier heuristics tried to admit commentary while still catching a
    // truncated CRL, and every narrowing swapped one failure for the other —
    // an exact-armour search missed `----BEGIN`, any-triple-hyphen refused a
    // Markdown rule, fused-hyphens refused an issuer CN of `ACME---Production`.
    // A parser cannot tell prose from a half a CRL, so neither is accepted.
    const rejected = [
      '----BEGIN X509 CRL-----\nQkJCQg==', // one hyphen short
      '------BEGIN X509 CRL-----\nQkJCQg==', // one too many
      '-----BEGIN X509 CRL----\nQkJCQg==', // clipped tail
      '-----BEG1N X509 CRL-----\nQkJCQg==', // mangled keyword
      '-----END X509 CRL-----', // footer with no header
      'QkJCQg==', // a body whose armour is gone entirely
      'Certificate Revocation List (CRL):', // decoded `-text` header
      '--- CRL export ---', // commentary
    ];

    for (const suffix of rejected) {
      let rejection: unknown;

      try {
        await captureCRL({ crl: `${fixtures.crlEmpty}\n${suffix}` });
      } catch (error) {
        rejection = error;
      }

      expect((rejection as Error | undefined)?.message).toMatch(
        /outside any complete/,
      );
    }
  });

  test('whitespace between and around blocks is fine', async () => {
    // What every producer of a bundle actually emits: blocks separated by
    // newlines, sometimes with trailing whitespace. This has to keep working
    // or the exact rule would be useless.
    const captured = await captureCRL({
      crl: `\n  ${fixtures.crlEmpty}\n\n\t${fixtures.unrelatedCRL}\n  \n`,
    });

    expect(captured).toHaveLength(2);
  });

  test('no crl option means no crl in the request', async () => {
    const captured = await captureCRL({});

    expect(captured).toBeUndefined();
  });
});
