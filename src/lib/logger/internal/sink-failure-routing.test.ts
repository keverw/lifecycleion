import { expect, spyOn, test } from 'bun:test';
import type { LogEntry, LogSink } from '../types';
import {
  isDiagnosticEntry,
  markDiagnosticEntry,
  registerSinkFailureReporter,
  reportSinkFailure,
} from './sink-failure-routing';
import type { SinkFailureReport } from './sink-failure-routing';
import { diagnosticEntry } from './diagnostic-entry';

const report: SinkFailureReport = {
  kind: 'sink',
  context: 'write',
  error: new Error('private failure details'),
  message: 'A sink write failed',
};

test('sink ownership never reads or mutates caller-owned properties', () => {
  const sink = new Proxy(Object.freeze({ write() {} }), {
    get() {
      throw new Error('sink property read');
    },
    set() {
      throw new Error('sink property write');
    },
    defineProperty() {
      throw new Error('sink property definition');
    },
  });
  const reports: SinkFailureReport[] = [];
  const unregister = registerSinkFailureReporter(sink, (failure) =>
    reports.push(failure),
  );
  expect(reportSinkFailure(sink, report)).toBe(true);
  expect(reports).toEqual([report]);
  unregister();
  unregister();
  expect(reportSinkFailure(sink, report)).toBe(false);
});

test('duplicate callbacks and multiple owners retain independent subscriptions', () => {
  const sink: LogSink = { write() {} };
  let calls = 0;
  const reporter = () => {
    calls++;
  };
  const first = registerSinkFailureReporter(sink, reporter);
  const second = registerSinkFailureReporter(sink, reporter);
  reportSinkFailure(sink, report);
  expect(calls).toBe(2);
  first();
  reportSinkFailure(sink, report);
  expect(calls).toBe(3);
  second();
  expect(reportSinkFailure(sink, report)).toBe(false);
});

test('report delivery snapshots owners before callbacks change subscriptions', () => {
  const sink: LogSink = { write() {} };
  const calls: string[] = [];
  let removeSecond = () => {};
  const removeFirst = registerSinkFailureReporter(sink, () => {
    calls.push('first');
    removeSecond();
  });
  removeSecond = registerSinkFailureReporter(sink, () => {
    calls.push('second');
  });
  try {
    reportSinkFailure(sink, report);
    reportSinkFailure(sink, report);
    expect(calls).toEqual(['first', 'second', 'first']);
  } finally {
    removeFirst();
    removeSecond();
  }
});

test('one failing reporter cannot prevent another owner receiving the failure', () => {
  const sink: LogSink = { write() {} };
  const consoleSpy = spyOn(console, 'error').mockImplementation(() => {});
  const removeFirst = registerSinkFailureReporter(sink, () => {
    throw new Error('owner failed');
  });
  let calls = 0;
  const removeSecond = registerSinkFailureReporter(sink, () => {
    calls++;
  });
  try {
    expect(reportSinkFailure(sink, report)).toBe(true);
    expect(calls).toBe(1);
    expect(consoleSpy).toHaveBeenCalledTimes(1);
  } finally {
    removeFirst();
    removeSecond();
    consoleSpy.mockRestore();
  }
});

test('diagnostic identity is independent of public tags and survives frozen entries', () => {
  const entry: LogEntry = Object.freeze({
    timestamp: 1,
    type: 'error',
    template: 'x',
    message: 'x',
  });
  expect(isDiagnosticEntry(entry)).toBe(false);
  expect(markDiagnosticEntry(entry)).toBe(entry);
  expect(isDiagnosticEntry(entry)).toBe(true);
  expect(
    isDiagnosticEntry({ ...entry, tags: ['lifecycleion-diagnostic'] }),
  ).toBe(false);
  expect(isDiagnosticEntry(diagnosticEntry({ ...report, timestamp: 1 }))).toBe(
    true,
  );
});

test('separate module copies share owners and diagnostic identity', async () => {
  const copyName = 'duplicate';
  const duplicate = (await import(`./sink-failure-routing.ts?${copyName}`)) as {
    reportSinkFailure: typeof reportSinkFailure;
    isDiagnosticEntry: typeof isDiagnosticEntry;
    markDiagnosticEntry: typeof markDiagnosticEntry;
  };
  expect(duplicate.reportSinkFailure).not.toBe(reportSinkFailure);
  const sink: LogSink = { write() {} };
  let calls = 0;
  const remove = registerSinkFailureReporter(sink, () => {
    calls++;
  });
  try {
    expect(duplicate.reportSinkFailure(sink, report)).toBe(true);
    expect(calls).toBe(1);
    const entry = diagnosticEntry({ ...report, timestamp: 1 });
    expect(duplicate.isDiagnosticEntry(entry)).toBe(true);
    expect(isDiagnosticEntry(duplicate.markDiagnosticEntry({ ...entry }))).toBe(
      true,
    );
  } finally {
    remove();
  }
});

test('a shared sink does not retain a logger that was dropped without close()', async () => {
  // Isolated in a child process, as the lifecycle retention probe is: the test runner's
  // own stack can keep temporaries alive across an in-process collection.
  const probe = Bun.spawn({
    cmd: [
      process.execPath,
      '--eval',
      `
      import { Logger, ArraySink } from ${JSON.stringify(new URL('../index.ts', import.meta.url).href)};
      import { reportSinkFailure } from ${JSON.stringify(new URL('./sink-failure-routing.ts', import.meta.url).href)};
      const shared = new ArraySink();
      const kept = new Logger({ sinks: [shared, new ArraySink()], callProcessExit: false });
      function dropLogger() {
        let logger = new Logger({ sinks: [shared, new ArraySink()], callProcessExit: false });
        const reference = new WeakRef(logger);
        logger = undefined;
        return reference;
      }
      const dropped = dropLogger();
      for (let attempt = 0; attempt < 100; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        Bun.gc(true);
      }
      if (dropped.deref() !== undefined) throw new Error('Dropped logger retained by its shared sink');
      const report = { kind: 'sink', context: 'write', error: new Error('x'), message: 'x' };
      if (!reportSinkFailure(shared, report)) throw new Error('Live owner lost its subscription');
      await new Promise((resolve) => setTimeout(resolve, 0));
      await kept.close();
      if (reportSinkFailure(shared, report)) throw new Error('Closed owner still subscribed');
    `,
    ],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stderr] = await Promise.all([
    probe.exited,
    new Response(probe.stderr).text(),
  ]);
  expect(stderr).toBe('');
  expect(exitCode).toBe(0);
});
