import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  spyOn,
  test,
} from 'bun:test';
import * as net from 'node:net';
import type { AddressInfo } from 'node:net';
import vm from 'node:vm';
import { FetchAdapter } from './fetch-adapter';
import { materializeRequestHeaders } from '../internal/header-utils';
import { serializeError } from '../../serialize-error';
import { HTTPClient } from '../http-client';
import { startTestServer, type TestServer } from '../test-helpers/test-server';
import {
  NON_RETRYABLE_HTTP_ADAPTER_ERROR_FLAG,
  RESPONSE_STREAM_ABORT_FLAG,
  STREAM_ABORT_HEADERS_KEY,
} from '../consts';
import type { AdapterRequest } from '../types';
import { errorText } from '../test-helpers/error-text';

let server: TestServer;
/**
 * Requests Node's `fetch` refuses at dispatch, each with the `cause` it hangs the refusal
 * on (as Node 25's undici words them), read by FetchAdapter's dispatch-refusal backstop.
 */
const NODE_FETCH_DISPATCH_REFUSALS: Array<{
  url: string;
  headers: Record<string, string>;
  code: string | undefined;
  message: string;
}> = [
  {
    url: 'http://127.0.0.1:59999/',
    headers: { expect: '100-continue' },
    code: 'UND_ERR_NOT_SUPPORTED',
    message: 'expect header not supported',
  },
  {
    url: 'http://127.0.0.1:59999/',
    headers: { 'transfer-encoding': 'chunked' },
    code: 'UND_ERR_INVALID_ARG',
    message: 'invalid transfer-encoding header',
  },
  {
    url: 'http://127.0.0.1:59999/',
    headers: { connection: 'upgrade' },
    code: 'UND_ERR_INVALID_ARG',
    message: 'invalid connection header',
  },
  {
    url: 'http://127.0.0.1:6000/',
    headers: {},
    code: undefined,
    message: 'bad port',
  },
];

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

  test('a body that arrives as one large chunk is copied, so its producer reusing the chunk does not change the delivered body', async () => {
    const chunk = new Uint8Array(8 * 1024).fill(7);

    (globalThis as any).fetch = () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(chunk);
              controller.close();
            },
          }),
          { status: 200 },
        ),
      );

    const answer = await new FetchAdapter().send({
      requestURL: 'https://local.test/one-chunk',
      method: 'GET',
      headers: {},
      maxResponseBytes: 64 * 1024,
    });
    chunk.fill(0);

    const body = answer.body as Uint8Array;
    expect(body.byteLength).toBe(8 * 1024);
    expect(body.buffer).not.toBe(chunk.buffer);
    expect(body.every((byte) => byte === 7)).toBe(true);
  });

  test('a status below 100 is answered as a malformed response, its body let go', async () => {
    // Bun's `fetch` hands a server's `099` on as `status: 99`, and `000` as a response
    // with `status: 0`, where Node's refuses the response. Either way it is a transport
    // error, its headers - and so its cookies - unread.
    for (const status of [99, 0, 1000, 99.5]) {
      let isBodyCancelled = false;
      const uploads: number[] = [];

      (globalThis as any).fetch = () => {
        const response = new Response(
          new ReadableStream({
            cancel() {
              isBodyCancelled = true;
            },
          }),
          { status: 200, headers: { 'set-cookie': 'a=b' } },
        );

        Object.defineProperty(response, 'status', { value: status });

        return Promise.resolve(response);
      };

      const answer = await new FetchAdapter().send({
        requestURL: 'https://local.test/odd',
        method: 'POST',
        headers: {},
        body: 'abc',
        onUploadProgress: (event) => {
          uploads.push(event.progress);
        },
      });

      // The server answered, so the upload ended, as on every answered path: from the
      // starting 0 to done.
      expect(uploads).toEqual([0, 1]);
      expect(answer.status).toBe(0);
      expect(answer.isTransportError).toBe(true);
      expect(answer.headers).toEqual({});
      expect(answer.errorCause?.message).toBe(
        `Server answered with an invalid status code (got ${status})`,
      );
      expect(isBodyCancelled).toBe(true);
    }

    // A cancel that lands as the response does stays a cancel.
    const controller = new AbortController();

    (globalThis as any).fetch = () => {
      const response = new Response('x', { status: 200 });
      Object.defineProperty(response, 'status', { value: 99 });
      controller.abort();

      return Promise.resolve(response);
    };

    const failure = await new FetchAdapter()
      .send({
        requestURL: 'https://local.test/odd',
        method: 'GET',
        headers: {},
        signal: controller.signal,
      })
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect((failure as Error | null)?.name).toBe('AbortError');
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

  test("a form body goes out with fetch's own multipart Content-Type, not a caller's", async () => {
    let capturedInit: RequestInit | undefined;
    (globalThis as any).fetch = (_url: unknown, init?: RequestInit) => {
      capturedInit = init;
      return Promise.resolve(new Response('ok', { status: 200 }));
    };
    const form = new FormData();
    form.append('a', '1');

    await new FetchAdapter().send({
      requestURL: 'https://local.test/upload',
      method: 'POST',
      headers: { 'Content-Type': 'multipart/form-data', 'x-kept': 'yes' },
      body: form,
    });

    const sent = new Headers(capturedInit?.headers);
    expect(sent.has('content-type')).toBe(false);
    expect(sent.get('x-kept')).toBe('yes');
  });

  test('each header value is read once, so the build check and fetch see the same one', async () => {
    let capturedInit: RequestInit | undefined;
    (globalThis as any).fetch = (_url: unknown, init?: RequestInit) => {
      capturedInit = init;
      return Promise.resolve(new Response('ok', { status: 200 }));
    };
    let reads = 0;
    const headers = {
      get authorization() {
        reads++;
        return reads === 1 ? 'Bearer checked' : 'Bearer swapped';
      },
    } as unknown as Record<string, string>;

    await new FetchAdapter().send({
      requestURL: 'https://local.test/users',
      method: 'GET',
      headers,
    });

    expect(reads).toBe(1);
    expect(capturedInit?.headers).toEqual({ authorization: 'Bearer checked' });
  });

  test('a Cookie given under two spellings is joined with "; " whether or not another header is an array', async () => {
    // Read off what the adapter hands over, as one field: two spellings left for the
    // runtime to join would be joined with `, ` in Node and browsers (Bun uses `; `).
    const sent: string[] = [];
    (globalThis as any).fetch = (_url: unknown, init?: RequestInit) => {
      const given = init?.headers;
      const fields =
        given instanceof Headers
          ? [given.get('cookie')]
          : Object.entries(given ?? {})
              .filter(([name]) => name.toLowerCase() === 'cookie')
              .map(([, value]) => value as string);
      sent.push(fields.length === 1 ? (fields[0] ?? '') : 'not joined');
      return Promise.resolve(new Response('ok', { status: 200 }));
    };

    await new FetchAdapter().send({
      requestURL: 'https://local.test/users',
      method: 'GET',
      headers: { Cookie: 'a=1', cookie: 'b=2' },
    });
    await new FetchAdapter().send({
      requestURL: 'https://local.test/users',
      method: 'GET',
      headers: { Cookie: 'a=1', cookie: 'b=2', accept: ['x', 'y'] },
    });

    expect(sent).toEqual(['a=1; b=2', 'a=1; b=2']);
  });

  test('an empty Cookie part is left out', async () => {
    let cookie = null as string | null;
    (globalThis as any).fetch = (_url: unknown, init?: RequestInit) => {
      cookie = new Headers(init?.headers).get('cookie');
      return Promise.resolve(new Response('ok', { status: 200 }));
    };

    await new FetchAdapter().send({
      requestURL: 'https://local.test/users',
      method: 'GET',
      headers: { Cookie: [], cookie: 'b=2' },
    });

    expect(cookie).toBe('b=2');
  });

  test('the Cookie header is the one NodeAdapter sends', async () => {
    for (const headers of [
      { Cookie: [], cookie: 'b=2' },
      { cookie: ['a=1', ''] },
      { Cookie: '', cookie: 'b=2' },
      { Cookie: 'a=1', cookie: ['b=2', 'c=3'], accept: ['x', 'y'] },
    ] as Array<Record<string, string | string[]>>) {
      const expected = Object.entries(materializeRequestHeaders(headers)).find(
        ([name]) => name.toLowerCase() === 'cookie',
      )?.[1];
      let sent = null as string | null;
      (globalThis as any).fetch = (_url: unknown, init?: RequestInit) => {
        sent =
          init?.headers instanceof Headers
            ? init.headers.get('cookie')
            : ((Object.entries(init?.headers ?? {}).find(
                ([name]) => name.toLowerCase() === 'cookie',
              )?.[1] as string | undefined) ?? null);
        return Promise.resolve(new Response('ok', { status: 200 }));
      };

      await new FetchAdapter().send({
        requestURL: 'https://local.test/users',
        method: 'GET',
        headers,
      });

      // `Headers` trims each value, as fetch sends every header.
      expect([headers, sent]).toEqual([headers, expected?.trim() ?? null]);
    }
  });

  test('an unset cookie is not sent as the text "undefined"', async () => {
    let init: RequestInit | undefined;
    (globalThis as any).fetch = (_url: unknown, given?: RequestInit) => {
      init = given;
      return Promise.resolve(new Response('ok', { status: 200 }));
    };

    await new FetchAdapter().send({
      requestURL: 'https://local.test/users',
      method: 'GET',
      headers: { cookie: undefined } as unknown as Record<string, string>,
    });

    expect(new Headers(init?.headers).get('cookie')).toBeNull();
  });

  test('a 205 has no body, so no size refusal is read off it', async () => {
    (globalThis as any).fetch = () =>
      Promise.resolve(
        new Response(null, {
          status: 205,
          headers: { 'content-length': '1000' },
        }),
      );

    const response = await new FetchAdapter().send({
      requestURL: 'https://local.test/reset',
      method: 'POST',
      headers: {},
      maxResponseBytes: 10,
    });

    expect(response.status).toBe(205);
    expect(response.streamErrorCode).toBeUndefined();
  });

  test('withholds URL userinfo on a cross-origin hop', async () => {
    let capturedURL = '';

    (globalThis as any).fetch = (url: string) => {
      capturedURL = url;
      return Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: '/next' },
        }),
      );
    };

    const response = await new FetchAdapter().send({
      requestURL: 'https://user:hunter2@evil.test/collect',
      initialURL: 'https://api.example.test/start',
      method: 'GET',
      headers: {},
    });

    expect(capturedURL).toBe('https://evil.test/collect');
    expect(response.detectedRedirectURL).toBe('https://evil.test/next');
  });

  test('a redirect of a relative request URL reports its target', async () => {
    (globalThis as any).document = { baseURI: 'https://app.test/dir/page' };
    (globalThis as any).fetch = () =>
      Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: 'next' },
        }),
      );

    const response = await new FetchAdapter().send({
      requestURL: 'api/start',
      method: 'GET',
      headers: {},
    });

    expect(response.wasRedirectDetected).toBe(true);
    expect(response.detectedRedirectURL).toBe('https://app.test/dir/api/next');
  });

  test.each([
    ['https:next', 'https://app.test/dir/page', 'https://app.test/dir/next'],
    ['http:next', 'https://app.test/dir/page', 'http://next/'],
    ['https:next', undefined, 'https://next/'],
  ] as const)(
    '%s is sent where fetch resolves it against the page base (%s): %s',
    async (requestURL, baseURI, expected) => {
      let capturedURL = '';

      if (baseURI !== undefined) {
        (globalThis as any).document = { baseURI };
      }

      (globalThis as any).fetch = (url: string) => {
        capturedURL = url;
        return Promise.resolve(new Response(null, { status: 204 }));
      };

      await new FetchAdapter().send({ requestURL, method: 'GET', headers: {} });

      // The same as the URL parser resolves it against that base, as `fetch` does.
      expect(capturedURL).toBe(
        baseURI === undefined
          ? new URL(requestURL).href
          : new URL(requestURL, baseURI).href,
      );
      expect(capturedURL).toBe(expected);
    },
  );

  test.each([
    'https://user:hunter2@api.example.test/next',
    'https://user:@api.example.test/next',
    'https://user@api.example.test/next',
    'https://:hunter2@api.example.test/next',
  ])(
    'refuses same-origin URL userinfo, as fetch does, on every runtime: %s',
    async (requestURL) => {
      let calls = 0;
      (globalThis as any).fetch = () => {
        calls++;
        return Promise.resolve(new Response(null, { status: 204 }));
      };

      const refusal = await new FetchAdapter()
        .send({
          requestURL,
          initialURL: 'https://api.example.test/start',
          method: 'GET',
          headers: {},
        })
        .then(
          () => undefined,
          (error: unknown) => error as Record<PropertyKey, unknown>,
        );

      expect(String(refusal?.message)).toBe(
        '[FetchAdapter] fetch does not send a URL with credentials (user:pass@). Set an Authorization header instead, or use NodeAdapter.',
      );
      expect(refusal?.[NON_RETRYABLE_HTTP_ADAPTER_ERROR_FLAG]).toBe(true);
      expect(errorText(refusal)).not.toContain('hunter2');
      expect(calls).toBe(0);
    },
  );

  test("on Bun, refuses a path that starts with //, which Bun's fetch would send without its leading empty segments", async () => {
    const sent: string[] = [];
    (globalThis as any).fetch = (url: string) => {
      sent.push(url);
      return Promise.resolve(new Response(null, { status: 204 }));
    };
    const send = (requestURL: string) =>
      new FetchAdapter().send({ requestURL, method: 'GET', headers: {} }).then(
        () => undefined,
        (error: unknown) => error as Record<PropertyKey, unknown>,
      );

    for (const url of [
      'https://api.test//double//slash',
      'https://api.test///three',
      'https://api.test//a?x=1',
    ]) {
      const error = await send(url);
      expect(String(error?.message)).toBe(
        "[FetchAdapter] Bun's fetch would send a path that starts with // without its leading empty segments. Use NodeAdapter for it.",
      );
      expect(error?.[NON_RETRYABLE_HTTP_ADAPTER_ERROR_FLAG]).toBe(true);
    }

    expect(sent).toEqual([]);
    expect(await send('https://api.test/plain//x')).toBeUndefined();
    expect(sent).toEqual(['https://api.test/plain//x']);
  });

  test('withholds userinfo from a protocol-relative cross-origin URL', async () => {
    let capturedURL = '';

    (globalThis as any).document = { baseURI: 'https://api.example.test/page' };
    (globalThis as any).fetch = (url: string) => {
      capturedURL = url;
      return Promise.resolve(new Response(null, { status: 204 }));
    };

    await new FetchAdapter().send({
      requestURL: '//user:hunter2@evil.test/collect',
      initialURL: 'https://api.example.test/start',
      method: 'GET',
      headers: {},
    });

    expect(capturedURL).toBe('https://evil.test/collect');
  });

  test('userinfo is withheld from a protocol-relative URL that resolves to another origin', async () => {
    let capturedURL = '';
    // An `http:` page: `//u:p@api.test/x` is `http://api.test/x`, not the `https:` origin
    // the request started on.
    (globalThis as any).document = { baseURI: 'http://api.test/page' };
    (globalThis as any).fetch = (url: string) => {
      capturedURL = url;
      return Promise.resolve(new Response(null, { status: 204 }));
    };

    const originalRequest = globalThis.Request;
    const probedURLs: string[] = [];
    globalThis.Request = class extends originalRequest {
      constructor(input: RequestInfo | URL, init?: RequestInit) {
        super(input, init);
        probedURLs.push(this.url);
      }
    };

    try {
      const response = await new FetchAdapter().send({
        requestURL: '//u:p@api.test/x',
        initialURL: 'https://api.test/start',
        method: 'GET',
        headers: {},
      });

      expect(response.status).toBe(204);
      expect(capturedURL).toBe('http://api.test/x');
      // Checked before it was sent, as the URL that was sent.
      expect(probedURLs).toEqual(['http://api.test/x']);
    } finally {
      globalThis.Request = originalRequest;
    }
  });

  test('same-origin userinfo is kept once resolved against the page, and so refused', async () => {
    let capturedURL = '';
    (globalThis as any).document = { baseURI: 'https://api.test/page' };
    (globalThis as any).fetch = (url: string) => {
      capturedURL = url;
      return Promise.resolve(new Response(null, { status: 204 }));
    };

    // Bun's `Request` takes a URL with credentials; Node's refuses one, which is not what
    // this test is about.
    const originalRequest = globalThis.Request;
    delete (globalThis as { Request?: unknown }).Request;

    try {
      const refusal = await new FetchAdapter()
        .send({
          requestURL: '//u:p@api.test/x',
          initialURL: 'https://api.test/start',
          method: 'GET',
          headers: {},
        })
        .then(
          () => undefined,
          (error: unknown) => error as Error,
        );

      // Kept, so refused, as fetch refuses a URL with credentials.
      expect(refusal?.message).toBe(
        '[FetchAdapter] fetch does not send a URL with credentials (user:pass@). Set an Authorization header instead, or use NodeAdapter.',
      );
      expect(capturedURL).toBe('');
    } finally {
      globalThis.Request = originalRequest;
    }
  });

  test('a network-path URL with no base is refused, not stripped into an absolute one and sent', async () => {
    // No `document` or `location`: nothing resolves the URL against a page, so it is
    // refused as a relative URL with no base, not sent as one stripped against the initial
    // URL into an absolute `https://evil.test/x`.
    expect((globalThis as any).document).toBeUndefined();
    expect((globalThis as any).location).toBeUndefined();

    let calls = 0;
    (globalThis as any).fetch = () => {
      calls++;
      return Promise.resolve(new Response(null, { status: 204 }));
    };

    const outcome = await new FetchAdapter()
      .send({
        requestURL: '\\\\u:p@evil.test/x',
        initialURL: 'https://api.test/',
        method: 'GET',
        headers: {},
      })
      .then(
        () => undefined,
        (error: unknown) => error as Record<PropertyKey, unknown>,
      );

    expect(outcome).toBeInstanceOf(Error);
    expect(String(outcome?.message)).toContain(
      'could not be resolved to an absolute URL',
    );
    expect(outcome?.[NON_RETRYABLE_HTTP_ADAPTER_ERROR_FLAG]).toBe(true);
    expect(calls).toBe(0);
  });

  test('a signal this runtime cannot read is refused as non-retryable, without quoting it', async () => {
    (globalThis as any).fetch = originalFetch;

    const signal = {
      aborted: false,
      addEventListener() {},
      removeEventListener() {},
      secret: 'do-not-quote',
    } as unknown as AbortSignal;

    const outcome = await new FetchAdapter()
      .send({
        requestURL: 'http://127.0.0.1:59999/',
        method: 'GET',
        headers: {},
        signal,
      })
      .then(
        () => undefined,
        (error: unknown) => error as Record<PropertyKey, unknown>,
      );

    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as unknown as Error).message).toBe(
      "FetchAdapter request could not be sent: this runtime's fetch refused its signal, which is not a native AbortSignal",
    );
    expect(outcome?.[NON_RETRYABLE_HTTP_ADAPTER_ERROR_FLAG]).toBe(true);
    expect(
      JSON.stringify(serializeError(outcome as unknown as Error)),
    ).not.toContain('do-not-quote');
  });

  test('a stubbed fetch that takes a non-native signal still gets it', async () => {
    const signal = {
      aborted: false,
      addEventListener() {},
      removeEventListener() {},
    } as unknown as AbortSignal;
    let received: unknown;
    (globalThis as any).fetch = (_url: string, init: RequestInit) => {
      received = init.signal;
      return Promise.resolve(new Response('ok'));
    };

    const response = await new FetchAdapter().send({
      requestURL: 'http://example.test/',
      method: 'GET',
      headers: {},
      signal,
    });

    expect(response.status).toBe(200);
    expect(received).toBe(signal);
  });

  test('a network failure with a non-native signal stays a network failure', async () => {
    const signal = {
      aborted: false,
      addEventListener() {},
      removeEventListener() {},
    } as unknown as AbortSignal;
    const failure = new TypeError('Failed to fetch');
    (globalThis as any).fetch = () => Promise.reject(failure);

    const response = await new FetchAdapter().send({
      requestURL: 'http://example.test/',
      method: 'GET',
      headers: {},
      signal,
    });

    expect(response.status).toBe(0);
    expect(response.errorCause).toBe(failure);
  });

  test('a header fetch refuses is refused before the upload starts, on every runtime', async () => {
    let calls = 0;
    (globalThis as any).fetch = () => {
      calls++;
      return Promise.resolve(new Response('ok'));
    };
    const sendWith = (headers: Record<string, string | string[]>) => {
      const uploads: unknown[] = [];
      return new FetchAdapter()
        .send({
          requestURL: 'http://example.test/',
          method: 'POST',
          headers,
          body: 'x',
          onUploadProgress: (event) => uploads.push(event),
        })
        .then(
          () => ({ refusal: undefined, uploads }),
          (error: unknown) => ({
            refusal: error as Record<PropertyKey, unknown>,
            uploads,
          }),
        );
    };
    const refused: Array<Record<string, string | string[]>> = [
      { 'Transfer-Encoding': 'chunked' },
      { 'keep-alive': 'timeout=5' },
      { upgrade: 'websocket' },
      { expect: '100-continue' },
      { connection: 'upgrade' },
      { connection: ['close', 'close'] },
      { Connection: 'close', connection: 'close' },
    ];
    const named = [
      'a Transfer-Encoding header',
      'a Keep-Alive header',
      'an Upgrade header',
      'an Expect header',
      ...Array.from(
        { length: 3 },
        () => 'a Connection header other than close or keep-alive',
      ),
    ];

    for (const [index, headers] of refused.entries()) {
      const { refusal, uploads } = await sendWith(headers);

      expect(refusal).toBeInstanceOf(TypeError);
      expect(refusal?.[NON_RETRYABLE_HTTP_ADAPTER_ERROR_FLAG]).toBe(true);
      expect(String(refusal?.message)).toBe(
        `[FetchAdapter] Cannot send a request with ${named[index]}: the Fetch Standard forbids one, so FetchAdapter does not send it.`,
      );
      expect(uploads).toEqual([]);
    }
    expect(calls).toBe(0);

    for (const headers of [
      { connection: ' Close ' },
      { Connection: 'keep-alive' },
    ] as Array<Record<string, string>>) {
      expect((await sendWith(headers)).refusal).toBeUndefined();
    }
    expect(calls).toBe(2);
  });

  test.each(
    NODE_FETCH_DISPATCH_REFUSALS.map(({ code, message }) => [code, message]),
  )(
    "a request Node's fetch refuses at dispatch (%s: %s) fails once as non-retryable",
    async (code, message) => {
      let calls = 0;
      // As Node 25's undici rejects one: a `TypeError` with the refusal on its `cause`.
      (globalThis as any).fetch = () => {
        calls++;
        return Promise.reject(
          new TypeError('fetch failed', {
            cause: Object.assign(new Error(message), { code }),
          }),
        );
      };

      const outcome = await new FetchAdapter()
        .send({
          requestURL: 'http://example.test/',
          method: 'PUT',
          headers: {},
          body: 'x',
        })
        .then(
          () => undefined,
          (error: unknown) => error as Record<PropertyKey, unknown>,
        );

      expect(outcome?.[NON_RETRYABLE_HTTP_ADAPTER_ERROR_FLAG]).toBe(true);
      // Named by undici's reason, not its `fetch failed`, which reads as a network failure.
      expect(outcome?.message).toBe(`FetchAdapter request refused: ${message}`);
      expect(calls).toBe(1);
    },
  );

  // Pins the refusals above to the real `fetch` of the `node` on this machine, so a Node
  // that rewords or recodes one fails here rather than turning it into a retried network
  // error. Bun's `fetch` refuses none of these, so only Node is asked.
  test.skipIf(Bun.which('node') === null)(
    "Node's fetch refuses each at dispatch with the cause the adapter reads",
    () => {
      const script = `
        const probes = ${JSON.stringify(NODE_FETCH_DISPATCH_REFUSALS)};
        (async () => {
          const causes = [];
          for (const { url, headers } of probes) {
            try {
              await fetch(url, { headers });
              causes.push('sent');
            } catch (error) {
              causes.push({ code: error.cause?.code, message: error.cause?.message });
            }
          }
          console.log(JSON.stringify(causes));
        })();
      `;
      const result = Bun.spawnSync(['node', '-e', script], { timeout: 10_000 });
      expect(result.stderr.toString()).toBe('');
      const causes = JSON.parse(result.stdout.toString()) as unknown;

      expect(causes).toEqual(
        NODE_FETCH_DISPATCH_REFUSALS.map(({ code, message }) => ({
          ...(code === undefined ? {} : { code }),
          message,
        })),
      );
    },
  );

  test.each(['CONNECT', 'connect', 'TRACE', 'trace', 'TRACK'])(
    'a %s is refused as non-retryable before it is fetched',
    async (method) => {
      let calls = 0;
      (globalThis as any).fetch = () => {
        calls++;
        return Promise.resolve(new Response('ok'));
      };

      const outcome = await new FetchAdapter()
        .send({ requestURL: 'http://example.test/', method, headers: {} })
        .then(
          () => undefined,
          (error: unknown) => error as Record<PropertyKey, unknown>,
        );

      expect(outcome).toBeInstanceOf(Error);
      expect(outcome?.[NON_RETRYABLE_HTTP_ADAPTER_ERROR_FLAG]).toBe(true);
      expect(calls).toBe(0);
    },
  );

  test('a URL that is not http(s) is refused as non-retryable before it is fetched', async () => {
    let calls = 0;
    (globalThis as any).fetch = () => {
      calls++;
      return Promise.resolve(new Response('127.0.0.1 localhost'));
    };

    for (const requestURL of [
      'file:///etc/hosts',
      'data:text/plain,hi',
      'blob:https://app.test/0b2c',
      'ftp://files.test/x',
    ]) {
      const outcome = await new FetchAdapter()
        .send({ requestURL, method: 'GET', headers: {} })
        .then(
          () => undefined,
          (error: unknown) => error as Record<PropertyKey, unknown>,
        );

      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as unknown as Error).message).toBe(
        `FetchAdapter sends http: and https: URLs only (got ${requestURL.slice(0, requestURL.indexOf(':') + 1)})`,
      );
      expect(outcome?.[NON_RETRYABLE_HTTP_ADAPTER_ERROR_FLAG]).toBe(true);
    }

    expect(calls).toBe(0);
  });

  test('a relative URL with no base to resolve it against is refused as non-retryable', async () => {
    // No `document` or `location`: nothing to resolve the URL against.
    expect((globalThis as any).document).toBeUndefined();
    expect((globalThis as any).location).toBeUndefined();

    let calls = 0;
    (globalThis as any).fetch = () => {
      calls++;
      return Promise.resolve(new Response(null, { status: 204 }));
    };

    for (const requestURL of [
      '/relative',
      '//h.test/x',
      'api/x',
      'not a url',
    ]) {
      const outcome = await new FetchAdapter()
        .send({ requestURL, method: 'GET', headers: {} })
        .then(
          () => undefined,
          (error: unknown) => error as Record<PropertyKey, unknown>,
        );

      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as unknown as Error).message).toBe(
        'FetchAdapter request URL could not be resolved to an absolute URL (no document or location base, or not a valid URL)',
      );
      expect(outcome?.[NON_RETRYABLE_HTTP_ADAPTER_ERROR_FLAG]).toBe(true);
    }

    expect(calls).toBe(0);
  });

  test('a relative initial URL is resolved against the page before credentials are judged', async () => {
    let capturedURL = '';
    (globalThis as any).fetch = (url: string) => {
      capturedURL = url;
      return Promise.resolve(new Response(null, { status: 204 }));
    };

    // Bun's `Request` takes a URL with credentials; Node's refuses one, which is not what
    // this test is about.
    const originalRequest = globalThis.Request;
    delete (globalThis as { Request?: unknown }).Request;

    // A URL whose userinfo is kept is refused, as fetch refuses one with credentials.
    const sentURL = async (requestURL: string): Promise<string> => {
      capturedURL = '';
      return new FetchAdapter()
        .send({
          requestURL,
          initialURL: '/start',
          method: 'GET',
          headers: {},
        })
        .then(
          () => capturedURL,
          () => 'refused',
        );
    };

    try {
      (globalThis as any).document = { baseURI: 'https://api.test/page' };
      // `/start` on this page is `https://api.test/start`: same origin, kept.
      expect(await sentURL('https://u:p@api.test/x')).toBe('refused');
      // Another origin than the page's: withheld.
      expect(await sentURL('https://u:p@evil.test/x')).toBe(
        'https://evil.test/x',
      );

      // No base: the initial URL cannot be resolved, so it still fails closed.
      delete (globalThis as any).document;
      expect(await sentURL('https://u:p@api.test/x')).toBe(
        'https://api.test/x',
      );
    } finally {
      globalThis.Request = originalRequest;
    }
  });

  test('an initial URL that names no origin fails closed rather than naming the page', async () => {
    // Resolved against the page, `''`, `#top`, `?q` or `start` is the page itself: the
    // request URL's userinfo was kept with nothing to show it belonged to that origin. A
    // root- or protocol-relative one names an origin, and is resolved.
    let capturedURL = '';
    (globalThis as any).fetch = (url: string) => {
      capturedURL = url;
      return Promise.resolve(new Response(null, { status: 204 }));
    };

    // Bun's `Request` takes a URL with credentials; Node's refuses one, which is not what
    // this test is about.
    const originalRequest = globalThis.Request;
    delete (globalThis as { Request?: unknown }).Request;
    const previousDocument = (globalThis as any).document;

    // A URL whose userinfo is kept is refused, as fetch refuses one with credentials.
    const sentURL = async (initialURL: string): Promise<string> => {
      capturedURL = '';
      return new FetchAdapter()
        .send({
          requestURL: 'https://u:p@app.test/x',
          initialURL,
          method: 'GET',
          headers: {},
        })
        .then(
          () => capturedURL,
          () => 'refused',
        );
    };

    try {
      (globalThis as any).document = { baseURI: 'https://app.test/page' };

      for (const initialURL of ['', ' \t\n', '#top', '?q', '.', 'start']) {
        expect(await sentURL(initialURL)).toBe('https://app.test/x');
      }

      for (const initialURL of ['/start', '//app.test/start']) {
        expect(await sentURL(initialURL)).toBe('refused');
      }
    } finally {
      if (previousDocument === undefined) {
        delete (globalThis as any).document;
      } else {
        (globalThis as any).document = previousDocument;
      }
      globalThis.Request = originalRequest;
    }
  });

  test('a request refused before it is sent reports no upload start', async () => {
    let calls = 0;
    (globalThis as any).fetch = () => {
      calls++;
      return Promise.resolve(new Response(null, { status: 204 }));
    };

    const refusals: Array<Partial<AdapterRequest>> = [
      // Refused by the `Request` probe: a header name `fetch` will not take.
      { headers: { 'bad name': 'x' } },
      // Refused as its signal is read.
      {
        signal: {
          get aborted(): boolean {
            throw new Error('aborted getter failed');
          },
        } as unknown as AbortSignal,
      },
    ];

    for (const refusal of refusals) {
      const events: unknown[] = [];
      const outcome = await new FetchAdapter()
        .send({
          requestURL: 'https://api.test/upload',
          method: 'POST',
          headers: {},
          body: 'hello',
          onUploadProgress: (event) => events.push(event),
          ...refusal,
        })
        .then(
          () => undefined,
          (error: unknown) => error as Record<PropertyKey, unknown>,
        );

      expect(outcome?.[NON_RETRYABLE_HTTP_ADAPTER_ERROR_FLAG]).toBe(true);
      expect(events).toEqual([]);
    }

    expect(calls).toBe(0);
  });

  test("a request the runtime refuses to build is reported without the runtime's error, which quotes the value", async () => {
    const secret = 'secret-token';
    let calls = 0;
    (globalThis as any).fetch = () => {
      calls++;
      return Promise.resolve(new Response(null, { status: 204 }));
    };
    const send = (request: Partial<AdapterRequest>) =>
      new FetchAdapter()
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

    // This runtime's own refusal: Bun quotes a header value it will not take.
    const header = await send({
      headers: { authorization: `Bearer ${secret}\u0000x` },
    });
    expect(String(header?.message)).toBe(
      "FetchAdapter request could not be built: the runtime refused the value of header 'authorization'",
    );
    expect(header?.[NON_RETRYABLE_HTTP_ADAPTER_ERROR_FLAG]).toBe(true);
    expect(errorText(header)).not.toContain(secret);

    // A name that is not a token - a whole header line pasted in as one - is not written.
    const name = await send({
      headers: { [`Authorization: Bearer ${secret}`]: 'x' },
    });
    expect(String(name?.message)).toBe(
      'FetchAdapter request could not be built: the runtime refused a header name',
    );
    expect(errorText(name)).not.toContain(secret);

    // A URL the runtime refuses, quoting it with its userinfo and query, as Node's
    // `Request` does.
    const OriginalRequest = globalThis.Request;
    globalThis.Request = class {
      constructor(url: string) {
        throw Object.assign(
          new TypeError(`Request cannot be constructed from ${url}`),
          { input: url },
        );
      }
    } as unknown as typeof Request;
    try {
      const url = await send({
        requestURL: `https://api.test/x?token=${secret}`,
      });
      expect(String(url?.message)).toBe(
        'FetchAdapter request could not be built: the runtime refused its URL or method',
      );
      expect(errorText(url)).not.toContain(secret);
    } finally {
      globalThis.Request = OriginalRequest;
    }

    // A URL with credentials is refused before the runtime is asked, without them.
    const credentials = await send({
      requestURL: `https://user:${secret}@api.test/x?token=${secret}`,
    });
    expect(String(credentials?.message)).toBe(
      '[FetchAdapter] fetch does not send a URL with credentials (user:pass@). Set an Authorization header instead, or use NodeAdapter.',
    );
    expect(errorText(credentials)).not.toContain(secret);

    expect(calls).toBe(0);
  });

  test("without a global Request, a header Headers refuses is refused before fetch, without the runtime's error", async () => {
    const secret = 'secret-token';
    let calls = 0;
    (globalThis as any).fetch = () => {
      calls++;
      return Promise.resolve(new Response(null, { status: 204 }));
    };
    const OriginalRequest = globalThis.Request;
    delete (globalThis as Record<string, unknown>).Request;
    try {
      // A repeated header is appended to a `Headers`; a single one checked by one.
      for (const headers of [
        { authorization: ['Bearer a', `Bearer ${secret}\u0000x`] },
        { authorization: `Bearer ${secret}\u0000x` },
      ]) {
        const outcome = await new FetchAdapter()
          .send({ requestURL: 'https://api.test/x', method: 'GET', headers })
          .then(
            () => undefined,
            (error: unknown) => error as Record<PropertyKey, unknown>,
          );

        expect(String(outcome?.message)).toBe(
          "FetchAdapter request could not be built: the runtime refused the value of header 'authorization'",
        );
        expect(outcome?.[NON_RETRYABLE_HTTP_ADAPTER_ERROR_FLAG]).toBe(true);
        expect(errorText(outcome)).not.toContain(secret);
      }
    } finally {
      globalThis.Request = OriginalRequest;
    }

    expect(calls).toBe(0);
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

  test('joins a repeated request header with `, `, in any case, where the runtime has no Headers', async () => {
    let capturedInit: RequestInit | undefined;

    (globalThis as any).fetch = (
      _url: string | URL | Request,
      init?: RequestInit,
    ) => {
      capturedInit = init;
      return Promise.resolve(new Response('ok', { status: 200 }));
    };

    const OriginalHeaders = globalThis.Headers;
    const OriginalRequest = globalThis.Request;
    let response: Awaited<ReturnType<FetchAdapter['send']>>;

    delete (globalThis as Record<string, unknown>).Headers;
    delete (globalThis as Record<string, unknown>).Request;
    try {
      response = await new FetchAdapter().send({
        requestURL: 'https://local.test/users',
        method: 'GET',
        headers: {
          accept: ['application/json', 'text/plain'],
          Accept: 'text/html',
          'x-one': 'a',
        },
      });
    } finally {
      globalThis.Headers = OriginalHeaders;
      globalThis.Request = OriginalRequest;
    }

    expect(response.status).toBe(200);
    // One field per name, in any case, as a `Headers` would send it.
    expect(capturedInit?.headers).toEqual({
      accept: 'application/json, text/plain, text/html',
      'x-one': 'a',
    });
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

    // Joined into one field before it is handed over, so no name repeats and it goes as
    // a record.
    expect(capturedInit?.headers).toEqual({
      cookie: 'session=abc123; theme=dark',
    });
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
      // No body: zero bytes, as NodeAdapter reports it.
      { loaded: 0, total: 0, progress: 1 },
    ]);
    expect(downloadEvents).toEqual([{ loaded: 0, total: 0, progress: 1 }]);
  });

  test('the final upload event reports the body as fetch took it, though its buffer is transferred in flight', async () => {
    const body = new Uint8Array(8);
    const uploadEvents: Array<{
      loaded: number;
      total: number;
      progress: number;
    }> = [];

    (globalThis as any).fetch = () => {
      // The caller hands the buffer on while the request is in flight, leaving the view
      // with no bytes.
      structuredClone(body.buffer, { transfer: [body.buffer] });
      return Promise.resolve(
        new Response(null, { status: 204, headers: new Headers() }),
      );
    };

    const response = await new FetchAdapter().send({
      requestURL: 'https://local.test/upload',
      method: 'POST',
      headers: {},
      body,
      onUploadProgress: (e) => uploadEvents.push(e),
    });

    expect(response.status).toBe(204);
    expect(body.byteLength).toBe(0);
    expect(uploadEvents).toEqual([
      { loaded: 0, total: 0, progress: 0 },
      { loaded: 8, total: 8, progress: 1 },
    ]);
  });

  test.each([
    ['an opaque redirect', 0, 'opaqueredirect', 'GET', 'resolved'],
    ['a bodiless answer', 204, 'basic', 'GET', 'rejected AbortError'],
    ['a HEAD answer', 200, 'basic', 'HEAD', 'rejected AbortError'],
  ] as const)(
    'a cancel from the final upload event on %s reports no download completion',
    async (_label, status, type, method, expected) => {
      const controller = new AbortController();
      const downloads: number[] = [];

      (globalThis as any).fetch = () =>
        Promise.resolve({
          status,
          type,
          headers: new Headers(),
          body: null,
        } as Response);

      const outcome = await new FetchAdapter()
        .send({
          requestURL: 'https://local.test/users',
          method,
          headers: {},
          signal: controller.signal,
          onUploadProgress: ({ progress }) => {
            if (progress === 1) {
              controller.abort();
            }
          },
          onDownloadProgress: ({ progress }) => downloads.push(progress),
        })
        .then(
          () => 'resolved',
          (error: unknown) => `rejected ${(error as Error).name}`,
        );

      // The opaque redirect is the client's to sort from the cancel, as XHRAdapter's is.
      expect(outcome).toBe(expected);
      expect(downloads).toEqual([]);
    },
  );

  test('a cancel from the final upload event lets go of the body', async () => {
    const controller = new AbortController();
    let isCancelled = false;

    (globalThis as any).fetch = () =>
      Promise.resolve({
        status: 200,
        type: 'basic',
        headers: new Headers(),
        // A polyfill's body that does not watch the signal.
        body: {
          cancel: () => {
            isCancelled = true;
            return Promise.resolve();
          },
        },
      } as unknown as Response);

    const outcome = await new FetchAdapter()
      .send({
        requestURL: 'https://local.test/users',
        method: 'GET',
        headers: {},
        signal: controller.signal,
        onUploadProgress: ({ progress }) => {
          if (progress === 1) {
            controller.abort();
          }
        },
      })
      .then(
        () => 'resolved',
        (error: unknown) => `rejected ${(error as Error).name}`,
      );

    expect(outcome).toBe('rejected AbortError');
    expect(isCancelled).toBe(true);
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

  test('a throwing error name getter cannot escape fetch failure handling', async () => {
    const hostile = new Error('fetch failed');
    Object.defineProperty(hostile, 'name', {
      get(): never {
        throw new Error('hostile name getter');
      },
    });
    (globalThis as any).fetch = () => Promise.reject(hostile);

    const response = await new FetchAdapter().send({
      requestURL: 'https://local.test/users',
      method: 'GET',
      headers: {},
    });

    expect(response.status).toBe(0);
    expect(response.isTransportError).toBe(true);
    expect(response.errorCause).toBe(hostile);
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

  test.each([4, undefined])(
    'a resizable buffer arrayBuffer() hands over is returned as the bytes it held then (maxResponseBytes %p)',
    async (maxResponseBytes) => {
      const buffer = new (
        ArrayBuffer as unknown as new (
          length: number,
          options: { maxByteLength: number },
        ) => ArrayBuffer & { resize: (length: number) => void }
      )(4, {
        maxByteLength: 16,
      });
      new Uint8Array(buffer).set([1, 2, 3, 4]);

      (globalThis as any).fetch = () =>
        Promise.resolve({
          status: 200,
          headers: new Headers(),
          arrayBuffer: () => Promise.resolve(buffer),
        } as unknown as Response);

      const response = await new FetchAdapter().send({
        requestURL: 'https://local.test/resizable',
        method: 'GET',
        headers: {},
        maxResponseBytes,
      });
      buffer.resize(16);

      expect(response.body).toEqual(new Uint8Array([1, 2, 3, 4]));
      expect(response.body?.length).toBe(4);
    },
  );

  test('a SharedArrayBuffer arrayBuffer() hands over is returned as a copy of the bytes it held then', async () => {
    const buffer = new SharedArrayBuffer(4);
    const shared = new Uint8Array(buffer);
    shared.set([1, 2, 3, 4]);

    (globalThis as any).fetch = () =>
      Promise.resolve({
        status: 200,
        headers: new Headers(),
        arrayBuffer: () => Promise.resolve(buffer),
      } as unknown as Response);

    const response = await new FetchAdapter().send({
      requestURL: 'https://local.test/shared',
      method: 'GET',
      headers: {},
      maxResponseBytes: 4,
    });
    shared[0] = 9;

    expect(response.body).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  test.each([
    [4, [1, 2, 3, 4]],
    [2, null],
  ])(
    'a wider typed array arrayBuffer() hands over is read by its bytes (maxResponseBytes %p)',
    async (maxResponseBytes, expected) => {
      const view = new Uint16Array(new Uint8Array([1, 2, 3, 4]).buffer);

      (globalThis as any).fetch = () =>
        Promise.resolve({
          status: 200,
          headers: new Headers(),
          arrayBuffer: () => Promise.resolve(view),
        } as unknown as Response);

      const response = await new FetchAdapter().send({
        requestURL: 'https://local.test/view',
        method: 'GET',
        headers: {},
        maxResponseBytes,
      });

      if (expected === null) {
        expect(response.streamErrorCode).toBe('response_too_large');
        expect(response.body).toBeNull();
      } else {
        expect(response.body).toEqual(new Uint8Array(expected));
      }
    },
  );

  test('a view over part of a buffer that arrayBuffer() hands over is returned as a copy of its own bytes', async () => {
    const pool = new Uint8Array([9, 1, 2, 9]);
    const view = pool.subarray(1, 3);

    (globalThis as any).fetch = () =>
      Promise.resolve({
        status: 200,
        headers: new Headers(),
        arrayBuffer: () => Promise.resolve(view),
      } as unknown as Response);

    const response = await new FetchAdapter().send({
      requestURL: 'https://local.test/pooled',
      method: 'GET',
      headers: {},
      maxResponseBytes: 2,
    });
    pool[1] = 7;

    expect(response.body).toEqual(new Uint8Array([1, 2]));
    expect(response.body?.buffer.byteLength).toBe(2);
  });

  test('a typed array past the end of a resizable buffer that shrank is a stream error, not an empty body', async () => {
    const buffer = new (
      ArrayBuffer as unknown as new (
        length: number,
        options: { maxByteLength: number },
      ) => ArrayBuffer & { resize: (length: number) => void }
    )(8, { maxByteLength: 8 });
    const view = new Uint8Array(buffer, 4, 4);
    buffer.resize(2);

    (globalThis as any).fetch = () =>
      Promise.resolve({
        status: 200,
        headers: new Headers(),
        arrayBuffer: () => Promise.resolve(view),
      } as unknown as Response);

    const response = await new FetchAdapter().send({
      requestURL: 'https://local.test/shrunk',
      method: 'GET',
      headers: {},
    });

    expect(response.status).toBe(200);
    expect(response.isStreamError).toBe(true);
    expect(response.body).toBeNull();
  });

  test('a DataView from another realm that arrayBuffer() hands over is read by its bytes', async () => {
    const view = vm.runInNewContext(
      'new DataView(new Uint8Array([9, 1, 2, 9]).buffer, 1, 2)',
    ) as DataView;

    (globalThis as any).fetch = () =>
      Promise.resolve({
        status: 200,
        headers: new Headers(),
        arrayBuffer: () => Promise.resolve(view),
      } as unknown as Response);

    const response = await new FetchAdapter().send({
      requestURL: 'https://local.test/realm',
      method: 'GET',
      headers: {},
    });

    expect(response.body).toEqual(new Uint8Array([1, 2]));
  });

  test('an arrayBuffer() that resolves to neither a buffer nor a view is a stream error', async () => {
    (globalThis as any).fetch = () =>
      Promise.resolve({
        status: 200,
        headers: new Headers(),
        arrayBuffer: () => Promise.resolve(1_000_000),
      } as unknown as Response);

    const response = await new FetchAdapter().send({
      requestURL: 'https://local.test/odd',
      method: 'GET',
      headers: {},
    });

    expect(response.status).toBe(200);
    expect(response.isStreamError).toBe(true);
    expect(response.body).toBeNull();
  });

  test('a resizable buffer over the limit that arrayBuffer() hands over is refused without being copied', async () => {
    const buffer = new (
      ArrayBuffer as unknown as new (
        length: number,
        options: { maxByteLength: number },
      ) => ArrayBuffer
    )(16, { maxByteLength: 32 });
    const slice = spyOn(Uint8Array.prototype, 'slice');

    (globalThis as any).fetch = () =>
      Promise.resolve({
        status: 200,
        headers: new Headers(),
        arrayBuffer: () => Promise.resolve(buffer),
      } as unknown as Response);

    try {
      const response = await new FetchAdapter().send({
        requestURL: 'https://local.test/too-large',
        method: 'GET',
        headers: {},
        maxResponseBytes: 4,
      });

      expect(response.streamErrorCode).toBe('response_too_large');
      expect(response.body).toBeNull();
      expect(slice).not.toHaveBeenCalled();
    } finally {
      slice.mockRestore();
    }
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
      // No body: zero bytes, as NodeAdapter reports it.
      { loaded: 0, total: 0, progress: 1 },
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

    test('does not report `requestBodySettled` on a bodied request', async () => {
      // The documented contract: `fetch()` exposes neither upload progress nor the moment
      // the body finished going out, so the adapter cannot say when an upload settled and
      // leaves the field absent. The client therefore does not wait before a `307`/`308`
      // hop or a retry on this adapter - see the FetchAdapter docs. Pinned so an
      // adapter change that starts reporting it is a deliberate one, with the wait
      // semantics that come with it.
      const response = await adapter.send({
        requestURL: `${server.url}/api/users`,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Alice' }),
      });

      expect(response.status).toBe(201);
      expect('requestBodySettled' in response).toBe(false);
    });

    test('reports 100% upload progress once the response headers arrive', async () => {
      // Also the documented contract, and the reason the previous test matters: the
      // terminal upload event is fired when `fetch()` resolves - which is when the
      // response headers arrive - not when the body was confirmed on the wire.
      const uploads: number[] = [];

      await adapter.send({
        requestURL: `${server.url}/api/users`,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Alice' }),
        onUploadProgress: (event) => uploads.push(event.progress),
      });

      expect(uploads).toEqual([0, 1]);
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
    // Same shape `toError` produces, and the raw value stays reachable on `cause`.
    expect(response.errorCause?.message).toBe(
      'Non-error value thrown: socket hang up',
    );
    expect(response.errorCause?.cause).toBe('socket hang up');
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

  test('body abort tagging survives throwing Error metadata getters', async () => {
    const controller = new AbortController();
    const hostile = new Error('ignored');

    for (const field of ['name', 'message']) {
      Object.defineProperty(hostile, field, {
        get(): never {
          throw new Error(`hostile ${field} getter`);
        },
      });
    }

    (globalThis as any).fetch = () =>
      Promise.resolve({
        status: 200,
        type: 'default',
        headers: new Headers(),
        arrayBuffer: () => {
          controller.abort();
          return Promise.reject(hostile);
        },
      });

    const thrown = await adapter
      .send({
        requestURL: 'http://api.test/api/test',
        method: 'GET',
        headers: {},
        signal: controller.signal,
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).name).toBe('AbortError');
    expect((thrown as Error).message).toBe('Request aborted');
    expect(
      (thrown as Record<string, unknown>)[RESPONSE_STREAM_ABORT_FLAG],
    ).toBe(true);
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

describe('FetchAdapter - a request aborted before it is sent', () => {
  test.each([
    'already aborted',
    'cancelled from the 0% upload callback',
  ] as const)(
    "one %s is not dispatched, reports no upload end and rejects with the signal's reason",
    async (when) => {
      let fetchCalls = 0;
      // A `fetch` that sends whatever it is handed, an aborted signal included.
      (globalThis as any).fetch = () => {
        fetchCalls++;
        return Promise.resolve(new Response('ok', { status: 200 }));
      };
      const controller = new AbortController();
      const reason = new Error('caller gave up');
      if (when === 'already aborted') {
        controller.abort(reason);
      }
      const events: number[] = [];

      const rejection = await new FetchAdapter()
        .send({
          requestURL: 'https://local.test/upload',
          method: 'POST',
          headers: {},
          body: 'abc',
          signal: controller.signal,
          onUploadProgress: (event) => {
            events.push(event.progress);
            if (event.progress === 0) {
              controller.abort(reason);
            }
          },
        })
        .then(
          () => undefined,
          (error: unknown) => error,
        );

      expect(rejection).toBe(reason);
      expect(fetchCalls).toBe(0);
      expect(events).toEqual(when === 'already aborted' ? [] : [0]);
    },
  );

  test('one aborted with no reason of its own rejects with an AbortError', async () => {
    let fetchCalls = 0;
    (globalThis as any).fetch = () => {
      fetchCalls++;
      return Promise.resolve(new Response('ok', { status: 200 }));
    };
    const signal = {
      aborted: true,
      reason: undefined,
      addEventListener: () => {},
      removeEventListener: () => {},
    } as unknown as AbortSignal;

    const rejection = await new FetchAdapter()
      .send({
        requestURL: 'https://local.test/data',
        method: 'GET',
        headers: {},
        signal,
      })
      .then(
        () => undefined,
        (error: unknown) => error as Error,
      );

    expect(rejection?.name).toBe('AbortError');
    expect(fetchCalls).toBe(0);
  });
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
    expect(STREAM_ABORT_HEADERS_KEY in sharedReason).toBe(false);
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

describe('FetchAdapter - cut-off responses and unbuildable requests', () => {
  test("a cut-off response's Set-Cookie is not written by serializeError", async () => {
    (globalThis as any).fetch = (_url: string, init?: RequestInit) =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              init?.signal?.addEventListener('abort', () => {
                controller.error(new DOMException('aborted', 'AbortError'));
              });
            },
          }),
          { status: 200, headers: { 'set-cookie': 'session=SECRET123' } },
        ),
      );
    const builder = new HTTPClient({
      adapter: new FetchAdapter(),
      timeout: 30,
    }).get('http://api.test/x');

    await builder.send();

    expect(builder.error?.code).toBe('stream_response_error');
    expect(JSON.stringify(serializeError(builder.error?.cause))).not.toContain(
      'SECRET123',
    );
  });

  test('a request fetch refuses to build fails once as adapter_error, not a retried network error', async () => {
    let calls = 0;
    (globalThis as any).fetch = () => {
      calls++;
      return Promise.resolve(new Response(null, { status: 200 }));
    };
    const builder = new HTTPClient({
      adapter: new FetchAdapter(),
      retryPolicy: { strategy: 'fixed', maxRetryAttempts: 3, delayMS: 0 },
    })
      .get('http://api.test/x')
      .headers({ 'x-bad': 'a\nb' });

    const response = await builder.send();

    expect(calls).toBe(0);
    expect(builder.error?.code).toBe('adapter_error');
    expect(response.isNetworkError).toBe(false);
    expect(builder.attemptCount).toBe(1);
  });
});

test('FetchAdapter still sends where Request or URL.canParse is missing', async () => {
  let calls = 0;
  (globalThis as any).fetch = () => {
    calls++;
    return Promise.resolve(new Response(null, { status: 200 }));
  };
  const originalRequest = globalThis.Request;
  const canParseDescriptor = Object.getOwnPropertyDescriptor(URL, 'canParse');
  try {
    delete (globalThis as { Request?: unknown }).Request;
    (URL as { canParse?: unknown }).canParse = undefined;

    const response = await new HTTPClient({ adapter: new FetchAdapter() })
      .get('http://api.test/x')
      .send();

    expect(response.status).toBe(200);
    expect(calls).toBe(1);
  } finally {
    globalThis.Request = originalRequest;
    if (canParseDescriptor) {
      Object.defineProperty(URL, 'canParse', canParseDescriptor);
    }
  }
});

test('FetchAdapter refuses a method the runtime fetch would rewrite, rather than sending it as another', async () => {
  // Bun's Request reads an unknown method as GET; where the runtime keeps it, there is
  // nothing to refuse.
  if (
    new Request('http://a.test', { method: 'APPROVE' }).method === 'APPROVE'
  ) {
    return;
  }
  let calls = 0;
  (globalThis as any).fetch = () => {
    calls++;
    return Promise.resolve(new Response(null, { status: 200 }));
  };
  const builder = new HTTPClient({ adapter: new FetchAdapter() }).request(
    'APPROVE',
    'http://api.test/x',
  );

  await builder.send();

  expect(calls).toBe(0);
  expect(builder.error?.code).toBe('adapter_error');
});

test('FetchAdapter refuses a fetch that uppercases a custom method, which is case-sensitive', async () => {
  let calls = 0;
  (globalThis as any).fetch = () => {
    calls++;
    return Promise.resolve(new Response(null, { status: 200 }));
  };
  const originalRequest = globalThis.Request;
  // A polyfill that uppercases every method, as `fetch` does only the standard six.
  globalThis.Request = class {
    public readonly method: string;

    constructor(_input: RequestInfo | URL, init?: RequestInit) {
      this.method = (init?.method ?? 'GET').toUpperCase();
    }
  } as unknown as typeof Request;

  try {
    let thrown: unknown;
    try {
      await new FetchAdapter().send({
        requestURL: 'http://api.test/x',
        method: 'purge',
        headers: {},
      });
    } catch (error) {
      thrown = error;
    }

    expect(calls).toBe(0);
    expect((thrown as Error).message).toBe(
      "[FetchAdapter] This runtime's fetch would send the purge request as PURGE. Use NodeAdapter for it.",
    );
  } finally {
    globalThis.Request = originalRequest;
  }
});

test('an empty document.baseURI falls back to location, as the client resolves', async () => {
  const locationDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    'location',
  );
  (globalThis as any).document = { baseURI: '' };
  Object.defineProperty(globalThis, 'location', {
    value: { href: 'https://app.test/dir/page' },
    configurable: true,
    writable: true,
  });
  (globalThis as any).fetch = () =>
    Promise.resolve(
      new Response(null, { status: 302, headers: { location: 'next' } }),
    );

  try {
    const response = await new FetchAdapter().send({
      requestURL: 'api/start',
      method: 'GET',
      headers: {},
    });

    expect(response.detectedRedirectURL).toBe('https://app.test/dir/api/next');
  } finally {
    if (locationDescriptor === undefined) {
      delete (globalThis as any).location;
    } else {
      Object.defineProperty(globalThis, 'location', locationDescriptor);
    }
  }
});

describe('FetchAdapter - joining body chunks', () => {
  /** A `fetch` answering with a stream of `chunks`, read under a response limit. */
  async function readChunks(chunks: Uint8Array[]): Promise<Uint8Array> {
    (globalThis as any).fetch = () =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              for (const chunk of chunks) {
                controller.enqueue(chunk);
              }
              controller.close();
            },
          }),
          { status: 200 },
        ),
      );

    const response = await new FetchAdapter().send({
      requestURL: 'https://local.test/data',
      method: 'GET',
      headers: {},
      maxResponseBytes: 100,
    });

    return response.body as Uint8Array;
  }

  test('a lone chunk, whatever its buffer, is copied into a plain array of its own', async () => {
    const shared = new Uint8Array([9, 1, 2, 3, 9]);
    for (const chunk of [
      new Uint8Array([1, 2, 3]),
      shared.subarray(1, 4),
      Buffer.from([1, 2, 3]),
    ]) {
      const body = await readChunks([chunk]);

      expect(body).not.toBe(chunk);
      expect(Object.getPrototypeOf(body)).toBe(Uint8Array.prototype);
      expect(body.buffer.byteLength).toBe(3);
      expect([...body]).toEqual([1, 2, 3]);
    }
  });

  test('several chunks are joined in order', async () => {
    const body = await readChunks([
      new Uint8Array([1, 2]),
      new Uint8Array([3]),
      new Uint8Array([4, 5]),
    ]);

    expect([...body]).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('FetchAdapter - body chunk types and sizes', () => {
  /** A `fetch` answering with a web stream of `chunks`, read under `maxResponseBytes`. */
  async function sendStreamed(chunks: unknown[], maxResponseBytes: number) {
    let isCancelled = false;
    (globalThis as any).fetch = () =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              for (const chunk of chunks) {
                controller.enqueue(chunk);
              }
              controller.close();
            },
            cancel() {
              isCancelled = true;
            },
          }),
          { status: 200 },
        ),
      );

    const response = await new FetchAdapter().send({
      requestURL: 'https://local.test/data',
      method: 'GET',
      headers: {},
      maxResponseBytes,
    });

    return { response, isCancelled };
  }

  test('empty chunks answered from microtasks alone yield to timers', async () => {
    // Capped, so a read that starves the timer ends rather than hanging the run.
    const readCap = 100_000;
    let reads = 0;
    let didTimerFire = false;
    setTimeout(() => {
      didTimerFire = true;
    }, 0);

    (globalThis as any).fetch = () => {
      const response = new Response('', { status: 200 });
      Object.defineProperty(response, 'body', {
        value: {
          getReader: () => ({
            read: () => {
              reads++;
              return Promise.resolve(
                didTimerFire || reads >= readCap
                  ? { done: true, value: undefined }
                  : { done: false, value: new Uint8Array(0) },
              );
            },
            cancel: () => Promise.resolve(),
          }),
        },
      });
      return Promise.resolve(response);
    };

    const response = await new FetchAdapter().send({
      requestURL: 'https://local.test/data',
      method: 'GET',
      headers: {},
      maxResponseBytes: 10,
    });

    expect(didTimerFire).toBe(true);
    expect(reads).toBeLessThan(readCap);
    expect(response.isStreamError).toBeUndefined();
    expect(response.body?.length).toBe(0);
  });

  test('empty chunks yield to timers once every so many, not after each one', async () => {
    const emptyChunks = 640;
    let reads = 0;
    let timers = 0;

    (globalThis as any).fetch = () => {
      const response = new Response('', { status: 200 });
      Object.defineProperty(response, 'body', {
        value: {
          getReader: () => ({
            read: () => {
              reads++;
              return Promise.resolve(
                reads > emptyChunks
                  ? { done: true, value: undefined }
                  : { done: false, value: new Uint8Array(0) },
              );
            },
            cancel: () => Promise.resolve(),
          }),
        },
      });
      return Promise.resolve(response);
    };

    // A browser holds a timer set from a timer's callback to at least 4 ms past a few
    // levels, so each wait counts.
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
      timers++;
      return originalSetTimeout(...args);
    }) as typeof setTimeout;

    try {
      await new FetchAdapter().send({
        requestURL: 'https://local.test/data',
        method: 'GET',
        headers: {},
        maxResponseBytes: 10,
      });
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }

    // Some waits, so timers still run - but far fewer than one per chunk.
    expect(timers).toBeGreaterThan(0);
    expect(timers).toBeLessThan(emptyChunks / 8);
  });

  test('empty chunks between bytes still yield to timers', async () => {
    let reads = 0;
    let timers = 0;

    // Runs of empty chunks, each ended by a byte, from microtasks alone.
    (globalThis as any).fetch = () => {
      const response = new Response('', { status: 200 });
      Object.defineProperty(response, 'body', {
        value: {
          getReader: () => ({
            read: () => {
              reads++;
              if (reads > 6_400) {
                return Promise.resolve({ done: true, value: undefined });
              }
              return Promise.resolve({
                done: false,
                value: new Uint8Array(reads % 32 === 0 ? 1 : 0),
              });
            },
            cancel: () => Promise.resolve(),
          }),
        },
      });
      return Promise.resolve(response);
    };

    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
      timers++;
      return originalSetTimeout(...args);
    }) as typeof setTimeout;

    try {
      await new FetchAdapter().send({
        requestURL: 'https://local.test/data',
        method: 'GET',
        headers: {},
        maxResponseBytes: 1_000,
      });
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }

    expect(timers).toBeGreaterThan(0);
  });

  test.each([
    ['chunks that ignore it', false],
    ['a read that stalls until cancelled', true],
  ] as const)(
    'an abort ends a read of %s and lets the stream go',
    async (_name, doesStall) => {
      const controller = new AbortController();
      let reads = 0;
      let cancels = 0;
      let endStalledRead = (): void => {};

      (globalThis as any).fetch = () => {
        const response = new Response('', { status: 200 });
        Object.defineProperty(response, 'body', {
          value: {
            getReader: () => ({
              read: () => {
                reads++;

                if (doesStall && reads === 2) {
                  setTimeout(() => {
                    controller.abort();
                  }, 0);

                  return new Promise((resolve) => {
                    endStalledRead = () => {
                      resolve({ done: true, value: undefined });
                    };
                  });
                }

                if (reads === 2) {
                  controller.abort();
                }

                return Promise.resolve({
                  done: false,
                  value: new Uint8Array(1),
                });
              },
              cancel: () => {
                cancels++;
                endStalledRead();
                return Promise.resolve();
              },
            }),
          },
        });
        return Promise.resolve(response);
      };

      let failure: any;
      try {
        await new FetchAdapter().send({
          requestURL: 'https://local.test/data',
          method: 'GET',
          headers: {},
          maxResponseBytes: 100,
          signal: controller.signal,
        });
      } catch (error) {
        failure = error;
      }

      expect(failure?.name).toBe('AbortError');
      expect(cancels).toBe(1);
      expect(reads).toBe(2);
    },
  );

  test.each([Number.POSITIVE_INFINITY, 1000])(
    'an abort lets go of a body being read whole, with a limit of %d',
    async (maxResponseBytes) => {
      const controller = new AbortController();
      let cancels = 0;
      let failRead = (_error: Error): void => {};

      (globalThis as any).fetch = () => {
        const response = new Response('', { status: 200 });
        Object.defineProperty(response, 'body', {
          value: {
            cancel: () => {
              cancels++;
              failRead(new Error('body destroyed'));
              return Promise.resolve();
            },
          },
        });
        Object.defineProperty(response, 'arrayBuffer', {
          value: () =>
            new Promise((_resolve, reject) => {
              failRead = reject;
              setTimeout(() => {
                controller.abort();
              }, 0);
            }),
        });
        return Promise.resolve(response);
      };

      const failure = await new FetchAdapter()
        .send({
          requestURL: 'https://local.test/data',
          method: 'GET',
          headers: {},
          maxResponseBytes,
          signal: controller.signal,
        })
        .catch((error: unknown) => error);

      expect(cancels).toBe(1);
      expect((failure as Error).message).toBe('body destroyed');
    },
  );

  test.each([Number.POSITIVE_INFINITY, 1000])(
    'a cancel that ends a body read whole as if finished is the abort, not a short body, with a limit of %d',
    async (maxResponseBytes) => {
      const controller = new AbortController();
      let finishRead = (): void => {};

      (globalThis as any).fetch = () => {
        const response = new Response('', { status: 200 });
        Object.defineProperty(response, 'body', {
          value: {
            cancel: () => {
              finishRead();
              return Promise.resolve();
            },
          },
        });
        Object.defineProperty(response, 'arrayBuffer', {
          value: () =>
            new Promise((resolve) => {
              finishRead = () => {
                resolve(new Uint8Array([1, 2, 3]).buffer);
              };
              setTimeout(() => {
                controller.abort();
              }, 0);
            }),
        });
        return Promise.resolve(response);
      };

      const outcome = await new FetchAdapter()
        .send({
          requestURL: 'https://local.test/data',
          method: 'GET',
          headers: {},
          maxResponseBytes,
          signal: controller.signal,
        })
        .then(
          () => 'resolved',
          (error: unknown) => (error as Error).name,
        );

      expect(outcome).toBe('AbortError');
    },
  );

  test.each(['type', 'status', 'headers'])(
    'a response whose %s cannot be read is refused as non-retryable',
    async (member) => {
      (globalThis as any).fetch = () => {
        const response = new Response('ok', { status: 200 });
        Object.defineProperty(response, member, {
          get(): never {
            throw new Error('unreadable');
          },
        });
        return Promise.resolve(response);
      };

      const outcome = (await new FetchAdapter()
        .send({
          requestURL: 'https://local.test/data',
          method: 'GET',
          headers: {},
        })
        .catch((error: unknown) => error)) as Record<string, unknown>;

      expect(outcome[NON_RETRYABLE_HTTP_ADAPTER_ERROR_FLAG]).toBe(true);
    },
  );

  test('an answered response is read once, so a getter cannot change the answer', async () => {
    const reads: Record<string, number> = { type: 0, status: 0, headers: 0 };
    const headers = new Headers({ 'content-length': '2' });

    (globalThis as any).fetch = () => {
      const response = new Response('ok', { status: 200 });
      Object.defineProperties(response, {
        type: { get: () => (reads.type++, 'basic') },
        status: { get: () => (reads.status++ === 0 ? 200 : 204) },
        headers: { get: () => (reads.headers++, headers) },
      });
      return Promise.resolve(response);
    };

    const response = await new FetchAdapter().send({
      requestURL: 'https://local.test/data',
      method: 'GET',
      headers: {},
      maxResponseBytes: 1000,
    });

    expect(response.status).toBe(200);
    expect(new TextDecoder().decode(response.body as Uint8Array)).toBe('ok');
    expect(reads).toEqual({ type: 1, status: 1, headers: 1 });
  });

  test('a refused response lets its body go', async () => {
    let cancels = 0;

    (globalThis as any).fetch = () => {
      const response = new Response('ok', { status: 200 });
      Object.defineProperties(response, {
        headers: {
          get(): never {
            throw new Error('unreadable');
          },
        },
        body: {
          value: {
            cancel: () => {
              cancels++;
              return Promise.resolve();
            },
          },
        },
      });
      return Promise.resolve(response);
    };

    await new FetchAdapter()
      .send({
        requestURL: 'https://local.test/data',
        method: 'GET',
        headers: {},
      })
      .catch(() => {});

    expect(cancels).toBe(1);
  });

  test('a refused response still ends the upload with its final event', async () => {
    const uploads: number[] = [];

    (globalThis as any).fetch = () => {
      const response = new Response('ok', { status: 200 });
      Object.defineProperty(response, 'headers', {
        get(): never {
          throw new Error('unreadable');
        },
      });
      return Promise.resolve(response);
    };

    await new FetchAdapter()
      .send({
        requestURL: 'https://local.test/data',
        method: 'POST',
        headers: {},
        body: 'abc',
        onUploadProgress: (event) => {
          uploads.push(event.progress);
        },
      })
      .catch(() => {});

    expect(uploads).toEqual([0, 1]);
  });

  test('a response read that throws over an abort stays the abort', async () => {
    const controller = new AbortController();

    (globalThis as any).fetch = () => {
      const response = new Response('ok', { status: 200 });
      Object.defineProperty(response, 'headers', {
        get(): never {
          controller.abort();
          throw new Error('unreadable');
        },
      });
      return Promise.resolve(response);
    };

    const outcome = (await new FetchAdapter()
      .send({
        requestURL: 'https://local.test/data',
        method: 'GET',
        headers: {},
        signal: controller.signal,
      })
      .catch((error: unknown) => error)) as Error;

    expect(outcome.name).toBe('AbortError');
  });

  test('an opaque redirect answers without its status being read', async () => {
    (globalThis as any).fetch = () => {
      const response = new Response('', { status: 200 });
      Object.defineProperties(response, {
        type: { value: 'opaqueredirect' },
        status: {
          get(): never {
            throw new Error('unreadable');
          },
        },
      });
      return Promise.resolve(response);
    };

    const response = await new FetchAdapter().send({
      requestURL: 'https://local.test/data',
      method: 'GET',
      headers: {},
    });

    expect(response.wasRedirectDetected).toBe(true);
  });

  test('a function-style polyfill error keeps its certificate code through the wrapping', async () => {
    function FetchError(this: { code: string; message: string }) {
      Error.call(this as never);
      this.message = 'request failed';
      this.code = 'CRL_HAS_EXPIRED';
    }
    FetchError.prototype = Object.create(Error.prototype);

    (globalThis as any).fetch = () =>
      Promise.reject(new (FetchError as unknown as new () => Error)());

    const response = await new FetchAdapter().send({
      requestURL: 'https://local.test/data',
      method: 'GET',
      headers: {},
    });

    expect(response.status).toBe(495);
    expect(response.isRetryable).toBe(false);
  });

  test('a timeout ends a read of endless empty chunks, keeps the status and lets the stream go', async () => {
    let reads = 0;
    let cancels = 0;

    (globalThis as any).fetch = () => {
      const response = new Response('', { status: 200 });
      Object.defineProperty(response, 'body', {
        value: {
          getReader: () => ({
            read: () => {
              reads++;
              return Promise.resolve({
                done: false,
                value: new Uint8Array(0),
              });
            },
            cancel: () => {
              cancels++;
              return Promise.resolve();
            },
          }),
        },
      });
      return Promise.resolve(response);
    };

    const client = new HTTPClient({
      adapter: new FetchAdapter(),
      baseURL: 'https://local.test',
      timeout: 30,
      maxResponseBytes: 10,
    });
    const response = await client.get('/data').retryPolicy(null).send();
    const readsAtSettle = reads;
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(response.status).toBe(200);
    expect(response.isTimeout).toBe(true);
    expect(cancels).toBe(1);
    expect(reads).toBe(readsAtSettle);
  });

  test('a chunk that is not a Uint8Array fails the body read as arrayBuffer() does, not as zeros', async () => {
    // How the unlimited path fails for the same stream where `arrayBuffer()` follows the
    // Fetch standard (Node's undici, browsers): it rejects with a `TypeError`.
    (globalThis as any).fetch = () => {
      const response = new Response('', { status: 200 });
      Object.defineProperty(response, 'arrayBuffer', {
        value: () =>
          Promise.reject(new TypeError('Received non-Uint8Array chunk')),
      });
      return Promise.resolve(response);
    };
    const unlimited = await new FetchAdapter().send({
      requestURL: 'https://local.test/data',
      method: 'GET',
      headers: {},
    });

    expect(unlimited.isStreamError).toBe(true);
    expect(unlimited.streamErrorCode).toBe('stream_response_error');
    expect(unlimited.errorCause).toBeInstanceOf(TypeError);

    for (const chunk of [
      new Uint8Array([1, 2, 3]).buffer,
      new DataView(new Uint8Array([1, 2, 3]).buffer),
      new Uint16Array([1, 2]),
      'abc',
      { byteLength: 3 },
    ]) {
      // A chunk after it, so the stream is still open to be let go of.
      const { response, isCancelled } = await sendStreamed(
        [new Uint8Array([9]), chunk, new Uint8Array([9])],
        100,
      );

      expect(response.status).toBe(200);
      expect(response.body).toBeNull();
      expect(response.isStreamError).toBe(true);
      expect(response.streamErrorCode).toBe(unlimited.streamErrorCode);
      expect(response.errorCause).toBeInstanceOf(TypeError);
      expect(isCancelled).toBe(true);
    }
  });

  test('a chunk over a detached or shrunk-away buffer fails the body read, not reads it short', async () => {
    const detached = new Uint8Array(new ArrayBuffer(4));
    structuredClone(detached.buffer, { transfer: [detached.buffer] });
    const resizable = new (ArrayBuffer as any)(8, { maxByteLength: 8 });
    const shrunkAway = new Uint8Array(resizable, 4, 4);
    resizable.resize(2);

    for (const chunk of [detached, shrunkAway]) {
      const { response, isCancelled } = await sendStreamed(
        [new Uint8Array([9]), chunk, new Uint8Array([9])],
        100,
      );

      expect(response.status).toBe(200);
      expect(response.body).toBeNull();
      expect(response.isStreamError).toBe(true);
      expect(response.streamErrorCode).toBe('stream_response_error');
      expect(response.errorCause).toBeInstanceOf(TypeError);
      expect(isCancelled).toBe(true);
    }

    // An empty chunk that is in bounds is still no bytes, not an error.
    const { response } = await sendStreamed(
      [new Uint8Array([9]), new Uint8Array(0), new Uint8Array([8])],
      100,
    );
    expect(response.isStreamError).toBeFalsy();
    expect(Array.from(response.body as Uint8Array)).toEqual([9, 8]);
  });

  test('a chunk is counted by the bytes it holds, not the byteLength it reports', async () => {
    class Understated extends Uint8Array {
      public override get byteLength(): number {
        return 0;
      }
    }

    const { response } = await sendStreamed([new Understated(200)], 100);

    expect(response.streamErrorCode).toBe('response_too_large');

    const joined = await sendStreamed(
      [new Understated([1, 2]), new Uint8Array([3])],
      100,
    );

    expect([...(joined.response.body as Uint8Array)]).toEqual([1, 2, 3]);
  });

  /** A `fetch` whose one chunk spans a resizable buffer resized to `newLength` once read. */
  async function sendResized(byteLength: number, newLength: number) {
    const buffer = new ArrayBuffer(byteLength, {
      maxByteLength: byteLength * 2,
    });
    const chunk = new Uint8Array(buffer);
    chunk.fill(7);
    let pulls = 0;
    (globalThis as any).fetch = () =>
      Promise.resolve(
        new Response(
          new ReadableStream(
            {
              pull(controller) {
                pulls++;

                if (pulls === 1) {
                  controller.enqueue(chunk);
                } else {
                  buffer.resize(newLength);
                  controller.close();
                }
              },
            },
            // Pulled only when read: the chunk is counted before it is resized.
            { highWaterMark: 0 },
          ),
          { status: 200 },
        ),
      );

    return new FetchAdapter().send({
      requestURL: 'https://local.test/data',
      method: 'GET',
      headers: {},
      maxResponseBytes: byteLength * 4,
    });
  }

  test.each([
    ['under 4 KiB', 'grows', 3, 5],
    ['under 4 KiB', 'shrinks', 3, 1],
    ['of 4 KiB or more', 'grows', 20_000, 40_000],
    ['of 4 KiB or more', 'shrinks', 20_000, 1],
  ])(
    'a chunk %s whose resizable buffer %s after it is read keeps the bytes it held when read',
    async (_size, _label, byteLength, newLength) => {
      const response = await sendResized(byteLength, newLength);

      expect(response.status).toBe(200);
      expect(response.isStreamError).toBeUndefined();
      const body = response.body as Uint8Array;
      expect(body.length).toBe(byteLength);
      expect(body.every((byte) => byte === 7)).toBe(true);
    },
  );

  test('a Uint8Array chunk from another realm is read as one', async () => {
    const { runInNewContext } = await import('node:vm');
    const foreign = runInNewContext('new Uint8Array([4, 5, 6])') as Uint8Array;
    const { response } = await sendStreamed([foreign], 100);

    expect([...(response.body as Uint8Array)]).toEqual([4, 5, 6]);
  });

  test.each([
    ['HEAD', 200],
    ['GET', 304],
    ['GET', 204],
  ] as const)(
    "a polyfilled fetch's Readable is released on a bodiless answer: %s %i",
    async (method, status) => {
      const { Readable } = await import('node:stream');
      const body = Readable.from(['unread']);
      (globalThis as any).fetch = () =>
        Promise.resolve({
          status,
          type: 'basic',
          headers: new Headers(),
          body,
        });

      const response = await new FetchAdapter().send({
        requestURL: 'https://local.test/data',
        method,
        headers: {},
        maxResponseBytes: 100,
      });

      expect(response.body).toBeNull();
      expect(body.destroyed).toBe(true);
    },
  );

  test("a polyfilled fetch's Readable that yields text is still read as its UTF-8 bytes", async () => {
    const { Readable } = await import('node:stream');
    (globalThis as any).fetch = () =>
      Promise.resolve({
        status: 200,
        type: 'basic',
        headers: new Headers(),
        body: Readable.from(['hé', 'llo']),
        arrayBuffer: () => Promise.reject(new Error('not read whole')),
      });

    const response = await new FetchAdapter().send({
      requestURL: 'https://local.test/data',
      method: 'GET',
      headers: {},
      maxResponseBytes: 100,
    });

    expect(decoder.decode(response.body as Uint8Array)).toBe('héllo');
  });

  test('a body whose iterator cannot be had leaves no listener on the signal', async () => {
    const controller = new AbortController();
    let listeners = 0;
    const add = controller.signal.addEventListener.bind(controller.signal);
    const remove = controller.signal.removeEventListener.bind(
      controller.signal,
    );
    controller.signal.addEventListener = ((...args: Parameters<typeof add>) => {
      listeners++;
      add(...args);
    }) as typeof add;
    controller.signal.removeEventListener = ((
      ...args: Parameters<typeof remove>
    ) => {
      listeners--;
      remove(...args);
    }) as typeof remove;

    (globalThis as any).fetch = () =>
      Promise.resolve({
        status: 200,
        type: 'basic',
        headers: new Headers(),
        body: {
          [Symbol.asyncIterator]: () => {
            throw new TypeError('no iterator');
          },
        },
        arrayBuffer: () => Promise.reject(new Error('not read whole')),
      });

    const answer = await new FetchAdapter().send({
      requestURL: 'https://local.test/data',
      method: 'GET',
      headers: {},
      maxResponseBytes: 10,
      signal: controller.signal,
    });

    expect(answer.isStreamError).toBe(true);
    expect(listeners).toBe(0);
  });

  test("an iterated body left early settles without waiting on the iterator's return()", async () => {
    // A polyfill's iterator whose `return()` never settles: past the limit, or aborted
    // as a chunk arrives, the send still answers at once, and asks it to return.
    const controller = new AbortController();
    let returnCalls = 0;
    const body = (yieldChunk: () => void) => ({
      [Symbol.asyncIterator]: () => ({
        next: () => {
          yieldChunk();
          return Promise.resolve({
            done: false,
            value: new Uint8Array([1, 2]),
          });
        },
        return: () => {
          returnCalls++;
          return new Promise<never>(() => {});
        },
      }),
    });
    const send = (yieldChunk: () => void, signal?: AbortSignal) => {
      (globalThis as any).fetch = () =>
        Promise.resolve({
          status: 200,
          type: 'basic',
          headers: new Headers(),
          body: body(yieldChunk),
          arrayBuffer: () => Promise.reject(new Error('not read whole')),
        });

      return new FetchAdapter().send({
        requestURL: 'https://local.test/data',
        method: 'GET',
        headers: {},
        maxResponseBytes: 1,
        ...(signal ? { signal } : {}),
      });
    };
    // Only to tell a hang from an answer: an answer arrives before it either way.
    const settles = <T>(promise: Promise<T>) =>
      Promise.race([
        promise.then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        ),
        new Promise<'hung'>((resolve) =>
          setTimeout(() => resolve('hung'), 2000),
        ),
      ]);

    const tooLarge = await settles(send(() => {}));
    expect(tooLarge).not.toBe('hung');
    expect(
      (tooLarge as { value: { streamErrorCode?: string } }).value
        .streamErrorCode,
    ).toBe('response_too_large');

    const aborted = await settles(
      send(() => controller.abort(), controller.signal),
    );
    expect(aborted).not.toBe('hung');
    expect((aborted as { error: Error }).error.name).toBe('AbortError');
    expect(returnCalls).toBe(2);
  });

  test('an abort while an iterated body read is stalled settles the send and asks the iterator to return()', async () => {
    // A polyfill's body whose `next()` never settles once started, with no `cancel` or a
    // `cancel` that does not end the read: the abort alone must end the wait.
    for (const hasCancel of [false, true]) {
      const controller = new AbortController();
      let returnCalls = 0;
      let cancelCalls = 0;
      let nextStarted: () => void = () => {};
      const started = new Promise<void>((resolve) => {
        nextStarted = resolve;
      });
      const body = {
        [Symbol.asyncIterator]: () => ({
          next: () => {
            nextStarted();
            return new Promise<never>(() => {});
          },
          return: () => {
            returnCalls++;
            return Promise.resolve({ done: true, value: undefined });
          },
        }),
        ...(hasCancel
          ? {
              cancel: () => {
                cancelCalls++;
              },
            }
          : {}),
      };
      (globalThis as any).fetch = () =>
        Promise.resolve({
          status: 200,
          type: 'basic',
          headers: new Headers(),
          body,
          arrayBuffer: () => Promise.reject(new Error('not read whole')),
        });

      const sent = new FetchAdapter()
        .send({
          requestURL: 'https://local.test/data',
          method: 'GET',
          headers: {},
          maxResponseBytes: 100,
          signal: controller.signal,
        })
        .then(
          () => 'answered',
          (error: unknown) => (error as Error).name,
        );

      await started;
      controller.abort();

      // Only to tell a hang from an answer: an answer arrives before it either way.
      const outcome = await Promise.race([
        sent,
        new Promise<'hung'>((resolve) =>
          setTimeout(() => resolve('hung'), 2000),
        ),
      ]);

      expect({ hasCancel, outcome, returnCalls, cancelCalls }).toEqual({
        hasCancel,
        outcome: 'AbortError',
        returnCalls: 1,
        cancelCalls: hasCancel ? 1 : 0,
      });
    }
  });

  test('an abort from within an iterated body read settles the send and asks the iterator to return()', async () => {
    // A polyfill's `next()` that aborts the signal itself, then never settles: the abort
    // lands before the wait on that `next()` has begun.
    const controller = new AbortController();
    let returnCalls = 0;
    const body = {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          controller.abort();
          return new Promise<never>(() => {});
        },
        return: () => {
          returnCalls++;
          return Promise.resolve({ done: true, value: undefined });
        },
      }),
      destroy: () => {},
    };
    (globalThis as any).fetch = () =>
      Promise.resolve({
        status: 200,
        type: 'basic',
        headers: new Headers(),
        body,
        arrayBuffer: () => Promise.reject(new Error('not read whole')),
      });

    const sent = new FetchAdapter()
      .send({
        requestURL: 'https://local.test/data',
        method: 'GET',
        headers: {},
        maxResponseBytes: 100,
        signal: controller.signal,
      })
      .then(
        () => 'answered',
        (error: unknown) => (error as Error).name,
      );

    // Only to tell a hang from an answer: an answer arrives before it either way.
    const outcome = await Promise.race([
      sent,
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 2000)),
    ]);

    expect({ outcome, returnCalls }).toEqual({
      outcome: 'AbortError',
      returnCalls: 1,
    });
  });

  test.each([
    ['an iterable', 100, [0x41, 0x42, 0x43]],
    ['an iterable', 4096, [0x43, 0x43, 0x43]],
    ['a web stream', 100, [0x41, 0x42, 0x43]],
    ['a web stream', 4096, [0x43, 0x43, 0x43]],
  ])(
    '%s body that refills one buffer of %i bytes for each chunk is read as %j',
    async (source, chunkBytes, expected) => {
      // A small chunk is copied as it is read; one of 4 KiB or more that is all of its
      // buffer is kept as it is, so it is read as the buffer's last fill.
      const shared = new Uint8Array(chunkBytes);
      const fills = [0x41, 0x42, 0x43];
      let body: unknown;

      if (source === 'an iterable') {
        body = {
          async *[Symbol.asyncIterator]() {
            for (const byte of fills) {
              await Promise.resolve();
              shared.fill(byte);
              yield shared;
            }
          },
        };
      } else {
        let pulls = 0;
        body = new ReadableStream(
          {
            pull(controller) {
              if (pulls === fills.length) {
                controller.close();
                return;
              }

              shared.fill(fills[pulls++]);
              controller.enqueue(shared);
            },
          },
          // Pulled only when read: each fill is read before the next.
          { highWaterMark: 0 },
        );
      }

      (globalThis as any).fetch = () =>
        Promise.resolve({
          status: 200,
          type: 'basic',
          headers: new Headers(),
          body,
          arrayBuffer: () => Promise.reject(new Error('not read whole')),
        });

      const response = await new FetchAdapter().send({
        requestURL: 'https://local.test/data',
        method: 'GET',
        headers: {},
        maxResponseBytes: 1_000_000,
      });

      const read = response.body as Uint8Array;
      expect(read.length).toBe(3 * chunkBytes);
      expect([read[0], read[chunkBytes], read[2 * chunkBytes]]).toEqual(
        expected,
      );
    },
  );

  test('a text chunk whose UTF-16 units are exactly the bytes the limit has left is read', async () => {
    (globalThis as any).fetch = () =>
      Promise.resolve({
        status: 200,
        type: 'basic',
        headers: new Headers(),
        body: {
          *[Symbol.asyncIterator]() {
            yield 'a'.repeat(600);
            yield 'b'.repeat(400);
          },
        },
        arrayBuffer: () => Promise.reject(new Error('not read whole')),
      });

    const response = await new FetchAdapter().send({
      requestURL: 'https://local.test/data',
      method: 'GET',
      headers: {},
      maxResponseBytes: 1000,
    });

    expect(response.streamErrorCode).toBeUndefined();
    expect((response.body as Uint8Array).length).toBe(1000);
  });

  test('a text chunk with more UTF-16 units than the limit has bytes left is refused before it is encoded', async () => {
    (globalThis as any).fetch = () =>
      Promise.resolve({
        status: 200,
        type: 'basic',
        headers: new Headers(),
        body: {
          *[Symbol.asyncIterator]() {
            yield 'a'.repeat(600);
            yield 'b'.repeat(1_000_000);
          },
        },
        arrayBuffer: () => Promise.reject(new Error('not read whole')),
      });
    const encode = spyOn(TextEncoder.prototype, 'encode');

    try {
      const response = await new FetchAdapter().send({
        requestURL: 'https://local.test/data',
        method: 'GET',
        headers: {},
        maxResponseBytes: 1000,
      });

      expect(response.streamErrorCode).toBe('response_too_large');
      expect(encode.mock.calls.map(([text]) => text?.length)).toEqual([600]);
    } finally {
      encode.mockRestore();
    }
  });

  test('a text chunk within the limit by its UTF-16 units but past it as UTF-8 is refused before it is encoded', async () => {
    (globalThis as any).fetch = () =>
      Promise.resolve({
        status: 200,
        type: 'basic',
        headers: new Headers(),
        body: {
          *[Symbol.asyncIterator]() {
            yield 'a'.repeat(600);
            // 300 units, within the 400 bytes left; 900 bytes as UTF-8.
            yield '\u20ac'.repeat(300);
          },
        },
        arrayBuffer: () => Promise.reject(new Error('not read whole')),
      });
    const encode = spyOn(TextEncoder.prototype, 'encode');

    try {
      const response = await new FetchAdapter().send({
        requestURL: 'https://local.test/data',
        method: 'GET',
        headers: {},
        maxResponseBytes: 1000,
      });

      expect(response.streamErrorCode).toBe('response_too_large');
      expect(encode.mock.calls.map(([text]) => text?.length)).toEqual([600]);
    } finally {
      encode.mockRestore();
    }
  });

  test('a text chunk that is only a held high surrogate is not counted as an empty chunk', async () => {
    const pairs = 128;
    (globalThis as any).fetch = () =>
      Promise.resolve({
        status: 200,
        type: 'basic',
        headers: new Headers(),
        body: {
          *[Symbol.asyncIterator]() {
            for (let index = 0; index < pairs; index++) {
              yield '\uD83D';
              yield '\uDE00';
            }
          },
        },
        arrayBuffer: () => Promise.reject(new Error('not read whole')),
      });
    const timers = spyOn(globalThis, 'setTimeout');

    try {
      timers.mockClear();
      const response = await new FetchAdapter().send({
        requestURL: 'https://local.test/data',
        method: 'GET',
        headers: {},
        maxResponseBytes: 1000,
      });

      expect((response.body as Uint8Array).length).toBe(pairs * 4);
      // No yield for empty chunks: every chunk carried text.
      expect(timers.mock.calls.filter(([, delay]) => delay === 0)).toHaveLength(
        0,
      );
    } finally {
      timers.mockRestore();
    }
  });

  test('empty text chunks after a held high surrogate still count toward a yield', async () => {
    (globalThis as any).fetch = () =>
      Promise.resolve({
        status: 200,
        type: 'basic',
        headers: new Headers(),
        body: {
          *[Symbol.asyncIterator]() {
            yield '\uD83D';
            for (let index = 0; index < 256; index++) {
              yield '';
            }
          },
        },
        arrayBuffer: () => Promise.reject(new Error('not read whole')),
      });
    const timers = spyOn(globalThis, 'setTimeout');

    try {
      timers.mockClear();
      const response = await new FetchAdapter().send({
        requestURL: 'https://local.test/data',
        method: 'GET',
        headers: {},
        maxResponseBytes: 1000,
      });

      // The held half, unpaired, is U+FFFD.
      expect([...(response.body as Uint8Array)]).toEqual([0xef, 0xbf, 0xbd]);
      expect(
        timers.mock.calls.filter(([, delay]) => delay === 0).length,
      ).toBeGreaterThan(0);
    } finally {
      timers.mockRestore();
    }
  });

  test('a surrogate pair split across two text chunks is read as the one character it is', async () => {
    /** The body of an iterable yielding `chunks`, read under `maxResponseBytes`. */
    async function read(chunks: unknown[], maxResponseBytes: number) {
      (globalThis as any).fetch = () =>
        Promise.resolve({
          status: 200,
          type: 'basic',
          headers: new Headers(),
          body: {
            *[Symbol.asyncIterator]() {
              yield* chunks;
            },
          },
          arrayBuffer: () => Promise.reject(new Error('not read whole')),
        });

      const response = await new FetchAdapter().send({
        requestURL: 'https://local.test/data',
        method: 'GET',
        headers: {},
        maxResponseBytes,
      });

      return response.streamErrorCode ?? [...(response.body ?? [])];
    }

    // U+1F600, four bytes, as joined text encodes it: not refused at four.
    expect(await read(['\uD83D', '\uDE00'], 4)).toEqual([
      0xf0, 0x9f, 0x98, 0x80,
    ]);
    expect(await read(['a\uD83D', '\uDE00b'], 100)).toEqual([
      0x61, 0xf0, 0x9f, 0x98, 0x80, 0x62,
    ]);
    // A half with nothing to pair with is U+FFFD, as joined text encodes it: at the end,
    // and before a chunk of bytes.
    expect(await read(['a\uD83D'], 100)).toEqual([0x61, 0xef, 0xbf, 0xbd]);
    expect(await read(['\uD83D', new Uint8Array([1])], 100)).toEqual([
      0xef, 0xbf, 0xbd, 1,
    ]);
    expect(await read(['\uD83D', 'x'], 100)).toEqual([0xef, 0xbf, 0xbd, 0x78]);
  });

  test('a body whose iterator fails is let go of', async () => {
    const shapes: Array<[string, () => AsyncIterator<unknown>]> = [
      [
        'asyncIterator() throws',
        () => {
          throw new Error('no iterator');
        },
      ],
      [
        'next() answers a non-object',
        () =>
          ({
            next: () => Promise.resolve(5),
          }) as unknown as AsyncIterator<unknown>,
      ],
      [
        'next() rejects',
        () => ({
          next: () => Promise.reject(new Error('read failed')),
        }),
      ],
    ];

    for (const [shape, iterate] of shapes) {
      let destroyCalls = 0;
      const body = {
        [Symbol.asyncIterator]: iterate,
        destroy: () => {
          destroyCalls++;
        },
      };
      (globalThis as any).fetch = () =>
        Promise.resolve({
          status: 200,
          type: 'basic',
          headers: new Headers(),
          body,
          arrayBuffer: () => Promise.reject(new Error('not read whole')),
        });

      await new FetchAdapter()
        .send({
          requestURL: 'https://local.test/data',
          method: 'GET',
          headers: {},
          maxResponseBytes: 100,
        })
        .catch(() => {});

      expect({ shape, destroyCalls }).toEqual({ shape, destroyCalls: 1 });
    }
  });

  test('a body whose Symbol.asyncIterator throws when read is read whole through arrayBuffer()', async () => {
    const body = {
      get [Symbol.asyncIterator](): never {
        throw new TypeError('not iterable');
      },
    };
    (globalThis as any).fetch = () =>
      Promise.resolve({
        status: 200,
        type: 'basic',
        headers: new Headers(),
        body,
        arrayBuffer: () => Promise.resolve(new Uint8Array([7, 8]).buffer),
      });

    const response = await new FetchAdapter().send({
      requestURL: 'https://local.test/data',
      method: 'GET',
      headers: {},
      maxResponseBytes: 100,
    });

    expect([...(response.body as Uint8Array)]).toEqual([7, 8]);
  });

  test('a response whose body getter throws is read whole through arrayBuffer()', async () => {
    (globalThis as any).fetch = () =>
      Promise.resolve({
        status: 200,
        type: 'basic',
        headers: new Headers(),
        get body(): never {
          throw new TypeError('body unreadable');
        },
        arrayBuffer: () => Promise.resolve(new Uint8Array([7, 8]).buffer),
      });

    const response = await new FetchAdapter().send({
      requestURL: 'https://local.test/data',
      method: 'GET',
      headers: {},
      maxResponseBytes: 100,
    });

    expect([...(response.body as Uint8Array)]).toEqual([7, 8]);
  });

  test.each([
    ['a limit', 100],
    ['no limit', Number.POSITIVE_INFINITY],
  ])(
    'a body read whole under %s is read once, and that one is let go of on an abort',
    async (_name, maxResponseBytes) => {
      const controller = new AbortController();
      const bodies: Array<{ cancels: number }> = [];
      let finishRead = (): void => {};

      (globalThis as any).fetch = () =>
        Promise.resolve({
          status: 200,
          type: 'basic',
          headers: new Headers(),
          // A new body on every read, as a test double's getter may hand over.
          get body() {
            const body = {
              cancels: 0,
              cancel: () => {
                body.cancels++;
                finishRead();
                return Promise.resolve();
              },
            };
            bodies.push(body);
            return body;
          },
          arrayBuffer: () =>
            new Promise<ArrayBuffer>((resolve) => {
              finishRead = () => resolve(new ArrayBuffer(0));
            }),
        });

      const sending = new FetchAdapter()
        .send({
          requestURL: 'https://local.test/data',
          method: 'GET',
          headers: {},
          maxResponseBytes,
          signal: controller.signal,
        })
        .then(
          () => 'resolved',
          (error: unknown) => (error as Error).name,
        );

      await new Promise((resolve) => setTimeout(resolve, 0));
      controller.abort();

      expect(await sending).toBe('AbortError');
      expect(bodies.map(({ cancels }) => cancels)).toEqual([1]);
    },
  );

  test.each([
    ['Symbol.asyncIterator', Symbol.asyncIterator],
    ['getReader', 'getReader'],
  ] as const)(
    'a body whose %s getter answers once is read through the method it answered',
    async (_name, key) => {
      const { Readable } = await import('node:stream');
      const source =
        key === 'getReader'
          ? (new Response(new Uint8Array([1, 2, 3]))
              .body as ReadableStream<Uint8Array>)
          : Readable.from([new Uint8Array([1, 2, 3])]);
      const method = (source as any)[key] as () => unknown;
      let reads = 0;
      const body = {
        get [key](): unknown {
          reads++;
          if (reads > 1) {
            throw new TypeError('read again');
          }
          return (...args: unknown[]) => Reflect.apply(method, source, args);
        },
      };
      (globalThis as any).fetch = () =>
        Promise.resolve({
          status: 200,
          type: 'basic',
          headers: new Headers(),
          body,
          arrayBuffer: () => Promise.reject(new Error('not read whole')),
        });

      const response = await new FetchAdapter().send({
        requestURL: 'https://local.test/data',
        method: 'GET',
        headers: {},
        maxResponseBytes: 100,
      });

      expect([...(response.body as Uint8Array)]).toEqual([1, 2, 3]);
      expect(reads).toBe(1);
    },
  );
});

