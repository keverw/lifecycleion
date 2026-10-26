// cspell:ignore résumé
import { EventEmitter } from 'node:events';
import * as vm from 'node:vm';
import { describe, expect, test, spyOn } from 'bun:test';
import {
  calculateMultipartFormDataSize,
  generateMultipartBoundary,
  sanitizeContentType,
  serializeMultipartFormData,
} from './multipart';
import type { RequestBodyWritable } from './request-body-writable';
import { REQUEST_BODY_CHUNK_SIZE } from './request-body-writer';
import { NON_RETRYABLE_HTTP_ADAPTER_ERROR_FLAG } from '../consts';
import {
  scriptFormEntries,
  useScriptedFormEntries,
} from '../test-helpers/scripted-form-entries';

useScriptedFormEntries();

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
  test('uses 128 cryptographic bits without consulting Math.random', () => {
    const random = spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('weak randomness');
    });
    const secure = spyOn(crypto, 'getRandomValues');
    try {
      expect(generateMultipartBoundary()).toMatch(
        /^----NodeAdapterFormBoundary[0-9a-f]{32}$/,
      );
      expect(secure).toHaveBeenCalledTimes(1);
      expect(secure.mock.calls[0]?.[0]?.byteLength).toBe(16);
      expect(random).not.toHaveBeenCalled();
    } finally {
      random.mockRestore();
      secure.mockRestore();
    }
  });

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

  test('percent-encodes quotes and line breaks in field names, as fetch does', async () => {
    const fd = new FormData();
    fd.append('meta"\r\nX-Bad: yes', 'value');
    const { req, getBody } = makeCapture();

    const boundary = generateMultipartBoundary();
    await serializeMultipartFormData(fd, req, boundary);

    const body = getBody().toString('utf8');
    expect(body).toContain('name="meta%22%0D%0AX-Bad: yes"');
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
    expect(body).toContain('name="up%22%0D%0Aload"; filename="photo.jpg"');
  });

  test('non-ASCII filename is sent as UTF-8 with no filename* form', async () => {
    const fd = new FormData();
    fd.append(
      'cv',
      new File(['content'], 'résumé.pdf', { type: 'application/pdf' }),
    );

    const { req, getBody } = makeCapture();

    const boundary = generateMultipartBoundary();
    await serializeMultipartFormData(fd, req, boundary);

    const body = getBody().toString('utf8');
    expect(body).toContain('filename="résumé.pdf"');
    expect(body).not.toContain('filename*=');
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

  test('quotes in filenames are percent-encoded, as fetch does', async () => {
    const fd = new FormData();
    fd.append(
      'doc',
      new File(['data'], 'my "draft".txt', { type: 'text/plain' }),
    );

    const { req, getBody } = makeCapture();

    const boundary = generateMultipartBoundary();
    await serializeMultipartFormData(fd, req, boundary);

    const body = getBody().toString('utf8');
    expect(body).toContain('filename="my %22draft%22.txt"');
    expect(body).not.toContain('filename*=');
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
    // Scripted rather than appended (see `scriptFormEntries`): `append(name, blob,
    // filename)` builds a fresh `File` from the blob per spec, so a subclass overriding
    // `size` and `stream` does not survive being put in one. Both passes read only `name`,
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

    const fd = scriptFormEntries(new FormData(), () =>
      [['file', shortFile]][Symbol.iterator](),
    );

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
    expect(caught?.message).toContain('part expected 10 bytes, received 4');
  });

  test('rejects, and says so accurately, when a blob yields more than its size', async () => {
    // The mirror of the shortfall above, and not the same failure: the body overran a
    // `Content-Length` already on the wire, so the server reads the tail as the start of
    // another message. It was reported as "closed before the body was fully written",
    // which points at exactly the wrong end of the payload.
    const longFile = {
      name: 'long.bin',
      type: 'application/octet-stream',
      // Claims two bytes; its stream yields six.
      size: 2,
      stream: () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3, 4, 5, 6]));
            controller.close();
          },
        }),
    };

    const fd = scriptFormEntries(new FormData(), () =>
      [['file', longFile]][Symbol.iterator](),
    );

    const { req } = makeCapture();
    const boundary = generateMultipartBoundary();

    let caught: Error | undefined;

    try {
      await serializeMultipartFormData(fd, req, boundary);
    } catch (error) {
      caught = error as Error;
    }

    expect(caught?.message).toContain('Content-Length');
    expect(caught?.message).not.toContain('closed before');
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
    const fd = scriptFormEntries(new FormData(), function* () {
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
    });

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

  test('keeps other control characters in field names, as fetch does', async () => {
    const fd = new FormData();
    fd.append('field\u0000\u0001\u0008name', 'value');
    const { req, getBody } = makeCapture();

    const boundary = generateMultipartBoundary();
    await serializeMultipartFormData(fd, req, boundary);

    const body = getBody().toString('utf8');
    expect(body).toContain('name="field\u0000\u0001\u0008name"');
  });

  test('control characters in field names: size matches byte length', async () => {
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

  test('rejects when req emits close while a write waits for its callback', async () => {
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

    // Backpressured, with the callback held back: the write is not yet accepted.
    req.write = () => false;

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

  test('rejects when the socket dies under a write that was never backpressured', async () => {
    // The same hang `writeRequestBodyChunked` had: `'close'` and `'error'` were armed only
    // when `write()` asked for a drain, so a part the buffer took outright - callback
    // pending, no backpressure - had nothing listening when the connection dropped. The
    // upload promise never settled, and `node-adapter` hands that promise to the caller as
    // `requestBodySettled`.
    const fd = new FormData();
    fd.append('field', 'value');

    const req = new EventEmitter() as EventEmitter &
      RequestBodyWritable & { destroyed: boolean };
    req.destroyed = false;
    req.setHeader = () => {};

    // Accepted without backpressure, callback never called: what a `ClientRequest` does
    // with a part still in its buffer when the socket goes.
    req.write = () => true;

    const boundary = generateMultipartBoundary();
    const writePromise = serializeMultipartFormData(fd, req, boundary);

    await Promise.resolve();

    req.destroyed = true;
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

    expect(req.listenerCount('close')).toBe(0);
    expect(req.listenerCount('error')).toBe(0);
  });

  test('no upload progress is reported after the write has already rejected', async () => {
    // `maybeResolve` does more than resolve: it advances `uploadedBytes` and fires
    // `onProgress`. Its sibling in `request-body-writer` keeps an `isSettled` guard and
    // this one did not, which only started to matter once `onClose` began *rejecting*.
    // With the write callback still outstanding - so `cleanup` has not run and the
    // listeners are still attached - `'close'` rejects the upload, and the write callback
    // lands afterwards and reports progress for a request already surfaced to the caller
    // as a transport error, counting bytes the stream never accepted.
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

    // `'close'` while the write callback is still outstanding.
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

  test('rejects when req emits error while a write waits for its callback', async () => {
    const fd = new FormData();
    fd.append('field', 'value');

    const req = new EventEmitter() as EventEmitter &
      RequestBodyWritable & { destroyed: boolean };
    req.destroyed = false;
    req.setHeader = () => {};

    // Backpressured, with the callback held back: the write is not yet accepted.
    req.write = () => false;

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

  test('rejects immediately when req.destroyed at time its listeners are registered', async () => {
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

    const fd = scriptFormEntries(new FormData(), function* () {
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
    });

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

  test('waits for the write callback before writing the next multipart chunk', async () => {
    const fd = new FormData();
    fd.append('field', 'value');

    const req = new EventEmitter() as EventEmitter &
      RequestBodyWritable & { destroyed: boolean };
    req.destroyed = false;
    req.setHeader = () => {};

    const writeOrder: number[] = [];
    const callbacks: Array<(error?: Error | null) => void> = [];
    let writeIndex = 0;

    req.write = (_data, callback) => {
      writeOrder.push(writeIndex++);
      if (callback) {
        callbacks.push(callback);
      }
      return true;
    };

    const boundary = generateMultipartBoundary();
    const writePromise = serializeMultipartFormData(fd, req, boundary);

    await Promise.resolve();

    expect(writeOrder).toEqual([0]);

    // Accept each write as it comes; one is in flight at a time.
    while (callbacks.length > 0) {
      const callback = callbacks.shift();
      callback?.(null);
      await new Promise((resolve) => setImmediate(resolve));
      expect(callbacks.length).toBeLessThanOrEqual(1);
    }

    await writePromise;
    expect(writeOrder.length).toBeGreaterThan(1);
  });

  test('PR review round 54: a backpressured File chunk is accepted on its callback, with no drain', async () => {
    // Every `Blob.stream()` chunk Node yields is larger than a request's high-water mark,
    // so every one asks for a drain - and Node and Bun stop emitting `'drain'` once an
    // early response has ended. Waiting for it as well parked the writer on the first
    // chunk, and the adapter's stall watchdog then cut the upload short.
    const fd = new FormData();
    fd.append('file', new File([new Uint8Array(3 * 1024 * 1024)], 'big.bin'));

    const req = new EventEmitter() as EventEmitter &
      RequestBodyWritable & { destroyed: boolean };
    req.destroyed = false;
    req.setHeader = () => {};

    const chunks: Buffer[] = [];
    req.write = (data, callback) => {
      chunks.push(Buffer.from(data));
      // Asks for a drain that never comes; the callback still runs.
      setImmediate(() => callback?.(null));
      return false;
    };

    const boundary = generateMultipartBoundary();
    const outcome = await Promise.race([
      serializeMultipartFormData(fd, req, boundary).then(() => 'resolved'),
      new Promise((resolve) => setTimeout(() => resolve('pending'), 500)),
    ]);

    expect(outcome).toBe('resolved');
    expect(
      Buffer.concat(chunks).toString('latin1').endsWith(`--${boundary}--\r\n`),
    ).toBe(true);
  });
});

test.each([
  [3, 1],
  [1, 3],
])(
  'rejects offsetting multipart size changes (%p, %p)',
  async (firstSize, secondSize) => {
    const part = (length: number) => ({
      name: 'file.bin',
      type: 'application/octet-stream',
      size: 2,
      stream: () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(length).fill(65));
            controller.close();
          },
        }),
    });
    const form = scriptFormEntries(new FormData(), () =>
      [
        ['first', part(firstSize)],
        ['second', part(secondSize)],
      ][Symbol.iterator](),
    );
    const capture = makeCapture();
    let failure: unknown;
    try {
      await serializeMultipartFormData(form, capture.req, 'boundary');
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('Content-Length');
    expect(capture.getBody().toString()).not.toContain('name="second"');
    if (firstSize > 2) {
      expect(capture.getBody().toString()).not.toContain('AAA');
    }
  },
);

test('uses the original part size even when size changes after the sizing pass', async () => {
  let reads = 0;
  const file = {
    name: 'growing.bin',
    type: 'application/octet-stream',
    get size() {
      return ++reads === 1 ? 2 : 3;
    },
    stream: () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(3).fill(65));
          controller.close();
        },
      }),
  };
  const form = scriptFormEntries(new FormData(), () =>
    [['file', file]][Symbol.iterator](),
  );
  const capture = makeCapture();
  let failure: unknown;
  try {
    await serializeMultipartFormData(form, capture.req, 'boundary');
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect(capture.getBody().toString()).not.toContain('AAA');
});

test('round 129: a File named "" is sent as filename="", one with no name as blob', async () => {
  // Built by hand: Bun's FormData hands back an empty-named File with no `name` at all,
  // where Node's keeps `''`.
  const emptyNamed = Object.assign(new Blob(['x']), { name: '' });
  const unnamed = new Blob(['y']);
  const fd = scriptFormEntries(new FormData(), () =>
    [
      ['empty', emptyNamed],
      ['unnamed', unnamed],
    ][Symbol.iterator](),
  );
  const { req, getBody } = makeCapture();
  const boundary = generateMultipartBoundary();

  await serializeMultipartFormData(fd, req, boundary);
  const body = getBody().toString();
  expect(body).toContain('name="empty"; filename=""');
  expect(body).toContain('name="unnamed"; filename="blob"');
  expect(calculateMultipartFormDataSize(fd, boundary)).toBe(getBody().length);
});

test('PR review round 36: a field appended mid-upload is refused before any of its bytes go out', async () => {
  const fd = new FormData();
  fd.append('first', 'one');
  const { req, getBody } = makeCapture();
  const boundary = generateMultipartBoundary();
  const write = req.write.bind(req);
  let didAppend = false;
  req.write = (data, callback) => {
    if (!didAppend) {
      didAppend = true;
      fd.append('late', 'two');
    }

    return write(data, callback);
  };

  let failure: unknown;
  try {
    await serializeMultipartFormData(fd, req, boundary);
  } catch (error) {
    failure = error;
  }

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain('more than its Content-Length');
  // Only the first part's own delimiter: none of the appended part reached the wire.
  expect(getBody().toString().split(`--${boundary}\r\n`).length - 1).toBe(1);
});

test('PR review round 37: a File that outgrows its measured size is refused naming that part', async () => {
  // Claims two bytes; its stream yields six. Nothing else outgrew the body, so the message
  // names the part's size, not the body's `Content-Length`.
  const longFile = {
    name: 'long.bin',
    type: 'application/octet-stream',
    size: 2,
    stream: () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3, 4, 5, 6]));
          controller.close();
        },
      }),
  };
  const fd = scriptFormEntries(new FormData(), () =>
    [['file', longFile]][Symbol.iterator](),
  );
  const { req, getBody } = makeCapture();
  const boundary = generateMultipartBoundary();

  let failure: unknown;
  try {
    await serializeMultipartFormData(fd, req, boundary);
  } catch (error) {
    failure = error;
  }

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain(
    'part expected 2 bytes, produced more - 0 written and a further 6 refused',
  );
  expect((failure as Error).message).not.toContain(
    'more than its Content-Length',
  );
  expect(getBody().includes(Buffer.from([1, 2, 3]))).toBe(false);
});

