import { describe, expect, test, beforeAll, afterAll, spyOn } from 'bun:test';
import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import * as http from 'node:http';
import * as https from 'node:https';
import type { Socket } from 'node:net';
import { Writable } from 'node:stream';
import { NodeAdapter } from './node-adapter';
import type { NodeAdapterConfig } from './node-adapter';
import { HTTPClient } from '../http-client';
import { CookieJar } from '../cookie-jar';
import {
  NON_RETRYABLE_HTTP_CLIENT_CALLBACK_ERROR_FLAG,
  REQUEST_BODY_SETTLED_KEY,
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

test.each(['abort', 'close'] as const)(
  'cleans up a pending streamResponse factory after %s',
  async (mode) => {
    let response: http.ServerResponse | undefined;
    const server = http.createServer((_req, res) => {
      response = res;
      res.writeHead(200, { 'Content-Length': '100' });
      res.flushHeaders();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('No test address');
    }
    const controller = new AbortController();
    const entered = Promise.withResolvers<AbortSignal>();
    const factory = Promise.withResolvers<Writable>();
    const { stream } = makeMemoryWritable();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const pending = new NodeAdapter()
      .send(
        makeAdapterRequest(`http://127.0.0.1:${String(address.port)}/`, {
          signal: controller.signal,
          streamResponse: (_info, context) => {
            entered.resolve(context.signal);
            return factory.promise;
          },
        }),
      )
      .then(
        (result) => result,
        (error: unknown) => error,
      );
    try {
      const signal = await entered.promise;
      if (mode === 'abort') {
        controller.abort();
      } else {
        response?.socket?.end();
      }
      const result = await Promise.race([
        pending,
        new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(
            () => reject(new Error('Adapter did not settle')),
            1000,
          );
        }),
      ]);
      expect(signal.aborted).toBe(true);
      if (mode === 'abort') {
        expect(result).toBeInstanceOf(Error);
      } else {
        expect((result as AdapterResponse).isStreamError).toBe(true);
      }
      factory.resolve(stream);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(stream.destroyed).toBe(true);
    } finally {
      clearTimeout(deadline);
      factory.resolve(stream);
      controller.abort();
      stream.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await pending;
    }
  },
);

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

  test('stores Set-Cookie even when the caller cancelled', async () => {
    const jar = new CookieJar();
    const controller = new AbortController();

    // Cancel at the moment the body read fails, so the headers have already
    // been received and attached — a pre-aborted signal never reaches the
    // adapter at all.
    const adapter: HTTPAdapter = {
      getType: () => 'node',
      send: (): Promise<AdapterResponse> => {
        controller.abort();

        const abortError = new Error(
          'Request aborted during response streaming',
        );
        abortError.name = 'AbortError';
        Object.assign(abortError, {
          [RESPONSE_STREAM_ABORT_FLAG]: true,
          streamAbortStatus: 200,
          streamAbortHeaders: { 'set-cookie': 'session=abc123; Path=/' },
        });

        return Promise.reject(abortError);
      },
    };

    const client = new HTTPClient({ adapter, cookieJar: jar });

    const res = await client
      .get('https://example.com/download')
      .signal(controller.signal)
      .send();

    // Aborting the body read does not un-receive the headers, and browsers
    // keep these cookies too.
    expect(res.isCancelled).toBe(true);
    expect(jar.getCookieHeaderString('https://example.com/next')).toBe(
      'session=abc123',
    );
  });

  test('ignores stream metadata on an error that was never tagged', async () => {
    const jar = new CookieJar();

    const adapter: HTTPAdapter = {
      getType: () => 'node',
      send: (): Promise<AdapterResponse> => {
        // Shaped like a tagged response abort, but carrying no marker. Any
        // adapter error could hold these fields by coincidence, and this path
        // writes to the cookie jar.
        const untagged = new Error('ordinary adapter failure');
        Object.assign(untagged, {
          streamAbortStatus: 200,
          streamAbortHeaders: { 'set-cookie': 'injected=evil; Path=/' },
        });

        return Promise.reject(untagged);
      },
    };

    const client = new HTTPClient({ adapter, cookieJar: jar });

    await client.get('https://example.com/thing').send();

    expect(jar.getCookieHeaderString('https://example.com/next')).toBe('');
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
  test('a frozen error from the factory is still classified as non-retryable', async () => {
    // `markStreamFactoryError` tags the error in place so the caller keeps its identity.
    // A frozen error refuses that assignment in strict mode, and falling through untagged
    // is the damaging outcome: the client reads both flags to classify a stream setup
    // failure as non-retryable, so without them the request lands in the generic retry
    // arm and the factory is invoked a second time.
    const net = await import('node:net');

    const server = net.createServer((socket) => {
      socket.on('data', () => {
        socket.end(
          'HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: 4\r\n\r\nbody',
        );
      });
    });

    await new Promise<void>((done) => {
      server.listen(0, '127.0.0.1', done);
    });

    const { port } = server.address() as { port: number };

    let factoryCalls = 0;

    try {
      const client = new HTTPClient({
        adapter: new NodeAdapter(),
        baseURL: `http://127.0.0.1:${port}`,
        retryPolicy: { strategy: 'fixed', maxRetryAttempts: 2, delayMS: 1 },
      });

      const builder = client.get('/frozen').streamResponse(() => {
        factoryCalls++;

        const frozen: Error = Object.freeze(
          new Error('frozen factory failure'),
        );

        throw frozen;
      });

      const res = await builder.send();

      expect(res.isFailed).toBe(true);
      expect(builder.error?.code).toBe('stream_setup_error');
      // The whole point: not retried.
      expect(factoryCalls).toBe(1);
      // The original survives on the carrier's cause.
      expect(builder.error?.cause?.message).toContain('frozen factory failure');
    } finally {
      await new Promise<void>((done) => {
        server.close(() => done());
      });
    }
  });

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

  test('a cross-origin redirect hop does not stay on the unix socket', async () => {
    // The socket is the caller's chosen endpoint, often a privileged one. A `Location`
    // to another host used to keep `socketPath` and change only the request line, so the
    // redirect became a second request against that same socket - the same class of
    // retargeting `mtls.cert` and `servername` are already withheld for.
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
        requestURL: 'http://evil.test/privileged',
        initialURL: 'http://localhost/v1.41/info',
        method: 'GET',
        headers: {},
      });

      expect(capturedOptions?.socketPath).toBeUndefined();
      expect(capturedOptions?.hostname).toBe('evil.test');
      expect(capturedOptions?.port).toBe(80);
      expect(capturedOptions?.path).toBe('/privileged');
    } finally {
      requestSpy.mockRestore();
    }
  });

  test('a same-origin redirect hop keeps the unix socket', async () => {
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
        requestURL: 'http://localhost/v1.41/containers',
        initialURL: 'http://localhost/v1.41/info',
        method: 'GET',
        headers: {},
      });

      expect(capturedOptions?.socketPath).toBe('/tmp/test.sock');
    } finally {
      requestSpy.mockRestore();
    }
  });

  test('URL userinfo is presented as Basic auth on a same-origin request', async () => {
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
        requestURL: 'http://user:hunter2@example.test/data',
        method: 'GET',
        headers: {},
      });

      expect(capturedOptions?.auth).toBe('user:hunter2');
    } finally {
      requestSpy.mockRestore();
    }
  });

  test('a cross-origin redirect hop does not carry URL userinfo as Basic auth', async () => {
    // The credential is addressed to an origin the caller named, and a `Location` is the
    // remote server's choice - the same retargeting `socketPath` and `mtls.cert` are
    // withheld for, except the secret rides in the request itself rather than in the
    // handshake. `HTTPClient` strips userinfo from a `Location` before dispatch, so this
    // is the adapter being driven directly.
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
        requestURL: 'http://user:hunter2@evil.test/collect',
        initialURL: 'http://api.example.test/start',
        method: 'GET',
        headers: {},
      });

      expect(capturedOptions?.auth).toBeUndefined();
      expect(capturedOptions?.hostname).toBe('evil.test');
    } finally {
      requestSpy.mockRestore();
    }
  });

  test('a same-origin redirect hop keeps URL userinfo', async () => {
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
        requestURL: 'http://user:hunter2@api.example.test/next',
        initialURL: 'http://api.example.test/start',
        method: 'GET',
        headers: {},
      });

      expect(capturedOptions?.auth).toBe('user:hunter2');
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

  test('a throwing transport code getter resolves conservatively', async () => {
    const transportError = new Error('socket failed');
    Object.defineProperty(transportError, 'code', {
      get(): never {
        throw new Error('hostile code getter');
      },
    });

    const req = new MockClientRequest();
    const requestSpy = spyOn(http, 'request').mockImplementation(
      (_options, _callback) => {
        queueMicrotask(() => {
          req.emit('error', transportError);
        });
        return req as unknown as http.ClientRequest;
      },
    );

    try {
      const response = await new NodeAdapter().send({
        requestURL: 'http://example.test/data',
        method: 'GET',
        headers: {},
      });

      // An unreadable code supplies no proof that the request was never sent,
      // but it must still settle through the ordinary transport-error path.
      // Unproven is reported by omitting the field, never as `false` — the
      // contract is that absence means "not known".
      expect(response.status).toBe(0);
      expect(response.isTransportError).toBe(true);
      expect(response.wasDefinitelyNotSent).toBeUndefined();
      expect('wasDefinitelyNotSent' in response).toBe(false);
      expect(response.errorCause).toBe(transportError);
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

  test('one upload-side socket failure after the response is reported once', async () => {
    // A single reset arrives twice: the writer's own per-write `req.once('error', ...)`
    // rejects with it, and this request's `'error'` handler is handed the same error a
    // tick later. Both then rendered it onto the host's `'error'` channel and armed a
    // grace deadline of their own, so one failure read as two.
    const req = new MockClientRequest();
    const res = new MockIncomingMessage(200, { 'content-type': 'text/plain' });
    const failure = new Error('read ECONNRESET');

    const requestSpy = spyOn(http, 'request').mockImplementation(
      (_options, callback) => {
        const cb = callback as
          ((res: http.IncomingMessage) => void) | undefined;

        queueMicrotask(() => {
          cb?.(res as unknown as http.IncomingMessage);
          queueMicrotask(() => {
            res.emit('data', Buffer.from('ok'));
            res.emit('end');
            res.emit('close');
            // Both channels, as a real socket reset reaches both.
            req.emit('error', failure);
          });
        });

        return req as unknown as http.ClientRequest;
      },
    );

    const reports: unknown[] = [];
    const onError = (event: Event): void => {
      reports.push(event);
      event.preventDefault();
    };

    globalThis.addEventListener('error', onError);

    try {
      const response = await new NodeAdapter().send({
        requestURL: 'http://example.test/upload',
        method: 'POST',
        headers: {},
        body: 'x'.repeat(64 * 1024),
      });

      expect(response.status).toBe(200);

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(reports.length).toBe(1);
    } finally {
      globalThis.removeEventListener('error', onError);
      requestSpy.mockRestore();
    }
  });

  test('the stall watchdog leaves a writer waiting on a slow source alone', async () => {
    // Progress is bytes the socket accepted, and a writer parked in `Blob.stream()`'s
    // `read()` makes none - so a multipart `File` on a slow disk, with the server already
    // answered, was destroyed as "stalled" after five seconds of the socket doing nothing
    // wrong. The writer now says when it is waiting on the source, and that wait has a
    // grace of its own.
    const req = new MockClientRequest();
    const res = new MockIncomingMessage(200, { 'content-type': 'text/plain' });

    const requestSpy = spyOn(http, 'request').mockImplementation(
      (_options, callback) => {
        const cb = callback as
          ((res: http.IncomingMessage) => void) | undefined;

        queueMicrotask(() => {
          cb?.(res as unknown as http.IncomingMessage);
          // The server answers in full while the file is still being read.
          queueMicrotask(() => {
            res.emit('data', Buffer.from('ok'));
            res.emit('end');
            res.emit('close');
          });
        });

        return req as unknown as http.ClientRequest;
      },
    );

    // `FormData` re-wraps a `Blob`, so a subclass override does not reach the writer; the
    // prototype does. Half the bytes at once, the other half after a gap longer than the
    // socket grace.
    const streamSpy = spyOn(Blob.prototype, 'stream').mockImplementation(
      function (this: Blob) {
        const size = this.size;
        const half = Math.floor(size / 2);

        return new ReadableStream<Uint8Array<ArrayBuffer>>({
          start(controller) {
            controller.enqueue(new Uint8Array(half));
            setTimeout(() => {
              controller.enqueue(new Uint8Array(size - half));
              controller.close();
            }, 6_500);
          },
        });
      },
    );

    try {
      const fd = new FormData();
      fd.append('file', new Blob([new Uint8Array(8)]), 'slow.bin');

      const response = await new NodeAdapter().send({
        requestURL: 'http://example.test/upload',
        method: 'POST',
        headers: {},
        body: fd,
      });

      expect(response.status).toBe(200);

      const outcome = await Promise.race([
        response.requestBodySettled,
        new Promise((resolve) => setTimeout(() => resolve('hung'), 15_000)),
      ]);

      // Completed, not stalled: the upload finished once the source answered.
      expect(outcome).toBeUndefined();
      expect(req.ended).toBe(true);
      expect(req.destroyed).toBe(false);
    } finally {
      streamSpy.mockRestore();
      requestSpy.mockRestore();
    }
  }, 30000);

  test('the stall watchdog settles the upload outcome it gives up on', async () => {
    // `endBodyWrite` and `reportWriteErrorAfterResponse` both answer `requestBodySettled`
    // because the writer may never come back to answer it itself. The watchdog destroyed
    // the request and answered nothing: a writer parked with no pending callback - inside
    // `Blob.stream()`'s `read()`, or on a `write` that never calls back - has nothing for
    // the destroy to reject, so it never returns to notice, and
    // `await response.requestBodySettled` waited forever on an upload this had already
    // given up on. That is the exact hang `reportWriteErrorAfterResponse` documents fixing,
    // reached through the other door.
    //
    // A `write` that accepts the chunk and never acknowledges it is the parked writer in
    // its smallest form: `destroy()` on this request emits nothing, exactly as a reader
    // that never yields hands the writer nothing to unblock on.
    const req = new MockClientRequest(() => true);
    const res = new MockIncomingMessage(200, { 'content-type': 'text/plain' });

    const requestSpy = spyOn(http, 'request').mockImplementation(
      (_options, callback) => {
        const cb = callback as
          ((res: http.IncomingMessage) => void) | undefined;

        queueMicrotask(() => {
          cb?.(res as unknown as http.IncomingMessage);
          // The server answers in full while the upload is still parked.
          queueMicrotask(() => {
            res.emit('data', Buffer.from('ok'));
            res.emit('end');
            res.emit('close');
          });
        });

        return req as unknown as http.ClientRequest;
      },
    );

    // The docs promise every late upload failure on the host's `'error'` channel whether
    // or not anyone awaits the promise, and name the watchdog as one of them. It was the
    // one late failure that settled the promise and said nothing else.
    const reports: ErrorEvent[] = [];
    const onError = (event: Event): void => {
      reports.push(event as ErrorEvent);
      event.preventDefault();
    };

    globalThis.addEventListener('error', onError);

    try {
      const response = await new NodeAdapter().send({
        requestURL: 'http://example.test/upload',
        method: 'POST',
        headers: {},
        body: 'x'.repeat(256 * 1024),
      });

      expect(response.status).toBe(200);

      const outcome = await Promise.race([
        response.requestBodySettled,
        // Two watchdog windows and change: the first re-arms if the opening chunk moved
        // the counter after it was armed. See `UPLOAD_STALL_GRACE_MS`.
        new Promise((resolve) => setTimeout(() => resolve('hung'), 12_000)),
      ]);

      expect(outcome).toBeInstanceOf(Error);
      expect(req.destroyed).toBe(true);

      expect(reports.length).toBe(1);
      expect(reports[0]?.error).toBe(outcome);
    } finally {
      globalThis.removeEventListener('error', onError);
      requestSpy.mockRestore();
    }
  }, 30000);

  test('a socket error while the streamResponse factory is still opening settles', async () => {
    // The one window where "the response side always settles on its own" is not true.
    // `res`'s own handlers are installed by `streamResponseBody`, which does not run until
    // the factory has resolved - so a socket reset during an `await`ed factory reached
    // nothing at all: the request's `'error'` handler stood down because the headers had
    // already arrived, `res` had no listeners to see it, and the adapter promise never
    // settled. The caller hung until its own signal, with no timeout of the adapter's own.
    const req = new MockClientRequest();
    const res = new MockIncomingMessage(200, {
      'content-type': 'application/octet-stream',
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
          // Mid-setup, while the factory below is still opening its sink.
          queueMicrotask(() => {
            req.emit('error', new Error('read ECONNRESET'));
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
          streamResponse: async () => {
            await new Promise((resolve) => setTimeout(resolve, 20));

            return writable;
          },
        }),
        new Promise((resolve) => setTimeout(() => resolve('timeout'), 500)),
      ]);

      expect(result).not.toBe('timeout');

      const response = result as AdapterResponse;

      expect(response.status).toBe(200);
      expect(response.isStreamError).toBe(true);
      expect(response.streamErrorCode).toBe('stream_response_error');
      expect(response.errorCause?.message).toContain('ECONNRESET');
      expect(req.destroyed).toBe(true);

      // The factory's sink arrives after the request is over, and is closed rather than
      // left open: the stream signal is aborted, which is what the post-await check reads.
      await new Promise((resolve) => setTimeout(resolve, 50));

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

  test('a second request sharing a writable gets its own absorber window', async () => {
    // One absorber covers every request sharing the writable, and only the request that
    // *attached* it scheduled the backstop that takes it off. A later request settling near
    // the end of that window inherited whatever was left of it - which can be no window at
    // all - while `cleanup` had just removed its own `'error'` listener, so the late error
    // the absorber exists for arrived with nothing attached. Each request that relies on it
    // now pushes the deadline out, and an absolute lifetime keeps "pushes it out" from
    // meaning "forever".
    const writable = new EventEmitter() as unknown as WritableLike;

    writable.write = () => true;
    writable.end = (callback?: () => void) => {
      callback?.();
    };
    writable.destroy = () => writable;

    const countErrorListeners = (): number =>
      (writable as unknown as EventEmitter).listenerCount('error');

    const sendOne = async (): Promise<void> => {
      const req = new MockClientRequest();
      const res = new MockIncomingMessage(200, {
        'content-type': 'application/octet-stream',
        'content-length': '0',
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
        await new NodeAdapter().send({
          requestURL: 'http://example.test/data',
          method: 'GET',
          headers: {},
          streamResponse: () => writable,
        });
      } finally {
        requestSpy.mockRestore();
      }
    };

    await sendOne();

    // The absorber, with the request's own `onWritableError` already removed by `cleanup`.
    expect(countErrorListeners()).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 800));
    await sendOne();

    // 700 ms after the second request settled, and 1.5 s after the first: the first
    // request's one-second backstop has passed, and the second's has not.
    await new Promise((resolve) => setTimeout(resolve, 700));

    expect(countErrorListeners()).toBe(1);

    // And it does come off - the extension is a new window, not the removal of the bound.
    await new Promise((resolve) => setTimeout(resolve, 600));

    expect(countErrorListeners()).toBe(0);
  }, 15000);

  test("a writable emitting a non-Error 'error' still yields an Error cause", async () => {
    const req = new MockClientRequest();
    const res = new MockIncomingMessage(200, {
      'content-type': 'application/octet-stream',
      'content-length': '5',
    });
    const writable = new EventEmitter() as unknown as WritableLike;
    writable.write = () => true;
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
            // `WritableLike` declares the listener as taking an `Error`, but the value is
            // whatever the writable emitted, and a hand-written one is under no
            // obligation. This was the last route by which a non-`Error` could reach
            // `AdapterResponse.errorCause`, which also declares an `Error`.
            (writable as unknown as EventEmitter).emit('error', 'disk full');
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

      expect(response.isStreamError).toBe(true);
      expect(response.streamErrorCode).toBe('stream_write_error');
      expect(response.errorCause).toBeInstanceOf(Error);
      expect(response.errorCause?.message).toContain('disk full');
      expect((response.errorCause as Error).cause).toBe('disk full');
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

  test('a writable that errored without telling end resolves as stream_write_error', async () => {
    // Some runtimes destroy a writable on a failed write and then call `end`'s callback
    // with nothing, so the callback's own argument says the download finished. `errored`
    // is the second signal that says otherwise; ignoring it settles a truncated file as a
    // success, which is the one answer a download must never give.
    const req = new MockClientRequest();
    const res = new MockIncomingMessage(200, {
      'content-type': 'application/octet-stream',
      'content-length': '1',
    });
    const writable = new EventEmitter() as unknown as WritableLike;
    writable.write = () => true;
    writable.end = (callback?: (err?: Error | null) => void) => {
      writable.errored = new Error('destroyed mid-write');
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
      expect(response.errorCause?.message).toBe('destroyed mid-write');
    } finally {
      requestSpy.mockRestore();
    }
  });

  test('a write that fails only through its callback is a stream_write_error', async () => {
    // The third way a writable can report a failed write, alongside `end`'s callback and
    // `errored`: the callback handed to `write` itself, which `WritableLike` names as a
    // failure channel. Dropping it settled a truncated download as a success.
    const req = new MockClientRequest();
    const res = new MockIncomingMessage(200, {
      'content-type': 'application/octet-stream',
      'content-length': '1',
    });
    const writable = new EventEmitter() as unknown as WritableLike;
    writable.write = (
      _chunk: unknown,
      callback?: (err?: Error | null) => void,
    ) => {
      callback?.(new Error('disk full'));

      return true;
    };
    writable.end = (callback?: (err?: Error | null) => void) => {
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
      expect(response.errorCause?.message).toBe('disk full');
    } finally {
      requestSpy.mockRestore();
    }
  });

  test('a synchronous write failure does not pause the settled response', async () => {
    // Nothing obliges `write`'s callback to be asynchronous, so a writable can report a
    // failure through it and *then* return `false` for backpressure. The failure settles
    // the request from inside the `write` call, and `settle` runs `cleanup`, which
    // detaches the `'drain'` listener that undoes a pause - so applying one here would
    // leave the response paused with nothing left able to resume it.
    const req = new MockClientRequest();
    const res = new MockIncomingMessage(200, {
      'content-type': 'application/octet-stream',
      'content-length': '1',
    });
    const writable = new EventEmitter() as unknown as WritableLike;
    writable.write = (
      _chunk: unknown,
      callback?: (err?: Error | null) => void,
    ) => {
      callback?.(new Error('disk full'));

      // Backpressure reported after the failure, in the same call.
      return false;
    };
    writable.end = (callback?: (err?: Error | null) => void) => {
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

      expect(response.isStreamError).toBe(true);
      expect(response.streamErrorCode).toBe('stream_write_error');
      expect(response.errorCause?.message).toBe('disk full');
      // The whole point: no pause was applied after the request settled.
      expect(res.pauseCalls).toBe(0);
    } finally {
      requestSpy.mockRestore();
    }
  });

  test('a throwing errored accessor costs the signal, not the request', async () => {
    // `errored` is read inside `end`'s callback, which a real stream invokes on a later
    // tick with no `try` above it. An unguarded throw there is an uncaught exception that
    // ends the process, so the read degrades to "no second signal" instead - and the
    // download, which actually succeeded, still resolves as one.
    const req = new MockClientRequest();
    const res = new MockIncomingMessage(200, {
      'content-type': 'application/octet-stream',
      'content-length': '1',
    });
    const writable = new EventEmitter() as unknown as WritableLike;
    writable.write = () => true;
    // Deferred, as a real stream defers it: invoking the callback synchronously would put
    // the throw back inside the `try` that wraps the `end` call, which is not the failure
    // being guarded against. On a later tick there is nothing above it to catch.
    writable.end = (callback?: (err?: Error | null) => void) => {
      setImmediate(() => callback?.());
    };
    writable.destroy = () => writable;
    Object.defineProperty(writable, 'errored', {
      get() {
        throw new Error('hostile errored accessor');
      },
    });
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
      expect(response.isStreamError).toBeFalsy();
      expect(response.streamErrorCode).toBeUndefined();
    } finally {
      requestSpy.mockRestore();
    }
  });

  test('the pending-error listener is absorbed and then released', async () => {
    // Two halves of the same guarantee. A writable torn down by a failed `end` emits its
    // `error` after the request has settled and its listeners are gone, so an absorber is
    // attached to keep that from being an uncaught exception. But `once` only detaches on
    // delivery, and a hand-written `WritableLike` need not emit at all - so on a writable
    // reused across requests the absorbers would pile up until Node warned about a leak.
    const emitter = new EventEmitter();
    const writable = emitter as unknown as WritableLike;
    writable.write = () => true;
    writable.end = () => {
      throw new Error('sync end boom');
    };
    writable.destroy = () => writable;

    const runOnce = async (): Promise<void> => {
      const req = new MockClientRequest();
      const res = new MockIncomingMessage(200, {
        'content-type': 'application/octet-stream',
        'content-length': '1',
      });
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

        expect(response.streamErrorCode).toBe('stream_write_error');
      } finally {
        requestSpy.mockRestore();
      }
    };

    await runOnce();

    // Attached while the event may still be on its way, so a late emit is absorbed
    // rather than thrown.
    expect(emitter.listenerCount('error')).toBe(1);
    expect(() => emitter.emit('error', new Error('late boom'))).not.toThrow();

    // Absorbed with `on`, not `once`, so one listener keeps covering the writable
    // instead of standing down after the first error and leaving a sibling's unhandled.
    expect(() => emitter.emit('error', new Error('later boom'))).not.toThrow();
    expect(emitter.listenerCount('error')).toBe(1);

    // Concurrent requests sharing one writable attach one absorber between them, not one
    // each: a dozen failures inside a single turn would otherwise trip Node's listener
    // warning before any removal ran.
    await Promise.all(Array.from({ length: 12 }, async () => runOnce()));
    expect(emitter.listenerCount('error')).toBe(1);

    // Released a turn after the error was delivered, not a turn after it was attached.
    // A `setImmediate` scheduled at attach time used to release it unconditionally, and
    // that lands *before* a real `fs.WriteStream` emits - it closes its fd asynchronously
    // first - so the error it was attached to absorb arrived to no listener at all and
    // killed the process. Counting from delivery instead keeps the siblings above covered
    // and still bounds the listener's life.
    //
    // *Unless* a later request renewed it in the meantime, which the twelve above did.
    // The deferred release is a guess that nothing further is expected, and a renewal is
    // the evidence that it was wrong: releasing anyway took the absorber off the very
    // requests that had just been told they were covered by it, and `cleanup` had removed
    // each of their own `onWritableError` - the uncaught `'error'` this exists to prevent,
    // reached from the other side. The renewed backstop below is what bounds it instead.
    await new Promise<void>((done) => {
      setImmediate(done);
    });

    expect(emitter.listenerCount('error')).toBe(1);

    // And it is a bound, not a reprieve: the window the renewals restarted runs out with
    // no further request asking, and the absorber comes off on its own.
    await new Promise<void>((done) => {
      // `PENDING_WRITABLE_ERROR_WINDOW_MS` plus room for the timer, spelled out because
      // the constant is module-private to the adapter.
      setTimeout(done, 1000 + 250);
    });

    expect(emitter.listenerCount('error')).toBe(0);
  });

  test('the pending-error listener is released when the writable closes without erroring', async () => {
    // The other bound. A writable handed a failed write that then never emits the error -
    // a hand-written `WritableLike` is not obliged to - would otherwise keep the absorber,
    // and with it the closure scope of the request it was declared in, for as long as the
    // writable itself lives.
    const emitter = new EventEmitter();
    const writable = emitter as unknown as WritableLike;

    writable.write = (
      _chunk: Uint8Array | string,
      cb?: (error?: Error | null) => void,
    ): boolean => {
      cb?.(new Error('write failed'));

      return true;
    };
    writable.end = (cb?: (error?: Error | null) => void): void => {
      cb?.();
    };
    writable.destroy = () => writable;

    const req = new MockClientRequest();
    const res = new MockIncomingMessage(200, {
      'content-type': 'application/octet-stream',
      'content-length': '1',
    });
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

      expect(response.streamErrorCode).toBe('stream_write_error');
    } finally {
      requestSpy.mockRestore();
    }

    // No error was ever emitted, so nothing has bounded it yet.
    expect(emitter.listenerCount('error')).toBe(1);

    emitter.emit('close');

    expect(emitter.listenerCount('error')).toBe(0);
  });

  test('a writable with no removal method gets one listener, not one per request', async () => {
    // `off`/`removeListener` are optional on `WritableLike`, and a listener attached to a
    // writable without either could never be removed: the request's own `'drain'` and
    // `'error'` piled up two per request plus the closure behind each, and an absorber
    // attached there could never be taken back either. Attaching none at all is not the
    // answer, because `'error'` is a channel `WritableLike` documents as sufficient on its
    // own - a sink that reports only that way would settle a truncated download as a
    // success. So one permanent listener per event fans out to whoever is listening now.
    const handlers: ((error: Error) => void)[] = [];
    const track = (event: string, listener: (error: Error) => void): void => {
      if (event === 'error') {
        handlers.push(listener);
      }
    };
    const writable = {
      write: () => true,
      end: () => {
        throw new Error('sync end boom');
      },
      on: (event: string, listener: (error: Error) => void) => {
        track(event, listener);

        return writable;
      },
      once: (event: string, listener: (error: Error) => void) => {
        track(event, listener);

        return writable;
      },
      destroy: () => writable,
    } as unknown as WritableLike;

    const runOnce = async (): Promise<void> => {
      const req = new MockClientRequest();
      const res = new MockIncomingMessage(200, {
        'content-type': 'application/octet-stream',
        'content-length': '1',
      });
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

        expect(response.streamErrorCode).toBe('stream_write_error');
      } finally {
        requestSpy.mockRestore();
      }
    };

    await runOnce();

    // One `'error'` listener: the permanent fan-out, and no absorber piled on top of it.
    expect(handlers.length).toBe(1);

    // It still absorbs the error the torn-down writable delivers late, and settles
    // nothing, because the request has already settled.
    expect(() => handlers[0]?.(new Error('late boom'))).not.toThrow();

    await new Promise<void>((done) => {
      setImmediate(done);
    });

    // And a second request through the same sink adds none: this is what a reused sink
    // used to pay two listeners and a retained request closure for, every time.
    await runOnce();

    expect(handlers.length).toBe(1);
  });

  test('a refused removal keeps the absorber tracked instead of stacking another', async () => {
    // The removal method is caller code and can refuse. When it does, the absorber is
    // still attached, so its bookkeeping is kept rather than dropped - dropping it would
    // let the next failure add a second listener on top of one that never came off.
    let errorListeners = 0;
    const writable = {
      write: () => true,
      end: () => {
        throw new Error('sync end boom');
      },
      on: (event: string) => {
        if (event === 'error') {
          errorListeners++;
        }

        return writable;
      },
      once: () => writable,
      off: () => {
        throw new Error('this writable refuses removals');
      },
      destroy: () => writable,
    } as unknown as WritableLike;

    const runOnce = async (): Promise<void> => {
      const req = new MockClientRequest();
      const res = new MockIncomingMessage(200, {
        'content-type': 'application/octet-stream',
        'content-length': '1',
      });
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

        expect(response.streamErrorCode).toBe('stream_write_error');
      } finally {
        requestSpy.mockRestore();
      }
    };

    await runOnce();

    // The request's own listener plus one absorber.
    expect(errorListeners).toBe(2);

    await new Promise<void>((done) => {
      setImmediate(done);
    });

    // Three more failures on the same writable. The refused removal left the absorber
    // attached and tracked, so each of these skips attaching a second one and only the
    // per-request listener is added.
    await runOnce();
    await runOnce();
    await runOnce();

    await new Promise<void>((done) => {
      setImmediate(done);
    });

    expect(errorListeners).toBe(5);
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

  test('a writable that fails after a successful stream does not kill the process', async () => {
    // `cleanup` removes this request's own `onWritableError` on *every* settle path, but
    // only the three `write`/`end` throw sites asked for the shared absorber - so the
    // ordinary success path left the writable with no `'error'` listener at all. A real
    // `fs.WriteStream` closes its descriptor asynchronously *after* `'finish'`, so
    // streaming a 200 to a file and then having `fs.close(fd)` fail with `EIO` or
    // `ENOSPC` emitted `'error'` into exactly that gap: an uncaught exception, from the
    // stream failure this adapter had already reported correctly.
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

      const result = await adapter.send({
        requestURL: 'http://example.test/data',
        method: 'GET',
        headers: {},
        streamResponse: () => writable,
      });

      expect(result.isStreamed).toBe(true);

      // The descriptor's asynchronous close fails, a turn after everything settled.
      expect(() =>
        writable.emit('error', new Error('ENOSPC on close')),
      ).not.toThrow();
    } finally {
      requestSpy.mockRestore();
    }
  });

  test('the absorber lets go of a writable that never closes', async () => {
    // The absorber is attached to the *caller's* writable, and a writable handed to
    // `streamResponse` may well outlive the request without ever emitting `'close'` -
    // `process.stdout`, a pooled sink, a long-lived socket. Unbounded, it would stay for
    // the life of the process: swallowing the caller's own later errors, and pinning the
    // request scope it closes over to the stream's lifetime.
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

      await adapter.send({
        requestURL: 'http://example.test/data',
        method: 'GET',
        headers: {},
        streamResponse: () => writable,
      });

      // This mock emits neither `'error'` nor `'close'`, so only the backstop can take the
      // absorber off.
      await new Promise((resolve) => setTimeout(resolve, 1_300));

      expect(writable.listenerCount('error')).toBe(0);
      expect(writable.listenerCount('close')).toBe(0);
    } finally {
      requestSpy.mockRestore();
    }
  }, 10_000);

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

        // At most one `'error'` listener, and the same one every time - not zero.
        //
        // `cleanup` now leaves the shared pending-error absorber attached on every settle
        // path, because it takes this request's own `onWritableError` off on all of them
        // and an `'error'` event with no listener ends the process. A real `fs.WriteStream`
        // closes its descriptor *after* `'finish'`, so a failing `fs.close(fd)` lands
        // exactly in that gap on the ordinary success path.
        //
        // What this test is named for is accumulation, and that is what is asserted: the
        // absorber is keyed on the writable through a `WeakMap`, so three requests over one
        // reused writable attach one listener between them rather than three. A real stream
        // emits `'close'` and it comes straight back off; this mock emits neither `'close'`
        // nor `'error'`, which is the one shape that holds it - inert, bounded, and never
        // more than one.
        expect(writable.listenerCount('error')).toBeLessThanOrEqual(1);

        // And the absorber is doing its job: an `'error'` with no listener at all is an
        // uncaught exception, which `EventEmitter` raises synchronously from `emit`.
        expect(() =>
          writable.emit('error', new Error('late close failed')),
        ).not.toThrow();
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
    // Every surface is checked rather than one, because runtimes disagree about where
    // the refusal is recorded. A single-stack connect gives an `Error` whose message
    // reads `connect ECONNREFUSED 127.0.0.1:1`. `localhost` is dual-stack, so both
    // `::1` and `127.0.0.1` are tried and the results are bundled into an
    // `AggregateError` whose own message is empty by spec, with `code` set and the
    // per-attempt errors in `errors`. Bun reported the flat form before 1.4.0 and the
    // aggregate one after, and either is correct - the test should not care which.
    interface ConnectFailure {
      code?: string;
      message?: string;
      errors?: ConnectFailure[];
    }

    const cause: ConnectFailure | undefined = builder.error?.cause;

    const surfaces = [
      cause?.code,
      cause?.message,
      ...(cause?.errors ?? []).flatMap((attempt) => [
        attempt.code,
        attempt.message,
      ]),
    ].filter((value): value is string => typeof value === 'string');

    expect(surfaces.some((value) => /ECONNREFUSED/i.test(value))).toBe(true);
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

  test('an early response with the body still uploading does not strand the socket', async () => {
    const net = await import('node:net');

    // A complete answer mid-upload, with the connection kept alive: a proxy replying
    // `413` before the body is finished is the ordinary shape of this. The write then
    // fails or parks, and the response path deliberately answers over it - but
    // `req.end()` only ever runs on the write path's success, so nothing finished the
    // request and the socket was held, unfinished and unusable, until the server's own
    // timeout.
    let didCloseSocket = false;
    let receivedBytes = 0;

    const server = net.createServer((socket) => {
      socket.on('close', () => {
        didCloseSocket = true;
      });

      socket.on('data', (chunk: Buffer) => {
        receivedBytes += chunk.length;
      });

      socket.once('data', () => {
        socket.write(
          'HTTP/1.1 413 Payload Too Large\r\nConnection: keep-alive\r\nContent-Length: 3\r\n\r\nno!',
        );
      });
    });

    await new Promise<void>((done) => {
      server.listen(0, '127.0.0.1', done);
    });

    const { port } = server.address() as { port: number };
    const bodySize = 8 * 1024 * 1024;

    try {
      const res = await new NodeAdapter().send({
        requestURL: `http://127.0.0.1:${port}/upload`,
        method: 'POST',
        headers: {},
        // Large enough that the upload is still running when the answer lands.
        body: 'x'.repeat(bodySize),
      });

      // The server's real answer, not a fabricated transport error over it.
      expect(res.status).toBe(413);

      // Past the stall grace, so an upload that parked has been torn down by now. See
      // `UPLOAD_STALL_GRACE_MS`.
      await new Promise((resolve) => setTimeout(resolve, 6_000));

      // Either exit leaves the socket usable: the upload finished and the request was
      // ended, or it made no further progress and was destroyed. What the request must
      // never be is left open with a body it is no longer writing - which is what a
      // server still reading here would see as neither.
      expect(didCloseSocket || receivedBytes >= bodySize).toBe(true);
    } finally {
      server.close();
    }
  }, 20000);

  test('an early response with a stalled upload tears the request down', async () => {
    const net = await import('node:net');

    // The server answers and then stops reading, so the write parks under backpressure
    // that will never drain. Nothing fails, so no `catch` runs; without the stall watchdog
    // the request sits unfinished on a keep-alive socket until the server times it out.
    // See `UPLOAD_STALL_GRACE_MS`.
    //
    // Observed through `requestBodySettled` rather than through the server's own `'close'`,
    // and with a reader that never resumes. Watching the server side needed the socket
    // reading again to see the client's reset, and resuming it to look put the upload back
    // in motion: the watchdog re-arms for as long as progress is being made, so a resume
    // inside any of its windows let the 8 MB finish, left nothing to tear down, and failed
    // an assertion about a teardown that correctly never happened. Measured: the upload
    // parks at ~1.7 MB, dribbles a few KB as the kernel probes the closed window, and the
    // first window that sees none of it destroys the request - here at ~15 s, which is why
    // the timeout below is generous. The writer's own outcome says the same thing the
    // socket close did, from the side that is not racing.
    const server = net.createServer((socket) => {
      socket.on('error', () => {
        // The client's teardown reaches this side as a reset.
      });

      socket.once('data', () => {
        socket.write(
          'HTTP/1.1 413 Payload Too Large\r\nConnection: keep-alive\r\nContent-Length: 3\r\n\r\nno!',
        );

        // Read nothing more, ever. The buffers fill and the client's writes stop being
        // accepted, which is the shape a proxy that has given up presents.
        socket.pause();
      });
    });

    await new Promise<void>((done) => {
      server.listen(0, '127.0.0.1', done);
    });

    const { port } = server.address() as { port: number };

    try {
      const res = await new NodeAdapter().send({
        requestURL: `http://127.0.0.1:${port}/upload`,
        method: 'POST',
        headers: {},
        // Past what the socket buffers absorb, so the write genuinely parks.
        body: 'x'.repeat(8 * 1024 * 1024),
      });

      expect(res.status).toBe(413);

      // The upload outlived the answer, so the writer's outcome is the teardown's receipt:
      // an upload left alone would resolve `undefined` once it finished.
      const uploadOutcome = await res.requestBodySettled;

      expect(uploadOutcome).toBeInstanceOf(Error);
    } finally {
      server.close();
    }
  }, 40000);

  test('an early response does not truncate an upload the server is still reading', async () => {
    const net = await import('node:net');

    // The other half of the early-response case, and the one the stall watchdog must not
    // break: with request buffering disabled the answer can arrive while the upload is
    // still going and the server goes on consuming it. Progress is reported only once per
    // accepted chunk, so a receiver that is merely busy for a moment reports nothing at
    // all - and a watchdog impatient with that cuts a body short of the `Content-Length`
    // already on the wire while handing the caller the early status as a clean success.
    let receivedBytes = 0;

    const server = net.createServer((socket) => {
      socket.on('error', () => {
        // Only the assertion below decides the outcome.
      });

      socket.on('data', (chunk: Buffer) => {
        receivedBytes += chunk.length;
      });

      socket.once('data', () => {
        socket.write(
          'HTTP/1.1 200 OK\r\nConnection: keep-alive\r\nContent-Length: 2\r\n\r\nok',
        );

        // Busy for a while, then back to reading - a pause, not a hang up.
        socket.pause();

        setTimeout(() => {
          socket.resume();
        }, 2_000);
      });
    });

    await new Promise<void>((done) => {
      server.listen(0, '127.0.0.1', done);
    });

    const { port } = server.address() as { port: number };
    const bodySize = 8 * 1024 * 1024;

    try {
      const res = await new NodeAdapter().send({
        requestURL: `http://127.0.0.1:${port}/upload`,
        method: 'POST',
        headers: {},
        body: 'x'.repeat(bodySize),
      });

      expect(res.status).toBe(200);

      await new Promise((resolve) => setTimeout(resolve, 4_000));

      // Every byte the caller handed over, not the prefix that fitted before the pause.
      expect(receivedBytes).toBeGreaterThanOrEqual(bodySize);
    } finally {
      server.close();
    }
  }, 20000);

  test('an upload cut short after the response settles `requestBodySettled`', async () => {
    const net = await import('node:net');

    // The failure this field exists for. The server answers in full and stops reading, so
    // the response is complete - and delivered - while the upload is still parked behind
    // it; the stall watchdog then tears that upload down seconds later. Nothing about the
    // response can change by then, so the outcome of the body is carried as a promise the
    // caller may await rather than as a field that would always be empty.
    const server = net.createServer((socket) => {
      socket.on('error', () => {
        // The client's teardown reaches this side as a reset; nothing here asserts on it.
      });

      socket.once('data', () => {
        socket.write(
          'HTTP/1.1 200 OK\r\nConnection: keep-alive\r\nContent-Length: 2\r\n\r\nok',
        );

        // Read nothing further, ever: the upload parks and never moves again.
        socket.pause();
      });
    });

    await new Promise<void>((done) => {
      server.listen(0, '127.0.0.1', done);
    });

    const { port } = server.address() as { port: number };

    try {
      const res = await new NodeAdapter().send({
        requestURL: `http://127.0.0.1:${port}/upload`,
        method: 'POST',
        headers: {},
        // Past what the socket buffers absorb, so the write genuinely parks.
        body: 'x'.repeat(8 * 1024 * 1024),
      });

      // The server's real answer, delivered without waiting for the upload.
      expect(res.status).toBe(200);
      expect(res.isTransportError).toBeUndefined();
      expect(res.requestBodySettled).toBeDefined();

      // Resolves rather than rejecting, so a caller that ignores it is never handed an
      // unhandled rejection.
      const failure = await res.requestBodySettled;

      expect(failure).toBeInstanceOf(Error);
    } finally {
      server.close();
    }
  }, 20000);

  test('a cancel mid-upload carries the upload outcome on the throw', async () => {
    const net = await import('node:net');

    // The other half of the same contract. Every path that *resolves* carries
    // `requestBodySettled` on the response; a path that *throws* has no response to carry
    // it, and the promise lives in this adapter's closure - so it is tagged onto the error
    // instead. Without it `HTTPClient` built its cancelled response without the field, and
    // `await undefined` reported a clean upload for a body torn down mid-flight.
    const server = net.createServer((socket) => {
      socket.on('error', () => {
        // The teardown reaches this side as a reset; nothing here asserts on it.
      });

      // Never read: the upload parks with the request still open.
      socket.pause();
    });

    await new Promise<void>((done) => {
      server.listen(0, '127.0.0.1', done);
    });

    const { port } = server.address() as { port: number };
    const controller = new AbortController();

    try {
      const pending = new NodeAdapter().send({
        requestURL: `http://127.0.0.1:${port}/upload`,
        method: 'POST',
        headers: {},
        // Past what the socket buffers absorb, so the write is genuinely still running.
        body: 'x'.repeat(8 * 1024 * 1024),
        signal: controller.signal,
      });

      // Long enough for the writer to start and park.
      await new Promise((done) => setTimeout(done, 50));
      controller.abort();

      const thrown: unknown = await pending.then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).name).toBe('AbortError');

      const settled = (thrown as Record<PropertyKey, unknown>)[
        REQUEST_BODY_SETTLED_KEY
      ];

      expect(settled).toBeInstanceOf(Promise);

      // Resolves rather than rejecting, exactly as it does on the paths that resolve, so
      // an error nobody inspects cannot become an unhandled rejection.
      const failure = await (settled as Promise<Error | undefined>);

      expect(failure).toBeInstanceOf(Error);
    } finally {
      server.close();
    }
  }, 20000);

  test('a bodied request aborted before any write still carries the upload outcome', async () => {
    // The window the mid-upload fix left open. The outcome promise used to be created by
    // the first write, and the write branches are the last thing the adapter does - so a
    // signal that was already aborted threw from above them with nothing to tag, the field
    // was omitted, and `await` answered `undefined`: the documented value for a body that
    // went out in full, for one that never started. Opened with the request instead.
    const controller = new AbortController();

    controller.abort();

    // Never connected to: the abort is answered before the socket matters.
    const pending = new NodeAdapter().send({
      requestURL: 'http://127.0.0.1:1/upload',
      method: 'POST',
      headers: {},
      body: 'hello',
      signal: controller.signal,
    });

    const thrown: unknown = await pending.then(
      () => undefined,
      (error: unknown) => error,
    );

    expect((thrown as Error).name).toBe('AbortError');

    const settled = (thrown as Record<PropertyKey, unknown>)[
      REQUEST_BODY_SETTLED_KEY
    ];

    expect(settled).toBeInstanceOf(Promise);

    // The throw itself, not `undefined`. Nothing went out, and the promise settles rather
    // than hanging on a writer that is never going to run.
    expect(await (settled as Promise<Error | undefined>)).toBeInstanceOf(Error);

    // Not enumerable: a runtime printing this error prints its own enumerable properties,
    // and so do `describeError` and `serializeError`.
    expect(Object.keys(thrown as object)).not.toContain(
      REQUEST_BODY_SETTLED_KEY,
    );
  });

  test('a bodiless request aborted before any write carries no upload outcome', async () => {
    // Absence still means something: there is no upload to report on, so nothing is
    // claimed either way.
    const controller = new AbortController();

    controller.abort();

    const thrown: unknown = await new NodeAdapter()
      .send({
        requestURL: 'http://127.0.0.1:1/nothing',
        method: 'GET',
        headers: {},
        signal: controller.signal,
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect((thrown as Error).name).toBe('AbortError');
    expect(
      (thrown as Record<PropertyKey, unknown>)[REQUEST_BODY_SETTLED_KEY],
    ).toBeUndefined();
  });

  test('a body that goes out in full settles `requestBodySettled` with no error', async () => {
    const net = await import('node:net');

    const server = net.createServer((socket) => {
      socket.on('error', () => {
        // Only the assertions below decide the outcome.
      });

      socket.resume();

      socket.once('data', () => {
        socket.write(
          'HTTP/1.1 200 OK\r\nConnection: keep-alive\r\nContent-Length: 2\r\n\r\nok',
        );
      });
    });

    await new Promise<void>((done) => {
      server.listen(0, '127.0.0.1', done);
    });

    const { port } = server.address() as { port: number };

    try {
      const res = await new NodeAdapter().send({
        requestURL: `http://127.0.0.1:${port}/upload`,
        method: 'POST',
        headers: {},
        body: 'x'.repeat(64 * 1024),
      });

      expect(res.status).toBe(200);
      expect(await res.requestBodySettled).toBeUndefined();
    } finally {
      server.close();
    }
  }, 20000);

  test('a response that fails mid-stream still carries `requestBodySettled`', async () => {
    const net = await import('node:net');

    // The shape the field exists for, and the one it was missing from: an early-ack `200`
    // whose *response* body then fails while the upload is still parked behind it. The
    // response resolves through `isStreamError`, and attaching the promise only to the two
    // success paths meant `await response.requestBodySettled` gave `undefined` here - which
    // is exactly what a clean upload looks like, for a body that never went out.
    const server = net.createServer((socket) => {
      socket.on('error', () => {
        // The teardown below reaches this side as a reset; nothing here asserts on it.
      });

      socket.once('data', () => {
        // A length the body never reaches, so cutting the connection is a premature close
        // rather than a complete response.
        socket.write(
          'HTTP/1.1 200 OK\r\nConnection: keep-alive\r\nContent-Length: 1000\r\n\r\nok',
        );

        // Read nothing further: the upload parks behind the answer.
        socket.pause();

        setTimeout(() => {
          socket.destroy();
        }, 100);
      });
    });

    await new Promise<void>((done) => {
      server.listen(0, '127.0.0.1', done);
    });

    const { port } = server.address() as { port: number };

    try {
      const res = await new NodeAdapter().send({
        requestURL: `http://127.0.0.1:${port}/upload`,
        method: 'POST',
        headers: {},
        // Past what the socket buffers absorb, so the write genuinely parks.
        body: 'x'.repeat(8 * 1024 * 1024),
      });

      // The server's real status survives the stream failure, as it always has.
      expect(res.status).toBe(200);
      expect(res.isStreamError).toBe(true);

      // And the upload outcome travels with it.
      expect(res.requestBodySettled).toBeDefined();
      expect(await res.requestBodySettled).toBeInstanceOf(Error);
    } finally {
      server.close();
    }
  }, 20000);

  test('a transport failure before any headers still carries `requestBodySettled`', async () => {
    const net = await import('node:net');

    // The other half of the same gap: no response at all, the connection reset under an
    // upload that was still running. The adapter answers `{ status: 0, isTransportError }`,
    // and that response is bodied too - so it says what became of the body rather than
    // leaving the caller to read `undefined` as success.
    const server = net.createServer((socket) => {
      socket.on('error', () => {
        // A reset on this side is the point of the test.
      });

      socket.once('data', () => {
        socket.destroy();
      });
    });

    await new Promise<void>((done) => {
      server.listen(0, '127.0.0.1', done);
    });

    const { port } = server.address() as { port: number };

    try {
      const res = await new NodeAdapter().send({
        requestURL: `http://127.0.0.1:${port}/upload`,
        method: 'POST',
        headers: {},
        body: 'x'.repeat(8 * 1024 * 1024),
      });

      expect(res.status).toBe(0);
      expect(res.isTransportError).toBe(true);
      expect(res.requestBodySettled).toBeDefined();
      expect(await res.requestBodySettled).toBeInstanceOf(Error);
    } finally {
      server.close();
    }
  }, 20000);

  test('a 413 that stops reading keeps its status and its body', async () => {
    const net = await import('node:net');

    // What carrying the body failure on the response itself would have broken: the client
    // reads any `isTransportError` as a network failure and drops the body with it, so the
    // server's own explanation of the `413` would never reach the caller. The upload here
    // is torn down by the stall watchdog exactly as above; none of that may touch this
    // response.
    const server = net.createServer((socket) => {
      socket.on('error', () => {
        // The client's teardown reaches this side as a reset.
      });

      socket.once('data', () => {
        socket.write(
          'HTTP/1.1 413 Payload Too Large\r\nConnection: keep-alive\r\nContent-Length: 15\r\n\r\n{"error":"big"}',
        );

        socket.pause();
      });
    });

    await new Promise<void>((done) => {
      server.listen(0, '127.0.0.1', done);
    });

    const { port } = server.address() as { port: number };

    try {
      const res = await new NodeAdapter().send({
        requestURL: `http://127.0.0.1:${port}/upload`,
        method: 'POST',
        headers: {},
        body: 'x'.repeat(8 * 1024 * 1024),
      });

      expect(res.status).toBe(413);
      expect(res.isTransportError).toBeUndefined();
      expect(res.isStreamError).toBeUndefined();
      expect(res.errorCause).toBeUndefined();
      expect(new TextDecoder().decode(res.body ?? new Uint8Array())).toBe(
        '{"error":"big"}',
      );
    } finally {
      server.close();
    }
  }, 20000);

  test('an upload reset before the response body is in keeps the real status', async () => {
    const net = await import('node:net');

    // The write-path `catch` handlers stand down on `didReceiveResponse` and leave the real
    // status to the response path; `req.on('error')` did not, and an upload-side
    // `ECONNRESET` fires both. `resolve` is first-call-wins, so whenever that error landed
    // before the response body was fully in, the server's answer was replaced by a
    // fabricated `{ status: 0, isTransportError: true }` - the same overlay the
    // early-response handling exists to prevent, reached from the other entry point. The
    // response here is deliberately left short of its `Content-Length` so the reset wins
    // the race every run.
    const server = net.createServer((socket) => {
      socket.on('error', () => {
        // The reset below reaches this side too.
      });

      socket.once('data', () => {
        socket.write(
          'HTTP/1.1 413 Payload Too Large\r\nConnection: keep-alive\r\nContent-Length: 15\r\n\r\n{"err',
        );

        setTimeout(() => {
          socket.destroy();
        }, 50);
      });
    });

    await new Promise<void>((done) => {
      server.listen(0, '127.0.0.1', done);
    });

    const { port } = server.address() as { port: number };

    try {
      const res = await new NodeAdapter().send({
        requestURL: `http://127.0.0.1:${port}/upload`,
        method: 'POST',
        headers: {},
        // Large enough that the upload is still running when the reset arrives.
        body: 'x'.repeat(32 * 1024 * 1024),
      });

      // The server's answer, and a truncated response reported as exactly that - not as a
      // connection that never produced one.
      expect(res.status).toBe(413);
      expect(res.isTransportError).toBeUndefined();
      expect(res.isStreamError).toBe(true);
    } finally {
      server.close();
    }
  }, 20000);

  test('an abort while the upload is still running keeps a response already received', async () => {
    const net = await import('node:net');

    // The other thing waiting for the writer broke. The answer is complete at once and the
    // upload runs on behind it, so a signal that fires in that window must not turn a
    // response the caller already has into an `AbortError`.
    const server = net.createServer((socket) => {
      socket.on('error', () => {
        // Only the assertions below decide the outcome.
      });

      socket.once('data', () => {
        socket.write(
          'HTTP/1.1 200 OK\r\nConnection: keep-alive\r\nContent-Length: 2\r\n\r\nok',
        );

        socket.pause();
      });
    });

    await new Promise<void>((done) => {
      server.listen(0, '127.0.0.1', done);
    });

    const { port } = server.address() as { port: number };
    const controller = new AbortController();

    setTimeout(() => {
      controller.abort();
    }, 200);

    try {
      const res = await new NodeAdapter().send({
        requestURL: `http://127.0.0.1:${port}/upload`,
        method: 'POST',
        headers: {},
        body: 'x'.repeat(8 * 1024 * 1024),
        signal: controller.signal,
      });

      expect(res.status).toBe(200);
      expect(new TextDecoder().decode(res.body ?? new Uint8Array())).toBe('ok');
    } finally {
      server.close();
    }
  }, 20000);

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
      // A body-byte counter would have called this safe to replay. Absent
      // rather than `false`: nothing here proves delivery either way.
      expect(res.wasDefinitelyNotSent).toBeUndefined();
      expect('wasDefinitelyNotSent' in res).toBe(false);

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

describe('NodeAdapter via HTTPClient — early 307 with a cookie jar', () => {
  test('waits for the upload to settle, then carries the hop-1 cookie onto hop 2', async () => {
    // The combination the pieces were each tested for: a real server answers a large
    // `POST` with `307` before reading the body, the client waits on the hop's
    // `requestBodySettled` before dispatching hop 2, and the `Set-Cookie` from hop 1
    // rides onto hop 2 through the jar. Ordering is asserted on the client: hop 1's
    // outcome settles before attempt 2 starts, observed without holding the client -
    // the observer registers a `.then`, it does not `await`, since an awaited observer
    // would hold hop 2 itself and pass with the client's wait deleted. The server's
    // clock is not compared: the writer finishes when the last bytes reach the kernel,
    // and the in-process server reads them a few milliseconds after that, so "hop 2
    // started after the server had the body" is not a promise the client makes.
    //
    // A raw socket rather than `node:http`: the server must answer while the request
    // body is still arriving, and still count every byte of it afterwards, which an
    // `IncomingMessage` that has already been answered does not promise on every runtime.
    const net = await import('node:net');
    const bodySize = 8 * 1024 * 1024;
    let uploadBytes = 0;
    let uploadEndedAt: number | undefined;
    let secondCookieHeader: string | undefined;
    const openSockets = new Set<Socket>();

    const server = net.createServer((socket) => {
      openSockets.add(socket);
      socket.on('close', () => openSockets.delete(socket));

      let buffered = Buffer.alloc(0);
      let headerLength = -1;
      let contentLength = 0;
      let bodyBytes = 0;
      let isUpload = false;

      socket.on('data', (chunk: Buffer) => {
        if (headerLength === -1) {
          buffered = Buffer.concat([buffered, chunk]);
          const headerEnd = buffered.indexOf('\r\n\r\n');

          if (headerEnd === -1) {
            return;
          }

          headerLength = headerEnd + 4;
          const head = buffered.subarray(0, headerEnd).toString('latin1');
          const [requestLine = '', ...headerLines] = head.split('\r\n');
          const headers = new Map(
            headerLines.map((line) => {
              const separator = line.indexOf(':');

              return [
                line.slice(0, separator).trim().toLowerCase(),
                line.slice(separator + 1).trim(),
              ];
            }),
          );

          isUpload = requestLine.startsWith('POST /upload ');
          contentLength = Number(headers.get('content-length') ?? '0');

          // Both hops are answered at the headers, both keep-alive, and neither socket
          // is ended from here. A `307` resends the `POST`, so hop 2 is an upload too,
          // and it is hop 2's outcome the final response reports. On `Connection:
          // close` Node's client finalizes the socket's writable side as soon as the
          // response is consumed, and the writer reports the body cut short; ending
          // the socket the instant the last byte lands races the writer's own finish
          // the same way. The client closes them once its writer is finished.
          if (isUpload) {
            socket.write(
              'HTTP/1.1 307 Temporary Redirect\r\nLocation: /second\r\nSet-Cookie: hop=1; Path=/\r\nConnection: keep-alive\r\nContent-Length: 0\r\n\r\n',
            );
          } else {
            secondCookieHeader = headers.get('cookie');
            socket.write(
              'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nConnection: keep-alive\r\nContent-Length: 2\r\n\r\nok',
            );
          }

          chunk = buffered.subarray(headerLength);
        }

        bodyBytes += chunk.length;

        if (isUpload) {
          uploadBytes = bodyBytes;

          if (bodyBytes >= contentLength) {
            uploadEndedAt = Date.now();
          }
        }
      });

      socket.on('error', () => {
        // The client may tear the socket down after the response; not this test's concern.
      });
    });

    await new Promise<void>((done) => {
      server.listen(0, '127.0.0.1', done);
    });

    const { port } = server.address() as { port: number };
    const jar = new CookieJar();
    const client = makeClient({}, `http://127.0.0.1:${port}`, {
      cookieJar: jar,
      followRedirects: true,
    });
    const order: string[] = [];

    client.addResponseObserver(
      (res) => {
        if (res.status === 307 && res.requestBodySettled !== undefined) {
          order.push('hop-1-seen');
          void res.requestBodySettled.then(() => {
            order.push('hop-1-settled');
          });
        }
      },
      { phases: ['redirect'] },
    );

    try {
      const res = await client
        .post('/upload')
        .onAttemptStart((event) => {
          if (event.attemptNumber === 2) {
            order.push('attempt-2-start');
          }
        })
        .body('x'.repeat(bodySize))
        .send();

      expect(res.status).toBe(200);
      expect(res.wasRedirectFollowed).toBe(true);
      expect(await res.requestBodySettled).toBeUndefined();

      expect(secondCookieHeader).toBe('hop=1');
      expect(jar.getCookieFor('hop', `http://127.0.0.1:${port}/`)?.value).toBe(
        '1',
      );

      expect(order).toEqual(['hop-1-seen', 'hop-1-settled', 'attempt-2-start']);

      // And the server did receive the whole body: the settle was a real finish, not a
      // teardown.
      expect(uploadBytes).toBe(bodySize);
      expect(uploadEndedAt).toBeDefined();
    } finally {
      for (const socket of openSockets) {
        socket.destroy();
      }

      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  }, 20000);
});

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

// ---------------------------------------------------------------------------
// TLS identity on a redirect hop
// ---------------------------------------------------------------------------

interface IdentityCerts {
  caCert: string;
  /** Server leaf with DNS:localhost and IP:127.0.0.1 SANs. */
  server: { cert: string; key: string };
  /** Server leaf with only a DNS:localhost SAN, so dialing by IP needs `servername`. */
  serverDnsOnly: { cert: string; key: string };
  /** Client leaf issued by the same CA, so a server trusting `caCert` authorizes it. */
  client: { cert: string; key: string };
}

let cachedIdentityCerts: IdentityCerts | null = null;

/**
 * The shared helper issues server leaves only. These tests need a *client* leaf from a CA
 * the servers trust, so the servers can say whether the adapter presented it; generated
 * once per process with the same openssl flow the helper uses.
 */
function getIdentityCerts(): IdentityCerts {
  if (cachedIdentityCerts) {
    return cachedIdentityCerts;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tls-identity-'));

  try {
    const p = (name: string) => path.join(dir, name);
    const run = (cmd: string) => execSync(cmd, { stdio: 'pipe' });
    const read = (name: string) => fs.readFileSync(p(name), 'utf8');

    fs.writeFileSync(
      p('san-full.cnf'),
      '[SAN]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n',
    );
    fs.writeFileSync(p('san-dns.cnf'), '[SAN]\nsubjectAltName=DNS:localhost\n');

    run(
      `openssl ecparam -genkey -name prime256v1 -noout -out "${p('ca.key')}"`,
    );
    run(
      `openssl req -new -x509 -days 1 -key "${p('ca.key')}" -out "${p('ca.crt')}" -subj "/CN=Identity Test CA"`,
    );

    const issue = (name: string, subject: string, sanFile?: string) => {
      run(
        `openssl ecparam -genkey -name prime256v1 -noout -out "${p(`${name}.key`)}"`,
      );
      run(
        `openssl req -new -key "${p(`${name}.key`)}" -out "${p(`${name}.csr`)}" -subj "/CN=${subject}"`,
      );
      run(
        `openssl x509 -req -days 1 -in "${p(`${name}.csr`)}" -CA "${p('ca.crt')}" -CAkey "${p('ca.key')}" -CAcreateserial -out "${p(`${name}.crt`)}"${sanFile ? ` -extensions SAN -extfile "${p(sanFile)}"` : ''}`,
      );

      return { cert: read(`${name}.crt`), key: read(`${name}.key`) };
    };

    cachedIdentityCerts = {
      caCert: read('ca.crt'),
      server: issue('server', 'localhost', 'san-full.cnf'),
      serverDnsOnly: issue('server-dns', 'localhost', 'san-dns.cnf'),
      client: issue('client', 'identity-test-client'),
    };

    return cachedIdentityCerts;
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
}

/** What one TLS server observed on each request it answered. */
interface ObservedTLSRequest {
  path: string;
  /** Whether a client certificate chaining to the server's `ca` was presented. */
  authorized: boolean;
  /** The SNI name the client sent, if any. */
  servername: string | undefined;
}

interface IdentityTestServer {
  url: string;
  observed: ObservedTLSRequest[];
  stop: () => Promise<void>;
}

/**
 * An HTTPS server that asks for a client certificate without requiring one, records what
 * each request presented, and answers with whatever `respond` decides.
 */
function startIdentityServer(
  leaf: { cert: string; key: string },
  respond: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    self: () => IdentityTestServer,
  ) => void,
): Promise<IdentityTestServer> {
  const { caCert } = getIdentityCerts();
  const observed: ObservedTLSRequest[] = [];

  return new Promise((resolve, reject) => {
    let self: IdentityTestServer;

    const server = https.createServer(
      {
        cert: leaf.cert,
        key: leaf.key,
        ca: caCert,
        requestCert: true,
        rejectUnauthorized: false,
      },
      (req, res) => {
        const socket = req.socket as Socket & {
          authorized?: boolean;
          servername?: string;
        };

        observed.push({
          path: req.url ?? '',
          authorized: socket.authorized === true,
          servername:
            typeof socket.servername === 'string'
              ? socket.servername
              : undefined,
        });

        respond(req, res, () => self);
      },
    );

    server.on('error', reject);

    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };

      self = {
        url: `https://127.0.0.1:${port}`,
        observed,
        stop: () =>
          new Promise<void>((done, fail) => {
            server.close((error) => (error ? fail(error) : done()));
          }),
      };

      resolve(self);
    });
  });
}

describe('NodeAdapter — TLS identity is not presented on a cross-origin redirect hop', () => {
  let certs: IdentityCerts;
  // `target` answers 200 to anything. `origin` redirects `/hop` to `target` (a different
  // port, so a different origin), `/same` to its own `/landed`, and answers 200 elsewhere.
  let target: IdentityTestServer;
  let origin: IdentityTestServer;

  beforeAll(async () => {
    certs = getIdentityCerts();

    target = await startIdentityServer(certs.server, (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ landed: 'target' }));
    });

    origin = await startIdentityServer(certs.server, (req, res, self) => {
      if (req.url === '/hop') {
        res.writeHead(302, { location: `${target.url}/landed` });
        res.end();

        return;
      }

      if (req.url === '/same') {
        res.writeHead(302, { location: `${self().url}/landed` });
        res.end();

        return;
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ landed: 'origin' }));
    });
  });

  afterAll(async () => {
    await origin.stop();
    await target.stop();
  });

  test('the client certificate reaches the origin the caller addressed but not the hop', async () => {
    const client = new HTTPClient({
      adapter: new NodeAdapter({
        mtls: {
          cert: certs.client.cert,
          key: certs.client.key,
          ca: certs.caCert,
        },
      }),
      baseURL: origin.url,
      followRedirects: true,
    });

    const res = await client.get('/hop').send<{ landed: string }>();

    // The hop itself went through: `target` presents a leaf from the same private CA, and
    // that CA is configured only through `mtls.ca`, so the trust anchor still applied to
    // the hop even though the identity did not.
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ landed: 'target' });
    expect(res.redirectHistory).toEqual([`${target.url}/landed`]);

    const first = origin.observed.find((entry) => entry.path === '/hop');
    const second = target.observed.find((entry) => entry.path === '/landed');

    expect(first?.authorized).toBe(true);
    expect(second?.authorized).toBe(false);
  });

  test('a same-origin redirect keeps presenting the client certificate', async () => {
    const client = new HTTPClient({
      adapter: new NodeAdapter({
        mtls: {
          cert: certs.client.cert,
          key: certs.client.key,
          ca: certs.caCert,
        },
      }),
      baseURL: origin.url,
      followRedirects: true,
    });

    const res = await client.get('/same').send<{ landed: string }>();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ landed: 'origin' });

    const landed = origin.observed.filter((entry) => entry.path === '/landed');

    expect(landed).toHaveLength(1);
    expect(landed[0].authorized).toBe(true);
  });

  test('driven directly, initialURL decides: absent or same-origin presents it, cross-origin withholds it', async () => {
    const adapter = new NodeAdapter({
      mtls: {
        cert: certs.client.cert,
        key: certs.client.key,
        ca: certs.caCert,
      },
    });

    const countBefore = target.observed.length;

    const direct = await adapter.send(
      makeAdapterRequest(`${target.url}/direct`),
    );
    const sameOrigin = await adapter.send(
      makeAdapterRequest(`${target.url}/same-origin`, {
        initialURL: `${target.url}/somewhere-else`,
      }),
    );
    const crossOrigin = await adapter.send(
      makeAdapterRequest(`${target.url}/cross-origin`, {
        initialURL: `${origin.url}/start`,
      }),
    );

    expect(direct.status).toBe(200);
    expect(sameOrigin.status).toBe(200);
    expect(crossOrigin.status).toBe(200);

    const seen = target.observed.slice(countBefore);

    expect(seen.map((entry) => [entry.path, entry.authorized])).toEqual([
      ['/direct', true],
      ['/same-origin', true],
      ['/cross-origin', false],
    ]);
  });

  test('an unparseable initialURL fails closed and withholds the identity', async () => {
    const adapter = new NodeAdapter({
      mtls: {
        cert: certs.client.cert,
        key: certs.client.key,
        ca: certs.caCert,
      },
    });

    const countBefore = target.observed.length;

    const res = await adapter.send(
      makeAdapterRequest(`${target.url}/unparseable`, {
        initialURL: 'not a url',
      }),
    );

    expect(res.status).toBe(200);
    expect(target.observed.slice(countBefore)).toEqual([
      { path: '/unparseable', authorized: false, servername: undefined },
    ]);
  });
});

