import { expect, spyOn, test } from 'bun:test';
import { ArraySink, Logger, type LogSink } from './index';

interface ExitEvent {
  eventType: string;
  code?: number;
  endedProcess?: boolean;
}

// A sink whose close is held open until `release()`, so a test can look inside the
// window between `exit-process` and the end of sink cleanup.
function gatedSink(): { sink: LogSink; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  return {
    sink: { write: (): void => {}, close: (): Promise<void> => gate },
    release,
  };
}

// Every exit event, with `isFinishingExit` as each listener saw it.
function recordExitEvents(
  logger: Logger,
): { event: ExitEvent; isFinishingExit: boolean }[] {
  const events: { event: ExitEvent; isFinishingExit: boolean }[] = [];
  logger.on<ExitEvent>('logger', (event) => {
    if (event.eventType.startsWith('exit-')) {
      events.push({ event, isFinishingExit: logger.isFinishingExit });
    }
  });

  return events;
}

function completions(
  events: { event: ExitEvent }[],
): { code?: number; endedProcess?: boolean }[] {
  return events
    .filter(({ event }) => event.eventType === 'exit-completed')
    .map(({ event }) => ({
      code: event.code,
      endedProcess: event.endedProcess,
    }));
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  expect(condition()).toBe(true);
}

test('a simulated exit emits exit-completed once, after its sink cleanup settles, with the settled code', async () => {
  const { sink, release } = gatedSink();
  let releaseBeforeExit!: () => void;
  const beforeExitGate = new Promise<void>((resolve) => {
    releaseBeforeExit = resolve;
  });
  const output = spyOn(console, 'error').mockImplementation(() => {});
  const logger = new Logger({
    sinks: [new ArraySink(), sink],
    callProcessExit: false,
    beforeExitCallback: async (_code, isFirstExit) => {
      if (!isFirstExit) {
        return { action: 'wait' };
      }
      await beforeExitGate;
      return { action: 'proceed' };
    },
  });
  const events = recordExitEvents(logger);

  try {
    logger.exit(0);
    // Joins the pending exit and replaces its code.
    logger.exit(2);
    releaseBeforeExit();
    await waitFor(() => logger.didExit);

    // `exit-process` has fired; cleanup is still held open.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(completions(events)).toEqual([]);

    release();
    await waitFor(() => completions(events).length > 0);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(events.map(({ event }) => event.eventType)).toEqual([
      'exit-called',
      'exit-called',
      'exit-process',
      'exit-completed',
    ]);
    expect(completions(events)).toEqual([{ code: 2, endedProcess: false }]);
    expect(logger.exitCode).toBe(2);
  } finally {
    release();
    releaseBeforeExit();
    output.mockRestore();
  }
});

test('isFinishingExit is true exactly from exit-process until exit-completed', async () => {
  const { sink, release } = gatedSink();
  const logger = new Logger({ sinks: [sink], callProcessExit: false });
  const events = recordExitEvents(logger);

  try {
    expect(logger.isFinishingExit).toBe(false);
    logger.exit(1);
    expect(logger.isFinishingExit).toBe(true);
    expect(logger.isPendingExit).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(logger.isFinishingExit).toBe(true);

    release();
    await waitFor(() => completions(events).length > 0);

    expect(logger.isFinishingExit).toBe(false);
    expect(
      events.map(({ event, isFinishingExit }) => [
        event.eventType,
        isFinishingExit,
      ]),
    ).toEqual([
      ['exit-called', false],
      ['exit-process', true],
      ['exit-completed', false],
    ]);
  } finally {
    release();
  }
});

test('a real exit emits exit-completed with endedProcess: true right before process.exit()', async () => {
  const order: string[] = [];
  const exit = spyOn(process, 'exit').mockImplementation(((code?: number) => {
    order.push(`process.exit(${String(code)})`);
  }) as typeof process.exit);

  try {
    const logger = new Logger({ sinks: [], callProcessExit: true });
    let exitCalled = 0;
    logger.on<ExitEvent>('logger', (event) => {
      if (event.eventType === 'exit-called') {
        exitCalled++;
      }
      if (event.eventType === 'exit-completed') {
        order.push(
          `exit-completed(${String(event.code)}, ${String(event.endedProcess)})`,
        );
        // Ignored: this exit has already scheduled process.exit().
        logger.exit(7);
      }
    });

    logger.exit(3);
    await waitFor(() => order.length >= 2);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(order).toEqual(['exit-completed(3, true)', 'process.exit(3)']);
    expect(exitCalled).toBe(1);
    expect(logger.exitCode).toBe(3);
  } finally {
    exit.mockRestore();
  }
});

test('a real exit that finds process.exit gone emits exit-completed with endedProcess: false', async () => {
  const actualExit = Object.getOwnPropertyDescriptor(process, 'exit');
  const calls: number[] = [];
  const output = spyOn(console, 'error').mockImplementation(() => {});
  process.exit = ((code?: number) => {
    calls.push(code ?? 0);
  }) as typeof process.exit;

  try {
    const logger = new Logger({ sinks: [], callProcessExit: true });
    const events = recordExitEvents(logger);
    logger.on<ExitEvent>('logger', ({ eventType }) => {
      if (eventType === 'exit-process') {
        (process as { exit?: unknown }).exit = undefined;
      }
    });

    logger.exit(4);
    await waitFor(() => completions(events).length > 0);

    expect(completions(events)).toEqual([{ code: 4, endedProcess: false }]);
    expect(calls).toEqual([]);
    expect(output.mock.calls.flat().join('\n')).toContain(
      'process.exit is no longer callable',
    );
  } finally {
    if (actualExit) {
      Object.defineProperty(process, 'exit', actualExit);
    }
    output.mockRestore();
  }
});

