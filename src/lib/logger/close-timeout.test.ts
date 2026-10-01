import { expect, spyOn, test } from 'bun:test';
import { Logger } from './index';
import type { LoggerDiagnostic, LogSink } from './types';
import { sleep } from '../sleep';

for (const mode of ['thenable', 'promise subclass', 'async hook'] as const) {
  test(`close deadline breaks a ${mode} self-dependency`, async () => {
    const diagnostics: LoggerDiagnostic[] = [];
    let closeCalls = 0;
    let closeEvents = 0;
    const sink: LogSink = {
      write: () => {},
      close(): Promise<void> {
        closeCalls++;
        if (mode === 'async hook') {
          return (async () => {
            await Promise.resolve();
            await logger.close();
          })();
        }
        if (mode === 'thenable') {
          return {
            then(resolve: (value: unknown) => void) {
              resolve(logger.close());
            },
          } as unknown as Promise<void>;
        }
        class LazyClose extends Promise<void> {
          public override then<TResult1 = void, TResult2 = never>(
            onfulfilled?:
              ((value: void) => TResult1 | PromiseLike<TResult1>) | null,
            onrejected?:
              ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
          ): Promise<TResult1 | TResult2> {
            return logger.close().then(onfulfilled, onrejected);
          }
        }
        return new LazyClose(() => {});
      },
    };
    const logger = new Logger({
      callProcessExit: false,
      closeTimeoutMS: 5,
      sinks: [sink],
    });
    logger.on<LoggerDiagnostic>('diagnostic', (diagnostic) => {
      diagnostics.push(diagnostic);
    });
    logger.on<{ eventType: string }>('logger', ({ eventType }) => {
      if (eventType === 'close') {
        closeEvents++;
      }
    });
    const closing = logger.close();
    await Promise.resolve();
    expect(logger.close()).toBe(closing);
    await closing;
    await sleep(0);
    expect(closeCalls).toBe(1);
    expect(closeEvents).toBe(1);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].kind).toBe('sink');
    expect(diagnostics[0].context).toBe('close');
    expect(diagnostics[0].sink).toBe(sink);
    expect(diagnostics[0].message).toContain('timed out');
    expect(logger.getSinks()).toHaveLength(0);
  });
}

test('deadline reports only unfinished unique sinks and contains their late rejection', async () => {
  const pending = Promise.withResolvers<void>();
  const diagnostics: LoggerDiagnostic[] = [];
  let slowCalls = 0;
  let fastCalls = 0;
  let diagnosticWrites = 0;
  let closeEvents = 0;
  const slow: LogSink = {
    write: () => {},
    writeDiagnostic: () => {
      diagnosticWrites++;
    },
    close: () => {
      slowCalls++;
      return pending.promise;
    },
  };
  const fast: LogSink = {
    write: () => {},
    close: () => {
      fastCalls++;
    },
  };
  const logger = new Logger({
    callProcessExit: false,
    closeTimeoutMS: 5,
    sinks: [slow, fast],
    diagnosticSinks: [slow],
  });
  logger.on<LoggerDiagnostic>('diagnostic', (diagnostic) => {
    diagnostics.push(diagnostic);
  });
  logger.on<{ eventType: string }>('logger', ({ eventType }) => {
    if (eventType === 'close') {
      closeEvents++;
    }
  });
  await logger.close();
  await sleep(0);
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0].sink).toBe(slow);
  expect(diagnostics[0].message).toContain('Log sink #1');
  expect(slowCalls).toBe(1);
  expect(fastCalls).toBe(1);
  expect(diagnosticWrites).toBe(0);
  pending.reject(new Error('late failure after deadline'));
  await sleep(0);
  expect(diagnostics).toHaveLength(1);
  expect(closeEvents).toBe(1);
});