describe('FetchAdapter - a declared length over the limit', () => {
  const gzipped = Bun.gzipSync(new TextEncoder().encode('OK'));

  /** A `fetch` answering like an XHR-based polyfill: headers as XHR exposes them, no `body`. */
  function polyfillFetch(type: string | undefined, headers: HeadersInit) {
    (globalThis as any).fetch = () =>
      Promise.resolve({
        status: 200,
        ...(type === undefined ? {} : { type }),
        headers: new Headers(headers),
        // XHR hands over the body already decoded.
        arrayBuffer: () =>
          Promise.resolve(new TextEncoder().encode('OK').buffer),
      });
  }

  test.each([['default'], [undefined]])(
    'without a streamed body, a missing Content-Encoding is not taken as identity (type %p): the decoded body is measured',
    async (type) => {
      // A cross-origin server that exposes Content-Length but not Content-Encoding.
      polyfillFetch(type, { 'content-length': String(gzipped.byteLength) });

      const response = await new FetchAdapter().send({
        requestURL: 'https://other-origin.test/data',
        method: 'GET',
        headers: {},
        maxResponseBytes: 10,
      });

      expect(gzipped.byteLength).toBeGreaterThan(10);
      expect(response.streamErrorCode).toBeUndefined();
      expect(new TextDecoder().decode(response.body as Uint8Array)).toBe('OK');
    },
  );

  test('without a streamed body, a visible identity Content-Encoding still refuses it unread', async () => {
    let reads = 0;
    (globalThis as any).fetch = () =>
      Promise.resolve({
        status: 200,
        type: 'default',
        headers: new Headers({
          'content-length': '1000',
          'content-encoding': 'identity',
        }),
        arrayBuffer: () => {
          reads++;
          return Promise.resolve(new ArrayBuffer(1000));
        },
      });

    const response = await new FetchAdapter().send({
      requestURL: 'https://local.test/data',
      method: 'GET',
      headers: {},
      maxResponseBytes: 10,
    });

    expect(response.streamErrorCode).toBe('response_too_large');
    expect(reads).toBe(0);
  });

  test('a streamed body with no Content-Encoding is refused unread by its declared length', async () => {
    let reads = 0;
    (globalThis as any).fetch = () => {
      const response = new Response('x'.repeat(1000), {
        status: 200,
        headers: { 'content-length': '1000' },
      });
      Object.defineProperty(response, 'body', {
        value: {
          getReader() {
            reads++;
            throw new Error('not read');
          },
          cancel() {},
        },
      });
      return Promise.resolve(response);
    };

    const response = await new FetchAdapter().send({
      requestURL: 'https://local.test/data',
      method: 'GET',
      headers: {},
      maxResponseBytes: 10,
    });

    expect(response.streamErrorCode).toBe('response_too_large');
    expect(reads).toBe(0);
  });
});

