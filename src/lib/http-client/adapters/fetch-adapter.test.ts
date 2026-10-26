import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test';
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

  test('PR review round 4: an empty Cookie part is left out', async () => {
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

  test('PR review round 6: an unset cookie is not sent as the text "undefined"', async () => {
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

  test('PR review round 9: a 205 has no body, so no size refusal is read off it', async () => {
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

  test('PR review round 36: a redirect of a relative request URL reports its target', async () => {
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

  test('keeps URL userinfo when the initial and request origins match', async () => {
    let capturedURL = '';

    (globalThis as any).fetch = (url: string) => {
      capturedURL = url;
      return Promise.resolve(new Response(null, { status: 204 }));
    };

    await new FetchAdapter().send({
      requestURL: 'https://user:hunter2@api.example.test/next',
      initialURL: 'https://api.example.test/start',
      method: 'GET',
      headers: {},
    });

    expect(capturedURL).toBe('https://user:hunter2@api.example.test/next');
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

  test('PR review round 40: userinfo is withheld from a protocol-relative URL that resolves to another origin', async () => {
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

  test('PR review round 40: same-origin userinfo is kept once resolved against the page', async () => {
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
      const response = await new FetchAdapter().send({
        requestURL: '//u:p@api.test/x',
        initialURL: 'https://api.test/start',
        method: 'GET',
        headers: {},
      });

      expect(response.status).toBe(204);
      expect(capturedURL).toBe('https://u:p@api.test/x');
    } finally {
      globalThis.Request = originalRequest;
    }
  });

  test('PR review round 40: a network-path URL with no base is refused, not stripped into an absolute one and sent', async () => {
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

  test('PR review round 41: a URL that is not http(s) is refused as non-retryable before it is fetched', async () => {
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

  test('PR review round 41: a relative URL with no base to resolve it against is refused as non-retryable', async () => {
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

  test('PR review round 41: a relative initial URL is resolved against the page before credentials are judged', async () => {
    let capturedURL = '';
    (globalThis as any).fetch = (url: string) => {
      capturedURL = url;
      return Promise.resolve(new Response(null, { status: 204 }));
    };

    // Bun's `Request` takes a URL with credentials; Node's refuses one, which is not what
    // this test is about.
    const originalRequest = globalThis.Request;
    delete (globalThis as { Request?: unknown }).Request;

    const sentURL = async (requestURL: string): Promise<string> => {
      await new FetchAdapter().send({
        requestURL,
        initialURL: '/start',
        method: 'GET',
        headers: {},
      });
      return capturedURL;
    };

    try {
      (globalThis as any).document = { baseURI: 'https://api.test/page' };
      // `/start` on this page is `https://api.test/start`: same origin, kept.
      expect(await sentURL('https://u:p@api.test/x')).toBe(
        'https://u:p@api.test/x',
      );
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

  test('PR review round 42: an initial URL that names no origin fails closed rather than naming the page', async () => {
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

    const sentURL = async (initialURL: string): Promise<string> => {
      await new FetchAdapter().send({
        requestURL: 'https://u:p@app.test/x',
        initialURL,
        method: 'GET',
        headers: {},
      });
      return capturedURL;
    };

    try {
      (globalThis as any).document = { baseURI: 'https://app.test/page' };

      for (const initialURL of ['', ' \t\n', '#top', '?q', '.', 'start']) {
        expect(await sentURL(initialURL)).toBe('https://app.test/x');
      }

      for (const initialURL of ['/start', '//app.test/start']) {
        expect(await sentURL(initialURL)).toBe('https://u:p@app.test/x');
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

  test('PR review round 42: a request refused before it is sent reports no upload start', async () => {
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

  test("PR review round 43: a request the runtime refuses to build is reported without the runtime's error, which quotes the value", async () => {
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

    // Node's refusal of a URL with credentials, which quotes the URL.
    const OriginalRequest = globalThis.Request;
    globalThis.Request = class {
      constructor(url: string) {
        throw Object.assign(
          new TypeError(
            `Request cannot be constructed from a URL that includes credentials: ${url}`,
          ),
          { input: url },
        );
      }
    } as unknown as typeof Request;
    try {
      const url = await send({
        requestURL: `https://user:${secret}@api.test/x?token=${secret}`,
      });
      expect(String(url?.message)).toBe(
        'FetchAdapter request could not be built: the runtime refused its URL or method',
      );
      expect(errorText(url)).not.toContain(secret);
    } finally {
      globalThis.Request = OriginalRequest;
    }

    expect(calls).toBe(0);
  });

  test("PR review round 43: without a global Request, a header Headers refuses is refused before fetch, without the runtime's error", async () => {
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
      // No body: zero bytes, as NodeAdapter reports it.
      { loaded: 0, total: 0, progress: 1 },
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

describe('FetchAdapter - round 58', () => {
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

test('PR review round 47: FetchAdapter refuses a fetch that uppercases a custom method, which is case-sensitive', async () => {
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

test('PR review round 37: an empty document.baseURI falls back to location, as the client resolves', async () => {
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

describe('FetchAdapter - PR review round 65', () => {
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

  test('PR review round 65: a lone chunk that owns its buffer is the body as it is, not copied', async () => {
    const chunk = new Uint8Array([1, 2, 3]);
    const body = await readChunks([chunk]);

    expect(body).toBe(chunk);
  });

  test('PR review round 65: a lone chunk that shares its buffer, or is a Buffer, is copied into a plain array of its own', async () => {
    const shared = new Uint8Array([9, 1, 2, 3, 9]);
    for (const chunk of [shared.subarray(1, 4), Buffer.from([1, 2, 3])]) {
      const body = await readChunks([chunk]);

      expect(body).not.toBe(chunk);
      expect(Object.getPrototypeOf(body)).toBe(Uint8Array.prototype);
      expect(body.buffer.byteLength).toBe(3);
      expect([...body]).toEqual([1, 2, 3]);
    }
  });

  test('PR review round 65: several chunks are joined in order', async () => {
    const body = await readChunks([
      new Uint8Array([1, 2]),
      new Uint8Array([3]),
      new Uint8Array([4, 5]),
    ]);

    expect([...body]).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('FetchAdapter - PR review round 66', () => {
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

  test('PR review round 66: a chunk that is not a Uint8Array fails the body read as arrayBuffer() does, not as zeros', async () => {
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

  test('PR review round 66: a chunk is counted by the bytes it holds, not the byteLength it reports', async () => {
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

  test('PR review round 66: a Uint8Array chunk from another realm is read as one', async () => {
    const { runInNewContext } = await import('node:vm');
    const foreign = runInNewContext('new Uint8Array([4, 5, 6])') as Uint8Array;
    const { response } = await sendStreamed([foreign], 100);

    expect([...(response.body as Uint8Array)]).toEqual([4, 5, 6]);
  });

  test("PR review round 66: a polyfilled fetch's Readable that yields text is still read as its UTF-8 bytes", async () => {
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
});

describe('FetchAdapter - PR review round 74', () => {
  test("PR review round 74: the bytes it is handed are copied by the runtime's fetch before send() returns, so a change made after it reaches nothing sent", async () => {
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

describe('FetchAdapter - PR review round 78', () => {
  test("PR review round 78: a body whose cancel() answers with another realm's rejecting promise leaves no unhandled rejection", async () => {
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
