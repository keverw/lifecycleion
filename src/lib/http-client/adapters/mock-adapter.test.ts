import { describe, expect, test, beforeEach } from 'bun:test';
import { MockAdapter } from './mock-adapter';
import type { MockFormData } from './mock-adapter';
import { HTTPClient } from '../http-client';
import { CookieJar } from '../cookie-jar';
import type {
  AdapterRequest,
  AdapterResponse,
  AdapterType,
  HTTPAdapter,
} from '../types';
import type { Cookie } from '../cookie-jar';

function makeCookie(
  overrides: Partial<Cookie> & { name: string; value: string },
): Cookie {
  return {
    domain: 'mock.test',
    path: '/',
    createdAt: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeClient(
  adapter: MockAdapter,
  baseURL = 'http://mock.test',
  extra: Record<string, unknown> = {},
) {
  return new HTTPClient({ adapter, baseURL, ...extra });
}

// Minimal AdapterRequest for low-level adapter tests
function makeAdapterRequest(
  overrides: Partial<AdapterRequest> = {},
): AdapterRequest {
  return {
    requestURL: '/test',
    method: 'GET',
    headers: {},
    body: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// HTTPClient-level tests (primary — reflects real usage)
// ---------------------------------------------------------------------------

describe('MockAdapter via HTTPClient', () => {
  let adapter: MockAdapter;
  let client: HTTPClient;

  beforeEach(() => {
    adapter = new MockAdapter();
    client = makeClient(adapter);
  });

  // --- HTTP methods ---

  test('GET route returns JSON response', async () => {
    adapter.routes.get('/users', () => ({ status: 200, body: [{ id: 1 }] }));

    const res = await client.get('/users').send<{ id: number }[]>();
    expect(res.status).toBe(200);
    expect(res.isJSON).toBe(true);
    expect(res.body).toEqual([{ id: 1 }]);
  });

  test('POST route receives parsed JSON body', async () => {
    let captured: unknown;

    adapter.routes.post('/users', (req) => {
      captured = req.body;
      return { status: 201, body: { created: true } };
    });

    await client.post('/users').json({ name: 'Alice' }).send();
    expect(captured).toEqual({ name: 'Alice' });
  });

  test('POST route keeps invalid JSON request body as a string', async () => {
    let captured: unknown;

    adapter.routes.post('/users', (req) => {
      captured = req.body;
      return { status: 200 };
    });

    await client
      .post('/users')
      .headers({ 'content-type': 'application/json' })
      .body('{"name":')
      .send();

    expect(captured).toBe('{"name":');
  });

  test('POST route receives binary body as raw bytes', async () => {
    let captured: unknown;
    const bytes = new Uint8Array([0, 255, 10, 13]);

    adapter.routes.post('/upload-bytes', (req) => {
      captured = req.body;
      return { status: 204 };
    });

    await client.post('/upload-bytes').body(bytes).send();

    expect(captured).toBeInstanceOf(Uint8Array);
    expect(Array.from(captured as Uint8Array)).toEqual(Array.from(bytes));
  });

  test('PUT route receives path param and body', async () => {
    adapter.routes.put('/users/:id', (req) => ({
      status: 200,
      body: { id: req.params.id, updated: true },
    }));

    const res = await client
      .put('/users/42')
      .json({ name: 'Bob' })
      .send<{ id: string; updated: boolean }>();

    expect(res.status).toBe(200);
    expect(res.body.id).toBe('42');
  });

  test('PATCH route', async () => {
    adapter.routes.patch('/items/:id', () => ({
      status: 200,
      body: { patched: true },
    }));

    const res = await client.patch('/items/7').send<{ patched: boolean }>();
    expect(res.body.patched).toBe(true);
  });

  test('DELETE route', async () => {
    adapter.routes.delete('/items/:id', (req) => ({
      status: 200,
      body: { deleted: true, id: req.params.id },
    }));

    const res = await client
      .delete('/items/5')
      .send<{ deleted: boolean; id: string }>();

    expect(res.body.deleted).toBe(true);
    expect(res.body.id).toBe('5');
  });

  test('HEAD route returns headers, no body', async () => {
    adapter.routes.head('/ping', () => ({
      status: 200,
      headers: { 'x-pong': 'true' },
    }));

    const res = await client.head('/ping').send();
    expect(res.status).toBe(200);
    expect(res.headers['x-pong']).toBe('true');
  });

  test('HEAD responses ignore any handler body', async () => {
    adapter.routes.head('/ping-body', () => ({
      status: 200,
      body: { unexpected: true },
      headers: { 'content-type': 'application/json' },
    }));

    const res = await client.head('/ping-body').send();
    expect(res.body).toBeNull();
  });

  // --- path params & query ---

  test('exposes multiple path params', async () => {
    let captured: Record<string, string> = {};

    adapter.routes.get('/orgs/:org/repos/:repo', (req) => {
      captured = req.params;
      return { status: 200 };
    });

    await client.get('/orgs/acme/repos/widget').send();
    expect(captured).toEqual({ org: 'acme', repo: 'widget' });
  });

  test('exposes query params', async () => {
    let captured: unknown;

    adapter.routes.get('/search', (req) => {
      captured = req.query;
      return { status: 200 };
    });

    await client.get('/search').params({ q: 'hello', page: '2' }).send();
    expect(captured).toMatchObject({ q: 'hello', page: '2' });
  });

  test('parses nested query params via qs', async () => {
    let captured: unknown;

    adapter.routes.get('/filter', (req) => {
      captured = req.query;
      return { status: 200 };
    });

    // qs bracket notation — client encodes params, adapter parses them back
    await client
      .get('/filter')
      .params({ where: { active: 'true', role: 'admin' } })
      .send();

    expect(captured).toMatchObject({
      where: { active: 'true', role: 'admin' },
    });
  });

  // --- 404 / 500 ---

  test('unregistered route returns 404', async () => {
    const res = await client.get('/unknown').send();
    expect(res.status).toBe(404);
  });

  test('handler throw returns 500', async () => {
    adapter.routes.get('/boom', () => {
      throw new Error('oops');
    });

    const res = await client.get('/boom').send();
    expect(res.status).toBe(500);
  });

  test('onError handler overrides default 500', async () => {
    const errorAdapter = new MockAdapter({
      onError: (_req, error) => ({
        status: 422,
        body: { message: (error as Error).message },
      }),
    });

    const errorClient = makeClient(errorAdapter);
    errorAdapter.routes.get('/boom', () => {
      throw new Error('validation failed');
    });

    const res = await errorClient.get('/boom').send<{ message: string }>();
    expect(res.status).toBe(422);
    expect(res.body.message).toBe('validation failed');
  });

  test('onError handler falling back to 500 when it also throws', async () => {
    const errorAdapter = new MockAdapter({
      onError: () => {
        throw new Error('error handler exploded');
      },
    });

    const errorClient = makeClient(errorAdapter);
    errorAdapter.routes.get('/boom', () => {
      throw new Error('original');
    });

    const res = await errorClient.get('/boom').send();
    expect(res.status).toBe(500);
  });

  // --- response body & content-type ---

  test('object body is parsed as JSON by the client', async () => {
    adapter.routes.get('/data', () => ({ status: 200, body: { value: 42 } }));
    const res = await client.get('/data').send<{ value: number }>();

    expect(res.isJSON).toBe(true);
    expect(res.body.value).toBe(42);
  });

  test('string body with contentType text is parsed as text by the client', async () => {
    adapter.routes.get('/msg', () => ({
      status: 200,
      body: 'hello',
      contentType: 'text',
    }));

    const res = await client.get('/msg').send<string>();
    expect(res.isText).toBe(true);
    expect(res.body).toBe('hello');
  });

  test('malformed JSON is surfaced as text with isParseError', async () => {
    adapter.routes.get('/bad-json', () => ({
      status: 200,
      body: '{"broken":',
      contentType: 'json',
    }));

    const res = await client.get('/bad-json').send<string>();
    expect(res.status).toBe(200);
    expect(res.isJSON).toBe(false);
    expect(res.isText).toBe(false);
    expect(res.isParseError).toBe(true);
    expect(res.body).toBe('{"broken":');
  });

  test('custom response headers are passed through', async () => {
    adapter.routes.get('/hdr', () => ({
      status: 200,
      headers: { 'x-custom': 'yes' },
    }));

    const res = await client.get('/hdr').send();
    expect(res.headers['x-custom']).toBe('yes');
  });

  test('204 responses ignore any handler body', async () => {
    adapter.routes.get('/empty', () => ({
      status: 204,
      body: { unexpected: true },
      headers: { 'content-type': 'application/json' },
    }));

    const res = await client.get('/empty').send();
    expect(res.body).toBeNull();
  });

  test('304 responses ignore any handler body', async () => {
    adapter.routes.get('/cached', () => ({
      status: 304,
      body: { unexpected: true },
      headers: { 'content-type': 'application/json' },
    }));

    const res = await client.get('/cached').send();
    expect(res.body).toBeNull();
  });

  // --- FormData ---

  test('FormData body is parsed into fields and files', async () => {
    let captured: MockFormData | undefined;

    adapter.routes.post('/upload', (req) => {
      captured = req.body as MockFormData | undefined;
      return { status: 200 };
    });

    const fd = new FormData();
    fd.append('username', 'alice');
    fd.append('avatar', new File(['img'], 'avatar.png', { type: 'image/png' }));
    await client.post('/upload').formData(fd).send();
    expect(captured?.fields).toEqual({ username: 'alice' });
    expect(captured?.files.avatar.name).toBe('avatar.png');
  });

  // --- cookies ---

  test('CookieJar cookies are visible in req.headers.cookie and req.cookies', async () => {
    const jar = new CookieJar();
    jar.setCookie(makeCookie({ name: 'session', value: 'tok123' }));
    const clientWithJar = new HTTPClient({
      adapter,
      baseURL: 'http://mock.test',
      cookieJar: jar,
    });

    let capturedCookies: Record<string, string> = {};
    let capturedHeader = '';

    adapter.routes.get('/profile', (req) => {
      capturedCookies = req.cookies;
      capturedHeader = req.headers['cookie'] ?? '';
      return { status: 200 };
    });

    await clientWithJar.get('/profile').send();

    // Both the convenience map and the raw header should agree
    expect(capturedCookies['session']).toBe('tok123');
    expect(capturedHeader).toContain('session=tok123');
  });

  test('response cookies shorthand is processed by the client into CookieJar', async () => {
    const jar = new CookieJar();
    const clientWithJar = new HTTPClient({
      adapter,
      baseURL: 'http://mock.test',
      cookieJar: jar,
    });

    adapter.routes.post('/login', () => ({
      status: 200,
      body: { ok: true },
      cookies: { session: 'newtoken' },
    }));

    await clientWithJar.post('/login').json({ user: 'alice' }).send();

    const cookies = jar.getCookiesFor('http://mock.test/profile');
    expect(cookies.find((c: Cookie) => c.name === 'session')?.value).toBe(
      'newtoken',
    );
  });

  test('MockCookieOptions sets attributes on the Set-Cookie header', async () => {
    adapter.routes.post('/login', () => ({
      status: 200,
      cookies: {
        session: {
          value: 'tok',
          httpOnly: true,
          secure: true,
          maxAge: 3600,
          sameSite: 'Strict',
        },
      },
    }));

    const res = await client.post('/login').send();
    const setCookie = res.headers['set-cookie'] as string[];
    expect(Array.isArray(setCookie)).toBe(true);
    const header = setCookie.find((h) => h.startsWith('session='));
    expect(header).toContain('session=tok');
    expect(header).toContain('HttpOnly');
    expect(header).toContain('Secure');
    expect(header).toContain('Max-Age=3600');
    expect(header).toContain('SameSite=Strict');
  });

  test('null response cookie expires it in the jar', async () => {
    const jar = new CookieJar();
    jar.setCookie(makeCookie({ name: 'session', value: 'old' }));

    const clientWithJar = new HTTPClient({
      adapter,
      baseURL: 'http://mock.test',
      cookieJar: jar,
    });

    adapter.routes.post('/logout', () => ({
      status: 200,
      cookies: { session: null },
    }));

    await clientWithJar.post('/logout').send();

    const cookies = jar.getCookiesFor('http://mock.test/');
    expect(cookies.find((c: Cookie) => c.name === 'session')).toBeUndefined();
  });

  test('cookie round-trip: set on login, automatically sent on next request', async () => {
    const jar = new CookieJar();
    const clientWithJar = new HTTPClient({
      adapter,
      baseURL: 'http://mock.test',
      cookieJar: jar,
    });

    adapter.routes.post('/login', () => ({
      status: 200,
      cookies: { session: 'abc' },
    }));

    let cookieSentOnProfile = '';
    adapter.routes.get('/profile', (req) => {
      cookieSentOnProfile = req.cookies['session'] ?? '';
      return { status: 200 };
    });

    await clientWithJar.post('/login').send();
    await clientWithJar.get('/profile').send();

    expect(cookieSentOnProfile).toBe('abc');
  });

  // --- delay ---

  test('per-route delay is observed', async () => {
    adapter.routes.get('/slow', () => ({ status: 200, delay: 50 }));
    const start = Date.now();
    await client.get('/slow').send();
    expect(Date.now() - start).toBeGreaterThanOrEqual(40);
  });

  test('default adapter delay is observed', async () => {
    const slowAdapter = new MockAdapter({ defaultDelay: 50 });
    const slowClient = makeClient(slowAdapter);
    slowAdapter.routes.get('/item', () => ({ status: 200 }));
    const start = Date.now();
    await slowClient.get('/item').send();
    expect(Date.now() - start).toBeGreaterThanOrEqual(40);
  });

  // --- redirects ---

  test('route returning 302 is followed by the client', async () => {
    const redirectClient = makeClient(adapter, 'http://mock.test', {
      followRedirects: true,
    });

    adapter.routes.get('/old', () => ({
      status: 302,
      headers: { location: 'http://mock.test/new' },
    }));

    adapter.routes.get('/new', () => ({ status: 200, body: { here: true } }));
    const res = await redirectClient.get('/old').send<{ here: boolean }>();
    expect(res.status).toBe(200);
    expect(res.wasRedirectFollowed).toBe(true);
    expect(res.detectedRedirectURL).toBeUndefined();
    expect(res.body.here).toBe(true);
  });

  test('disabled redirects expose detectedRedirectURL for relative targets', async () => {
    const redirectClient = makeClient(adapter, 'http://mock.test', {
      followRedirects: false,
    });

    adapter.routes.get('/old-relative', () => ({
      status: 302,
      headers: { Location: '/new-relative' },
    }));

    const builder = redirectClient.get('/old-relative');
    const res = await builder.send();

    expect(res.status).toBe(0);
    expect(res.wasRedirectDetected).toBe(true);
    expect(res.wasRedirectFollowed).toBe(false);
    expect(res.requestURL).toBe('http://mock.test/old-relative');
    expect(res.detectedRedirectURL).toBe('http://mock.test/new-relative');
    expect(builder.error?.code).toBe('redirect_disabled');
    expect(builder.error?.detectedRedirectURL).toBe(
      'http://mock.test/new-relative',
    );
  });

  test('disabled redirects expose detectedRedirectURL for absolute targets', async () => {
    const redirectClient = makeClient(adapter, 'http://mock.test', {
      followRedirects: false,
    });

    adapter.routes.get('/old-absolute', () => ({
      status: 302,
      headers: { location: 'https://other.test/new-absolute' },
    }));

    const builder = redirectClient.get('/old-absolute');
    const res = await builder.send();

    expect(res.status).toBe(0);
    expect(res.wasRedirectDetected).toBe(true);
    expect(res.wasRedirectFollowed).toBe(false);
    expect(res.requestURL).toBe('http://mock.test/old-absolute');
    expect(res.detectedRedirectURL).toBe('https://other.test/new-absolute');
    expect(builder.error?.code).toBe('redirect_disabled');
    expect(builder.error?.detectedRedirectURL).toBe(
      'https://other.test/new-absolute',
    );
  });

  test('cross-domain redirect works on single adapter (host stripped during match)', async () => {
    const redirectClient = makeClient(adapter, 'http://mock.test', {
      followRedirects: true,
    });

    adapter.routes.get('/start', () => ({
      status: 302,
      headers: { location: 'http://other.test/end' },
    }));

    adapter.routes.get('/end', () => ({ status: 200, body: { landed: true } }));
    const res = await redirectClient.get('/start').send<{ landed: boolean }>();
    expect(res.status).toBe(200);
    expect(res.body.landed).toBe(true);
  });

  // --- cancellation ---

  test('cancelled request resolves with isCancelled: true', async () => {
    adapter.routes.get('/slow', () => ({ status: 200, delay: 200 }));
    const controller = new AbortController();
    const promise = client.get('/slow').signal(controller.signal).send();
    setTimeout(() => controller.abort(), 30);
    const res = await promise;
    expect(res.isCancelled).toBe(true);
    expect(res.isFailed).toBe(true);
  });

  test('timeout produces no cancelReason', async () => {
    adapter.routes.get('/slow', () => ({ status: 200, delay: 500 }));
    const builder = client.get('/slow').timeout(30);
    const res = await builder.send();
    expect(res.isTimeout).toBe(true);
    expect(res.isFailed).toBe(true);
    expect(builder.error?.cancelReason).toBeUndefined();
  });

  test('builder.cancel(reason) surfaces cancelReason via MockAdapter', async () => {
    adapter.routes.get('/slow', () => ({ status: 200, delay: 200 }));
    const builder = client.get('/slow');
    const promise = builder.send();
    setTimeout(() => builder.cancel('user_navigated_away'), 30);
    const res = await promise;
    expect(res.isCancelled).toBe(true);
    expect(builder.error?.cancelReason).toBe('user_navigated_away');
  });

  test('builder.cancel() without reason produces no cancelReason via MockAdapter', async () => {
    adapter.routes.get('/slow', () => ({ status: 200, delay: 200 }));
    const builder = client.get('/slow');
    const promise = builder.send();
    setTimeout(() => builder.cancel(), 30);
    await promise;
    expect(builder.error?.cancelReason).toBeUndefined();
  });

  // --- routes.clear ---

  test('routes.clear removes all routes', async () => {
    adapter.routes.get('/item', () => ({ status: 200 }));
    adapter.routes.clear();
    const res = await client.get('/item').send();
    expect(res.status).toBe(404);
  });

  // --- trailing slash ---

  test('trailing slash is ignored', async () => {
    adapter.routes.get('/items', () => ({ status: 200 }));
    const res = await client.get('/items/').send();
    expect(res.status).toBe(200);
  });

  test('duplicate route registration throws a mock-adapter error', () => {
    adapter.routes.get('/users/:id', () => ({ status: 200 }));

    expect(() => {
      adapter.routes.get('/users/:name', () => ({ status: 200 }));
    }).toThrow(
      '[MockAdapter] Duplicate route registration for GET /users/:name. Routes must be unique per method and normalized path.',
    );
  });
});

// ---------------------------------------------------------------------------
// Low-level adapter.send() tests — contract details the client layer
// would obscure (progress event shape, abort signal timing, URL edge cases)
// ---------------------------------------------------------------------------

describe('MockAdapter.send() — low-level contract', () => {
  let adapter: MockAdapter;

  beforeEach(() => {
    adapter = new MockAdapter();
  });

  test('getType returns mock', () => {
    expect(adapter.getType()).toBe('mock');
  });

  test('progress events do not include attemptNumber (injected by client)', async () => {
    adapter.routes.get('/prog', () => ({ status: 200 }));
    const events: object[] = [];
    await adapter.send(
      makeAdapterRequest({
        requestURL: '/prog',
        onUploadProgress: (e) => events.push(e),
      }),
    );

    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => !('attemptNumber' in e))).toBe(true);
  });

  test('fires 0% upload then 100% upload and download', async () => {
    adapter.routes.get('/prog', () => ({ status: 200, body: { x: 1 } }));
    const upload: number[] = [];
    const download: number[] = [];

    await adapter.send(
      makeAdapterRequest({
        requestURL: '/prog',
        onUploadProgress: (e) => upload.push(e.progress),
        onDownloadProgress: (e) => download.push(e.progress),
      }),
    );

    expect(upload).toContain(0);
    expect(upload).toContain(1);
    expect(download).toContain(1);
  });

  test('throws AbortError if signal already aborted', () => {
    adapter.routes.get('/item', () => ({ status: 200 }));
    const controller = new AbortController();
    controller.abort();

    expect(
      adapter.send(
        makeAdapterRequest({ requestURL: '/item', signal: controller.signal }),
      ),
    ).rejects.toThrow(/aborted/i);
  });

  test('throws AbortError when signal fires during delay and resolves early', async () => {
    adapter.routes.get('/slow', () => ({ status: 200, delay: 200 }));
    const controller = new AbortController();
    const start = Date.now();
    setTimeout(() => controller.abort(), 30);

    let caught: Error | undefined;
    try {
      await adapter.send(
        makeAdapterRequest({
          requestURL: '/slow',
          signal: controller.signal,
        }),
      );
    } catch (error) {
      caught = error as Error;
    }

    expect(caught?.name).toBe('AbortError');
    // Should have thrown well before the 200ms delay completed
    expect(Date.now() - start).toBeLessThan(150);
  });

  test('throws AbortError when signal fires while async handler is still pending', async () => {
    adapter.routes.get('/slow-handler', async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return { status: 200 };
    });

    const controller = new AbortController();
    const start = Date.now();
    setTimeout(() => controller.abort(), 30);

    let caught: Error | undefined;
    try {
      await adapter.send(
        makeAdapterRequest({
          requestURL: '/slow-handler',
          signal: controller.signal,
        }),
      );
    } catch (error) {
      caught = error as Error;
    }

    expect(caught?.name).toBe('AbortError');
    expect(Date.now() - start).toBeLessThan(150);
  });

  test('does not invoke onError when signal fires while async handler is pending', async () => {
    let onErrorCalls = 0;
    const errorAdapter = new MockAdapter({
      onError: () => {
        onErrorCalls++;
        return { status: 500 };
      },
    });

    errorAdapter.routes.get('/slow-handler', async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return { status: 200 };
    });

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);

    let caught: Error | undefined;
    try {
      await errorAdapter.send(
        makeAdapterRequest({
          requestURL: '/slow-handler',
          signal: controller.signal,
        }),
      );
    } catch (error) {
      caught = error as Error;
    }

    expect(caught?.message).toMatch(/aborted/i);
    expect(onErrorCalls).toBe(0);
  });

  test('handles path-only URL without host', async () => {
    adapter.routes.get('/items', () => ({ status: 200 }));

    const res = await adapter.send(
      makeAdapterRequest({ requestURL: '/items?sort=asc' }),
    );

    expect(res.status).toBe(200);
  });

  test('Uint8Array response body passes through without explicit contentType', async () => {
    const bytes = new Uint8Array([1, 2, 3, 255]);
    adapter.routes.get('/bin', () => ({ status: 200, body: bytes }));

    const res = await adapter.send(makeAdapterRequest({ requestURL: '/bin' }));

    expect(res.body).toBeInstanceOf(Uint8Array);
    expect(Array.from(res.body as Uint8Array)).toEqual(Array.from(bytes));
  });

  test('unsupported response body type throws (aligned with request serializeBody)', () => {
    adapter.routes.get('/map', () => ({
      status: 200,
      body: new Map([['a', 1]]),
    }));

    expect(
      adapter.send(makeAdapterRequest({ requestURL: '/map' })),
    ).rejects.toThrow(/Unsupported mock response body type/);
  });

  test('3xx response sets wasRedirectDetected on AdapterResponse', async () => {
    adapter.routes.get('/moved', () => ({
      status: 301,
      headers: { Location: '/new' },
    }));

    const res = await adapter.send(
      makeAdapterRequest({ requestURL: 'http://mock.test/moved' }),
    );
    expect(res.wasRedirectDetected).toBe(true);
    expect(res.detectedRedirectURL).toBe('http://mock.test/new');
  });

  test('non-3xx response does not set wasRedirectDetected', async () => {
    adapter.routes.get('/ok', () => ({ status: 200 }));

    const res = await adapter.send(makeAdapterRequest({ requestURL: '/ok' }));
    expect(res.wasRedirectDetected).toBe(false);
    expect(res.detectedRedirectURL).toBeUndefined();
  });

  test('async handler rejection propagates through awaitAbortable when signal is present', async () => {
    adapter.routes.get('/fail', () => {
      throw new Error('handler boom');
    });

    const controller = new AbortController();

    const res = await adapter.send(
      makeAdapterRequest({ requestURL: '/fail', signal: controller.signal }),
    );

    // Error propagates through awaitAbortable's rejection handler, falls back to 500
    expect(res.status).toBe(500);
  });

  test('awaitAbortable normalizes non-Error handler rejection to Error', async () => {
    adapter.routes.get('/fail-string', () => {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      return Promise.reject('plain string rejection');
    });

    const controller = new AbortController();

    const res = await adapter.send(
      makeAdapterRequest({
        requestURL: '/fail-string',
        signal: controller.signal,
      }),
    );

    expect(res.status).toBe(500);
  });

  test('awaitAbortable settles when rejection inspection traps throw', async () => {
    const hostile = new Proxy(Object.create(null) as object, {
      get: () => {
        throw new Error('get trap');
      },
      getPrototypeOf: () => {
        throw new Error('prototype trap');
      },
    });

    adapter.routes.get('/fail-proxy', () => {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      return Promise.reject(hostile);
    });

    const controller = new AbortController();
    const response = await adapter.send(
      makeAdapterRequest({
        requestURL: '/fail-proxy',
        signal: controller.signal,
      }),
    );

    expect(response.status).toBe(500);
  });

  test('repeated cookie headers are materialized with cookie delimiters', async () => {
    let seenCookies: Record<string, string> | undefined;

    adapter.routes.get('/cookies', (req) => {
      seenCookies = req.cookies;
      return { status: 200 };
    });

    const res = await adapter.send(
      makeAdapterRequest({
        requestURL: '/cookies',
        headers: {
          cookie: ['session=abc123', 'theme=dark'],
        },
      }),
    );

    expect(res.status).toBe(200);
    expect(seenCookies).toEqual({
      session: 'abc123',
      theme: 'dark',
    });
  });
});

