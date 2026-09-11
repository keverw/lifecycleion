import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { promises as fsPromises } from 'fs';
import * as fs from 'fs';
import * as os from 'os';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { NamedPipeSink } from './named-pipe';
import type { SinkFailure, SinkFailureKind } from './internal/sink-failure';
import { LogLevel } from '../types';
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
    const errors: SinkFailure[] = [];

    const sink = new NamedPipeSink({
      pipePath,
      onError: (failure) => {
        errors.push(failure);
      },
    });

    // Wait for initialization attempt
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Should have an error
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]?.kind).toBe('not_found' satisfies SinkFailureKind);

    await sink.close();
  });

  test('should handle error when path is not a pipe', async () => {
    // Create a regular file instead of a pipe
    const filePath = `${tmpDir.path}/regular-file.txt`;
    await fsPromises.writeFile(filePath, 'not a pipe');

    const errors: SinkFailure[] = [];

    const sink = new NamedPipeSink({
      pipePath: filePath,
      onError: (failure) => {
        errors.push(failure);
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]?.kind).toBe('not_a_pipe' satisfies SinkFailureKind);

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
    const errors: SinkFailure[] = [];

    const sink = new NamedPipeSink({
      pipePath,
      onError: (failure) => {
        errors.push(failure);
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]?.kind).toBe('not_found' satisfies SinkFailureKind);
    expect(errors[0]?.target).toBe(pipePath);

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
    const errors: SinkFailure[] = [];

    const sink = new NamedPipeSink({
      pipePath,
      jsonFormat: true,
      onError: (failure) => {
        errors.push(failure);
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

    // Waited for rather than guessed at: the queued entry is only processed - and its
    // render failure only reported - once the pipe is actually open, and how long that
    // takes depends on when the reader's own open completes.
    expect(await waitForOpenPipe(sink)).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 200));
    await sink.close();

    reader.stop();

    expect(reader.data.join('')).not.toContain(
      'topsecret-should-never-be-written',
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.kind).toBe('format' satisfies SinkFailureKind);
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

    // Let the pending open finish before leaving. A FIFO open with no reader blocks in
    // libuv's threadpool - four threads for the whole process - and `destroy()` cannot
    // cancel one already in flight, so a test that walks away from it takes a thread with
    // it and every later test waits on file I/O behind it. That was a real source of
    // flakiness here, not a tidiness point.
    const readerFd = fs.openSync(
      pipePath,
      fs.constants.O_RDONLY | fs.constants.O_NONBLOCK,
    );

    await sink.close();
    fs.closeSync(readerFd);
  }, 15000);

  test('requeues an entry whose write fails asynchronously', async () => {
    // A stream reports `EPIPE` through the write callback and an `'error'` event, not by
    // throwing, so treating `write()` returning as delivery meant the one entry that
    // actually failed was the one never retried.
    const pipePath = `${tmpDir.path}/async-fail.pipe`;
    await createNamedPipe(pipePath);

    const reader = startPipeReader(pipePath);
    const sink = new NamedPipeSink({ pipePath, onError: () => {} });

    try {
      expect(await waitForOpenPipe(sink)).toBe(true);

      const written: string[] = [];
      let failuresLeft = 1;

      // A stream that fails its first write on the next tick - as a real one does - and
      // accepts what follows. The connection itself stays up, so the sink's answer is to
      // try the line again rather than to reconnect.
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
        write: (chunk, callback) => {
          if (failuresLeft > 0) {
            failuresLeft--;

            setTimeout(() => {
              callback(new Error('EPIPE'));
            }, 0);

            return true;
          }

          written.push(chunk);

          setTimeout(() => {
            callback(null);
          }, 0);

          return true;
        },
        end: (callback?: () => void) => {
          callback?.();
        },
        destroy: () => {
          // Nothing to tear down.
        },
      };

      sink.write({
        timestamp: Date.now(),
        type: 'info',
        template: 'retried',
        message: 'retried',
      });

      await new Promise((resolve) => setTimeout(resolve, 150));

      // Written on the second attempt rather than dropped on the first.
      expect(written.join('')).toContain('retried');
      expect(sink.getHealth().queueSize).toBe(0);
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

    // A raw descriptor rather than `startPipeReader`, and it is the difference between
    // this test passing and hanging. `reconnect()` ends the old write stream, which leaves
    // the FIFO with no writer; a `createReadStream` reader sees EOF and closes, and the
    // replacement stream then has no reader to open against and blocks. A descriptor held
    // open for the whole test keeps a reader attached across the swap.
    const readerFd = fs.openSync(
      pipePath,
      fs.constants.O_RDONLY | fs.constants.O_NONBLOCK,
    );
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

      await sink.reconnect();

      // The connection, not `reconnect()`'s verdict: a busy threadpool can push the open
      // past the wait `reconnect()` is willing to give it, and it answers honestly that
      // the pipe is not open *yet* while the open it started goes on to succeed. What
      // this test is about is what a stale error does to the connection that results.
      expect(await waitForOpenPipe(sink)).toBe(true);

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
      fs.closeSync(readerFd);
    }
  }, 15000);
  test('filters by minLevel, and always writes a raw entry', async () => {
    // The sink had no level filtering at all, so a debug line went down the pipe whatever
    // the reader wanted. It now matches `FileSink` and `ConsoleSink`, default included.
    const pipePath = `${tmpDir.path}/min-level.pipe`;
    await createNamedPipe(pipePath);

    const reader = startPipeReader(pipePath);
    const sink = new NamedPipeSink({ pipePath });

    try {
      expect(await waitForOpenPipe(sink)).toBe(true);
      expect(sink.getMinLevel()).toBe(LogLevel.INFO);

      const entryOf = (type: LogEntry['type'], message: string): LogEntry => ({
        timestamp: Date.now(),
        type,
        template: message,
        message,
      });

      sink.write(entryOf('debug', 'below-the-default'));
      sink.write(entryOf('info', 'at-the-default'));
      sink.write(entryOf('raw', 'raw-is-always-written'));

      await new Promise((resolve) => setTimeout(resolve, 200));

      const written = reader.data.join('');

      expect(written).not.toContain('below-the-default');
      expect(written).toContain('at-the-default');
      expect(written).toContain('raw-is-always-written');

      // And it can be widened, as on the other sinks.
      sink.setMinLevel(LogLevel.DEBUG);
      sink.write(entryOf('debug', 'now-included'));

      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(reader.data.join('')).toContain('now-included');
    } finally {
      await sink.close();
      reader.stop();
    }
  }, 15000);
  test('drains a requeue that arrives from a stream already replaced', async () => {
    // A write callback can land after `reconnect()` has put a working stream in place.
    // Its failure belongs to the stream that is gone, so asking `ensureConnection` for
    // help gets nothing - correctly, the sink is connected - and nothing else drained the
    // queue, while every later write went straight past it to the new stream.
    const pipePath = `${tmpDir.path}/replaced-requeue.pipe`;
    await createNamedPipe(pipePath);

    const reader = startPipeReader(pipePath);
    const sink = new NamedPipeSink({ pipePath, onError: () => {} });

    try {
      expect(await waitForOpenPipe(sink)).toBe(true);

      const privateSink = sink as unknown as {
        requeue: (queued: {
          formatted: string | undefined;
          formatError: Error | undefined;
          attempts: number;
        }) => void;
      };

      // Exactly what a late callback from a replaced stream does: the sink is connected,
      // and an entry it had already taken off the queue comes back.
      privateSink.requeue({
        formatted: 'late-callback-from-a-replaced-stream\n',
        formatError: undefined,
        attempts: 0,
      });

      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(sink.getHealth().queueSize).toBe(0);
      expect(sink.getHealth().droppedEntries).toBe(0);
      expect(reader.data.join('')).toContain(
        'late-callback-from-a-replaced-stream',
      );
    } finally {
      await sink.close();
      reader.stop();
    }
  }, 15000);
  test('reports a failed write with the line it belongs to and its real retry state', async () => {
    // A stream delivers one failed write twice - through the callback and as an `'error'`
    // event - and only the callback knows which line it was. Reported from the event, it
    // came out as `attempt: undefined` with nothing to retry, for a line the sink was
    // about to retry: a handler writing a fallback copy duplicated it. Reported from the
    // callback, and said once.
    const pipePath = `${tmpDir.path}/write-report.pipe`;
    await createNamedPipe(pipePath);

    const reader = startPipeReader(pipePath);
    const failures: SinkFailure[] = [];
    const sink = new NamedPipeSink({
      pipePath,
      onError: (failure) => {
        failures.push(failure);
      },
    });

    try {
      expect(await waitForOpenPipe(sink)).toBe(true);

      const live = (sink as unknown as { pipeStream: fs.WriteStream })
        .pipeStream;
      const failure = new Error('EPIPE');

      (
        live as unknown as {
          write: (
            chunk: string,
            callback?: (error?: Error | null) => void,
          ) => boolean;
        }
      ).write = (_chunk, callback) => {
        // On the next tick, as a real stream reports: the callback first, then the same
        // error instance as an `'error'` event.
        setTimeout(() => {
          callback?.(failure);
          live.emit('error', failure);
        }, 0);

        return true;
      };

      sink.write({
        timestamp: Date.now(),
        type: 'info',
        template: 'reported-once',
        message: 'reported-once',
      });

      await new Promise((resolve) => setTimeout(resolve, 150));

      const writeFailures = failures.filter((entry) => entry.kind === 'write');

      // Every write failure describes the line it belongs to. The `'error'` event used to
      // add one of its own for the same failure, with no attempt and nothing to retry -
      // which is what made a handler write a fallback copy of a line the sink was about to
      // resend. Counted rather than asserted at one, because a retry against a stream that
      // has not yet reported its error is a genuine second attempt.
      expect(writeFailures.length).toBeGreaterThan(0);

      for (const entry of writeFailures) {
        expect(entry.attempt).toBeGreaterThan(0);
        expect(entry.disposition).not.toBe('no_entry');
        expect(entry.target).toBe(pipePath);
      }

      expect(writeFailures[0]?.attempt).toBe(1);
      expect(writeFailures[0]?.disposition).toBe('retrying');
    } finally {
      await sink.close();
      reader.stop();
    }
  }, 15000);

  test('a formatter that threw is reported as a fallback, not a loss', async () => {
    // The sink falls back to its own default format, so the line goes out. Reported as
    // though it were lost, a handler that writes lost lines elsewhere duplicated it.
    const pipePath = `${tmpDir.path}/formatter-written.pipe`;
    await createNamedPipe(pipePath);

    const reader = startPipeReader(pipePath);
    const failures: SinkFailure[] = [];
    const sink = new NamedPipeSink({
      pipePath,
      formatter: () => {
        throw new Error('formatter blew up');
      },
      onError: (failure) => {
        failures.push(failure);
      },
    });

    try {
      expect(await waitForOpenPipe(sink)).toBe(true);

      sink.write({
        timestamp: Date.now(),
        type: 'info',
        template: 'still-written',
        message: 'still-written',
      });

      await new Promise((resolve) => setTimeout(resolve, 150));

      const formatFailures = failures.filter(
        (entry) => entry.kind === 'format',
      );

      expect(formatFailures).toHaveLength(1);
      expect(formatFailures[0]?.disposition).toBe('fallback');
      expect(reader.data.join('')).toContain('still-written');
    } finally {
      await sink.close();
      reader.stop();
    }
  }, 15000);
  test('counts one failed write once', async () => {
    // The write callback reports the failure, and the stream's `'error'` event delivers
    // the same one a moment later. With the event's report suppressed, its bookkeeping
    // counted the failure a second time, so one failed attempt read as two in
    // `getHealth()`.
    const pipePath = `${tmpDir.path}/failure-count.pipe`;
    await createNamedPipe(pipePath);

    const reader = startPipeReader(pipePath);
    // No retries, so the failure below is the only write there is, and recovery is held
    // off so a successful write cannot reset the tally before it is read.
    const sink = new NamedPipeSink({
      pipePath,
      maxRetries: 0,
      onError: () => {},
    });

    try {
      expect(await waitForOpenPipe(sink)).toBe(true);

      (sink as unknown as { ensureConnection: () => void }).ensureConnection =
        () => {
          // Intentionally empty: recovery is not what this test is about.
        };

      const live = (sink as unknown as { pipeStream: fs.WriteStream })
        .pipeStream;
      const failure = new Error('EPIPE');

      (
        live as unknown as {
          write: (
            chunk: string,
            callback?: (error?: Error | null) => void,
          ) => boolean;
        }
      ).write = (_chunk, callback) => {
        setTimeout(() => {
          callback?.(failure);
          // The same instance, through both channels, exactly as a stream reports it.
          live.emit('error', failure);
        }, 0);

        return true;
      };

      sink.write({
        timestamp: Date.now(),
        type: 'info',
        template: 'counted-once',
        message: 'counted-once',
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(sink.getHealth().consecutiveFailures).toBe(1);
    } finally {
      await sink.close();
      reader.stop();
    }
  }, 15000);
  test('an unrelated stream error does not unsuppress a pending report', async () => {
    // The suppression used to be one slot holding the last error, cleared by whatever
    // error arrived next. A stale stream emitting between a write callback and its own
    // event cleared the entry, and the real failure was then reported a second time - with
    // no attempt and nothing to retry, which is the duplicate the pairing exists to stop.
    const pipePath = `${tmpDir.path}/suppression.pipe`;
    await createNamedPipe(pipePath);

    const readerFd = fs.openSync(
      pipePath,
      fs.constants.O_RDONLY | fs.constants.O_NONBLOCK,
    );
    const failures: SinkFailure[] = [];
    const sink = new NamedPipeSink({
      pipePath,
      maxRetries: 0,
      onError: (failure) => {
        failures.push(failure);
      },
    });

    try {
      expect(await waitForOpenPipe(sink)).toBe(true);

      (sink as unknown as { ensureConnection: () => void }).ensureConnection =
        () => {
          // Recovery is not what this test is about.
        };

      const live = (sink as unknown as { pipeStream: fs.WriteStream })
        .pipeStream;
      const errorHandlers = live.listeners('error') as ((
        error: Error,
      ) => void)[];
      const ours = new Error('EPIPE from the current stream');

      (
        live as unknown as {
          write: (
            chunk: string,
            callback?: (error?: Error | null) => void,
          ) => boolean;
        }
      ).write = (_chunk, callback) => {
        setTimeout(() => {
          callback?.(ours);

          // A stream this sink replaced long ago reports in the gap, before our own
          // event arrives.
          for (const handler of errorHandlers) {
            handler(new Error('late EPIPE from somewhere else'));
          }

          live.emit('error', ours);
        }, 0);

        return true;
      };

      sink.write({
        timestamp: Date.now(),
        type: 'info',
        template: 'reported-once',
        message: 'reported-once',
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Our failure is described once, by the callback that knew the line. The unrelated
      // error is reported too - it did happen - but it cannot make ours be said twice.
      const ownFailures = failures.filter((entry) => entry.error === ours);

      expect(ownFailures).toHaveLength(1);
      expect(ownFailures[0]?.attempt).toBe(1);
      expect(ownFailures[0]?.disposition).toBe('lost');
    } finally {
      await sink.close();
      fs.closeSync(readerFd);
    }
  }, 15000);
  test('a late callback from a replaced stream does not mark the live one unhealthy', async () => {
    // The write callback runs later than the write that started it, and `reconnect()` can
    // put a working stream in place in between. The failure belongs to the stream that is
    // gone - the `'error'` handler has always asked that question, and this one did not,
    // so a late callback marked the healthy replacement unhealthy.
    const pipePath = `${tmpDir.path}/stale-callback.pipe`;
    await createNamedPipe(pipePath);

    const readerFd = fs.openSync(
      pipePath,
      fs.constants.O_RDONLY | fs.constants.O_NONBLOCK,
    );
    const failures: SinkFailure[] = [];
    const sink = new NamedPipeSink({
      pipePath,
      onError: (failure) => {
        failures.push(failure);
      },
    });

    try {
      expect(await waitForOpenPipe(sink)).toBe(true);

      const replaced = (sink as unknown as { pipeStream: fs.WriteStream })
        .pipeStream;
      let deliverFailure: ((error: Error) => void) | undefined;

      // A write whose callback is held until after the stream has been replaced.
      (
        replaced as unknown as {
          write: (
            chunk: string,
            callback?: (error?: Error | null) => void,
          ) => boolean;
        }
      ).write = (_chunk, callback) => {
        deliverFailure = (error: Error) => {
          callback?.(error);
        };

        return true;
      };

      sink.write({
        timestamp: Date.now(),
        type: 'info',
        template: 'held',
        message: 'held',
      });

      await sink.reconnect();

      expect(await waitForOpenPipe(sink)).toBe(true);
      expect(sink.getHealth().consecutiveFailures).toBe(0);

      // The stream that is gone reports its failure now.
      deliverFailure?.(new Error('EPIPE from the replaced stream'));

      await new Promise((resolve) => setTimeout(resolve, 100));

      const health = sink.getHealth();

      // Reported - the line is still owed - but charged to nobody's health.
      expect(failures.some((entry) => entry.kind === 'write')).toBe(true);
      expect(health.consecutiveFailures).toBe(0);
      expect(health.isHealthy).toBe(true);
    } finally {
      await sink.close();
      fs.closeSync(readerFd);
    }
  }, 20000);
  test('a retry-exhausted drop is not reported as a full queue', async () => {
    // `droppedEntries` counts two different things - entries evicted by the cap, and
    // entries whose retries ran out - and `enforceQueueLimit` read the total. So one
    // retry-exhausted drop made the next `write()` report a `'queue_full'` against a queue
    // holding a single line, and set the once-only flag, which nothing resets: the real
    // overflow that came later was then never reported at all.
    const pipePath = `${tmpDir.path}/false-queue-full.pipe`;
    await createNamedPipe(pipePath);

    const readerFd = fs.openSync(
      pipePath,
      fs.constants.O_RDONLY | fs.constants.O_NONBLOCK,
    );
    const failures: SinkFailure[] = [];
    const sink = new NamedPipeSink({
      pipePath,
      maxQueueSize: 5,
      maxRetries: 0,
      onError: (failure) => {
        failures.push(failure);
      },
      closeTimeoutMS: 200,
    });

    try {
      expect(await waitForOpenPipe(sink)).toBe(true);

      (sink as unknown as { ensureConnection: () => void }).ensureConnection =
        () => {
          // Recovery would reopen the pipe and drain the queue; this test is about what
          // the queue reports while it cannot.
        };

      const live = (sink as unknown as { pipeStream: fs.WriteStream })
        .pipeStream;

      // One write that fails on the next tick. With no retries left the entry is given up
      // on, which counts a drop that the cap had nothing to do with.
      (
        live as unknown as {
          write: (
            chunk: string,
            callback?: (error?: Error | null) => void,
          ) => boolean;
        }
      ).write = (_chunk, callback) => {
        setTimeout(() => {
          callback?.(new Error('EPIPE'));
        }, 0);

        return true;
      };

      sink.write({
        timestamp: Date.now(),
        type: 'info',
        template: 'given-up-on',
        message: 'given-up-on',
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(sink.getHealth().droppedEntries).toBe(1);

      // Nothing to write to, so everything below waits in the managed queue.
      (sink as unknown as { isInitialized: boolean }).isInitialized = false;

      for (let index = 0; index < 3; index++) {
        sink.write({
          timestamp: Date.now(),
          type: 'info',
          template: `under-cap-${String(index)}`,
          message: `under-cap-${String(index)}`,
        });
      }

      // Three lines held under a cap of five is not a full queue.
      expect(sink.getHealth().queueSize).toBe(3);
      expect(failures.filter((entry) => entry.kind === 'queue_full')).toEqual(
        [],
      );

      for (let index = 0; index < 20; index++) {
        sink.write({
          timestamp: Date.now(),
          type: 'info',
          template: `over-cap-${String(index)}`,
          message: `over-cap-${String(index)}`,
        });
      }

      // Now the cap is evicting, and that is reported - once.
      const queueFull = failures.filter((entry) => entry.kind === 'queue_full');

      expect(queueFull).toHaveLength(1);
      expect(queueFull[0]?.disposition).toBe('lost');
      expect(sink.getHealth().queueSize).toBe(5);
    } finally {
      await sink.close();
      fs.closeSync(readerFd);
    }
  }, 15000);

  test('entries still queued when close() gives up are counted and reported', async () => {
    // A FIFO with no reader is this sink's ordinary failure, and the queue behind it is
    // exactly what `close()` cannot flush. Those lines were abandoned silently:
    // `droppedEntries` stayed at 0 and `onError` heard nothing, so a shutdown during an
    // outage looked identical to one that wrote everything.
    const pipePath = `${tmpDir.path}/close-abandons.pipe`;
    await createNamedPipe(pipePath);

    const failures: SinkFailure[] = [];
    const sink = new NamedPipeSink({
      pipePath,
      closeTimeoutMS: 200,
      onError: (failure) => {
        failures.push(failure);
      },
    });

    // No reader, so the write side never opens and everything below waits in the queue.
    for (let index = 0; index < 4; index++) {
      sink.write({
        timestamp: Date.now(),
        type: 'info',
        template: `abandoned-${String(index)}`,
        message: `abandoned-${String(index)}`,
      });
    }

    expect(sink.getHealth().queueSize).toBe(4);

    // `close()` sets `closing` synchronously, so the reader opened here only releases the
    // `open` blocked in libuv's threadpool - the stream it completes is destroyed unused
    // rather than draining the queue this test is about. Walking away from that pending
    // open instead would take one of four threads with it and stall every later test.
    const closePromise = sink.close();
    const readerFd = fs.openSync(
      pipePath,
      fs.constants.O_RDONLY | fs.constants.O_NONBLOCK,
    );

    await closePromise;
    fs.closeSync(readerFd);

    expect(sink.getHealth().queueSize).toBe(0);
    expect(sink.getHealth().droppedEntries).toBe(4);

    // Once, not once per entry: a shutdown that abandons a full queue would otherwise
    // fire the callback `maxQueueSize` times on the way out of the process.
    const closeFailures = failures.filter((entry) => entry.kind === 'close');

    expect(closeFailures).toHaveLength(1);
    expect(closeFailures[0]?.disposition).toBe('lost');
    expect(closeFailures[0]?.error.message).toContain('4 entries still queued');

    // `'close'` rather than `'write'`, so a connection being torn down is not also
    // reported as unhealthy.
    expect(sink.getHealth().consecutiveFailures).toBe(0);
  }, 15000);

  test('close() reports nothing when the queue is empty', async () => {
    const pipePath = `${tmpDir.path}/close-clean.pipe`;
    await createNamedPipe(pipePath);

    const readerFd = fs.openSync(
      pipePath,
      fs.constants.O_RDONLY | fs.constants.O_NONBLOCK,
    );
    const failures: SinkFailure[] = [];
    const sink = new NamedPipeSink({
      pipePath,
      closeTimeoutMS: 2000,
      onError: (failure) => {
        failures.push(failure);
      },
    });

    try {
      expect(await waitForOpenPipe(sink)).toBe(true);

      sink.write({
        timestamp: Date.now(),
        type: 'info',
        template: 'delivered',
        message: 'delivered',
      });

      await new Promise((resolve) => setTimeout(resolve, 100));
      await sink.close();

      expect(sink.getHealth().droppedEntries).toBe(0);
      expect(failures.filter((entry) => entry.kind === 'close')).toEqual([]);
    } finally {
      fs.closeSync(readerFd);
    }
  }, 15000);
});