describe('FetchAdapter - request body copy', () => {
  test("the bytes it is handed are copied by the runtime's fetch before send() returns, so a change made after it reaches nothing sent", async () => {
    const received: number[][] = [];
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: async (request) => {
        received.push([...new Uint8Array(await request.arrayBuffer())]);
        return new Response('ok');
      },
    });

    try {
      const body = new Uint8Array([1, 2, 3, 4]);
      const sending = new FetchAdapter().send({
        requestURL: `http://127.0.0.1:${server.port}/upload`,
        method: 'POST',
        headers: {},
        body,
      });
      // The client hands a built-in adapter the request's bytes uncopied, relying on this.
      body.fill(9);

      expect((await sending).status).toBe(200);
      expect(received).toEqual([[1, 2, 3, 4]]);
    } finally {
      await server.stop(true);
    }
  });
});

describe('FetchAdapter - body cancel() rejecting from another realm', () => {
  test("a body whose cancel() answers with another realm's rejecting promise leaves no unhandled rejection", async () => {
    const { runInNewContext } = await import('node:vm');
    let cancels = 0;
    (globalThis as any).fetch = () => {
      const response = new Response('x'.repeat(1000), {
        status: 200,
        headers: { 'content-length': '1000' },
      });
      // Refused by its declared length, so the body is let go of unread.
      Object.defineProperty(response, 'body', {
        value: {
          getReader() {
            throw new Error('not read');
          },
          cancel() {
            cancels++;
            return runInNewContext(
              'Promise.reject(new Error("cancel failed"))',
            ) as unknown;
          },
        },
      });
      return Promise.resolve(response);
    };

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const response = await new FetchAdapter().send({
        requestURL: 'https://local.test/data',
        method: 'GET',
        headers: {},
        maxResponseBytes: 10,
      });
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(response.streamErrorCode).toBe('response_too_large');
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }

    expect(cancels).toBe(1);
    expect(unhandled).toEqual([]);
  });
});

