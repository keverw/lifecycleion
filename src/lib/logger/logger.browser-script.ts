/**
 * Browser scenarios for the logger's global `'error'` listener.
 *
 * Bundled and run inside real Chromium by `logger.playwright.test.ts`. These cannot be
 * expressed in Bun or Node: a resource-load failure requires an actual element in an
 * actual document, and the whole point of `captureResourceErrors` is that such an event
 * does not bubble, so only a capturing listener sees it.
 */

import {
  browserExpect,
  createBrowserTestRunner,
  type BrowserTestSuite,
} from '../http-client/adapters/browser-test-utils';
import { Logger } from './index';
import { ArraySink } from './sinks/array';
import { safeHandleCallback } from '../safe-handle-callback';

declare global {
  interface Window {
    loggerBrowserTestResults?: BrowserTestSuite;
  }
}

/** Load a deliberately missing image and resolve once the browser has given up on it. */
async function loadBrokenImage(src: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const image = document.createElement('img');

    image.addEventListener('error', () => resolve());
    image.src = src;

    document.body.appendChild(image);
  });

  // The element's own handler resolves before the capturing listener on the window has
  // necessarily run, so yield once.
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function runTests(): Promise<void> {
  const { test, finish } = createBrowserTestRunner();

  await test('resource failures are ignored without the flag', async () => {
    const sink = new ArraySink();
    const logger = new Logger({ sinks: [sink], callProcessExit: false });

    logger.registerReportErrorListener();

    await loadBrokenImage('/definitely-missing-default.png');

    logger.unregisterReportErrorListener();

    browserExpect(sink.logs.length).toBe(0);
  });

  await test('captureResourceErrors logs a failed image with a tag', async () => {
    const sink = new ArraySink();
    const logger = new Logger({ sinks: [sink], callProcessExit: false });

    logger.registerReportErrorListener('Uncaught exception', {
      captureResourceErrors: true,
    });

    await loadBrokenImage('/definitely-missing-capture.png');

    logger.unregisterReportErrorListener();

    browserExpect(sink.logs.length).toBe(1);
    browserExpect(sink.logs[0].message).toContain('Failed to load IMG');
    browserExpect(sink.logs[0].message).toContain(
      'definitely-missing-capture.png',
    );
    browserExpect(sink.logs[0].tags?.includes('resource')).toBe(true);
  });

  await test('reported callback errors are untagged and still captured', async () => {
    const sink = new ArraySink();
    const logger = new Logger({ sinks: [sink], callProcessExit: false });

    logger.registerReportErrorListener('Uncaught exception', {
      captureResourceErrors: true,
    });

    safeHandleCallback('browserCallback', () => {
      throw new Error('Browser callback boom');
    });

    await Promise.resolve();

    logger.unregisterReportErrorListener();

    browserExpect(sink.logs.length).toBe(1);
    browserExpect(sink.logs[0].message).toContain('Browser callback boom');
    browserExpect(sink.logs[0].tags === undefined).toBe(true);
  });

  await test('unregister detaches the capturing listener', async () => {
    const sink = new ArraySink();
    const logger = new Logger({ sinks: [sink], callProcessExit: false });

    logger.registerReportErrorListener('Uncaught exception', {
      captureResourceErrors: true,
    });

    logger.unregisterReportErrorListener();

    // removeEventListener only detaches a listener registered with the same capture
    // flag, so a mismatch here would leave it attached and still logging.
    await loadBrokenImage('/definitely-missing-after-unregister.png');

    browserExpect(sink.logs.length).toBe(0);
  });

  window.loggerBrowserTestResults = finish();
}

runTests().catch((error) => {
  window.loggerBrowserTestResults = {
    passed: false,
    results: [{ name: '__runner__', passed: false, error: String(error) }],
  };
});