test('PR review round 37: a chunk within its part but past the body total is refused before it is written', async () => {
  let wasGrownPartCancelled = false;
  // The grown part's stream stays open after its chunk, so only a cancel ends it.
  const blobPart = (name: string, bytes: number[], isLeftOpen = false) => ({
    name,
    type: 'application/octet-stream',
    size: bytes.length,
    stream: () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(bytes));
          if (!isLeftOpen) {
            controller.close();
          }
        },
        cancel() {
          if (isLeftOpen) {
            wasGrownPartCancelled = true;
          }
        },
      }),
  });
  const parts: [string, unknown][] = [
    ['first', blobPart('a', [1, 2])],
    ['second', blobPart('b', [7, 7, 7, 7])],
  ];
  // Read live, as a FormData is: the second part is swapped for one whose filename is
  // three bytes longer once the first part's bytes go out. Its headers still fit in the
  // bytes its payload was measured at; its payload, the right size for its part, does not.
  // An array's iterator reads each index as it reaches it.
  const fd = scriptFormEntries(new FormData(), () => parts[Symbol.iterator]());
  const { req, getBody } = makeCapture();
  const boundary = generateMultipartBoundary();
  const write = req.write.bind(req);
  req.write = (data, callback) => {
    if (Buffer.from(data as Uint8Array).equals(Buffer.from([1, 2]))) {
      parts[1] = ['second', blobPart('bbbb', [7, 7, 7, 7], true)];
    }

    return write(data, callback);
  };

  let failure: unknown;
  try {
    await serializeMultipartFormData(fd, req, boundary);
  } catch (error) {
    failure = error;
  }

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain('more than its Content-Length');
  expect(getBody().toString()).toContain('filename="bbbb"');
  expect(getBody().includes(Buffer.from([7]))).toBe(false);
  expect(wasGrownPartCancelled).toBe(true);
});