describe('FetchAdapter - reader cancel() that throws or returns nothing', () => {
  /** A `fetch` answering with a body whose reader yields `chunks` and cancels with `cancel`. */
  async function sendWithReader(chunks: unknown[], cancel: () => unknown) {
    let cancels = 0;
    (globalThis as any).fetch = () => {
      const response = new Response(null, { status: 200 });
      const pending = [...chunks];
      Object.defineProperty(response, 'body', {
        value: {
          getReader() {
            return {
              read() {
                return Promise.resolve(
                  pending.length > 0
                    ? { done: false, value: pending.shift() }
                    : { done: true, value: undefined },
                );
              },
              cancel() {
                cancels++;
                return cancel();
              },
            };
          },
        },
      });
      return Promise.resolve(response);
    };

    const response = await new FetchAdapter().send({
      requestURL: 'https://local.test/data',
      method: 'GET',
      headers: {},
      maxResponseBytes: 10,
    });

    return { response, cancels };
  }

  test("a body over the limit is refused as too large when its reader's cancel() answers with nothing or throws", async () => {
    for (const cancel of [
      () => undefined,
      () => {
        throw new Error('cancel failed');
      },
    ]) {
      const { response, cancels } = await sendWithReader(
        [new Uint8Array(8), new Uint8Array(8)],
        cancel,
      );

      expect(response.isStreamError).toBe(true);
      expect(response.streamErrorCode).toBe('response_too_large');
      expect(cancels).toBe(1);
    }
  });

  test("a chunk that is not a Uint8Array keeps its TypeError when the reader's cancel() throws", async () => {
    const { response, cancels } = await sendWithReader(['abc'], () => {
      throw new Error('cancel failed');
    });

    expect(response.isStreamError).toBe(true);
    expect(response.streamErrorCode).toBe('stream_response_error');
    expect(response.errorCause).toBeInstanceOf(TypeError);
    expect((response.errorCause as Error).message).toContain(
      'not a Uint8Array',
    );
    expect(cancels).toBe(1);
  });
});

