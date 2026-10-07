import { expect, spyOn, test } from 'bun:test';
import { Logger } from './index';
import { ArraySink } from './sinks/array';
import { ConsoleSink } from './sinks/console';
import { FileSink } from './sinks/file';
import type { LogEntry, LoggerDiagnostic } from './types';
import { TmpDir } from '../tmp-dir';
import { sleep } from '../sleep';

const entry = (): LogEntry => ({
  timestamp: 1,
  type: 'info',
  template: 'original',
  message: 'original',
});

test('an attached FileSink routes a queued write failure to its other sink', async () => {
  const directory = new TmpDir({ unsafeCleanup: true });
  await directory.initialize();
  const source = new FileSink({
    logDir: directory.path,
    basename: 'source',
    maxRetries: 0,
  });
  await source.flush();
  const stored = new ArraySink();
  const logger = new Logger({
    sinks: [source, stored],
    callProcessExit: false,
  });
  const diagnostics: LoggerDiagnostic[] = [];
  logger.on<LoggerDiagnostic>('diagnostic', (value) => {
    diagnostics.push(value);
  });
  const failure = new Error('disk full');
  const write = spyOn(
    source as unknown as { writeEntry(): Promise<void> },
    'writeEntry',
  ).mockRejectedValue(failure);
  const ownDiagnostic = spyOn(source, 'writeDiagnostic');
  const consoleReport = spyOn(console, 'error').mockImplementation(() => {});
  try {
    logger.info('original');
    await source.flush();
    await sleep(0);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ kind: 'sink', sink: source });
    expect(
      stored.logs.filter((log) =>
        log.tags?.includes('lifecycleion-diagnostic'),
      ),
    ).toHaveLength(1);
    expect(ownDiagnostic).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledTimes(1);
    expect(source.getHealth().droppedByKind.write).toBe(1);
    expect(consoleReport).not.toHaveBeenCalled();
  } finally {
    write.mockRestore();
    ownDiagnostic.mockRestore();
    await logger.close();
    consoleReport.mockRestore();
    await directory.cleanup();
  }
});

test('ArraySink transform failures reach another sink without leaking the thrown message', async () => {
  const failure = new Error('secret-token-should-not-be-in-message');
  const source = new ArraySink({
    transformer: () => {
      throw failure;
    },
  });
  const stored = new ArraySink();
  const logger = new Logger({
    sinks: [source, stored],
    callProcessExit: false,
  });
  const diagnostics: LoggerDiagnostic[] = [];
  logger.on<LoggerDiagnostic>('diagnostic', (value) => {
    diagnostics.push(value);
  });
  const consoleReport = spyOn(console, 'error').mockImplementation(() => {});
  try {
    logger.info('original');
    await sleep(0);
    expect(source.logs).toHaveLength(1);
    expect(source.logs[0].message).toBe('original');
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].sink).toBe(source);
    const delivered = stored.logs.filter((log) =>
      log.tags?.includes('lifecycleion-diagnostic'),
    );
    expect(delivered).toHaveLength(1);
    expect(delivered[0].message).not.toContain('secret-token');
    expect(consoleReport).not.toHaveBeenCalled();
  } finally {
    await logger.close();
    consoleReport.mockRestore();
  }
});

test('ConsoleSink write failures go to other sinks without retrying the failed console sink', async () => {
  const source = new ConsoleSink({ colors: false });
  const stored = new ArraySink();
  const logger = new Logger({
    sinks: [source, stored],
    callProcessExit: false,
  });
  const consoleWrite = spyOn(console, 'info').mockImplementation(() => {
    throw new Error('console down');
  });
  const ownDiagnostic = spyOn(source, 'writeDiagnostic');
  const consoleReport = spyOn(console, 'error').mockImplementation(() => {});
  try {
    logger.info('original');
    await sleep(0);
    expect(
      stored.logs.filter((log) =>
        log.tags?.includes('lifecycleion-diagnostic'),
      ),
    ).toHaveLength(1);
    expect(ownDiagnostic).not.toHaveBeenCalled();
    expect(consoleReport).not.toHaveBeenCalled();
  } finally {
    consoleWrite.mockRestore();
    ownDiagnostic.mockRestore();
    await logger.close();
    consoleReport.mockRestore();
  }
});