describe('MockAdapter streamError', () => {
  let adapter: MockAdapter;

  beforeEach(() => {
    adapter = new MockAdapter();
  });

  test('emits isStreamError with the real status and a null body', async () => {
    adapter.routes.get('/truncated', () => ({
      status: 200,
      body: { hello: 'world' },
      streamError: true,
    }));

    const res = await adapter.send(
      makeAdapterRequest({ requestURL: '/truncated' }),
    );

    expect(res.status).toBe(200);
    expect(res.isStreamError).toBe(true);
    expect(res.streamErrorCode).toBe('stream_response_error');
    // The handler's body is discarded — a real post-header failure loses it.
    expect(res.body).toBeNull();
    expect(res.errorCause).toBeInstanceOf(Error);
  });

  test('keeps the content-type the server would have sent', async () => {
    adapter.routes.get('/truncated', () => ({
      status: 200,
      body: { hello: 'world' },
      streamError: true,
    }));

    const res = await adapter.send(
      makeAdapterRequest({ requestURL: '/truncated' }),
    );

    // The failure strikes after headers arrived, so a real response would have
    // carried Content-Type. Inferring it from the discarded body would drop it.
    expect(res.headers['content-type']).toBe('application/json');
    expect(res.body).toBeNull();
  });

  test('honours an explicit contentType on a stream error', async () => {
    adapter.routes.get('/truncated', () => ({
      status: 200,
      body: 'plain text',
      contentType: 'text',
      streamError: true,
    }));

    const res = await adapter.send(
      makeAdapterRequest({ requestURL: '/truncated' }),
    );

    expect(res.headers['content-type']).toBe('text/plain');
  });

  test('sets no content-type when there was no body to begin with', async () => {
    adapter.routes.get('/truncated', () => ({
      status: 204,
      streamError: true,
    }));

    const res = await adapter.send(
      makeAdapterRequest({ requestURL: '/truncated' }),
    );

    // A 204 never carries a body, so there is no header to preserve.
    expect(res.headers['content-type']).toBeUndefined();
  });

  test('accepts an explicit stream error code', async () => {
    adapter.routes.get('/truncated', () => ({
      status: 200,
      streamError: 'stream_write_error',
    }));

    const res = await adapter.send(
      makeAdapterRequest({ requestURL: '/truncated' }),
    );

    expect(res.streamErrorCode).toBe('stream_write_error');
  });

  test('streamError: false behaves like an ordinary response', async () => {
    adapter.routes.get('/fine', () => ({
      status: 200,
      body: { hello: 'world' },
      streamError: false,
    }));

    const res = await adapter.send(makeAdapterRequest({ requestURL: '/fine' }));

    expect(res.isStreamError).toBeUndefined();
    expect(res.body).not.toBeNull();
  });

  test('reports no terminal download progress for a stream error', async () => {
    adapter.routes.get('/truncated', () => ({
      status: 200,
      body: { hello: 'world' },
      streamError: true,
    }));

    const uploadEvents: Array<{ progress: number }> = [];
    const downloadEvents: Array<{ progress: number }> = [];

    await adapter.send(
      makeAdapterRequest({
        requestURL: '/truncated',
        onUploadProgress: (e) => uploadEvents.push(e),
        onDownloadProgress: (e) => downloadEvents.push(e),
      }),
    );

    // Real adapters fail the body read before emitting terminal download
    // progress, so a `progress: 1` here would report a completed download for a
    // body that never arrived.
    expect(uploadEvents.at(-1)?.progress).toBe(1);
    expect(downloadEvents).toEqual([]);
  });

  test('preserves headers and a non-2xx status', async () => {
    adapter.routes.get('/truncated', () => ({
      status: 503,
      headers: { 'x-trace': 'abc123' },
      streamError: true,
    }));

    const res = await adapter.send(
      makeAdapterRequest({ requestURL: '/truncated' }),
    );

    expect(res.status).toBe(503);
    expect(res.headers['x-trace']).toBe('abc123');
    expect(res.isStreamError).toBe(true);
  });

  test('HTTPClient surfaces it as a terminal, non-retried failure', async () => {
    let attempts = 0;

    adapter.routes.get('/truncated', () => {
      attempts++;
      return { status: 200, streamError: true };
    });

    const client = new HTTPClient({
      adapter,
      baseURL: 'http://api.test',
      retryPolicy: { strategy: 'fixed', maxRetryAttempts: 3, delayMS: 1 },
    });

    const res = await client.get('/truncated').send();

    expect(attempts).toBe(1);
    expect(res.isStreamError).toBe(true);
    expect(res.status).toBe(200);
    expect(res.isFailed).toBe(true);
  });
});