describe('PR review round 54: caller values the writer cannot use are refused as non-retryable', () => {
  // A `FormData` yielding the part as it is: Bun's `append` copies a `File` subclass into a
  // plain `File`, which would leave nothing to misbehave.
  const formWith = (part: unknown): FormData => {
    const fd = new FormData();

    scriptFormEntries(fd, function* (): Generator<[string, unknown]> {
      yield ['file', part];
    });

    return fd;
  };

  const failureOf = async (
    fd: FormData,
  ): Promise<{ error: Error; written: number }> => {
    const { req, writes } = makeCapture();
    let caught: unknown;

    try {
      await serializeMultipartFormData(fd, req, generateMultipartBoundary());
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(
      (caught as Record<string, unknown>)[
        NON_RETRYABLE_HTTP_ADAPTER_ERROR_FLAG
      ],
    ).toBe(true);

    return { error: caught as Error, written: writes.length };
  };

  test('a part whose type getter throws', async () => {
    const failure = new Error('type getter failed');

    class ThrowingTypeFile extends File {
      public override get type(): string {
        throw failure;
      }
    }

    const { error, written } = await failureOf(
      formWith(new ThrowingTypeFile([new Uint8Array(4)], 'a.bin')),
    );

    // Refused in the sizing pass, before anything was written.
    expect(written).toBe(0);
    expect(error.message).toBe('Request body source could not be read');
    expect(error.cause).toBe(failure);
  });

  test('a part whose type is not a string', async () => {
    class NumericTypeFile extends File {
      public override get type(): string {
        return 42 as unknown as string;
      }
    }

    const { error, written } = await failureOf(
      formWith(new NumericTypeFile([new Uint8Array(4)], 'a.bin')),
    );

    expect(written).toBe(0);
    expect(error.message).toBe('Request body source could not be read');
    expect(String((error.cause as Error).message)).not.toContain('42');
  });

  test('a part whose size is not a byte count', async () => {
    class FractionalSizeFile extends File {
      public override get size(): number {
        return 1.5;
      }
    }

    const { error, written } = await failureOf(
      formWith(new FractionalSizeFile([new Uint8Array(4)], 'a.bin')),
    );

    expect(written).toBe(0);
    expect(error.message).toBe('Request body source could not be read');
  });

  test('a form its entries cannot be read from: a Proxy over one', async () => {
    const { error, written } = await failureOf(new Proxy(new FormData(), {}));

    expect(written).toBe(0);
    expect(error.cause).toBeInstanceOf(TypeError);
  });

  test('a stream() that yields a chunk that is not a Uint8Array', async () => {
    class NumberStreamFile extends File {
      public override stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
        return new ReadableStream({
          start(controller) {
            controller.enqueue(42 as unknown as Uint8Array<ArrayBuffer>);
            controller.close();
          },
        });
      }
    }

    const { error } = await failureOf(
      formWith(new NumberStreamFile([new Uint8Array(4)], 'a.bin')),
    );

    expect(error.message).toBe(
      'Request body source produced a chunk that is not a Uint8Array',
    );
  });
});

