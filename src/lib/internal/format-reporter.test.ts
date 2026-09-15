import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { muteConsoleError, restoreConsoleError } from './console-test-utils';
import { createFormatReporter } from './format-reporter';

describe('createFormatReporter follows an async handler', () => {
  // Sink-owned failure callbacks are followed when they return a promise,
  // and `reportThroughHandler` exists to do exactly that. `createFormatReporter` wrapped
  // the caller's handler in a *block-bodied* arrow, which discards the return value - so a
  // rejecting `async onFormatError` sailed past every rung as an unhandled rejection.
  // Under Node's default `--unhandled-rejections=throw` that ends the process, raised out
  // of the one path whose contract is that reporting a failure may never raise one.

  let captured: string[];

  beforeEach(() => {
    captured = muteConsoleError();
  });

  afterEach(() => {
    restoreConsoleError();
  });

  test('a rejecting async handler lands on the console rung, like a throw does', async () => {
    // An `async` handler passed where `FormatErrorHandler` declares `void` - allowed by
    // TypeScript's void-return rule, documented as supported, and exactly the shape this
    // test exists for. The lint rule is warning about the hazard being asserted against.
    const report = createFormatReporter(
      'render',
      // eslint-disable-next-line @typescript-eslint/no-misused-promises -- the handler returning a promise is the subject of this test
      async () => {
        await Promise.resolve();

        throw new Error('the handler itself broke');
      },
    );

    report(new Error('the original failure'), 'items.0');

    // The rejection is delivered on a later turn, which is the whole reason it could
    // escape: a `try`/`catch` around the call never sees it.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(captured.length).toBe(1);
    expect(captured[0]).toContain('Render failed for items.0');
    expect(captured[0]).toContain('the original failure');
    // Both failures, never only the handler's: the one it was told about is what the
    // caller actually needed.
    expect(captured[0]).toContain('the handler itself broke');
  });

  test('a resolving async handler reports nothing at all', async () => {
    const seen: string[] = [];

    const report = createFormatReporter(
      'redaction',
      // eslint-disable-next-line @typescript-eslint/no-misused-promises -- as above: an async handler is the supported shape under test
      async (error, kind, path) => {
        await Promise.resolve();

        seen.push(`${kind}:${path}:${error.message}`);
      },
    );

    report(new Error('boom'), '<params>');

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(seen).toEqual(['redaction:<params>:boom']);
    expect(captured).toEqual([]);
  });
});
