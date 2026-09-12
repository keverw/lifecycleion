import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
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
    // nested object wherever nothing under it was masked, so a `BigInt` placed there
    // fails the render at `write` time and the caller can then remove it - which is
    // exactly what would let a second render succeed and serialize the token added
    // beside it, under a `redactedKeys` path that masked nothing because the key did
    // not exist yet.
    const shared: Record<string, unknown> = { name: 'kev', big: 1n };

    const entry: LogEntry = {
      timestamp: Date.now(),
      type: 'info',
      template: 'hi',
      message: 'hi',
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

    // A `BigInt` is not serializable, so the render throws and no line can be produced.
    sink.write({
      timestamp: Date.now(),
      type: 'info',
      serviceName: 'TestService',
      template: 'unrenderable',
      message: 'unrenderable',
      redactedParams: { big: 1n },
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