describe('non-idempotent retry safety', () => {
  const policy = {
    strategy: 'fixed' as const,
    maxRetryAttempts: 3,
    delayMS: 1,
  };

  function countingAdapter(status: number) {
    const adapter = new MockAdapter();
    const state = { attempts: 0 };

    const handler = () => {
      state.attempts++;
      return { status };
    };

    adapter.routes.post('/thing', handler);
    adapter.routes.patch('/thing', handler);
    adapter.routes.put('/thing', handler);
    adapter.routes.delete('/thing', handler);
    adapter.routes.get('/thing', handler);

    return { adapter, state };
  }

  test('does not retry POST on a retryable status by default', async () => {
    const { adapter, state } = countingAdapter(500);
    const client = new HTTPClient({
      adapter,
      baseURL: 'http://api.test',
      retryPolicy: policy,
    });

    // A 500 means the handler ran and may have committed — the strongest
    // possible evidence that replay is unsafe.
    const res = await client.post('/thing').send();

    expect(state.attempts).toBe(1);
    expect(res.status).toBe(500);
  });

  test('does not retry PATCH by default', async () => {
    const { adapter, state } = countingAdapter(503);
    const client = new HTTPClient({
      adapter,
      baseURL: 'http://api.test',
      retryPolicy: policy,
    });

    await client.patch('/thing').send();

    expect(state.attempts).toBe(1);
  });

  test('still retries idempotent methods', async () => {
    for (const method of ['get', 'put', 'delete'] as const) {
      const { adapter, state } = countingAdapter(503);
      const client = new HTTPClient({
        adapter,
        baseURL: 'http://api.test',
        retryPolicy: policy,
      });

      await client[method]('/thing').send();

      // PUT and DELETE mutate but are idempotent, so replay is safe.
      expect(state.attempts).toBe(4);
    }
  });

  test('retries POST when the client opts in', async () => {
    const { adapter, state } = countingAdapter(503);
    const client = new HTTPClient({
      adapter,
      baseURL: 'http://api.test',
      retryPolicy: policy,
      retryNonIdempotentMethods: true,
    });

    await client.post('/thing').send();

    expect(state.attempts).toBe(4);
  });

  test('per-request opt-in overrides the client config', async () => {
    const { adapter, state } = countingAdapter(503);
    const client = new HTTPClient({
      adapter,
      baseURL: 'http://api.test',
      retryPolicy: policy,
    });

    await client.post('/thing').retryNonIdempotentMethods(true).send();

    expect(state.attempts).toBe(4);
  });

  test('per-request opt-out overrides an opted-in client', async () => {
    const { adapter, state } = countingAdapter(503);
    const client = new HTTPClient({
      adapter,
      baseURL: 'http://api.test',
      retryPolicy: policy,
      retryNonIdempotentMethods: true,
    });

    await client.post('/thing').retryNonIdempotentMethods(false).send();

    expect(state.attempts).toBe(1);
  });
});