describe('PR review round 54: source chunks the writing pass reads', () => {
  test('a stream() that yields the whole part as one chunk is written in REQUEST_BODY_CHUNK_SIZE slices', async () => {
    // Node's `Blob.stream()` yields an in-memory `Blob` as a single chunk. Written as one
    // `req.write`, a 64 MiB `File` reported no progress between 0 and 100%, and the
    // adapter's stall watchdog - which reads that progress - destroyed an upload the
    // server had acked early and was still reading.
    const size = 1024 * 1024 + 7;
    const source = new Uint8Array(size).map((_, index) => index % 251);

    class OneChunkFile extends File {
      public override stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
        return new ReadableStream({
          start(controller) {
            controller.enqueue(source);
            controller.close();
          },
        });
      }
    }

    const fd = new FormData();

    scriptFormEntries(fd, function* (): Generator<[string, unknown]> {
      yield ['file', new OneChunkFile([source], 'one.bin')];
    });

    const { req, writes, getBody } = makeCapture();
    const progress: number[] = [];

    await serializeMultipartFormData(
      fd,
      req,
      generateMultipartBoundary(),
      (e) => {
        progress.push(e.loaded);
      },
    );

    expect(
      writes.every((write) => write.data.length <= REQUEST_BODY_CHUNK_SIZE),
    ).toBe(true);
    expect(progress.length).toBeGreaterThan(size / REQUEST_BODY_CHUNK_SIZE);
    expect(getBody().includes(Buffer.from(source))).toBe(true);
  });

  test('a chunk made in another realm is written as the bytes it is', async () => {
    // `instanceof Uint8Array` is false for bytes from another realm - a `vm` context, or
    // Jest's node environment, whose `Blob.stream()` chunks come from the host - and the
    // refusal of chunks that are not bytes turned those away too.
    const foreign = vm.runInNewContext(
      'new Uint8Array([1, 2, 3])',
    ) as Uint8Array<ArrayBuffer>;

    expect(foreign instanceof Uint8Array).toBe(false);

    class ForeignChunkFile extends File {
      public override stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
        return new ReadableStream({
          start(controller) {
            controller.enqueue(foreign);
            controller.close();
          },
        });
      }
    }

    const fd = new FormData();

    scriptFormEntries(fd, function* (): Generator<[string, unknown]> {
      yield ['file', new ForeignChunkFile([new Uint8Array(3)], 'f.bin')];
    });

    const { req, getBody } = makeCapture();

    await serializeMultipartFormData(fd, req, generateMultipartBoundary());

    expect(getBody().includes(Buffer.from([1, 2, 3]))).toBe(true);
  });
});