describe('NodeAdapter — servername is not sent on a cross-origin redirect hop', () => {
  // Both servers present a DNS-only leaf and are dialed by IP, so a connection only
  // verifies when `servername: 'localhost'` is sent. The hop must therefore fail: the
  // configured name belongs to the origin the caller addressed, not to wherever a
  // `Location` header points.
  let certs: IdentityCerts;
  let target: IdentityTestServer;
  let origin: IdentityTestServer;

  beforeAll(async () => {
    certs = getIdentityCerts();

    target = await startIdentityServer(certs.serverDnsOnly, (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ landed: 'target' }));
    });

    origin = await startIdentityServer(certs.serverDnsOnly, (_req, res) => {
      res.writeHead(302, { location: `${target.url}/landed` });
      res.end();
    });
  });

  afterAll(async () => {
    await origin.stop();
    await target.stop();
  });

  test('the hop is verified against its own host, not the configured servername', async () => {
    const client = new HTTPClient({
      adapter: new NodeAdapter({ ca: certs.caCert, servername: 'localhost' }),
      baseURL: origin.url,
      followRedirects: true,
    });

    const targetCountBefore = target.observed.length;
    const res = await client.get('/hop').send();

    // The first hop verified through the configured name...
    const first = origin.observed.find((entry) => entry.path === '/hop');

    expect(first?.servername).toBe('localhost');

    // ...and the cross-origin hop did not get it: dialed by IP against a DNS-only leaf
    // with no SNI override, the handshake fails on the altname check, and the target
    // never sees a request.
    expect(res.isFailed).toBe(true);
    expect(res.isNetworkError).toBe(true);
    expect(res.redirectHistory).toEqual([`${target.url}/landed`]);
    expect(target.observed.length).toBe(targetCountBefore);
  });

  test('driven directly, the same target verifies with servername unless initialURL is cross-origin', async () => {
    const adapter = new NodeAdapter({
      ca: certs.caCert,
      servername: 'localhost',
    });

    const countBefore = target.observed.length;

    const direct = await adapter.send(
      makeAdapterRequest(`${target.url}/direct`),
    );
    const sameOrigin = await adapter.send(
      makeAdapterRequest(`${target.url}/same-origin`, {
        initialURL: `${target.url}/start`,
      }),
    );
    const crossOrigin = await adapter.send(
      makeAdapterRequest(`${target.url}/cross-origin`, {
        initialURL: `${origin.url}/start`,
      }),
    );

    expect(direct.status).toBe(200);
    expect(sameOrigin.status).toBe(200);

    // A TLS verification failure resolves as 495, the adapter's certificate-error status.
    expect(crossOrigin.status).toBe(495);
    expect(crossOrigin.isTransportError).toBe(true);

    expect(
      target.observed
        .slice(countBefore)
        .map((entry) => [entry.path, entry.servername]),
    ).toEqual([
      ['/direct', 'localhost'],
      ['/same-origin', 'localhost'],
    ]);
  });
});

