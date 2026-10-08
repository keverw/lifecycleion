import { expect, spyOn, test } from 'bun:test';
import type { LogEntry, LogSink } from '../types';
import {
  isDiagnosticEntry,
  markDiagnosticEntry,
  registerSinkFailureReporter,
  reportSinkFailure,
  type SinkFailureReport,
} from './sink-failure-routing';
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