describe('FetchAdapter - GET and HEAD bodies', () => {
  test('a GET or HEAD with any body, an empty string included, is refused as non-retryable before fetch or upload progress', async () => {
    let fetches = 0;
    (globalThis as any).fetch = () => {
      fetches++;
      return Promise.reject(
        new TypeError('Request with GET/HEAD method cannot have body.'),
      );
    };

    for (const [method, body] of [
      ['GET', ''],
      ['HEAD', 'payload'],
      ['get', new Uint8Array(1)],
    ] as const) {
      const uploadEvents: unknown[] = [];
      const outcome = await new FetchAdapter()
        .send({
          requestURL: 'https://local.test/data',
          method,
          headers: {},
          body,
          onUploadProgress: (event) => uploadEvents.push(event),
        })
        .then(
          () => undefined,
          (error: unknown) => error as Record<PropertyKey, unknown>,
        );

      expect(outcome).toBeInstanceOf(Error);
      expect(outcome?.[NON_RETRYABLE_HTTP_ADAPTER_ERROR_FLAG]).toBe(true);
      expect(String(outcome?.message)).toContain('with a body');
      expect(String(outcome?.message)).not.toContain('payload');
      expect(uploadEvents).toEqual([]);
    }

    expect(fetches).toBe(0);
  });
});

