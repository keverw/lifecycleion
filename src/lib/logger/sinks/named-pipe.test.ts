import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { promises as fsPromises } from 'fs';
import * as fs from 'fs';
import * as os from 'os';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { NamedPipeSink, PipeErrorType } from './named-pipe';
import type { LogEntry } from '../types';
import { TmpDir } from '../../tmp-dir';

const execAsync = promisify(exec);

let tmpDir: TmpDir;

// Helper to create a named pipe
async function createNamedPipe(pipePath: string): Promise<void> {
  await execAsync(`mkfifo "${pipePath}"`);
}

// Helper to read from pipe in background
function startPipeReader(pipePath: string): {
  data: string[];
  stop: () => void;
} {
  const data: string[] = [];
  let isStopped = false;

  // Open pipe for reading in non-blocking mode
  const stream = fs.createReadStream(pipePath, {
    encoding: 'utf8',
  });

  stream.on('data', (chunk: string | Buffer) => {
    if (!isStopped) {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      data.push(text);
    }
  });

  return {
    data,
    stop: () => {
      isStopped = true;
      stream.destroy();
    },
  };
}

// The write side of a FIFO does not open until a reader has opened the read side, and the
// reader's own open is asynchronous too - so tests that need an open pipe wait for it
// rather than guessing at a delay.
async function waitForOpenPipe(
  sink: NamedPipeSink,
  timeoutMS = 5000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMS;

  while (Date.now() < deadline) {
    if (sink.getHealth().isInitialized) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  return false;
}

describe('NamedPipeSink', () => {
  // Only run these tests on supported platforms
  const platform = os.platform();
  const isSupported = platform === 'linux' || platform === 'darwin';
  const hookTimeoutMS = 15000;

  if (!isSupported) {
    test('should not be supported on this platform', () => {
      expect(platform).not.toBe('linux');
      expect(platform).not.toBe('darwin');
    });
    return;
  }

  beforeEach(async () => {
    tmpDir = new TmpDir({
      unsafeCleanup: true,
      prefix: 'named-pipe-sink-test',
    });
    await tmpDir.initialize();
  }, hookTimeoutMS);

  afterEach(async () => {
    await tmpDir.cleanup();
  }, hookTimeoutMS);

  test('should write log entry to named pipe', async () => {
    const pipePath = `${tmpDir.path}/test.pipe`;
    await createNamedPipe(pipePath);

    // Start reading from pipe
    const reader = startPipeReader(pipePath);

    // Create sink
    const sink = new NamedPipeSink({
      pipePath,
      jsonFormat: false,
    });

    // Wait for initialization
    await new Promise((resolve) => setTimeout(resolve, 100));

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

    // Wait for write
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Check if data was written
    const allData = reader.data.join('');
    expect(allData).toContain(testMessage);
    expect(allData).toContain('TestService');

    // Clean up
    reader.stop();
    await sink.close();
  });

  test('should format logs as JSON when jsonFormat is true', async () => {
    const pipePath = `${tmpDir.path}/json-test.pipe`;
    await createNamedPipe(pipePath);

    const reader = startPipeReader(pipePath);

    const sink = new NamedPipeSink({
      pipePath,
      jsonFormat: true,
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

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

    await new Promise((resolve) => setTimeout(resolve, 100));

    const allData = reader.data.join('');
    const jsonLog = JSON.parse(allData.trim());

    expect(jsonLog).toHaveProperty('timestamp', timestamp);
    expect(jsonLog).toHaveProperty('type', 'info');
    expect(jsonLog).toHaveProperty('serviceName', 'JSONService');
    expect(jsonLog).toHaveProperty('message', testMessage);

    reader.stop();
    await sink.close();
  });

  test('should use custom formatter when provided', async () => {
    const pipePath = `${tmpDir.path}/custom-format.pipe`;
    await createNamedPipe(pipePath);

    const reader = startPipeReader(pipePath);

    const customFormatter = (entry: LogEntry) => {
      return `CUSTOM: ${entry.type.toUpperCase()} - ${entry.message}`;
    };

    const sink = new NamedPipeSink({
      pipePath,
      formatter: customFormatter,
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    const entry: LogEntry = {
      timestamp: Date.now(),
      type: 'info',
      serviceName: 'CustomTest',
      template: 'Custom formatted log',
      message: 'Custom formatted log',
    };

    sink.write(entry);

    await new Promise((resolve) => setTimeout(resolve, 100));

    const allData = reader.data.join('');
    expect(allData).toContain('CUSTOM: INFO - Custom formatted log');

    reader.stop();
    await sink.close();
  });

  test('should handle error when pipe does not exist', async () => {
    const pipePath = `${tmpDir.path}/nonexistent.pipe`;
    const errors: Array<{ type: PipeErrorType; error: Error }> = [];

    const sink = new NamedPipeSink({
      pipePath,
      onError: (errorType, error) => {
        errors.push({ type: errorType, error });
      },
    });

    // Wait for initialization attempt
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Should have an error
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].type).toBe(PipeErrorType.NOT_FOUND);

    await sink.close();
  });

  test('should handle error when path is not a pipe', async () => {
    // Create a regular file instead of a pipe
    const filePath = `${tmpDir.path}/regular-file.txt`;
    await fsPromises.writeFile(filePath, 'not a pipe');

    const errors: Array<{ type: PipeErrorType; error: Error }> = [];

    const sink = new NamedPipeSink({
      pipePath: filePath,
      onError: (errorType, error) => {
        errors.push({ type: errorType, error });
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].type).toBe(PipeErrorType.NOT_A_PIPE);

    await sink.close();
  });

  test('should queue writes before initialization', async () => {
    const pipePath = `${tmpDir.path}/queue-test.pipe`;
    await createNamedPipe(pipePath);

    const reader = startPipeReader(pipePath);

    const sink = new NamedPipeSink({
      pipePath,
      jsonFormat: false,
    });

    // Write immediately before initialization completes
    const entry1: LogEntry = {
      timestamp: Date.now(),
      type: 'info',
      serviceName: 'QueueTest',
      template: 'Queued entry 1',
      message: 'Queued entry 1',
    };

    const entry2: LogEntry = {
      timestamp: Date.now(),
      type: 'info',
      serviceName: 'QueueTest',
      template: 'Queued entry 2',
      message: 'Queued entry 2',
    };

    sink.write(entry1);
    sink.write(entry2);

    // Wait for initialization and queue processing
    await new Promise((resolve) => setTimeout(resolve, 200));

    const allData = reader.data.join('');
    expect(allData).toContain('Queued entry 1');
    expect(allData).toContain('Queued entry 2');

    reader.stop();
    await sink.close();
  });

  test('a queued write keeps the params it was given', async () => {
    // The queue is drained after initialization, and `entry.redactedParams` is not a
    // snapshot - it is the caller's own bag, or shares every subtree that held nothing
    // redacted - so rendering at flush time wrote whatever the caller had done to it
    // during the outage.
    const pipePath = `${tmpDir.path}/queue-snapshot.pipe`;
    await createNamedPipe(pipePath);

    const reader = startPipeReader(pipePath);

    const sink = new NamedPipeSink({ pipePath, jsonFormat: true });

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

    await new Promise((resolve) => setTimeout(resolve, 200));

    const allData = reader.data.join('');

    expect(allData).toContain('"foo":"bar"');
    expect(allData).not.toContain('hunter2secret');

    reader.stop();
    await sink.close();
  });

  test('should handle multiple concurrent writes', async () => {
    const pipePath = `${tmpDir.path}/concurrent.pipe`;
    await createNamedPipe(pipePath);

    const reader = startPipeReader(pipePath);

    const sink = new NamedPipeSink({
      pipePath,
      jsonFormat: false,
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    // Write many entries
    const numEntries = 50;
    for (let i = 0; i < numEntries; i++) {
      const message = `Entry ${i}`;
      const entry: LogEntry = {
        timestamp: Date.now(),
        type: 'info',
        serviceName: 'ConcurrentTest',
        template: message,
        message,
      };
      sink.write(entry);
    }

    // Wait for writes
    await new Promise((resolve) => setTimeout(resolve, 300));

    const allData = reader.data.join('');

    // Check that all entries were written
    for (let i = 0; i < numEntries; i++) {
      expect(allData).toContain(`Entry ${i}`);
    }

    reader.stop();
    await sink.close();
  });

  test('should not write after closing', async () => {
    const pipePath = `${tmpDir.path}/close-test.pipe`;
    await createNamedPipe(pipePath);

    const reader = startPipeReader(pipePath);

    const sink = new NamedPipeSink({
      pipePath,
      jsonFormat: false,
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    // Close the sink
    await sink.close();

    // Try to write after close
    const entry: LogEntry = {
      timestamp: Date.now(),
      type: 'info',
      serviceName: 'CloseTest',
      template: 'Should not be written',
      message: 'Should not be written',
    };

    sink.write(entry);

    await new Promise((resolve) => setTimeout(resolve, 100));

    const allData = reader.data.join('');
    expect(allData).not.toContain('Should not be written');

    reader.stop();
  });

  test('should format raw type logs without type prefix', async () => {
    const pipePath = `${tmpDir.path}/raw-test.pipe`;
    await createNamedPipe(pipePath);

    const reader = startPipeReader(pipePath);

    const sink = new NamedPipeSink({
      pipePath,
      jsonFormat: false,
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    const entry: LogEntry = {
      timestamp: Date.now(),
      type: 'raw',
      serviceName: '',
      template: 'Raw message',
      message: 'Raw message',
    };

    sink.write(entry);

    await new Promise((resolve) => setTimeout(resolve, 100));

    const allData = reader.data.join('');
    expect(allData).not.toContain('[raw]');
    expect(allData).toContain('Raw message');

    reader.stop();
    await sink.close();
  });

  test('should successfully reconnect after stream is destroyed', async () => {
    const pipePath = `${tmpDir.path}/reconnect-destroy.pipe`;
    await createNamedPipe(pipePath);

    let reader = startPipeReader(pipePath);

    const sink = new NamedPipeSink({
      pipePath,
      jsonFormat: false,
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    // Write initial entry
    const entry1: LogEntry = {
      timestamp: Date.now(),
      type: 'info',
      serviceName: 'ReconnectTest',
      template: 'Before destroy',
      message: 'Before destroy',
    };

    sink.write(entry1);
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify initial write
    expect(reader.data.join('')).toContain('Before destroy');

    // Get access to private fields and destroy the stream
    const privateSink = sink as any;
    if (privateSink.pipeStream) {
      privateSink.pipeStream.destroy();
      privateSink.pipeStream = undefined;
      privateSink.isInitialized = false;
    }

    // Stop old reader
    reader.stop();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Start new reader
    reader = startPipeReader(pipePath);
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Reconnect
    const reconnectResult = await sink.reconnect();
    expect(reconnectResult.success).toBe(true);

    // Write after reconnect
    const entry2: LogEntry = {
      timestamp: Date.now(),
      type: 'info',
      serviceName: 'ReconnectTest',
      template: 'After reconnect',
      message: 'After reconnect',
    };

    sink.write(entry2);
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify write after reconnect
    const newData = reader.data.join('');
    expect(newData).toContain('After reconnect');

    reader.stop();
    await sink.close();
  });

  test('should report reconnection state through getHealth', async () => {
    const pipePath = `${tmpDir.path}/reconnecting-status.pipe`;
    await createNamedPipe(pipePath);

    const reader = startPipeReader(pipePath);

    const sink = new NamedPipeSink({
      pipePath,
      jsonFormat: false,
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    // Initially not reconnecting
    expect(sink.getHealth().isReconnecting).toBe(false);

    // Write to ensure it's working
    const entry: LogEntry = {
      timestamp: Date.now(),
      type: 'info',
      serviceName: 'ReconnectingTest',
      template: 'Test',
      message: 'Test',
    };

    sink.write(entry);
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Should still not be reconnecting during normal operation
    expect(sink.getHealth().isReconnecting).toBe(false);

    reader.stop();
    await sink.close();
  });

  test('should handle concurrent reconnect attempts', async () => {
    const pipePath = `${tmpDir.path}/already-reconnecting.pipe`;
    await createNamedPipe(pipePath);

    const reader = startPipeReader(pipePath);

    const sink = new NamedPipeSink({
      pipePath,
      jsonFormat: false,
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    // Manually set reconnecting flag to test the already_reconnecting path
    const privateSink = sink as any;
    privateSink._isReconnecting = true;

    // Try to reconnect while flag is set
    const reconnectResult = await sink.reconnect();

    // Should report already_reconnecting
    expect(reconnectResult.success).toBe(false);
    if (!reconnectResult.success) {
      expect(reconnectResult.reason).toBe('already_reconnecting');
    }

    reader.stop();
    await sink.close();
  });

  test('should handle custom formatter errors gracefully', async () => {
    const pipePath = `${tmpDir.path}/formatter-error.pipe`;
    await createNamedPipe(pipePath);

    const reader = startPipeReader(pipePath);

    const faultyFormatter = (_entry: LogEntry) => {
      throw new Error('Formatter error');
    };

    const sink = new NamedPipeSink({
      pipePath,
      formatter: faultyFormatter,
      jsonFormat: false,
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    const entry: LogEntry = {
      timestamp: Date.now(),
      type: 'info',
      serviceName: 'FormatterErrorTest',
      template: 'Test message',
      message: 'Test message',
    };

    sink.write(entry);

    await new Promise((resolve) => setTimeout(resolve, 100));

    // Should fall back to default formatting
    const allData = reader.data.join('');
    expect(allData).toContain('Test message');

    reader.stop();
    await sink.close();
  });

  test('should call onError callback when provided', async () => {
    const pipePath = `${tmpDir.path}/nonexistent-error.pipe`;
    const errors: Array<{
      type: PipeErrorType;
      error: Error;
      path: string;
    }> = [];

    const sink = new NamedPipeSink({
      pipePath,
      onError: (errorType, error, path) => {
        errors.push({ type: errorType, error, path });
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].type).toBe(PipeErrorType.NOT_FOUND);
    expect(errors[0].path).toBe(pipePath);

    await sink.close();
  });

  test('should handle backpressure with drain event', async () => {
    const pipePath = `${tmpDir.path}/backpressure.pipe`;
    await createNamedPipe(pipePath);

    const reader = startPipeReader(pipePath);

    const sink = new NamedPipeSink({
      pipePath,
      jsonFormat: false,
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    // Write a moderate amount of data to test backpressure handling
    // Reduced from 1000 to 100 to avoid too many drain listeners
    for (let i = 0; i < 100; i++) {
      const message = 'X'.repeat(100); // 100 chars per entry
      const entry: LogEntry = {
        timestamp: Date.now(),
        type: 'info',
        serviceName: 'BackpressureTest',
        template: message,
        message,
      };
      sink.write(entry);
    }

    // Wait for all writes to complete
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Just verify no crashes occurred and data was written
    const allData = reader.data.join('');
    expect(allData.length).toBeGreaterThan(0);

    reader.stop();
    await sink.close();
  });

  test('does not re-render a queued entry whose first render failed', async () => {
    const pipePath = `${tmpDir.path}/format-failure.pipe`;

    await createNamedPipe(pipePath);

    const reader = startPipeReader(pipePath);
    const errors: { type: PipeErrorType; error: Error }[] = [];

    const sink = new NamedPipeSink({
      pipePath,
      jsonFormat: true,
      onError: (type, error) => {
        errors.push({ type, error });
      },
    });

    // Queued while the pipe is still opening. The shared-subtree gap: a `BigInt` under
    // `params.user` fails the render at `write` time, and the caller can then remove it
    // during the outage - which is what would let a second render succeed and serialize
    // the token added beside it on the same shared object.
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

    await new Promise((resolve) => setTimeout(resolve, 200));
    await sink.close();

    reader.stop();

    expect(reader.data.join('')).not.toContain(
      'topsecret-should-never-be-written',
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.type).toBe(PipeErrorType.WRITE);
  });
  test('holds entries while the pipe is unusable and flushes them on recovery', async () => {
    // The failure this sink used to answer by dropping. `FileSink` queues, retries and
    // reopens; a pipe error cleared the stream, left `isInitialized` set, and every later
    // entry fell through a silent early return until the application called `reconnect()`
    // itself - by which time there was nothing left to flush.
    const pipePath = `${tmpDir.path}/recover.pipe`;
    await createNamedPipe(pipePath);

    const reader = startPipeReader(pipePath);
    const sink = new NamedPipeSink({ pipePath });

    await new Promise((resolve) => setTimeout(resolve, 100));

    const entryFor = (message: string): LogEntry => ({
      timestamp: Date.now(),
      type: 'info',
      template: message,
      message,
    });

    // Force the sink into the state a stream failure leaves behind.
    sink.write(entryFor('before-outage'));
    await new Promise((resolve) => setTimeout(resolve, 100));

    (sink as unknown as { pipeStream: undefined }).pipeStream = undefined;
    (sink as unknown as { isInitialized: boolean }).isInitialized = false;

    sink.write(entryFor('during-outage'));

    // Held, not lost: nothing was written and nothing was counted as dropped.
    expect(sink.getHealth().droppedEntries).toBe(0);

    // `write` starts an automatic reopen of its own, and a manual `reconnect()` racing it
    // answers `already_reconnecting` - correctly, since the reopen it would have done is
    // already happening. Let that settle so this asserts the manual path.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const status = await sink.reconnect();

    expect(status.success).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 200));
    await sink.close();
    reader.stop();

    const written = reader.data.join('');

    expect(written).toContain('before-outage');
    expect(written).toContain('during-outage');
  }, 15000);

  test('reopens on its own once the cooldown has passed', async () => {
    // No `reconnect()` call at all: the entry queued during the outage goes out because
    // `write` asked the sink to reopen, the way `FileSink` recreates its stream on the
    // next attempt.
    const pipePath = `${tmpDir.path}/selfheal.pipe`;
    await createNamedPipe(pipePath);

    const reader = startPipeReader(pipePath);
    const sink = new NamedPipeSink({ pipePath });

    await new Promise((resolve) => setTimeout(resolve, 100));

    (sink as unknown as { pipeStream: undefined }).pipeStream = undefined;
    (sink as unknown as { isInitialized: boolean }).isInitialized = false;
    // The constructor's own open counts as the last attempt, so clear the cooldown.
    (sink as unknown as { lastReopenAttempt: number }).lastReopenAttempt = 0;

    sink.write({
      timestamp: Date.now(),
      type: 'info',
      template: 'self-healed',
      message: 'self-healed',
    });

    await new Promise((resolve) => setTimeout(resolve, 400));
    await sink.close();
    reader.stop();

    expect(reader.data.join('')).toContain('self-healed');
    expect(sink.getHealth().droppedEntries).toBe(0);
  }, 15000);

  test('caps the queue at 10,000 entries by default', async () => {
    // Both sinks default to a cap now. Unbounded is the wrong default for a queue that
    // only grows when something is already wrong.
    // A path with no FIFO at it: the sink cannot initialize, which is the state this
    // exercises, and - unlike a real pipe with no reader - it leaves no `open` blocked in
    // libuv's threadpool, which has four threads and is what every other file operation
    // in this suite needs.
    const pipePath = `${tmpDir.path}/default-cap.pipe`;

    const sink = new NamedPipeSink({
      pipePath,
      // Driven deliberately over the cap, so the drop report is expected rather than news.
      onError: () => {},
      // Nothing is reading this pipe, so the closing flush cannot complete; the sink caps
      // that wait rather than hanging on it, and this keeps the test brisk.
      closeTimeoutMS: 200,
    });

    // Auto-reopen is neutered here deliberately. These two cover queue accounting, and a
    // reopen against a pipe nobody is reading leaves an `open` pending for as long as the
    // test process lives - holding a libuv threadpool slot, four of which is every file
    // operation the suite has. Recovery is covered by its own tests above, with a reader.
    (sink as unknown as { ensureConnection: () => void }).ensureConnection =
      () => {
        // Intentionally empty.
      };

    // Never initialized - nothing is reading and nothing opened it - so every entry queues.
    (sink as unknown as { isInitialized: boolean }).isInitialized = false;

    for (let i = 0; i < 10_050; i++) {
      sink.write({
        timestamp: Date.now(),
        type: 'info',
        template: `entry-${String(i)}`,
        message: `entry-${String(i)}`,
      });
    }

    expect(
      (sink as unknown as { writeQueue: unknown[] }).writeQueue.length,
    ).toBe(10_000);
    expect(sink.getHealth().droppedEntries).toBe(50);

    await sink.close();
  }, 15000);

  test('holds everything when maxQueueSize is -1', async () => {
    // No FIFO at this path either; see the test above.
    const pipePath = `${tmpDir.path}/unlimited.pipe`;

    const sink = new NamedPipeSink({
      pipePath,
      maxQueueSize: -1,
      onError: () => {},
      closeTimeoutMS: 200,
    });

    // Auto-reopen is neutered here deliberately. These two cover queue accounting, and a
    // reopen against a pipe nobody is reading leaves an `open` pending for as long as the
    // test process lives - holding a libuv threadpool slot, four of which is every file
    // operation the suite has. Recovery is covered by its own tests above, with a reader.
    (sink as unknown as { ensureConnection: () => void }).ensureConnection =
      () => {
        // Intentionally empty.
      };

    (sink as unknown as { isInitialized: boolean }).isInitialized = false;

    for (let i = 0; i < 10_050; i++) {
      sink.write({
        timestamp: Date.now(),
        type: 'info',
        template: `entry-${String(i)}`,
        message: `entry-${String(i)}`,
      });
    }

    expect(
      (sink as unknown as { writeQueue: unknown[] }).writeQueue.length,
    ).toBe(10_050);
    expect(sink.getHealth().droppedEntries).toBe(0);

    await sink.close();
  }, 15000);
  test('reports queue size, drops and failures through getHealth', async () => {
    // The observability half of the shared policy: both sinks answer a failure the same
    // way, and both can now say how that is going. This sink used to expose a single
    // dropped-entry count, so a queue growing behind a pipe nobody was reading was
    // invisible until entries started falling off the end of it.
    const pipePath = `${tmpDir.path}/health.pipe`;
    await createNamedPipe(pipePath);

    const reader = startPipeReader(pipePath);
    const sink = new NamedPipeSink({ pipePath });

    await new Promise((resolve) => setTimeout(resolve, 100));

    const healthy = sink.getHealth();

    expect(healthy.isInitialized).toBe(true);
    expect(healthy.isHealthy).toBe(true);
    expect(healthy.queueSize).toBe(0);
    expect(healthy.droppedEntries).toBe(0);
    expect(healthy.consecutiveFailures).toBe(0);
    expect(healthy.lastError).toBeUndefined();

    // Force the state a stream failure leaves behind, then queue behind it.
    (sink as unknown as { pipeStream: undefined }).pipeStream = undefined;
    (sink as unknown as { isInitialized: boolean }).isInitialized = false;

    for (let index = 0; index < 3; index++) {
      sink.write({
        timestamp: Date.now(),
        type: 'info',
        template: `queued-${String(index)}`,
        message: `queued-${String(index)}`,
      });
    }

    const stalled = sink.getHealth();

    expect(stalled.queueSize).toBe(3);
    expect(stalled.isInitialized).toBe(false);
    expect(stalled.isHealthy).toBe(false);
    expect(stalled.droppedEntries).toBe(0);

    await sink.close();
    reader.stop();
  }, 15000);

  test('counts a format failure without calling the sink unhealthy', async () => {
    // A `formatter` that throws still produces a line and leaves the pipe untouched, so
    // it is recorded as the last error but never as a write failure.
    const pipePath = `${tmpDir.path}/health-format.pipe`;
    await createNamedPipe(pipePath);

    const reader = startPipeReader(pipePath);
    const sink = new NamedPipeSink({
      pipePath,
      formatter: () => {
        throw new Error('formatter blew up');
      },
      onError: () => {
        // Expected: the sink reports the failure and writes the default format instead.
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    sink.write({
      timestamp: Date.now(),
      type: 'info',
      template: 'still-written',
      message: 'still-written',
    });

    await new Promise((resolve) => setTimeout(resolve, 150));

    const health = sink.getHealth();

    expect(health.lastError?.message).toContain('formatter blew up');
    expect(health.consecutiveFailures).toBe(0);
    expect(health.isHealthy).toBe(true);

    await sink.close();
    reader.stop();

    expect(reader.data.join('')).toContain('still-written');
  }, 15000);
  test('keeps entries in its own queue until the pipe is genuinely open', async () => {
    // `createWriteStream` returns before the open completes, and a FIFO does not open
    // until a reader arrives. Treating the stream as usable at creation handed every
    // queued line to Node, which buffers without limit - so `maxQueueSize` bounded
    // nothing and `getHealth().queueSize` read zero while memory grew. Measured before
    // the fix: a cap of 10 held 0 entries and dropped none of 500.
    const pipePath = `${tmpDir.path}/no-reader.pipe`;
    await createNamedPipe(pipePath);

    const sink = new NamedPipeSink({
      pipePath,
      maxQueueSize: 10,
      onError: () => {
        // Expected: the queue fills and reports its first drop.
      },
      closeTimeoutMS: 200,
    });

    await new Promise((resolve) => setTimeout(resolve, 200));

    for (let index = 0; index < 500; index++) {
      sink.write({
        timestamp: Date.now(),
        type: 'info',
        template: `entry-${String(index)}`,
        message: `entry-${String(index)}`,
      });
    }

    const health = sink.getHealth();

    // Nothing is reading, so the pipe never opened and the sink says so.
    expect(health.isInitialized).toBe(false);
    expect(health.queueSize).toBe(10);
    expect(health.droppedEntries).toBe(490);

    await sink.close();
  }, 15000);

  test('requeues an entry whose write fails asynchronously', async () => {
    // A stream reports `EPIPE` through the write callback and an `'error'` event, not by
    // throwing, so treating `write()` returning as delivery meant the one entry that
    // actually failed was the one never retried.
    const pipePath = `${tmpDir.path}/async-fail.pipe`;
    await createNamedPipe(pipePath);

    const reader = startPipeReader(pipePath);
    const sink = new NamedPipeSink({ pipePath });

    expect(await waitForOpenPipe(sink)).toBe(true);

    // A stream that accepts the write and fails it on the next tick, as a real one does.
    (
      sink as unknown as {
        pipeStream: {
          destroyed: boolean;
          write: (
            chunk: string,
            callback: (error?: Error | null) => void,
          ) => boolean;
          end: (callback?: () => void) => void;
          destroy: () => void;
        };
      }
    ).pipeStream = {
      destroyed: false,
      write: (_chunk, callback) => {
        setTimeout(() => {
          callback(new Error('EPIPE'));
        }, 0);

        return true;
      },
      // Enough of a stream for `close()` to shut it down without reporting a failure of
      // its own; the point of the stub is the write callback above.
      end: (callback?: () => void) => {
        callback?.();
      },
      destroy: () => {
        // Nothing to tear down.
      },
    };

    try {
      sink.write({
        timestamp: Date.now(),
        type: 'info',
        template: 'retried',
        message: 'retried',
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Back on the queue rather than gone: the line is still owed to the caller.
      expect(sink.getHealth().queueSize).toBe(1);
      expect(sink.getHealth().droppedEntries).toBe(0);
    } finally {
      await sink.close();
      reader.stop();
    }
  }, 15000);
  test('keeps entries under the cap when the reader stops consuming', async () => {
    // Backpressure was the third way the managed queue could be bypassed: `write()`
    // returning false means the stream's buffer is over its high-water mark, and ignoring
    // it drained the queue into Node's buffer, which has no cap. Measured before the fix:
    // 500 entries went there while a cap of 10 held none and `getHealth()` reported an
    // empty queue with no drops.
    const pipePath = `${tmpDir.path}/backpressure.pipe`;
    await createNamedPipe(pipePath);

    // A reader that opens the pipe and never consumes a byte, so the kernel FIFO buffer
    // fills and everything after it is backpressure.
    const readerFd = fs.openSync(
      pipePath,
      fs.constants.O_RDONLY | fs.constants.O_NONBLOCK,
    );

    const sink = new NamedPipeSink({
      pipePath,
      maxQueueSize: 10,
      onError: () => {
        // Expected: the queue fills and reports its first drop.
      },
      closeTimeoutMS: 200,
    });

    try {
      expect(await waitForOpenPipe(sink)).toBe(true);

      const line = 'x'.repeat(1000);

      for (let index = 0; index < 500; index++) {
        sink.write({
          timestamp: Date.now(),
          type: 'info',
          template: line,
          message: line,
          entityName: `e-${String(index)}`,
        });
      }

      await new Promise((resolve) => setTimeout(resolve, 200));

      const health = sink.getHealth();

      // Held under the cap rather than handed to a buffer nothing bounds.
      expect(health.queueSize).toBe(10);
      expect(health.droppedEntries).toBeGreaterThan(0);
    } finally {
      await sink.close();
      fs.closeSync(readerFd);
    }
  }, 15000);

  test('recovers a requeued entry without waiting for later traffic', async () => {
    // A failed write reports through its callback before the stream emits `'error'`, so
    // the requeue asks for a reconnection while the sink still looks connected and is told
    // there is nothing to do. Nothing then started recovery, and the entry sat until some
    // unrelated later write happened along - which in a quiet process is never.
    const pipePath = `${tmpDir.path}/self-recovery.pipe`;
    await createNamedPipe(pipePath);

    const reader = startPipeReader(pipePath);
    const sink = new NamedPipeSink({ pipePath, onError: () => {} });

    try {
      expect(await waitForOpenPipe(sink)).toBe(true);

      // The sink's own stream, made to fail the way a real one does: the write callback
      // first, the `'error'` event behind it.
      const live = (sink as unknown as { pipeStream: fs.WriteStream })
        .pipeStream;

      (
        live as unknown as {
          write: (
            chunk: string,
            callback?: (error?: Error | null) => void,
          ) => boolean;
        }
      ).write = (_chunk, callback) => {
        callback?.(new Error('EPIPE'));
        live.emit('error', new Error('EPIPE'));

        return true;
      };

      sink.write({
        timestamp: Date.now(),
        type: 'info',
        template: 'recovered-on-its-own',
        message: 'recovered-on-its-own',
      });

      // The entry is owed, the connection is gone, and nothing else is going to be logged.
      expect(sink.getHealth().queueSize).toBe(1);
      expect(sink.getHealth().isInitialized).toBe(false);

      // No further writes and no `reconnect()` call: the sink reopens on the deferred
      // attempt its own failure scheduled, and flushes what it was holding.
      expect(await waitForOpenPipe(sink, 5000)).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(sink.getHealth().queueSize).toBe(0);
      expect(reader.data.join('')).toContain('recovered-on-its-own');
    } finally {
      await sink.close();
      reader.stop();
    }
  }, 20000);

  test('a late error from a replaced stream does not unseat the live one', async () => {
    // A stream ended by `reconnect()` can deliver its error after the replacement has
    // opened, and its handler is a closure over the stream it was attached to. Ungated,
    // that late error marked the fresh connection uninitialized and sent every later
    // entry to the queue - and counted against a stream that was working.
    const pipePath = `${tmpDir.path}/stale-error.pipe`;
    await createNamedPipe(pipePath);

    const reader = startPipeReader(pipePath);
    const sink = new NamedPipeSink({ pipePath, onError: () => {} });

    try {
      expect(await waitForOpenPipe(sink)).toBe(true);

      // The listeners the sink attached to the stream it is about to replace.
      const replaced = (sink as unknown as { pipeStream: fs.WriteStream })
        .pipeStream;
      const staleHandlers = replaced.listeners('error') as ((
        error: Error,
      ) => void)[];

      expect(staleHandlers.length).toBeGreaterThan(0);

      const status = await sink.reconnect();

      expect(status.success).toBe(true);
      expect(sink.getHealth().isInitialized).toBe(true);

      // The replaced stream reports its failure now, one turn too late.
      for (const handler of staleHandlers) {
        handler(new Error('late EPIPE from a stream we replaced'));
      }

      const health = sink.getHealth();

      expect(health.isInitialized).toBe(true);
      expect(health.consecutiveFailures).toBe(0);
      expect(health.isHealthy).toBe(true);
    } finally {
      await sink.close();
      reader.stop();
    }
  }, 15000);
});
