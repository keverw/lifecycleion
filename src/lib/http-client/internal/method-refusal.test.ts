import { expect, test } from 'bun:test';
import { FetchAdapter } from '../adapters/fetch-adapter';
import { MockAdapter } from '../adapters/mock-adapter';
import { NodeAdapter } from '../adapters/node-adapter';
import { XHRAdapter } from '../adapters/xhr-adapter';
import { HTTPClient } from '../http-client';
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
      ]) {
        refusals.push(
          await refusalOf(
            adapter.send({
              requestURL: 'ftp://api.example.com/x',
              headers: {},
              ...request,
            }),
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
    ...Array.from({ length: 3 }, () =>
      expect.stringContaining('FetchAdapter sends http: and https: URLs only'),
    ),
    ...Array.from({ length: 3 }, () =>
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