// ---------------------------------------------------------------------------
// Abort listeners come off the signal once the request has settled
// ---------------------------------------------------------------------------

describe('NodeAdapter — abort listeners are released when the request settles', () => {
  let server: TestServer;

  beforeAll(() => {
    server = startTestServer();
  });

  afterAll(async () => {
    await server.stop();
  });

  /**
   * Counts the `'abort'` listeners the adapter adds to and removes from a signal.
   * Net zero means every listener the request attached came off again.
   */
  function watchSignal() {
    const controller = new AbortController();
    const added = spyOn(controller.signal, 'addEventListener');
    const removed = spyOn(controller.signal, 'removeEventListener');

    return {
      controller,
      signal: controller.signal,
      counts: () => ({
        added: added.mock.calls.filter(([type]) => type === 'abort').length,
        removed: removed.mock.calls.filter(([type]) => type === 'abort').length,
      }),
    };
  }

  test('a bodiless GET leaves no listener behind', async () => {
    const watched = watchSignal();

    const res = await new NodeAdapter().send(
      makeAdapterRequest(`${server.url}/api/test`, { signal: watched.signal }),
    );

    expect(res.status).toBe(200);
    expect(res.requestBodySettled).toBeUndefined();

    const counts = watched.counts();

    expect(counts.added).toBe(1);
    expect(counts.removed).toBe(counts.added);
  });

  test('a bodied POST leaves no listener behind once the upload has settled too', async () => {
    const watched = watchSignal();

    const res = await new NodeAdapter().send(
      makeAdapterRequest(`${server.url}/api/raw-upload-hash`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: 'x'.repeat(64 * 1024),
        signal: watched.signal,
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.requestBodySettled).toBeUndefined();

    const counts = watched.counts();

    expect(counts.added).toBe(1);
    expect(counts.removed).toBe(counts.added);
  });

  test('a streamed response releases the stream relay listener as well', async () => {
    const watched = watchSignal();
    const { stream, getBytes } = makeMemoryWritable();

    const res = await new NodeAdapter().send(
      makeAdapterRequest(`${server.url}/api/binary`, {
        signal: watched.signal,
        streamResponse: () => stream,
      }),
    );

    expect(res.status).toBe(200);
    expect(res.isStreamed).toBe(true);
    expect(getBytes().length).toBe(2048);

    const counts = watched.counts();

    // The main abort listener and the relay into the factory's stream signal.
    expect(counts.added).toBe(2);
    expect(counts.removed).toBe(counts.added);
  });

  test('a failed request releases its listeners too', async () => {
    const watched = watchSignal();

    const res = await new NodeAdapter().send(
      makeAdapterRequest('http://127.0.0.1:1/unreachable', {
        signal: watched.signal,
      }),
    );

    expect(res.status).toBe(0);
    expect(res.isTransportError).toBe(true);

    const counts = watched.counts();

    expect(counts.added).toBe(1);
    expect(counts.removed).toBe(counts.added);
  });

  test('a rejected request releases its listeners too', async () => {
    const watched = watchSignal();

    let caught: Error | undefined;

    try {
      await new NodeAdapter().send(
        makeAdapterRequest(`${server.url}/api/test`, {
          signal: watched.signal,
          streamResponse: () => {
            throw new Error('factory refused');
          },
        }),
      );
    } catch (error) {
      caught = error as Error;
    }

    expect(caught?.message).toBe('factory refused');

    const counts = watched.counts();

    expect(counts.added).toBe(2);
    expect(counts.removed).toBe(counts.added);
  });

  test('the listener stays on while an early-answered upload is still going, so the attempt signal can still tear it down', async () => {
    const net = await import('node:net');

    // The same shape as "an early response with a stalled upload tears the request
    // down": the server answers and stops reading, so the write parks for good. Here the
    // teardown is asked for through the signal *after* `send()` has resolved - which is
    // what the client's settle deadline does - and must land well inside the watchdog's
    // five-second grace, which is the only other thing that would end the upload.
    const socketServer = net.createServer((socket) => {
      socket.on('error', () => {
        // The teardown reaches this side as a reset.
      });

      socket.once('data', () => {
        socket.write(
          'HTTP/1.1 413 Payload Too Large\r\nConnection: keep-alive\r\nContent-Length: 3\r\n\r\nno!',
        );
        socket.pause();
      });
    });

    await new Promise<void>((done) => {
      socketServer.listen(0, '127.0.0.1', done);
    });

    const { port } = socketServer.address() as { port: number };
    const watched = watchSignal();

    try {
      const res = await new NodeAdapter().send({
        requestURL: `http://127.0.0.1:${port}/upload`,
        method: 'POST',
        headers: {},
        body: 'x'.repeat(8 * 1024 * 1024),
        signal: watched.signal,
      });

      expect(res.status).toBe(413);

      // Resolved, but the upload is still outstanding: nothing has been released yet.
      expect(watched.counts()).toEqual({ added: 1, removed: 0 });

      const startedAt = Date.now();

      watched.controller.abort();

      const outcome = await res.requestBodySettled;

      expect(outcome).toBeInstanceOf(Error);
      expect(Date.now() - startedAt).toBeLessThan(2000);

      // Both sides have settled now, so the listener has been taken off.
      expect(watched.counts()).toEqual({ added: 1, removed: 1 });
    } finally {
      socketServer.close();
    }
  }, 20000);
});
