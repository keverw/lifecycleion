/**
 * Browser-side test script for FetchAdapter and HTTPClient + FetchAdapter.
 *
 * This file is bundled with `bun build --target browser` by
 * fetch-adapter.playwright.test.ts and injected into a Playwright page.
 *
 * All requests target the real Bun test server via
 * window.adapterBrowserTestBaseURL. Results are written to
 * window.adapterBrowserTestResults for the Playwright harness to read back.
 */
import { FetchAdapter } from './fetch-adapter';
import { HTTPClient } from '../http-client';
import {
  browserExpect,
  type BrowserTestSuite,
  createBrowserTestRunner,
} from './browser-test-utils';

declare global {
  interface Window {
    adapterBrowserTestResults?: BrowserTestSuite;
    adapterBrowserTestBaseURL?: string;
  }
}

async function runTests(): Promise<void> {
  const { test, finish } = createBrowserTestRunner();

  const base = window.adapterBrowserTestBaseURL ?? '';

  // ---------------------------------------------------------------------------
  // FetchAdapter direct tests — adapter.send() against the real server
  //
  // Each `await test(name, ...)` name must have a matching entry in the
  // browserScenarios() call in fetch-adapter.playwright.test.ts — add/remove
  // scenarios in both files together.
  // ---------------------------------------------------------------------------

  const adapter = new FetchAdapter();

  await test('adapter: getType returns fetch', () => {
    browserExpect(adapter.getType()).toBe('fetch');
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
  });

  await test('adapter: browser manual redirect is opaque and has no detectedRedirectURL', async () => {
    const r = await adapter.send({
      requestURL: `${base}/api/redirect/301`,
      method: 'GET',
      headers: {},
    });

    browserExpect(r.status).toBe(0);
    browserExpect(r.wasRedirectDetected).toBeTruthy();
    browserExpect(r.detectedRedirectURL).toBeUndefined();
    browserExpect(r.body).toBeNull();
  });

  await test('adapter: request headers are forwarded', async () => {
    const r = await adapter.send({
      requestURL: `${base}/api/test`,
      method: 'GET',
      headers: { 'x-test-header': 'hello-from-fetch' },
    });

    browserExpect(r.body).toBeUint8Array();
    const json = JSON.parse(new TextDecoder().decode(r.body as Uint8Array)) as {
      headers: Record<string, string>;
    };
    browserExpect(json.headers['x-test-header']).toBe('hello-from-fetch');
  });

  await test('adapter: upload progress fires 0% first then 100% last', async () => {
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

  await test('adapter: opaque redirect still emits terminal progress', async () => {
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
    browserExpect(uploadEvents[0]).toBe(0);
    browserExpect(uploadEvents[uploadEvents.length - 1]).toBe(1);
    browserExpect(downloadEvents[downloadEvents.length - 1]).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // HTTPClient + FetchAdapter end-to-end tests
  //
  // Same rule as above: each name must match a browserScenarios() entry in
  // fetch-adapter.playwright.test.ts.
  // ---------------------------------------------------------------------------

  const client = new HTTPClient({
    adapter: new FetchAdapter(),
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

  await test('client: browser redirect_disabled keeps detectedRedirectURL undefined', async () => {
    const builder = client.get('/api/redirect/301');
    const r = await builder.send();

    browserExpect(r.status).toBe(0);
    browserExpect(r.isFailed).toBeTruthy();
    browserExpect(r.wasRedirectDetected).toBeTruthy();
    browserExpect(r.wasRedirectFollowed).toBeFalsy();
    browserExpect(r.detectedRedirectURL).toBeUndefined();
    browserExpect(builder.error?.code).toBe('redirect_disabled');
    browserExpect(builder.error?.detectedRedirectURL).toBeUndefined();
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

  await test('client: synthetic fetch progress still fires callbacks', async () => {
    const uploadEvents: number[] = [];
    const downloadEvents: number[] = [];

    const r = await client
      .post('/api/users')
      .text('hello')
      .onUploadProgress((e) => uploadEvents.push(e.progress))
      .onDownloadProgress((e) => downloadEvents.push(e.progress))
      .send();

    browserExpect(r.status).toBe(201);
    browserExpect(uploadEvents.length).toBeGreaterThanOrEqual(2);
    browserExpect(uploadEvents[0]).toBe(0);
    browserExpect(uploadEvents[uploadEvents.length - 1]).toBe(1);
    browserExpect(downloadEvents.length).toBeGreaterThanOrEqual(1);
    browserExpect(downloadEvents[downloadEvents.length - 1]).toBe(1);
  });

  await test('client: adapterType is fetch', async () => {
    const r = await client.get('/api/test').send();

    browserExpect(r.adapterType).toBe('fetch');
  });

  window.adapterBrowserTestResults = finish();
}

runTests().catch((error) => {
  window.adapterBrowserTestResults = {
    passed: false,
    results: [{ name: '__runner__', passed: false, error: String(error) }],
  };
});
