import { expect, spyOn, test } from 'bun:test';
import http from 'node:http';
import https from 'node:https';
import { FetchAdapter } from '../adapters/fetch-adapter';
import { MockAdapter } from '../adapters/mock-adapter';
import { NodeAdapter } from '../adapters/node-adapter';
import { XHRAdapter } from '../adapters/xhr-adapter';
import { NON_RETRYABLE_HTTP_ADAPTER_ERROR_FLAG } from '../consts';
import { HTTPClient } from '../http-client';
import type { AdapterRequest, AdapterResponse, HTTPAdapter } from '../types';
import {
  bodyOnBodilessMethodMessage,
  forbiddenMethodMessage,
  isBodilessMethod,
  isForbiddenBrowserMethod,
} from './method-refusal';

test('the rules read a method by its ASCII case alone', () => {
  expect(['CONNECT', 'trace', 'Track'].map(isForbiddenBrowserMethod)).toEqual([
    true,
    true,
    true,
  ]);
  expect(isForbiddenBrowserMethod('POST')).toBe(false);
  expect(['GET', 'head'].map(isBodilessMethod)).toEqual([true, true]);
  expect(isBodilessMethod('POST')).toBe(false);
});

test('FetchAdapter driven directly refuses as the client does, in the same words', async () => {
  const adapter = new FetchAdapter();
  const refusals: string[] = [];

  for (const request of [
    { method: 'TRACE', body: undefined },
    { method: 'GET', body: 'x' },
    { method: 'head', body: '' },
  ] as const) {
    try {
      await adapter.send({
        requestURL: 'https://api.example.com/x',
        headers: {},
        ...request,
      });
    } catch (error) {
      refusals.push((error as Error).message);
    }
  }

  const client = new HTTPClient({ adapter });
  const builder = client.request('TRACE', 'https://api.example.com/x');
  await builder.send();
  const reported = builder.error?.cause;

  expect(refusals).toEqual([
    forbiddenMethodMessage('FetchAdapter', 'TRACE'),
    bodyOnBodilessMethodMessage('fetch', 'GET'),
    bodyOnBodilessMethodMessage('fetch', 'HEAD'),
  ]);
  expect(builder.error?.code).toBe('request_setup_error');
  expect(
    reported instanceof Error ? reported.message : builder.error?.message,
  ).toBe(forbiddenMethodMessage('FetchAdapter', 'TRACE'));
});

/** The message `send` rejects with, or `undefined` when it resolves. */
async function refusalOf(send: Promise<unknown>): Promise<string | undefined> {
  return send.then(
    () => undefined,
    (error: unknown) => (error as Error).message,
  );
}

test('every adapter driven directly refuses an unusable URL before its body, header and method rules', async () => {
  const browserGlobals = globalThis as { window?: unknown; document?: unknown };
  browserGlobals.window = globalThis;
  browserGlobals.document = {};
  const refusals: Array<string | undefined> = [];
  try {
    for (const adapter of [new FetchAdapter(), new XHRAdapter()]) {
      for (const request of [
        { method: 'TRACE' },
        { method: 'CONNECT' },
        { method: 'GET', body: 'x' },
        { method: 'POST', body: { a: 1 } },
      ]) {
        refusals.push(
          await refusalOf(
            adapter.send({
              requestURL: 'ftp://api.example.com/x',
              headers: {},
              ...request,
            } as AdapterRequest),
          ),
        );
      }
    }
  } finally {
    delete browserGlobals.window;
    delete browserGlobals.document;
  }

  const node = new NodeAdapter();
  for (const request of [
    { method: 'CONNECT' },
    { method: 'POST', headers: { 'transfer-encoding': 'chunked' } },
    { method: 'POST', body: new ArrayBuffer(1) },
  ]) {
    refusals.push(
      await refusalOf(
        node.send({
          requestURL: 'ftp://api.example.com/x',
          headers: {},
          ...request,
        } as never),
      ),
    );
  }

  expect(refusals).toEqual([
    ...Array.from({ length: 4 }, () =>
      expect.stringContaining('FetchAdapter sends http: and https: URLs only'),
    ),
    ...Array.from({ length: 4 }, () =>
      expect.stringContaining('XHRAdapter sends http: and https: URLs only'),
    ),
    ...Array.from({ length: 3 }, () =>
      expect.stringContaining('NodeAdapter sends http: and https: URLs only'),
    ),
  ]);
});

