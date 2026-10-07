import { expect, spyOn, test } from 'bun:test';
import { Logger } from './index';
import { FileSink } from './sinks/file';
import { ArraySink } from './sinks/array';
import { NamedPipeSink } from './sinks/named-pipe';
import { ConsoleSink } from './sinks/console';
import type { LogEntry } from './types';
import { TmpDir } from '../tmp-dir';
import { reportToConsole } from '../internal/report-to-console';

const entry = (message: string): LogEntry => ({
  timestamp: 1,
  type: 'error',
  template: message,
  message,
});
const badEntry = (): LogEntry => ({
  ...entry('unrenderable'),
  get message(): string {
    throw new Error('message unavailable');
  },
});
const nextTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

// The cap lets a broken implementation fail an assertion instead of starving the
// event loop forever. Working implementations reach the console only once.
function forwardConsole(forward: () => void) {
  let calls = 0;
  const spy = spyOn(console, 'error').mockImplementation(() => {
    if (++calls < 20) {
      forward();
    }
  });
  return { calls: () => calls, restore: () => spy.mockRestore() };
}

for (const mode of ['throw', 'reject', 'event rejection'] as const) {
  test(`a console bridge cannot restart logger diagnostics after ${mode}`, async () => {
    const stored = new ArraySink();
    const logger = new Logger({
      callProcessExit: false,
      diagnosticSinks: [
        {
          write() {
            throw new Error('diagnostic failed');
          },
        },
      ],
      sinks: [
        stored,
        {
          write() {
            if (mode === 'throw') {
              throw new Error('sink failed');
            }
            if (mode === 'reject') {
              return Promise.reject(new Error('sink failed'));
            }
          },
          writeDiagnostic() {
            throw new Error('diagnostic failed');
          },
        },
      ],
    });
    const failingListener = () => Promise.reject(new Error('listener failed'));
    if (mode === 'event rejection') {
      logger.on('logger', failingListener);
    }
    const consoleBridge = forwardConsole(() => logger.error('forwarded'));
    try {
      logger.info('original');
      await nextTurn();
      expect(consoleBridge.calls()).toBe(1);
      expect(
        stored.logs.filter((log) => log.message === 'forwarded'),
      ).toHaveLength(1);
      // Ordinary failures still report after the terminal call finishes.
      logger.info('independent');
      await nextTurn();
      expect(consoleBridge.calls()).toBe(2);
    } finally {
      logger.clear('logger');
      consoleBridge.restore();
      await logger.close();
    }
  });
}

test('file format report overflow contains a forwarding console while preserving its deferred report', async () => {
  const directory = new TmpDir({ unsafeCleanup: true });
  await directory.initialize();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reports = 0;
  const sink = new FileSink({
    logDir: directory.path,
    basename: 'format-feedback',
    jsonFormat: true,
    onError: () => (++reports === 1 ? pending : undefined),
  });
  await sink.flush();
  const consoleBridge = forwardConsole(() => sink.write(badEntry()));
  try {
    for (let index = 0; index < 3; index++) {
      sink.write(badEntry());
    }
    await sink.flush();
    expect(consoleBridge.calls()).toBe(1);
    expect(reports).toBe(1);
    expect(sink.getHealth().droppedByKind.format).toBe(4);
    release();
    await nextTurn();
    expect(reports).toBe(2);
    expect(consoleBridge.calls()).toBe(1);
  } finally {
    release();
    consoleBridge.restore();
    await sink.close();
    await directory.cleanup();
  }
});

for (const handler of ['absent', 'reject', 'console'] as const) {
  test(`file write failures forwarded by console retain terminal origin (handler: ${handler})`, async () => {
    const directory = new TmpDir({ unsafeCleanup: true });
    await directory.initialize();
    let reports = 0;
    const sink = new FileSink({
      logDir: directory.path,
      basename: 'write-feedback',
      maxRetries: 0,
      onError:
        handler !== 'absent'
          ? () => {
              reports++;
              if (handler === 'console') {
                console.error('handler report');
                return;
              }
              return Promise.reject(new Error('handler failed'));
            }
          : undefined,
    });
    await sink.flush();
    const internals = sink as unknown as { writeEntry(): Promise<void> };
    const write = spyOn(internals, 'writeEntry').mockRejectedValue(
      new Error('disk full'),
    );
    const consoleBridge = forwardConsole(() => sink.write(entry('forwarded')));
    try {
      if (handler === 'console') {
        reportToConsole('original');
      } else {
        sink.write(entry('original'));
      }
      await sink.flush();
      await nextTurn();
      expect(consoleBridge.calls()).toBe(1);
      const losses = handler === 'console' ? 1 : 2;
      expect(sink.getHealth().droppedByKind.write).toBe(losses);
      expect(reports).toBe(handler === 'reject' ? 1 : 0);
      write.mockRestore();
      reportToConsole('successful bridge');
      await sink.flush();
      expect(consoleBridge.calls()).toBe(2);
      expect(sink.getHealth().droppedByKind.write).toBe(losses);
    } finally {
      write.mockRestore();
      consoleBridge.restore();
      await sink.close();
      await directory.cleanup();
    }
  });
}