test('sink-owned failures respect dedicated diagnostic destinations and explicit error handlers', async () => {
  let callbacks = 0;
  const custom = new ArraySink({
    transformer: () => {
      throw new Error('custom failure');
    },
    onFormatError: () => {
      callbacks++;
    },
  });
  const source = new ArraySink({
    transformer: () => {
      throw new Error('default failure');
    },
  });
  const ordinary = new ArraySink();
  const diagnostic = new ArraySink();
  const logger = new Logger({
    sinks: [custom, source, ordinary],
    diagnosticSinks: [source, diagnostic],
    callProcessExit: false,
  });
  try {
    logger.info('original');
    await sleep(0);
    expect(callbacks).toBe(1);
    expect(source.logs).toHaveLength(1);
    expect(ordinary.logs).toHaveLength(1);
    expect(diagnostic.logs).toHaveLength(1);
    expect(diagnostic.logs[0].tags).toContain('lifecycleion-diagnostic');
  } finally {
    await logger.close();
  }
});

test('shared sink ownership survives partial removal and detaches after the final reference', async () => {
  const source = new ArraySink({
    transformer: () => {
      throw new Error('transform failed');
    },
  });
  const firstDestination = new ArraySink();
  const secondDestination = new ArraySink();
  const first = new Logger({
    sinks: [source, source],
    diagnosticSinks: [source, firstDestination],
    callProcessExit: false,
  });
  const second = new Logger({
    sinks: [source, secondDestination],
    callProcessExit: false,
  });
  const consoleReport = spyOn(console, 'error').mockImplementation(() => {});
  try {
    source.write(entry());
    await sleep(0);
    expect(firstDestination.logs).toHaveLength(1);
    expect(secondDestination.logs).toHaveLength(1);
    first.removeSink(source);
    first.removeDiagnosticSink(source);
    source.write(entry());
    await sleep(0);
    expect(firstDestination.logs).toHaveLength(2);
    expect(secondDestination.logs).toHaveLength(2);
    first.removeSink(source);
    await first.close();
    source.write(entry());
    await sleep(0);
    expect(firstDestination.logs).toHaveLength(2);
    expect(secondDestination.logs).toHaveLength(3);
    second.removeSink(source);
    source.write(entry());
    await sleep(0);
    expect(secondDestination.logs).toHaveLength(3);
    expect(consoleReport).toHaveBeenCalledTimes(1);
  } finally {
    await first.close();
    await second.close();
    source.close();
    consoleReport.mockRestore();
  }
});

test('two failing files send failed diagnostics to console instead of back to one another', async () => {
  const directory = new TmpDir({ unsafeCleanup: true });
  await directory.initialize();
  const first = new FileSink({
    logDir: directory.path,
    basename: 'first',
    maxRetries: 0,
  });
  const second = new FileSink({
    logDir: directory.path,
    basename: 'second',
    maxRetries: 0,
  });
  await Promise.all([first.flush(), second.flush()]);
  const logger = new Logger({ sinks: [first, second], callProcessExit: false });
  let firstWrites = 0;
  let secondWrites = 0;
  const firstWrite = spyOn(
    first as unknown as { writeEntry(): Promise<void> },
    'writeEntry',
  ).mockImplementation(() => {
    if (++firstWrites < 20) {
      return Promise.reject(new Error('first disk failed'));
    }
    return Promise.resolve();
  });
  const secondWrite = spyOn(
    second as unknown as { writeEntry(): Promise<void> },
    'writeEntry',
  ).mockImplementation(() => {
    if (++secondWrites < 20) {
      return Promise.reject(new Error('second disk failed'));
    }
    return Promise.resolve();
  });
  const consoleReport = spyOn(console, 'error').mockImplementation(() => {});
  try {
    logger.info('original');
    await Promise.all([first.flush(), second.flush()]);
    await sleep(10);
    await Promise.all([first.flush(), second.flush()]);
    expect(firstWrites).toBe(2);
    expect(secondWrites).toBe(2);
    expect(consoleReport).toHaveBeenCalledTimes(2);
    expect(first.getHealth().droppedByKind.write).toBe(2);
    expect(second.getHealth().droppedByKind.write).toBe(2);
  } finally {
    firstWrite.mockRestore();
    secondWrite.mockRestore();
    await logger.close();
    consoleReport.mockRestore();
    await directory.cleanup();
  }
});
