import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { promises as fsPromises } from 'fs';
import * as fs from 'fs';
import * as os from 'os';
import { exec, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import type { Writable } from 'node:stream';
import { NamedPipeSink } from './named-pipe';
import type { SinkFailure, SinkFailureKind } from './internal/sink-failure';
import { LogLevel } from '../types';
import type { LogEntry } from '../types';
import { TmpDir } from '../../tmp-dir';

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

// A reader's data arrives whenever the FIFO delivers it, which under a full suite run can
// be well after any fixed delay. Waited for by content rather than by clock: the assertion
// wants the line, not a moment.
async function waitForReaderData(
  reader: { data: string[] },
  predicate: (text: string) => boolean,
  timeoutMS = 5000,
): Promise<string> {
  const deadline = Date.now() + timeoutMS;

  while (Date.now() < deadline) {
    const text = reader.data.join('');

    if (predicate(text)) {
      return text;
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  return reader.data.join('');
}

describe('NamedPipeSink', () => {
  test.each([1, 3])(
    'retries failed FIFO writes in order with maxRetries=%d',
    async (maxRetries) => {
      const pipePath = `${tmpDir.path}/retry-order.pipe`;
      await createNamedPipe(pipePath);
      let reader = fs.openSync(
        pipePath,
        fs.constants.O_RDONLY | fs.constants.O_NONBLOCK,
      );
      const failures: SinkFailure[] = [];
      const sink = new NamedPipeSink({
        pipePath,
        maxRetries,
        formatter: (entry) => entry.message,
        onError: (failure) => {
          failures.push(failure);
        },
      });
      try {
        expect(await waitForOpenPipe(sink)).toBe(true);
        fs.closeSync(reader);
        reader = -1;
        for (const message of ['A', 'B', 'C']) {
          sink.write({
            timestamp: Date.now(),
            type: 'info',
            template: message,
            message,
          });
        }
        for (let i = 0; i < 100 && failures.length < 3; i++) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        reader = fs.openSync(
          pipePath,
          fs.constants.O_RDONLY | fs.constants.O_NONBLOCK,
        );
        await sink.reconnect();
        const buffer = Buffer.alloc(100);
        let received = '';
        for (let i = 0; i < 100 && received.length < 6; i++) {
          try {
            const length = fs.readSync(reader, buffer, 0, buffer.length, null);
            received += buffer.toString('utf8', 0, length);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EAGAIN') {
              throw error;
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(received).toBe('A\nB\nC\n');
        expect(sink.getHealth().droppedEntries).toBe(0);
      } finally {
        await sink.close();
        if (reader >= 0) {
          fs.closeSync(reader);
        }
      }
    },
  );
  test('a complete syscall remains successful when destroyed before its callback', async () => {
    const pipePath = `${tmpDir.path}/complete-destroy.pipe`;
    await createNamedPipe(pipePath);
    const reader = fs.openSync(
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
    let writeSpy: { mockRestore(): void } | undefined;
    try {
      expect(await waitForOpenPipe(sink)).toBe(true);
      const stream = (
        sink as unknown as { pipeStream: Writable & { fd: number } }
      ).pipeStream;
      const write = fs.write;
      writeSpy = spyOn(fs, 'write').mockImplementation(((
        fd: number,
        buffer: Buffer,
        offset: number,
        length: number,
        position: null,
        callback: (
          error: NodeJS.ErrnoException | null,
          written: number,
          buffer: Buffer,
        ) => void,
      ) => {
        return write(
          fd,
          buffer,
          offset,
          length,
          position,
          (error, written, result) => {
            if (fd === stream.fd) {
              stream.destroy();
            }
            callback(error, written, result);
          },
        );
      }) as typeof fs.write);
      sink.write({
        timestamp: Date.now(),
        type: 'info',
        template: 'complete',
        message: 'complete',
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(
        failures.filter((failure) => failure.disposition === 'lost'),
      ).toEqual([]);
      expect(sink.getHealth().droppedEntries).toBe(0);
      const received = Buffer.alloc(4096);
      const length = fs.readSync(reader, received, 0, received.length, null);
      expect(received.subarray(0, length).toString()).toContain('complete');
    } finally {
      writeSpy?.mockRestore();
      await sink.close();
      fs.closeSync(reader);
    }
  });

  test('a partial low-level write is reported lost without replaying the original record', async () => {
    const pipePath = `${tmpDir.path}/partial-write.pipe`;
    await createNamedPipe(pipePath);
    const reader = fs.openSync(
      pipePath,
      fs.constants.O_RDONLY | fs.constants.O_NONBLOCK,
    );
    const failures: SinkFailure[] = [];
    const sink = new NamedPipeSink({
      pipePath,
      maxRetries: 3,
      closeTimeoutMS: 100,
      onError: (failure) => {
        failures.push(failure);
      },
    });
    let writeSpy: { mockRestore(): void } | undefined;
    let drainSpy: { mockRestore(): void } | undefined;
    try {
      expect(await waitForOpenPipe(sink)).toBe(true);
      const internals = sink as unknown as {
        pipeStream: { fd: number };
        processQueue: () => void;
        writeQueue: Array<{ entry: LogEntry }>;
      };
      const descriptor = internals.pipeStream.fd;
      const write = fs.write;
      let calls = 0;
      writeSpy = spyOn(fs, 'write').mockImplementation(((
        fd: number,
        buffer: Buffer,
        offset: number,
        length: number,
        position: null,
        callback: (
          error: NodeJS.ErrnoException | null,
          written: number,
          buffer: Buffer,
        ) => void,
      ) => {
        if (fd !== descriptor) {
          return write(fd, buffer, offset, length, position, callback);
        }
        calls++;
        if (calls === 1) {
          return write(fd, buffer, offset, 8, position, callback);
        }
        queueMicrotask(() =>
          callback(
            Object.assign(new Error('broken pipe'), { code: 'EPIPE' }),
            0,
            buffer,
          ),
        );
      }) as typeof fs.write);
      sink.write({
        timestamp: Date.now(),
        type: 'info',
        template: 'partial-record',
        message: 'partial-record',
      });
      sink.write({
        timestamp: Date.now(),
        type: 'info',
        template: 'buffered-record',
        message: 'buffered-record',
      });
      drainSpy = spyOn(internals, 'processQueue').mockImplementation(() => {});
      await new Promise((resolve) => setTimeout(resolve, 30));
      const partial = failures.find(
        (failure) => failure.entry?.message === 'partial-record',
      );
      expect(partial?.disposition).toBe('lost');
      expect(
        (partial?.error as Error & { bytesWritten: number }).bytesWritten,
      ).toBe(8);
      expect(sink.getHealth().droppedEntries).toBe(1);
      expect(
        internals.writeQueue.some(
          (queued) => queued.entry.message === 'partial-record',
        ),
      ).toBe(false);
      expect(
        failures.find((failure) => failure.entry?.message === 'buffered-record')
          ?.disposition,
      ).toBe('retrying');
      const received = Buffer.alloc(100);
      expect(fs.readSync(reader, received, 0, received.length, null)).toBe(8);
    } finally {
      writeSpy?.mockRestore();
      drainSpy?.mockRestore();
      await sink.close();
      fs.closeSync(reader);
    }
  });

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

  test('destroy waits for an outstanding fs.write before closing its descriptor', async () => {
    const pipePath = `${tmpDir.path}/in-flight-destroy.pipe`;
    await createNamedPipe(pipePath);
    const reader = fs.openSync(
      pipePath,
      fs.constants.O_RDONLY | fs.constants.O_NONBLOCK,
    );
    const sink = new NamedPipeSink({
      pipePath,
      closeTimeoutMS: 100,
      onError: () => {},
    });
    let writeSpy: { mockRestore(): void } | undefined;
    try {
      expect(await waitForOpenPipe(sink)).toBe(true);
      const stream = (
        sink as unknown as {
          pipeStream: Writable & { fd: number };
        }
      ).pipeStream;
      const write = fs.write;
      let complete: (() => void) | undefined;
      writeSpy = spyOn(fs, 'write').mockImplementation(((
        fd: number,
        buffer: Buffer,
        offset: number,
        length: number,
        position: null,
        callback: (
          error: NodeJS.ErrnoException | null,
          written: number,
          buffer: Buffer,
        ) => void,
      ) => {
        if (fd !== stream.fd) {
          return write(fd, buffer, offset, length, position, callback);
        }
        complete = () => callback(null, length, buffer);
      }) as typeof fs.write);
      stream.write(Buffer.from('pending'), () => {});
      expect(complete).toBeDefined();
      stream.destroy();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(() => fs.fstatSync(stream.fd)).not.toThrow();
      const closed = new Promise<void>((resolve) =>
        stream.once('close', resolve),
      );
      complete?.();
      await closed;
      expect(() => fs.fstatSync(stream.fd)).toThrow();
    } finally {
      writeSpy?.mockRestore();
      await sink.close();
      fs.closeSync(reader);
    }
  });

  test('Node stays alive until a backpressured close reports buffered loss', async () => {
    const pipePath = `${tmpDir.path}/node-close.pipe`;
    await createNamedPipe(pipePath);
    const reader = fs.openSync(
      pipePath,
      fs.constants.O_RDONLY | fs.constants.O_NONBLOCK,
    );
    const scriptPath = `${tmpDir.path}/node-close.ts`;
    const modulePath = fileURLToPath(
      new URL('./named-pipe.ts', import.meta.url),
    );
    await fsPromises.writeFile(
      scriptPath,
      `
      import { NamedPipeSink } from ${JSON.stringify(modulePath)};
      const sink = new NamedPipeSink({ pipePath: ${JSON.stringify(pipePath)}, closeTimeoutMS: 100, format: entry => entry.message, onError: failure => console.log('loss', failure.disposition) });
      while (!sink.getHealth().isInitialized) await new Promise(resolve => setTimeout(resolve, 10));
      sink.write({ timestamp: Date.now(), type: 'info', template: 'large', message: 'x'.repeat(2_000_000) });
      await sink.close();
      console.log('closed');
    `,
    );
    const built = await Bun.build({
      entrypoints: [scriptPath],
      target: 'node',
      format: 'esm',
    });
    expect(built.success).toBe(true);
    const executable = `${tmpDir.path}/node-close.mjs`;
    await fsPromises.writeFile(executable, await built.outputs[0].text());
    try {
      const child = spawn('node', [executable], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
      });
      const watchdog = setTimeout(() => child.kill('SIGKILL'), 5000);
      const code = await new Promise<number | null>((resolve, reject) => {
        child.on('error', reject);
        child.on('close', resolve);
      }).finally(() => clearTimeout(watchdog));
      expect(stderr).toBe('');
      expect(code).toBe(0);
      expect(stdout).toContain('loss lost');
      expect(stdout).toContain('closed');
    } finally {
      fs.closeSync(reader);
    }
  }, 10000);

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

    // Waited for the line rather than a fixed delay; see `waitForReaderData`.
    const allData = await waitForReaderData(reader, (text) =>
      text.includes(testMessage),
    );
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

    const allData = await waitForReaderData(reader, (text) =>
      text.trimEnd().endsWith('}'),
    );
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

    const allData = await waitForReaderData(reader, (text) =>
      text.includes('CUSTOM: INFO - Custom formatted log'),
    );
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

  test('hands the non-blocking probe descriptor to the stream without reopening the path', async () => {
    // Reopening by pathname was both a path-swap opportunity and a blocking FIFO open
    // that could pin the process after close. The stream must use the descriptor which
    // already passed the non-blocking probe and descriptor-level FIFO check.
    const pipePath = `${tmpDir.path}/descriptor-handoff.pipe`;
    await createNamedPipe(pipePath);

    const reader = startPipeReader(pipePath);
    const sink = new NamedPipeSink({ pipePath });

    try {
      expect(await waitForOpenPipe(sink)).toBe(true);

      // No pathname-backed pending open exists: the descriptor returned by the probe is
      // already installed as the active stream.
      expect(
        (sink as unknown as { pendingStream?: fs.WriteStream }).pendingStream,
      ).toBeUndefined();

      sink.write({
        timestamp: Date.now(),
        type: 'info',
        template: 'through the original descriptor',
        message: 'through the original descriptor',
      });

      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(reader.data.join('')).toContain('through the original descriptor');
    } finally {
      await sink.close();
      reader.stop();
    }
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

    // Waited for both lines rather than a fixed delay: under a full suite run the
    // reader was still empty after 200 ms and the assertion failed on entries that
    // arrived a moment later.
    const allData = await waitForReaderData(
      reader,
      (text) =>
        text.includes('Queued entry 1') && text.includes('Queued entry 2'),
    );
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

    // Waited for the line itself rather than a fixed delay: under a full suite run the
    // reader was still empty after 200 ms and the assertion failed on an entry that
    // arrived a moment later.
    const allData = await waitForReaderData(reader, (text) =>
      text.includes('"foo":"bar"'),
    );

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

    // Waited for the last entry rather than a fixed delay; the sink writes in order.
    const allData = await waitForReaderData(reader, (text) =>
      text.includes(`Entry ${numEntries - 1}`),
    );

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

  test('reports an unsupported platform once rather than once per attempt', async () => {
    // Every other open failure goes through `reportOpenFailure`, which says a thing once
    // per outage. This one called `handleError` directly and marked nothing, so each
    // `write()` re-entered `openPipe` once `REOPEN_COOLDOWN_MS` had elapsed and a process
    // logging once a second called `onError` once a second, forever - on the one failure
    // that is certain never to clear.
    const pipePath = `${tmpDir.path}/unsupported-platform.pipe`;
    await createNamedPipe(pipePath);

    const platformSpy = spyOn(os, 'platform').mockReturnValue('win32');

    const failures: SinkFailure[] = [];

    try {
      const sink = new NamedPipeSink({
        pipePath,
        jsonFormat: false,
        onError: (failure) => {
          failures.push(failure);
        },
      });

      const privateSink = sink as unknown as { openPipe: () => Promise<void> };

      for (let attempt = 0; attempt < 5; attempt++) {
        await privateSink.openPipe();
      }

      await sink.close();
    } finally {
      platformSpy.mockRestore();
    }

    const platformFailures = failures.filter(
      (failure) => failure.kind === 'unsupported_platform',
    );

    expect(platformFailures).toHaveLength(1);
  });

  test('reconnect() waits for an open already in flight rather than racing it', async () => {
    // `reconnect()` guarded on `closed`, `closing` and `_isReconnecting`, none of which the
    // constructor's `initializePipe()` sets - only `isOpening` does. A `reconnect()` issued
    // while the constructor's open was still pending therefore ran a second `openPipe`
    // against the same FIFO: two probes, two `createWriteStream` opens, one `pendingStream`
    // assignment silently orphaned, and `MAX_ABANDONED_OPENS` reached twice as fast.
    const pipePath = `${tmpDir.path}/reconnect-races-open.pipe`;
    await createNamedPipe(pipePath);

    let concurrentOpens = 0;
    let maxConcurrentOpens = 0;
    let releaseOpen: () => void = () => undefined;

    const openGate = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });

    const prototype = NamedPipeSink.prototype as unknown as Record<
      string,
      unknown
    >;
    const realOpenPipe = prototype.openPipe;

    prototype.openPipe = async function stalledOpenPipe(): Promise<void> {
      concurrentOpens++;
      maxConcurrentOpens = Math.max(maxConcurrentOpens, concurrentOpens);

      try {
        await openGate;
      } finally {
        concurrentOpens--;
      }
    };

    try {
      const sink = new NamedPipeSink({ pipePath, jsonFormat: false });

      // Issued while the constructor's open is still parked on the gate, which is the
      // window the guard covers.
      const reconnecting = sink.reconnect();

      await new Promise((resolve) => setTimeout(resolve, 50));

      releaseOpen();

      await reconnecting;

      expect(maxConcurrentOpens).toBe(1);

      await sink.close();
    } finally {
      prototype.openPipe = realOpenPipe;
    }
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

  test('an unusable closeTimeoutMS takes the default and Infinity is bounded', async () => {
    // The same resolution `FileSink` applies, so the two sinks read the option alike:
    // `NaN` hung the drain loop for good and `Infinity` fired the init deadline at once.
    const pipePath = `${tmpDir.path}/timeout-option.pipe`;
    await createNamedPipe(pipePath);

    const reader = startPipeReader(pipePath);

    const read = (sink: NamedPipeSink): number =>
      (sink as unknown as { closeTimeoutMS: number }).closeTimeoutMS;

    const nan = new NamedPipeSink({ pipePath, closeTimeoutMS: Number.NaN });
    const negative = new NamedPipeSink({ pipePath, closeTimeoutMS: -5 });
    const infinite = new NamedPipeSink({
      pipePath,
      closeTimeoutMS: Number.POSITIVE_INFINITY,
    });

    expect(read(nan)).toBe(30_000);
    expect(read(negative)).toBe(30_000);
    expect(read(infinite)).toBe(2_147_483_647);

    await Promise.all([nan.close(), negative.close(), infinite.close()]);
    reader.stop();
  });

  test('getHealth() reports unhealthy for the whole of a close', async () => {
    // `close()` cleared `isInitialized` only once its drain had finished, so for that
    // whole window a sink refusing every new `write()` at the `closing` guard still
    // answered healthy to anything polling it. The same answer `FileSink` gives.
    const pipePath = `${tmpDir.path}/health-while-closing.pipe`;
    await createNamedPipe(pipePath);

    const reader = startPipeReader(pipePath);
    const sink = new NamedPipeSink({ pipePath, jsonFormat: false });

    expect(await waitForOpenPipe(sink)).toBe(true);
    expect(sink.getHealth().isHealthy).toBe(true);

    const closing = sink.close();

    expect(sink.getHealth().isHealthy).toBe(false);

    await closing;

    expect(sink.getHealth().isHealthy).toBe(false);
    reader.stop();
  });

  test('a successful reconnect() clears the failures it replaced', async () => {
    // `consecutiveFailures` was cleared only by a successful *write*, so a `reconnect()`
    // that opened a fresh pipe over an already-drained queue returned `{ success: true }`
    // while `getHealth()` went on answering `isHealthy: false` - until traffic happened to
    // arrive, which in a quiet process is never. A supervisor polling health answers that
    // by restarting a sink that is working.
    const pipePath = `${tmpDir.path}/reconnect-health.pipe`;
    await createNamedPipe(pipePath);

    let reader = startPipeReader(pipePath);

    const sink = new NamedPipeSink({
      pipePath,
      jsonFormat: false,
      onError: () => {
        // The failure under test is recorded directly; nothing here needs to act on it.
      },
    });

    expect(await waitForOpenPipe(sink)).toBe(true);

    // The state an `EPIPE` leaves behind: failures counted against a stream that is gone.
    const privateSink = sink as unknown as {
      consecutiveFailures: number;
      pipeStream?: { destroy: () => void };
      isInitialized: boolean;
    };

    privateSink.consecutiveFailures = 2;
    privateSink.pipeStream?.destroy();
    privateSink.pipeStream = undefined;
    privateSink.isInitialized = false;

    expect(sink.getHealth().isHealthy).toBe(false);

    // A FIFO reader sees end of input when the writer goes, so the reader is restarted
    // around the reconnect exactly as the reconnection tests above do.
    reader.stop();
    await new Promise((resolve) => setTimeout(resolve, 100));

    reader = startPipeReader(pipePath);
    await new Promise((resolve) => setTimeout(resolve, 100));

    const status = await sink.reconnect();

    expect(status.success).toBe(true);
    expect(sink.getHealth().consecutiveFailures).toBe(0);
    expect(sink.getHealth().isHealthy).toBe(true);

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

    // Queued while the pipe is still opening. The shared-subtree gap: a message the
    // envelope refuses fails the render at `write` time, and the caller can then mutate
    // the shared bag during the outage - which is what would let a second render succeed
    // and serialize the token added to it.
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

    expect(await waitForOpenPipe(sink)).toBe(true);

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

    expect(await waitForOpenPipe(sink)).toBe(true);

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

    expect(health.lastError?.message).toBe(
      'NamedPipeSink formatter failed; the default format was used',
    );
    expect((health.lastError?.cause as Error | undefined)?.message).toBe(
      'formatter blew up',
    );
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
    const pipePath = `${tmpDir.path}/async-fail.pipe`;
    await createNamedPipe(pipePath);
    const reader = startPipeReader(pipePath);
    const sink = new NamedPipeSink({ pipePath, onError: () => {} });
    let live: fs.WriteStream | undefined;
    try {
      expect(await waitForOpenPipe(sink)).toBe(true);
      live = (sink as unknown as { pipeStream: fs.WriteStream }).pipeStream;
      const failedStream = live;
      let writes = 0;
      // A failed write is followed by an error event. It must not be retried in
      // the gap before that event invalidates the connection.
      (
        live as unknown as {
          write: (chunk: string, callback: (error: Error) => void) => boolean;
        }
      ).write = (_chunk, callback) => {
        writes++;
        setTimeout(() => {
          const error = new Error('EPIPE');
          callback(error);
          failedStream.emit('error', error);
        }, 0);
        return true;
      };
      sink.write({
        timestamp: Date.now(),
        type: 'info',
        template: 'retried',
        message: 'retried',
      });
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(writes).toBe(1);
      expect(await waitForOpenPipe(sink, 5000)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(reader.data.join('')).toContain('retried');
      expect(sink.getHealth().queueSize).toBe(0);
      expect(sink.getHealth().droppedEntries).toBe(0);
    } finally {
      await sink.close();
      live?.destroy();
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
          entry: LogEntry;
          attempts: number;
        }) => void;
      };

      // Exactly what a late callback from a replaced stream does: the sink is connected,
      // and an entry it had already taken off the queue comes back.
      privateSink.requeue({
        formatted: 'late-callback-from-a-replaced-stream\n',
        formatError: undefined,
        entry: {
          timestamp: Date.now(),
          type: 'info',
          template: 'late',
          message: 'late',
        },
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
  test('a line that could not be rendered is counted, not just reported', async () => {
    // `disposition: 'lost'` and a `droppedEntries` that never moved disagreed about the
    // same entry: three unrenderable lines reported three `format`/`lost` failures while
    // `getHealth()` still answered `droppedEntries: 0` and `isHealthy: true`, so an
    // operator polling health saw a sink in perfect condition that had delivered nothing.
    const pipePath = `${tmpDir.path}/format-lost-counted.pipe`;
    await createNamedPipe(pipePath);

    const reader = startPipeReader(pipePath);
    const failures: SinkFailure[] = [];
    const sink = new NamedPipeSink({
      pipePath,
      jsonFormat: true,
      onError: (failure) => {
        failures.push(failure);
      },
    });

    try {
      expect(await waitForOpenPipe(sink)).toBe(true);

      for (let index = 0; index < 3; index++) {
        sink.write({
          timestamp: Date.now(),
          type: 'info',
          template: 'unrenderable',
          // The envelope refuses this message, so the default format throws too and
          // there is no fallback left to produce a line.
          message: UNRENDERABLE_MESSAGE,
        });
      }

      await new Promise((resolve) => setTimeout(resolve, 150));

      const lostFormats = failures.filter(
        (entry) => entry.kind === 'format' && entry.disposition === 'lost',
      );

      expect(lostFormats).toHaveLength(3);
      expect(lostFormats[0]?.error.message).toBe(
        'Failed to format a log entry; no line was written',
      );
      expect(lostFormats[0]?.error.message).not.toContain(
        'message refused to serialize',
      );
      expect((lostFormats[0]?.error.cause as Error | undefined)?.message).toBe(
        'message refused to serialize',
      );
      expect(sink.getHealth().droppedEntries).toBe(3);
    } finally {
      await sink.close();
      reader.stop();
    }
  }, 15000);

  test('a line that could not be rendered is reported even with no reader attached', async () => {
    // The render failure used to be checked *after* the stream check, so an unrenderable
    // entry logged while the pipe had no reader was requeued instead of reported - and
    // once its retries ran out `requeue` dropped it on `droppedEntries` with no `onError`
    // call at all. A caller whose formatter throws during an outage got a silent loss for
    // the one failure this sink documents as never retried and always reported.
    const pipePath = `${tmpDir.path}/format-lost-no-reader.pipe`;
    await createNamedPipe(pipePath);

    const failures: SinkFailure[] = [];
    // No reader, so the open never completes and there is no stream to write to.
    const sink = new NamedPipeSink({
      pipePath,
      jsonFormat: true,
      onError: (failure) => {
        failures.push(failure);
      },
    });

    try {
      sink.write({
        timestamp: Date.now(),
        type: 'info',
        template: 'unrenderable',
        // The envelope refuses this message, so the default format throws too and there
        // is no fallback left to produce a line.
        message: UNRENDERABLE_MESSAGE,
      });

      await new Promise((resolve) => setTimeout(resolve, 150));

      const lostFormats = failures.filter(
        (entry) => entry.kind === 'format' && entry.disposition === 'lost',
      );

      expect(lostFormats).toHaveLength(1);
      expect(sink.getHealth().droppedEntries).toBe(1);
      expect(sink.getHealth().queueSize).toBe(0);
    } finally {
      await sink.close();
    }
  }, 15000);

  test('a closed sink does not report itself healthy, and refuses to reconnect', async () => {
    // `isHealthy` is `consecutiveFailures === 0 && isInitialized`, and `close()` left
    // `isInitialized` set - so a sink with no stream, discarding everything written to it,
    // answered a polling supervisor exactly as a working one does.
    //
    // And `reconnect()` was the one public entry point without the closed guard the rest
    // carry. After `close()` it re-opened the FIFO, and on this sink's ordinary failure
    // that open never completes: `close()` had already run its `pendingStream` cleanup, so
    // the fresh descriptor and the libuv threadpool slot behind it were held for the life
    // of the process, for a sink nothing can write to again.
    const pipePath = `${tmpDir.path}/closed-not-healthy.pipe`;
    await createNamedPipe(pipePath);

    const reader = startPipeReader(pipePath);
    const sink = new NamedPipeSink({ pipePath });

    try {
      expect(await waitForOpenPipe(sink)).toBe(true);
      expect(sink.getHealth().isHealthy).toBe(true);

      await sink.close();

      const health = sink.getHealth();

      expect(health.isHealthy).toBe(false);
      expect(health.isInitialized).toBe(false);

      const status = await sink.reconnect();

      expect(status).toEqual({ success: false, reason: 'closed' });
      expect(sink.getHealth().isInitialized).toBe(false);
    } finally {
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
  test('reports the entry it drops when the stream went away and the retries ran out', async () => {
    // The window `drainQueue` cannot close: it checks the stream, shifts an entry, and the
    // stream can be gone by the time `writeEntry` looks again. That path requeues with no
    // report of its own, so at the retry cap `requeue` counted a `droppedEntries` and said
    // nothing - a silent loss for an `onError` consumer whose job is to write a fallback
    // copy on `disposition: 'lost'`, since only `getHealth()` ever moved.
    const pipePath = `${tmpDir.path}/dropped-no-stream.pipe`;
    await createNamedPipe(pipePath);

    const reader = startPipeReader(pipePath);
    const failures: SinkFailure[] = [];
    const sink = new NamedPipeSink({
      pipePath,
      // No retries, so the first failed attempt is also the last one.
      maxRetries: 0,
      onError: (failure) => {
        failures.push(failure);
      },
    });

    try {
      expect(await waitForOpenPipe(sink)).toBe(true);

      (sink as unknown as { ensureConnection: () => void }).ensureConnection =
        () => {
          // Recovery is not what this test is about; the entry has already run out of
          // attempts by the time this would be reached.
        };

      const live = (sink as unknown as { pipeStream: fs.WriteStream })
        .pipeStream;

      live.destroy();

      // Driven straight at `writeEntry`, because that is the whole race: `drainQueue`
      // would refuse to shift while the stream is destroyed, and the entry only reaches
      // this branch when the stream dies *after* that check.
      (
        sink as unknown as {
          writeEntry: (queued: { formatted: string; attempts: number }) => void;
        }
      ).writeEntry({ formatted: 'orphan\n', attempts: 0 });

      expect(sink.getHealth().droppedEntries).toBe(1);
      expect(failures).toHaveLength(1);
      expect(failures[0]?.kind).toBe('write');
      // `'lost'`, which is the one disposition that means write this line somewhere else.
      expect(failures[0]?.disposition).toBe('lost');
      expect(failures[0]?.attempt).toBe(1);
      // The stream this could not be written to is already gone, so it says nothing about
      // the health of whatever replaces it.
      expect(sink.getHealth().consecutiveFailures).toBe(0);
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
      // The oldest line the cap evicted, as `FileSink` reports it: a dropped entry,
      // never one still queued, so a handler that re-emits on `'lost'` does not
      // duplicate a line the pipe will still get.
      expect(queueFull[0]?.entry?.message).toBe('under-cap-0');
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

    // No reader for the whole close either, so it gives up on `closeTimeoutMS` with nothing
    // to flush into - which is the shutdown this test is about. A reader attached *during*
    // the close would not reproduce it: the write side then opens while `closing` is set,
    // the drain loop promotes it and writes all four, which is the behaviour
    // `'writes an entry queued before the pipe finishes opening'` covers.
    await sink.close();

    // Opened only now, to release the `open` still blocked in libuv's threadpool: walking
    // away from it would take one of four threads with it and stall every later test. With
    // `closed` set, the stream it completes is destroyed unused.
    const readerFd = fs.openSync(
      pipePath,
      fs.constants.O_RDONLY | fs.constants.O_NONBLOCK,
    );

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

  test('a write that fails inside the close drain is still counted', async () => {
    // `close()` sets `closing` before running its drain loop, and `requeue` returned early
    // on that flag - so an entry the drain had already shifted off the queue, whose write
    // then failed, was dropped on the floor: not put back, not counted in
    // `droppedEntries`, and `abandonQueueOnClose()` afterwards saw an empty queue and
    // reported nothing. `getHealth().droppedEntries` means "lines this sink did not
    // deliver", and this was the one shutdown failure it did not know about.
    const pipePath = `${tmpDir.path}/close-drain-failure.pipe`;
    await createNamedPipe(pipePath);

    const readerFd = fs.openSync(
      pipePath,
      fs.constants.O_RDONLY | fs.constants.O_NONBLOCK,
    );
    const failures: SinkFailure[] = [];
    const sink = new NamedPipeSink({
      pipePath,
      closeTimeoutMS: 1000,
      // One attempt each, so the first failure inside the drain is the last one.
      maxRetries: 0,
      onError: (failure) => {
        failures.push(failure);
      },
    });

    try {
      expect(await waitForOpenPipe(sink)).toBe(true);

      const internals = sink as unknown as {
        writeQueue: { formatted: string; attempts: number }[];
        pipeStream?: { write: (...args: unknown[]) => boolean };
      };

      // Parked directly, because this is about the drain loop's own writes: entries handed
      // to `write()` while the pipe is healthy go straight out.
      for (let index = 0; index < 3; index++) {
        internals.writeQueue.push({
          formatted: `drain-${String(index)}\n`,
          attempts: 0,
        });
      }

      // The reader going away mid-shutdown, which is exactly when this happens for real.
      const stream = internals.pipeStream;

      expect(stream).toBeDefined();

      if (stream) {
        stream.write = (): boolean => {
          throw new Error('reader vanished');
        };
      }

      await sink.close();

      expect(sink.getHealth().queueSize).toBe(0);
      expect(sink.getHealth().droppedEntries).toBe(3);
      expect(
        failures.filter((entry) => entry.kind === 'write'),
      ).not.toHaveLength(0);
    } finally {
      fs.closeSync(readerFd);
    }
  }, 15000);

  test('a failure tied to a line hands onError the LogEntry, as FileSink does', async () => {
    // This sink used to drop the `LogEntry` once rendered, so every report arrived with
    // `entry` absent and a handler that falls back on `'lost'` could re-emit a FileSink
    // line but not a pipe line. Kept now, under the same `maxQueueSize` bound FileSink
    // holds its entries under.
    const pipePath = `${tmpDir.path}/entry-on-failure.pipe`;
    await createNamedPipe(pipePath);

    const readerFd = fs.openSync(
      pipePath,
      fs.constants.O_RDONLY | fs.constants.O_NONBLOCK,
    );
    const failures: SinkFailure[] = [];
    const sink = new NamedPipeSink({
      pipePath,
      maxRetries: 0,
      closeTimeoutMS: 1000,
      onError: (failure) => {
        failures.push(failure);
      },
    });

    try {
      expect(await waitForOpenPipe(sink)).toBe(true);

      // Reader gone: the write fails, and with no retries left it is lost.
      fs.closeSync(readerFd);

      sink.write({
        timestamp: Date.now(),
        type: 'info',
        template: 'orphaned {id}',
        message: 'orphaned 7',
        params: { id: 7 },
        redactedParams: { id: 7 },
      });

      await new Promise((resolve) => setTimeout(resolve, 200));

      const writeFailures = failures.filter((entry) => entry.kind === 'write');

      expect(writeFailures.length).toBeGreaterThan(0);
      expect(writeFailures[0]?.entry?.message).toBe('orphaned 7');
      expect(writeFailures[0]?.entry?.redactedParams).toEqual({ id: 7 });

      // A formatter that throws is reported as `'fallback'` with the entry the default
      // format then rendered in its place.
      const throwing = new NamedPipeSink({
        pipePath,
        formatter: () => {
          throw new Error('formatter refused');
        },
        onError: (failure) => {
          failures.push(failure);
        },
      });

      try {
        throwing.write({
          timestamp: Date.now(),
          type: 'info',
          template: 'unrenderable',
          message: 'unrenderable',
        });

        await new Promise((resolve) => setTimeout(resolve, 100));

        const formatFailures = failures.filter(
          (entry) => entry.kind === 'format',
        );

        expect(formatFailures.length).toBeGreaterThan(0);
        expect(formatFailures[0]?.disposition).toBe('fallback');
        expect(formatFailures[0]?.entry?.message).toBe('unrenderable');
      } finally {
        await throwing.close();
      }
    } finally {
      await sink.close();
    }
  }, 15000);

  test('a pending open past STALE_OPEN_MS is abandoned and reported, and the cap is said once', async () => {
    // The race this covers - a reader that hangs up between the probe and the open, then
    // recreates the FIFO so the blocked open points at an unlinked inode - cannot be
    // produced on demand. The path itself can: it reads only `pendingStream` and when it
    // was started. A stand-in stream rather than a real blocked `open(2)`, which would
    // hold a threadpool slot for the rest of the run.
    const pipePath = `${tmpDir.path}/stale-open.pipe`;
    await createNamedPipe(pipePath);

    const failures: SinkFailure[] = [];
    // No reader, so the constructor's probe finds nobody and starts no open of its own.
    const sink = new NamedPipeSink({
      pipePath,
      onError: (failure) => {
        failures.push(failure);
      },
    });

    const internals = sink as unknown as {
      pendingStream: unknown;
      pendingStreamSince: number | undefined;
      abandonedOpens: number;
      releaseStalePendingOpen: () => void;
    };

    const closeHandlers: Array<() => void> = [];
    let destroyed = 0;

    const installStuckOpen = (ageMS: number): void => {
      internals.pendingStream = {
        once: (event: string, handler: () => void) => {
          if (event === 'close') {
            closeHandlers.push(handler);
          }
        },
        destroy: () => {
          destroyed++;
        },
      };
      internals.pendingStreamSince = Date.now() - ageMS;
    };

    const staleReports = (): SinkFailure[] =>
      failures.filter((f) =>
        f.error.message.includes('did not complete within'),
      );
    const capReports = (): SinkFailure[] =>
      failures.filter((f) => f.error.message.includes('Gave up reopening'));

    try {
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Not yet stale: left alone.
      installStuckOpen(0);
      internals.releaseStalePendingOpen();

      expect(destroyed).toBe(0);
      expect(staleReports()).toHaveLength(0);

      // Stale: abandoned, counted, reported, and the sink keeps trying.
      internals.pendingStreamSince = Date.now() - 60_000;
      internals.releaseStalePendingOpen();

      expect(destroyed).toBe(1);
      expect(internals.pendingStream).toBeUndefined();
      expect(internals.abandonedOpens).toBe(1);
      expect(staleReports()).toHaveLength(1);
      expect(staleReports()[0]?.kind).toBe('write');
      expect(staleReports()[0]?.disposition).toBe('no_entry');
      expect(capReports()).toHaveLength(0);
      // A stale open is not a write failure and must not mark the sink unhealthy.
      expect(sink.getHealth().consecutiveFailures).toBe(0);

      // A second stale open reaches the cap of two.
      installStuckOpen(60_000);
      internals.releaseStalePendingOpen();

      expect(internals.abandonedOpens).toBe(2);
      expect(staleReports()).toHaveLength(2);

      // At the cap: the third is held, not destroyed, and the cap is reported once even
      // though every later write() would come through here.
      installStuckOpen(60_000);
      internals.releaseStalePendingOpen();
      internals.releaseStalePendingOpen();
      internals.releaseStalePendingOpen();

      expect(destroyed).toBe(2);
      expect(internals.pendingStream).toBeDefined();
      expect(capReports()).toHaveLength(1);
      expect(capReports()[0]?.error.message).toContain(
        '2 opens are still blocked',
      );

      // The kernel releases one: the count drops, the cap re-arms, and the held open is
      // abandoned on the next pass.
      closeHandlers[0]?.();

      expect(internals.abandonedOpens).toBe(1);

      internals.releaseStalePendingOpen();

      expect(destroyed).toBe(3);
      expect(internals.abandonedOpens).toBe(2);
      expect(staleReports()).toHaveLength(3);

      // Back at the cap, it is a new fact and is said again - once.
      installStuckOpen(60_000);
      internals.releaseStalePendingOpen();
      internals.releaseStalePendingOpen();

      expect(capReports()).toHaveLength(2);
    } finally {
      internals.pendingStream = undefined;
      internals.pendingStreamSince = undefined;
      await sink.close();
    }
  }, 15000);

  test('reconnect() with one open abandoned and one pending does not abandon-then-open a third', async () => {
    // The cap was checked before the pending open was abandoned: one abandoned, one
    // pending, the check passed, the pending one was abandoned - two - and a third open
    // started. Counted with the open about to be given up, `reconnect()` refuses and
    // leaves the pending open where it is.
    const pipePath = `${tmpDir.path}/reconnect-cap.pipe`;
    await createNamedPipe(pipePath);

    const failures: SinkFailure[] = [];
    const sink = new NamedPipeSink({
      pipePath,
      onError: (failure) => {
        failures.push(failure);
      },
    });

    const internals = sink as unknown as {
      abandonedOpens: number;
      pendingStream: unknown;
      isOpening: boolean;
    };

    try {
      await new Promise((resolve) => setTimeout(resolve, 100));

      let destroyed = 0;
      const pending = {
        once: () => {},
        destroy: () => {
          destroyed++;
        },
      };

      internals.abandonedOpens = 1;
      internals.pendingStream = pending;

      const status = await sink.reconnect();

      expect(status.success).toBe(false);
      expect(status.success === false && status.reason).toBe('error');
      // Not abandoned, not replaced, nothing new started.
      expect(destroyed).toBe(0);
      expect(internals.pendingStream).toBe(pending);
      expect(internals.abandonedOpens).toBe(1);
      expect(internals.isOpening).toBe(false);
      expect(
        failures.filter((f) => f.error.message.includes('Gave up reopening')),
      ).toHaveLength(1);

      // Under the cap by one with nothing pending, a reconnect is allowed to try.
      internals.pendingStream = undefined;

      const readerFd = fs.openSync(
        pipePath,
        fs.constants.O_RDONLY | fs.constants.O_NONBLOCK,
      );

      try {
        expect((await sink.reconnect()).success).toBe(true);
      } finally {
        fs.closeSync(readerFd);
      }
    } finally {
      internals.pendingStream = undefined;
      await sink.close();
    }
  }, 15000);

  test('at the abandoned-open cap, neither a write nor reconnect() starts another open', async () => {
    // The cap was only read while a stale `pendingStream` existed, and abandoning one
    // clears it - so after two real abandons the next `write()` found nothing pending,
    // passed the in-flight guard, and started a third blocked `open(2)`. `reconnect()`
    // never read the cap at all. Starts from the state the race leaves behind: the cap's
    // worth of opens counted, nothing pending, no stream.
    const pipePath = `${tmpDir.path}/open-cap.pipe`;
    await createNamedPipe(pipePath);

    const failures: SinkFailure[] = [];
    const sink = new NamedPipeSink({
      pipePath,
      onError: (failure) => {
        failures.push(failure);
      },
    });

    const internals = sink as unknown as {
      abandonedOpens: number;
      pendingStream: unknown;
      isOpening: boolean;
      _isReconnecting: boolean;
      lastReopenAttempt: number;
      ensureConnection: () => void;
    };

    const capReports = (): SinkFailure[] =>
      failures.filter((f) => f.error.message.includes('Gave up reopening'));

    // A reader, so an open the sink *does* start would complete at once and be visible
    // as `isInitialized`.
    const readerFd = fs.openSync(
      pipePath,
      fs.constants.O_RDONLY | fs.constants.O_NONBLOCK,
    );

    try {
      expect(await waitForOpenPipe(sink)).toBe(true);

      // Back to "no stream, cap reached", as if two stale opens had just been abandoned.
      await sink.reconnect();
      (sink as unknown as { isInitialized: boolean }).isInitialized = false;
      (sink as unknown as { pipeStream: unknown }).pipeStream = undefined;
      internals.abandonedOpens = 2;
      internals.lastReopenAttempt = 0;

      // A write asks for a connection and is refused one; the cap is said once.
      sink.write({
        timestamp: Date.now(),
        type: 'info',
        template: 'held',
        message: 'held',
      });
      internals.ensureConnection();
      internals.ensureConnection();

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(sink.getHealth().isInitialized).toBe(false);
      expect(internals.isOpening).toBe(false);
      expect(internals._isReconnecting).toBe(false);
      expect(capReports()).toHaveLength(1);
      expect(capReports()[0]?.disposition).toBe('no_entry');
      expect(sink.getHealth().queueSize).toBe(1);

      // `reconnect()` is refused too, and says why.
      const status = await sink.reconnect();

      expect(status.success).toBe(false);
      expect(status.success === false && status.reason).toBe('error');
      expect(
        status.success === false &&
          status.reason === 'error' &&
          status.error.message,
      ).toContain('still blocked');
      expect(sink.getHealth().isInitialized).toBe(false);
      expect(capReports()).toHaveLength(1);

      // One of the blocked opens returns: the sink opens again and drains the line.
      internals.abandonedOpens = 1;
      (
        sink as unknown as { reportedAbandonedOpenCap: boolean }
      ).reportedAbandonedOpenCap = false;

      expect((await sink.reconnect()).success).toBe(true);
      expect(sink.getHealth().isInitialized).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(sink.getHealth().queueSize).toBe(0);
    } finally {
      await sink.close();
      fs.closeSync(readerFd);
    }
  }, 15000);

  test('a blocked open returning at the cap resumes probing without a write()', async () => {
    // At the cap `ensureConnection` returns before it can arm a timer, so the retry chain
    // that keeps every other failure alive dies there. The `'close'` of a blocked open is
    // the only event that says the cap has been left, and it used to do nothing but
    // decrement - so a quiet process whose reader came back sat uninitialized until its
    // next `write()`. The existing cap tests fire `'close'` and then call
    // `releaseStalePendingOpen()` or `reconnect()` by hand, which is exactly the traffic
    // this pins the sink not to need.
    const pipePath = `${tmpDir.path}/cap-close-resume.pipe`;
    await createNamedPipe(pipePath);

    const failures: SinkFailure[] = [];
    // No reader, so the constructor's probe finds nobody and keeps asking once a second.
    const sink = new NamedPipeSink({
      pipePath,
      onError: (failure) => {
        failures.push(failure);
      },
    });

    const internals = sink as unknown as {
      pendingStream: unknown;
      pendingStreamSince: number | undefined;
      abandonedOpens: number;
      reopenTimer: unknown;
      isOpening: boolean;
      _isReconnecting: boolean;
      releaseStalePendingOpen: () => void;
    };

    const closeHandlers: Array<() => void> = [];

    const installStuckOpen = (): void => {
      internals.pendingStream = {
        once: (event: string, handler: () => void) => {
          if (event === 'close') {
            closeHandlers.push(handler);
          }
        },
        destroy: () => {},
      };
      internals.pendingStreamSince = Date.now() - 60_000;
    };

    const capReports = (): SinkFailure[] =>
      failures.filter((f) => f.error.message.includes('Gave up reopening'));

    let readerFd: number | undefined;

    try {
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Two stale opens abandoned through the real path, so the real `'close'` handlers
      // are the ones registered.
      installStuckOpen();
      internals.releaseStalePendingOpen();
      installStuckOpen();
      internals.releaseStalePendingOpen();

      expect(internals.abandonedOpens).toBe(2);
      expect(closeHandlers).toHaveLength(2);

      // The probe's timer fires into the cap and is not re-armed.
      await new Promise((resolve) => setTimeout(resolve, 1300));

      expect(capReports()).toHaveLength(1);
      expect(internals.reopenTimer).toBeUndefined();
      expect(sink.getHealth().isInitialized).toBe(false);

      // A reader arrives. Nothing is written, and nothing notices.
      readerFd = fs.openSync(
        pipePath,
        fs.constants.O_RDONLY | fs.constants.O_NONBLOCK,
      );

      await new Promise((resolve) => setTimeout(resolve, 1300));

      expect(sink.getHealth().isInitialized).toBe(false);
      expect(internals.isOpening).toBe(false);
      expect(internals._isReconnecting).toBe(false);
      expect(internals.reopenTimer).toBeUndefined();

      // The kernel releases one blocked open. That alone has to start the next attempt.
      closeHandlers[0]?.();

      expect(internals.abandonedOpens).toBe(1);
      expect(internals.reopenTimer).toBeDefined();
      expect(await waitForOpenPipe(sink)).toBe(true);
      expect(sink.getHealth().isReconnecting).toBe(false);
      // Recovered, not re-refused: the cap was said once, before, and not again.
      expect(capReports()).toHaveLength(1);

      // The second release finds a sink already open and starts nothing beside it.
      closeHandlers[1]?.();

      expect(internals.abandonedOpens).toBe(0);
      expect(internals.reopenTimer).toBeUndefined();
      expect(internals.isOpening).toBe(false);
    } finally {
      internals.pendingStream = undefined;
      internals.pendingStreamSince = undefined;
      await sink.close();

      if (readerFd !== undefined) {
        fs.closeSync(readerFd);
      }
    }
  }, 15000);

  test('late write callbacks report every lost line without retrying after close', async () => {
    const pipePath = `${tmpDir.path}/late-write-callbacks.pipe`;
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
    const callbacks: Array<(error?: Error | null) => void> = [];
    try {
      expect(await waitForOpenPipe(sink)).toBe(true);
      const stream = (sink as unknown as { pipeStream: fs.WriteStream })
        .pipeStream;
      const writeSpy = spyOn(stream, 'write').mockImplementation(
        (_chunk: unknown, callback: unknown) => {
          callbacks.push(callback as (error?: Error | null) => void);
          return true;
        },
      );
      for (let i = 0; i < 3; i++) {
        sink.write({
          timestamp: Date.now(),
          type: 'info',
          message: `late-${i}`,
          template: `late-${i}`,
        });
      }
      expect(callbacks).toHaveLength(3);
      writeSpy.mockRestore();
      await sink.close();
      for (const callback of callbacks) {
        callback(new Error('late EPIPE'));
      }
      const losses = failures.filter((failure) => failure.entry !== undefined);
      expect(
        losses.map((failure) => [failure.entry?.message, failure.disposition]),
      ).toEqual([
        ['late-0', 'lost'],
        ['late-1', 'lost'],
        ['late-2', 'lost'],
      ]);
      expect(sink.getHealth().droppedEntries).toBe(3);
      expect(sink.getHealth().queueSize).toBe(0);
    } finally {
      await sink.close();
      fs.closeSync(readerFd);
    }
  });

  test('each unreported write that fails after close is reported lost', async () => {
    // The drain loop pushes the backlog into the stream's buffer and sets `closed` without
    // awaiting the write callbacks, so a callback that errors afterwards lands in
    // `requeue` past `abandonQueueOnClose()`. It counted the loss and said nothing - while
    // the caller had already reported that same entry as `disposition: 'retrying'`, so an
    // `onError` consumer whose job is to fall back to another destination on `'lost'` was
    // told the opposite of what happened.
    const pipePath = `${tmpDir.path}/post-close-loss.pipe`;
    await createNamedPipe(pipePath);

    const readerFd = fs.openSync(
      pipePath,
      fs.constants.O_RDONLY | fs.constants.O_NONBLOCK,
    );
    const failures: SinkFailure[] = [];
    const sink = new NamedPipeSink({
      pipePath,
      closeTimeoutMS: 1000,
      onError: (failure) => {
        failures.push(failure);
      },
    });

    try {
      expect(await waitForOpenPipe(sink)).toBe(true);

      // Nothing queued, so `abandonQueueOnClose()` reports nothing and every `'close'`
      // failure below is the one this test is about.
      await sink.close();

      expect(failures.filter((entry) => entry.kind === 'close')).toHaveLength(
        0,
      );

      const internals = sink as unknown as {
        requeue: (queued: {
          formatted: string;
          entry: LogEntry;
          attempts: number;
        }) => void;
      };

      for (let index = 0; index < 3; index++) {
        internals.requeue({
          formatted: `late-${String(index)}\n`,
          entry: {
            timestamp: Date.now(),
            type: 'info',
            template: `late-${String(index)}`,
            message: `late-${String(index)}`,
          },
          attempts: 0,
        });
      }

      expect(sink.getHealth().droppedEntries).toBe(3);

      // Fallback consumers need the identity of every lost entry.
      const closeFailures = failures.filter((entry) => entry.kind === 'close');

      expect(closeFailures).toHaveLength(3);
      expect(
        closeFailures.every((failure) => failure.disposition === 'lost'),
      ).toBe(true);
      expect(closeFailures[0]?.error.message).toContain(
        'after the sink was closed',
      );
      expect(closeFailures[0]?.entry?.message).toBe('late-0');
    } finally {
      fs.closeSync(readerFd);
    }
  }, 15000);

  test('a close that times out with writes still buffered reports the loss before it resolves', async () => {
    // The stream's buffered writes are errored by `destroy()` and land in `requeue` past
    // `closed`, which reports each failed line on a later tick, after `await close()` had
    // answered, so a shutdown handler that exits on that answer never heard it.
    // `FileSink` reports its in-flight write before its close resolves; this sink now
    // reports buffered bytes at the same moment; later callbacks identify individual losses.
    const pipePath = `${tmpDir.path}/close-buffered-loss.pipe`;
    await createNamedPipe(pipePath);

    // A reader that never reads: once the kernel buffer is full, everything else stays
    // in the stream's buffer with its callback pending.
    const readerFd = fs.openSync(
      pipePath,
      fs.constants.O_RDONLY | fs.constants.O_NONBLOCK,
    );
    let isReaderOpen = true;
    const failures: SinkFailure[] = [];
    const sink = new NamedPipeSink({
      pipePath,
      closeTimeoutMS: 300,
      onError: (failure) => {
        failures.push(failure);
      },
    });

    try {
      expect(await waitForOpenPipe(sink)).toBe(true);

      const line = 'x'.repeat(4096);

      // Well past a 64 KiB pipe buffer.
      for (let index = 0; index < 64; index++) {
        sink.write({
          timestamp: Date.now(),
          type: 'info',
          template: line,
          message: line,
        });
      }

      await new Promise((resolve) => setTimeout(resolve, 50));

      await sink.close();

      // Backpressure parks the rest of the backlog in the sink's own queue, and
      // `abandonQueueOnClose()` reports that separately: two distinct losses, each said
      // once. The one this test is about names the stream's buffer.
      const isBufferedLoss = (entry: SinkFailure): boolean =>
        entry.kind === 'close' &&
        entry.disposition === 'lost' &&
        entry.error.message.includes('still buffered');

      expect(failures.filter(isBufferedLoss)).toHaveLength(1);
      expect(failures.filter((entry) => entry.kind === 'close')).toHaveLength(
        2,
      );

      // The in-flight write is blocked in the threadpool behind the full pipe, and
      // `destroy()` defers until it returns - so until the reader goes away nothing errors
      // and no callback fires. That is why the report above is the only timely one.
      // Releasing the reader errors the write and the buffer behind it; those callbacks
      // land in `requeue` past `closed`, counted, and not reported a second time.
      const droppedAtResolve = sink.getHealth().droppedEntries;

      fs.closeSync(readerFd);
      isReaderOpen = false;

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(failures.filter((entry) => entry.kind === 'close')).toHaveLength(
        2,
      );
      expect(sink.getHealth().droppedEntries).toBeGreaterThanOrEqual(
        droppedAtResolve,
      );
    } finally {
      if (isReaderOpen) {
        fs.closeSync(readerFd);
      }
    }
  }, 15000);

  test('the close drain retries a failed write and reports what it still cannot send', async () => {
    // The other half of the same fix: with retries left the entry goes back on the queue
    // rather than being counted immediately, so `close()`'s drain loop gets to try it
    // again - and whatever the loop still cannot deliver is counted *and* reported by
    // `abandonQueueOnClose()`, instead of having silently evaporated before it ran.
    const pipePath = `${tmpDir.path}/close-drain-retry.pipe`;
    await createNamedPipe(pipePath);

    const readerFd = fs.openSync(
      pipePath,
      fs.constants.O_RDONLY | fs.constants.O_NONBLOCK,
    );
    const failures: SinkFailure[] = [];
    const sink = new NamedPipeSink({
      pipePath,
      closeTimeoutMS: 1000,
      maxRetries: 2,
      onError: (failure) => {
        failures.push(failure);
      },
    });

    try {
      expect(await waitForOpenPipe(sink)).toBe(true);

      const internals = sink as unknown as {
        writeQueue: { formatted: string; attempts: number }[];
        pipeStream?: { write: (...args: unknown[]) => boolean };
      };

      internals.writeQueue.push({ formatted: 'retried\n', attempts: 0 });

      const stream = internals.pipeStream;

      expect(stream).toBeDefined();

      let attempts = 0;

      if (stream) {
        stream.write = (): boolean => {
          attempts++;

          throw new Error('reader vanished');
        };
      }

      await sink.close();

      // Three writes for one entry: the first, then one per retry. The loop terminates -
      // `maxRetries` is finite, so the work is bounded whatever the drain does.
      expect(attempts).toBe(3);
      expect(sink.getHealth().queueSize).toBe(0);
      expect(sink.getHealth().droppedEntries).toBe(1);
    } finally {
      fs.closeSync(readerFd);
    }
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

  test('a write in the same tick as construction does not open the pipe twice', async () => {
    // `ensureConnection` refuses a second open on `_isReconnecting` and `pendingStream`,
    // but the constructor's own `initializePipe()` set neither until after its
    // `await fsPromises.stat()` - so a `write()` in the same tick as `new NamedPipeSink()`,
    // which is the ordinary case, walked through every guard and started a second open.
    // Opening a FIFO with no reader does not fail, it *blocks*, holding one of libuv's
    // four threadpool slots for as long as it waits. The current path probes once through
    // `fs.open` and hands that descriptor to its bounded writable, so no pathname-backed
    // WriteStream open should occur at all.
    const pipePath = `${tmpDir.path}/single-open.pipe`;
    await createNamedPipe(pipePath);

    const opened: string[] = [];
    const realCreateWriteStream = fs.createWriteStream.bind(fs);
    const createSpy = spyOn(fs, 'createWriteStream').mockImplementation(
      (
        target: fs.PathLike,
        options?: Parameters<typeof fs.createWriteStream>[1],
      ): fs.WriteStream => {
        opened.push(String(target));

        return realCreateWriteStream(target, options);
      },
    );

    const readerFd = fs.openSync(
      pipePath,
      fs.constants.O_RDONLY | fs.constants.O_NONBLOCK,
    );

    try {
      const sink = new NamedPipeSink({ pipePath, closeTimeoutMS: 2000 });

      // The same tick as the constructor, deliberately: this is what every caller does.
      sink.write({
        timestamp: Date.now(),
        type: 'info',
        template: 'first line',
        message: 'first line',
      });

      expect(await waitForOpenPipe(sink)).toBe(true);

      expect(opened.filter((target) => target === pipePath).length).toBe(0);

      await sink.close();
    } finally {
      createSpy.mockRestore();
      fs.closeSync(readerFd);
    }
  }, 20000);

  test('a FIFO with no reader does not pin the process open', async () => {
    // The failure this is here for was not a wrong value anywhere - every assertion in
    // this file passed while it was true. `fs.createWriteStream` on a FIFO issues a
    // blocking `open(2)`, which for a pipe nobody is reading never returns, and
    // `destroy()` cannot cancel a syscall already in flight. A pending threadpool request
    // keeps the event loop alive, so `await sink.close()` resolved, the queue was
    // abandoned and reported, the sink said everything it was supposed to say - and the
    // process then sat there until something sent it `SIGKILL`.
    //
    // Only observable from outside, hence the child: in-process the sink looks closed.
    const pipePath = `${tmpDir.path}/no-reader-exit.pipe`;
    await createNamedPipe(pipePath);

    const sinkModulePath = fileURLToPath(
      new URL('./named-pipe.ts', import.meta.url),
    );
    const scriptPath = `${tmpDir.path}/no-reader-exit.ts`;

    await fsPromises.writeFile(
      scriptPath,
      [
        `import { NamedPipeSink } from ${JSON.stringify(sinkModulePath)};`,
        '',
        'const sink = new NamedPipeSink({',
        `  pipePath: ${JSON.stringify(pipePath)},`,
        '  closeTimeoutMS: 500,',
        '  onError: () => {',
        '    // Expected: the line cannot be delivered to a pipe nobody is reading.',
        '  },',
        '});',
        '',
        'sink.write({',
        '  timestamp: Date.now(),',
        "  type: 'info',",
        "  template: 'never-delivered',",
        "  message: 'never-delivered',",
        '});',
        '',
        'await sink.close();',
        '',
        "console.log('closed');",
        '',
      ].join('\n'),
      'utf8',
    );

    // `process.execPath` is the runtime running this suite, which is the one that knows
    // how to load the sink's TypeScript directly.
    const child = spawn(process.execPath, [scriptPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });

    // Captured rather than merely drained. Without it a child that failed for an unrelated
    // reason - an import that did not resolve, a throw before `close()` - shows up only as
    // "stdout did not contain 'closed'", with the actual diagnosis discarded.
    let stderr = '';

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    const exitTimeoutMS = 10000;
    const outcome = await new Promise<number | 'did_not_exit'>((resolve) => {
      const timer = setTimeout(() => {
        resolve('did_not_exit');
      }, exitTimeoutMS);

      child.once('exit', (code) => {
        clearTimeout(timer);
        resolve(code ?? -1);
      });
    });

    if (outcome === 'did_not_exit') {
      // The `SIGKILL` this test exists to make unnecessary. Sent anyway, so a regression
      // fails the assertion below rather than leaving a stuck child behind it.
      child.kill('SIGKILL');
    }

    // `close()` resolved *and* the process was then free to leave. The first was already
    // true before the non-blocking probe; the second was not.
    //
    // `stderr` is folded into the first assertion rather than checked separately, so a
    // child that died on its way to `close()` fails with its own error in the message.
    expect(
      stdout + (stderr === '' ? '' : `\n[child stderr] ${stderr}`),
    ).toContain('closed');
    expect(outcome).toBe(0);
  }, 20000);

  test('a pipe that never appears is reported once, not once per retry', async () => {
    // The cost of making recovery independent of traffic. Every failed open schedules
    // another attempt now, so a mistyped `pipePath` is retried once a second for the life
    // of the process - and reported on every one of them, it would call the caller's
    // `onError` 86,400 times a day for a sink whose whole job on this path is to wait
    // quietly and keep trying. One report per outage, the way the queue cap and the
    // abandoned-open cap already report.
    const pipePath = `${tmpDir.path}/never/going/to/exist.pipe`;
    const kinds: SinkFailureKind[] = [];

    const sink = new NamedPipeSink({
      pipePath,
      closeTimeoutMS: 500,
      onError: (failure: SinkFailure) => {
        kinds.push(failure.kind);
      },
    });

    sink.write({
      timestamp: Date.now(),
      type: 'info',
      template: 'nowhere-to-go',
      message: 'nowhere-to-go',
    });

    // Several cooldowns' worth of attempts, with nothing written after the first.
    await new Promise((resolve) => setTimeout(resolve, 3500));

    expect(kinds.filter((kind) => kind === 'not_found').length).toBe(1);

    // Still counted and still visible, which is the part that must not be traded away for
    // the quiet: the report is deduplicated, the state is not.
    expect(sink.getHealth().isInitialized).toBe(false);
    expect(sink.getHealth().lastError).toBeDefined();
    expect(sink.getHealth().queueSize).toBe(1);

    await sink.close();
  }, 15000);

  test('an open that failed for anything but absence is not called not_found', async () => {
    // The catch-all reported every failure escaping the open as `'not_found'` - "the
    // destination does not exist" - and that block covers `stat` failing with `EACCES`,
    // `ELOOP` or `ENOTDIR` as well as a synchronous throw from `createWriteStream`. A
    // handler switching on `kind` to decide whether to recreate the FIFO acted on a false
    // premise for every one of them. `'setup'` is what the probe path already chose for
    // exactly these.
    const filePath = `${tmpDir.path}/an-ordinary-file`;

    await fsPromises.writeFile(filePath, 'not a directory', 'utf8');

    const kinds: SinkFailureKind[] = [];

    const sink = new NamedPipeSink({
      pipePath: `${filePath}/under-a-file.pipe`,
      closeTimeoutMS: 2000,
      onError: (failure: SinkFailure) => {
        kinds.push(failure.kind);
      },
    });

    sink.write({
      timestamp: Date.now(),
      type: 'info',
      serviceName: 'TestService',
      template: 'nowhere to go',
      message: 'nowhere to go',
    });

    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(kinds).toContain('setup');
    expect(kinds).not.toContain('not_found');

    // And a path that genuinely is not there still says so.
    const missingKinds: SinkFailureKind[] = [];
    const missing = new NamedPipeSink({
      pipePath: `${tmpDir.path}/never-created.pipe`,
      closeTimeoutMS: 2000,
      onError: (failure: SinkFailure) => {
        missingKinds.push(failure.kind);
      },
    });

    missing.write({
      timestamp: Date.now(),
      type: 'info',
      serviceName: 'TestService',
      template: 'nowhere to go',
      message: 'nowhere to go',
    });

    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(missingKinds).toContain('not_found');

    await sink.close();
    await missing.close();
  }, 15000);

  test('a path that is not a FIFO is reported once, and does not trap the sink', async () => {
    // This one was both a flood and a dead end. Reporting directly rather than through the
    // once-per-outage path meant six callbacks in four seconds against an ordinary file,
    // and returning with no retry scheduled made it absorbing: the retry chain that
    // recovers a missing path walks straight into it the moment the path exists as
    // something else, and stops there for good.
    //
    // `rm pipe; touch pipe; rm pipe; mkfifo pipe` is an ordinary deploy fumble, and it left
    // the sink uninitialized for the life of a quiet process - a live reader on a perfectly
    // good FIFO, and nothing looking at it.
    const pipePath = `${tmpDir.path}/not-a-fifo.pipe`;
    const kinds: SinkFailureKind[] = [];

    // Step one: the path is a regular file.
    await fsPromises.writeFile(pipePath, 'not a fifo', 'utf8');

    const sink = new NamedPipeSink({
      pipePath,
      closeTimeoutMS: 2000,
      onError: (failure: SinkFailure) => {
        kinds.push(failure.kind);
      },
    });

    sink.write({
      timestamp: Date.now(),
      type: 'info',
      template: 'waiting-for-a-real-pipe',
      message: 'waiting-for-a-real-pipe',
    });

    // Several cooldowns, nothing written after the first line.
    await new Promise((resolve) => setTimeout(resolve, 2500));

    expect(kinds.filter((kind) => kind === 'not_a_pipe').length).toBe(1);
    expect(sink.getHealth().isInitialized).toBe(false);

    // Step two: the file is replaced by a real FIFO with a real reader, and still nothing
    // is written. The sink has to have kept looking.
    await fsPromises.unlink(pipePath);
    await createNamedPipe(pipePath);

    const reader = spawn('cat', [pipePath], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    let received = '';

    reader.stdout.setEncoding('utf8');
    reader.stdout.on('data', (chunk: string) => {
      received += chunk;
    });

    try {
      expect(await waitForOpenPipe(sink)).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 250));

      expect(received).toContain('waiting-for-a-real-pipe');
      expect(sink.getHealth().droppedEntries).toBe(0);
    } finally {
      await sink.close();
      reader.kill('SIGKILL');
    }
  }, 20000);

  test('reconnect() reports the failure every time it is asked', async () => {
    // The deduplication that keeps an automatic retry quiet must not silence an attempt the
    // caller made by name. `docs/logger.md` promises that a failed `reconnect()` calls
    // `onError` again with the details, and `ReconnectStatus.error` is a generic
    // `Failed to initialize pipe connection` - so suppressing the report leaves the caller
    // with no way at all to learn why. It cannot run away either: this is driven by the
    // application, not by a timer.
    const pipePath = `${tmpDir.path}/reconnect-reports.pipe`;
    const kinds: SinkFailureKind[] = [];

    const sink = new NamedPipeSink({
      pipePath,
      closeTimeoutMS: 500,
      onError: (failure: SinkFailure) => {
        kinds.push(failure.kind);
      },
    });

    // Let the constructor's own attempt settle and report.
    await new Promise((resolve) => setTimeout(resolve, 150));

    kinds.length = 0;

    const first = await sink.reconnect();
    const second = await sink.reconnect();

    expect(first.success).toBe(false);
    expect(second.success).toBe(false);

    // Both asks answered, not just the first.
    expect(kinds.filter((kind) => kind === 'not_found').length).toBe(2);

    await sink.close();
  }, 15000);

  test('an onError that logs back into the broken sink does not recurse', async () => {
    // The hostile shape, and a realistic one: a handler whose way of reporting the failure
    // is to log it - through the very sink that just failed, because that is the logger the
    // application has.
    //
    // What stops it is not the report deduplication but the queue. A sink that cannot write
    // *queues* the entry and returns; queuing is not a failure, so it reports nothing, so
    // the log about the failure becomes a queued line rather than a second failure. The
    // recursion therefore stops at depth one on its own. The deduplication covers a
    // different axis - it keeps the retry timer from re-entering the handler once a second
    // for as long as the outage lasts - and both are checked here.
    const pipePath = `${tmpDir.path}/self-logging.pipe`;

    let calls = 0;
    let depth = 0;
    let maxDepth = 0;

    // Declared before the sink so the handler can reach it, and read through the box so
    // the handler closes over something that is assigned by the time it runs.
    const self: { sink?: NamedPipeSink } = {};

    const sink = new NamedPipeSink({
      pipePath,
      closeTimeoutMS: 500,
      onError: () => {
        calls++;
        depth++;
        maxDepth = Math.max(maxDepth, depth);

        self.sink?.write({
          timestamp: Date.now(),
          type: 'error',
          template: 'the log sink failed',
          message: 'the log sink failed',
        });

        depth--;
      },
    });

    self.sink = sink;

    sink.write({
      timestamp: Date.now(),
      type: 'info',
      template: 'first',
      message: 'first',
    });

    // Several cooldowns' worth of retries against a path that does not exist.
    await new Promise((resolve) => setTimeout(resolve, 2500));

    // Never re-entered: the handler's own write reported nothing.
    expect(maxDepth).toBe(1);

    // And said once, not once per retry.
    expect(calls).toBe(1);

    // Not vacuous: the handler's write really did happen, and really was queued - the
    // original line plus the one the handler logged about it.
    expect(sink.getHealth().queueSize).toBe(2);

    await sink.close();
  }, 15000);

  test('a self-logging onError cannot recurse through a throwing formatter', async () => {
    // The other half of the invariant above. The queue short-circuit that stops the
    // no-pipe path does not apply here: the render happens in `write()`, before anything
    // is queued, so a `formatter` that throws reported, re-entered `write()` from the
    // handler, threw again, and reported again - without bound.
    const pipePath = `${tmpDir.path}/self-logging-format.pipe`;

    let calls = 0;
    let depth = 0;
    let maxDepth = 0;

    const self: { sink?: NamedPipeSink } = {};

    const sink = new NamedPipeSink({
      pipePath,
      closeTimeoutMS: 500,
      formatter: () => {
        throw new Error('Formatter error');
      },
      onError: () => {
        calls++;
        depth++;
        maxDepth = Math.max(maxDepth, depth);

        self.sink?.write({
          timestamp: Date.now(),
          type: 'error',
          template: 'the log sink failed',
          message: 'the log sink failed',
        });

        depth--;
      },
    });

    self.sink = sink;

    sink.write({
      timestamp: Date.now(),
      type: 'info',
      template: 'first',
      message: 'first',
    });

    expect(maxDepth).toBe(1);
    expect(calls).toBe(1);

    // Not vacuous: the handler's own line still rendered through the default format and
    // still reached the queue, alongside the one that started this.
    expect(sink.getHealth().queueSize).toBe(2);

    await sink.close();
  }, 15000);

  test('a self-logging onError cannot recurse through an unrenderable jsonFormat entry', async () => {
    // The third half of the invariant: no `formatter` at all, and the default `jsonFormat`
    // render refusing the entry. That line is handed to `writeEntry` on the caller's
    // stack, reported from there, and the handler's own line - carrying the same
    // unrenderable value - failed the same way and reached the same report: a
    // synchronous recursion that ended in a stack overflow.
    const pipePath = `${tmpDir.path}/self-logging-json.pipe`;

    let calls = 0;
    let depth = 0;
    let maxDepth = 0;

    const self: { sink?: NamedPipeSink } = {};

    const sink = new NamedPipeSink({
      pipePath,
      closeTimeoutMS: 500,
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

    sink.write({
      timestamp: Date.now(),
      type: 'info',
      template: 'unrenderable',
      message: UNRENDERABLE_MESSAGE,
    });

    expect(maxDepth).toBe(1);
    expect(calls).toBe(1);

    // Both lines counted: the one that started this and the handler's own.
    expect(sink.getHealth().droppedEntries).toBe(2);

    await sink.close();
  }, 15000);

  test('the format guard holds until an async onError settles', async () => {
    // A flag cleared when the handler returned was cleared at its first `await`, so an
    // `async` handler that logged the unrenderable failure back after awaiting found no
    // guard and reported again, once per turn of the event loop.
    const pipePath = `${tmpDir.path}/async-self-logging.pipe`;

    let calls = 0;

    const self: { sink?: NamedPipeSink } = {};

    const sink = new NamedPipeSink({
      pipePath,
      closeTimeoutMS: 500,
      jsonFormat: true,
      onError: async (failure) => {
        // Only the reports under test: the missing pipe reports `'not_found'` on its own
        // schedule, and those are a different subject.
        if (failure.kind !== 'format') {
          return;
        }

        calls++;

        await new Promise((resolve) => setTimeout(resolve, 5));

        self.sink?.write({
          timestamp: Date.now(),
          type: 'error',
          template: 'the log sink failed',
          message: UNRENDERABLE_MESSAGE,
        });
      },
    });

    self.sink = sink;

    sink.write({
      timestamp: Date.now(),
      type: 'info',
      template: 'unrenderable',
      message: UNRENDERABLE_MESSAGE,
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

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
  }, 15000);

  test('reports one concurrent format failure after the active handler settles', async () => {
    const pipePath = `${tmpDir.path}/concurrent-format.pipe`;
    let releaseFirst!: () => void;
    const firstPending = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const messages: string[] = [];

    const sink = new NamedPipeSink({
      pipePath,
      closeTimeoutMS: 500,
      jsonFormat: true,
      onError: (failure) => {
        if (failure.kind !== 'format') {
          return;
        }

        messages.push(failure.entry?.message ?? 'missing');

        return messages.length === 1 ? firstPending : undefined;
      },
    });

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

    expect(messages).toEqual([UNRENDERABLE_MESSAGE]);

    releaseFirst();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(messages).toEqual([UNRENDERABLE_MESSAGE, UNRENDERABLE_MESSAGE]);
    expect(sink.getHealth().droppedByKind.format).toBe(2);

    await sink.close();
  }, 15000);

  test('destination health is independent of historical queue overflow', async () => {
    const pipePath = `${tmpDir.path}/overflow-health.pipe`;
    await createNamedPipe(pipePath);
    const readerFd = fs.openSync(
      pipePath,
      fs.constants.O_RDONLY | fs.constants.O_NONBLOCK,
    );
    const sink = new NamedPipeSink({
      pipePath,
      maxQueueSize: 1,
      closeTimeoutMS: 200,
      onError: () => {},
    });
    try {
      // Both writes precede the asynchronous open, so the second evicts the first.
      for (const message of ['first', 'second']) {
        sink.write({
          timestamp: Date.now(),
          type: 'info',
          template: message,
          message,
        });
      }
      expect(sink.getHealth().droppedByKind.queue_full).toBe(1);
      expect(await waitForOpenPipe(sink)).toBe(true);
      expect(sink.getHealth().isHealthy).toBe(true);
      expect(sink.getHealth().droppedEntries).toBe(1);
    } finally {
      await sink.close();
      fs.closeSync(readerFd);
    }
  });

  test('droppedByKind splits the total by reason and always sums to it', async () => {
    const makeEntry = (message: string): LogEntry => ({
      timestamp: Date.now(),
      type: 'info',
      template: message,
      message,
    });

    // No reader on this pipe, so every ordinary line queues; a one-slot queue then evicts
    // the older of two, an unrenderable line is a format loss, the survivor is abandoned
    // by `close()`, and a line after close is refused at the door.
    const pipePath = `${tmpDir.path}/dropped-by-kind.pipe`;

    const sink = new NamedPipeSink({
      pipePath,
      closeTimeoutMS: 100,
      jsonFormat: true,
      maxQueueSize: 1,
    });

    sink.write({
      timestamp: Date.now(),
      type: 'info',
      template: 'unrenderable',
      message: UNRENDERABLE_MESSAGE,
    });
    sink.write(makeEntry('first'));
    sink.write(makeEntry('second'));

    expect(sink.getHealth().droppedByKind.format).toBe(1);
    expect(sink.getHealth().droppedByKind.queue_full).toBe(1);

    const closing = sink.close();

    sink.write(makeEntry('after close'));

    await closing;

    const health = sink.getHealth();
    const byKind = health.droppedByKind;

    expect(byKind.format).toBe(1);
    expect(byKind.queue_full).toBe(1);
    // The abandoned survivor and the one refused after close.
    expect(byKind.close).toBe(2);
    expect(byKind.write).toBe(0);
    expect(
      byKind.queue_full + byKind.write + byKind.format + byKind.close,
    ).toBe(health.droppedEntries);
  }, 15000);

  test('jsonFormat writes one parseable line with markers, and reports the fallback once', async () => {
    // A plain `JSON.stringify` over the bag lost the whole line to a `BigInt` or a cycle
    // the logger's own renderer handles. Now the line reaches the reader with a marker
    // where the value was, still one JSON object, and the one value that would not render
    // is said once as `'format'`/`'fallback'`.
    const pipePath = `${tmpDir.path}/json-render.pipe`;

    await createNamedPipe(pipePath);

    const reader = startPipeReader(pipePath);
    const failures: SinkFailure[] = [];
    const cyclic: Record<string, unknown> = { a: 1 };

    cyclic.self = cyclic;

    const sink = new NamedPipeSink({
      pipePath,
      jsonFormat: true,
      onError: (failure) => {
        failures.push(failure);
      },
    });

    expect(await waitForOpenPipe(sink)).toBe(true);

    sink.write({
      timestamp: Date.now(),
      type: 'info',
      template: 'markers',
      message: 'markers',
      redactedParams: {
        big: 1n,
        cyclic,
        get boom(): never {
          throw new Error('getter exploded');
        },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 200));
    await sink.close();

    reader.stop();

    const line = reader.data.join('').trim();
    const parsed = JSON.parse(line) as { params: Record<string, unknown> };

    expect(parsed.params['big']).toBe('1');
    expect((parsed.params['cyclic'] as Record<string, unknown>)['self']).toBe(
      '[circular]',
    );
    expect(parsed.params['boom']).toBe('[unrenderable: value]');

    const formats = failures.filter((failure) => failure.kind === 'format');

    expect(formats).toHaveLength(1);
    expect(formats[0]?.disposition).toBe('fallback');
    expect(formats[0]?.error.message).not.toContain('getter exploded');
    expect(formats[0]?.error.message).toBe(
      'Failed to render a value in the log entry; a marker was written in its place',
    );
    expect((formats[0]?.error.cause as Error | undefined)?.message).toBe(
      'getter exploded',
    );
    expect(sink.getHealth().droppedEntries).toBe(0);
  }, 15000);

  test('an entry written during close() is counted and reported once', async () => {
    // `close()` waits up to `closeTimeoutMS`, and everything logged in that window left
    // through `write()`'s early return with nothing to show for it: `droppedEntries`
    // unmoved, `onError` silent, `getHealth()` claiming a clean shutdown.
    const pipePath = `${tmpDir.path}/write-during-close.pipe`;
    const dispositions: (string | undefined)[] = [];

    const sink = new NamedPipeSink({
      pipePath,
      closeTimeoutMS: 200,
      onError: (failure: SinkFailure) => {
        if (failure.kind === 'close') {
          dispositions.push(failure.disposition);
        }
      },
    });

    await sink.close();

    for (let index = 0; index < 3; index++) {
      sink.write({
        timestamp: Date.now(),
        type: 'info',
        template: 'late',
        message: 'late',
      });
    }

    expect(sink.getHealth().droppedEntries).toBe(3);

    // Once, not once per line.
    expect(dispositions).toEqual(['lost']);
  }, 15000);

  test('a path that flaps reports each distinct state once, not once per change', async () => {
    // The reason the sink remembers every failure of an outage rather than just the last
    // one. Remembering only the previous failure reports on every *change*, so a path
    // genuinely thrashing - a deploy script creating and removing it, a mount coming and
    // going - is a callback per transition, and at one attempt a second that is the flood
    // again by another route.
    //
    // Here the path cycles missing -> regular file -> missing. Three states to diagnose,
    // two of them distinct, and the third is one the sink has already reported this outage.
    const pipePath = `${tmpDir.path}/flapping.pipe`;
    const kinds: SinkFailureKind[] = [];

    const sink = new NamedPipeSink({
      pipePath,
      closeTimeoutMS: 500,
      onError: (failure: SinkFailure) => {
        kinds.push(failure.kind);
      },
    });

    sink.write({
      timestamp: Date.now(),
      type: 'info',
      template: 'flap',
      message: 'flap',
    });

    // Missing.
    await new Promise((resolve) => setTimeout(resolve, 1200));

    // Now a regular file.
    await fsPromises.writeFile(pipePath, 'not a fifo', 'utf8');
    await new Promise((resolve) => setTimeout(resolve, 1200));

    // And missing again - a state already reported, so it must not be reported twice.
    await fsPromises.unlink(pipePath);
    await new Promise((resolve) => setTimeout(resolve, 1200));

    expect(kinds.filter((kind) => kind === 'not_found').length).toBe(1);
    expect(kinds.filter((kind) => kind === 'not_a_pipe').length).toBe(1);

    // Two facts, two callbacks, across three state changes and several attempts each.
    expect(kinds.length).toBe(2);

    await sink.close();
  }, 20000);

  test('recovers a pipe that only appears later, with no further traffic', async () => {
    // Three ways an open can fail - no reader on the FIFO, the open itself refused, the
    // `stat` finding nothing there - and only the first ever had a timer behind it. The
    // other two waited for the next `write()` to ask, which is a retry policy only for a
    // process that is still logging. A deploy that lays the pipe down a moment after the
    // service starts, or a `rm pipe; mkfifo pipe` during a quiet minute, was picked up
    // whenever traffic happened to resume, and by a process that had gone quiet, never.
    //
    // Nothing is written after the first line here, deliberately: the recovery under test
    // is the one that happens with no help from the caller at all.
    const pipePath = `${tmpDir.path}/late-arrival.pipe`;
    const kinds: SinkFailureKind[] = [];

    const sink = new NamedPipeSink({
      pipePath,
      closeTimeoutMS: 2000,
      onError: (failure: SinkFailure) => {
        kinds.push(failure.kind);
      },
    });

    // The FIFO does not exist yet, so the `stat` fails and the sink says so.
    sink.write({
      timestamp: Date.now(),
      type: 'info',
      template: 'queued-before-the-pipe-existed',
      message: 'queued-before-the-pipe-existed',
    });

    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(kinds).toContain('not_found');
    expect(sink.getHealth().isInitialized).toBe(false);
    expect(sink.getHealth().queueSize).toBe(1);

    // Now the pipe and its reader turn up. No further `write()`.
    await createNamedPipe(pipePath);

    const reader = spawn('cat', [pipePath], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    let received = '';

    reader.stdout.setEncoding('utf8');
    reader.stdout.on('data', (chunk: string) => {
      received += chunk;
    });

    try {
      // Opened by the retry timer alone - `waitForOpenPipe` only polls `getHealth()`.
      expect(await waitForOpenPipe(sink)).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 250));

      // And the line that was queued the whole time went out.
      expect(received).toContain('queued-before-the-pipe-existed');
      expect(sink.getHealth().droppedEntries).toBe(0);
    } finally {
      await sink.close();
      reader.kill('SIGKILL');
    }
  }, 15000);

  test('opening the pipe does not hand the reader an end of input', async () => {
    // A FIFO's reader sees EOF when the *last* writer closes it. The non-blocking probe
    // that keeps a blocking open from ever starting is itself a writer, so releasing it
    // before the real stream has a descriptor of its own leaves a moment with no writer at
    // all - and `cat < pipe`, like every other reader that treats end of input as end of
    // job, exits in that moment. Measured while writing this: the reader hung up before
    // the first line was ever written to it.
    //
    // `cat` in a child process rather than an in-process `fs.createReadStream`, and that
    // is not incidental. Opening a FIFO for *reading* blocks until a writer arrives, so a
    // reader living in this process sits in the runtime's file-I/O thread pool waiting for
    // the writer that only this sink's probe - another file-I/O call, queued behind it -
    // is going to provide. Under Bun that deadlocks outright. A separate process has its
    // own pool and none of that applies, which is also what every real deployment of this
    // sink looks like.
    const pipePath = `${tmpDir.path}/no-eof.pipe`;
    await createNamedPipe(pipePath);

    const reader = spawn('cat', [pipePath], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    let received = '';
    let readerExitCode: number | null | 'still_running' = 'still_running';

    reader.stdout.setEncoding('utf8');
    reader.stdout.on('data', (chunk: string) => {
      received += chunk;
    });

    reader.once('exit', (code) => {
      readerExitCode = code;
    });

    const sink = new NamedPipeSink({ pipePath, closeTimeoutMS: 2000 });

    try {
      expect(await waitForOpenPipe(sink)).toBe(true);

      sink.write({
        timestamp: Date.now(),
        type: 'info',
        template: 'after-probe',
        message: 'after-probe',
      });

      await new Promise((resolve) => setTimeout(resolve, 250));

      // Still the same reader, and it got the line: the probe never handed it an EOF to
      // exit on.
      expect(readerExitCode).toBe('still_running');
      expect(received).toContain('after-probe');
    } finally {
      await sink.close();

      if (readerExitCode === 'still_running') {
        reader.kill('SIGKILL');
      }
    }
  }, 15000);

  test('writes an entry queued before the pipe finishes opening', async () => {
    // A FIFO's write side does not open until a reader arrives, so on this sequence the
    // `'open'` event lands while `close()` is still awaiting `initPromise` - during
    // `closing`. Refusing to promote the stream there left `pipeStream` undefined, which is
    // the one condition the drain loop will not wait on, so the backlog was abandoned with
    // a reader attached and consuming.
    const pipePath = `${tmpDir.path}/close-drain.pipe`;
    await createNamedPipe(pipePath);

    const reader = startPipeReader(pipePath);

    const failures: SinkFailure[] = [];
    const sink = new NamedPipeSink({
      pipePath,
      jsonFormat: false,
      onError: (failure) => {
        failures.push(failure);
      },
    });

    const testMessage = 'logged before the pipe opened';

    sink.write({
      timestamp: Date.now(),
      type: 'info',
      serviceName: 'TestService',
      template: testMessage,
      message: testMessage,
    });

    await sink.close();

    // The reader's own delivery is asynchronous even once the write has flushed.
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(reader.data.join('')).toContain(testMessage);
    expect(sink.getHealth().droppedEntries).toBe(0);
    expect(failures).toEqual([]);

    reader.stop();
  }, 15000);

  test('close() waits out a reader that is restarting, and only briefly', async () => {
    // The consumer of a FIFO is often restarted alongside the process writing to it, so a
    // probe that answers `ENXIO` at shutdown usually means "back in a moment" rather than
    // "nothing is listening". `close()` re-asks across a short grace window for exactly
    // that, and gives up at the end of it: a reader that is genuinely gone must not turn a
    // shutdown into a `closeTimeoutMS` wait.
    const pipePath = `${tmpDir.path}/close-regrace.pipe`;
    await createNamedPipe(pipePath);

    const sink = new NamedPipeSink({
      pipePath,
      jsonFormat: false,
      closeTimeoutMS: 8000,
    });

    const testMessage = 'written while the reader was restarting';

    sink.write({
      timestamp: Date.now(),
      type: 'info',
      serviceName: 'TestService',
      template: testMessage,
      message: testMessage,
    });

    let restarted: ReturnType<typeof startPipeReader> | undefined;

    // Attached after the sink has already found no reader, inside the grace window.
    const readerTimer = setTimeout(() => {
      restarted = startPipeReader(pipePath);
    }, 150);

    await sink.close();
    clearTimeout(readerTimer);

    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(restarted?.data.join('')).toContain(testMessage);
    expect(sink.getHealth().droppedEntries).toBe(0);

    restarted?.stop();
  }, 15000);

  test('close() reopens for a stream that was destroyed but not yet cleared', async () => {
    // A `WriteStream` marks itself `destroyed` synchronously when a write fails, while
    // `pipeStream` is cleared only later from the asynchronous `'error'` handler. Both
    // drain loops tested `pipeStream === undefined`, so a `close()` entered in that window
    // - the ordinary shape, an `onError` handler calling `sink.close()` - skipped the
    // reopen loop, failed the drain loop's liveness test below and abandoned the whole
    // backlog with a reader on the other end and the grace window unspent.
    const pipePath = `${tmpDir.path}/close-destroyed-stream.pipe`;
    await createNamedPipe(pipePath);

    // A held descriptor rather than a read stream: destroying the sink's writer below
    // makes the FIFO writerless for a moment, which ends a `createReadStream` and takes
    // the reader away with it - the state this test is *not* about.
    const readerFD = fs.openSync(
      pipePath,
      fs.constants.O_RDONLY | fs.constants.O_NONBLOCK,
    );

    const sink = new NamedPipeSink({
      pipePath,
      jsonFormat: false,
      closeTimeoutMS: 8000,
    });

    expect(await waitForOpenPipe(sink)).toBe(true);

    const privateSink = sink as unknown as {
      pipeStream?: { destroy: () => void };
    };

    // Destroyed without clearing the reference, exactly as a synchronous write failure
    // leaves it before the `'error'` event lands.
    privateSink.pipeStream?.destroy();

    const testMessage = 'queued behind a destroyed stream';

    sink.write({
      timestamp: Date.now(),
      type: 'info',
      serviceName: 'TestService',
      template: testMessage,
      message: testMessage,
    });

    await sink.close();

    const buffer = Buffer.alloc(65536);
    let bytesRead = 0;

    try {
      bytesRead = fs.readSync(readerFD, buffer, 0, buffer.length, null);
    } finally {
      fs.closeSync(readerFD);
    }

    expect(buffer.subarray(0, bytesRead).toString('utf8')).toContain(
      testMessage,
    );
    expect(sink.getHealth().droppedEntries).toBe(0);
  }, 15000);

  test('close() gives up on a reader that never comes back', async () => {
    // The other half of the grace window: nothing is reading, and the close returns in
    // roughly the window rather than holding for `closeTimeoutMS`.
    const pipePath = `${tmpDir.path}/close-regrace-none.pipe`;
    await createNamedPipe(pipePath);

    const sink = new NamedPipeSink({
      pipePath,
      jsonFormat: false,
      closeTimeoutMS: 8000,
    });

    sink.write({
      timestamp: Date.now(),
      type: 'info',
      serviceName: 'TestService',
      template: 'nobody is listening',
      message: 'nobody is listening',
    });

    const startedAt = Date.now();

    await sink.close();

    const elapsed = Date.now() - startedAt;

    // Comfortably inside `closeTimeoutMS`, which is what the grace window exists to stay
    // clear of; the upper bound is loose so a slow machine does not make this flake.
    expect(elapsed).toBeLessThan(3000);
    expect(sink.getHealth().droppedEntries).toBe(1);
  }, 15000);
});
