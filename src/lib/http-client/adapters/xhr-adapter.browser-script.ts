/**
 * Browser-side test script for XHRAdapter and HTTPClient + XHRAdapter.
 *
 * This file is NOT a test runner — it is bundled with `bun build --target browser`
 * by xhr-adapter.playwright.test.ts and injected into a Playwright page.
 *
 * All requests target the real Bun test server via
 * window.adapterBrowserTestBaseURL (injected before this script runs). The
 * server adds CORS headers so requests from the null-origin test page are
 * accepted without route interception.
 *
 * Results are written to window.adapterBrowserTestResults so the Playwright
 * test can read them back with page.evaluate().
 */
import { XHRAdapter } from './xhr-adapter';
import { HTTPClient } from '../http-client';
import {
  browserExpect,
  type BrowserTestSuite,
  createBrowserTestRunner,
} from './browser-test-utils';

declare global {
  interface Window {
    adapterBrowserTestResults?: BrowserTestSuite;
    // Injected by the Playwright test before loading this script
    adapterBrowserTestBaseURL?: string;
  }
}

async function runTests(): Promise<void> {
  const { test, finish } = createBrowserTestRunner();

  const base = window.adapterBrowserTestBaseURL ?? '';

  // ---------------------------------------------------------------------------
  // XHRAdapter direct tests — adapter.send() against the real server
  //
  // Each `await test(name, ...)` name must have a matching entry in the
  // browserScenarios() call in xhr-adapter.playwright.test.ts — add/remove
  // scenarios in both files together.
  // ---------------------------------------------------------------------------

  const adapter = new XHRAdapter();

  await test('adapter: getType returns xhr', () => {
    browserExpect(adapter.getType()).toBe('xhr');
    return Promise.resolve();
  });

  await test('adapter: GET 200 with body', async () => {
    const r = await adapter.send({
      requestURL: `${base}/api/users/1`,
      method: 'GET',
      headers: {},
    });

    browserExpect(r.status).toBe(200);

    browserExpect(r.body).toBeUint8Array();
    const json = JSON.parse(new TextDecoder().decode(r.body as Uint8Array)) as {
      id: string;
      name: string;
    };
    browserExpect(json.id).toBe('1');
    browserExpect(json.name).toBe('User 1');
  });

  await test('adapter: POST returns 201', async () => {
    const r = await adapter.send({
      requestURL: `${base}/api/users`,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"name":"test"}',
    });

    browserExpect(r.status).toBe(201);
  });

  await test('adapter: 404 is not a transport error', async () => {
    const r = await adapter.send({
      requestURL: `${base}/api/nonexistent`,
      method: 'GET',
      headers: {},
    });

    browserExpect(r.status).toBe(404);
    browserExpect(r.isTransportError).toBeFalsy();
  });

  await test('adapter: response headers are lowercase', async () => {
    const r = await adapter.send({
      requestURL: `${base}/api/users/1`,
      method: 'GET',
      headers: {},
    });

    for (const key of Object.keys(r.headers)) {
      browserExpect(key).toBe(key.toLowerCase());
    }

    browserExpect(r.headers['content-type']).toBeDefined();
  });

  await test('adapter: request headers are forwarded', async () => {
    const r = await adapter.send({
      requestURL: `${base}/api/test`,
      method: 'GET',
      headers: { 'x-test-header': 'hello-from-xhr' },
    });

    browserExpect(r.body).toBeUint8Array();
    const json = JSON.parse(new TextDecoder().decode(r.body as Uint8Array)) as {
      headers: Record<string, string>;
    };
    browserExpect(json.headers['x-test-header']).toBe('hello-from-xhr');
  });

  await test('adapter: HEAD returns null body', async () => {
    const r = await adapter.send({
      requestURL: `${base}/api/head`,
      method: 'HEAD',
      headers: {},
    });

    browserExpect(r.body).toBeNull();
  });

  await test('adapter: AbortSignal cancels request', async () => {
    const controller = new AbortController();
    const promise = adapter.send({
      requestURL: `${base}/api/slow`,
      method: 'GET',
      headers: {},
      signal: controller.signal,
    });

    controller.abort();

    let caught: unknown;

    try {
      await promise;
    } catch (error) {
      caught = error;
    }

    browserExpect(caught).toBeInstanceOf(DOMException);
    browserExpect((caught as DOMException).name).toBe('AbortError');
  });

  await test('adapter: upload progress 0% first then 100% last', async () => {
    const events: number[] = [];
    const r = await adapter.send({
      requestURL: `${base}/api/users`,
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'hello',
      onUploadProgress: (e) => events.push(e.progress),
    });

    browserExpect(r.status).toBe(201);
    browserExpect(events.length).toBeGreaterThanOrEqual(2);
    browserExpect(events[0]).toBe(0);
    browserExpect(events[events.length - 1]).toBe(1);
  });

  await test('adapter: download progress fires 100% on completion', async () => {
    const events: number[] = [];
    await adapter.send({
      requestURL: `${base}/api/users/1`,
      method: 'GET',
      headers: {},
      onDownloadProgress: (e) => events.push(e.progress),
    });

    browserExpect(events.length).toBeGreaterThanOrEqual(1);
    browserExpect(events[events.length - 1]).toBe(1);
  });

  await test('adapter: redirect detection still emits terminal progress', async () => {
    const uploadEvents: number[] = [];
    const downloadEvents: number[] = [];

    const r = await adapter.send({
      requestURL: `${base}/api/redirect/301`,
      method: 'GET',
      headers: {},
      onUploadProgress: (e) => uploadEvents.push(e.progress),
      onDownloadProgress: (e) => downloadEvents.push(e.progress),
    });

    browserExpect(r.status).toBe(0);
    browserExpect(r.wasRedirectDetected).toBeTruthy();
    browserExpect(uploadEvents[0]).toBe(0);
    browserExpect(uploadEvents[uploadEvents.length - 1]).toBe(1);
    browserExpect(downloadEvents[downloadEvents.length - 1]).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // HTTPClient + XHRAdapter end-to-end tests
  //
  // Same rule as above: each name must match a browserScenarios() entry in
  // xhr-adapter.playwright.test.ts.
  // ---------------------------------------------------------------------------

  // XHR offers no way to intercept or observe individual redirect hops, so
  // HTTPClient treats redirect following as an error when using XHRAdapter.
  // followRedirects must be false.
  const client = new HTTPClient({
    adapter: new XHRAdapter(),
    baseURL: base,
    followRedirects: false as const,
  });

  await test('client: GET /api/users/:id returns user JSON', async () => {
    const r = await client
      .get('/api/users/42')
      .send<{ id: string; name: string }>();

    browserExpect(r.status).toBe(200);
    browserExpect(r.isJSON).toBeTruthy();
    browserExpect(r.body.id).toBe('42');
  });

  await test('client: POST /api/users returns 201', async () => {
    const r = await client
      .post('/api/users')
      .json({ name: 'Alice' })
      .send<{ created: boolean }>();

    browserExpect(r.status).toBe(201);
    browserExpect(r.isJSON).toBeTruthy();
    browserExpect(r.body.created).toBeTruthy();
  });

  await test('client: response headers are lowercase-keyed', async () => {
    const r = await client.get('/api/test').send();

    for (const key of Object.keys(r.headers)) {
      browserExpect(key).toBe(key.toLowerCase());
    }
  });

  await test('client: 404 sets correct status without isFailed', async () => {
    const r = await client.get('/api/nonexistent').send();

    browserExpect(r.status).toBe(404);
    browserExpect(r.isFailed).toBeFalsy();
  });

  await test('client: 500 sets correct status without isFailed', async () => {
    const r = await client.get('/api/error').send();

    browserExpect(r.status).toBe(500);
    browserExpect(r.isFailed).toBeFalsy();
  });

  await test('client: plain text response has isText', async () => {
    const r = await client.get('/api/text').send<string>();

    browserExpect(r.status).toBe(200);
    browserExpect(r.isText).toBeTruthy();
    browserExpect(r.body).toBe('hello world');
  });

  await test('client: malformed JSON sets isParseError and preserves text body', async () => {
    const r = await client.get('/api/invalid-json').send<string>();

    browserExpect(r.status).toBe(200);
    browserExpect(r.isJSON).toBeFalsy();
    browserExpect(r.isText).toBeFalsy();
    browserExpect(r.isParseError).toBeTruthy();
    browserExpect(r.body).toContain('{"broken":');
  });

  await test('client: 204 response has null body', async () => {
    const r = await client.get('/api/no-content').send();

    browserExpect(r.status).toBe(204);
    browserExpect(r.body).toBeNull();
  });

  await test('client: default headers are sent', async () => {
    const clientWithHeaders = new HTTPClient({
      adapter: new XHRAdapter(),
      baseURL: base,
      followRedirects: false as const,
      defaultHeaders: { 'x-browser-test': 'true' },
    });

    const r = await clientWithHeaders
      .get('/api/test')
      .send<{ headers: Record<string, string> }>();

    browserExpect(r.status).toBe(200);
    browserExpect(r.body.headers['x-browser-test']).toBe('true');
  });

  await test('client: per-request headers are sent', async () => {
    const r = await client
      .get('/api/test')
      .headers({ 'x-per-request': 'yes' })
      .send<{ headers: Record<string, string> }>();

    browserExpect(r.body.headers['x-per-request']).toBe('yes');
  });

  await test('client: adapterType is xhr', async () => {
    const r = await client.get('/api/test').send();

    browserExpect(r.adapterType).toBe('xhr');
  });

  await test('client: timeout sets isTimeout', async () => {
    const r = await client.get('/api/slow').timeout(50).send();

    browserExpect(r.isFailed).toBeTruthy();
    browserExpect(r.isTimeout).toBeTruthy();
  });

  await test('client: FormData upload integrity: server hash matches client hash', async () => {
    // 64 KB buffer with a repeating i % 256 pattern — byte-mangling bugs can't hide.
    // crypto.subtle is unavailable in non-secure page contexts (null origin), so
    // the expected hash is precomputed for this deterministic pattern.
    const EXPECTED_HASH =
      '7daca2095d0438260fa849183dfc67faa459fdf4936e1bc91eec6b281b27e4c2';

    const bytes = new Uint8Array(64 * 1024);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = i % 256;
    }

    const fd = new FormData();
    fd.append(
      'file',
      new File([bytes], 'integrity.bin', { type: 'application/octet-stream' }),
    );

    const r = await client
      .post('/api/upload-hash')
      .formData(fd)
      .send<{ hash: string }>();

    browserExpect(r.status).toBe(200);
    browserExpect(r.body.hash).toBe(EXPECTED_HASH);
  });

  await test('client: raw Uint8Array upload integrity: server hash matches client hash', async () => {
    const EXPECTED_HASH =
      '7daca2095d0438260fa849183dfc67faa459fdf4936e1bc91eec6b281b27e4c2';

    const bytes = new Uint8Array(64 * 1024);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = i % 256;
    }

    const r = await client
      .post('/api/raw-upload-hash')
      .headers({ 'content-type': 'application/octet-stream' })
      .body(bytes)
      .send<{ hash: string }>();

    browserExpect(r.status).toBe(200);
    browserExpect(r.body.hash).toBe(EXPECTED_HASH);
  });

  window.adapterBrowserTestResults = finish();
}

runTests().catch((error) => {
  window.adapterBrowserTestResults = {
    passed: false,
    results: [{ name: '__runner__', passed: false, error: String(error) }],
  };
});
