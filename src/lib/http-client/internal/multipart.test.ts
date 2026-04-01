// cspell:ignore résumé
import { EventEmitter } from 'node:events';
import { describe, expect, test } from 'bun:test';
import {
  calculateMultipartFormDataSize,
  generateMultipartBoundary,
  serializeMultipartFormData,
} from './multipart';
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
  const headers: Record<string, string> = {};
  const writes: CapturedWrite[] = [];
  let totalBytesWritten = 0;

  const req: RequestBodyWritable = {
    destroyed: false,
    setHeader(name, value) {
      headers[name.toLowerCase()] = value;
    },
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
    headers,
    writes,
    getBody: () => Buffer.concat(writes.map((w) => w.data)),
  };
}

describe('generateMultipartBoundary', () => {
  test('returns a non-empty string', () => {
    expect(generateMultipartBoundary().length).toBeGreaterThan(0);
  });

  test('includes the NodeAdapterFormBoundary prefix', () => {
    expect(generateMultipartBoundary()).toContain('NodeAdapterFormBoundary');
  });

  test('returns unique values on repeated calls', () => {
    const a = generateMultipartBoundary();
    const b = generateMultipartBoundary();

    expect(a).not.toBe(b);
  });
});

describe('calculateMultipartFormDataSize', () => {
  test('size matches actual serialized byte length for string fields', async () => {
    const fd = new FormData();

    fd.append('username', 'alice');
    fd.append('message', 'hello world');

    const { req, getBody } = makeCapture();
    const boundary = generateMultipartBoundary();

    await serializeMultipartFormData(fd, req, boundary);
    expect(calculateMultipartFormDataSize(fd, boundary)).toBe(getBody().length);
  });

  test('size matches actual serialized byte length for a file entry', async () => {
    const fd = new FormData();

    fd.append(
      'avatar',
      new File(['hello file content'], 'avatar.png', { type: 'image/png' }),
    );

    const { req, getBody } = makeCapture();
    const boundary = generateMultipartBoundary();

    await serializeMultipartFormData(fd, req, boundary);
    expect(calculateMultipartFormDataSize(fd, boundary)).toBe(getBody().length);
  });

  test('size matches for mixed string and file fields', async () => {
    const fd = new FormData();
    fd.append('name', 'bob');
    fd.append(
      'data',
      new File(['binary'], 'data.bin', { type: 'application/octet-stream' }),
    );
    fd.append('extra', 'value');

    const { req, getBody } = makeCapture();
    const boundary = generateMultipartBoundary();

    await serializeMultipartFormData(fd, req, boundary);
    expect(calculateMultipartFormDataSize(fd, boundary)).toBe(getBody().length);
  });

  test('returns just the closing boundary line for empty FormData', () => {
    const fd = new FormData();
    const boundary = generateMultipartBoundary();
    const size = calculateMultipartFormDataSize(fd, boundary);
    expect(size).toBe(Buffer.byteLength(`--${boundary}--\r\n`));
  });
});

