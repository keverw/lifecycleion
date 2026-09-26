import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { muteConsoleError, restoreConsoleError } from './console-test-utils';
import { createFormatReporter } from './format-reporter';
import { reportThroughHandler } from './failure-reporter';
import { hostileRejections } from './hostile-promise-test-utils';

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

  test('adopts a rejection from a then-only handler', async () => {
    let thenCalls = 0;
    const thenOnly = {
      then(_resolve: (value: unknown) => void, reject: (error: Error) => void) {
        thenCalls++;
        reject(new Error('then-only rejection'));
      },
    };
    const report = createFormatReporter(
      'render',
      // eslint-disable-next-line @typescript-eslint/no-misused-promises -- a then-only return is the supported runtime shape under test
      () => thenOnly,
    );

    report(new Error('original failure'), 'items.0');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(thenCalls).toBe(1);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toContain('the failure handler also rejected');
    expect(captured[0]).toContain('then-only rejection');
  });
});

describe('createFormatReporter follows a hostile rejected promise', () => {
  let captured: string[];

  beforeEach(() => {
    captured = muteConsoleError();
  });

  afterEach(() => {
    restoreConsoleError();
  });

  test.each(hostileRejections)(
    'a handler returning one with %s lands on the console rung',
    async (_label, make) => {
      const report = createFormatReporter(
        'render',
        // eslint-disable-next-line @typescript-eslint/no-misused-promises -- the handler returning a promise is the subject of this test
        () => make(new Error('the handler rejected')),
      );

      report(new Error('the original failure'), 'items.0');
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(captured.length).toBe(1);
      expect(captured[0]).toContain('the handler rejected');
    },
  );
});

describe('reportThroughHandler with a line that throws', () => {
  let captured: string[];

  beforeEach(() => {
    captured = muteConsoleError();
  });

  afterEach(() => {
    restoreConsoleError();
  });

  const throwingLine = (): string => {
    throw new Error('line exploded');
  };

  test('a rejecting handler still reports, and nothing is left unhandled', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    try {
      reportThroughHandler(
        () => Promise.reject(new Error('handler rejected')),
        throwingLine,
      );
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(unhandled).toEqual([]);
      expect(captured.some((line) => line.includes('line exploded'))).toBe(
        true,
      );
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  test('a throwing handler, or none, still reports without throwing', () => {
    expect(() => {
      reportThroughHandler(() => {
        throw new Error('handler threw');
      }, throwingLine);
      reportThroughHandler(undefined, throwingLine);
    }).not.toThrow();
    expect(
      captured.filter((line) => line.includes('line exploded')),
    ).toHaveLength(2);
  });

  test('a settle callback that throws is called once and contained', () => {
    let calls = 0;

    expect(() => {
      reportThroughHandler(
        () => undefined,
        () => 'a report',
        {
          onSettled: () => {
            calls++;
            throw new Error('settle exploded');
          },
        },
      );
    }).not.toThrow();
    expect(calls).toBe(1);
    expect(captured.some((line) => line.includes('settle exploded'))).toBe(
      true,
    );
  });

  test('a handler result whose then getter throws is not reported as the handler throwing', () => {
    const result = {};
    Object.defineProperty(result, 'then', {
      get: (): never => {
        throw new Error('then getter exploded');
      },
    });

    reportThroughHandler(
      () => result,
      () => 'a report',
    );

    expect(captured.some((line) => line.includes('also threw'))).toBe(false);
    expect(
      captured.filter((line) => line.includes('then getter exploded')),
    ).toHaveLength(1);
  });
});

test('an anonymous failure handler with an unreadable return retains the report context', () => {
  const captured = muteConsoleError();
  let settlements = 0;
  try {
    reportThroughHandler(
      () => ({
        get then(): never {
          throw new Error('broken return');
        },
      }),
      () => 'FileSink /test/output failed writing original entry',
      {
        onSettled: () => {
          settlements++;
        },
      },
    );
    expect(settlements).toBe(1);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toContain('FileSink /test/output');
    expect(captured[0]).toContain('then could not be read');
    expect(captured[0]).not.toContain('also threw');
  } finally {
    restoreConsoleError();
  }
});

test('format failure handlers retain the original alongside an unreadable return', () => {
  const captured = muteConsoleError();
  try {
    const reporter = createFormatReporter('render', () => ({
      get then(): never {
        throw new Error('bad return');
      },
    }));
    reporter(new Error('original delivered failure'), 'params.secret');
    expect(captured).toHaveLength(1);
    expect(captured[0]).toContain('failure handler');
    expect(captured[0]).toContain('then could not be read');
    expect(captured[0]).toContain('original delivered failure');
    expect(captured[0]).toContain('params.secret');
  } finally {
    restoreConsoleError();
  }
});

test('a lazy named handler with an unreadable then retains the undelivered failure', () => {
  const captured = muteConsoleError();
  let deliveries = 0;
  try {
    reportThroughHandler(
      () =>
        new Proxy(
          {
            then: (): void => {
              deliveries++;
            },
          },
          {
            get(): never {
              throw new Error('lazy adoption failed');
            },
          },
        ),
      () => 'original disk-write failure',
      { handlerName: 'FileSink onError' },
    );
    expect(deliveries).toBe(0);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toContain('original disk-write failure');
    expect(captured[0]).toContain('FileSink onError');
    expect(captured[0]).toContain('lazy adoption failed');
    expect(captured[0]).not.toContain('also threw');
  } finally {
    restoreConsoleError();
  }
});
