import { expect, spyOn, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ArraySink, Logger, type LogSink } from './index';

// The codes `exit-process` publishes, so a test can check they agree with
// `logger.exitCode` and the `process.exit()` call.
function recordExitProcess(logger: Logger): number[] {
  const processed: number[] = [];
  logger.on<{ eventType: string; code: number }>(
    'logger',
    ({ eventType, code }) => {
      if (eventType === 'exit-process') {
        processed.push(code);
      }
    },
  );
  return processed;
}

// Settles on the logger's next `eventType` event: `exit-completed` once an exit's sinks
// have closed and, for a real exit, `process.exit()` has been called.
function nextLoggerEvent(logger: Logger, eventType: string): Promise<void> {
  return new Promise((resolve) => {
    logger.on<{ eventType: string }>('logger', (event) => {
      if (event.eventType === eventType) {
        resolve();
      }
    });
  });
}

// Every `beforeExit` answer, so a test can wait for a request that proceeds after its
// exit has already completed - and for what that late answer does - before asserting.
function recordAnswers(
  callback: (
    code: number,
    isFirstExit: boolean,
  ) => Promise<{ action: 'proceed' | 'wait' }>,
): {
  callback: typeof callback;
  settled: () => Promise<void>;
} {
  const answers: Promise<unknown>[] = [];
  return {
    callback: (code, isFirstExit) => {
      const answer = callback(code, isFirstExit);
      answers.push(answer);
      return answer;
    },
    settled: async () => {
      await Promise.all(answers);
      // The logger acts on an answer a few promise reactions later; one macrotask
      // runs them all.
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

test.each([1.5, 1e20, -1, 256, 2 ** 40])(
  'invalid real exit code %s is normalized before notifications',
  async (requestedCode) => {
    const loggerURL = new URL('./index.ts', import.meta.url).href;
    const script = `
    const { Logger } = await import(${JSON.stringify(loggerURL)});
    const logger = new Logger({
      sinks: [], callProcessExit: true,
      beforeExitCallback(code) {
        process.stdout.write('before:' + code + '\\n');
        return { action: 'proceed' };
      },
    });
    logger.on('logger', ({ eventType, code }) => {
      if (eventType === 'exit-called' || eventType === 'exit-process') {
        process.stdout.write(eventType + ':' + code + '\\n');
      }
    });
    logger.exit(${requestedCode});
    setTimeout(() => process.stdout.write('survived'), 100);
  `;
    const child = Bun.spawn([process.execPath, '-e', script], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect(exitCode).toBe(1);
    expect(stdout.trim().split('\n')).toEqual([
      'exit-called:1',
      'before:1',
      'exit-process:1',
    ]);
    expect(stderr).toContain(`exit code ${requestedCode} is invalid`);
  },
);

test('a throwing process.exit gets one bounded fallback without an unhandled rejection', async () => {
  const loggerURL = new URL('./index.ts', import.meta.url).href;
  const script = `
    const { Logger } = await import(${JSON.stringify(loggerURL)});
    const actualExit = process.exit;
    const calls = [];
    const unhandled = [];
    process.on('unhandledRejection', (error) => unhandled.push(String(error)));
    process.exit = (code) => {
      calls.push(code);
      if (calls.length === 1) throw new Error('exit hook threw');
    };
    const logger = new Logger({ sinks: [], callProcessExit: true });
    logger.exit(2);
    await new Promise((resolve) => setTimeout(resolve, 10));
    process.exit = actualExit;
    process.stdout.write(JSON.stringify({ calls, unhandled, didExit: logger.didExit }));
  `;
  const child = Bun.spawn([process.execPath, '-e', script], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  expect(exitCode).toBe(0);
  expect(JSON.parse(stdout)).toEqual({
    calls: [2, 1],
    unhandled: [],
    didExit: true,
  });
  expect(stderr).toContain('exit hook threw');
});

test('a real Node exit listener that throws cannot strand the closed logger', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'logger-exit-listener-'));
  try {
    const bundle = await Bun.build({
      entrypoints: [fileURLToPath(new URL('./index.ts', import.meta.url))],
      target: 'node',
      format: 'esm',
      splitting: false,
    });
    expect(bundle.success).toBe(true);
    await writeFile(
      join(directory, 'logger.mjs'),
      await bundle.outputs[0].text(),
    );
    await writeFile(
      join(directory, 'fixture.mjs'),
      `
        import { Logger } from './logger.mjs';
        process.on('exit', () => { throw new Error('exit listener blew up'); });
        const logger = new Logger({ sinks: [], callProcessExit: true });
        logger.exit(1);
        setInterval(() => process.stdout.write('still alive'), 100);
      `,
    );
    const child = Bun.spawn(['node', join(directory, 'fixture.mjs')], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const timeout = setTimeout(() => child.kill(), 1000);
    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(exitCode).toBe(1);
      expect(stdout).toBe('');
      expect(stderr).toContain('exit listener blew up');
      expect(stderr).toContain('Logger process exit failed');
    } finally {
      clearTimeout(timeout);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test.each([1.5, -1, 256, 2 ** 40])(
  'simulated exits retain code %s for inspection',
  (code) => {
    const logger = new Logger({ sinks: [], callProcessExit: false });
    logger.exit(code);
    expect(logger.exitCode).toBe(code);
  },
);

test('simulated NaN exit retains its code without claiming a fallback', () => {
  const output = spyOn(console, 'error').mockImplementation(() => {});
  try {
    const logger = new Logger({ sinks: [], callProcessExit: false });
    const codes: number[] = [];
    logger.on<{ eventType: string; code: number }>(
      'logger',
      ({ eventType, code }) => {
        if (eventType === 'exit-called' || eventType === 'exit-process') {
          codes.push(code);
        }
      },
    );
    logger.exit(NaN);
    expect(logger.exitCode).toBeNaN();
    expect(codes).toEqual([NaN, NaN]);
    expect(output).not.toHaveBeenCalled();
  } finally {
    output.mockRestore();
  }
});

test.each([0, 255])('portable exit boundary %s is retained', async (code) => {
  const loggerURL = new URL('./index.ts', import.meta.url).href;
  const script = `
    const { Logger } = await import(${JSON.stringify(loggerURL)});
    const logger = new Logger({ sinks: [], callProcessExit: true });
    logger.exit(${code});
  `;
  const child = Bun.spawn([process.execPath, '-e', script], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);
  expect(exitCode).toBe(code);
  expect(stderr).toBe('');
});

test.each([false, true])(
  'invalid exits report once after an earlier valid exit: %s',
  (hasEarlierValidExit) => {
    const output = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const logger = new Logger({
        sinks: [],
        callProcessExit: true,
        beforeExitCallback: () => ({ action: 'wait' }),
      });
      const codes: number[] = [];
      logger.on<{ eventType: string; code: number }>(
        'logger',
        ({ eventType, code }) => {
          if (eventType === 'exit-called') {
            codes.push(code);
          }
        },
      );
      if (hasEarlierValidExit) {
        logger.exit(0);
      }
      logger.exit(300);
      logger.exit(301);
      expect(codes).toEqual(hasEarlierValidExit ? [0, 1, 1] : [1, 1]);
      // The normalized code replaces a pending success, and says what it became; the
      // repeat of the pending 1 changes nothing and is not reported.
      expect(output.mock.calls.map((call) => String(call[0]))).toEqual(
        hasEarlierValidExit
          ? [
              'Logger exit code 300 is invalid; treating it as code 1',
              'Logger exit(300) replaces the pending exit code 0 with 1',
            ]
          : ['Logger exit code 300 is invalid; treating it as code 1'],
      );
    } finally {
      output.mockRestore();
    }
  },
);

test('a repeat real exit does not report or call process.exit with a later code', async () => {
  const exit = spyOn(process, 'exit').mockImplementation(
    () => undefined as never,
  );
  try {
    const logger = new Logger({ sinks: [], callProcessExit: true });
    const processed: number[] = [];
    logger.on<{ eventType: string; code: number }>(
      'logger',
      ({ eventType, code }) => {
        if (eventType === 'exit-process') {
          processed.push(code);
        }
      },
    );

    logger.exit(1);
    logger.exit(2);
    await logger.close();
    await Promise.resolve();

    expect(processed).toEqual([1]);
    expect(logger.exitCode).toBe(1);
    expect(exit.mock.calls).toEqual([[1]]);
  } finally {
    exit.mockRestore();
  }
});

test('an exit skipped because process.exit disappeared releases later exits', async () => {
  const actualExit = Object.getOwnPropertyDescriptor(process, 'exit');
  const calls: number[] = [];
  const stub = ((code?: number) => {
    calls.push(code ?? 0);
  }) as typeof process.exit;
  const output = spyOn(console, 'error').mockImplementation(() => {});
  process.exit = stub;
  try {
    const logger = new Logger({ sinks: [], callProcessExit: true });
    const processed: number[] = [];
    logger.on<{ eventType: string; code: number }>(
      'logger',
      ({ eventType, code }) => {
        if (eventType === 'exit-process') {
          processed.push(code);
          if (processed.length === 1) {
            // Removed after the exit was scheduled, so finish finds nothing to call.
            (process as { exit?: unknown }).exit = undefined;
          }
        }
      },
    );

    logger.exit(0);
    await logger.close();
    await Promise.resolve();

    const reported = (): string => output.mock.calls.flat().join('\n');
    expect(reported()).toContain('process.exit is no longer callable');

    // Nothing ended the process, so a later failure is not ignored behind the skipped
    // 0: it starts the next exit, which finds process.exit back and calls it.
    process.exit = stub;
    logger.exit(2);
    await logger.close();
    await Promise.resolve();

    expect(processed).toEqual([0, 2]);
    expect(logger.exitCode).toBe(2);
    expect(calls).toEqual([2]);
    expect(reported()).not.toContain('already processing');
  } finally {
    if (actualExit !== undefined) {
      Object.defineProperty(process, 'exit', actualExit);
    }
    output.mockRestore();
  }
});

test('an exit-process listener can close a logger whose sink hook requested the exit', async () => {
  const exit = spyOn(process, 'exit').mockImplementation(
    () => undefined as never,
  );
  const output = spyOn(console, 'error').mockImplementation(() => {});
  try {
    const logger: Logger = new Logger({
      callProcessExit: true,
      sinks: [
        {
          write: () => {},
          close: () => {
            logger.exit(1);
          },
        },
      ],
    });
    const diagnostics: unknown[] = [];
    logger.on('diagnostic', (diagnostic) => {
      diagnostics.push(diagnostic);
    });
    let listenerClose: Promise<void> | undefined;
    logger.on<{ eventType: string }>('logger', ({ eventType }) => {
      if (eventType === 'exit-process') {
        listenerClose = logger.close();
      }
    });

    await logger.close();
    await listenerClose;

    expect(listenerClose).toBeDefined();
    expect(diagnostics).toEqual([]);
    expect(output).not.toHaveBeenCalled();
  } finally {
    output.mockRestore();
    exit.mockRestore();
  }
});

test('a simulated exit ignores an exit requested by its own exit-process listener', async () => {
  const logger = new Logger({ sinks: [], callProcessExit: false });
  const codes: number[] = [];
  logger.on<{ eventType: string; code: number }>(
    'logger',
    ({ eventType, code }) => {
      if (eventType === 'exit-process') {
        codes.push(code);
        // Unbounded before: each nested exit emitted exit-process again.
        if (codes.length < 5) {
          logger.exit(2);
        }
      }
    },
  );

  logger.exit(1);
  await logger.close();

  expect(codes).toEqual([1]);
  expect(logger.exitCode).toBe(1);
});

test('exit-called listeners and beforeExit can close a logger whose sink hook requested the exit', async () => {
  const exit = spyOn(process, 'exit').mockImplementation(
    () => undefined as never,
  );
  const output = spyOn(console, 'error').mockImplementation(() => {});
  try {
    let beforeExitClose: Promise<void> | undefined;
    const logger: Logger = new Logger({
      callProcessExit: true,
      sinks: [
        {
          write: () => {},
          close: () => {
            logger.exit(1);
          },
        },
      ],
      beforeExitCallback: () => {
        beforeExitClose = logger.close();
        return { action: 'proceed' };
      },
    });
    const diagnostics: unknown[] = [];
    logger.on('diagnostic', (diagnostic) => {
      diagnostics.push(diagnostic);
    });
    let listenerClose: Promise<void> | undefined;
    logger.on<{ eventType: string }>('logger', ({ eventType }) => {
      if (eventType === 'exit-called') {
        listenerClose = logger.close();
      }
    });

    await logger.close();
    await listenerClose;
    await beforeExitClose;

    expect(listenerClose).toBeDefined();
    expect(beforeExitClose).toBeDefined();
    expect(diagnostics).toEqual([]);
    expect(output).not.toHaveBeenCalled();
  } finally {
    output.mockRestore();
    exit.mockRestore();
  }
});

test('a simulated exit with beforeExit ignores an exit requested by its own exit-process listener', async () => {
  let beforeExitCalls = 0;
  const logger = new Logger({
    sinks: [],
    callProcessExit: false,
    beforeExitCallback: () => {
      beforeExitCalls++;
      return { action: 'proceed' };
    },
  });
  const codes: number[] = [];
  logger.on<{ eventType: string; code: number }>(
    'logger',
    ({ eventType, code }) => {
      if (eventType === 'exit-process') {
        codes.push(code);
        // Unbounded before: beforeExit deferred each nested exit past the emit guard.
        if (codes.length < 5) {
          logger.exit(2);
        }
      }
    },
  );

  logger.exit(1);
  await logger.close();
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(codes).toEqual([1]);
  expect(beforeExitCalls).toBe(1);
  expect(logger.exitCode).toBe(1);
});

test('an exit-called listener that exits again does not recurse', async () => {
  const output = spyOn(console, 'error').mockImplementation(() => {});
  try {
    const logger = new Logger({ sinks: [], callProcessExit: false });
    const called: number[] = [];
    logger.on<{ eventType: string; code: number }>(
      'logger',
      ({ eventType, code }) => {
        if (eventType === 'exit-called') {
          called.push(code);
          // Unconditional: each nested exit emitted exit-called again until the stack
          // overflowed.
          logger.exit(2);
        }
      },
    );

    logger.exit(1);
    await logger.close();

    // Absorbed, but its failure code still replaces the pending one.
    expect(called).toEqual([1]);
    expect(logger.exitCode).toBe(2);
    expect(output.mock.calls.map((call) => String(call[0]))).toEqual([
      'Logger exit(2) replaces the pending exit code 1',
    ]);
  } finally {
    output.mockRestore();
  }
});

test('a failure exit ignored behind a scheduled success exit is reported once', async () => {
  const exit = spyOn(process, 'exit').mockImplementation(
    () => undefined as never,
  );
  const output = spyOn(console, 'error').mockImplementation(() => {});
  try {
    const logger = new Logger({ sinks: [], callProcessExit: true });
    logger.exit(0);
    logger.exit(1);
    logger.exit(3);
    await logger.close();
    await Promise.resolve();

    // The first exit committed its code before the failures arrived, so they cannot
    // replace it; the failure is not lost silently either.
    expect(exit.mock.calls).toEqual([[0]]);
    expect(output).toHaveBeenCalledTimes(1);
    expect(String(output.mock.calls[0]?.[0])).toContain(
      'Logger exit(1) ignored: an exit with code 0 is already processing',
    );
  } finally {
    output.mockRestore();
    exit.mockRestore();
  }
});

test('a success exit that proceeds first does not downgrade a pending failure', async () => {
  const exit = spyOn(process, 'exit').mockImplementation(
    () => undefined as never,
  );
  const output = spyOn(console, 'error').mockImplementation(() => {});
  try {
    const answers = recordAnswers(async (code) => {
      if (code !== 0) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return { action: 'proceed' };
    });
    const logger = new Logger({
      sinks: [],
      callProcessExit: true,
      beforeExitCallback: answers.callback,
    });
    const processed = recordExitProcess(logger);
    const completed = nextLoggerEvent(logger, 'exit-completed');
    // Neither has proceeded when the other is requested. The success proceeds first,
    // but commits the pending failure rather than its own code.
    logger.exit(1);
    logger.exit(0);
    await completed;
    // The failure proceeds too, after the exit it joined: it has nothing left to publish.
    await answers.settled();

    expect(processed).toEqual([1]);
    expect(logger.exitCode).toBe(1);
    expect(exit.mock.calls).toEqual([[1]]);
    expect(output).not.toHaveBeenCalled();
  } finally {
    output.mockRestore();
    exit.mockRestore();
  }
});

test('an exit-called listener that requests a failure replaces a pending success', async () => {
  const exit = spyOn(process, 'exit').mockImplementation(
    () => undefined as never,
  );
  const output = spyOn(console, 'error').mockImplementation(() => {});
  try {
    const logger = new Logger({ sinks: [], callProcessExit: true });
    const called: number[] = [];
    logger.on<{ eventType: string; code: number }>(
      'logger',
      ({ eventType, code }) => {
        if (eventType === 'exit-called') {
          called.push(code);
          logger.exit(1);
        }
      },
    );
    const processed = recordExitProcess(logger);
    logger.exit(0);
    await logger.close();
    await Promise.resolve();

    // Absorbed by the exit in flight - no second exit-called - but its code counts.
    expect(called).toEqual([0]);
    expect(processed).toEqual([1]);
    expect(logger.exitCode).toBe(1);
    expect(exit.mock.calls).toEqual([[1]]);
    expect(output.mock.calls.map((call) => String(call[0]))).toEqual([
      'Logger exit(1) replaces the pending exit code 0',
    ]);
  } finally {
    output.mockRestore();
    exit.mockRestore();
  }
});

test('beforeExit is told the failure an exit-called listener requested', async () => {
  const output = spyOn(console, 'error').mockImplementation(() => {});
  try {
    const told: [number, boolean][] = [];
    const logger = new Logger({
      sinks: [],
      callProcessExit: false,
      beforeExitCallback: (code, isFirstExit) => {
        told.push([code, isFirstExit]);
        return { action: 'proceed' };
      },
    });
    const called: number[] = [];
    logger.on<{ eventType: string; code: number }>(
      'logger',
      ({ eventType, code }) => {
        if (eventType === 'exit-called') {
          called.push(code);
          logger.exit(1);
          // A later success does not downgrade the absorbed failure.
          logger.exit(0);
        }
      },
    );
    const processed = recordExitProcess(logger);
    logger.exit(0);
    await logger.close();

    // The event fired before the listener asked for 1, so it names the request; the
    // absorbed request runs no beforeExit of its own, so the outer one carries its code.
    expect(called).toEqual([0]);
    expect(told).toEqual([[1, true]]);
    expect(processed).toEqual([1]);
    expect(logger.exitCode).toBe(1);
  } finally {
    output.mockRestore();
  }
});

test('beforeExit is told its own code when its exit-called listeners request none', async () => {
  const told: number[] = [];
  const logger = new Logger({
    sinks: [],
    callProcessExit: false,
    beforeExitCallback: (code) => {
      told.push(code);
      return { action: told.length === 1 ? 'wait' : 'proceed' };
    },
  });
  // An earlier failure still pending is not this request's code.
  logger.exit(2);
  logger.exit(0);
  await logger.close();

  expect(told).toEqual([2, 0]);
  expect(logger.exitCode).toBe(2);
});

test('a later success or repeated failure exit is not reported', async () => {
  const exit = spyOn(process, 'exit').mockImplementation(
    () => undefined as never,
  );
  const output = spyOn(console, 'error').mockImplementation(() => {});
  try {
    const logger = new Logger({ sinks: [], callProcessExit: true });
    logger.exit(2);
    logger.exit(0);
    logger.exit(1);
    await logger.close();
    await Promise.resolve();

    expect(exit.mock.calls).toEqual([[2]]);
    expect(output).not.toHaveBeenCalled();
  } finally {
    output.mockRestore();
    exit.mockRestore();
  }
});

test('a log entry records the exit code a real exit will use', async () => {
  const exit = spyOn(process, 'exit').mockImplementation(
    () => undefined as never,
  );
  const output = spyOn(console, 'error').mockImplementation(() => {});
  try {
    const sink = new ArraySink();
    const logger = new Logger({ sinks: [sink], callProcessExit: true });
    logger.error('fatal', { exitCode: 300 });
    await logger.close();
    await Promise.resolve();

    // Recorded 300 before, while the process exited 1.
    expect(sink.logs[0]?.exitCode).toBe(1);
    expect(exit.mock.calls).toEqual([[1]]);
    expect(output.mock.calls.flat().join('\n')).toContain(
      'exit code 300 is invalid',
    );
  } finally {
    output.mockRestore();
    exit.mockRestore();
  }
});

test('a simulated exit entry keeps the requested exit code', async () => {
  const sink = new ArraySink();
  const logger = new Logger({ sinks: [sink], callProcessExit: false });
  logger.error('fatal', { exitCode: 300 });
  await logger.close();

  expect(sink.logs[0]?.exitCode).toBe(300);
  expect(logger.exitCode).toBe(300);
});

test('a repeat exit behind a committed real exit reaches no exit-called listener', async () => {
  const exit = spyOn(process, 'exit').mockImplementation(
    () => undefined as never,
  );
  const output = spyOn(console, 'error').mockImplementation(() => {});
  try {
    const logger = new Logger({ sinks: [], callProcessExit: true });
    logger.exit(1);
    let exitCalled = 0;
    logger.on<{ eventType: string }>('logger', ({ eventType }) => {
      if (eventType === 'exit-called') {
        exitCalled++;
        logger.exit(5);
      }
    });
    // Ignored behind the committed exit, so it starts nothing: no `exit-called`, and so
    // no nested request from its listener either.
    logger.exit(0);
    await logger.close();
    await Promise.resolve();

    expect(exitCalled).toBe(0);
    expect(exit.mock.calls).toEqual([[1]]);
    expect(output).not.toHaveBeenCalled();
  } finally {
    output.mockRestore();
    exit.mockRestore();
  }
});

test('a failure exit beforeExit waits out behind a pending success exit replaces its code', async () => {
  // SIGTERM's `exit(0)` is still stopping components when one fails and logs
  // `exitCode: 1`; `LifecycleManager` answers 'wait' for it. Under first-wins the
  // process exited 0, so a failed shutdown read as a clean one.
  const exit = spyOn(process, 'exit').mockImplementation(
    () => undefined as never,
  );
  const output = spyOn(console, 'error').mockImplementation(() => {});
  try {
    const logger = new Logger({
      sinks: [],
      callProcessExit: true,
      beforeExitCallback: async (_code, isFirstExit) => {
        if (!isFirstExit) {
          return { action: 'wait' };
        }
        // The leading exit's shutdown, during which a component fails.
        await new Promise((resolve) => setTimeout(resolve, 5));
        logger.error('component failed to stop', { exitCode: 1 });
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { action: 'proceed' };
      },
    });
    const processed = recordExitProcess(logger);
    const completed = nextLoggerEvent(logger, 'exit-completed');
    logger.exit(0);
    await completed;

    expect(processed).toEqual([1]);
    expect(logger.exitCode).toBe(1);
    expect(exit.mock.calls).toEqual([[1]]);
    expect(output.mock.calls.map((call) => String(call[0]))).toEqual([
      'Logger exit(1) replaces the pending exit code 0',
    ]);
  } finally {
    output.mockRestore();
    exit.mockRestore();
  }
});

test('an invalid exit during a pending success exit replaces it with 1', async () => {
  const exit = spyOn(process, 'exit').mockImplementation(
    () => undefined as never,
  );
  const output = spyOn(console, 'error').mockImplementation(() => {});
  try {
    const logger = new Logger({
      sinks: [],
      callProcessExit: true,
      beforeExitCallback: async (_code, isFirstExit) => {
        if (!isFirstExit) {
          return { action: 'wait' };
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { action: 'proceed' };
      },
    });
    const processed = recordExitProcess(logger);
    const completed = nextLoggerEvent(logger, 'exit-completed');
    logger.exit(0);
    logger.exit(300);
    await completed;

    expect(processed).toEqual([1]);
    expect(logger.exitCode).toBe(1);
    expect(exit.mock.calls).toEqual([[1]]);
    expect(output.mock.calls.map((call) => String(call[0]))).toEqual([
      'Logger exit code 300 is invalid; treating it as code 1',
      'Logger exit(300) replaces the pending exit code 0 with 1',
    ]);
  } finally {
    output.mockRestore();
    exit.mockRestore();
  }
});

test('a failure exit requested after exit-process fired is ignored and reported', async () => {
  const exit = spyOn(process, 'exit').mockImplementation(
    () => undefined as never,
  );
  const output = spyOn(console, 'error').mockImplementation(() => {});
  try {
    let releaseClose = (): void => {};
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const logger = new Logger({
      // Held open, so `process.exit()` is still to come when the failure arrives.
      sinks: [{ write: () => {}, close: () => closeGate }],
      callProcessExit: true,
      beforeExitCallback: async (_code, isFirstExit) => {
        if (!isFirstExit) {
          return { action: 'wait' };
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { action: 'proceed' };
      },
    });
    const processed = recordExitProcess(logger);
    const published = nextLoggerEvent(logger, 'exit-process');
    const completed = nextLoggerEvent(logger, 'exit-completed');
    logger.exit(0);
    await published;
    expect(processed).toEqual([0]);
    expect(exit).not.toHaveBeenCalled();

    // The code is final once published: the failure cannot change it.
    logger.exit(1);
    releaseClose();
    await completed;

    expect(processed).toEqual([0]);
    expect(logger.exitCode).toBe(0);
    expect(exit.mock.calls).toEqual([[0]]);
    expect(output.mock.calls.map((call) => String(call[0]))).toEqual([
      'Logger exit(1) ignored: an exit with code 0 is already processing',
    ]);
  } finally {
    output.mockRestore();
    exit.mockRestore();
  }
});

test('a failure exit requested by an exit-process listener is not applied', async () => {
  const exit = spyOn(process, 'exit').mockImplementation(
    () => undefined as never,
  );
  const output = spyOn(console, 'error').mockImplementation(() => {});
  try {
    const logger = new Logger({ sinks: [], callProcessExit: true });
    const processed = recordExitProcess(logger);
    logger.on<{ eventType: string }>('logger', ({ eventType }) => {
      if (eventType === 'exit-process') {
        logger.exit(1);
      }
    });
    logger.exit(0);
    await logger.close();
    await Promise.resolve();

    expect(processed).toEqual([0]);
    expect(logger.exitCode).toBe(0);
    expect(exit.mock.calls).toEqual([[0]]);
    expect(output.mock.calls.map((call) => String(call[0]))).toEqual([
      'Logger exit(1) ignored: an exit with code 0 is already processing',
    ]);
  } finally {
    output.mockRestore();
    exit.mockRestore();
  }
});

test('the last failure exit replaces an earlier one, and a success does not downgrade it', async () => {
  const exit = spyOn(process, 'exit').mockImplementation(
    () => undefined as never,
  );
  const output = spyOn(console, 'error').mockImplementation(() => {});
  try {
    const logger = new Logger({
      sinks: [],
      callProcessExit: true,
      beforeExitCallback: async (_code, isFirstExit) => {
        if (!isFirstExit) {
          return { action: 'wait' };
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { action: 'proceed' };
      },
    });
    const processed = recordExitProcess(logger);
    const completed = nextLoggerEvent(logger, 'exit-completed');
    logger.exit(2);
    logger.exit(0);
    logger.exit(1);
    logger.exit(1);
    await completed;

    expect(processed).toEqual([1]);
    expect(logger.exitCode).toBe(1);
    expect(exit.mock.calls).toEqual([[1]]);
    // The success and the repeat of the pending code change nothing, so only the
    // replacement is reported.
    expect(output.mock.calls.map((call) => String(call[0]))).toEqual([
      'Logger exit(1) replaces the pending exit code 2',
    ]);
  } finally {
    output.mockRestore();
    exit.mockRestore();
  }
});

test('a pending failure applies to an exit that turns out simulated, and not to the next exit', async () => {
  const output = spyOn(console, 'error').mockImplementation(() => {});
  const actualExit = Object.getOwnPropertyDescriptor(process, 'exit');
  try {
    const calls: number[] = [];
    const stub = ((code?: number) => {
      calls.push(code ?? 0);
    }) as typeof process.exit;
    let shouldWait = true;
    const logger = new Logger({
      sinks: [],
      callProcessExit: true,
      beforeExitCallback: () =>
        shouldWait ? { action: 'wait' } : { action: 'proceed' },
    });
    const processed = recordExitProcess(logger);
    // A real failure request, left pending.
    process.exit = stub;
    logger.exit(1);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Simulated from here: no callable process.exit. The success does not downgrade the
    // pending failure, and the exit that proceeds commits it.
    (process as { exit?: unknown }).exit = undefined;
    shouldWait = false;
    logger.exit(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(processed).toEqual([1]);
    expect(logger.exitCode).toBe(1);

    // The commit used the pending code up: the next exit starts from its own.
    process.exit = stub;
    logger.exit(0);
    await logger.close();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(processed).toEqual([1, 0]);
    expect(logger.exitCode).toBe(0);
    expect(calls).toEqual([0]);
    expect(output).not.toHaveBeenCalled();
  } finally {
    if (actualExit !== undefined) {
      Object.defineProperty(process, 'exit', actualExit);
    }
    output.mockRestore();
  }
});

// A simulated logger whose first exit runs a short shutdown and proceeds, answering
// 'wait' for every exit requested while it runs - the shape `LifecycleManager` gives it.
function simulatedShutdownLogger(
  duringShutdown: (logger: Logger) => void = () => {},
): Logger {
  const logger: Logger = new Logger({
    sinks: [],
    callProcessExit: false,
    beforeExitCallback: async (_code, isFirstExit) => {
      if (!isFirstExit) {
        return { action: 'wait' };
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
      duringShutdown(logger);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { action: 'proceed' };
    },
  });
  return logger;
}

test('a simulated failure exit beforeExit waits out behind a pending success exit replaces its code', async () => {
  // The SIGTERM shape under `callProcessExit: false`: it exited 0 while the real exit
  // exited 1, so a test of the shutdown passed where production failed.
  const output = spyOn(console, 'error').mockImplementation(() => {});
  try {
    const logger = simulatedShutdownLogger((shuttingDown) => {
      shuttingDown.error('component failed to stop', { exitCode: 1 });
    });
    const processed = recordExitProcess(logger);
    const completed = nextLoggerEvent(logger, 'exit-completed');
    logger.exit(0);
    await completed;

    expect(processed).toEqual([1]);
    expect(logger.didExit).toBe(true);
    expect(logger.exitCode).toBe(1);
    expect(output.mock.calls.map((call) => String(call[0]))).toEqual([
      'Logger exit(1) replaces the pending exit code 0',
    ]);
  } finally {
    output.mockRestore();
  }
});

test.each<[string, number[], number, string[]]>([
  [
    'a later failure replaces an earlier one',
    [2, 1],
    1,
    ['Logger exit(1) replaces the pending exit code 2'],
  ],
  ['a success does not downgrade a failure', [1, 0], 1, []],
  [
    // Not normalized when simulated, and not 0, so a failure; a repeat is no change.
    'NaN counts as a failure',
    [0, NaN, 0, NaN],
    NaN,
    ['Logger exit(NaN) replaces the pending exit code 0'],
  ],
  [
    'a code a real exit would normalize is kept as requested',
    [0, 300],
    300,
    ['Logger exit(300) replaces the pending exit code 0'],
  ],
])(
  'overlapping simulated exits: %s',
  async (_name, requests, settledCode, lines) => {
    const output = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const logger = simulatedShutdownLogger();
      const processed = recordExitProcess(logger);
      const completed = nextLoggerEvent(logger, 'exit-completed');
      for (const code of requests) {
        logger.exit(code);
      }
      await completed;

      expect(processed).toEqual([settledCode]);
      expect(logger.exitCode).toEqual(settledCode);
      expect(output.mock.calls.map((call) => String(call[0]))).toEqual(lines);
    } finally {
      output.mockRestore();
    }
  },
);

test('overlapping simulated exits that both proceed publish the settled code once', async () => {
  const output = spyOn(console, 'error').mockImplementation(() => {});
  try {
    const answers = recordAnswers(async (code) => {
      if (code !== 0) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return { action: 'proceed' };
    });
    const logger = new Logger({
      sinks: [],
      callProcessExit: false,
      beforeExitCallback: answers.callback,
    });
    const processed = recordExitProcess(logger);
    const completed = nextLoggerEvent(logger, 'exit-completed');
    // As with a real exit, the success proceeds first and commits the pending failure;
    // the failure, proceeding later, was already folded into it.
    logger.exit(1);
    logger.exit(0);
    await completed;
    await answers.settled();

    expect(processed).toEqual([1]);
    expect(logger.exitCode).toBe(1);
    expect(output).not.toHaveBeenCalled();
  } finally {
    output.mockRestore();
  }
});

test('a simulated exit requested after an earlier one completed starts fresh', async () => {
  const output = spyOn(console, 'error').mockImplementation(() => {});
  try {
    const logger = new Logger({ sinks: [], callProcessExit: false });
    const processed = recordExitProcess(logger);
    // Each exit is allowed to finish closing before the next is requested: one requested
    // while it still closes belongs to it, as behind a real exit.
    const completed = (): Promise<void> =>
      new Promise((resolve) => setTimeout(resolve, 0));
    logger.exit(0);
    await completed();
    // Each later exit publishes its own code: the process is still running, so the
    // failure is not ignored behind the earlier success, and the success after it does
    // not inherit it.
    logger.exit(1);
    await completed();
    logger.exit(0);
    await completed();

    expect(processed).toEqual([0, 1, 0]);
    expect(logger.exitCode).toBe(0);
    expect(output).not.toHaveBeenCalled();
  } finally {
    output.mockRestore();
  }
});

test('an invalid exit absorbed by a scheduled exit does not claim to exit with 1', async () => {
  const exit = spyOn(process, 'exit').mockImplementation(
    () => undefined as never,
  );
  const output = spyOn(console, 'error').mockImplementation(() => {});
  try {
    const logger = new Logger({ sinks: [], callProcessExit: true });
    logger.exit(0);
    logger.exit(300);
    await logger.close();
    await Promise.resolve();

    const lines = output.mock.calls.map((call) => String(call[0]));
    // Said "exiting with code 1" while the process went on to exit 0.
    expect(lines).toEqual([
      'Logger exit code 300 is invalid; treating it as code 1',
      'Logger exit(300) ignored: an exit with code 0 is already processing',
    ]);
    expect(exit.mock.calls).toEqual([[0]]);
  } finally {
    output.mockRestore();
    exit.mockRestore();
  }
});

test('a failure exitCode logged after a real exit committed 0 is reported as ignored, not dropped', async () => {
  const exit = spyOn(process, 'exit').mockImplementation(
    () => undefined as never,
  );
  const output = spyOn(console, 'error').mockImplementation(() => {});
  try {
    const sink = new ArraySink();
    const logger = new Logger({ sinks: [sink], callProcessExit: true });
    logger.exit(0);
    // The commit closed the logger synchronously; this entry is not written, but its
    // exit request still reaches `exit()`.
    logger.error('component failed after the exit committed', {
      exitCode: 1,
    });
    await logger.close();
    await Promise.resolve();

    expect(sink.logs.map((entry) => entry.message)).toEqual([]);
    expect(exit.mock.calls).toEqual([[0]]);
    expect(output.mock.calls.map((call) => String(call[0]))).toEqual([
      'Logger exit(1) ignored: an exit with code 0 is already processing',
    ]);
  } finally {
    output.mockRestore();
    exit.mockRestore();
  }
});

test('a failure exitCode logged after a simulated exit completed starts the next exit', async () => {
  const beforeExitCodes: number[] = [];
  const logger = new Logger({
    sinks: [],
    callProcessExit: false,
    beforeExitCallback: (code) => {
      beforeExitCodes.push(code);
      return { action: 'proceed' };
    },
  });
  const processed = recordExitProcess(logger);
  logger.exit(0);
  await logger.close();
  // The exit proceeds after `beforeExitCallback` settles, so its cleanup completes a
  // turn after this close() call's; a request before then would belong to it.
  await new Promise((resolve) => setTimeout(resolve, 0));

  logger.error('fatal after the first exit', { exitCode: 1 });
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(beforeExitCodes).toEqual([0, 1]);
  expect(processed).toEqual([0, 1]);
  expect(logger.exitCode).toBe(1);
});

// A logger whose one sink logs `exitCode` from its own `close()`, as a component that
// reports its shutdown through the logger does, recording what the exit published.
function exitLoggingFromSinkClose(
  shouldCallProcessExit: boolean,
  closeExitCode: number,
): {
  logger: Logger;
  processed: number[];
  exitCalled: number[];
  beforeExitCodes: number[];
} {
  const self: { logger?: Logger } = {};
  const sink: LogSink = {
    write: () => {},
    close: () => {
      self.logger?.info('bye', { exitCode: closeExitCode });
    },
  };
  const beforeExitCodes: number[] = [];
  const logger = new Logger({
    sinks: [sink],
    callProcessExit: shouldCallProcessExit,
    beforeExitCallback: (code) => {
      beforeExitCodes.push(code);
      return { action: 'proceed' };
    },
  });
  self.logger = logger;
  const processed = recordExitProcess(logger);
  const exitCalled: number[] = [];
  logger.on<{ eventType: string; code: number }>(
    'logger',
    ({ eventType, code }) => {
      if (eventType === 'exit-called') {
        exitCalled.push(code);
      }
    },
  );
  return { logger, processed, exitCalled, beforeExitCodes };
}

test.each([false, true])(
  'a sink close logging exitCode 0 during exit(1) cannot downgrade it (callProcessExit: %p)',
  async (shouldCallProcessExit) => {
    // Simulated, the close's request started a new exit that committed 0, so
    // `logger.exitCode` read 0 where the real exit it stands in for exits 1.
    const exit = spyOn(process, 'exit').mockImplementation(
      () => undefined as never,
    );
    const output = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { logger, processed, exitCalled, beforeExitCodes } =
        exitLoggingFromSinkClose(shouldCallProcessExit, 0);
      logger.exit(1);
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(processed).toEqual([1]);
      expect(logger.exitCode).toBe(1);
      expect(logger.isPendingExit).toBe(false);
      // Ignored, so it started nothing of its own.
      expect(exitCalled).toEqual([1]);
      expect(beforeExitCodes).toEqual([1]);
      expect(exit.mock.calls).toEqual(shouldCallProcessExit ? [[1]] : []);
      expect(output).not.toHaveBeenCalled();
    } finally {
      output.mockRestore();
      exit.mockRestore();
    }
  },
);

test.each([false, true])(
  'a sink close logging exitCode 1 during exit(0) is reported as ignored (callProcessExit: %p)',
  async (shouldCallProcessExit) => {
    const exit = spyOn(process, 'exit').mockImplementation(
      () => undefined as never,
    );
    const output = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { logger, processed, exitCalled, beforeExitCodes } =
        exitLoggingFromSinkClose(shouldCallProcessExit, 1);
      logger.exit(0);
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(processed).toEqual([0]);
      expect(logger.exitCode).toBe(0);
      expect(exitCalled).toEqual([0]);
      expect(beforeExitCodes).toEqual([0]);
      expect(exit.mock.calls).toEqual(shouldCallProcessExit ? [[0]] : []);
      expect(output.mock.calls.map((call) => String(call[0]))).toEqual([
        'Logger exit(1) ignored: an exit with code 0 is already processing',
      ]);
    } finally {
      output.mockRestore();
      exit.mockRestore();
    }
  },
);

test('an exit ignored behind a committed real exit emits no exit-called and runs no beforeExit', async () => {
  // `isPendingExit` says such a request starts nothing, yet it still emitted
  // `exit-called` and called `beforeExitCallback` for an exit that never runs.
  const exit = spyOn(process, 'exit').mockImplementation(
    () => undefined as never,
  );
  const output = spyOn(console, 'error').mockImplementation(() => {});
  try {
    const { logger, processed, exitCalled, beforeExitCodes } =
      exitLoggingFromSinkClose(true, 0);
    logger.exit(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Committed, with `process.exit()` stubbed: the latch stays, as it would in a
    // process that was really on its way out.
    logger.exit(2);
    logger.error('after the exit', { exitCode: 3 });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(exitCalled).toEqual([1]);
    expect(beforeExitCodes).toEqual([1]);
    expect(processed).toEqual([1]);
    expect(logger.isPendingExit).toBe(false);
    expect(exit.mock.calls).toEqual([[1]]);
    expect(output).not.toHaveBeenCalled();
  } finally {
    output.mockRestore();
    exit.mockRestore();
  }
});

test('a failure exitCode logged after close() while an exit is pending replaces its code', async () => {
  const output = spyOn(console, 'error').mockImplementation(() => {});
  try {
    const logger = simulatedShutdownLogger((shuttingDown) => {
      void shuttingDown.close();
      shuttingDown.error('component failed to stop', { exitCode: 1 });
    });
    const processed = recordExitProcess(logger);
    const completed = nextLoggerEvent(logger, 'exit-completed');
    logger.exit(0);
    await completed;

    expect(processed).toEqual([1]);
    expect(logger.exitCode).toBe(1);
    expect(output.mock.calls.map((call) => String(call[0]))).toEqual([
      'Logger exit(1) replaces the pending exit code 0',
    ]);
  } finally {
    output.mockRestore();
  }
});

test('isPendingExit holds for every pending exit, including a later simulated one', async () => {
  const logger = simulatedShutdownLogger();
  expect(logger.isPendingExit).toBe(false);
  const completed = nextLoggerEvent(logger, 'exit-completed');

  logger.exit(0);
  expect(logger.isPendingExit).toBe(true);
  expect(logger.hasExitedOrPending).toBe(true);
  await completed;
  expect(logger.isPendingExit).toBe(false);
  expect(logger.didExit).toBe(true);
  expect(logger.exitCode).toBe(0);

  // `isFirstExit` is false from here, so this logger's callback answers 'wait' and the
  // exit stays pending until another request proceeds.
  logger.exit(1);
  expect(logger.isPendingExit).toBe(true);
  // The previous exit's code until this one commits.
  expect(logger.exitCode).toBe(0);
});

test('pendingExitCode reads the code the pending exit settles on', async () => {
  const output = spyOn(console, 'error').mockImplementation(() => {});
  try {
    const seenByCallback: Array<[number, number | undefined]> = [];
    const logger: Logger = new Logger({
      sinks: [],
      callProcessExit: false,
      beforeExitCallback: async (code, isFirstExit) => {
        seenByCallback.push([code, logger.pendingExitCode]);
        if (!isFirstExit) {
          return { action: 'wait' };
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { action: 'proceed' };
      },
    });
    expect(logger.pendingExitCode).toBeUndefined();
    const completed = nextLoggerEvent(logger, 'exit-completed');

    logger.exit(0);
    expect(logger.pendingExitCode).toBe(0);
    // Overlapping requests settle on the last non-zero code; a later 0 does not
    // downgrade it.
    logger.exit(2);
    expect(logger.pendingExitCode).toBe(2);
    logger.exit(3);
    logger.exit(0);
    expect(logger.pendingExitCode).toBe(3);
    // Each callback sees its own request's code, and the code the exit will use.
    expect(seenByCallback).toEqual([
      [0, 0],
      [2, 2],
      [3, 3],
      [0, 3],
    ]);

    await completed;
    expect(logger.exitCode).toBe(3);
    expect(logger.pendingExitCode).toBeUndefined();
  } finally {
    output.mockRestore();
  }
});

test('a code kept by a simulated request is normalized when the exit commits as real', async () => {
  const output = spyOn(console, 'error').mockImplementation(() => {});
  const actualExit = Object.getOwnPropertyDescriptor(process, 'exit');
  try {
    const calls: number[] = [];
    const stub = ((code?: number) => {
      calls.push(code ?? 0);
    }) as typeof process.exit;
    let proceed!: () => void;
    const logger = new Logger({
      sinks: [],
      callProcessExit: true,
      beforeExitCallback: () =>
        new Promise((resolve) => {
          proceed = () => resolve({ action: 'proceed' });
        }),
    });
    const processed = recordExitProcess(logger);
    // Simulated when requested: no callable process.exit, so 256 is kept as written.
    (process as { exit?: unknown }).exit = undefined;
    logger.exit(256);
    // Real by the time it commits. Unnormalized, 256 would wrap to status 0.
    process.exit = stub;
    proceed();
    await logger.close();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(processed).toEqual([1]);
    expect(logger.exitCode).toBe(1);
    expect(calls).toEqual([1]);
    expect(output.mock.calls.map((call) => String(call[0]))).toEqual([
      'Logger exit code 256 is invalid for a real exit; exiting with code 1',
    ]);
  } finally {
    if (actualExit !== undefined) {
      Object.defineProperty(process, 'exit', actualExit);
    }
    output.mockRestore();
  }
});

test('replacement reports are bounded to one line per exit plus a settled-code summary', async () => {
  const output = spyOn(console, 'error').mockImplementation(() => {});
  try {
    const logger = simulatedShutdownLogger();
    const processed = recordExitProcess(logger);
    const completed = nextLoggerEvent(logger, 'exit-completed');
    for (const code of [0, 1, 2, 1, 2, 3]) {
      logger.exit(code);
    }
    await completed;

    expect(processed).toEqual([3]);
    expect(output.mock.calls.map((call) => String(call[0]))).toEqual([
      'Logger exit(1) replaces the pending exit code 0',
      'Logger exit code settled on 3 after 4 further replacements not reported',
    ]);
  } finally {
    output.mockRestore();
  }
});

test('a NaN exitCode on a log entry exits as a real exit(NaN) does', async () => {
  const exit = spyOn(process, 'exit').mockImplementation(
    () => undefined as never,
  );
  const output = spyOn(console, 'error').mockImplementation(() => {});
  try {
    const sink = new ArraySink();
    const logger = new Logger({ sinks: [sink], callProcessExit: true });
    // Ignored before: no exit, no report, and `entry.exitCode` undefined, though a
    // direct `exit(NaN)` fails with 1.
    logger.error('fatal', { exitCode: NaN });
    await logger.close();
    await Promise.resolve();

    expect(sink.logs[0]?.exitCode).toBe(1);
    expect(logger.didExit).toBe(true);
    expect(exit.mock.calls).toEqual([[1]]);
    expect(output.mock.calls.map((call) => String(call[0]))).toEqual([
      'Logger exit code NaN is invalid; treating it as code 1',
    ]);
  } finally {
    output.mockRestore();
    exit.mockRestore();
  }
});

test('a NaN exitCode on a log entry starts a simulated exit that keeps the code', async () => {
  const sink = new ArraySink();
  const logger = new Logger({ sinks: [sink], callProcessExit: false });
  const processed = recordExitProcess(logger);
  logger.error('fatal', { exitCode: NaN });
  await logger.close();

  expect(sink.logs[0]?.exitCode).toBeNaN();
  expect(logger.didExit).toBe(true);
  expect(processed).toEqual([NaN]);

  // Once closed, the request still reaches `exit()` and starts the next exit.
  logger.error('fatal after the first exit', { exitCode: NaN });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(processed).toEqual([NaN, NaN]);
});

test('a failure exit requested by a simulated exit-process listener is reported, not applied', async () => {
  const output = spyOn(console, 'error').mockImplementation(() => {});
  try {
    const logger = new Logger({ sinks: [], callProcessExit: false });
    const processed = recordExitProcess(logger);
    logger.on<{ eventType: string }>('logger', ({ eventType }) => {
      if (eventType === 'exit-process') {
        logger.exit(1);
      }
    });
    logger.exit(0);
    await logger.close();

    expect(processed).toEqual([0]);
    expect(logger.exitCode).toBe(0);
    // Dropped silently before, while the real exit reported the same request.
    expect(output.mock.calls.map((call) => String(call[0]))).toEqual([
      'Logger exit(1) ignored: an exit with code 0 is already processing',
    ]);
  } finally {
    output.mockRestore();
  }
});
