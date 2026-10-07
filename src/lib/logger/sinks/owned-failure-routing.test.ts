import { expect, spyOn, test } from 'bun:test';
import { reportToConsole } from '../../internal/report-to-console';
import nodeFS, { promises as fs, type WriteStream } from 'node:fs';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArraySink } from './array';
import { FileSink } from './file';
import { NamedPipeSink } from './named-pipe';
import type { LogEntry } from '../types';
import {
  markDiagnosticEntry,
  registerSinkFailureReporter,
  type SinkFailureReport,
} from '../internal/sink-failure-routing';
import {
  muteConsoleError,
  restoreConsoleError,
} from '../../internal/console-test-utils';

function entry(message = 'ordinary'): LogEntry {
  return { timestamp: Date.now(), type: 'info', message, template: message };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 10));

test('array default format failures reach owners while explicit handlers retain priority', () => {
  const reports: SinkFailureReport[] = [];
  const failure = new Error('transform failed');
  const sink = new ArraySink({
    transformer: () => {
      throw failure;
    },
  });
  const release = registerSinkFailureReporter(sink, (report) => {
    reports.push(report);
  });
  const consoleLines = muteConsoleError();
  try {
    sink.write(entry());
    expect(reports).toHaveLength(1);
    expect(reports[0].error).toBe(failure);
    expect(consoleLines).toHaveLength(0);
    release();
    sink.write(entry());
    expect(consoleLines).toHaveLength(1);
    let calls = 0;
    const explicit = new ArraySink({
      transformer: () => {
        throw failure;
      },
      onFormatError: () => {
        calls++;
      },
    });
    const unbind = registerSinkFailureReporter(explicit, (report) => {
      reports.push(report);
    });
    explicit.write(entry());
    expect(calls).toBe(1);
    expect(reports).toHaveLength(1);
    unbind();
  } finally {
    release();
    restoreConsoleError();
  }
});

test('array diagnostic transformer rejection stays terminal and independent errors still route', async () => {
  const reports: SinkFailureReport[] = [];
  let callbacks = 0;
  const sink = new ArraySink({
    transformer: (() =>
      Promise.reject(new Error('late transformer failure'))) as unknown as (
      value: LogEntry,
    ) => LogEntry,
    onFormatError: () => {
      callbacks++;
    },
  });
  const release = registerSinkFailureReporter(sink, (report) => {
    reports.push(report);
  });
  const lines = muteConsoleError();
  try {
    sink.write(markDiagnosticEntry(entry('diagnostic')));
    await tick();
    expect(callbacks).toBe(0);
    expect(reports).toHaveLength(0);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    sink.write(entry());
    await tick();
    expect(callbacks).toBeGreaterThan(0);
  } finally {
    release();
    restoreConsoleError();
  }
});