describe('non-idempotent retry on transport failures', () => {
  const policy = {
    strategy: 'fixed' as const,
    maxRetryAttempts: 2,
    delayMS: 1,
  };

  /** Resolves a transport failure, optionally proving nothing was sent. */
  class TransportFailureAdapter implements HTTPAdapter {
    public attempts = 0;

    constructor(private readonly wasDefinitelyNotSent?: boolean) {}

    public getType(): AdapterType {
      return 'mock';
    }

    public send(_request: AdapterRequest): Promise<AdapterResponse> {
      this.attempts++;

      return Promise.resolve({
        status: 0,
        isTransportError: true,
        ...(this.wasDefinitelyNotSent !== undefined
          ? { wasDefinitelyNotSent: this.wasDefinitelyNotSent }
          : {}),
        headers: {},
        body: null,
        errorCause: new Error('connection refused'),
      });
    }
  }

  test('retries POST when the adapter proves nothing was sent', async () => {
    const adapter = new TransportFailureAdapter(true);
    const client = new HTTPClient({
      adapter,
      baseURL: 'http://api.test',
      retryPolicy: policy,
    });

    await client.post('/thing').send();

    // wasDefinitelyNotSent is positive evidence no request bytes left the
    // process, so replay cannot double-apply.
    expect(adapter.attempts).toBe(3);
  });

  test('an isRetryable hint alone does not unlock a POST retry', async () => {
    class HintOnlyAdapter implements HTTPAdapter {
      public attempts = 0;

      public getType(): AdapterType {
        return 'mock';
      }

      public send(_request: AdapterRequest): Promise<AdapterResponse> {
        this.attempts++;

        // A custom adapter may set isRetryable: true to mean "transient, worth
        // another go" without knowing whether bytes were sent. That is a hint,
        // not proof, and must not authorize replaying a write.
        return Promise.resolve({
          status: 0,
          isTransportError: true,
          isRetryable: true,
          headers: {},
          body: null,
        });
      }
    }

    const adapter = new HintOnlyAdapter();
    const client = new HTTPClient({
      adapter,
      baseURL: 'http://api.test',
      retryPolicy: policy,
    });

    await client.post('/thing').send();

    expect(adapter.attempts).toBe(1);
  });

  test('does not retry POST when the adapter cannot tell', async () => {
    const adapter = new TransportFailureAdapter();
    const client = new HTTPClient({
      adapter,
      baseURL: 'http://api.test',
      retryPolicy: policy,
    });

    await client.post('/thing').send();

    // Absence of evidence is not evidence of absence.
    expect(adapter.attempts).toBe(1);
  });

  test('a real response is never unlocked by isRetryable: true', async () => {
    class MisreportingAdapter implements HTTPAdapter {
      public attempts = 0;

      public getType(): AdapterType {
        return 'mock';
      }

      public send(_request: AdapterRequest): Promise<AdapterResponse> {
        this.attempts++;

        // A 500 with isRetryable: true. The flag says "safe as far as I know",
        // which is only evidence of non-delivery when nothing came back — here
        // the server answered, so the handler ran.
        return Promise.resolve({
          status: 500,
          isRetryable: true,
          headers: {},
          body: null,
        });
      }
    }

    const adapter = new MisreportingAdapter();
    const client = new HTTPClient({
      adapter,
      baseURL: 'http://api.test',
      retryPolicy: policy,
    });

    await client.post('/thing').send();

    expect(adapter.attempts).toBe(1);
  });

  test('retries GET regardless of what the adapter reports', async () => {
    const adapter = new TransportFailureAdapter();
    const client = new HTTPClient({
      adapter,
      baseURL: 'http://api.test',
      retryPolicy: policy,
    });

    await client.get('/thing').send();

    expect(adapter.attempts).toBe(3);
  });
});