test('NodeAdapter refuses a body it cannot send before its headers and method, and before reading its config', async () => {
  let configReads = 0;
  const node = new NodeAdapter({
    get decompress() {
      configReads++;
      return true;
    },
  });
  configReads = 0;
  const refusals: Array<string | undefined> = [];

  for (const request of [
    { method: 'CONNECT' },
    { method: 'POST', headers: { 'transfer-encoding': 'chunked' } },
  ]) {
    refusals.push(
      await refusalOf(
        node.send({
          requestURL: 'https://api.example.com/x',
          headers: {},
          body: new ArrayBuffer(1),
          ...request,
        } as never),
      ),
    );
  }

  expect(refusals).toEqual([
    expect.stringContaining(
      'NodeAdapter sends a string, Uint8Array or FormData body',
    ),
    expect.stringContaining(
      'NodeAdapter sends a string, Uint8Array or FormData body',
    ),
  ]);
  expect(configReads).toBe(0);
});

test("an interceptor's unusable URL is refused before the method it set, as before the interceptors", async () => {
  const adapter = new FetchAdapter();
  const client = new HTTPClient({ adapter });
  client.addRequestInterceptor((request) => ({
    ...request,
    method: 'TRACE',
    requestURL: 'ftp://api.example.com/x',
  }));
  const builder = client.get('https://api.example.com/x');
  await builder.send();

  expect(builder.error?.code).toBe('interceptor_error');
  expect(builder.error?.cause?.message).toContain(
    'Interceptor rewrote requestURL',
  );
});

test('every adapter driven directly refuses a CONNECT as a TypeError in the same words', async () => {
  const outcomes: Array<{ type: string; message: string }> = [];

  for (const adapter of [
    new FetchAdapter(),
    new XHRAdapter(),
    new NodeAdapter(),
    new MockAdapter(),
  ]) {
    const refusal = await adapter
      .send({
        requestURL: 'https://api.example.com/x',
        method: 'CONNECT',
        headers: {},
      })
      .then(
        () => undefined,
        (error: unknown) => error as Error,
      );
    outcomes.push({
      type: refusal instanceof TypeError ? 'TypeError' : String(refusal),
      message: String(refusal?.message).replace(/^\w+Adapter /, ''),
    });
  }

  expect(new Set(outcomes.map((outcome) => JSON.stringify(outcome))).size).toBe(
    1,
  );
  expect(outcomes[0]).toEqual({
    type: 'TypeError',
    message: 'does not open tunnels; a CONNECT request is not supported',
  });
});