describe('serializeMultipartFormData', () => {
  test('sets Content-Type header with boundary', async () => {
    const fd = new FormData();
    fd.append('field', 'value');
    const { req, headers } = makeCapture();

    const boundary = generateMultipartBoundary();
    await serializeMultipartFormData(fd, req, boundary);

    expect(headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
  });

  test('sets Content-Length header matching actual body size', async () => {
    const fd = new FormData();
    fd.append('field', 'value');
    const { req, headers, getBody } = makeCapture();

    const boundary = generateMultipartBoundary();
    await serializeMultipartFormData(fd, req, boundary);

    expect(parseInt(headers['content-length'], 10)).toBe(getBody().length);
  });

  test('body contains field name and value', async () => {
    const fd = new FormData();
    fd.append('username', 'alice');
    const { req, getBody } = makeCapture();

    const boundary = generateMultipartBoundary();
    await serializeMultipartFormData(fd, req, boundary);

    const body = getBody().toString('utf8');
    expect(body).toContain('name="username"');
    expect(body).toContain('alice');
  });

  test('escapes quoted field names and strips CRLF from multipart headers', async () => {
    const fd = new FormData();
    fd.append('meta"\r\nX-Bad: yes', 'value');
    const { req, getBody } = makeCapture();

    const boundary = generateMultipartBoundary();
    await serializeMultipartFormData(fd, req, boundary);

    const body = getBody().toString('utf8');
    expect(body).toContain('name="meta\\" X-Bad: yes"');
    expect(body).not.toContain('name="meta"\r\nX-Bad: yes"');
  });

  test('body contains file part with filename and content-type', async () => {
    const fd = new FormData();
    fd.append(
      'photo',
      new File(['imgdata'], 'photo.jpg', { type: 'image/jpeg' }),
    );
    const { req, getBody } = makeCapture();

    const boundary = generateMultipartBoundary();
    await serializeMultipartFormData(fd, req, boundary);

    const body = getBody().toString('utf8');
    expect(body).toContain('name="photo"');
    expect(body).toContain('filename="photo.jpg"');
    expect(body).toContain('Content-Type: image/jpeg');
    expect(body).toContain('imgdata');
  });

  test('escapes file field names before writing Content-Disposition', async () => {
    const fd = new FormData();
    fd.append(
      'up"\nload',
      new File(['imgdata'], 'photo.jpg', { type: 'image/jpeg' }),
    );
    const { req, getBody } = makeCapture();

    const boundary = generateMultipartBoundary();
    await serializeMultipartFormData(fd, req, boundary);

    const body = getBody().toString('utf8');
    expect(body).toContain('name="up\\" load"; filename="photo.jpg"');
  });

  test('non-ASCII filename uses ASCII fallback plus RFC 5987 filename* form', async () => {
    const fd = new FormData();
    fd.append(
      'cv',
      new File(['content'], 'résumé.pdf', { type: 'application/pdf' }),
    );

    const { req, getBody } = makeCapture();

    const boundary = generateMultipartBoundary();
    await serializeMultipartFormData(fd, req, boundary);

    const body = getBody().toString('utf8');
    expect(body).toContain('filename="resume.pdf"');
    expect(body).toContain("filename*=UTF-8''r%C3%A9sum%C3%A9.pdf");
  });

  test('non-ASCII filename: size matches actual byte length', async () => {
    const fd = new FormData();
    fd.append(
      'cv',
      new File(['content'], 'résumé.pdf', { type: 'application/pdf' }),
    );

    const { req, getBody } = makeCapture();
    const boundary = generateMultipartBoundary();

    await serializeMultipartFormData(fd, req, boundary);
    expect(calculateMultipartFormDataSize(fd, boundary)).toBe(getBody().length);
  });

  test('ASCII filename uses simple filename= form only (no filename*)', async () => {
    const fd = new FormData();
    fd.append(
      'doc',
      new File(['data'], 'report.pdf', { type: 'application/pdf' }),
    );

    const { req, getBody } = makeCapture();

    const boundary = generateMultipartBoundary();
    await serializeMultipartFormData(fd, req, boundary);

    const body = getBody().toString('utf8');
    expect(body).toContain('filename="report.pdf"');
    expect(body).not.toContain('filename*=');
  });

  test('safe ASCII filenames preserve spaces and punctuation without filename*', async () => {
    const fd = new FormData();
    fd.append(
      'doc',
      new File(['data'], 'Q1 report (final).pdf', {
        type: 'application/pdf',
      }),
    );

    const { req, getBody } = makeCapture();

    const boundary = generateMultipartBoundary();
    await serializeMultipartFormData(fd, req, boundary);

    const body = getBody().toString('utf8');
    expect(body).toContain('filename="Q1 report (final).pdf"');
    expect(body).not.toContain('filename*=UTF-8');
  });

  test('quoted filenames use sanitized fallback plus filename*', async () => {
    const fd = new FormData();
    fd.append(
      'doc',
      new File(['data'], 'my "draft".txt', { type: 'text/plain' }),
    );

    const { req, getBody } = makeCapture();

    const boundary = generateMultipartBoundary();
    await serializeMultipartFormData(fd, req, boundary);

    const body = getBody().toString('utf8');
    expect(body).toContain('filename="my_draft_.txt"');
    expect(body).toContain("filename*=UTF-8''my%20%22draft%22.txt");
  });

  test('file with no type defaults to application/octet-stream', async () => {
    const fd = new FormData();
    fd.append('bin', new File(['data'], 'dump.bin'));
    const { req, getBody } = makeCapture();

    const boundary = generateMultipartBoundary();
    await serializeMultipartFormData(fd, req, boundary);

    expect(getBody().toString()).toContain(
      'Content-Type: application/octet-stream',
    );
  });

  test('file with no name defaults to "blob"', async () => {
    const fd = new FormData();
    fd.append('blob', new Blob(['data']));
    const { req, getBody } = makeCapture();

    const boundary = generateMultipartBoundary();
    await serializeMultipartFormData(fd, req, boundary);

    expect(getBody().toString()).toContain('filename="blob"');
  });

  test('body starts and ends with correct boundaries', async () => {
    const fd = new FormData();
    fd.append('x', 'y');
    const { req, headers, getBody } = makeCapture();

    const boundary = generateMultipartBoundary();
    await serializeMultipartFormData(fd, req, boundary);

    const contentType = headers['content-type'];
    const body = getBody().toString('utf8');

    expect(contentType).toBe(`multipart/form-data; boundary=${boundary}`);
    expect(body).toContain(`--${boundary}\r\n`);
    expect(body.endsWith(`--${boundary}--\r\n`)).toBe(true);
  });

  test('multiple fields each get their own boundary delimiter', async () => {
    const fd = new FormData();
    fd.append('a', '1');
    fd.append('b', '2');
    fd.append('c', '3');
    const { req, headers, getBody } = makeCapture();

    const boundary = generateMultipartBoundary();
    await serializeMultipartFormData(fd, req, boundary);

    const body = getBody().toString('utf8');
    expect(headers['content-type']).toBe(
      `multipart/form-data; boundary=${boundary}`,
    );
    const openCount = (body.match(new RegExp(`--${boundary}\r\n`, 'g')) ?? [])
      .length;
    expect(openCount).toBe(3);
  });

  test('fires upload progress events that sum to 100%', async () => {
    const fd = new FormData();
    fd.append('field', 'value');
    const { req } = makeCapture();
    const events: number[] = [];

    const boundary = generateMultipartBoundary();
    await serializeMultipartFormData(fd, req, boundary, (e) => {
      events.push(e.progress);
    });

    expect(events.length).toBeGreaterThan(0);
    expect(events[events.length - 1]).toBe(1);

    for (let i = 1; i < events.length; i++) {
      expect(events[i]).toBeGreaterThanOrEqual(events[i - 1]);
    }
  });

  test('upload progress total matches Content-Length', async () => {
    const fd = new FormData();
    fd.append('field', 'hello');
    const { req, headers } = makeCapture();
    const totals = new Set<number>();

    const boundary = generateMultipartBoundary();
    await serializeMultipartFormData(fd, req, boundary, (e) => {
      totals.add(e.total);
    });

    const contentLength = parseInt(headers['content-length'], 10);
    expect(totals.size).toBe(1);
    expect([...totals][0]).toBe(contentLength);
  });

  test('stops writing if req.destroyed is true mid-loop', async () => {
    const fd = new FormData();
    fd.append('a', '1');
    fd.append('b', '2');

    let writeCalls = 0;
    const req: RequestBodyWritable = {
      get destroyed() {
        return writeCalls >= 3;
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

    const boundary = generateMultipartBoundary();
    await serializeMultipartFormData(fd, req, boundary);
    expect(writeCalls).toBeLessThan(10);
  });

  test('cancels an in-flight file reader when req.destroyed flips mid-file', async () => {
    const chunks = [
      new Uint8Array([1, 2, 3]),
      new Uint8Array([4, 5, 6]),
      new Uint8Array([7, 8, 9]),
    ];
    let readCount = 0;
    let cancelCount = 0;
    let isDestroyed = false;
    let didSeeFirstBinaryChunk = false;
    let binaryChunkWriteCount = 0;
    const fd = {
      *entries() {
        yield [
          'upload',
          {
            name: 'video.bin',
            type: 'application/octet-stream',
            size: chunks.reduce((total, chunk) => total + chunk.length, 0),
            stream() {
              return new ReadableStream<Uint8Array>({
                pull(controller) {
                  const chunk = chunks[readCount++];

                  if (chunk) {
                    controller.enqueue(chunk);
                    return;
                  }

                  controller.close();
                },
                cancel() {
                  cancelCount++;
                },
              });
            },
          },
        ];
      },
    } as unknown as FormData;

    const req: RequestBodyWritable = {
      get destroyed() {
        return isDestroyed;
      },
      setHeader() {},
      write(data, callback) {
        const buf = Buffer.isBuffer(data)
          ? data
          : typeof data === 'string'
            ? Buffer.from(data)
            : Buffer.from(data);

        if (chunks.some((chunk) => buf.equals(Buffer.from(chunk)))) {
          binaryChunkWriteCount++;

          if (!didSeeFirstBinaryChunk && buf.equals(Buffer.from(chunks[0]))) {
            didSeeFirstBinaryChunk = true;
            isDestroyed = true;
          }
        }

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

    const boundary = generateMultipartBoundary();
    await serializeMultipartFormData(fd, req, boundary);

    expect(didSeeFirstBinaryChunk).toBe(true);
    expect(readCount).toBeGreaterThanOrEqual(1);
    expect(binaryChunkWriteCount).toBe(1);
    expect(cancelCount).toBe(1);
  });

  test('rejects when write callback fires an error during string field', async () => {
    const fd = new FormData();
    fd.append('field', 'value');
    const { req } = makeCapture({ errorAfterBytes: 1 });

    let caught: Error | undefined;
    try {
      const boundary = generateMultipartBoundary();
      await serializeMultipartFormData(fd, req, boundary);
    } catch (error) {
      caught = error as Error;
    }

    expect(caught?.message).toBe('Simulated write error');
  });

  test('rejects when write callback fires an error mid-blob-stream', async () => {
    const fd = new FormData();
    fd.append(
      'file',
      new File([new Uint8Array(500).fill(0x41)], 'data.bin', {
        type: 'application/octet-stream',
      }),
    );

    const { req } = makeCapture({ errorAfterBytes: 150 });

    let caught: Error | undefined;
    try {
      const boundary = generateMultipartBoundary();
      await serializeMultipartFormData(fd, req, boundary);
    } catch (error) {
      caught = error as Error;
    }

    expect(caught?.message).toBe('Simulated write error');
  });

  test('strips control characters from field names', async () => {
    const fd = new FormData();
    fd.append('field\u0000\u0001\u0008name', 'value');
    const { req, getBody } = makeCapture();

    const boundary = generateMultipartBoundary();
    await serializeMultipartFormData(fd, req, boundary);

    const body = getBody().toString('utf8');
    expect(body).toContain('name="fieldname"');
    expect(body).not.toContain('\u0000');
    expect(body).not.toContain('\u0001');
  });

  test('strips control characters from field names: size matches byte length', async () => {
    const fd = new FormData();
    fd.append('field\u0000\u007Fname', 'value');

    const { req, getBody } = makeCapture();
    const boundary = generateMultipartBoundary();

    await serializeMultipartFormData(fd, req, boundary);
    expect(calculateMultipartFormDataSize(fd, boundary)).toBe(getBody().length);
  });

  test('sanitizes CR/LF in File.type to prevent header injection', async () => {
    const fd = new FormData();
    fd.append(
      'file',
      new File(['data'], 'test.txt', {
        type: 'text/plain\r\nX-Injected: yes',
      }),
    );
    const { req, getBody } = makeCapture();

    const boundary = generateMultipartBoundary();
    await serializeMultipartFormData(fd, req, boundary);

    const body = getBody().toString('utf8');
    expect(body).toContain('Content-Type: text/plainx-injected: yes');
    expect(body).not.toContain('Content-Type: text/plain\r\nx-injected: yes');
  });

  test('sanitized Content-Type: size matches actual byte length', async () => {
    const fd = new FormData();
    fd.append(
      'file',
      new File(['data'], 'test.txt', {
        type: 'text/plain\r\nX-Injected: yes',
      }),
    );

    const { req, getBody } = makeCapture();
    const boundary = generateMultipartBoundary();

    await serializeMultipartFormData(fd, req, boundary);
    expect(calculateMultipartFormDataSize(fd, boundary)).toBe(getBody().length);
  });

  test('write callbacks are awaited — writes are sequential not concurrent', async () => {
    const fd = new FormData();
    fd.append('a', '1');
    fd.append('b', '2');

    const writeOrder: number[] = [];
    const callbackOrder: number[] = [];
    let writeIndex = 0;

    const req: RequestBodyWritable = {
      destroyed: false,
      setHeader() {},
      write(_data, callback) {
        const index = writeIndex++;
        writeOrder.push(index);
        Promise.resolve()
          .then(() => {
            callbackOrder.push(index);
            callback?.(null);
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

    const boundary = generateMultipartBoundary();
    await serializeMultipartFormData(fd, req, boundary);

    expect(writeOrder.length).toBeGreaterThan(0);
    expect(callbackOrder).toEqual(writeOrder);
  });

  test('waits for drain before writing the next multipart chunk', async () => {
    const fd = new FormData();
    fd.append('field', 'value');

    const req = new EventEmitter() as EventEmitter &
      RequestBodyWritable & { destroyed: boolean };
    req.destroyed = false;
    req.setHeader = () => {};

    const writeOrder: number[] = [];
    let writeIndex = 0;

    req.write = (_data, callback) => {
      const index = writeIndex++;
      writeOrder.push(index);
      callback?.(null);
      return index !== 0;
    };

    const boundary = generateMultipartBoundary();
    const writePromise = serializeMultipartFormData(fd, req, boundary);

    await Promise.resolve();

    expect(writeOrder).toEqual([0]);

    req.emit('drain');
    await writePromise;

    expect(writeOrder.length).toBeGreaterThan(1);
  });
});