describe('FetchAdapter - a body that only fails to decode', () => {
  const failingBody = (error: Error): ReadableStream<Uint8Array> =>
    new ReadableStream({
      pull(controller) {
        controller.error(error);
      },
    });

  test.each([
    [
      "Node's, its cause coded by zlib",
      Object.assign(new TypeError('terminated'), {
        cause: Object.assign(new Error('incorrect header check'), {
          code: 'Z_DATA_ERROR',
        }),
      }),
      'gzip',
      true,
    ],
    [
      "Bun's, coded by its decoder",
      Object.assign(new TypeError('BrotliDecompressionError fetching'), {
        code: 'BrotliDecompressionError',
      }),
      'br',
      true,
    ],
    [
      'a failed transfer',
      Object.assign(new TypeError('terminated'), {
        cause: Object.assign(new Error('other side closed'), {
          code: 'UND_ERR_SOCKET',
        }),
      }),
      'gzip',
      false,
    ],
    [
      'a decoder code on an identity body',
      Object.assign(new TypeError('terminated'), {
        cause: Object.assign(new Error('incorrect header check'), {
          code: 'Z_DATA_ERROR',
        }),
      }),
      'identity',
      false,
    ],
    [
      'a decoder code on a body that is identity once trimmed and lowercased',
      Object.assign(new TypeError('terminated'), {
        cause: Object.assign(new Error('incorrect header check'), {
          code: 'Z_DATA_ERROR',
        }),
      }),
      'IDENTITY,\t ',
      false,
    ],
    [
      'a decoder code on a body with one real coding beside identity',
      Object.assign(new TypeError('terminated'), {
        cause: Object.assign(new Error('incorrect header check'), {
          code: 'Z_DATA_ERROR',
        }),
      }),
      'identity, gzip',
      true,
    ],
  ])(
    'a 503 whose body fails as %s is retried only when it only failed to decode',
    async (_name, error, encoding, isRetried) => {
      let fetches = 0;
      (globalThis as any).fetch = () => {
        fetches++;
        return Promise.resolve(
          fetches === 1
            ? new Response(failingBody(error), {
                status: 503,
                headers: { 'content-encoding': encoding },
              })
            : new Response('fine'),
        );
      };

      const builder = new HTTPClient({ adapter: new FetchAdapter() })
        .get('https://decode.test/')
        .retryPolicy({ strategy: 'fixed', maxRetryAttempts: 1, delayMS: 1 });
      const response = await builder.send();

      expect(fetches).toBe(isRetried ? 2 : 1);
      expect(response.status).toBe(isRetried ? 200 : 503);
    },
  );

  test("is the runtime's decoding failure: a 3xx labelled gzip and sent plain is followed, a 503 retried", async () => {
    const http = await import('node:http');
    let busy = 0;
    const server = http.createServer((request, response) => {
      if (request.url === '/moved') {
        response.writeHead(302, {
          location: '/landed',
          'content-encoding': 'gzip',
        });
        response.end('Moved Temporarily');
      } else if (request.url === '/busy' && busy++ === 0) {
        response.writeHead(503, { 'content-encoding': 'gzip' });
        response.end('Service Unavailable');
      } else {
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end('landed');
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const { port } = server.address() as AddressInfo;

    try {
      const client = new HTTPClient({
        adapter: new FetchAdapter(),
        baseURL: `http://127.0.0.1:${String(port)}`,
        followRedirects: true,
      });

      const moved = await client.get('/moved').send<string>();
      expect(moved.status).toBe(200);
      expect(moved.body).toBe('landed');
      expect(moved.redirectHistory).toHaveLength(1);

      const builder = client
        .get('/busy')
        .retryPolicy({ strategy: 'fixed', maxRetryAttempts: 1, delayMS: 1 });
      const retried = await builder.send<string>();
      expect(retried.status).toBe(200);
      expect(retried.body).toBe('landed');
      expect(builder.attemptCount).toBe(2);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});

test('a bounded body read takes an iterator result that is a function object, as for await does', async () => {
  const step = (isDone: boolean, value?: Uint8Array) =>
    Object.assign(() => undefined, { done: isDone, value });
  const steps = [step(false, new Uint8Array([1, 2])), step(true)];
  (globalThis as any).fetch = () =>
    Promise.resolve({
      status: 200,
      type: 'basic',
      headers: new Headers(),
      body: {
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.resolve(steps.shift()),
        }),
      },
      arrayBuffer: () => Promise.reject(new Error('not read whole')),
    });

  const response = await new FetchAdapter().send({
    requestURL: 'https://local.test/data',
    method: 'GET',
    headers: {},
    maxResponseBytes: 100,
  });

  expect(response.isStreamError).toBeUndefined();
  expect([...(response.body as Uint8Array)]).toEqual([1, 2]);
});

test('a body whose Content-Length understates it is read no further than the limit', async () => {
  // The header is only a value: a test double's, a service worker's, or one beside a
  // chunked body. What is pulled from the source is held to the limit all the same.
  const chunk = new Uint8Array(64 * 1024);
  let pulledBytes = 0;
  (globalThis as any).fetch = () =>
    Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (pulledBytes >= 2000 * chunk.length) {
              controller.close();
              return;
            }

            pulledBytes += chunk.length;
            controller.enqueue(chunk.slice());
          },
        }),
        { headers: { 'content-length': '10' } },
      ),
    );

  const response = await new FetchAdapter().send({
    requestURL: 'https://local.test/data',
    method: 'GET',
    headers: {},
    maxResponseBytes: 1000,
  });

  expect(response.streamErrorCode).toBe('response_too_large');
  expect(pulledBytes).toBeLessThanOrEqual(4 * chunk.length);
});