test('healthy cleanup finishes without a timeout diagnostic and concurrent callers wait', async () => {
  const gate = Promise.withResolvers<void>();
  const diagnostics: LoggerDiagnostic[] = [];
  const logger = new Logger({
    callProcessExit: false,
    closeTimeoutMS: 100,
    sinks: [{ write: () => {}, close: () => gate.promise }],
  });
  logger.on<LoggerDiagnostic>('diagnostic', (diagnostic) => {
    diagnostics.push(diagnostic);
  });
  const first = logger.close();
  let didClose = false;
  void first.then(() => {
    didClose = true;
  });
  await Promise.resolve();
  expect(didClose).toBe(false);
  expect(logger.close()).toBe(first);
  gate.resolve();
  await first;
  expect(didClose).toBe(true);
  expect(diagnostics).toHaveLength(0);
});

test('exit proceeds after an unresponsive sink deadline and reports unconfirmed cleanup', async () => {
  const codes: number[] = [];
  const diagnostics: LoggerDiagnostic[] = [];
  const exit = spyOn(process, 'exit').mockImplementation(((code: number) => {
    codes.push(code);
  }) as typeof process.exit);
  const logger = new Logger({
    callProcessExit: true,
    closeTimeoutMS: 5,
    sinks: [{ write: () => {}, close: () => new Promise<void>(() => {}) }],
  });
  logger.on<LoggerDiagnostic>('diagnostic', (diagnostic) => {
    diagnostics.push(diagnostic);
  });
  try {
    logger.exit(1);
    expect(codes).toHaveLength(0);
    await logger.close();
    await sleep(0);
    expect(codes).toEqual([1]);
    expect(diagnostics).toHaveLength(1);
  } finally {
    exit.mockRestore();
  }
});

test('an unobserved timeout uses the usual console fallback', async () => {
  const output = spyOn(console, 'error').mockImplementation(() => {});
  const logger = new Logger({
    callProcessExit: false,
    closeTimeoutMS: 5,
    sinks: [{ write: () => {}, close: () => new Promise<void>(() => {}) }],
  });
  try {
    await logger.close();
    await sleep(0);
    expect(output).toHaveBeenCalledTimes(1);
    expect(String(output.mock.calls[0][0])).toContain('timed out');
  } finally {
    output.mockRestore();
  }
});

for (const [requested, expected] of [
  [undefined, 60_000],
  [null, 60_000],
  [Number.POSITIVE_INFINITY, 2_147_483_647],
  [2_147_483_648, 2_147_483_647],
  [0, 0],
  [12, 12],
] as const) {
  test(`close timeout ${String(requested)} uses a usable timer budget`, async () => {
    const original = globalThis.setTimeout;
    const delays: number[] = [];
    const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((
      callback: () => void,
      delay?: number,
    ) => {
      delays.push(delay ?? 0);
      return original(callback, 0);
    }) as typeof globalThis.setTimeout);
    const logger = new Logger({
      callProcessExit: false,
      closeTimeoutMS: requested,
      sinks: [{ write: () => {}, close: () => new Promise<void>(() => {}) }],
    });
    logger.on('diagnostic', () => {});
    let closing: Promise<void>;
    try {
      closing = logger.close();
    } finally {
      timer.mockRestore();
    }
    await closing;
    expect(delays).toEqual([expected]);
  });
}

for (const requested of [
  Number.NaN,
  -1,
  -Infinity,
  '12',
  false,
  {},
  Symbol('timeout'),
]) {
  test(`invalid close timeout (${typeof requested}) rejects before reading sinks`, () => {
    let sinkReads = 0;
    const timer = spyOn(globalThis, 'setTimeout');
    try {
      expect(
        () =>
          new Logger({
            closeTimeoutMS: requested as number,
            get sinks() {
              sinkReads++;
              return [];
            },
          }),
      ).toThrow(
        typeof requested === 'number' && requested < 0 ? RangeError : TypeError,
      );
      expect(sinkReads).toBe(0);
      expect(timer).not.toHaveBeenCalled();
    } finally {
      timer.mockRestore();
    }
  });
}