describe('non-idempotent gate across redirect hops', () => {
  const policy = {
    strategy: 'fixed' as const,
    maxRetryAttempts: 2,
    delayMS: 1,
  };

  test('a 303 rewrites POST to GET, and that hop is retried', async () => {
    const adapter = new MockAdapter();
    let targetAttempts = 0;

    adapter.routes.post('/start', () => ({
      status: 303,
      headers: { location: 'http://api.test/target' },
    }));

    adapter.routes.get('/target', () => {
      targetAttempts++;
      return { status: 503 };
    });

    const client = new HTTPClient({
      adapter,
      baseURL: 'http://api.test',
      retryPolicy: policy,
      followRedirects: true,
    });

    await client.post('/start').send();

    // The gate reads the method of the attempt actually being sent, so once a
    // 303 has rewritten it to GET the hop is ordinary idempotent traffic.
    expect(targetAttempts).toBe(3);
  });

  test('a 307 preserves POST, and that hop is not retried', async () => {
    const adapter = new MockAdapter();
    let targetAttempts = 0;

    adapter.routes.post('/start', () => ({
      status: 307,
      headers: { location: 'http://api.test/target' },
    }));

    adapter.routes.post('/target', () => {
      targetAttempts++;
      return { status: 503 };
    });

    const client = new HTTPClient({
      adapter,
      baseURL: 'http://api.test',
      retryPolicy: policy,
      followRedirects: true,
    });

    await client.post('/start').send();

    // 307 keeps the method and body, so the protection has to survive the hop.
    expect(targetAttempts).toBe(1);
  });
});

