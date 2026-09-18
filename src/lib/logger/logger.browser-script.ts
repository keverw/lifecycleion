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

/**
 * Load a deliberately missing `<object>` and resolve once the browser has given up on it.
 *
 * Separate from {@link loadBrokenImage} because the point is the attribute: an `<object>`
 * names its resource in `data` and in none of `src`, `href`, or `currentSrc`.
 */
async function loadBrokenObject(data: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const element = document.createElement('object');

    element.addEventListener('error', () => resolve());
    element.data = data;

    document.body.appendChild(element);
  });

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

  await test('captureResourceErrors logs a failed object element', async () => {
    // `<object>` carries its URL in `data`. While only `src`, `href`, and `currentSrc`
    // were read it classified as "names no resource", so a broken `<object>` was neither
    // logged nor cancelled while an equivalent broken `<img>` was.
    const sink = new ArraySink();
    const logger = new Logger({ sinks: [sink], callProcessExit: false });

    logger.registerReportErrorListener('Uncaught exception', {
      captureResourceErrors: true,
    });

    await loadBrokenObject('/definitely-missing-object.svg');

    logger.unregisterReportErrorListener();

    browserExpect(sink.logs.length).toBe(1);
    browserExpect(sink.logs[0].message).toContain('Failed to load OBJECT');
    browserExpect(sink.logs[0].message).toContain(
      'definitely-missing-object.svg',
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

  await test('a component CustomEvent named error is left alone', async () => {
    // A capturing listener sees every 'error' event in the document, not just failed
    // loads. A component that dispatches its own cancelable 'error' and branches on the
    // result must keep its answer: cancelling it here would suppress that component's
    // fallback, and describing it would log 'Failed to load MY-WIDGET' for something
    // that never loaded anything.
    const sink = new ArraySink();
    const logger = new Logger({ sinks: [sink], callProcessExit: false });

    logger.registerReportErrorListener('Uncaught exception', {
      captureResourceErrors: true,
    });

    const widget = document.createElement('my-widget');

    document.body.appendChild(widget);

    // Let the element settle in the document before dispatching, so the window is
    // genuinely in the event path and a capturing listener would see the event.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const wasNotCancelled = widget.dispatchEvent(
      new CustomEvent('error', { cancelable: true, bubbles: false }),
    );

    logger.unregisterReportErrorListener();

    browserExpect(wasNotCancelled).toBe(true);
    browserExpect(sink.logs.length).toBe(0);
  });

  await test('a synthetic plain error event on a resource element is left alone', async () => {
    // The narrowest miss: an element target, a bare `Event` (not a `CustomEvent`), and a
    // real `href` — every structural test for a resource failure passes. Only `isTrusted`
    // separates it from a genuine failed load, so a component announcing its own 'error'
    // must not be described as a failed load or have its cancellation answer changed.
    //
    // An anchor rather than an `<img src>`: setting `src` starts a real load whose own
    // trusted failure event would land in this sink and mask the result. `href` is a
    // reflected IDL property, so it reads back as a string and fetches nothing.
    const sink = new ArraySink();
    const logger = new Logger({ sinks: [sink], callProcessExit: false });

    logger.registerReportErrorListener('Uncaught exception', {
      captureResourceErrors: true,
    });

    const widget = document.createElement('a');

    widget.href = '/status-signal';
    document.body.appendChild(widget);

    await new Promise((resolve) => setTimeout(resolve, 0));

    const wasNotCancelled = widget.dispatchEvent(
      new Event('error', { cancelable: true, bubbles: false }),
    );

    logger.unregisterReportErrorListener();

    browserExpect(wasNotCancelled).toBe(true);
    browserExpect(sink.logs.length).toBe(0);
  });

  await test('an element error event naming no resource is left alone', async () => {
    // Being an element is not enough either: with no src/href/currentSrc nothing was
    // loaded, so there is no failed load to describe or claim.
    const sink = new ArraySink();
    const logger = new Logger({ sinks: [sink], callProcessExit: false });

    logger.registerReportErrorListener('Uncaught exception', {
      captureResourceErrors: true,
    });

    const plain = document.createElement('div');

    document.body.appendChild(plain);

    await new Promise((resolve) => setTimeout(resolve, 0));

    const wasNotCancelled = plain.dispatchEvent(
      new Event('error', { cancelable: true, bubbles: false }),
    );

    logger.unregisterReportErrorListener();

    browserExpect(wasNotCancelled).toBe(true);
    browserExpect(sink.logs.length).toBe(0);
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