test("a retry interceptor's unusable URL is refused before the method it set", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response('busy', { status: 503 }),
    )) as unknown as typeof fetch;
  try {
    const client = new HTTPClient({
      adapter: new FetchAdapter(),
      retryPolicy: { strategy: 'fixed', maxRetryAttempts: 1, delayMS: 1 },
    });
    client.addRequestInterceptor(
      (request) => ({
        ...request,
        method: 'TRACE',
        requestURL: 'ftp://api.example.com/x',
      }),
      { phases: ['retry'] },
    );
    const builder = client.get('https://api.example.com/x');
    await builder.send();

    expect(builder.error?.cause?.message).toContain(
      'Interceptor rewrote requestURL',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('every adapter driven directly refuses a body it does not send, in the same words, before its transport and the upload event', async () => {
  const originalFetch = globalThis.fetch;
  const originalXHR = globalThis.XMLHttpRequest;
  const httpSpy = spyOn(http, 'request');
  const httpsSpy = spyOn(https, 'request');
  let transportCalls = 0;
  globalThis.fetch = (() => {
    transportCalls++;
    return Promise.resolve(new Response('ok'));
  }) as unknown as typeof fetch;
  (globalThis as Record<string, unknown>).XMLHttpRequest = class {
    constructor() {
      transportCalls++;
    }
  };
  const mock = new MockAdapter();
  mock.routes.post('/x', () => {
    transportCalls++;
    return { status: 200 };
  });
  const outcomes: Array<{ message: string; isNonRetryable: unknown }> = [];
  const uploads: unknown[] = [];

  try {
    for (const adapter of [
      new FetchAdapter(),
      new XHRAdapter(),
      new NodeAdapter(),
      mock,
    ] as HTTPAdapter[]) {
      for (const body of [
        { a: 1 },
        42,
        [1, 2],
        new ReadableStream(),
        new ArrayBuffer(1),
        new Blob(['x']),
        Object.create(FormData.prototype) as unknown,
      ]) {
        // A CONNECT and a refused header too, so the body is the first thing refused.
        const refusal = await adapter
          .send({
            requestURL: 'https://api.example.com/x',
            method: 'CONNECT',
            headers: { 'transfer-encoding': 'chunked' },
            body: body as AdapterRequest['body'],
            onUploadProgress: (event) => {
              uploads.push(event);
            },
          })
          .then(
            () => undefined,
            (error: unknown) => error as TypeError & Record<string, unknown>,
          );
        expect(refusal).toBeInstanceOf(TypeError);
        outcomes.push({
          message: String(refusal?.message).replace(/^\w+Adapter /, ''),
          isNonRetryable: refusal?.[NON_RETRYABLE_HTTP_ADAPTER_ERROR_FLAG],
        });
      }
    }

    expect(transportCalls).toBe(0);
    expect(httpSpy).not.toHaveBeenCalled();
    expect(httpsSpy).not.toHaveBeenCalled();
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.XMLHttpRequest = originalXHR;
    httpSpy.mockRestore();
    httpsSpy.mockRestore();
  }

  expect(uploads).toEqual([]);
  expect(outcomes).toEqual(
    Array.from({ length: 28 }, () => ({
      message:
        'sends a string, Uint8Array or FormData body; serialize other bodies first',
      isNonRetryable: true,
    })),
  );
});

test("an interceptor's unusable URL is refused before its CONNECT, in every phase", async () => {
  const causes: Array<string | undefined> = [];
  const methodsSent: string[] = [];

  for (const phase of ['initial', 'redirect', 'retry'] as const) {
    let calls = 0;
    const adapter: HTTPAdapter = {
      getType: () => 'mock',
      send: (request) => {
        methodsSent.push(request.method);
        calls++;
        return Promise.resolve<AdapterResponse>(
          calls > 1
            ? { status: 200, headers: {}, body: null }
            : phase === 'redirect'
              ? {
                  status: 302,
                  headers: { location: 'https://api.example.com/next' },
                  body: null,
                }
              : { status: 503, headers: {}, body: null },
        );
      },
    };
    const client = new HTTPClient({
      adapter,
      followRedirects: true,
      retryPolicy: { strategy: 'fixed', maxRetryAttempts: 1, delayMS: 1 },
    });
    client.addRequestInterceptor(
      (request) => ({
        ...request,
        method: 'CONNECT',
        requestURL: 'ftp://api.example.com/x',
      }),
      { phases: [phase] },
    );
    const builder = client.get('https://api.example.com/x');
    await builder.send();

    expect(builder.error?.code).toBe('interceptor_error');
    causes.push(builder.error?.cause?.message);
  }

  expect(causes).toEqual(
    Array.from({ length: 3 }, () =>
      expect.stringContaining('Interceptor rewrote requestURL'),
    ),
  );
  expect(methodsSent).toEqual(['GET', 'GET']);
});

test("an interceptor's CONNECT is handed to the next as a method name, and refused only if the chain ends on it", async () => {
  const sent: string[] = [];
  const adapter: HTTPAdapter = {
    getType: () => 'mock',
    send: (request) => {
      sent.push(request.method);
      return Promise.resolve({ status: 200, headers: {}, body: null });
    },
  };
  const client = new HTTPClient({ adapter });
  const seen: string[] = [];
  client.addRequestInterceptor((request) => ({
    ...request,
    method: 'CONNECT',
  }));
  client.addRequestInterceptor((request) => {
    seen.push(request.method);
    return { ...request, method: 'POST' };
  });
  await client.get('https://api.example.com/x').send();

  const refusing = new HTTPClient({ adapter });
  refusing.addRequestInterceptor((request) => ({
    ...request,
    method: 'connect',
  }));
  const builder = refusing.get('https://api.example.com/x');
  await builder.send();

  expect(seen).toEqual(['CONNECT']);
  expect(sent).toEqual(['POST']);
  expect(builder.error?.code).toBe('interceptor_error');
  expect(builder.error?.cause?.message).toBe(
    '[HTTPClient] Interceptor returned a request whose method is CONNECT, which opens a tunnel and is not supported.',
  );
});

test('FetchAdapter refuses a port the Fetch Standard blocks, on every runtime, before its body and method rules', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (() => {
    calls++;
    return Promise.resolve(new Response('ok'));
  }) as unknown as typeof fetch;
  const uploads: unknown[] = [];
  const refusals: Array<string | undefined> = [];
  try {
    for (const request of [
      { requestURL: 'http://api.example.com:6000/x', method: 'GET' },
      { requestURL: 'https://api.example.com:25/x', method: 'TRACE' },
      {
        requestURL: 'http://api.example.com:10080/x',
        method: 'POST',
        body: { a: 1 },
      },
    ]) {
      refusals.push(
        await refusalOf(
          new FetchAdapter().send({
            headers: {},
            onUploadProgress: (event) => {
              uploads.push(event);
            },
            ...request,
          } as AdapterRequest),
        ),
      );
    }
    // A default port, and one next to a blocked one, are sent.
    for (const requestURL of [
      'http://api.example.com:80/x',
      'http://api.example.com:6001/x',
    ]) {
      refusals.push(
        await refusalOf(
          new FetchAdapter().send({ requestURL, method: 'GET', headers: {} }),
        ),
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }

  expect(refusals).toEqual([
    '[FetchAdapter] The Fetch Standard blocks port 6000, so FetchAdapter does not send to it.',
    '[FetchAdapter] The Fetch Standard blocks port 25, so FetchAdapter does not send to it.',
    '[FetchAdapter] The Fetch Standard blocks port 10080, so FetchAdapter does not send to it.',
    undefined,
    undefined,
  ]);
  expect(uploads).toEqual([]);
  expect(calls).toBe(2);
});

test('a filter can select a CONNECT one interceptor hands the next', async () => {
  const sent: string[] = [];
  const adapter: HTTPAdapter = {
    getType: () => 'mock',
    send: (request) => {
      sent.push(request.method);
      return Promise.resolve({ status: 200, headers: {}, body: null });
    },
  };
  const client = new HTTPClient({ adapter });
  client.addRequestInterceptor((request) => ({
    ...request,
    method: 'CONNECT',
  }));
  client.addRequestInterceptor((request) => ({ ...request, method: 'POST' }), {
    methods: ['CONNECT'],
  });
  await client.get('https://api.example.com/x').send();

  expect(sent).toEqual(['POST']);
});

test("a redirect interceptor's CONNECT is refused before an unusable Location it left as it was", async () => {
  const adapter: HTTPAdapter = {
    getType: () => 'mock',
    send: () =>
      Promise.resolve<AdapterResponse>({
        status: 302,
        headers: { location: 'ftp://files.example/x' },
        body: null,
      }),
  };
  const client = new HTTPClient({ adapter, followRedirects: true });
  client.addRequestInterceptor(
    (request) => ({ ...request, method: 'CONNECT' }),
    { phases: ['redirect'] },
  );
  const builder = client.get('https://api.example.com/x');
  await builder.send();

  expect(builder.error?.code).toBe('interceptor_error');
  expect(builder.error?.cause?.message).toBe(
    '[HTTPClient] Interceptor returned a request whose method is CONNECT, which opens a tunnel and is not supported.',
  );
});

test('XHRAdapter in a browser refuses a port the Fetch Standard blocks, and outside one sends it', async () => {
  const browserGlobals = globalThis as { window?: unknown; document?: unknown };
  const originalXHR = globalThis.XMLHttpRequest;
  let opened = 0;
  (globalThis as Record<string, unknown>).XMLHttpRequest = class {
    constructor() {
      opened++;
      throw new Error('opened');
    }
  };
  const send = () =>
    refusalOf(
      new XHRAdapter().send({
        requestURL: 'http://api.example.com:6000/x',
        method: 'GET',
        headers: {},
      }),
    );
  let inBrowser: string | undefined;
  browserGlobals.window = globalThis;
  browserGlobals.document = {};
  try {
    inBrowser = await send();
  } finally {
    delete browserGlobals.window;
    delete browserGlobals.document;
  }
  const outside = await send();
  globalThis.XMLHttpRequest = originalXHR;

  expect(inBrowser).toBe(
    '[XHRAdapter] The Fetch Standard blocks port 6000, so XHRAdapter does not send to it.',
  );
  expect(outside).not.toContain('blocks port');
  expect(opened).toBe(1);
});

test('FetchAdapter refuses a body it does not send before a header fetch refuses, and that header before the method', async () => {
  const send = (request: Partial<AdapterRequest>) =>
    refusalOf(
      new FetchAdapter().send({
        requestURL: 'https://api.example.com/x',
        method: 'POST',
        headers: { expect: '100-continue' },
        ...request,
      }),
    );

  expect([
    await send({ body: { a: 1 } as never }),
    await send({ method: 'TRACE' }),
    await send({ method: 'GET', body: 'x' }),
  ]).toEqual([
    'FetchAdapter sends a string, Uint8Array or FormData body; serialize other bodies first',
    "[FetchAdapter] Cannot send a request with an Expect header: the Fetch Standard forbids one, and Node's fetch refuses it.",
    "[FetchAdapter] Cannot send a request with an Expect header: the Fetch Standard forbids one, and Node's fetch refuses it.",
  ]);
});

test("FetchAdapter sends a React Native form, whose FormData has no has(), to fetch as it is, its caller's Content-Type dropped", async () => {
  const originalFormData = globalThis.FormData;
  const originalFetch = globalThis.fetch;
  // React Native's FormData holds only append, getAll and getParts.
  class MethodlessFormData {
    public append(): void {}
  }
  let sentBody: unknown;
  let sentHeaders: unknown;
  (globalThis as Record<string, unknown>).FormData = MethodlessFormData;
  globalThis.fetch = ((_url: string, init: RequestInit) => {
    sentBody = init.body;
    sentHeaders = init.headers;
    return Promise.resolve(new Response(null, { status: 204 }));
  }) as unknown as typeof fetch;
  try {
    const form = new MethodlessFormData();
    const response = await new FetchAdapter().send({
      requestURL: 'https://api.example.com/upload',
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data' },
      body: form as unknown as FormData,
    });

    expect(response.status).toBe(204);
    expect(sentBody).toBe(form);
    expect(JSON.stringify(sentHeaders)).not.toContain('content-type');
  } finally {
    globalThis.FormData = originalFormData;
    globalThis.fetch = originalFetch;
  }
});