describe('MockAdapter transportError', () => {
  const policy = {
    strategy: 'fixed' as const,
    maxRetryAttempts: 2,
    delayMS: 1,
  };

  function makeClient(adapter: MockAdapter) {
    return new HTTPClient({
      adapter,
      baseURL: 'http://api.test',
      retryPolicy: policy,
    });
  }

  test('delivers no response at all', async () => {
    const adapter = new MockAdapter();

    adapter.routes.get('/down', () => ({
      status: 200,
      body: { never: 'delivered' },
      headers: { 'x-trace': 'abc' },
      cookies: { session: 'nope' },
      transportError: true,
    }));

    const downloadEvents: Array<{ progress: number }> = [];

    const res = await adapter.send(
      makeAdapterRequest({
        requestURL: '/down',
        onDownloadProgress: (e) => downloadEvents.push(e),
      }),
    );

    expect(res.status).toBe(0);
    expect(res.isTransportError).toBe(true);
    expect(res.body).toBeNull();
    expect(res.headers).toEqual({});
    expect(downloadEvents).toEqual([]);
    expect(res.errorCause).toBeInstanceOf(Error);
  });

  test('proof of non-delivery authorizes replaying a POST', async () => {
    const adapter = new MockAdapter();
    let attempts = 0;

    adapter.routes.post('/thing', () => {
      attempts++;
      return {
        status: 200,
        transportError: { wasDefinitelyNotSent: true },
      };
    });

    await makeClient(adapter).post('/thing').send();

    expect(attempts).toBe(3);
  });

  test('without that proof a POST is not replayed', async () => {
    const adapter = new MockAdapter();
    let attempts = 0;

    adapter.routes.post('/thing', () => {
      attempts++;
      return { status: 200, transportError: true };
    });

    await makeClient(adapter).post('/thing').send();

    expect(attempts).toBe(1);
  });

  test('an idempotent GET retries without any proof', async () => {
    const adapter = new MockAdapter();
    let attempts = 0;

    adapter.routes.get('/thing', () => {
      attempts++;
      return { status: 200, transportError: true };
    });

    await makeClient(adapter).get('/thing').send();

    expect(attempts).toBe(3);
  });

  test('isRetryable: false stops every method, and keeps a diagnostic status', async () => {
    const adapter = new MockAdapter();
    let attempts = 0;

    adapter.routes.get('/tls', () => {
      attempts++;
      return {
        status: 200,
        transportError: { status: 495, isRetryable: false },
      };
    });

    const res = await makeClient(adapter).get('/tls').send();

    expect(attempts).toBe(1);
    expect(res.status).toBe(495);
  });
});

