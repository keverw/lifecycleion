import { expect, spyOn, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArraySink, Logger } from './index';

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
      entrypoints: [new URL('./index.ts', import.meta.url).pathname],
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
      expect(output).toHaveBeenCalledTimes(1);
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

test('an exit skipped because process.exit disappeared keeps later exits from re-emitting', async () => {
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
          // Removed after the exit was scheduled, so finish finds nothing to call.
          (process as { exit?: unknown }).exit = undefined;
        }
      },
    );

    logger.exit(1);
    await logger.close();
    await Promise.resolve();

    expect(output.mock.calls.flat().join('\n')).toContain(
      'process.exit is no longer callable',
    );

    // Back again: a later exit still owns no second exit-process or process.exit().
    process.exit = stub;
    logger.exit(2);
    await logger.close();
    await Promise.resolve();

    expect(processed).toEqual([1]);
    expect(logger.exitCode).toBe(1);
    expect(calls).toEqual([]);
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

  expect(called).toEqual([1]);
  expect(logger.exitCode).toBe(1);
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

    // The first exit owns the code; the failure request is not lost silently.
    expect(exit.mock.calls).toEqual([[0]]);
    expect(output).toHaveBeenCalledTimes(1);
    expect(String(output.mock.calls[0]?.[0])).toContain(
      'Logger exit(1) ignored: an exit with code 0 is already in progress',
    );
  } finally {
    output.mockRestore();
    exit.mockRestore();
  }
});

test('a failure exit whose beforeExit loses the race to a success exit is reported', async () => {
  const exit = spyOn(process, 'exit').mockImplementation(
    () => undefined as never,
  );
  const output = spyOn(console, 'error').mockImplementation(() => {});
  try {
    const logger = new Logger({
      sinks: [],
      callProcessExit: true,
      beforeExitCallback: async (code) => {
        if (code !== 0) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        return { action: 'proceed' };
      },
    });
    // Neither is scheduled when the other is requested, so only processExit sees it.
    logger.exit(1);
    logger.exit(0);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(exit.mock.calls).toEqual([[0]]);
    expect(output.mock.calls.flat().join('\n')).toContain(
      'Logger exit(1) ignored',
    );
  } finally {
    output.mockRestore();
    exit.mockRestore();
  }
});

test('an exit-called listener that requests a failure during a success exit is reported', async () => {
  const exit = spyOn(process, 'exit').mockImplementation(
    () => undefined as never,
  );
  const output = spyOn(console, 'error').mockImplementation(() => {});
  try {
    const logger = new Logger({ sinks: [], callProcessExit: true });
    logger.on<{ eventType: string }>('logger', ({ eventType }) => {
      if (eventType === 'exit-called') {
        logger.exit(1);
      }
    });
    logger.exit(0);
    await logger.close();
    await Promise.resolve();

    expect(exit.mock.calls).toEqual([[0]]);
    expect(output.mock.calls.flat().join('\n')).toContain(
      'Logger exit(1) ignored',
    );
  } finally {
    output.mockRestore();
    exit.mockRestore();
  }
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

test('an exit-called listener during a repeat exit is judged against the scheduled code', async () => {
  const exit = spyOn(process, 'exit').mockImplementation(
    () => undefined as never,
  );
  const output = spyOn(console, 'error').mockImplementation(() => {});
  try {
    const logger = new Logger({ sinks: [], callProcessExit: true });
    logger.exit(1);
    // The repeat's own code is 0, but the process exits 1: the nested failure request
    // changes nothing, so it is not reported as ignored behind a success.
    logger.on<{ eventType: string }>('logger', ({ eventType }) => {
      if (eventType === 'exit-called') {
        logger.exit(5);
      }
    });
    logger.exit(0);
    await logger.close();
    await Promise.resolve();

    expect(exit.mock.calls).toEqual([[1]]);
    expect(output).not.toHaveBeenCalled();
  } finally {
    output.mockRestore();
    exit.mockRestore();
  }
});

test('a failure exit beforeExit waits out behind a pending success exit is reported', async () => {
  // SIGTERM's `exit(0)` is still stopping components when one fails and logs
  // `exitCode: 1`; `LifecycleManager` answers 'wait' for it. Nothing had scheduled when
  // the failure arrived, so the check in `exit()` never saw an owner, and the process
  // exited 0 with nothing on stderr.
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
    logger.exit(0);
    await new Promise((resolve) => setTimeout(resolve, 30));

    // The owning exit keeps its code, as documented, but the failure is not silent.
    expect(exit.mock.calls).toEqual([[0]]);
    expect(output).toHaveBeenCalledTimes(1);
    expect(String(output.mock.calls[0]?.[0])).toContain(
      'Logger exit(1) ignored: an exit with code 0 is already in progress',
    );
  } finally {
    output.mockRestore();
    exit.mockRestore();
  }
});

test('a failure exit beforeExit waits out after a success exit scheduled is reported', async () => {
  const exit = spyOn(process, 'exit').mockImplementation(
    () => undefined as never,
  );
  const output = spyOn(console, 'error').mockImplementation(() => {});
  try {
    const logger = new Logger({
      sinks: [],
      callProcessExit: true,
      beforeExitCallback: async (code) => {
        if (code === 0) {
          return { action: 'proceed' };
        }
        // Answers only once the success exit has scheduled.
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { action: 'wait' };
      },
    });
    logger.exit(0);
    logger.exit(1);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(exit.mock.calls).toEqual([[0]]);
    expect(output.mock.calls.flat().join('\n')).toContain(
      'Logger exit(1) ignored',
    );
  } finally {
    output.mockRestore();
    exit.mockRestore();
  }
});

test('a success exit beforeExit waits out is not reported, nor is a waited failure that owns the process', async () => {
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
    logger.exit(2);
    logger.exit(0);
    logger.exit(1);
    await new Promise((resolve) => setTimeout(resolve, 20));

    // The process fails either way, so nothing a supervisor reads was dropped.
    expect(exit.mock.calls).toEqual([[2]]);
    expect(output).not.toHaveBeenCalled();
  } finally {
    output.mockRestore();
    exit.mockRestore();
  }
});

test('a simulated exit does not carry a waited failure into a later exit', async () => {
  const output = spyOn(console, 'error').mockImplementation(() => {});
  const actualExit = Object.getOwnPropertyDescriptor(process, 'exit');
  try {
    let shouldWait = true;
    const logger = new Logger({
      sinks: [],
      callProcessExit: true,
      beforeExitCallback: () =>
        shouldWait ? { action: 'wait' } : { action: 'proceed' },
    });
    // Simulated: no callable process.exit, so the waited failure must not linger.
    (process as { exit?: unknown }).exit = undefined;
    logger.exit(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    shouldWait = false;
    logger.exit(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(logger.exitCode).toBe(0);

    const calls: number[] = [];
    process.exit = ((code?: number) => {
      calls.push(code ?? 0);
    }) as typeof process.exit;
    logger.exit(0);
    await logger.close();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(calls).toEqual([0]);
    expect(output).not.toHaveBeenCalled();
  } finally {
    if (actualExit !== undefined) {
      Object.defineProperty(process, 'exit', actualExit);
    }
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
      'Logger exit(300) ignored: an exit with code 0 is already in progress',
    ]);
    expect(exit.mock.calls).toEqual([[0]]);
  } finally {
    output.mockRestore();
    exit.mockRestore();
  }
});