test.each([NaN, -1])(
  'invalid logger close budget %s identifies its option',
  (closeTimeoutMS) => {
    expect(() => new Logger({ closeTimeoutMS })).toThrow(
      'Logger closeTimeoutMS',
    );
  },
);

test('zero budget still allows immediately settled cleanup and clears its timer', async () => {
  const diagnostics: LoggerDiagnostic[] = [];
  const clear = spyOn(globalThis, 'clearTimeout');
  const logger = new Logger({
    callProcessExit: false,
    closeTimeoutMS: 0,
    sinks: [{ write: () => {}, close: () => Promise.resolve() }],
  });
  logger.on<LoggerDiagnostic>('diagnostic', (diagnostic) => {
    diagnostics.push(diagnostic);
  });
  try {
    await logger.close();
    expect(diagnostics).toHaveLength(0);
    expect(clear).toHaveBeenCalledTimes(1);
  } finally {
    clear.mockRestore();
  }
});

test('timeout identifies a diagnostic-only sink by its original list position', async () => {
  const diagnostics: LoggerDiagnostic[] = [];
  const pending: LogSink = {
    write: () => {},
    close: () => new Promise<void>(() => {}),
  };
  const logger = new Logger({
    callProcessExit: false,
    closeTimeoutMS: 0,
    sinks: [],
    diagnosticSinks: [{ write: () => {} }, pending],
  });
  logger.on<LoggerDiagnostic>('diagnostic', (diagnostic) => {
    diagnostics.push(diagnostic);
  });
  await logger.close();
  await sleep(0);
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0].sink).toBe(pending);
  expect(diagnostics[0].message).toContain('Diagnostic sink #2');
});