describe('retrySuppressedReason', () => {
  const policy = {
    strategy: 'fixed' as const,
    maxRetryAttempts: 2,
    delayMS: 1,
  };

  test('names the method rule when a POST is blocked', async () => {
    const adapter = new MockAdapter();
    adapter.routes.post('/thing', () => ({ status: 503 }));

    const client = new HTTPClient({
      adapter,
      baseURL: 'http://api.test',
      retryPolicy: policy,
    });

    const reasons: Array<string | undefined> = [];

    await client
      .post('/thing')
      .onAttemptEnd((e) => reasons.push(e.retrySuppressedReason))
      .send();

    // Without this the caller sees only willRetry: false and has to guess.
    expect(reasons).toEqual(['non_idempotent_method']);
  });

  test('names the stream failure', async () => {
    const adapter = new MockAdapter();
    adapter.routes.get('/thing', () => ({
      status: 503,
      streamError: true,
    }));

    const client = new HTTPClient({
      adapter,
      baseURL: 'http://api.test',
      retryPolicy: policy,
    });

    const reasons: Array<string | undefined> = [];

    await client
      .get('/thing')
      .onAttemptEnd((e) => reasons.push(e.retrySuppressedReason))
      .send();

    expect(reasons).toEqual(['stream_error']);
  });

  test('names an adapter veto', async () => {
    const adapter = new MockAdapter();
    adapter.routes.get('/thing', () => ({
      status: 200,
      transportError: { isRetryable: false },
    }));

    const client = new HTTPClient({
      adapter,
      baseURL: 'http://api.test',
      retryPolicy: policy,
    });

    const reasons: Array<string | undefined> = [];

    await client
      .get('/thing')
      .onAttemptEnd((e) => reasons.push(e.retrySuppressedReason))
      .send();

    expect(reasons).toEqual(['adapter_veto']);
  });

  test('is absent when a retry actually happens', async () => {
    const adapter = new MockAdapter();
    adapter.routes.get('/thing', () => ({ status: 503 }));

    const client = new HTTPClient({
      adapter,
      baseURL: 'http://api.test',
      retryPolicy: policy,
    });

    const reasons: Array<string | undefined> = [];

    await client
      .get('/thing')
      .onAttemptEnd((e) => reasons.push(e.retrySuppressedReason))
      .send();

    // Retried twice, then exhausted — nothing suppressed it at any point.
    expect(reasons).toEqual([undefined, undefined, undefined]);
  });

  test('is absent once the policy has no attempts left', async () => {
    const adapter = new MockAdapter();
    adapter.routes.get('/thing', () => ({
      status: 503,
      streamError: true,
    }));

    const client = new HTTPClient({
      adapter,
      baseURL: 'http://api.test',
      retryPolicy: { strategy: 'fixed', maxRetryAttempts: 1, delayMS: 1 },
    });

    const reasons: Array<string | undefined> = [];

    // Burn the single retry on a plain 503 first, so the stream failure lands
    // on an attempt where no retry was available to suppress.
    let call = 0;
    adapter.routes.clear();
    adapter.routes.get('/thing', () => {
      call++;
      return call === 1 ? { status: 503 } : { status: 503, streamError: true };
    });

    await client
      .get('/thing')
      .onAttemptEnd((e) => reasons.push(e.retrySuppressedReason))
      .send();

    // First attempt retried, so nothing suppressed. Second had the budget
    // already spent — naming a cause would misdescribe why it stopped.
    expect(reasons).toEqual([undefined, undefined]);
  });

  test('is reported after a redirect hop that spent no retry budget', async () => {
    const adapter = new MockAdapter();
    let targetAttempts = 0;

    adapter.routes.post('/start', () => ({
      status: 307,
      headers: { location: 'http://api.test/target' },
    }));

    adapter.routes.post('/target', () => {
      targetAttempts++;
      return { status: 503 };
    });

    const client = new HTTPClient({
      adapter,
      baseURL: 'http://api.test',
      retryPolicy: { strategy: 'fixed', maxRetryAttempts: 1, delayMS: 1 },
      followRedirects: true,
    });

    const reasons: Array<string | undefined> = [];

    await client
      .post('/start')
      .onAttemptEnd((e) => reasons.push(e.retrySuppressedReason))
      .send();

    // The redirect hop advanced the attempt counter without calling
    // shouldRetry, so the retry budget is untouched — a retry really was
    // available on the second hop, and the method rule is what blocked it.
    expect(targetAttempts).toBe(1);
    expect(reasons.at(-1)).toBe('non_idempotent_method');
  });

  test('is absent when the status was never retryable', async () => {
    const adapter = new MockAdapter();
    adapter.routes.post('/thing', () => ({ status: 404 }));

    const client = new HTTPClient({
      adapter,
      baseURL: 'http://api.test',
      retryPolicy: policy,
    });

    const reasons: Array<string | undefined> = [];

    await client
      .post('/thing')
      .onAttemptEnd((e) => reasons.push(e.retrySuppressedReason))
      .send();

    // A 404 is not retryable for any method, so nothing was suppressed.
    expect(reasons).toEqual([undefined]);
  });
});