test('exit-completed fires when sink cleanup fails', async () => {
  const output = spyOn(console, 'error').mockImplementation(() => {});
  const logger = new Logger({ sinks: [], callProcessExit: false });
  const events = recordExitEvents(logger);
  const close = spyOn(logger, 'close').mockImplementation(() =>
    Promise.reject(new Error('cleanup broke')),
  );

  try {
    logger.exit(5);
    await waitFor(() => completions(events).length > 0);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(completions(events)).toEqual([{ code: 5, endedProcess: false }]);
    expect(logger.isFinishingExit).toBe(false);
    expect(output.mock.calls.map((call) => String(call[0]))).toEqual([
      'Logger cleanup failed before exit: cleanup broke',
    ]);
  } finally {
    close.mockRestore();
    output.mockRestore();
  }
});

test('an exit() from an exit-completed listener starts the next simulated exit', async () => {
  const logger = new Logger({
    sinks: [new ArraySink()],
    callProcessExit: false,
  });
  const events = recordExitEvents(logger);
  logger.on<ExitEvent>('logger', ({ eventType }) => {
    if (eventType === 'exit-completed' && completions(events).length === 1) {
      logger.exit(6);
    }
  });

  logger.exit(0);
  await waitFor(() => completions(events).length === 2);
  await new Promise((resolve) => setTimeout(resolve, 10));

  expect(events.map(({ event }) => [event.eventType, event.code])).toEqual([
    ['exit-called', 0],
    ['exit-process', 0],
    ['exit-completed', 0],
    ['exit-called', 6],
    ['exit-process', 6],
    ['exit-completed', 6],
  ]);
  expect(logger.exitCode).toBe(6);
  expect(logger.isFinishingExit).toBe(false);
});

test('an emit override that throws on exit-completed still lets a real exit call process.exit()', async () => {
  const calls: unknown[] = [];
  const exit = spyOn(process, 'exit').mockImplementation(((code?: number) => {
    calls.push(code);
  }) as typeof process.exit);
  const output = spyOn(console, 'error').mockImplementation(() => {});

  try {
    const logger = new Logger({ sinks: [], callProcessExit: true });
    const originalEmit = logger.emit.bind(logger);
    spyOn(logger, 'emit').mockImplementation((event, data) => {
      if ((data as ExitEvent | undefined)?.eventType === 'exit-completed') {
        throw new Error('completion event unavailable');
      }
      originalEmit(event, data);
    });

    logger.exit(2);
    await waitFor(() => calls.length > 0);

    expect(calls).toEqual([2]);
    expect(output.mock.calls.map((call) => String(call[0]))).toEqual([
      'Logger exit-completed event failed: completion event unavailable',
    ]);
  } finally {
    exit.mockRestore();
    output.mockRestore();
  }
});

test('an emit override that throws on exit-process still completes the exit', async () => {
  const output = spyOn(console, 'error').mockImplementation(() => {});
  const logger = new Logger({
    sinks: [new ArraySink()],
    callProcessExit: false,
  });
  const events = recordExitEvents(logger);
  const originalEmit = logger.emit.bind(logger);
  const emit = spyOn(logger, 'emit').mockImplementation((event, data) => {
    if ((data as ExitEvent | undefined)?.eventType === 'exit-process') {
      throw new Error('process event unavailable');
    }
    originalEmit(event, data);
  });

  try {
    expect(() => logger.exit(3)).not.toThrow();
    await waitFor(() => completions(events).length > 0);

    expect(completions(events)).toEqual([{ code: 3, endedProcess: false }]);
    expect(logger.isFinishingExit).toBe(false);
    expect(output.mock.calls.map((call) => String(call[0]))).toEqual([
      'Logger exit-process event failed: process event unavailable',
    ]);

    // The exit is over, so the next one is processed rather than ignored.
    logger.exit(4);
    await waitFor(() => completions(events).length > 1);
    expect(logger.exitCode).toBe(4);
  } finally {
    emit.mockRestore();
    output.mockRestore();
  }
});

test('a close override that throws synchronously still completes the exit', async () => {
  const output = spyOn(console, 'error').mockImplementation(() => {});
  const logger = new Logger({ sinks: [], callProcessExit: false });
  const events = recordExitEvents(logger);
  const close = spyOn(logger, 'close').mockImplementation(() => {
    throw new Error('cleanup refused');
  });

  try {
    expect(() => logger.exit(5)).not.toThrow();
    await waitFor(() => completions(events).length > 0);

    expect(completions(events)).toEqual([{ code: 5, endedProcess: false }]);
    expect(logger.isFinishingExit).toBe(false);
    expect(output.mock.calls.map((call) => String(call[0]))).toEqual([
      'Logger cleanup failed before exit: cleanup refused',
    ]);
  } finally {
    close.mockRestore();
    output.mockRestore();
  }
});