for (const method of ['then', 'catch'] as const) {
  for (const mode of ['close', 'exit', 'exit hook', 'timeout'] as const) {
    test(`${mode} completes after Promise.prototype.${method} is replaced`, async () => {
      const script = `
        import { Logger } from ${JSON.stringify(`${import.meta.dir}/index.ts`)};
        const nativeExit = process.exit.bind(process);
        const watchdog = setTimeout(() => nativeExit(42), 500);
        const exits = [];
        process.exit = code => exits.push(code);
        let diagnostics = 0;
        const logger = new Logger({
          callProcessExit: true, closeTimeoutMS: 5,
          beforeExitCallback: ${JSON.stringify(mode)} === 'exit hook' ? async () => ({ action: 'proceed' }) : undefined,
          sinks: [{ write() {}, close() {
            return ${JSON.stringify(mode)} === 'timeout'
              ? new Promise(() => {}) : Promise.resolve();
          } }]
        });
        logger.on('diagnostic', () => { diagnostics++; });
        const original = Promise.prototype[${JSON.stringify(method)}];
        Promise.prototype[${JSON.stringify(method)}] = function () { return this; };
        if (${JSON.stringify(mode)}.startsWith('exit')) logger.exit(1);
        await logger.close();
        await new Promise(resolve => setTimeout(resolve, 0));
        Promise.prototype[${JSON.stringify(method)}] = original;
        clearTimeout(watchdog);
        process.stdout.write(JSON.stringify({ exits, diagnostics }));
      `;
      const child = Bun.spawn([process.execPath, '--eval', script], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
      expect(JSON.parse(stdout)).toEqual({
        exits: mode.startsWith('exit') ? [1] : [],
        diagnostics: mode === 'timeout' ? 1 : 0,
      });
    });
  }
}

test('a rejection after the close deadline reports its cause to the terminal console', async () => {
  const pending = Promise.withResolvers<void>();
  const output = spyOn(console, 'error').mockImplementation(() => {});
  const logger = new Logger({
    callProcessExit: false,
    closeTimeoutMS: 0,
    sinks: [{ write() {}, close: () => pending.promise }],
  });
  const diagnostics: LoggerDiagnostic[] = [];
  logger.on<LoggerDiagnostic>('diagnostic', (event) => {
    diagnostics.push(event);
  });
  try {
    await logger.close();
    pending.reject(new Error('ENOSPC late flush failure'));
    await sleep(0);
    expect(diagnostics).toHaveLength(1);
    expect(output).toHaveBeenCalledTimes(1);
    expect(String(output.mock.calls[0][0])).toContain(
      'ENOSPC late flush failure',
    );
    expect(String(output.mock.calls[0][0])).toContain('Log sink #1');
  } finally {
    output.mockRestore();
  }
});

test('a later simulated exit proceeds when beforeExit action throws', async () => {
  const output = spyOn(console, 'error').mockImplementation(() => {});
  const callbacks: { code: number; isFirstExit: boolean }[] = [];
  const exitCodes: number[] = [];
  let closeCalls = 0;
  const logger = new Logger({
    callProcessExit: false,
    sinks: [
      {
        write() {},
        close() {
          closeCalls++;
        },
      },
    ],
    beforeExitCallback: (code, isFirstExit) => {
      callbacks.push({ code, isFirstExit });
      return isFirstExit
        ? { action: 'proceed' }
        : {
            get action(): 'proceed' {
              throw new Error('unreadable action');
            },
          };
    },
  });
  logger.on('logger', (event) => {
    const data = event as { eventType: string; code: number };
    if (data.eventType === 'exit-process') {
      exitCodes.push(data.code);
    }
  });
  try {
    logger.exit(1);
    await sleep(0);
    expect(logger.didExit).toBe(true);
    expect(logger.exitCode).toBe(1);

    logger.exit(2);
    await sleep(0);

    expect(callbacks).toEqual([
      { code: 1, isFirstExit: true },
      { code: 2, isFirstExit: false },
    ]);
    expect(exitCodes).toEqual([1, 2]);
    expect(logger.exitCode).toBe(2);
    expect(logger.isPendingExit).toBe(false);
    expect(closeCalls).toBe(1);
  } finally {
    output.mockRestore();
    await logger.close();
  }
});

test('a failed exit attempt after beforeExit is reported without invoking it twice', async () => {
  const output = spyOn(console, 'error').mockImplementation(() => {});
  const logger = new Logger({
    callProcessExit: false,
    beforeExitCallback: () => Promise.resolve({ action: 'proceed' }),
  });
  const originalEmit = logger.emit.bind(logger);
  let attempts = 0;
  const emit = spyOn(logger, 'emit').mockImplementation((event, data) => {
    if (
      event === 'logger' &&
      (data as { eventType?: string }).eventType === 'exit-process'
    ) {
      attempts++;
      throw new Error('exit event unavailable');
    }
    return originalEmit(event, data);
  });
  try {
    logger.exit(1);
    await sleep(0);
    expect(attempts).toBe(1);
    expect(output).toHaveBeenCalledTimes(1);
    expect(String(output.mock.calls[0][0])).toContain('exit event unavailable');
  } finally {
    emit.mockRestore();
    output.mockRestore();
    await logger.close();
  }
});

test('close re-entry returns a handled native rejection after Promise.reject is replaced', async () => {
  const diagnostics: LoggerDiagnostic[] = [];
  let nested: Promise<void> | undefined;
  const logger: Logger = new Logger({
    callProcessExit: false,
    sinks: [
      {
        write() {},
        close() {
          nested = logger.close();
          return nested;
        },
      },
    ],
  });
  logger.on<LoggerDiagnostic>('diagnostic', (event) => {
    diagnostics.push(event);
  });
  // Patch only during the synchronous sink invocation; unrelated asynchronous work
  // keeps the real factory. Returning a fake exposes the old intrinsic receiver error.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const originalReject = Promise.reject;
  let closing: Promise<void>;
  try {
    Promise.reject = (() => ({})) as typeof Promise.reject;
    closing = logger.close();
  } finally {
    Promise.reject = originalReject;
  }
  await closing;
  expect(nested).toBeInstanceOf(Promise);
  expect(await Promise.allSettled([nested])).toEqual([
    {
      status: 'rejected',
      reason: new Error('Cannot close a logger from its own sink close hook'),
    },
  ]);
  expect(diagnostics).toHaveLength(1);
});

test('late forwarding of a reported close re-entry does not report it twice', async () => {
  const gate = Promise.withResolvers<void>();
  const diagnostics: LoggerDiagnostic[] = [];
  const output = spyOn(console, 'error').mockImplementation(() => {});
  const sink: LogSink = {
    write: () => {},
    close() {
      const reentry = logger.close();
      return gate.promise.then(() => reentry);
    },
  };
  const logger = new Logger({
    sinks: [sink],
    callProcessExit: false,
    closeTimeoutMS: 0,
  });
  logger.on<LoggerDiagnostic>('diagnostic', (event) => {
    diagnostics.push(event);
  });
  try {
    await logger.close();
    gate.resolve();
    await sleep(0);
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[0].message).toContain('own sink close hook');
    expect(diagnostics[1].message).toContain('timed out');
    expect(output).not.toHaveBeenCalled();
  } finally {
    gate.resolve();
    output.mockRestore();
  }
});

