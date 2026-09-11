// cspell:ignore résumé
import { EventEmitter } from 'node:events';
import { describe, expect, test } from 'bun:test';
import {
  calculateMultipartFormDataSize,
  generateMultipartBoundary,
  sanitizeContentType,
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

  test('rejects when a blob yields fewer bytes than its declared size', async () => {
    // `Content-Length` is computed from `Blob.size` in the sizing pass, but the streaming
    // pass writes whatever `Blob.stream()` actually yields. A `File` backed by a file
    // another process is rotating can yield less, and nothing is destroyed - so the inner
    // loop exits through `isDone`, every delimiter is written, and the body used to go out
    // short of the length already on the wire. Node does not check a `ClientRequest` for a
    // shortfall, so the caller hangs on a server waiting for bytes that never come.
    // A stub rather than a real `FormData`: `append(name, blob, filename)` builds a fresh
    // `File` from the blob per spec, so a subclass overriding `size` and `stream` does not
    // survive being put in one. Both passes only ever call `entries()`, then read `name`,
    // `type`, `size` and `stream()` off the value.
    const shortFile = {
      name: 'short.bin',
      type: 'application/octet-stream',
      // Claims ten bytes; its stream yields four.
      size: 10,
      stream: () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3, 4]));
            controller.close();
          },
        }),
    };

    const fd = {
      entries: () => [['file', shortFile]][Symbol.iterator](),
    } as unknown as FormData;

    const { req, headers } = makeCapture();
    const boundary = generateMultipartBoundary();

    let caught: Error | undefined;
    try {
      await serializeMultipartFormData(fd, req, boundary);
    } catch (error) {
      caught = error as Error;
    }

    expect(req.destroyed).toBe(false);
    expect(headers['content-length']).toBeDefined();
    expect(caught?.message).toBe(
      'Request stream closed before the body was fully written',
    );
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

    let caught: Error | undefined;
    try {
      await serializeMultipartFormData(fd, req, boundary);
    } catch (error) {
      caught = error as Error;
    }

    // Stops writing, and says so: the closing `--boundary--` delimiter was never written,
    // so resolving would hand the server a body it reads as truncated while this side
    // called the upload a success.
    expect(writeCalls).toBeLessThan(10);
    expect(caught?.message).toBe(
      'Request stream closed before the body was fully written',
    );
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

    let caught: Error | undefined;
    try {
      await serializeMultipartFormData(fd, req, boundary);
    } catch (error) {
      caught = error as Error;
    }

    expect(didSeeFirstBinaryChunk).toBe(true);
    expect(readCount).toBeGreaterThanOrEqual(1);
    expect(binaryChunkWriteCount).toBe(1);
    expect(cancelCount).toBe(1);
    // The reader is cancelled *and* the truncated body is reported as a failed upload.
    expect(caught?.message).toBe(
      'Request stream closed before the body was fully written',
    );
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

  test('sanitizes CR/LF in a Content-Type to prevent header injection', () => {
    // Asserted against the sanitizer directly rather than through a `File`. As of Bun
    // 1.4.0 the `File` constructor rejects a type containing CR/LF and `FormData.append`
    // clones the file, so neither route can deliver the malicious value any more - the
    // fixture, not the protection, is what stopped working. Pinning the sanitizer keeps
    // the guarantee under test on a runtime that does not police the type for us.
    expect(sanitizeContentType('text/plain\r\nX-Injected: yes')).toBe(
      'text/plainX-Injected: yes',
    );
    expect(sanitizeContentType('text/plain\nX-Injected: yes')).toBe(
      'text/plainX-Injected: yes',
    );
    expect(sanitizeContentType('text/plain\rX-Injected: yes')).toBe(
      'text/plainX-Injected: yes',
    );
    expect(sanitizeContentType('text/plain')).toBe('text/plain');

    // Whatever it returns must never carry a header separator.
    for (const raw of [
      'a\r\nb',
      '\r\n\r\n',
      'x\ny\rz',
      'text/plain\r\n\r\nGET / HTTP/1.1',
    ]) {
      const sanitized = sanitizeContentType(raw);

      expect(sanitized).not.toContain('\r');
      expect(sanitized).not.toContain('\n');
    }
  });

  test('sanitized Content-Type: size matches actual byte length', async () => {
    // The size calculation and the serializer must agree on the sanitized type. A plain
    // type exercises the same path now that no runtime lets a CR/LF one through a
    // `FormData`; the sanitizer's own behaviour is pinned in the test above.
    const fd = new FormData();
    fd.append('file', new File(['data'], 'test.txt', { type: 'text/plain' }));

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

  test('rejects when req emits close during backpressure wait', async () => {
    // It used to resolve, and that reported parts as written when the stream had not
    // accepted them - leaving a multipart body without its closing `--boundary--`
    // delimiter while this side called the upload a success. A truncated write is a failed
    // write; the adapter turns the rejection into a transport error.
    const fd = new FormData();
    fd.append('field', 'value');

    const req = new EventEmitter() as EventEmitter &
      RequestBodyWritable & { destroyed: boolean };
    req.destroyed = false;
    req.setHeader = () => {};

    let writeIndex = 0;
    req.write = (_data, callback) => {
      const index = writeIndex++;
      callback?.(null);
      return index !== 0;
    };

    const boundary = generateMultipartBoundary();
    const writePromise = serializeMultipartFormData(fd, req, boundary);

    await Promise.resolve();

    req.emit('close');

    let caught: Error | undefined;

    try {
      await writePromise;
    } catch (error) {
      caught = error as Error;
    }

    expect(caught?.message).toBe(
      'Request stream closed before the body was fully written',
    );
  });

  test('no upload progress is reported after the write has already rejected', async () => {
    // `maybeResolve` does more than resolve: it advances `uploadedBytes` and fires
    // `onProgress`. Its sibling in `request-body-writer` keeps an `isSettled` guard and
    // this one did not, which only started to matter once `onClose` began *rejecting*.
    // Under backpressure a `'drain'` can arrive before the write callback - so `cleanup`
    // has not run and the listeners are still attached - then `'close'` rejects the
    // upload, and the write callback lands afterwards and reports progress for a request
    // already surfaced to the caller as a transport error, counting bytes the stream
    // never accepted.
    const fd = new FormData();
    fd.append('field', 'value');

    const req = new EventEmitter() as EventEmitter &
      RequestBodyWritable & { destroyed: boolean };
    req.destroyed = false;
    req.setHeader = () => {};

    let pendingCallback: ((error?: Error | null) => void) | undefined;
    let writeIndex = 0;

    req.write = (_data, callback) => {
      const index = writeIndex++;

      if (index === 0) {
        // Backpressure, with the callback deliberately held back.
        pendingCallback = callback;

        return false;
      }

      callback?.(null);

      return true;
    };

    const progress: number[] = [];
    const boundary = generateMultipartBoundary();
    const writePromise = serializeMultipartFormData(fd, req, boundary, (e) => {
      progress.push(e.loaded);
    });

    await Promise.resolve();

    // `'drain'` first, while the write callback is still outstanding.
    req.emit('drain');
    req.emit('close');

    let caught: Error | undefined;

    try {
      await writePromise;
    } catch (error) {
      caught = error as Error;
    }

    expect(caught?.message).toBe(
      'Request stream closed before the body was fully written',
    );

    const afterRejection = progress.length;

    // The held-back callback lands last, on a write that was already reported as failed.
    pendingCallback?.(null);

    await Promise.resolve();

    expect(progress.length).toBe(afterRejection);
  });

  test('rejects when req emits error during backpressure wait', async () => {
    const fd = new FormData();
    fd.append('field', 'value');

    const req = new EventEmitter() as EventEmitter &
      RequestBodyWritable & { destroyed: boolean };
    req.destroyed = false;
    req.setHeader = () => {};

    let writeIndex = 0;
    req.write = (_data, callback) => {
      const index = writeIndex++;
      callback?.(null);
      return index !== 0;
    };

    const boundary = generateMultipartBoundary();
    const writePromise = serializeMultipartFormData(fd, req, boundary);

    await Promise.resolve();

    req.emit('error', new Error('socket hang up'));

    let caught: Error | undefined;
    try {
      await writePromise;
    } catch (error) {
      caught = error as Error;
    }

    expect(caught?.message).toBe('socket hang up');
  });

  test('rejects immediately when req.destroyed at time drain listeners are registered', async () => {
    // It used to resolve, and that reported parts as written when the stream had not
    // accepted them - leaving a multipart body without its closing `--boundary--`
    // delimiter while this side called the upload a success. A truncated write is a failed
    // write; the adapter turns the rejection into a transport error.
    const fd = new FormData();
    fd.append('field', 'value');

    // req becomes destroyed synchronously after write() returns false,
    // triggering the race-condition guard at line 329 in multipart.ts
    let writeIndex = 0;
    const req: RequestBodyWritable = {
      get destroyed() {
        // Destroyed only after the first write has returned false
        return writeIndex > 0;
      },
      setHeader() {},
      write(_data, callback) {
        const index = writeIndex++;
        callback?.(null);
        // First write returns false to trigger backpressure path
        return index !== 0;
      },
      once() {
        return this;
      },
      off() {
        return this;
      },
    };

    const boundary = generateMultipartBoundary();

    // Settles without hanging - the destroyed guard calls `onClose()` immediately - and
    // settles as a failure, because a write into an already-destroyed stream delivered
    // nothing.
    let caught: Error | undefined;

    try {
      await serializeMultipartFormData(fd, req, boundary);
    } catch (error) {
      caught = error as Error;
    }

    expect(caught?.message).toBe(
      'Request stream closed before the body was fully written',
    );
  });

  test('leaves no listeners behind when a write callback errors synchronously', async () => {
    // `write` answering `false` *and* invoking its callback with an error in the same turn
    // settled the write before any listener existed, then attached `drain`, `close` and
    // `error` anyway - and the `req.destroyed` guard's `onClose()` returned early on
    // `isSettled` instead of cleaning up. The three listeners stayed on the request with
    // nothing left to remove them.
    const fd = new FormData();
    fd.append('field', 'value');

    const attached: string[] = [];
    const removed: string[] = [];
    let writeCount = 0;
    const req: RequestBodyWritable = {
      // Destroyed the moment the first write has been refused, which is what makes the
      // `req.destroyed` guard below the listener registration run.
      get destroyed() {
        return writeCount > 0;
      },
      setHeader() {},
      write(_data, callback) {
        writeCount++;
        callback?.(new Error('write refused'));

        return false;
      },
      once(event: string) {
        attached.push(event);

        return this;
      },
      off(event: string) {
        removed.push(event);

        return this;
      },
    };

    const boundary = generateMultipartBoundary();
    let caught: Error | undefined;

    try {
      await serializeMultipartFormData(fd, req, boundary);
    } catch (error) {
      caught = error as Error;
    }

    expect(caught?.message).toBe('write refused');

    // Nothing to wait for once the write has already been rejected, so nothing is armed -
    // and therefore nothing is left armed.
    expect(attached).toEqual([]);
    expect(attached.filter((event) => !removed.includes(event))).toEqual([]);
  });

  test('cancels reader when req.destroyed flips between reader.read() result and write()', async () => {
    let readCount = 0;
    let cancelCount = 0;
    let isDestroyed = false;

    const fd = {
      *entries() {
        yield [
          'upload',
          {
            name: 'data.bin',
            type: 'application/octet-stream',
            size: 3,
            stream() {
              return new ReadableStream<Uint8Array>({
                pull(controller) {
                  readCount++;
                  // Set destroyed before the chunk value reaches the caller so
                  // the post-read req.destroyed check (lines 380-382) fires.
                  isDestroyed = true;
                  controller.enqueue(new Uint8Array([1, 2, 3]));
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
      write(_data, callback) {
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

    let caught: Error | undefined;
    try {
      await serializeMultipartFormData(fd, req, boundary);
    } catch (error) {
      caught = error as Error;
    }

    expect(readCount).toBe(1);
    expect(cancelCount).toBe(1);
    // The reader is cancelled *and* the truncated body is reported as a failed upload.
    expect(caught?.message).toBe(
      'Request stream closed before the body was fully written',
    );
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