test('an abort ends a stalled body read whose Content-Length is within the limit', async () => {
  // A stream that stalls after its first chunk and does not heed the signal.
  const controller = new AbortController();
  let pulls = 0;
  (globalThis as any).fetch = () =>
    Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          pull(stream) {
            pulls++;

            if (pulls === 1) {
              stream.enqueue(new Uint8Array([1, 2, 3]));
              return;
            }

            controller.abort();
            return new Promise<void>(() => undefined);
          },
        }),
        { headers: { 'content-length': '10' } },
      ),
    );

  const sent = new FetchAdapter().send({
    requestURL: 'https://local.test/data',
    method: 'GET',
    headers: {},
    maxResponseBytes: 100,
    signal: controller.signal,
  });

  const outcome = await sent.then(
    () => 'resolved',
    (error: unknown) => (error as Error).name,
  );

  expect(outcome).toBe('AbortError');
});

test('a chunked body under the limit is read whole though the Content-Length beside it is past the limit', async () => {
  // The chunks frame the body and override the length (RFC 9112 §6.3); Bun's fetch hands
  // such a response over with both headers shown.
  (globalThis as any).fetch = () =>
    Promise.resolve(
      new Response('ok', {
        headers: { 'transfer-encoding': 'chunked', 'content-length': '100' },
      }),
    );

  const response = await new FetchAdapter().send({
    requestURL: 'https://local.test/data',
    method: 'GET',
    headers: {},
    maxResponseBytes: 10,
  });

  expect(response.streamErrorCode).toBeUndefined();
  expect(new TextDecoder().decode(response.body as Uint8Array)).toBe('ok');
});