for (const boundary of ['setup', 'failure reporting'] as const) {
  test(`unexpected close ${boundary} failure still releases lists and announces close`, async () => {
    const sink: LogSink = {
      write: () => {},
      close: () => {
        throw new Error('sink close failed');
      },
    };
    const logger = new Logger({
      sinks: [sink],
      diagnosticSinks: [sink],
      callProcessExit: false,
    });
    const failure = new Error('unexpected cleanup failure');
    const events: string[] = [];
    logger.on<{ eventType: string }>('logger', ({ eventType }) => {
      events.push(eventType);
    });
    // Fault injection at both sides of timer installation verifies that finalization
    // covers the setup and awaited-operation exits, not only expected sink failures.
    const fault =
      boundary === 'setup'
        ? spyOn(logger, 'unregisterReportErrorListener').mockImplementationOnce(
            () => {
              throw failure;
            },
          )
        : spyOn(Date, 'now').mockImplementationOnce(() => {
            throw failure;
          });
    try {
      const closing = logger.close();
      const outcome = await closing.catch((error: unknown) => error);
      expect(outcome).toBe(failure);
      expect(logger.getSinks()).toEqual([]);
      expect(logger.getDiagnosticSinks()).toEqual([]);
      expect(events).toEqual(['close']);
      expect(logger.close()).toBe(closing);
    } finally {
      fault.mockRestore();
    }
  });
}

test.each([false, true])(
  'late write failures avoid closing sinks (dedicated diagnostics: %s)',
  async (hasDiagnosticSink) => {
    const writing = Promise.withResolvers<void>();
    const closing = Promise.withResolvers<void>();
    const closeStarted = Promise.withResolvers<void>();
    const observed = Promise.withResolvers<LoggerDiagnostic>();
    let diagnosticWrites = 0;
    const sink: LogSink = {
      write: () => writing.promise,
      writeDiagnostic: () => {
        diagnosticWrites++;
      },
      close: () => {
        closeStarted.resolve();
        return closing.promise;
      },
    };
    const logger = new Logger({
      sinks: [sink],
      diagnosticSinks: hasDiagnosticSink ? [sink] : undefined,
      callProcessExit: false,
    });
    logger.on<LoggerDiagnostic>('diagnostic', (diagnostic) =>
      observed.resolve(diagnostic),
    );
    logger.info('queued write');
    const cleanup = logger.close();
    await closeStarted.promise;
    const failure = new Error('late write failed');
    writing.reject(failure);
    try {
      const diagnostic = await observed.promise;
      expect(diagnostic.error).toBe(failure);
      expect(diagnostic.context).toBe('write');
      expect(diagnosticWrites).toBe(0);
    } finally {
      closing.resolve();
      await cleanup;
    }
  },
);