test('a rejected ArraySink transformer born in a console fallback cannot restart reporting', async () => {
  const sink = new ArraySink({
    transformer: () =>
      Promise.reject(new Error('transform failed')) as unknown as LogEntry,
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- exercise runtime async handler support
    onFormatError: () => Promise.reject(new Error('handler failed')),
  });
  const consoleBridge = forwardConsole(() => sink.write(entry('forwarded')));
  try {
    reportToConsole('original');
    await nextTurn();
    expect(consoleBridge.calls()).toBe(1);
    expect(sink.logs).toHaveLength(1);
  } finally {
    consoleBridge.restore();
  }
});

test('a queued pipe write retains console origin after the console call returns', async () => {
  const initialize = spyOn(
    NamedPipeSink.prototype as unknown as { initializePipe(): Promise<void> },
    'initializePipe',
  ).mockResolvedValue();
  let reports = 0;
  const sink = new NamedPipeSink({
    pipePath: '/unused-console-feedback-test',
    maxRetries: 0,
    onError: () => {
      reports++;
      console.error('handler report');
    },
  });
  initialize.mockRestore();
  const internals = sink as unknown as {
    isProcessing: boolean;
    isInitialized: boolean;
    pipeStream: unknown;
    processQueue(): void;
  };
  internals.isInitialized = true;
  internals.isProcessing = true;
  internals.pipeStream = {
    destroyed: false,
    write() {
      throw new Error('pipe failed');
    },
  };
  const consoleBridge = forwardConsole(() => sink.write(entry('forwarded')));
  try {
    reportToConsole('original');
    expect(sink.getHealth().queueSize).toBe(1);
    internals.isProcessing = false;
    internals.processQueue();
    await nextTurn();
    expect(consoleBridge.calls()).toBe(1);
    expect(reports).toBe(0);
    expect(sink.getHealth().droppedByKind.write).toBe(1);
    expect(sink.getHealth().consecutiveFailures).toBe(1);
  } finally {
    internals.pipeStream = undefined;
    consoleBridge.restore();
    await sink.close();
  }
});

test('ConsoleSink contains a console bridge without dropping other sink delivery', async () => {
  const stored = new ArraySink();
  const logger = new Logger({
    callProcessExit: false,
    sinks: [new ConsoleSink({ colors: false }), stored],
  });
  const consoleBridge = forwardConsole(() => logger.error('forwarded'));
  try {
    logger.error('original');
    expect(consoleBridge.calls()).toBe(1);
    expect(stored.logs.map((log) => log.message)).toEqual([
      'forwarded',
      'original',
    ]);
    reportToConsole('terminal');
    expect(consoleBridge.calls()).toBe(2);
    expect(
      stored.logs.filter((log) => log.message === 'forwarded'),
    ).toHaveLength(2);
  } finally {
    consoleBridge.restore();
    await logger.close();
  }
});

test('a rejected NamedPipeSink formatter born in a console fallback cannot restart reporting', async () => {
  const initialize = spyOn(
    NamedPipeSink.prototype as unknown as { initializePipe(): Promise<void> },
    'initializePipe',
  ).mockResolvedValue();
  const sink = new NamedPipeSink({
    pipePath: '/unused-console-feedback-test',
    formatter: () =>
      Promise.reject(new Error('format failed')) as unknown as string,
    onError: () => Promise.reject(new Error('handler failed')),
  });
  initialize.mockRestore();
  const connect = spyOn(
    sink as unknown as { ensureConnection(): void },
    'ensureConnection',
  ).mockImplementation(() => {});
  const consoleBridge = forwardConsole(() => sink.write(entry('forwarded')));
  try {
    reportToConsole('original');
    await nextTurn();
    expect(consoleBridge.calls()).toBe(1);
  } finally {
    await sink.close();
    await nextTurn();
    consoleBridge.restore();
    connect.mockRestore();
  }
});
