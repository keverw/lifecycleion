/**
 * Playwright browser integration tests for XHRAdapter and HTTPClient + XHRAdapter.
 *
 * Uses bun:test as the test runner. Playwright is imported as a library
 * (no playwright.config.ts or separate CLI runner needed).
 *
 * Run with:
 *   bun run test:browser
 *
 * How it works:
 *   1. beforeAll: starts the real Bun test server, bundles
 *      xhr-adapter.browser-script.ts with `bun build --target browser`,
 *      and launches headless Chromium.
 *   2. The bundled script is inlined into a page. The real server URL is
 *      injected as window.adapterBrowserTestBaseURL so the browser hits the server directly —
 *      no Playwright route interception, no fake domains.
 *   3. The script runs all test scenarios and writes window.adapterBrowserTestResults.
 *   4. Each bun test case reads one result entry via page.evaluate() and asserts
 *      it passed.
 *
 * Note: run `bun run playwright:install` once before running these tests.
 */
import { beforeAll, afterAll } from 'bun:test';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createTempDir, type TmpDir } from '../../tmp-dir';
import { startTestServer, type TestServer } from '../test-helpers/test-server';
import type { BrowserTestSuite } from './browser-test-utils';
import { browserScenarios } from './browser-playwright-test-utils';

// Set to true locally to surface bun build output and browser errors
const DEBUG = false;

// ---------------------------------------------------------------------------
// Shared state — set up once, torn down after all tests
// ---------------------------------------------------------------------------

let browser: Browser;
let context: BrowserContext;
let page: Page;
let server: TestServer;
let tmpDir: TmpDir;
let suite: BrowserTestSuite;

beforeAll(async () => {
  // Start the real Bun HTTP test server. The browser hits it directly — no
  // proxy or route interception needed. CORS headers are added by the server
  // so requests from the null-origin test page are accepted.
  server = startTestServer();

  // Bundle the browser test script into a temp directory
  tmpDir = await createTempDir({ prefix: 'xhr-browser', unsafeCleanup: true });

  const scriptPath = path.join(
    import.meta.dir,
    'xhr-adapter.browser-script.ts',
  );

  const outFile = path.join(tmpDir.path, 'bundle.js');

  const buildResult = Bun.spawnSync({
    cmd: [
      'bun',
      'build',
      scriptPath,
      '--target',
      'browser',
      '--outfile',
      outFile,
    ],
    stdout: DEBUG ? 'inherit' : 'pipe',
    stderr: DEBUG ? 'inherit' : 'pipe',
  });

  if (buildResult.exitCode !== 0) {
    const stderrBytes = buildResult.stderr ?? new Uint8Array();
    const stderr =
      stderrBytes.length > 0
        ? new TextDecoder().decode(stderrBytes)
        : 'Unknown bun build error';
    throw new Error(`bun build failed: ${stderr}`);
  }

  const bundleCode = readFileSync(outFile, 'utf-8');

  // Launch headless Chromium
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext();
  page = await context.newPage();

  // Surface browser errors for debugging — gated on DEBUG so normal runs are quiet
  if (DEBUG) {
    page.on('pageerror', (err) =>
      console.error('[browser error]', err.message),
    );
  }

  // Inject the server URL and run the bundled test script. The browser makes
  // real XHR requests to the server — no route interception.
  await page.setContent(`
    <!DOCTYPE html>
    <html>
      <head><meta charset="utf-8"></head>
      <body>
        <script>window.adapterBrowserTestBaseURL = '${server.url}';</script>
        <script type="module">${bundleCode}</script>
      </body>
    </html>
  `);

  // Poll until the browser script finishes writing results to
  // window.adapterBrowserTestResults. Resolves as soon as all scenarios
  // complete — does NOT wait the full 15 s unless something hangs.
  await page.waitForFunction(
    () =>
      (window as unknown as { adapterBrowserTestResults?: unknown })
        .adapterBrowserTestResults !== undefined,
    { timeout: 15_000 },
  );

  // Read the results back into Node — page.evaluate serializes the return
  // value across the browser/Node boundary as JSON.
  suite = await page.evaluate<BrowserTestSuite>(
    () =>
      (window as unknown as { adapterBrowserTestResults: BrowserTestSuite })
        .adapterBrowserTestResults,
  );
  // 30 s outer cap covers: browser launch + bundle build + all in-browser
  // scenarios. Bun kills beforeAll if this limit is hit.
}, 30_000);

afterAll(async () => {
  await context?.close();
  await browser?.close();
  await server?.stop();
  await tmpDir?.cleanup();
});

// ---------------------------------------------------------------------------
// XHRAdapter direct scenarios
// ---------------------------------------------------------------------------

browserScenarios(
  'XHRAdapter in browser (real server)',
  [
    'adapter: getType returns xhr',
    'adapter: GET 200 with body',
    'adapter: POST returns 201',
    'adapter: 404 is not a transport error',
    'adapter: response headers are lowercase',
    'adapter: request headers are forwarded',
    'adapter: HEAD returns null body',
    'adapter: AbortSignal cancels request',
    'adapter: upload progress 0% first then 100% last',
    'adapter: download progress fires 100% on completion',
    'adapter: redirect detection still emits terminal progress',
  ],
  () => suite,
);

// ---------------------------------------------------------------------------
// HTTPClient + XHRAdapter end-to-end scenarios
// ---------------------------------------------------------------------------

browserScenarios(
  'HTTPClient + XHRAdapter end-to-end (real server)',
  [
    'client: GET /api/users/:id returns user JSON',
    'client: POST /api/users returns 201',
    'client: response headers are lowercase-keyed',
    'client: 404 sets correct status without isFailed',
    'client: 500 sets correct status without isFailed',
    'client: plain text response has isText',
    'client: malformed JSON sets isParseError and preserves text body',
    'client: 204 response has null body',
    'client: default headers are sent',
    'client: per-request headers are sent',
    'client: adapterType is xhr',
    'client: timeout sets isTimeout',
    'client: FormData upload integrity: server hash matches client hash',
    'client: raw Uint8Array upload integrity: server hash matches client hash',
  ],
  () => suite,
);