test('file queued write failures route to owners and diagnostic failures bypass onError', async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'lifecycle-owned-file-'));
  const reports: SinkFailureReport[] = [];
  let callbacks = 0;
  const sink = new FileSink({
    logDir: directory,
    basename: 'test',
    maxRetries: 0,
  });
  const internals = sink as unknown as {
    initPromise: Promise<void>;
    writeEntry: () => Promise<void>;
    onError?: () => void;
  };
  const release = registerSinkFailureReporter(sink, (report) => {
    reports.push(report);
  });
  const lines = muteConsoleError();
  try {
    await internals.initPromise;
    internals.writeEntry = () => Promise.reject(new Error('write failed'));
    sink.write(entry());
    await sink.flush(100);
    expect(reports).toHaveLength(1);
    expect(lines).toHaveLength(0);
    internals.onError = () => {
      callbacks++;
    };
    sink.write(markDiagnosticEntry(entry('diagnostic')));
    await sink.flush(100);
    expect(callbacks).toBe(0);
    expect(reports).toHaveLength(1);
    expect(lines).toHaveLength(1);
    sink.write(entry('later'));
    await sink.flush(100);
    expect(callbacks).toBe(1);
    expect(sink.getHealth().droppedEntries).toBe(3);
  } finally {
    await sink.close();
    release();
    restoreConsoleError();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('named-pipe format fallback reaches owner and marked entries stay terminal', async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'lifecycle-owned-pipe-'));
  const sink = new NamedPipeSink({
    pipePath: join(directory, 'missing'),
    closeTimeoutMS: 5,
    formatter: () => {
      throw new Error('formatter failed');
    },
  });
  const reports: SinkFailureReport[] = [];
  const release = registerSinkFailureReporter(sink, (report) => {
    reports.push(report);
  });
  const lines = muteConsoleError();
  try {
    await (sink as unknown as { initPromise: Promise<void> }).initPromise;
    reports.length = 0;
    sink.write(entry());
    expect(reports).toHaveLength(1);
    sink.write(markDiagnosticEntry(entry('diagnostic')));
    expect(reports).toHaveLength(1);
    expect(lines).toHaveLength(1);
  } finally {
    await sink.close();
    release();
    restoreConsoleError();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('two failing file owners cannot bounce diagnostic writes between sinks', async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'lifecycle-file-cycle-'));
  const a = new FileSink({ logDir: directory, basename: 'a', maxRetries: 0 });
  const b = new FileSink({ logDir: directory, basename: 'b', maxRetries: 0 });
  let reports = 0;
  const releaseA = registerSinkFailureReporter(a, () => {
    if (++reports < 10) {
      b.write(markDiagnosticEntry(entry('a failed')));
    }
  });
  const releaseB = registerSinkFailureReporter(b, () => {
    if (++reports < 10) {
      a.write(markDiagnosticEntry(entry('b failed')));
    }
  });
  const lines = muteConsoleError();
  try {
    for (const sink of [a, b]) {
      const internals = sink as unknown as {
        initPromise: Promise<void>;
        writeEntry: () => Promise<void>;
      };
      await internals.initPromise;
      internals.writeEntry = () =>
        Promise.reject(new Error('disk unavailable'));
    }
    a.write(entry());
    await a.flush(100);
    await b.flush(100);
    await tick();
    expect(reports).toBe(1);
    expect(lines).toHaveLength(1);
  } finally {
    await a.close();
    await b.close();
    releaseA();
    releaseB();
    restoreConsoleError();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test.each(['diagnostic', 'console'] as const)(
  'named-pipe %s retry origin promotes when independent ordinary work arrives',
  async (origin) => {
    const directory = await fs.mkdtemp(
      join(tmpdir(), 'lifecycle-pipe-origin-'),
    );
    const sink = new NamedPipeSink({
      pipePath: join(directory, 'missing'),
      closeTimeoutMS: 5,
    });
    const internals = sink as unknown as {
      initPromise: Promise<void>;
      initializePipe: (
        diagnostic: boolean,
        suppress?: boolean,
      ) => Promise<void>;
      reportedOpenFailures: Set<string>;
      writeQueue: { entry: LogEntry; shouldSuppressFailureReport?: boolean }[];
    };
    const reports: SinkFailureReport[] = [];
    const release = registerSinkFailureReporter(sink, (report) => {
      reports.push(report);
    });
    const lines = muteConsoleError();
    try {
      await internals.initPromise;
      reports.length = 0;
      internals.reportedOpenFailures.clear();
      if (origin === 'console') {
        const consoleShim = spyOn(console, 'error').mockImplementation(() => {
          sink.write(entry('forwarded terminal report'));
        });
        try {
          reportToConsole('terminal failure');
        } finally {
          consoleShim.mockRestore();
        }
      } else {
        sink.write(markDiagnosticEntry(entry()));
      }
      await internals.initPromise;
      await internals.initializePipe(
        origin === 'diagnostic',
        origin === 'console',
      );
      expect(reports).toHaveLength(0);
      expect(lines).toHaveLength(origin === 'diagnostic' ? 1 : 0);
      sink.write(entry('independent ordinary work'));
      await internals.initializePipe(
        origin === 'diagnostic',
        origin === 'console',
      );
      expect(reports).toHaveLength(1);
      expect(reports[0].error.message).toContain('ENOENT');
      await internals.initializePipe(
        origin === 'diagnostic',
        origin === 'console',
      );
      expect(reports).toHaveLength(1);
    } finally {
      await sink.close();
      release();
      restoreConsoleError();
      await fs.rm(directory, { recursive: true, force: true });
    }
  },
);

test('named-pipe terminal outage reports cannot spend the ordinary report budget', async () => {
  const directory = await fs.mkdtemp(
    join(tmpdir(), 'lifecycle-pipe-report-cap-'),
  );
  const sink = new NamedPipeSink({
    pipePath: join(directory, 'missing'),
    closeTimeoutMS: 5,
  });
  const internals = sink as unknown as {
    initPromise: Promise<void>;
    reportOpenFailure: (
      kind: 'setup',
      message: string,
      cause: unknown,
      diagnostic: boolean,
    ) => void;
    reportedOpenFailures: Set<string>;
  };
  const reports: SinkFailureReport[] = [];
  const release = registerSinkFailureReporter(sink, (report) => {
    reports.push(report);
  });
  const lines = muteConsoleError();
  try {
    await internals.initPromise;
    reports.length = 0;
    internals.reportedOpenFailures.clear();
    for (let index = 0; index < 100; index++) {
      internals.reportOpenFailure(
        'setup',
        `terminal failure ${index}`,
        undefined,
        true,
      );
    }
    expect(reports).toHaveLength(0);
    expect(lines.length).toBeLessThan(100);
    internals.reportOpenFailure(
      'setup',
      'independent failure',
      undefined,
      false,
    );
    expect(reports).toHaveLength(1);
    expect(reports[0].error.message).toBe('independent failure');
    internals.reportOpenFailure(
      'setup',
      'independent failure',
      undefined,
      false,
    );
    expect(reports).toHaveLength(1);
  } finally {
    await sink.close();
    release();
    restoreConsoleError();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('file pending-open errors retain diagnostic origin only until independent work', async () => {
  const directory = await fs.mkdtemp(
    join(tmpdir(), 'lifecycle-file-open-origin-'),
  );
  const sink = new FileSink({
    logDir: directory,
    basename: 'test',
    maxRetries: 0,
  });
  await sink.flush();
  (sink as unknown as { destroyStream: () => void }).destroyStream();
  let owners = 0;
  const release = registerSinkFailureReporter(sink, () => {
    owners++;
  });
  const lines = muteConsoleError();
  const create = spyOn(nodeFS, 'createWriteStream').mockImplementation(() => {
    class FailingOpen extends EventEmitter {
      public pending = true;
      public destroyed = false;
      public destroy(): void {
        this.destroyed = true;
      }
      public end(callback: () => void): void {
        callback();
      }
    }
    const stream = new FailingOpen();
    queueMicrotask(() => stream.emit('error', new Error('open failed')));
    return stream as unknown as WriteStream;
  });
  try {
    sink.write(markDiagnosticEntry(entry('diagnostic')));
    await sink.flush(1000);
    expect(owners).toBe(0);
    expect(lines.length).toBeGreaterThan(0);
    sink.write(entry('independent work'));
    await sink.flush(1000);
    expect(owners).toBeGreaterThan(0);
  } finally {
    create.mockRestore();
    await sink.close();
    release();
    restoreConsoleError();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
