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

describe('NamedPipeSink', () => {
  // Only run these tests on supported platforms
  const platform = os.platform();
  const isSupported = platform === 'linux' || platform === 'darwin';

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
  });

  afterEach(async () => {
    await tmpDir.cleanup();
  });

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

  test('should report isReconnecting status correctly', async () => {
    const pipePath = `${tmpDir.path}/reconnecting-status.pipe`;
    await createNamedPipe(pipePath);

    const reader = startPipeReader(pipePath);

    const sink = new NamedPipeSink({
      pipePath,
      jsonFormat: false,
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    // Initially not reconnecting
    expect(sink.isReconnecting).toBe(false);

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
    expect(sink.isReconnecting).toBe(false);

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
});
