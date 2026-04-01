import { EventEmitter } from 'node:events';
import { describe, expect, test } from 'bun:test';
import {
  REQUEST_BODY_CHUNK_SIZE,
  writeRequestBodyChunked,
} from './request-body-writer';
import type { RequestBodyWritable } from './request-body-writable';

interface CapturedWrite {
  data: Buffer;
  hadCallback: boolean;
}

function makeCapture(
  options: {
    errorAfterBytes?: number;
  } = {},
) {
  const writes: CapturedWrite[] = [];
  let totalBytesWritten = 0;

  const req: RequestBodyWritable = {
    destroyed: false,
    setHeader() {},
    write(data, callback) {
      const buf = Buffer.isBuffer(data)
        ? data
        : typeof data === 'string'
          ? Buffer.from(data)
          : Buffer.from(data);

      totalBytesWritten += buf.length;
      writes.push({ data: buf, hadCallback: callback !== undefined });

      if (
        options.errorAfterBytes !== undefined &&
        totalBytesWritten >= options.errorAfterBytes
      ) {
        callback?.(new Error('Simulated write error'));
      } else {
        callback?.(null);
      }

      return true;
    },
    once() {
      return this;
    },
    off() {
      return this;
    },
  };

  return {
    req,
    writes,
    getBody: () => Buffer.concat(writes.map((w) => w.data)),
  };
}

describe('writeRequestBodyChunked', () => {
  test('writes entire buffer', async () => {
    const data = Buffer.from('hello world');
    const { req, getBody } = makeCapture();

    await writeRequestBodyChunked(data, req);

    expect(getBody()).toEqual(data);
  });

  test('splits data larger than REQUEST_BODY_CHUNK_SIZE into multiple writes', async () => {
    const data = Buffer.alloc(REQUEST_BODY_CHUNK_SIZE + 100, 0x42);
    const { req, writes } = makeCapture();

    await writeRequestBodyChunked(data, req);

    expect(writes.length).toBe(2);
    expect(writes[0].data.length).toBe(REQUEST_BODY_CHUNK_SIZE);
    expect(writes[1].data.length).toBe(100);
  });

  test('fires progress for each chunk', async () => {
    const data = Buffer.alloc(REQUEST_BODY_CHUNK_SIZE + 1, 0x01);
    const { req } = makeCapture();
    const events: Array<{ loaded: number; total: number; progress: number }> =
      [];

    await writeRequestBodyChunked(data, req, (e) => {
      events.push(e);
    });

    expect(events.length).toBe(2);
    expect(events[0].loaded).toBe(REQUEST_BODY_CHUNK_SIZE);
    expect(events[1].loaded).toBe(data.length);
    expect(events[1].progress).toBe(1);
  });

  test('final progress event has progress === 1', async () => {
    const data = Buffer.from('abc');
    const { req } = makeCapture();
    const progressValues: number[] = [];

    await writeRequestBodyChunked(data, req, (e) => {
      progressValues.push(e.progress);
    });

    expect(progressValues[progressValues.length - 1]).toBe(1);
  });

  test('empty buffers still emit a terminal progress event', async () => {
    const data = Buffer.alloc(0);
    const { req, writes } = makeCapture();
    const events: Array<{ loaded: number; total: number; progress: number }> =
      [];

    await writeRequestBodyChunked(data, req, (e) => {
      events.push(e);
    });

    expect(writes).toEqual([]);
    expect(events).toEqual([{ loaded: 0, total: 0, progress: 1 }]);
  });

  test('rejects when write callback fires an error', async () => {
    const data = Buffer.from('some data');
    const { req } = makeCapture({ errorAfterBytes: 1 });

    let caught: Error | undefined;
    try {
      await writeRequestBodyChunked(data, req);
    } catch (error) {
      caught = error as Error;
    }

    expect(caught?.message).toBe('Simulated write error');
  });

  test('stops writing if req.destroyed becomes true mid-loop', async () => {
    const data = Buffer.alloc(REQUEST_BODY_CHUNK_SIZE * 3, 0x00);
    let writeCalls = 0;

    const req: RequestBodyWritable = {
      get destroyed() {
        return writeCalls >= 1;
      },
      setHeader() {},
      write(_data, callback) {
        writeCalls++;
        callback?.(null);
        return true;
      },
      once() {
        return this;
      },
      off() {
        return this;
      },
    };

    await writeRequestBodyChunked(data, req);
    expect(writeCalls).toBe(1);
  });

  test('each write waits for callback before proceeding (sequential writes)', async () => {
    const data = Buffer.alloc(REQUEST_BODY_CHUNK_SIZE * 2, 0xaa);
    const writeOrder: number[] = [];
    const callbackOrder: number[] = [];

    let pendingCallback: ((err: Error | null | undefined) => void) | undefined;
    let writeIndex = 0;

    const req: RequestBodyWritable = {
      destroyed: false,
      setHeader() {},
      write(_data, callback) {
        const index = writeIndex++;
        writeOrder.push(index);
        pendingCallback = callback;
        Promise.resolve()
          .then(() => {
            callbackOrder.push(index);
            pendingCallback?.(null);
          })
          .catch(() => {});
        return true;
      },
      once() {
        return this;
      },
      off() {
        return this;
      },
    };

    await writeRequestBodyChunked(data, req);

    expect(writeOrder).toEqual([0, 1]);
    expect(callbackOrder).toEqual([0, 1]);
  });

  test('waits for drain before writing the next chunk', async () => {
    const data = Buffer.alloc(REQUEST_BODY_CHUNK_SIZE * 2, 0xaa);
    const writeOrder: number[] = [];
    const req = new EventEmitter() as EventEmitter &
      RequestBodyWritable & { destroyed: boolean };
    req.destroyed = false;
    req.setHeader = () => {};

    let writeIndex = 0;
    req.write = (_data, callback) => {
      const index = writeIndex++;
      writeOrder.push(index);
      callback?.(null);
      return index !== 0;
    };

    const writePromise = writeRequestBodyChunked(data, req);

    await Promise.resolve();

    expect(writeOrder).toEqual([0]);

    req.emit('drain');
    await writePromise;

    expect(writeOrder).toEqual([0, 1]);
  });
});