test('a body with a Transfer-Encoding beside its Content-Length is read a chunk at a time, held to the limit', async () => {
  // A chunked body framed past the Content-Length sent with it, which Bun's fetch reads.
  const chunk = Buffer.alloc(256 * 1024, 97);
  const server = net.createServer((socket) => {
    socket.on('error', () => undefined);
    socket.once('data', () => {
      socket.write(
        'HTTP/1.1 200 OK\r\nContent-Length: 10\r\nTransfer-Encoding: chunked\r\n\r\n',
      );

      for (let index = 0; index < 8; index++) {
        socket.write(`${chunk.length.toString(16)}\r\n`);
        socket.write(chunk);
        socket.write('\r\n');
      }

      socket.end('0\r\n\r\n');
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  const arrayBuffer = spyOn(Response.prototype, 'arrayBuffer');
  (globalThis as any).fetch = originalFetch;

  try {
    const response = await new FetchAdapter().send({
      requestURL: `http://127.0.0.1:${String(port)}/`,
      method: 'GET',
      headers: {},
      maxResponseBytes: 512 * 1024,
    });

    expect(arrayBuffer).not.toHaveBeenCalled();
    // Refused as too large where the runtime reads the chunks; a runtime that refuses the
    // header pair fails it as a network error.
    expect(
      response.streamErrorCode === 'response_too_large' ||
        response.isTransportError === true,
    ).toBe(true);
  } finally {
    arrayBuffer.mockRestore();
    server.close();
  }
});

describe('FetchAdapter - headers observers see', () => {
  test("a caller's Content-Length is not shown to observers as sent", async () => {
    (globalThis as any).fetch = () =>
      Promise.resolve(new Response(null, { status: 204 }));
    const client = new HTTPClient({
      adapter: new FetchAdapter(),
      baseURL: 'https://api.test',
    });
    const observed: Array<Record<string, string | string[]>> = [];
    client.addResponseObserver((_response, request) => {
      observed.push(request.headers);
    });

    await client
      .post('/x')
      .headers({ 'content-length': '999' })
      .text('abc')
      .send();

    expect(observed).toHaveLength(1);
    expect(Object.hasOwn(observed[0], 'content-length')).toBe(false);
  });
});

describe('FetchAdapter: a fetch that followed a redirect itself', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test.each([
    [
      'redirected and url',
      { redirected: true, url: 'https://evil.test/landing' },
    ],
    ['url only, as a polyfill sets it', { url: 'https://evil.test/landing' }],
    ['redirected only', { redirected: true }],
  ])(
    'is reported as the redirect, not the page it led to: %s',
    async (_label, fields) => {
      let isBodyCancelled = false;
      (globalThis as any).fetch = () =>
        Promise.resolve(
          Object.assign(
            new Response('landing page', {
              status: 200,
              headers: { 'set-cookie': 'a=b' },
            }),
            {},
          ),
        ).then((response) => {
          Object.defineProperties(response, {
            url: { value: 'url' in fields ? fields.url : '' },
            // A polyfill's response carries no `redirected`; a native one, a boolean.
            redirected: {
              value: 'redirected' in fields ? fields.redirected : undefined,
            },
            body: {
              value: {
                cancel: () => {
                  isBodyCancelled = true;
                  return Promise.resolve();
                },
              },
            },
          });
          return response;
        });

      const response = await new FetchAdapter().send({
        requestURL: 'https://api.test/a',
        method: 'POST',
        headers: {},
        body: 'x',
      });

      expect(response.status).toBe(0);
      expect(response.wasRedirectDetected).toBe(true);
      expect(response.headers).toEqual({});
      expect(response.detectedRedirectURL).toBe(
        'url' in fields ? 'https://evil.test/landing' : undefined,
      );
      expect(isBodyCancelled).toBe(true);
    },
  );

  test.each([
    ['a service worker answering from another URL', 'https://cdn.test/cached'],
    ["a browser's upgrade to https:", 'https://api.test/a'],
  ])(
    "a native response's redirected: false is the answer, whatever its url: %s",
    async (_label, answeredURL) => {
      (globalThis as any).fetch = () => {
        const response = new Response('ok', { status: 200 });
        Object.defineProperties(response, {
          url: { value: answeredURL },
          redirected: { value: false },
        });
        return Promise.resolve(response);
      };

      const response = await new FetchAdapter().send({
        requestURL: 'http://api.test/a',
        method: 'GET',
        headers: {},
      });

      expect(response.status).toBe(200);
      expect(response.wasRedirectDetected).toBe(false);
    },
  );

  test.each([
    [
      'percent-escape hex case',
      'https://api.test/a%2fb',
      'https://api.test/a%2Fb',
      false,
    ],
    [
      'an escaped unreserved character',
      'https://api.test/a~b',
      'https://api.test/a%7Eb',
      false,
    ],
    [
      'an empty query dropped',
      'https://api.test/a?',
      'https://api.test/a',
      true,
    ],
    ['an empty query added', 'https://api.test/a', 'https://api.test/a?', true],
    [
      'an empty query kept',
      'https://api.test/a?',
      'https://api.test/a?',
      false,
    ],
    ['another path', 'https://api.test/a', 'https://api.test/b', true],
    [
      'an escaped slash against a slash',
      'https://api.test/a%2Fb',
      'https://api.test/a/b',
      true,
    ],
    ['another origin', 'https://api.test/a', 'https://evil.test/a', true],
    [
      'a query that ends in a ?',
      'https://api.test/a?q=a',
      'https://api.test/a?q=a?',
      true,
    ],
  ])(
    "a polyfill's url is compared as RFC 3986 normalizes it: %s",
    async (_label, requestURL, answeredURL, isRedirect) => {
      (globalThis as any).fetch = () => {
        const response = new Response('ok', { status: 200 });
        Object.defineProperties(response, {
          url: { value: answeredURL },
          redirected: { value: undefined },
        });
        return Promise.resolve(response);
      };

      const response = await new FetchAdapter().send({
        requestURL,
        method: 'GET',
        headers: {},
      });

      expect(response.wasRedirectDetected).toBe(isRedirect);
      expect(response.status).toBe(isRedirect ? 0 : 200);
    },
  );

  test('a response whose url is the one dispatched, fragment aside, is the answer', async () => {
    (globalThis as any).fetch = () => {
      const response = new Response('ok', { status: 200 });
      Object.defineProperties(response, {
        url: { value: 'https://api.test/a?q=1' },
        redirected: { value: undefined },
      });
      return Promise.resolve(response);
    };

    const response = await new FetchAdapter().send({
      requestURL: 'https://api.test/a?q=1#frag',
      method: 'GET',
      headers: {},
    });

    expect(response.status).toBe(200);
  });
});

test.each(['/x#frag', '/x#'])(
  "a request URL with a fragment is answered, not taken for a followed redirect though Bun's url keeps it: %s",
  async (path) => {
    const server = (await import('node:http')).createServer((_req, res) => {
      res.end('ok');
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const { port } = server.address() as AddressInfo;

    try {
      const response = await new FetchAdapter().send({
        requestURL: `http://127.0.0.1:${String(port)}${path}`,
        method: 'GET',
        headers: {},
      });

      expect(response.status).toBe(200);
      expect(response.wasRedirectDetected).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
