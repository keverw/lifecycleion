import { expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { FileSink } from './file';
import { NamedPipeSink } from './named-pipe';
import type { SinkFailure } from './internal/sink-failure';
import { setOpenRetryBackoffForTesting } from './internal/reopen-backoff';
import type { LogEntry } from '../types';
import { TmpDir } from '../../tmp-dir';

const entry = (message: string): LogEntry => ({
  timestamp: Date.now(),
  type: 'info',
  message,
  template: message,
});

test('a FileSink setup outage holds lines without counting losses or failed writes', async () => {
  const directory = new TmpDir({ unsafeCleanup: true });
  await directory.initialize();
  const logDir = `${directory.path}/ordinary-file`;
  await fs.writeFile(logDir, 'not a directory');
  const failures: SinkFailure[] = [];
  const sink = new FileSink({
    logDir,
    basename: 'setup',
    maxRetries: 1,
    onError: (failure) => {
      failures.push(failure);
    },
  });
  try {
    sink.write(entry('held during setup'));
    // The next open attempt falls after this deadline, so the flush answers at once.
    expect(await sink.flush(200)).toEqual({
      success: false,
      entriesWritten: 0,
      entriesFailed: 0,
      timedOut: false,
      entriesQueued: 1,
    });
    expect(sink.getHealth()).toMatchObject({
      isHealthy: false,
      isInitialized: false,
      consecutiveFailures: 0,
      queueSize: 1,
      droppedEntries: 0,
      droppedByKind: { write: 0, close: 0 },
    });
    expect(
      failures.filter((failure) => failure.attempt !== undefined),
    ).toHaveLength(0);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      kind: 'setup',
      disposition: 'no_entry',
    });
  } finally {
    await sink.close();
    await directory.cleanup();
  }
});

test('a FileSink startup burst waits on one open and preserves every queued entry', async () => {
  const directory = new TmpDir({ unsafeCleanup: true });
  await directory.initialize();
  const open = spyOn(
    FileSink.prototype as unknown as { openFile(): Promise<unknown> },
    'openFile',
  );
  const sink = new FileSink({
    logDir: directory.path,
    basename: 'startup',
    jsonFormat: true,
  });
  try {
    for (let index = 0; index < 100; index++) {
      sink.write(entry(`line ${String(index)}`));
    }
    expect((await sink.flush()).entriesWritten).toBe(100);
    expect(open).toHaveBeenCalledTimes(1);
    const [filename] = await fs.readdir(directory.path);
    const text = await fs.readFile(`${directory.path}/${filename}`, 'utf8');
    const lines = text.trim().split('\n');
    expect(lines).toHaveLength(100);
    expect(JSON.parse(lines[0]).message).toBe('line 0');
    expect(JSON.parse(lines[99]).message).toBe('line 99');
  } finally {
    open.mockRestore();
    await sink.close();
    await directory.cleanup();
  }
});

test('a failed rotation reopen holds the line and clears initialized health until the destination recovers', async () => {
  const directory = new TmpDir({ unsafeCleanup: true });
  await directory.initialize();
  const logDir = `${directory.path}/logs`;
  const oldDir = `${directory.path}/old-logs`;
  setOpenRetryBackoffForTesting({ initialMS: 20, maxMS: 50 });
  const sink = new FileSink({
    logDir,
    basename: 'rotation',
    maxSizeMB: 0.000001,
    maxRetries: 0,
    onError: () => {},
  });
  setOpenRetryBackoffForTesting(undefined);
  try {
    sink.write(entry('first'));
    expect((await sink.flush()).entriesWritten).toBe(1);
    expect(sink.getHealth().isHealthy).toBe(true);
    await fs.rename(logDir, oldDir);
    await fs.writeFile(logDir, 'not a directory');
    sink.write(entry('rotation cannot reopen'));
    expect(await sink.flush(200)).toMatchObject({
      success: false,
      entriesFailed: 0,
      timedOut: false,
      entriesQueued: 1,
    });
    expect(sink.getHealth()).toMatchObject({
      isInitialized: false,
      isHealthy: false,
      consecutiveFailures: 0,
      queueSize: 1,
      droppedEntries: 0,
    });
    await fs.unlink(logDir);
    await fs.rename(oldDir, logDir);
    sink.write(entry('recovered'));
    expect((await sink.flush()).entriesWritten).toBe(2);
    expect(sink.getHealth()).toMatchObject({
      isInitialized: true,
      isHealthy: true,
      consecutiveFailures: 0,
    });
  } finally {
    await sink.close();
    await directory.cleanup();
  }
});

test('each explicit readerless reconnect reports setup details without optional entry keys', async () => {
  const directory = new TmpDir({ unsafeCleanup: true });
  await directory.initialize();
  const pipePath = `${directory.path}/no-reader.pipe`;
  execFileSync('mkfifo', [pipePath]);
  const failures: SinkFailure[] = [];
  const sink = new NamedPipeSink({
    pipePath,
    onError: (failure) => {
      failures.push(failure);
    },
  });
  try {
    const state = sink as unknown as {
      engine: { readonly openSettled: Promise<void> };
      initializePipe(): Promise<void>;
    };
    await state.engine.openSettled;
    expect(failures).toEqual([]);
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await sink.reconnect()).toMatchObject({
        success: false,
        reason: 'error',
      });
    }
    expect(failures).toHaveLength(2);
    for (const failure of failures) {
      expect(failure).toMatchObject({ kind: 'setup', disposition: 'no_entry' });
      expect(failure.error.message).toContain('No reader');
      expect(failure.error.message).toContain(pipePath);
      expect(Object.hasOwn(failure, 'entry')).toBe(false);
      expect(Object.hasOwn(failure, 'attempt')).toBe(false);
    }
    // The retry timer uses this same path. It must remain quiet after manual reports.
    await state.initializePipe();
    expect(failures).toHaveLength(2);
    expect(sink.getHealth().consecutiveFailures).toBe(0);
  } finally {
    await sink.close();
    await directory.cleanup();
  }
});

test('a NamedPipeSink initialization failure omits entry and attempt properties', async () => {
  const directory = new TmpDir({ unsafeCleanup: true });
  await directory.initialize();
  const failures: SinkFailure[] = [];
  const sink = new NamedPipeSink({
    pipePath: `${directory.path}/absent.pipe`,
    onError: (failure) => {
      failures.push(failure);
    },
  });
  try {
    await (
      sink as unknown as { engine: { readonly openSettled: Promise<void> } }
    ).engine.openSettled;
    expect(failures).toHaveLength(1);
    expect(failures[0].kind).toBe('not_found');
    expect(Object.hasOwn(failures[0], 'entry')).toBe(false);
    expect(Object.hasOwn(failures[0], 'attempt')).toBe(false);
  } finally {
    await sink.close();
    await directory.cleanup();
  }
});
