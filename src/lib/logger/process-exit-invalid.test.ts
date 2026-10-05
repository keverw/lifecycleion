import { expect, spyOn, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger } from './index';

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
