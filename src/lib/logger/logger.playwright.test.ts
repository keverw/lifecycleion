/**
 * Playwright browser integration tests for the logger's global `'error'` listener.
 *
 * The `captureResourceErrors` option only means anything in a browser: a resource-load
 * failure fires on the element and does not bubble, so nothing in Bun or Node can
 * produce one. These scenarios run in real headless Chromium.
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
import { createTempDir, type TmpDir } from '../tmp-dir';
import type { BrowserTestSuite } from '../http-client/adapters/browser-test-utils';
import { browserScenarios } from '../http-client/adapters/browser-playwright-test-utils';

// Set to true locally to surface bun build output and browser errors
const DEBUG = false;

let browser: Browser;
let context: BrowserContext;
let page: Page;
let tmpDir: TmpDir;
let suite: BrowserTestSuite;

beforeAll(async () => {
  tmpDir = await createTempDir({
    prefix: 'logger-browser',
    unsafeCleanup: true,
  });

  const scriptPath = path.join(import.meta.dir, 'logger.browser-script.ts');
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

  browser = await chromium.launch({ headless: true });
  context = await browser.newContext();
  page = await context.newPage();

  if (DEBUG) {
    page.on('pageerror', (err) =>
      console.error('[browser error]', err.message),
    );
  }

  await page.setContent(`
    <!DOCTYPE html>
    <html>
      <head><meta charset="utf-8"></head>
      <body>
        <script type="module">${bundleCode}</script>
      </body>
    </html>
  `);

  await page.waitForFunction(
    () =>
      (window as unknown as { loggerBrowserTestResults?: unknown })
        .loggerBrowserTestResults !== undefined,
    { timeout: 15_000 },
  );

  suite = await page.evaluate<BrowserTestSuite>(
    () =>
      (window as unknown as { loggerBrowserTestResults: BrowserTestSuite })
        .loggerBrowserTestResults,
  );
}, 30_000);

afterAll(async () => {
  await context?.close();
  await browser?.close();
  await tmpDir?.cleanup();
}, 30_000);

browserScenarios(
  "logger 'error' listener in browser",
  [
    'resource failures are ignored without the flag',
    'captureResourceErrors logs a failed image with a tag',
    'reported callback errors are untagged and still captured',
    'unregister detaches the capturing listener',
  ],
  () => suite,
);