describe('PR review round 54: source chunks are counted and sliced as the bytes they hold', () => {
  // A `File` whose `stream()` yields exactly `chunks`, with a `size` of `size`, in a
  // `FormData` that yields it as it is (Bun's `append` copies a `File` subclass).
  const formWithChunks = (
    chunks: Uint8Array[],
    size = chunks.reduce((total, chunk) => total + chunk.length, 0),
  ): FormData => {
    class ChunkedFile extends File {
      public override get size(): number {
        return size;
      }

      public override stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
        return new ReadableStream({
          start(controller) {
            for (const chunk of chunks) {
              controller.enqueue(chunk as Uint8Array<ArrayBuffer>);
            }

            controller.close();
          },
        });
      }
    }

    const fd = new FormData();

    scriptFormEntries(fd, function* (): Generator<[string, unknown]> {
      yield ['file', new ChunkedFile([], 'chunked.bin')];
    });

    return fd;
  };

  const send = async (
    fd: FormData,
    capture = makeCapture(),
  ): Promise<{
    capture: ReturnType<typeof makeCapture>;
    progress: number[];
    error: unknown;
  }> => {
    const progress: number[] = [];
    let failure: unknown;

    try {
      await serializeMultipartFormData(
        fd,
        capture.req,
        generateMultipartBoundary(),
        (e) => {
          progress.push(e.loaded);
        },
      );
    } catch (error) {
      failure = error;
    }

    return { capture, progress, error: failure };
  };

  test.each([
    ['an exact multiple of the slice size', 2 * REQUEST_BODY_CHUNK_SIZE],
    ['a single byte', 1],
    ['one byte past a slice', REQUEST_BODY_CHUNK_SIZE + 1],
  ])(
    'a chunk of %s is written whole, in slices, with progress ending at Content-Length',
    async (_label, length) => {
      const chunk = new Uint8Array(length).fill(0x7a);
      const { capture, progress, error } = await send(formWithChunks([chunk]));

      expect(error).toBeUndefined();

      const fileWrites = capture.writes.filter((write) =>
        write.data.every((byte) => byte === 0x7a),
      );

      expect(fileWrites.map((write) => write.data.length)).toEqual(
        Array.from(
          { length: Math.ceil(length / REQUEST_BODY_CHUNK_SIZE) },
          (_, index) =>
            Math.min(
              REQUEST_BODY_CHUNK_SIZE,
              length - index * REQUEST_BODY_CHUNK_SIZE,
            ),
        ),
      );
      expect(progress.at(-1)).toBe(Number(capture.headers['content-length']));
      expect(capture.getBody().length).toBe(
        Number(capture.headers['content-length']),
      );
    },
  );

  test('an empty chunk writes nothing and the part still completes', async () => {
    const { capture, progress, error } = await send(
      formWithChunks([new Uint8Array(0), new Uint8Array(3).fill(0x7a)]),
    );

    expect(error).toBeUndefined();
    expect(capture.writes.some((write) => write.data.length === 0)).toBe(false);
    expect(progress.at(-1)).toBe(Number(capture.headers['content-length']));
  });

  test('a stream destroyed between slices stops the part and fails the write', async () => {
    const capture = makeCapture();
    const { req } = capture;
    const write = req.write.bind(req);
    let fileSlices = 0;

    req.write = (data, callback) => {
      const isFileSlice =
        typeof data !== 'string' && data.length === REQUEST_BODY_CHUNK_SIZE;

      const canContinue = write(data, callback);

      if (isFileSlice && ++fileSlices === 1) {
        (req as { destroyed: boolean }).destroyed = true;
      }

      return canContinue;
    };

    const { error } = await send(
      formWithChunks([new Uint8Array(4 * REQUEST_BODY_CHUNK_SIZE)]),
      capture,
    );

    expect((error as Error).message).toBe(
      'Request stream closed before the body was fully written',
    );
    expect(fileSlices).toBe(1);
  });

  test('a subclass whose subarray throws is still written, from a plain view of its bytes', async () => {
    const failure = new Error('subarray failed');

    class ThrowingSubarray extends Uint8Array {
      public override subarray(): Uint8Array<ArrayBuffer> {
        throw failure;
      }
    }

    const { capture, progress, error } = await send(
      formWithChunks([new ThrowingSubarray(3).fill(0x7a)]),
    );

    // The chunk's own `subarray` is never called: it is sliced as a plain view.
    expect(error).toBeUndefined();
    expect(progress.at(-1)).toBe(Number(capture.headers['content-length']));
    expect(capture.getBody().includes(Buffer.from('zzz'))).toBe(true);
  });

  test('a subclass whose byteLength lies is counted by its real bytes', async () => {
    class ShortLength extends Uint8Array {
      public override get byteLength(): number {
        return 1;
      }
    }

    const { capture, progress, error } = await send(
      formWithChunks([new ShortLength(3).fill(0x7a)], 3),
    );

    expect(error).toBeUndefined();
    expect(progress.at(-1)).toBe(Number(capture.headers['content-length']));
    expect(capture.getBody().length).toBe(
      Number(capture.headers['content-length']),
    );
  });

  test('a subclass whose byteLength understates it is refused before a byte past its part', async () => {
    // Node's `Buffer.byteLength` reads the getter too, so a chunk that said 1 passed the
    // part's size check and the budget check, and put 16 KiB on the wire past a part of 4.
    class ShortLength extends Uint8Array {
      public override get byteLength(): number {
        return 1;
      }
    }

    const { capture, error } = await send(
      formWithChunks(
        [new ShortLength(2 * REQUEST_BODY_CHUNK_SIZE).fill(0x7a)],
        4,
      ),
    );

    expect((error as Error).message).toBe(
      `Request body source did not match its Content-Length: part expected 4 bytes, produced more - 0 written and a further ${String(2 * REQUEST_BODY_CHUNK_SIZE)} refused`,
    );
    expect(
      (error as Record<string, unknown>)[NON_RETRYABLE_HTTP_ADAPTER_ERROR_FLAG],
    ).toBe(true);
    expect(capture.getBody().includes(0x7a)).toBe(false);
  });
});

test('PR review round 75: a form is read through the intrinsic entries, not one it declares', async () => {
  const reported = (): Iterator<[string, string]> =>
    [['reported', 'not held'] as [string, string]][Symbol.iterator]();
  // A subclass's `entries`, and a form's own.
  class Reporting extends FormData {}
  Object.defineProperty(Reporting.prototype, 'entries', { value: reported });
  const subclass = new Reporting();
  subclass.append('held', 'value');
  const ownEntries = new FormData();
  ownEntries.append('held', 'value');
  Object.defineProperty(ownEntries, 'entries', { value: reported });

  for (const fd of [subclass, ownEntries]) {
    const { req, headers, getBody } = makeCapture();
    const boundary = generateMultipartBoundary();

    await serializeMultipartFormData(fd, req, boundary);
    const body = getBody().toString();

    expect(body).toContain('name="held"\r\n\r\nvalue\r\n');
    expect(body).not.toContain('reported');
    expect(headers['content-length']).toBe(String(getBody().length));
    expect(calculateMultipartFormDataSize(fd, boundary)).toBe(getBody().length);
  }
});
