import {
  describe,
  test,
  expect,
  mock,
  beforeEach,
  afterEach,
  spyOn,
} from 'bun:test';
import { promises as fsPromises } from 'fs';
import { FileSink } from './file';
import type { SinkFailure, SinkFailureKind } from './internal/sink-failure';
import type { LogEntry } from '../types';
import { LogLevel } from '../types';
import { TmpDir } from '../../tmp-dir';
import {
  muteConsoleError,
  restoreConsoleError,
} from '../../internal/console-test-utils';

/**
 * A message the JSON envelope cannot serialize: `JSON.stringify` calls `toJSON` and it
 * throws. The one way left to make `jsonFormat` fail to render, now that the params bag
 * goes through the logger's own renderer and a `BigInt` or a cycle there is a marker
 * rather than a failure. A hostile cast, since `LogEntry.message` is a string.
 */
const UNRENDERABLE_MESSAGE = {
  toJSON(): never {
    throw new Error('message refused to serialize');
  },
} as unknown as string;

let tmpDir: TmpDir;

// Save the original Date.prototype.toISOString at module scope before any tests run
// Store the original method reference (not bound) so it can be properly restored
// eslint-disable-next-line @typescript-eslint/unbound-method
const originalToISOString = Date.prototype.toISOString;

describe('FileSink', () => {
  // Setup before each test
  beforeEach(async () => {
    // Create a new temporary directory for each test
    tmpDir = new TmpDir({
      unsafeCleanup: true, // Allow cleaning up even if directory is not empty
      prefix: 'file-sink-test',
    });
    await tmpDir.initialize();
  });

  // Clean up after tests
  afterEach(async () => {
    // Restore Date.prototype.toISOString FIRST before cleanup
    // This ensures that cleanup operations can use Date properly
    (Date.prototype as any).toISOString = originalToISOString;

    await tmpDir.cleanup();
  });

  test('should create log directory if it does not exist', async () => {
    const nonExistentDir = `${tmpDir.path}/does-not-exist`;

    const sink = new FileSink({
      logDir: nonExistentDir,
      basename: 'test',
      maxSizeMB: 1,
      jsonFormat: false,
    });

    // Wait a bit for async init to complete
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Check if directory was created
    const doesDirExist = await fsPromises
      .access(nonExistentDir)
      .then(() => true)
      .catch(() => false);

    expect(doesDirExist).toBe(true);

    // Clean up
    await sink.close();
  });

  test('should write log entry to file', async () => {
    const sink = new FileSink({
      logDir: tmpDir.path,
      basename: 'test',
      maxSizeMB: 1,
      jsonFormat: false,
    });

    // Write a test log entry
    const testMessage = 'Test log entry';
    const entry: LogEntry = {
      timestamp: Date.now(),
      type: 'info',
      serviceName: 'TestService',
      template: testMessage,
      message: testMessage,
    };

    sink.write(entry);

    // Flush to ensure write completes
    await sink.flush();

    // Get current date in UTC format for filename check
    const currentDate = new Date().toISOString().slice(0, 10);
    const logFilePath = `${tmpDir.path}/test-${currentDate}.log`;

    // Check if file exists
    const doesFileExist = await fsPromises
      .access(logFilePath)
      .then(() => true)
      .catch(() => false);

    expect(doesFileExist).toBe(true);

    // Read file content
    const content = await fsPromises.readFile(logFilePath, 'utf8');
    expect(content).toContain(testMessage);
    expect(content).toContain('TestService');

    // Clean up
    await sink.close();
  });

  test('should format logs as JSON when jsonFormat is true', async () => {
    const sink = new FileSink({
      logDir: tmpDir.path,
      basename: 'json-test',
      maxSizeMB: 1,
      jsonFormat: true,
    });

    const timestamp = Date.now();
    const testMessage = 'JSON formatted log';

    const entry: LogEntry = {
      timestamp,
      type: 'info',
      serviceName: 'JSONService',
      template: testMessage,
      message: testMessage,
      params: { foo: 'bar' },
      redactedParams: { foo: 'bar' },
    };

    sink.write(entry);

    // Flush to ensure write completes
    await sink.flush();

    // Get current date in UTC format for filename check
    const currentDate = new Date().toISOString().slice(0, 10);
    const logFilePath = `${tmpDir.path}/json-test-${currentDate}.log`;

    // Read file content
    const content = await fsPromises.readFile(logFilePath, 'utf8');

    // Parse JSON
    const jsonLog = JSON.parse(content.trim());

    // Check expected properties
    expect(jsonLog).toHaveProperty('timestamp', timestamp);
    expect(jsonLog).toHaveProperty('type', 'info');
    expect(jsonLog).toHaveProperty('serviceName', 'JSONService');
    expect(jsonLog).toHaveProperty('message', testMessage);
    expect(jsonLog).toHaveProperty('params');

    // Clean up
    await sink.close();
  });

  test('writes the params as they were at write() time', async () => {
    // `entry.redactedParams` is not a snapshot - it is the caller's own bag, or shares
    // every subtree that held nothing redacted - and the queue is drained after
    // `setupLogFile` and `rotateIfNeeded` have been awaited. Serializing it there wrote
    // whatever the caller had done to the bag since, so a bag reused across calls could
    // put a value into a line that was rendered without it.
    const sink = new FileSink({
      logDir: tmpDir.path,
      basename: 'snapshot-test',
      maxSizeMB: 1,
      jsonFormat: true,
    });

    const params: Record<string, unknown> = { foo: 'bar' };

    sink.write({
      timestamp: Date.now(),
      type: 'info',
      template: 'msg',
      message: 'msg',
      params,
      redactedParams: params,
    });

    // Synchronously after `write`, so the queue cannot have been drained yet.
    params['password'] = 'hunter2secret';
    params['foo'] = 'mutated';

    await sink.flush();

    const currentDate = new Date().toISOString().slice(0, 10);
    const content = await fsPromises.readFile(
      `${tmpDir.path}/snapshot-test-${currentDate}.log`,
      'utf8',
    );

    expect(content).not.toContain('hunter2secret');
    expect(content).not.toContain('mutated');
    expect(JSON.parse(content.trim()).params).toEqual({ foo: 'bar' });

    await sink.close();
  });

  test('should rotate log file when size exceeds maxSizeMB', async () => {
    // Create a sink with a very small max size (1 KB)
    const sink = new FileSink({
      logDir: tmpDir.path,
      basename: 'rotation-test',
      maxSizeMB: 0.001, // 1 KB
      jsonFormat: false,
    });

    // Get current date in UTC format for filename check
    const currentDate = new Date().toISOString().slice(0, 10);
    const logFilePath = `${tmpDir.path}/rotation-test-${currentDate}.log`;

    // Write enough data to trigger rotation - make it clearly exceed the limit
    const largeData = 'X'.repeat(1000); // 1000 chars (~1KB)

    // Write multiple chunks to ensure we exceed the limit
    for (let i = 0; i < 5; i++) {
      const message = `${i}: ${largeData}`;
      const entry: LogEntry = {
        timestamp: Date.now(),
        type: 'info',
        serviceName: 'RotationTest',
        template: message,
        message,
      };

      sink.write(entry);

      // Small wait between writes to ensure they're processed
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    // Flush to ensure all writes complete including rotation
    await sink.flush();

    // Check directory contents
    const files = await fsPromises.readdir(tmpDir.path);

    // Should have at least two files - the original and the rotated one
    expect(files.length).toBeGreaterThanOrEqual(2);

    // The original file should still exist but be smaller now (allow some buffer for metadata)
    const stats = await fsPromises.stat(logFilePath);
    expect(stats.size).toBeLessThan(1100); // Should be close to our max size

    // Clean up
    await sink.close();
  });

  test('should handle concurrent write operations correctly', async () => {
    const sink = new FileSink({
      logDir: tmpDir.path,
      basename: 'concurrent-test',
      maxSizeMB: 1,
      jsonFormat: false,
    });

    // Write many log entries concurrently
    const numEntries = 100;

    for (let i = 0; i < numEntries; i++) {
      const message = `Log entry ${i}`;
      const entry: LogEntry = {
        timestamp: Date.now(),
        type: 'info',
        serviceName: 'ConcurrentTest',
        template: message,
        message,
      };

      sink.write(entry);
    }

    // Flush to ensure all writes complete
    const result = await sink.flush();

    expect(result.success).toBe(true);
    expect(result.timedOut).toBe(false);

    // Get current date in UTC format for filename check
    const currentDate = new Date().toISOString().slice(0, 10);
    const logFilePath = `${tmpDir.path}/concurrent-test-${currentDate}.log`;

    // Read file content
    const content = await fsPromises.readFile(logFilePath, 'utf8');
    const lines = content.trim().split('\n');

    // Should have the same number of lines as log entries
    expect(lines.length).toBe(numEntries);

    // All entries should be present (order might vary, so just check presence)
    for (let i = 0; i < numEntries; i++) {
      expect(content).toContain(`Log entry ${i}`);
    }

    // Clean up
    await sink.close();
  });

  test('should create new log file when date changes', async () => {
    const sink = new FileSink({
      logDir: tmpDir.path,
      basename: 'date-test',
      maxSizeMB: 1,
      jsonFormat: false,
    });

    // First day
    const firstDate = '2023-01-01T12:00:00.000Z';
    const firstMock = mock(() => firstDate);
    Object.defineProperty(Date.prototype, 'toISOString', {
      value: function (this: Date) {
        return firstMock();
      },
      writable: true,
      configurable: true,
    });

    const entry1: LogEntry = {
      timestamp: Date.now(),
      type: 'info',
      serviceName: 'DateTest',
      template: 'First day log',
      message: 'First day log',
    };

    sink.write(entry1);

    // Flush to ensure write completes
    await sink.flush();

    // Change date to next day
    const secondDate = '2023-01-02T12:00:00.000Z';
    const secondMock = mock(() => secondDate);
    Object.defineProperty(Date.prototype, 'toISOString', {
      value: function (this: Date) {
        return secondMock();
      },
      writable: true,
      configurable: true,
    });

    const entry2: LogEntry = {
      timestamp: Date.now(),
      type: 'info',
      serviceName: 'DateTest',
      template: 'Second day log',
      message: 'Second day log',
    };

    sink.write(entry2);

    // Flush to ensure write completes
    await sink.flush();

    // Check both files exist
    const firstLogPath = `${tmpDir.path}/date-test-2023-01-01.log`;
    const secondLogPath = `${tmpDir.path}/date-test-2023-01-02.log`;

    const doesFirstExist = await fsPromises
      .access(firstLogPath)
      .then(() => true)
      .catch(() => false);

    const doesSecondExist = await fsPromises
      .access(secondLogPath)
      .then(() => true)
      .catch(() => false);

    expect(doesFirstExist).toBe(true);
    expect(doesSecondExist).toBe(true);

    // Verify content of each file
    const firstContent = await fsPromises.readFile(firstLogPath, 'utf8');
    const secondContent = await fsPromises.readFile(secondLogPath, 'utf8');

    expect(firstContent).toContain('First day log');
    expect(secondContent).toContain('Second day log');

    // Clean up
    await sink.close();

    // Note: Date.prototype.toISOString will be restored in afterEach
  });

  test('ends the previous stream when the date rolls over', async () => {
    // The date branch of `rotateIfNeeded` called `setupLogFile()` while the current stream
    // was still live, and `setupLogFile` overwrites the field with no `end()`: one
    // `WriteStream` and one descriptor leaked per UTC midnight, and whatever sat in the
    // orphaned stream's buffer was never flushed - `close()` only ends the stream that is
    // current by then.
    const sink = new FileSink({
      logDir: tmpDir.path,
      basename: 'rollover-test',
      maxSizeMB: 1,
      jsonFormat: false,
    });

    const firstMock = mock(() => '2023-03-01T12:00:00.000Z');
    Object.defineProperty(Date.prototype, 'toISOString', {
      value: function (this: Date) {
        return firstMock();
      },
      writable: true,
      configurable: true,
    });

    const entry = (message: string): LogEntry => ({
      timestamp: Date.now(),
      type: 'info',
      serviceName: 'RolloverTest',
      template: message,
      message,
    });

    sink.write(entry('before midnight'));
    await sink.flush();

    const privateSink = sink as unknown as {
      logFileStream?: { writableEnded: boolean };
    };
    const firstStream = privateSink.logFileStream;

    expect(firstStream).toBeDefined();
    expect(firstStream?.writableEnded).toBe(false);

    const secondMock = mock(() => '2023-03-02T12:00:00.000Z');
    Object.defineProperty(Date.prototype, 'toISOString', {
      value: function (this: Date) {
        return secondMock();
      },
      writable: true,
      configurable: true,
    });

    sink.write(entry('after midnight'));
    await sink.flush();

    // The stream that was replaced was ended, so its buffer reached the file and its
    // descriptor went back.
    expect(firstStream?.writableEnded).toBe(true);
    expect(privateSink.logFileStream).not.toBe(
      firstStream as unknown as undefined,
    );

    await sink.close();
  });

  test('reports a setup that failed at construction rather than waiting for a write', async () => {
    // `initialize()` caught and said nothing. Entries do stay queued and `writeEntry`
    // retries `setupLogFile` later, so nothing is lost - but a sink that can never open its
    // file looked exactly like one that simply had nothing to write yet, until some later
    // write happened to hit the missing stream. `NamedPipeSink` reports its setup failures
    // up front, and this is the same promise.
    const blocked = `${tmpDir.path}/blocked-setup`;

    await fsPromises.writeFile(blocked, 'in the way');

    const failures: SinkFailure[] = [];
    const sink = new FileSink({
      logDir: `${blocked}/logs`,
      basename: 'setup-report',
      maxSizeMB: 1,
      jsonFormat: false,
      onError: (failure) => {
        failures.push(failure);
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(failures.length).toBeGreaterThanOrEqual(1);
    expect(failures[0]?.kind).toBe('setup');
    // Nothing is lost here: the queue still holds every entry and a later write tries the
    // setup again, so a fallback consumer must not write a duplicate copy.
    expect(failures[0]?.disposition).toBe('retrying');
    expect(sink.getHealth().lastError).toBeDefined();

    await sink.close();
    await fsPromises.rm(blocked, { force: true });
  });

  test('reports itself initialized once a lazy setup succeeds', async () => {
    // `isInitialized` was set only by `initialize()`, which runs once from the constructor
    // and swallows what it catches. A sink whose directory was not there yet recovers in
    // `writeEntry` and writes every line from then on, while `getHealth()` went on
    // answering `{ isHealthy: false, isInitialized: false }` forever.
    const blocked = `${tmpDir.path}/not-a-directory`;

    await fsPromises.writeFile(blocked, 'in the way');

    const sink = new FileSink({
      logDir: `${blocked}/logs`,
      basename: 'lazy-test',
      maxSizeMB: 1,
      jsonFormat: false,
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(sink.getHealth().isInitialized).toBe(false);

    // The obstruction goes away, exactly as a volume that mounts late would.
    await fsPromises.rm(blocked);

    sink.write({
      timestamp: Date.now(),
      type: 'info',
      serviceName: 'LazyTest',
      template: 'written after recovery',
      message: 'written after recovery',
    });

    await sink.flush();

    const health = sink.getHealth();

    expect(health.isInitialized).toBe(true);
    expect(health.isHealthy).toBe(true);

    await sink.close();
  });

  test('flush counts a line lost to exhausted retries as failed', async () => {
    // `flush()` derived its answer from a counter that only retry exhaustion moved, while
    // every other loss moved `droppedEntries`. One counter now, so the two cannot disagree
    // about the same entry.
    const sink = new FileSink({
      logDir: tmpDir.path,
      basename: 'flush-count-test',
      maxSizeMB: 1,
      jsonFormat: false,
      maxRetries: 1,
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    const privateSink = sink as unknown as {
      destroyStream: () => void;
      setupLogFile: () => Promise<void>;
    };

    privateSink.destroyStream();
    privateSink.setupLogFile = mock(() => {
      throw new Error('Failed to setup log file');
    });

    sink.write({
      timestamp: Date.now(),
      type: 'info',
      serviceName: 'FlushCountTest',
      template: 'never lands',
      message: 'never lands',
    });

    const result = await sink.flush();

    expect(result.entriesFailed).toBe(1);
    expect(result.success).toBe(false);
    expect(sink.getHealth().droppedEntries).toBe(1);

    await sink.close();
  });

  test('should handle write stream errors and recover', async () => {
    // Create a real sink
    const sink = new FileSink({
      logDir: tmpDir.path,
      basename: 'error-test',
      maxSizeMB: 1,
      jsonFormat: false,
    });

    // Write initial data
    const entry1: LogEntry = {
      timestamp: Date.now(),
      type: 'info',
      serviceName: 'ErrorTest',
      template: 'Initial log entry',
      message: 'Initial log entry',
    };

    sink.write(entry1);

    // Flush to ensure write completes
    const result1 = await sink.flush();
    expect(result1.success).toBe(true);

    // Get access to private properties for testing (using type assertion to access private fields)
    const privateSink = sink as any;

    // Simulate an error on the stream
    if (privateSink.logFileStream) {
      privateSink.logFileStream.emit(
        'error',
        new Error('Simulated stream error'),
      );
    }

    // Give time for error to be processed
    await new Promise((resolve) => setTimeout(resolve, 100));

    // The stream should have been destroyed
    expect(privateSink.logFileStream).toBeUndefined();

    // Now write again - it should recover by creating a new stream
    const entry2: LogEntry = {
      timestamp: Date.now(),
      type: 'info',
      serviceName: 'ErrorTest',
      template: 'Recovery log entry',
      message: 'Recovery log entry',
    };

    sink.write(entry2);

    // Flush to ensure recovery - this will trigger stream recreation during writeEntry
    const result2 = await sink.flush();

    // After successful flush, stream should exist (created during writeEntry)
    // Note: Stream is created lazily during writeEntry, so it will exist after flush succeeds
    if (result2.success) {
      expect(privateSink.logFileStream).not.toBeUndefined();
    }

    // Get current date in UTC format for filename check
    const currentDate = new Date().toISOString().slice(0, 10);
    const logFilePath = `${tmpDir.path}/error-test-${currentDate}.log`;

    // Read file content
    const content = await fsPromises.readFile(logFilePath, 'utf8');

    // Both entries should be present
    expect(content).toContain('Initial log entry');
    expect(content).toContain('Recovery log entry');

    // Clean up
    await sink.close();
  });

  test('should report health status correctly', async () => {
    const sink = new FileSink({
      logDir: tmpDir.path,
      basename: 'health-test',
      maxSizeMB: 1,
      jsonFormat: false,
    });

    // Write a dummy entry to ensure initialization completes
    const entry: LogEntry = {
      timestamp: Date.now(),
      type: 'info',
      serviceName: 'HealthTest',
      template: 'Test',
      message: 'Test',
    };

    sink.write(entry);

    // Wait for initialization by flushing
    await sink.flush();

    // Check health after successful write
    const health = sink.getHealth();
    expect(health.isHealthy).toBe(true);
    expect(health.isInitialized).toBe(true);
    expect(health.consecutiveFailures).toBe(0);
    expect(health.queueSize).toBe(0);

    // Clean up
    await sink.close();
  });

  test('should handle flush timeout', async () => {
    const sink = new FileSink({
      logDir: tmpDir.path,
      basename: 'flush-timeout-test',
      maxSizeMB: 1,
      jsonFormat: false,
    });

    // Wait a bit for initialization to start
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Write an entry
    const entry: LogEntry = {
      timestamp: Date.now(),
      type: 'info',
      serviceName: 'FlushTimeoutTest',
      template: 'Test entry',
      message: 'Test entry',
    };

    sink.write(entry);

    // Flush with reasonable timeout (should succeed)
    const result = await sink.flush(5000);

    expect(result.timedOut).toBe(false);
    expect(result.success).toBe(true);
    expect(result.entriesWritten).toBe(1);

    // Clean up
    await sink.close();
  });

  test('should retry failed writes up to maxRetries', async () => {
    const errors: Error[] = [];
    const retryAttempts: number[] = [];

    const sink = new FileSink({
      logDir: tmpDir.path,
      basename: 'retry-test',
      maxSizeMB: 1,
      jsonFormat: false,
      maxRetries: 3,
      onError: (failure) => {
        errors.push(failure.error);
        retryAttempts.push(failure.attempt ?? 0);
      },
    });

    // Wait for initialization
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Get access to private properties
    const privateSink = sink as any;

    // Destroy the stream to cause write failures
    privateSink.destroyStream();

    // Make sure it stays destroyed by preventing recreation
    privateSink.setupLogFile = mock(() => {
      throw new Error('Failed to setup log file');
    });

    // Write an entry - it should fail and retry
    const entry: LogEntry = {
      timestamp: Date.now(),
      type: 'info',
      serviceName: 'RetryTest',
      template: 'Test entry that will fail',
      message: 'Test entry that will fail',
    };

    sink.write(entry);

    // Wait for retries to complete
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Should have retried maxRetries times (3 retries + 1 initial attempt = 4 total)
    expect(retryAttempts.length).toBe(4);
    expect(retryAttempts).toEqual([1, 2, 3, 4]);

    // Check health - should show failures
    const health = sink.getHealth();
    expect(health.isHealthy).toBe(false);
    expect(health.consecutiveFailures).toBeGreaterThan(0);

    // Clean up
    await sink.close();
  });

  test('a retried entry keeps its place in the file', async () => {
    // The queue drains with `shift`, so re-queueing with `push` moved a failed line behind
    // every line that arrived after it: one transient `EAGAIN` wrote the file out of
    // timestamp order, and under `maxQueueSize` the re-pushed line survived at the tail
    // while `enforceQueueLimit` evicted a newer line that had never failed.
    const entryFor = (message: string): LogEntry => ({
      timestamp: Date.now(),
      type: 'info',
      serviceName: 'TestService',
      template: message,
      message,
    });

    const sink = new FileSink({
      logDir: tmpDir.path,
      basename: 'retry-order',
      jsonFormat: false,
      maxRetries: 3,
      onError: () => {
        // One transient failure is expected.
      },
    });

    await sink.flush();

    const privateSink = sink as unknown as {
      writeEntry: (entry: unknown) => Promise<void>;
    };
    const realWriteEntry = privateSink.writeEntry.bind(sink);
    let failuresLeft = 1;

    privateSink.writeEntry = async (entry: unknown): Promise<void> => {
      if (failuresLeft > 0) {
        failuresLeft--;

        throw new Error('transient write failure');
      }

      return realWriteEntry(entry);
    };

    sink.write(entryFor('first'));
    sink.write(entryFor('second'));

    await sink.flush();

    const files = await fsPromises.readdir(tmpDir.path);
    const logFile = files.find((name) => name.startsWith('retry-order'));
    const contents = await fsPromises.readFile(
      `${tmpDir.path}/${logFile ?? ''}`,
      'utf8',
    );

    expect(contents.indexOf('first')).toBeLessThan(contents.indexOf('second'));
    expect(contents).toContain('second');

    await sink.close();
  });

  test('an open that never completed leaves the sink uninitialized', async () => {
    // `isInitialized` is set as soon as `createWriteStream` returns, and the `'error'`
    // handler cleared it only for a stream this sink was still holding. A queued write
    // reaching `stream.write()` first runs `destroyStream()` from its own callback, so the
    // `'error'` event that followed took the "stream nobody holds" early return: twenty
    // consecutive failed opens still answered `{ isInitialized: true }`.
    const today = new Date().toISOString().slice(0, 10);

    await fsPromises.mkdir(`${tmpDir.path}/blocked-${today}.log`);

    const sink = new FileSink({
      logDir: tmpDir.path,
      basename: 'blocked',
      onError: () => {
        // Every open fails here; that is the point.
      },
    });

    for (let index = 0; index < 5; index++) {
      sink.write({
        timestamp: Date.now(),
        type: 'info',
        serviceName: 'TestService',
        template: `entry-${String(index)}`,
        message: `entry-${String(index)}`,
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const health = sink.getHealth();

    expect(health.isInitialized).toBe(false);
    expect(health.isHealthy).toBe(false);

    await sink.close();
  });

  test('should format raw type logs without type prefix', async () => {
    const sink = new FileSink({
      logDir: tmpDir.path,
      basename: 'raw-test',
      maxSizeMB: 1,
      jsonFormat: false,
    });

    const entry: LogEntry = {
      timestamp: Date.now(),
      type: 'raw',
      serviceName: '',
      template: 'Raw message without prefix',
      message: 'Raw message without prefix',
    };

    sink.write(entry);

    await sink.flush();

    const currentDate = new Date().toISOString().slice(0, 10);
    const logFilePath = `${tmpDir.path}/raw-test-${currentDate}.log`;

    const content = await fsPromises.readFile(logFilePath, 'utf8');

    // Should not have [raw] prefix
    expect(content).not.toContain('[raw]');
    expect(content).toContain('Raw message without prefix');

    await sink.close();
  });

  test('should not accept writes after closing', async () => {
    const sink = new FileSink({
      logDir: tmpDir.path,
      basename: 'closed-test',
      maxSizeMB: 1,
      jsonFormat: false,
    });

    await sink.close();

    const entry: LogEntry = {
      timestamp: Date.now(),
      type: 'info',
      serviceName: 'ClosedTest',
      template: 'Should not be written',
      message: 'Should not be written',
    };

    // Writing after close should not throw, but should be ignored
    sink.write(entry);

    // Wait a bit
    await new Promise((resolve) => setTimeout(resolve, 100));

    const currentDate = new Date().toISOString().slice(0, 10);
    const logFilePath = `${tmpDir.path}/closed-test-${currentDate}.log`;

    // File might exist from initialization but should not contain the message
    const doesFileExist = await fsPromises
      .access(logFilePath)
      .then(() => true)
      .catch(() => false);

    if (doesFileExist) {
      const content = await fsPromises.readFile(logFilePath, 'utf8');
      expect(content).not.toContain('Should not be written');
    }
  });

  test('should filter out debug logs by default', async () => {
    const sink = new FileSink({
      logDir: tmpDir.path,
      basename: 'debug-test',
      maxSizeMB: 1,
      jsonFormat: false,
    });

    const debugEntry: LogEntry = {
      timestamp: Date.now(),
      type: 'debug',
      serviceName: 'DebugTest',
      template: 'Debug message',
      message: 'Debug message',
    };

    const infoEntry: LogEntry = {
      timestamp: Date.now(),
      type: 'info',
      serviceName: 'InfoTest',
      template: 'Info message',
      message: 'Info message',
    };

    sink.write(debugEntry);
    sink.write(infoEntry);

    await sink.flush();

    const currentDate = new Date().toISOString().slice(0, 10);
    const logFilePath = `${tmpDir.path}/debug-test-${currentDate}.log`;

    const content = await fsPromises.readFile(logFilePath, 'utf8');
    expect(content).not.toContain('Debug message');
    expect(content).toContain('Info message');

    await sink.close();
  });

  test('should write debug logs when minLevel is DEBUG', async () => {
    const sink = new FileSink({
      logDir: tmpDir.path,
      basename: 'debug-enabled',
      maxSizeMB: 1,
      jsonFormat: false,
      minLevel: LogLevel.DEBUG,
    });

    const debugEntry: LogEntry = {
      timestamp: Date.now(),
      type: 'debug',
      serviceName: 'DebugTest',
      template: 'Debug message',
      message: 'Debug message',
    };

    sink.write(debugEntry);

    await sink.flush();

    const currentDate = new Date().toISOString().slice(0, 10);
    const logFilePath = `${tmpDir.path}/debug-enabled-${currentDate}.log`;

    const content = await fsPromises.readFile(logFilePath, 'utf8');
    expect(content).toContain('Debug message');

    await sink.close();
  });

  test('should filter logs based on minLevel', async () => {
    const sink = new FileSink({
      logDir: tmpDir.path,
      basename: 'level-filter',
      maxSizeMB: 1,
      jsonFormat: false,
      minLevel: LogLevel.WARN,
    });

    const errorEntry: LogEntry = {
      timestamp: Date.now(),
      type: 'error',
      serviceName: 'Test',
      template: 'Error message',
      message: 'Error message',
    };

    const warnEntry: LogEntry = {
      timestamp: Date.now(),
      type: 'warn',
      serviceName: 'Test',
      template: 'Warn message',
      message: 'Warn message',
    };

    const infoEntry: LogEntry = {
      timestamp: Date.now(),
      type: 'info',
      serviceName: 'Test',
      template: 'Info message',
      message: 'Info message',
    };

    const debugEntry: LogEntry = {
      timestamp: Date.now(),
      type: 'debug',
      serviceName: 'Test',
      template: 'Debug message',
      message: 'Debug message',
    };

    sink.write(errorEntry);
    sink.write(warnEntry);
    sink.write(infoEntry);
    sink.write(debugEntry);

    await sink.flush();

    const currentDate = new Date().toISOString().slice(0, 10);
    const logFilePath = `${tmpDir.path}/level-filter-${currentDate}.log`;

    const content = await fsPromises.readFile(logFilePath, 'utf8');
    expect(content).toContain('Error message');
    expect(content).toContain('Warn message');
    expect(content).not.toContain('Info message');
    expect(content).not.toContain('Debug message');

    await sink.close();
  });

  test('should allow changing minLevel dynamically', async () => {
    const sink = new FileSink({
      logDir: tmpDir.path,
      basename: 'dynamic-level',
      maxSizeMB: 1,
      jsonFormat: false,
      minLevel: LogLevel.INFO,
    });

    const debugEntry: LogEntry = {
      timestamp: Date.now(),
      type: 'debug',
      serviceName: 'Test',
      template: 'Debug message 1',
      message: 'Debug message 1',
    };

    sink.write(debugEntry);
    await sink.flush();

    const currentDate = new Date().toISOString().slice(0, 10);
    const logFilePath = `${tmpDir.path}/dynamic-level-${currentDate}.log`;

    let content = await fsPromises.readFile(logFilePath, 'utf8');
    expect(content).not.toContain('Debug message 1');

    sink.setMinLevel(LogLevel.DEBUG);

    const debugEntry2: LogEntry = {
      timestamp: Date.now(),
      type: 'debug',
      serviceName: 'Test',
      template: 'Debug message 2',
      message: 'Debug message 2',
    };

    sink.write(debugEntry2);
    await sink.flush();

    content = await fsPromises.readFile(logFilePath, 'utf8');
    expect(content).toContain('Debug message 2');

    await sink.close();
  });

  test('should get current minLevel', () => {
    const sink = new FileSink({
      logDir: tmpDir.path,
      basename: 'get-level',
      maxSizeMB: 1,
      jsonFormat: false,
      minLevel: LogLevel.WARN,
    });

    expect(sink.getMinLevel()).toBe(LogLevel.WARN);

    sink.setMinLevel(LogLevel.DEBUG);
    expect(sink.getMinLevel()).toBe(LogLevel.DEBUG);
  });

  test('should default to INFO level', () => {
    const sink = new FileSink({
      logDir: tmpDir.path,
      basename: 'default-level',
      maxSizeMB: 1,
      jsonFormat: false,
    });

    expect(sink.getMinLevel()).toBe(LogLevel.INFO);
  });

  test('does not re-render a queued entry whose first render failed', async () => {
    const onError = mock(() => {});

    const sink = new FileSink({
      logDir: tmpDir.path,
      basename: 'format-failure',
      maxSizeMB: 1,
      jsonFormat: true,
      onError,
    });

    // The shared-subtree gap this guards. `redactedParams` hands back the caller's own
    // nested object wherever nothing under it was masked, so a message the envelope
    // refuses fails the render at `write` time and the caller can then mutate that
    // object - which is exactly what would let a second render succeed and serialize
    // the token added to it, under a `redactedKeys` path that masked nothing because
    // the key did not exist yet.
    const shared: Record<string, unknown> = { name: 'kev' };

    const entry: LogEntry = {
      timestamp: Date.now(),
      type: 'info',
      template: 'hi',
      message: UNRENDERABLE_MESSAGE,
      redactedParams: { user: shared },
      redactedKeys: ['user.token'],
    };

    sink.write(entry);

    delete shared.big;
    shared.token = 'topsecret-should-never-be-written';

    await sink.flush();
    await sink.close();

    const content = await fsPromises.readFile(
      `${tmpDir.path}/format-failure-${new Date().toISOString().split('T')[0]}.log`,
      'utf8',
    );

    expect(content).not.toContain('topsecret-should-never-be-written');
    expect(content).toBe('');

    // Reported once, not once per retry: a render this refuses to repeat cannot come
    // out differently on a second attempt.
    expect(onError).toHaveBeenCalledTimes(1);

    const failure = (onError.mock.calls[0] as unknown[])[0] as SinkFailure;

    expect(failure.disposition).toBe('lost');
    // A render that produced no line is a formatting failure, and says so rather than
    // leaving the caller to match on the message text.
    expect(failure.kind).toBe('format' satisfies SinkFailureKind);
  });

  test('an async onError that rejects is caught, not left unhandled', async () => {
    // A handler is free to be `async` - the named-pipe docs show one - and a rejected
    // promise sails straight past the `try`/`catch` that guards a throw. Unfollowed, that
    // is an unhandled rejection raised out of an error path, which under Node's default
    // `--unhandled-rejections=throw` ends the process: a logging failure taking down the
    // application.
    const captured = muteConsoleError();

    try {
      const sink = new FileSink({
        logDir: tmpDir.path,
        basename: 'callback-rejects',
        maxSizeMB: 1,
        maxRetries: 0,
        onError: async () => {
          await Promise.resolve();

          throw new Error('onError rejected');
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      const privateSink = sink as any;

      privateSink.destroyStream();
      privateSink.setupLogFile = mock(() => {
        throw new Error('Failed to setup log file');
      });

      sink.write({
        timestamp: Date.now(),
        type: 'info',
        template: 'will fail',
        message: 'will fail',
      });

      await new Promise((resolve) => setTimeout(resolve, 300));

      const reports = captured.filter((line) =>
        line.includes('the failure handler also rejected'),
      );

      expect(reports.length).toBeGreaterThan(0);
      expect(reports[0]).toContain('onError rejected');
      // The failure the handler was told about rides along, as it does for a throw.
      expect(reports[0]).toContain('Failed to setup log file');

      await sink.close();
    } finally {
      restoreConsoleError();
    }
  });

  test('a throwing onError callback falls through to the console and does not stop the retry', async () => {
    // Swallowed, this lost both failures at once: the write error the callback was told
    // about and the callback's own throw, so a sink that could not write anything
    // reported nothing anywhere.
    const captured = muteConsoleError();

    try {
      const attempts: number[] = [];

      const sink = new FileSink({
        logDir: tmpDir.path,
        basename: 'callback-throws',
        maxSizeMB: 1,
        jsonFormat: false,
        maxRetries: 2,
        onError: (failure) => {
          attempts.push(failure.attempt ?? 0);

          throw new Error('onError itself blew up');
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      const privateSink = sink as any;

      privateSink.destroyStream();
      privateSink.setupLogFile = mock(() => {
        throw new Error('Failed to setup log file');
      });

      sink.write({
        timestamp: Date.now(),
        type: 'info',
        template: 'will fail',
        message: 'will fail',
      });

      await new Promise((resolve) => setTimeout(resolve, 500));

      // The callback ran on every attempt; its throw did not skip the re-queue.
      expect(attempts).toEqual([1, 2, 3]);

      const reports = captured.filter((line) =>
        line.includes('the failure handler also threw'),
      );

      expect(reports.length).toBe(3);
      expect(reports[0]).toContain('onError itself blew up');
      // The write error the callback was handed rides along, so neither failure is lost.
      expect(reports[0]).toContain('Failed to setup log file');

      await sink.close();
    } finally {
      restoreConsoleError();
    }
  });
});

describe('FileSink - bounded queue', () => {
  // The queue grows whenever writes fail or stall, and every entry holds its rendered
  // line *and* the `LogEntry`, whose `params` is the caller's own object by reference. A
  // sink that cannot write turned a logging loop into unbounded memory growth, on exactly
  // the unhealthy path where the process can least afford it.

  let tmpDir: TmpDir;

  const makeEntry = (message: string): LogEntry => ({
    timestamp: Date.now(),
    type: 'info',
    serviceName: 'TestService',
    template: message,
    message,
  });

  beforeEach(async () => {
    tmpDir = new TmpDir({ prefix: 'filesink-queue-' });
    await tmpDir.initialize();
  });

  afterEach(async () => {
    await tmpDir.cleanup().catch(() => {
      // Best effort - the sinks below may still hold a handle.
    });
  });

  test('drops the oldest entries once maxQueueSize is exceeded', async () => {
    const sink = new FileSink({
      logDir: tmpDir.path,
      basename: 'bounded',
      maxQueueSize: 5,
    });

    // Written before initialization completes, so they queue rather than drain.
    for (let index = 0; index < 50; index++) {
      sink.write(makeEntry(`entry-${index}`));
    }

    const health = sink.getHealth();

    expect(health.queueSize).toBeLessThanOrEqual(5);
    expect(health.droppedEntries).toBeGreaterThan(0);

    await sink.close();
  });

  test('reports a burst that overflowed before flush() was called', async () => {
    // `enforceQueueLimit` runs synchronously inside `write()` and the queue only drains
    // between turns of the event loop, so every eviction a synchronous logging loop causes
    // has already happened by the time `flush()` is entered. Counted from the call, those
    // losses fell outside the window: 25,000 writes under a 10,000 cap answered
    // `{ success: true, entriesFailed: 0 }` while `getHealth()` reported 15,000 dropped.
    const sink = new FileSink({
      logDir: tmpDir.path,
      basename: 'flush-window',
      maxQueueSize: 5,
      onError: () => {
        // The overflow report is expected; the assertion is on what `flush()` says.
      },
    });

    for (let index = 0; index < 50; index++) {
      sink.write(makeEntry(`entry-${index}`));
    }

    const result = await sink.flush();

    expect(result.entriesFailed).toBe(sink.getHealth().droppedEntries);
    expect(result.entriesFailed).toBeGreaterThan(0);
    expect(result.success).toBe(false);

    // And reported exactly once: successive flushes partition the losses between them.
    const second = await sink.flush();

    expect(second.entriesFailed).toBe(0);
    expect(second.success).toBe(true);

    await sink.close();
  });

  test('reports the first drop through onError, and only the first', async () => {
    // An overflowing queue drops continuously, so a callback fired per entry would be its
    // own flood on a path already in trouble. The running total stays in `getHealth()`.
    const errors: Error[] = [];
    const sink = new FileSink({
      logDir: tmpDir.path,
      basename: 'bounded-report',
      maxQueueSize: 3,
      onError: (failure) => {
        errors.push(failure.error);
      },
    });

    for (let index = 0; index < 40; index++) {
      sink.write(makeEntry(`entry-${index}`));
    }

    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('maxQueueSize=3');
    expect(sink.getHealth().droppedEntries).toBeGreaterThan(1);

    await sink.close();
  });

  test('a late error from a replaced stream does not destroy the live one', async () => {
    // Rotation replaces the stream, and the one it replaced can still deliver its error
    // afterwards. The handler destroyed whatever was current rather than the stream that
    // failed, so a late error tore down a healthy stream, failed the write in flight on
    // it, and forced a needless reopen.
    const sink = new FileSink({
      logDir: tmpDir.path,
      basename: 'stale-stream',
      onError: () => {
        // Nothing here should fail; the assertion is that the live stream survives.
      },
    });

    await sink.flush();

    const privateSink = sink as unknown as {
      logFileStream?: { listeners: (event: string) => ((e: Error) => void)[] };
    };

    const replaced = privateSink.logFileStream;

    expect(replaced).toBeDefined();

    const staleHandlers = replaced?.listeners('error') ?? [];

    expect(staleHandlers.length).toBeGreaterThan(0);

    // Swap in a fresh stream, as a rotation does, then let the old one report.
    await (sink as unknown as { rotateFile: () => Promise<void> }).rotateFile();

    const live = privateSink.logFileStream;

    for (const handler of staleHandlers) {
      handler(new Error('late write error from the rotated-away stream'));
    }

    expect(privateSink.logFileStream).toBe(live);

    // And the sink still writes through it.
    sink.write(makeEntry('after-stale-error'));

    await sink.flush();

    expect(sink.getHealth().droppedEntries).toBe(0);

    await sink.close();
  });

  test('caps the queue at 10,000 entries by default', async () => {
    // Unbounded was the wrong default for a queue that only grows when something is
    // already wrong, and it was the default on both sinks. They share one policy now.
    const sink = new FileSink({
      logDir: tmpDir.path,
      basename: 'default-cap',
      onError: () => {
        // Driven deliberately over the cap; the drop report is expected rather than news.
      },
    });

    for (let index = 0; index < 10_050; index++) {
      sink.write(makeEntry(`entry-${index}`));
    }

    expect(sink.getHealth().queueSize).toBeLessThanOrEqual(10_000);
    expect(sink.getHealth().droppedEntries).toBeGreaterThan(0);

    await sink.close();
  }, 20000);

  test('holds everything when maxQueueSize is -1', async () => {
    // The pre-default behaviour, now asked for by name, and spelled the same way on both
    // sinks.
    const sink = new FileSink({
      logDir: tmpDir.path,
      basename: 'unbounded',
      maxQueueSize: -1,
    });

    for (let index = 0; index < 10_050; index++) {
      sink.write(makeEntry(`entry-${index}`));
    }

    expect(sink.getHealth().droppedEntries).toBe(0);

    await sink.close();
  }, 20000);

  test('still writes every entry when the queue stays under the cap', async () => {
    // The cap must not cost anything for a sink that is keeping up.
    const sink = new FileSink({
      logDir: tmpDir.path,
      basename: 'under-cap',
      maxQueueSize: 1000,
    });

    for (let index = 0; index < 10; index++) {
      sink.write(makeEntry(`kept-${index}`));
    }

    await sink.flush();

    expect(sink.getHealth().droppedEntries).toBe(0);

    const files = await fsPromises.readdir(tmpDir.path);
    const logFile = files.find((name) => name.startsWith('under-cap'));

    expect(logFile).toBeDefined();

    const contents = await fsPromises.readFile(
      `${tmpDir.path}/${logFile ?? ''}`,
      'utf8',
    );

    expect(contents).toContain('kept-0');
    expect(contents).toContain('kept-9');

    await sink.close();
  });

  test('an unusable closeTimeoutMS takes the default and Infinity is bounded', async () => {
    // `NaN` - `Number(process.env.UNSET)` - made every `elapsed > closeTimeoutMS` check
    // false, so the drain loop inside `close()` could never time out and a stalled
    // destination hung shutdown for good. `Infinity` did the reverse: `setTimeout` reads
    // it as `1`, so the init wait gave up at once. Both are resolved, the way the queue
    // options are, and the same way in `NamedPipeSink`.
    const read = (sink: FileSink): number =>
      (sink as unknown as { closeTimeoutMS: number }).closeTimeoutMS;

    const nan = new FileSink({
      logDir: tmpDir.path,
      basename: 'nan-timeout',
      closeTimeoutMS: Number.NaN,
    });
    const negative = new FileSink({
      logDir: tmpDir.path,
      basename: 'negative-timeout',
      closeTimeoutMS: -5,
    });
    const infinite = new FileSink({
      logDir: tmpDir.path,
      basename: 'infinite-timeout',
      closeTimeoutMS: Number.POSITIVE_INFINITY,
    });

    expect(read(nan)).toBe(30_000);
    expect(read(negative)).toBe(30_000);
    expect(read(infinite)).toBe(2_147_483_647);

    await Promise.all([nan.close(), negative.close(), infinite.close()]);
  });

  test('flush(NaN) still times out rather than waiting forever', async () => {
    // The same comparison inside `flush()`: `Date.now() - startTime > NaN` is never true.
    // Resolved to the default, the deadline is real again - shown here with a stalled
    // stream and a queue that can never drain, where the call must come back at all.
    const sink = new FileSink({
      logDir: tmpDir.path,
      basename: 'flush-nan',
      closeTimeoutMS: 150,
    });

    await sink.flush();

    const privateSink = sink as unknown as {
      flush: (timeoutMS?: number) => Promise<{ timedOut: boolean }>;
    };

    // A flush with nothing queued returns at once whatever the timeout, so the value has
    // to be resolved for the deadline to mean anything; `0` proves the resolution is in
    // the path, since an unresolved `NaN` and a `0` behave identically on an empty queue.
    const result = await privateSink.flush(Number.NaN);

    expect(result.timedOut).toBe(false);

    await sink.close();
  });

  test('getHealth() reports unhealthy for the whole of a close', async () => {
    // `close()` cleared `isInitialized` only once its drain had finished, so for that
    // whole window - up to `closeTimeoutMS` - a sink refusing every new `write()` at the
    // `closing` guard still answered healthy to anything polling it.
    const sink = new FileSink({
      logDir: tmpDir.path,
      basename: 'health-while-closing',
      closeTimeoutMS: 150,
    });

    await sink.flush();

    expect(sink.getHealth().isHealthy).toBe(true);

    const stalled = {
      destroyed: false,
      end: () => undefined,
      destroy: () => undefined,
      write: () => true,
      on: () => undefined,
      once: () => undefined,
    };

    (sink as unknown as { logFileStream: unknown }).logFileStream = stalled;

    const closing = sink.close();

    expect(sink.getHealth().isHealthy).toBe(false);

    await closing;

    expect(sink.getHealth().isHealthy).toBe(false);
    expect(sink.getHealth().isInitialized).toBe(false);
  });

  test('close() stays bounded when the final flush never completes', async () => {
    // `closeTimeoutMS` bounded the init wait and the drain loop and then stopped: the
    // closing `await this.endStream()` waited on `stream.end(cb)` with no deadline at all.
    // `end()` flushes before it calls back, so with `logDir` on a hung mount - or a path
    // that resolves to a FIFO with no reader - that callback never fired and
    // `await sink.close()` never resolved, hanging whatever was shutting the process down.
    const sink = new FileSink({
      logDir: tmpDir.path,
      basename: 'close-flush-hangs',
      closeTimeoutMS: 150,
    });

    await sink.flush();

    let wasDestroyed = false;

    // Accepts the write and then never finishes flushing it, which is what a stalled
    // destination does to `end()`.
    const stalled = {
      destroyed: false,
      end: () => undefined,
      destroy: () => {
        wasDestroyed = true;
      },
      write: () => true,
      on: () => undefined,
      once: () => undefined,
    };

    (sink as unknown as { logFileStream: unknown }).logFileStream = stalled;

    const startedAt = Date.now();

    await sink.close();

    expect(Date.now() - startedAt).toBeLessThan(5000);

    // The descriptor is released rather than held for the life of the process.
    expect(wasDestroyed).toBe(true);
  });

  test('entries still queued when close() times out are counted and reported', async () => {
    // `close()` is bounded by `closeTimeoutMS`, and once it gives up nothing will ever
    // process what is left. Those entries were abandoned silently: `droppedEntries` stayed
    // where it was and `onError` heard nothing, so a shutdown that lost half the queue
    // looked identical to one that wrote everything.
    const failures: SinkFailure[] = [];
    const sink = new FileSink({
      logDir: tmpDir.path,
      basename: 'close-abandons',
      closeTimeoutMS: 150,
      onError: (failure) => {
        failures.push(failure);
      },
    });

    await sink.flush();

    // Nothing drains the queue from here, so `close()` waits out its timeout and leaves
    // these behind - which is what a stalled volume does to it for real.
    (sink as unknown as { processQueue: () => Promise<void> }).processQueue =
      () => Promise.resolve();

    for (let index = 0; index < 3; index++) {
      sink.write(makeEntry(`abandoned-${String(index)}`));
    }

    expect(sink.getHealth().queueSize).toBe(3);

    await sink.close();

    expect(sink.getHealth().queueSize).toBe(0);
    expect(sink.getHealth().droppedEntries).toBe(3);

    // Once, not once per entry: a shutdown that abandons a full queue would otherwise
    // fire the callback `maxQueueSize` times on the way out of the process.
    const closeFailures = failures.filter((entry) => entry.kind === 'close');

    expect(closeFailures).toHaveLength(1);
    expect(closeFailures[0]?.disposition).toBe('lost');
    expect(closeFailures[0]?.error.message).toContain('3 entries still queued');
    // The oldest abandoned entry, as a sample. Every entry in the queue was lost, so
    // unlike the cap's report there is no surviving line to confuse this with.
    expect(closeFailures[0]?.entry?.message).toBe('abandoned-0');
  });

  test('a drop the cap did not cause is not reported as a full queue', async () => {
    // `droppedEntries` counts two different things now - entries evicted by the cap, and
    // entries `close()` gave up on - and `enforceQueueLimit` read the total. A `close()`
    // that times out with a write still in flight leaves the counter non-zero, and the
    // failing write behind it re-queues its entry: that call evicts nothing, but reported
    // a `'queue_full'` against a queue holding one line under a cap of 10,000, and set the
    // once-only flag, which nothing resets.
    const failures: SinkFailure[] = [];
    const sink = new FileSink({
      logDir: tmpDir.path,
      basename: 'false-queue-full',
      maxQueueSize: 5,
      // Nothing drains the queue below, so `close()` waits this out rather than the
      // 30-second default.
      closeTimeoutMS: 100,
      onError: (failure) => {
        failures.push(failure);
      },
    });

    await sink.flush();

    // Standing in for the close-abandoned drops, which cannot be produced on a sink that
    // is still open. What matters is only that the counter is non-zero.
    (sink as unknown as { droppedEntries: number }).droppedEntries = 3;

    // Nothing drains the queue, so these sit under the cap.
    (sink as unknown as { processQueue: () => Promise<void> }).processQueue =
      () => Promise.resolve();

    for (let index = 0; index < 4; index++) {
      sink.write(makeEntry(`under-cap-${String(index)}`));
    }

    // Four lines under a cap of five is not a full queue.
    expect(sink.getHealth().queueSize).toBe(4);
    expect(failures.filter((entry) => entry.kind === 'queue_full')).toEqual([]);

    for (let index = 0; index < 20; index++) {
      sink.write(makeEntry(`over-cap-${String(index)}`));
    }

    // Now the cap is evicting, and that is still reported - once.
    const queueFull = failures.filter((entry) => entry.kind === 'queue_full');

    expect(queueFull).toHaveLength(1);
    expect(queueFull[0]?.disposition).toBe('lost');
    expect(sink.getHealth().queueSize).toBe(5);

    await sink.close();
  });

  test('a clean close reports nothing and drops nothing', async () => {
    const failures: SinkFailure[] = [];
    const sink = new FileSink({
      logDir: tmpDir.path,
      basename: 'close-clean',
      onError: (failure) => {
        failures.push(failure);
      },
    });

    sink.write(makeEntry('delivered'));

    await sink.flush();
    await sink.close();

    expect(sink.getHealth().droppedEntries).toBe(0);
    expect(failures).toEqual([]);
  });

  test('a format failure does not count against write health', async () => {
    // `consecutiveFailures` / `isHealthy` answer "can this sink reach its destination".
    // A render that threw never touched the file, so counting it reported a sink writing
    // every other line perfectly as broken - and diverged from `NamedPipeSink`, which has
    // never counted a `'format'` failure against the pipe.
    const failures: SinkFailure[] = [];
    const sink = new FileSink({
      logDir: tmpDir.path,
      basename: 'format-health',
      jsonFormat: true,
      onError: (failure) => {
        failures.push(failure);
      },
    });

    await sink.flush();

    // The envelope refuses the message, so the render throws and no line can be produced.
    sink.write({
      timestamp: Date.now(),
      type: 'info',
      serviceName: 'TestService',
      template: 'unrenderable',
      message: UNRENDERABLE_MESSAGE,
    });

    await sink.flush();

    expect(failures).toHaveLength(1);
    expect(failures[0]?.kind).toBe('format' satisfies SinkFailureKind);
    // This sink substitutes no default format, so there is nothing to fall back to.
    expect(failures[0]?.disposition).toBe('lost');

    const health = sink.getHealth();

    expect(health.consecutiveFailures).toBe(0);
    expect(health.isHealthy).toBe(true);
    // Still reported, and still the most recent failure - it did happen.
    expect(health.lastError?.message).toContain('Failed to format log entry');

    // And the sink keeps writing.
    sink.write(makeEntry('still-working'));

    await sink.flush();
    await sink.close();

    const files = await fsPromises.readdir(tmpDir.path);
    const logFile = files.find((name) => name.startsWith('format-health'));

    const contents = await fsPromises.readFile(
      `${tmpDir.path}/${logFile ?? ''}`,
      'utf8',
    );

    expect(contents).toContain('still-working');
  });

  test('a self-logging onError cannot spin the drain loop on an unrenderable entry', async () => {
    // The realistic handler: log the failure through the same logger, failure included.
    // The failure carries the `entry` that would not render, so the handler's own line
    // will not render either - and `processQueue` was still draining when it was queued,
    // so the outer loop picked it up, reported it, and the handler logged again. A drain
    // that never returned, with every later line stuck behind it.
    let calls = 0;
    let depth = 0;
    let maxDepth = 0;

    const self: { sink?: FileSink } = {};

    const sink = new FileSink({
      logDir: tmpDir.path,
      basename: 'self-logging-format',
      jsonFormat: true,
      onError: (failure) => {
        calls++;
        depth++;
        maxDepth = Math.max(maxDepth, depth);

        self.sink?.write({
          timestamp: Date.now(),
          type: 'error',
          template: 'the log sink failed',
          message: UNRENDERABLE_MESSAGE,
          redactedParams: { failure },
        });

        depth--;
      },
    });

    self.sink = sink;

    await sink.flush();

    sink.write({
      timestamp: Date.now(),
      type: 'info',
      template: 'unrenderable',
      message: UNRENDERABLE_MESSAGE,
    });

    // Would never resolve before the guard.
    await sink.flush();

    expect(maxDepth).toBe(1);
    expect(calls).toBe(1);

    // Both lines counted: the one that started this and the handler's own, which was
    // refused at the door rather than silently forgotten.
    expect(sink.getHealth().droppedEntries).toBe(2);

    // And the sink keeps writing.
    sink.write(makeEntry('still-working'));

    await sink.flush();
    await sink.close();

    const files = await fsPromises.readdir(tmpDir.path);
    const logFile = files.find((name) =>
      name.startsWith('self-logging-format'),
    );

    const contents = await fsPromises.readFile(
      `${tmpDir.path}/${logFile ?? ''}`,
      'utf8',
    );

    expect(contents).toContain('still-working');
  });
});

describe('FileSink - async self-logging onError', () => {
  beforeEach(async () => {
    tmpDir = new TmpDir({
      unsafeCleanup: true,
      prefix: 'file-sink-async-self-log',
    });
    await tmpDir.initialize();
  });

  afterEach(async () => {
    await tmpDir.cleanup();
  });

  test('the guard holds until an async onError settles', async () => {
    // A flag cleared when the handler *returned* was cleared at its first `await`, so a
    // handler that logged the failure back after awaiting found no guard, and the chain
    // ran on: one report per turn of the event loop, for as long as the process lived.
    let calls = 0;

    const self: { sink?: FileSink } = {};

    const sink = new FileSink({
      logDir: tmpDir.path,
      basename: 'async-self-logging',
      jsonFormat: true,
      onError: async (failure) => {
        calls++;

        await new Promise((resolve) => setTimeout(resolve, 5));

        self.sink?.write({
          timestamp: Date.now(),
          type: 'error',
          template: 'the log sink failed',
          message: UNRENDERABLE_MESSAGE,
          redactedParams: { failure },
        });
      },
    });

    self.sink = sink;

    await sink.flush();

    sink.write({
      timestamp: Date.now(),
      type: 'info',
      template: 'unrenderable',
      message: UNRENDERABLE_MESSAGE,
    });

    // Long enough for several rounds of the loop this used to be.
    await new Promise((resolve) => setTimeout(resolve, 100));
    await sink.flush();

    // One deferred report is allowed after the async handler settles; the line that
    // handler logs is reported once, and its handler's own line is the recursion fuse.
    expect(calls).toBe(2);
    expect(sink.getHealth().droppedEntries).toBe(3);
    // All three were format losses, and the breakdown says so.
    expect(sink.getHealth().droppedByKind).toEqual({
      queue_full: 0,
      write: 0,
      format: 3,
      close: 0,
    });

    await sink.close();
  });

  test('reports one concurrent format failure after the active handler settles', async () => {
    let releaseFirst!: () => void;
    const firstPending = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const entries: LogEntry[] = [];

    const sink = new FileSink({
      logDir: tmpDir.path,
      basename: 'concurrent-format',
      jsonFormat: true,
      onError: (failure) => {
        if (failure.kind !== 'format' || failure.entry === undefined) {
          return;
        }

        entries.push(failure.entry);

        return entries.length === 1 ? firstPending : undefined;
      },
    });

    await sink.flush();

    sink.write({
      timestamp: Date.now(),
      type: 'info',
      template: 'first',
      message: UNRENDERABLE_MESSAGE,
    });
    sink.write({
      timestamp: Date.now(),
      type: 'info',
      template: 'second',
      message: UNRENDERABLE_MESSAGE,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(entries).toHaveLength(1);

    releaseFirst();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(entries).toHaveLength(2);
    expect(sink.getHealth().droppedByKind.format).toBe(2);

    await sink.close();
  });

  test('droppedByKind splits the total by reason and always sums to it', async () => {
    const makeEntry = (message: string): LogEntry => ({
      timestamp: Date.now(),
      type: 'info',
      template: message,
      message,
    });

    // A total said *that* lines were lost and left "why" to whoever kept the `onError`
    // calls. Three different losses here - one unrenderable, two evicted at the cap
    // while the file is not yet open, one refused after close - and each lands in its
    // own bucket.
    const sink = new FileSink({
      logDir: tmpDir.path,
      basename: 'dropped-by-kind',
      jsonFormat: true,
      maxQueueSize: 1,
    });

    // Two lines into a one-slot queue before the file is open, so nothing drains between
    // them: the older is evicted.
    sink.write(makeEntry('first'));
    sink.write(makeEntry('second'));

    await sink.flush();

    expect(sink.getHealth().droppedByKind.queue_full).toBe(1);
    // Destination health recovers independently of historical loss counters.
    expect(sink.getHealth().isHealthy).toBe(true);

    sink.write({
      timestamp: Date.now(),
      type: 'info',
      template: 'unrenderable',
      message: UNRENDERABLE_MESSAGE,
    });

    await sink.flush();

    expect(sink.getHealth().droppedByKind.format).toBe(1);

    const closing = sink.close();

    sink.write(makeEntry('after close'));

    await closing;

    const health = sink.getHealth();
    const byKind = health.droppedByKind;

    expect(byKind.format).toBe(1);
    expect(byKind.queue_full).toBe(1);
    expect(byKind.close).toBe(1);
    expect(byKind.write).toBe(0);
    expect(
      byKind.queue_full + byKind.write + byKind.format + byKind.close,
    ).toBe(health.droppedEntries);
  });
});

describe('FileSink - jsonFormat renders what JSON.stringify refuses', () => {
  const makeEntry = (message: string): LogEntry => ({
    timestamp: Date.now(),
    type: 'info',
    template: message,
    message,
  });

  beforeEach(async () => {
    tmpDir = new TmpDir({
      unsafeCleanup: true,
      prefix: 'file-sink-json-render',
    });
    await tmpDir.initialize();
  });

  afterEach(async () => {
    await tmpDir.cleanup();
  });

  test('writes one parseable line with markers, and reports the fallback once', async () => {
    // A plain `JSON.stringify` over the bag lost the whole line to a `BigInt` or a cycle
    // the logger's own renderer handles. Now the line is written with a marker where the
    // value was, still one JSON object, and the one value that would not render is said
    // once as `'format'`/`'fallback'`.
    const failures: SinkFailure[] = [];
    const cyclic: Record<string, unknown> = { a: 1 };

    cyclic.self = cyclic;

    const sink = new FileSink({
      logDir: tmpDir.path,
      basename: 'json-render',
      jsonFormat: true,
      onError: (failure) => {
        failures.push(failure);
      },
    });

    await sink.flush();

    sink.write({
      timestamp: Date.now(),
      type: 'info',
      template: 'markers',
      message: 'markers',
      redactedParams: {
        big: 1n,
        cyclic,
        gone: undefined,
        get boom(): never {
          throw new Error('getter exploded');
        },
      },
    });
    sink.write(makeEntry('plain'));

    await sink.flush();
    await sink.close();

    const files = await fsPromises.readdir(tmpDir.path);
    const logFile = files.find((name) => name.startsWith('json-render'));
    const lines = (
      await fsPromises.readFile(`${tmpDir.path}/${logFile ?? ''}`, 'utf8')
    )
      .trim()
      .split('\n');

    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0] ?? '') as {
      message: string;
      params: Record<string, unknown>;
    };

    expect(first.message).toBe('markers');
    expect(first.params['big']).toBe('1');
    expect((first.params['cyclic'] as Record<string, unknown>)['self']).toBe(
      '[circular]',
    );
    expect(first.params['gone']).toBe('[undefined]');
    expect(first.params['boom']).toBe('[unrenderable: value]');
    expect(JSON.parse(lines[1] ?? '')).toMatchObject({ message: 'plain' });

    // Only the getter was a failure; the rest are ordinary renders.
    expect(failures).toHaveLength(1);
    expect(failures[0]?.kind).toBe('format' satisfies SinkFailureKind);
    expect(failures[0]?.disposition).toBe('fallback');
    expect(failures[0]?.error.message).toContain('a marker was written');
    // Advisory: the line went out, so the sink is not less healthy for it.
    expect(sink.getHealth().droppedEntries).toBe(0);
  });

  test('a self-logging onError cannot recurse through the fallback report', async () => {
    // The handler logs the failure back, carrying the same throwing getter. Its line
    // renders - marker and all - and is queued; only the nested report is skipped.
    let calls = 0;
    let maxDepth = 0;
    let depth = 0;

    const self: { sink?: FileSink } = {};

    const hostile = {
      get boom(): never {
        throw new Error('getter exploded');
      },
    };

    const sink = new FileSink({
      logDir: tmpDir.path,
      basename: 'json-fallback-self-log',
      jsonFormat: true,
      onError: () => {
        calls++;
        depth++;
        maxDepth = Math.max(maxDepth, depth);

        self.sink?.write({
          timestamp: Date.now(),
          type: 'error',
          template: 'the log sink failed',
          message: 'the log sink failed',
          redactedParams: { hostile },
        });

        depth--;
      },
    });

    self.sink = sink;

    await sink.flush();

    sink.write({
      timestamp: Date.now(),
      type: 'info',
      template: 'first',
      message: 'first',
      redactedParams: { hostile },
    });

    await sink.flush();
    await sink.close();

    expect(calls).toBe(1);
    expect(maxDepth).toBe(1);

    const files = await fsPromises.readdir(tmpDir.path);
    const logFile = files.find((name) =>
      name.startsWith('json-fallback-self-log'),
    );
    const contents = await fsPromises.readFile(
      `${tmpDir.path}/${logFile ?? ''}`,
      'utf8',
    );

    // Both lines written, the handler's included.
    expect(contents).toContain('"message":"first"');
    expect(contents).toContain('"message":"the log sink failed"');
    expect(sink.getHealth().droppedEntries).toBe(0);
  });
});

describe('FileSink - accounting across a rotation', () => {
  beforeEach(async () => {
    tmpDir = new TmpDir({ prefix: 'filesink-accounting-' });
    await tmpDir.initialize();
  });

  afterEach(async () => {
    await tmpDir.cleanup().catch(() => {
      // Best effort - the sinks below may still hold a handle.
    });
  });

  const entryFor = (message: string): LogEntry => ({
    timestamp: Date.now(),
    type: 'info',
    serviceName: 'Accounting',
    template: message,
    message,
  });

  test('a write acknowledged after its stream was rotated away is not charged to the new file', async () => {
    // The error branch of the write callback already checks that the stream it belongs
    // to is still current; the success branch did not. A callback from a rotated-away
    // stream added its bytes to the fresh file's counter - bytes that sit in the
    // archive - so the new file rotated early.
    const sink = new FileSink({
      logDir: tmpDir.path,
      basename: 'late-success',
      closeTimeoutMS: 200,
    });

    await sink.flush();

    const privateSink = sink as unknown as {
      logFileStream?: {
        write: (chunk: unknown, cb: (err?: Error | null) => void) => boolean;
      };
      currentLogSize: number;
      rotateFile: () => Promise<void>;
    };

    const stale = privateSink.logFileStream;

    if (!stale) {
      throw new Error('the sink opened no stream');
    }

    // Hold the acknowledgement so a rotation can slip in before it.
    const realWrite = stale.write.bind(stale);
    let release: (() => void) | undefined;

    stale.write = (chunk, cb) =>
      realWrite(chunk, (err) => {
        release = () => cb(err);
      });

    sink.write(entryFor('held until after the rotation'));

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(release).toBeDefined();

    await privateSink.rotateFile();

    const sizeAfterRotation = privateSink.currentLogSize;

    release?.();

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(privateSink.currentLogSize).toBe(sizeAfterRotation);

    await sink.close();
  });

  test('a queued flush expires without stealing the active flush counting window', async () => {
    const sink = new FileSink({
      logDir: tmpDir.path,
      basename: 'queued-timeout',
    });
    await sink.flush();
    const internals = sink as unknown as {
      isProcessing: boolean;
      totalEntriesWritten: number;
    };
    internals.isProcessing = true;
    const first = sink.flush(1000);
    try {
      const result = await Promise.race([
        sink.flush(20),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error('queued flush exceeded its budget')),
            250,
          ),
        ),
      ]);
      expect(result).toEqual({
        success: false,
        entriesWritten: 0,
        entriesFailed: 0,
        timedOut: true,
      });
      internals.totalEntriesWritten++;
    } finally {
      internals.isProcessing = false;
    }
    expect((await first).entriesWritten).toBe(1);
    expect((await sink.flush()).entriesWritten).toBe(0);
    await sink.close();
  });

  test('overlapping flushes partition the written lines rather than both reporting them', async () => {
    // Each flush counts from a baseline the previous one advanced as it settled. Two in
    // flight together both read the same baseline, so both reported the same lines and a
    // caller summing the results counted every line twice.
    const sink = new FileSink({ logDir: tmpDir.path, basename: 'overlap' });

    sink.write(entryFor('one'));
    sink.write(entryFor('two'));

    const [first, second] = await Promise.all([sink.flush(), sink.flush()]);

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(first.entriesWritten + second.entriesWritten).toBe(2);

    // A later flush with nothing new reports nothing new.
    expect((await sink.flush()).entriesWritten).toBe(0);

    await sink.close();
  });
});

describe('FileSink - basename stays inside logDir', () => {
  test('refuses a basename carrying a path separator at construction', () => {
    for (const basename of [
      '../outside',
      'sub/app',
      'sub\\app',
      '.',
      '..',
      '',
      'app\0',
      'app\n',
    ]) {
      // Thrown before `initialize` runs, so no directory is ever created.
      expect(
        () => new FileSink({ logDir: './never-created', basename }),
      ).toThrow(/basename must be a file name inside logDir/);
    }
  });
});

describe('FileSink - entries refused at the door', () => {
  let tmpDir: TmpDir;

  beforeEach(async () => {
    tmpDir = new TmpDir({
      unsafeCleanup: true,
      prefix: 'file-sink-refused-test',
    });
    await tmpDir.initialize();
  });

  afterEach(async () => {
    await tmpDir.cleanup();
  });

  test('an async stream failure is reported, not only torn down', async () => {
    // `NamedPipeSink` reports every error its stream delivers; this handler recorded
    // nothing, so a failure with no write in flight to pair it with left `getHealth()`
    // answering `isHealthy: true` with a stale `lastError` and `onError` never fired.
    const failures: SinkFailure[] = [];
    const sink = new FileSink({
      logDir: tmpDir.path,
      basename: 'stream-error',
      onError: (failure) => {
        failures.push(failure);
      },
    });

    await sink.flush();

    const stream = (
      sink as unknown as {
        logFileStream?: {
          pending: boolean;
          emit: (event: string, error: Error) => void;
          once: (event: string, listener: () => void) => void;
        };
      }
    ).logFileStream;

    expect(stream).toBeDefined();

    // Waited for, because the classification turns on it: a stream still opening reports
    // `'setup'` - the destination could not be opened - and only one that has a descriptor
    // reports `'write'`, the kind that means an entry is at risk.
    if (stream?.pending === true) {
      await new Promise<void>((resolve) => {
        stream.once('open', resolve);
      });
    }

    stream?.emit('error', new Error('ENOSPC: no space left on device'));

    expect(failures).toHaveLength(1);
    expect(failures[0]?.kind).toBe('write');
    expect(failures[0]?.disposition).toBe('no_entry');
    expect(sink.getHealth().isHealthy).toBe(false);
    expect(sink.getHealth().lastError?.message).toContain(
      'Log file stream failed',
    );

    await sink.close();
  });

  test('one failed write is reported once, not by both channels', async () => {
    // A stream delivers a failed write through the callback *and* the `'error'` event. The
    // callback knows which line it was and whether it is coming back; the event knows only
    // that the stream is gone. The same identity pairing `NamedPipeSink` keeps.
    const failures: SinkFailure[] = [];
    const sink = new FileSink({
      logDir: tmpDir.path,
      basename: 'paired',
      maxRetries: 0,
      onError: (failure) => {
        failures.push(failure);
      },
    });

    await sink.flush();

    const stream = (
      sink as unknown as {
        logFileStream?: {
          write: (chunk: string, cb: (err?: Error) => void) => boolean;
          emit: (event: string, error: Error) => void;
        };
      }
    ).logFileStream;

    expect(stream).toBeDefined();

    if (stream) {
      stream.write = (_chunk, cb) => {
        const err = new Error('EIO: simulated');

        queueMicrotask(() => {
          cb(err);
          stream.emit('error', err);
        });

        return true;
      };
    }

    sink.write({
      timestamp: Date.now(),
      type: 'info',
      template: 'paired',
      message: 'paired',
    });

    await new Promise((resolve) => setTimeout(resolve, 200));

    const writeFailures = failures.filter((entry) => entry.kind === 'write');

    expect(writeFailures).toHaveLength(1);
    // The half that knows the line, not the one that knows only the connection.
    expect(writeFailures[0]?.disposition).toBe('lost');
    expect(sink.getHealth().droppedEntries).toBe(1);

    await sink.close();
  });

  test('an open that never completes is reported as setup, not write', async () => {
    // `createWriteStream` returns a stream for a path it cannot open and fails afterwards,
    // so this arrives as an event rather than a throw. `NamedPipeSink` settled the
    // classification: `'write'` is the one kind that means an entry is at risk, and a
    // destination that could never be opened is about no entry at all.
    const failures: SinkFailure[] = [];
    const logPath = `${tmpDir.path}/blocked-${new Date().toISOString().slice(0, 10)}.log`;

    // A directory where the log file goes: `access` succeeds, the open fails with EISDIR.
    await fsPromises.mkdir(logPath, { recursive: true });

    const sink = new FileSink({
      logDir: tmpDir.path,
      basename: 'blocked',
      onError: (failure) => {
        failures.push(failure);
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(failures).toHaveLength(1);
    expect(failures[0]?.kind).toBe('setup');
    expect(failures[0]?.disposition).toBe('no_entry');

    // A sink with no descriptor is not healthy, whatever `setupLogFile` marked on its way
    // out.
    expect(sink.getHealth().isHealthy).toBe(false);
    expect(sink.getHealth().isInitialized).toBe(false);

    await sink.close();
  });

  test('an entry written after close() is counted and reported once', async () => {
    // The other half of `abandonQueueOnClose`. That counts what was already queued; these
    // are the lines refused at the door during and after a close, which used to leave
    // through `write()`'s early return with `droppedEntries` unmoved and `onError` silent.
    const failures: SinkFailure[] = [];
    const sink = new FileSink({
      logDir: tmpDir.path,
      basename: 'refused',
      closeTimeoutMS: 150,
      onError: (failure) => {
        failures.push(failure);
      },
    });

    await sink.flush();
    await sink.close();

    for (let index = 0; index < 3; index++) {
      sink.write({
        timestamp: Date.now(),
        type: 'info',
        template: `late-${String(index)}`,
        message: `late-${String(index)}`,
      });
    }

    expect(sink.getHealth().droppedEntries).toBe(3);

    const closeFailures = failures.filter((entry) => entry.kind === 'close');

    // Once, not once per line: an application still logging through a thirty-second close
    // would otherwise get a callback per entry.
    expect(closeFailures).toHaveLength(1);
    expect(closeFailures[0]?.disposition).toBe('lost');
  });

  test('a close whose flush times out with bytes still buffered says so before it resolves', async () => {
    // This sink writes one line at a time and waits for the callback, so the stream's
    // buffer holds nothing the in-flight report does not already name. The backstop for
    // the case that model rules out: a stream that still holds bytes when `end()` times
    // out is reported once, as `'close'` / `'no_entry'`, before `await close()` answers -
    // the same report at the same moment as `NamedPipeSink`.
    const failures: SinkFailure[] = [];
    const sink = new FileSink({
      logDir: tmpDir.path,
      basename: 'buffered-close',
      closeTimeoutMS: 200,
      onError: (failure) => {
        failures.push(failure);
      },
    });

    await sink.flush();

    // Stand in for a stream on a hung mount: bytes accepted, `end()` never calls back.
    let destroyed = 0;
    const stuck = {
      destroyed: false,
      writableLength: 4096,
      end: () => {},
      once: () => {},
      on: () => {},
      removeListener: () => {},
      destroy() {
        destroyed++;
        this.destroyed = true;
      },
    };

    (sink as unknown as { logFileStream: unknown }).logFileStream = stuck;

    await sink.close();

    const closeFailures = failures.filter((f) => f.kind === 'close');

    expect(destroyed).toBe(1);
    expect(closeFailures).toHaveLength(1);
    expect(closeFailures[0]?.disposition).toBe('no_entry');
    expect(closeFailures[0]?.error.message).toContain(
      '4096 bytes still buffered',
    );
    expect(sink.getHealth().droppedEntries).toBe(0);
  });

  test('a rotation that finds no free archive name says so before it overwrites', async () => {
    // After `MAX_ROTATION_NAME_ATTEMPTS` collisions the last candidate is used anyway,
    // and `rename` onto it overwrites an archive - which used to happen with no `onError`
    // and no counter moved. Still allowed, since a rotation that never finishes parks the
    // queue for good; now reported, with the archive about to be replaced as the target.
    const failures: SinkFailure[] = [];
    const sink = new FileSink({
      logDir: tmpDir.path,
      basename: 'exhausted',
      onError: (failure) => {
        failures.push(failure);
      },
    });

    const fixedNow = 1_700_000_000_000;
    const nowSpy = spyOn(Date, 'now').mockReturnValue(fixedNow);

    try {
      const base = `${tmpDir.path}/exhausted-2023-11-14-${String(fixedNow)}`;

      // Every name the search will try: the bare one and the first 100 suffixes. The last
      // one counts - the report only goes out for a rotation that really is about to
      // replace an archive, so a free `-100` name is taken quietly (the case below).
      await fsPromises.writeFile(`${base}.log`, '');

      for (let attempt = 1; attempt <= 100; attempt++) {
        await fsPromises.writeFile(`${base}-${String(attempt)}.log`, '');
      }

      const reserved = await (
        sink as unknown as {
          reserveRotatedFileName: (date: string) => Promise<string>;
        }
      ).reserveRotatedFileName('2023-11-14');

      expect(reserved).toBe(`${base}-100.log`);
      expect(failures).toHaveLength(1);
      expect(failures[0]?.kind).toBe('setup');
      expect(failures[0]?.disposition).toBe('no_entry');
      expect(failures[0]?.target).toBe(reserved);
      expect(failures[0]?.error.message).toContain('No free archive name');
      expect(sink.getHealth().droppedEntries).toBe(0);
    } finally {
      nowSpy.mockRestore();
      await sink.close();
    }
  });

  test('a rotation that exhausts the search onto a free name says nothing', async () => {
    // The last candidate the search forms used to be handed back without ever being
    // probed, and reported as an archive about to be overwritten - so a rotation onto a
    // name nothing occupied raised a `'setup'` failure and made a healthy sink look
    // faulty. Nothing is at stake here, so nothing is said.
    const failures: SinkFailure[] = [];
    const sink = new FileSink({
      logDir: tmpDir.path,
      basename: 'exhausted-free',
      onError: (failure) => {
        failures.push(failure);
      },
    });

    const fixedNow = 1_700_000_000_000;
    const nowSpy = spyOn(Date, 'now').mockReturnValue(fixedNow);

    try {
      const base = `${tmpDir.path}/exhausted-free-2023-11-14-${String(fixedNow)}`;

      // Everything the search tries except the name it ends on.
      await fsPromises.writeFile(`${base}.log`, '');

      for (let attempt = 1; attempt < 100; attempt++) {
        await fsPromises.writeFile(`${base}-${String(attempt)}.log`, '');
      }

      const reserved = await (
        sink as unknown as {
          reserveRotatedFileName: (date: string) => Promise<string>;
        }
      ).reserveRotatedFileName('2023-11-14');

      expect(reserved).toBe(`${base}-100.log`);
      expect(failures).toHaveLength(0);
    } finally {
      nowSpy.mockRestore();
      await sink.close();
    }
  });

  test('two rotations in one second keep both archives', async () => {
    // The rotated name used a *second*-resolution suffix, and `rename` overwrites without
    // a word: any burst that filled `maxSizeMB` twice inside one second destroyed the
    // first archive while `flush()` reported `entriesFailed: 0`, `droppedEntries: 0` and
    // `onError` never fired. Lines this sink had already called written, gone silently -
    // the one outcome the whole failure contract exists to prevent.
    const sink = new FileSink({
      logDir: tmpDir.path,
      basename: 'collision-test',
      maxSizeMB: 0.0002, // 200 bytes - a few lines per file
      jsonFormat: false,
    });

    const line = 'Y'.repeat(120);

    for (let index = 0; index < 30; index++) {
      sink.write({
        timestamp: Date.now(),
        type: 'info',
        serviceName: 'CollisionTest',
        template: `${String(index)}: ${line}`,
        message: `${String(index)}: ${line}`,
      });
    }

    await sink.flush();
    await sink.close();

    const files = await fsPromises.readdir(tmpDir.path);

    let written = 0;

    for (const file of files) {
      const content = await fsPromises.readFile(
        `${tmpDir.path}/${file}`,
        'utf8',
      );

      written += content.split('\n').filter((entry) => entry !== '').length;
    }

    expect(written).toBe(30);
  });
});

describe('FileSink - entries written during close', () => {
  const makeEntry = (message: string): LogEntry => ({
    timestamp: Date.now(),
    type: 'info',
    message,
    template: message,
  });

  let tmpDir: TmpDir;

  beforeEach(async () => {
    tmpDir = new TmpDir({
      unsafeCleanup: true,
      prefix: 'file-sink-close-drain-test',
    });
    await tmpDir.initialize();
  });

  afterEach(async () => {
    // Restored first, exactly as the first suite restores it: the rollover test below moves
    // `toISOString` a day forward, and without this every later caller in this isolate -
    // the cleanup on the next line included - reads tomorrow's date. A test that mutates a
    // global and leaves it that way passes by agreeing with itself.
    (Date.prototype as unknown as { toISOString: () => string }).toISOString =
      originalToISOString;

    await tmpDir.cleanup();
  });

  test('an open that fails while `stat` is awaited stays uninitialized', async () => {
    // `createWriteStream` reports a path it cannot open as an event, and the window it
    // arrives in is the `stat` that follows: the `'error'` handler destroys the stream and
    // clears `isInitialized`, and `initialize()` used to set the flag again the moment
    // `setupLogFile` returned. `getHealth()` then answered `{ isInitialized: true,
    // isHealthy: true }` for a sink holding no descriptor - the opposite of what the
    // handler had just reported. `stat` is slowed here so the error lands inside that
    // window every run rather than on the scheduler's whim.
    const currentDate = new Date().toISOString().slice(0, 10);
    const logPath = `${tmpDir.path}/eisdir-${currentDate}.log`;

    // A directory where the log file goes: `access` succeeds, the open fails with EISDIR.
    await fsPromises.mkdir(logPath, { recursive: true });

    const statSpy = spyOn(fsPromises, 'stat').mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));

      throw new Error('stat held open long enough for the open to fail');
    });

    try {
      const failures: SinkFailure[] = [];
      const sink = new FileSink({
        logDir: tmpDir.path,
        basename: 'eisdir',
        onError: (failure) => {
          failures.push(failure);
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 500));

      expect(failures.map((failure) => failure.kind)).toEqual(['setup']);
      expect(sink.getHealth().isInitialized).toBe(false);
      expect(sink.getHealth().isHealthy).toBe(false);

      await sink.close();
    } finally {
      statSpy.mockRestore();
    }
  });

  test.each([false, true])(
    'reports a failed line lost when retry room is consumed (callback=%p)',
    async (shouldFillFromCallback) => {
      const failures: SinkFailure[] = [];
      const sink = new FileSink({
        logDir: tmpDir.path,
        basename: 'full-retry',
        maxQueueSize: 1,
        onError: (failure) => {
          failures.push(failure);
          if (shouldFillFromCallback && failure.disposition === 'retrying') {
            sink.write(makeEntry('callback survivor'));
          }
        },
      });
      await sink.flush();
      const internals = sink as unknown as {
        writeEntry: (entry: unknown) => Promise<void>;
      };
      const started = Promise.withResolvers<void>();
      const pending = Promise.withResolvers<void>();
      let attempts = 0;
      internals.writeEntry = () => {
        attempts++;
        if (attempts === 1) {
          started.resolve();
          return pending.promise;
        }
        return Promise.resolve();
      };
      try {
        sink.write(makeEntry('failed line'));
        await started.promise;
        if (!shouldFillFromCallback) {
          sink.write(makeEntry('evicted while busy'));
          sink.write(makeEntry('survivor'));
          // The aggregate overflow report has already fired before the failed retry.
          expect(failures.filter((f) => f.kind === 'queue_full')).toHaveLength(
            1,
          );
        }
        pending.reject(new Error('write failed'));
        await sink.flush();
        const finalLoss = failures.filter(
          (f) => f.disposition === 'lost' && f.entry?.message === 'failed line',
        );
        expect(finalLoss).toHaveLength(1);
        expect(finalLoss[0]?.kind).toBe('write');
        expect(sink.getHealth().droppedByKind.write).toBe(1);
        expect(sink.getHealth().droppedByKind.queue_full).toBe(
          shouldFillFromCallback ? 0 : 1,
        );
        expect(attempts).toBe(2);
        expect(sink.getHealth().queueSize).toBe(0);
      } finally {
        pending.resolve();
        await sink.close();
      }
    },
  );

  test('a write still in flight when close() gives up is lost, not re-queued', async () => {
    // `close()` gives up on its drain at `closeTimeoutMS` and returns with the pass it was
    // waiting on still suspended in a write callback. That pass then failed and re-queued
    // the entry - into a queue `abandonQueueOnClose()` had already emptied and nothing was
    // ever going to drain again: `getHealth().queueSize` sat above zero after `await
    // close()` resolved, the line was reported `'retrying'` for `maxRetries` rounds against
    // a sink that could only answer `Cannot write to closed sink`, and only then counted.
    // `NamedPipeSink.requeue` takes the same view this now does: past the close, the entry
    // is lost.
    const failures: SinkFailure[] = [];
    const sink = new FileSink({
      logDir: tmpDir.path,
      basename: 'inflight',
      closeTimeoutMS: 150,
      onError: (failure) => {
        failures.push(failure);
      },
    });

    await sink.flush();

    let settleWrite: ((error?: Error) => void) | undefined;

    // Takes the line and then holds its callback, which is what a stalled destination does
    // to a write already handed to the stream.
    const stalled = {
      destroyed: false,
      end: (callback?: () => void) => callback?.(),
      destroy: () => undefined,
      write: (_chunk: string, callback: (error?: Error) => void) => {
        settleWrite = callback;

        return true;
      },
      on: () => undefined,
      once: () => undefined,
    };

    (sink as unknown as { logFileStream: unknown }).logFileStream = stalled;

    for (let index = 0; index < 2; index++) {
      sink.write({
        timestamp: Date.now(),
        type: 'info',
        serviceName: 'TestService',
        template: `stalled-${String(index)}`,
        message: `stalled-${String(index)}`,
      });
    }

    // Long enough for the first entry to be handed to the stream and park there.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(settleWrite).toBeDefined();

    await sink.close();

    const droppedAtClose = sink.getHealth().droppedEntries;

    // The destination answers after the close has already resolved.
    settleWrite?.(new Error('stalled write failed after the close'));

    await new Promise((resolve) => setTimeout(resolve, 200));

    // Nothing waiting on a sink nothing will drain, and the line counted rather than
    // retried into a queue that no longer exists.
    expect(sink.getHealth().queueSize).toBe(0);
    expect(sink.getHealth().droppedEntries).toBe(droppedAtClose + 1);
    expect(failures.some((failure) => failure.disposition === 'retrying')).toBe(
      false,
    );
  });

  test('close() reports the write it gave up on, and does not call it a clean shutdown', async () => {
    // The other half of the same timeout. The entry that was mid-`stream.write` when the
    // drain's deadline passed is in no queue and no counter - `abandonQueueOnClose()` only
    // sees what is still queued - so `await close()` resolved and `getHealth()` answered
    // exactly as it does for a shutdown that wrote everything. Worse when the callback
    // *succeeds* late: it credits `totalEntriesWritten` and adds its length to a file
    // nothing is writing to any more, after the close said it was done.
    const failures: SinkFailure[] = [];
    const sink = new FileSink({
      logDir: tmpDir.path,
      basename: 'inflight-report',
      closeTimeoutMS: 150,
      onError: (failure) => {
        failures.push(failure);
      },
    });

    await sink.flush();

    let settleWrite: ((error?: Error) => void) | undefined;

    const stalled = {
      destroyed: false,
      end: (callback?: () => void) => callback?.(),
      destroy: () => undefined,
      write: (_chunk: string, callback: (error?: Error) => void) => {
        settleWrite = callback;

        return true;
      },
      on: () => undefined,
      once: () => undefined,
    };

    (sink as unknown as { logFileStream: unknown }).logFileStream = stalled;

    sink.write({
      timestamp: Date.now(),
      type: 'info',
      serviceName: 'TestService',
      template: 'held',
      message: 'held',
    });

    // Long enough for the entry to be handed to the stream and park there.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(settleWrite).toBeDefined();

    await sink.close();

    const closeFailures = failures.filter(
      (failure) => failure.kind === 'close',
    );

    // Said, rather than left to be inferred from a counter that never moved.
    expect(closeFailures).toHaveLength(1);
    expect(closeFailures[0]?.error.message).toMatch(
      /write still in flight.*unknown/i,
    );

    // `'no_entry'`, not `'lost'`: whether those bytes reached the file is genuinely
    // unknown from here, and `droppedEntries` means "lines this sink did not deliver" -
    // this one may well have been delivered a moment later.
    expect(closeFailures[0]?.disposition).toBe('no_entry');
    expect(closeFailures[0]?.entry).toBeUndefined();
    expect(sink.getHealth().droppedEntries).toBe(0);

    // Distinct from the refusal `write()` reports after `close()` began, and from the
    // abandoned-queue report: neither fires here, so this line is the only way a caller
    // learns the close did not finish what it started.
    expect(closeFailures[0]?.error.message).not.toMatch(/still queued/i);

    // The late success the report exists to explain: it lands after `close()` resolved.
    settleWrite?.();

    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  test('close() reports nothing extra when the drain finishes in time', async () => {
    const failures: SinkFailure[] = [];
    const sink = new FileSink({
      logDir: tmpDir.path,
      basename: 'inflight-clean',
      closeTimeoutMS: 2000,
      onError: (failure) => {
        failures.push(failure);
      },
    });

    sink.write({
      timestamp: Date.now(),
      type: 'info',
      serviceName: 'TestService',
      template: 'ordinary',
      message: 'ordinary',
    });

    await sink.close();

    expect(failures).toEqual([]);
    expect(sink.getHealth().droppedEntries).toBe(0);
  });

  test('a write interrupted during setup is classified as a close failure', async () => {
    const sink = new FileSink({
      logDir: tmpDir.path,
      basename: 'setup-close-race',
    });
    await sink.flush();
    const internals = sink as unknown as {
      closed: boolean;
      logFileStream: unknown;
      setupLogFile: () => Promise<void>;
      writeEntry: (queued: {
        entry: LogEntry;
        attempts: number;
        formatted: string;
        formatError: undefined;
      }) => Promise<void>;
    };
    const stream = internals.logFileStream;
    const setup = internals.setupLogFile;
    internals.logFileStream = undefined;
    internals.setupLogFile = () => {
      internals.closed = true;
      return Promise.resolve();
    };
    try {
      const failure = await internals
        .writeEntry({
          entry: {
            timestamp: Date.now(),
            type: 'info',
            template: 'line',
            message: 'line',
          },
          attempts: 0,
          formatted: 'line\n',
          formatError: undefined,
        })
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe('Cannot write to closed sink');
      expect(
        (
          sink as unknown as {
            failureKindFor: (error: Error) => SinkFailureKind;
          }
        ).failureKindFor(failure as Error),
      ).toBe('close');
    } finally {
      internals.closed = false;
      internals.logFileStream = stream;
      internals.setupLogFile = setup;
      await sink.close();
    }
  });

  test('an oversized-line rotation cannot resume writing after close completes', async () => {
    const sink = new FileSink({
      logDir: tmpDir.path,
      basename: 'rotate-close-race',
    });

    await sink.flush();

    const internals = sink as unknown as {
      closed: boolean;
      currentLogSize: number;
      maxSizeMB: number;
      rotateFile: () => Promise<void>;
      writeEntry: (queued: {
        entry: LogEntry;
        attempts: number;
        formatted: string;
        formatError: undefined;
      }) => Promise<void>;
    };

    internals.currentLogSize = 1;
    internals.maxSizeMB = 0;
    internals.rotateFile = () => {
      // The state visible when a real close wins while rotateFile() is suspended.
      internals.closed = true;

      return Promise.resolve();
    };

    const entry: LogEntry = {
      timestamp: Date.now(),
      type: 'info',
      template: 'late line',
      message: 'late line',
    };

    let writeError: unknown;

    try {
      await internals.writeEntry({
        entry,
        attempts: 0,
        formatted: 'late line\n',
        formatError: undefined,
      });
    } catch (error) {
      writeError = error;
    }

    expect(writeError).toBeInstanceOf(Error);
    expect((writeError as Error).message).toContain(
      'Cannot write to closed sink',
    );

    // Let the ordinary close path release the real stream used by this focused probe.
    internals.closed = false;
    await sink.close();
  });

  test('a UTC date change during close() does not rotate behind the shutdown', async () => {
    // The date branch of `rotateIfNeeded` was the one rotation with no close guard, and it
    // awaits `endStreamWithin(closeTimeoutMS)` - a fresh full-length wait begun inside a
    // close already keeping its own budget - before opening the next day's file through
    // `setupLogFile`. Crossing UTC midnight during a shutdown therefore doubled the
    // documented bound and left the close draining through a stream it had just replaced,
    // or past `closed`, holding a descriptor nothing would ever close.
    const logDir = `${tmpDir.path}/rollover`;
    const sink = new FileSink({
      logDir,
      basename: 'rollover',
      closeTimeoutMS: 300,
    });

    // Open on the real date first, so the rotation has a date to rotate away from.
    await new Promise((resolve) => setTimeout(resolve, 200));

    const firstDay = await fsPromises.readdir(logDir);

    expect(firstDay).toHaveLength(1);

    // Tomorrow, for every caller from here on: the next `rotateIfNeeded` sees a date change.
    (Date.prototype as unknown as { toISOString: () => string }).toISOString =
      function toISOString(this: Date): string {
        return originalToISOString.call(
          new Date(this.getTime() + 24 * 60 * 60 * 1000),
        );
      };

    const internals = sink as unknown as {
      closing: boolean;
      rotateIfNeeded: () => Promise<void>;
      logFileStream: unknown;
    };

    // The state a drain-phase write runs in: `close()` raises `closing` before the loop
    // whose writes reach `rotateIfNeeded`. Driven directly because the window is otherwise
    // a race - an ordinary `write()` is processed before the close begins, and one logged
    // after it is refused at the door.
    const streamBeforeClose = internals.logFileStream;

    internals.closing = true;

    await internals.rotateIfNeeded();

    expect(await fsPromises.readdir(logDir)).toEqual(firstDay);

    // Still draining through the stream it started with, not through a replacement.
    expect(internals.logFileStream).toBe(streamBeforeClose);

    // And the guard is the only thing holding it back: the same call outside a close does
    // rotate, so this test cannot pass by the date change going unnoticed.
    internals.closing = false;

    await internals.rotateIfNeeded();

    expect(await fsPromises.readdir(logDir)).toHaveLength(2);

    await sink.close();
  });

  test('writes an entry queued before the first open completes', async () => {
    // `close()` raises `closing` before the drain loop it exists to run, and that loop's
    // writes reach `setupLogFile` whenever the first entry arrives before the constructor's
    // `initialize()` has opened anything. A guard that refused during `closing` as well as
    // `closed` made this sequence create no log file at all and report the entry lost.
    const logDir = `${tmpDir.path}/close-drain`;
    const failures: SinkFailure[] = [];

    const sink = new FileSink({
      logDir,
      basename: 'drain',
      maxSizeMB: 1,
      jsonFormat: false,
      onError: (failure) => {
        failures.push(failure);
      },
    });

    const testMessage = 'logged before the first open';

    sink.write({
      timestamp: Date.now(),
      type: 'info',
      serviceName: 'TestService',
      template: testMessage,
      message: testMessage,
    });

    await sink.close();

    const currentDate = new Date().toISOString().slice(0, 10);
    const content = await fsPromises.readFile(
      `${logDir}/drain-${currentDate}.log`,
      'utf8',
    );

    expect(content).toContain(testMessage);
    expect(sink.getHealth().droppedEntries).toBe(0);
    expect(failures).toEqual([]);
  });
  // A rotation threshold of zero makes a *freshly opened, empty* file already over the
  // limit, so `setupLogFile` rotates it, reopens, and finds the new empty file over the
  // limit too. Nothing in that loop yields to anything that could stop it: `initPromise`
  // never settles, so `flush()` hangs, `close()` can only time out, and every pass reserves
  // another archive name and fills the directory.
  test('refuses a maxSizeMB that would rotate an empty file forever', async () => {
    const logDir = `${tmpDir.path}/zero-max-size`;

    const sink = new FileSink({
      logDir,
      basename: 'zero',
      maxSizeMB: 0,
      jsonFormat: false,
    });

    const message = 'written under a zero rotation threshold';

    sink.write({
      timestamp: Date.now(),
      type: 'info',
      serviceName: 'TestService',
      template: message,
      message,
    });

    await sink.close();

    const written = await fsPromises.readdir(logDir);

    // The default took over, so this is one live log and no archives at all.
    expect(written.length).toBe(1);

    const content = await fsPromises.readFile(
      `${logDir}/${written[0]}`,
      'utf8',
    );

    expect(content).toContain(message);
  });

  test('refuses a negative or unreadable maxSizeMB the same way', async () => {
    const logDir = `${tmpDir.path}/negative-max-size`;

    const sink = new FileSink({
      logDir,
      basename: 'negative',
      maxSizeMB: -5,
      jsonFormat: false,
    });

    sink.write({
      timestamp: Date.now(),
      type: 'info',
      serviceName: 'TestService',
      template: 'negative threshold',
      message: 'negative threshold',
    });

    await sink.close();

    expect((await fsPromises.readdir(logDir)).length).toBe(1);

    const nanDir = `${tmpDir.path}/nan-max-size`;
    const nanSink = new FileSink({
      logDir: nanDir,
      basename: 'nan',
      maxSizeMB: Number.NaN,
      jsonFormat: false,
    });

    nanSink.write({
      timestamp: Date.now(),
      type: 'info',
      serviceName: 'TestService',
      template: 'NaN threshold',
      message: 'NaN threshold',
    });

    await nanSink.close();

    expect((await fsPromises.readdir(nanDir)).length).toBe(1);
  });
});

test('close drains an accepted entry when rotation already ended its stream', async () => {
  const directory = new TmpDir({ unsafeCleanup: true });
  await directory.initialize();
  const failures: SinkFailure[] = [];
  const sink = new FileSink({
    logDir: directory.path,
    basename: 'race',
    maxSizeMB: 0.001,
    maxRetries: 0,
    onError: (failure) => {
      failures.push(failure);
    },
  });
  const entry = (message: string): LogEntry => ({
    timestamp: Date.now(),
    type: 'info',
    template: message,
    message,
  });
  const reached = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const internals = sink as unknown as {
    reserveRotatedFileName: (date: string) => Promise<string>;
  };
  let rotationSpy: { mockRestore(): void } | undefined;
  try {
    sink.write(entry('first'));
    await sink.flush();
    rotationSpy = spyOn(internals, 'reserveRotatedFileName').mockImplementation(
      async () => {
        reached.resolve();
        await resume.promise;
        return `${directory.path}/archive.log`;
      },
    );
    sink.write(entry('second-' + 'x'.repeat(2000)));
    await reached.promise;
    const closing = sink.close();
    resume.resolve();
    await closing;
    const files = await fsPromises.readdir(directory.path);
    const contents = (
      await Promise.all(
        files.map((file) =>
          fsPromises.readFile(`${directory.path}/${file}`, 'utf8'),
        ),
      )
    ).join('');
    expect(contents).toContain('second-');
    expect(failures).toEqual([]);
    expect(sink.getHealth().droppedEntries).toBe(0);
  } finally {
    resume.resolve();
    rotationSpy?.mockRestore();
    await sink.close();
    await directory.cleanup();
  }
});
