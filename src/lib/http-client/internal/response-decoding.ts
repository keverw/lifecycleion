/**
 * Content-Encoding decoding for NodeAdapter responses.
 *
 * `fetch` (undici, Bun) and browsers decode a compressed response before handing over its
 * body, and so do axios and got on Node; Node's own `http.request` does not. NodeAdapter
 * decodes as they do, so the same request yields the same body on every adapter: a server
 * or CDN that sends `Content-Encoding: gzip` gave NodeAdapter callers the raw gzip bytes -
 * a JSON response that failed to parse - where FetchAdapter gave the JSON.
 *
 * The decoded body is offered through the same events the raw `IncomingMessage` emits -
 * `data`, `end`, `error`, `aborted`, `close` - and its `pause` / `resume`, so the buffered
 * and streamed paths read either one the same way.
 */

import { EventEmitter } from 'node:events';
import type * as http from 'node:http';
import { Transform, type TransformCallback } from 'node:stream';
import * as zlib from 'node:zlib';
import { hasResponseBody } from './response-limit';

/** The encodings NodeAdapter asks for and decodes, as `fetch` asks for them. */
export const ACCEPTED_CONTENT_ENCODINGS = 'gzip, deflate, br';

/**
 * The most codings a response may stack, as undici bounds it. Each is a decoder built on
 * the first byte, and a header of a few thousand `br,` - well under Node's header limit -
 * cost tens of megabytes per response before its one-byte body failed to decode.
 */
const MAX_CONTENT_CODINGS = 5;

/**
 * What the response paths read a body from: the raw `IncomingMessage`, or a decoded view of
 * it. Only the members they use.
 */
export interface ResponseBodySource {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the emitter signature
  on(event: string, listener: (...args: any[]) => void): unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the emitter signature
  off(event: string, listener: (...args: any[]) => void): unknown;
  pause(): unknown;
  resume(): unknown;
}

type ContentCoding = 'gzip' | 'deflate' | 'br' | 'zstd';

type Decoder = NodeJS.ReadWriteStream & {
  destroy(error?: Error): unknown;
  pause(): unknown;
  resume(): unknown;
};

/** zstd where the runtime decodes it (Node 22.15+ / 23.8+, Bun): not asked for, decoded. */
const createZstdDecompress = (
  zlib as unknown as { createZstdDecompress?: () => Decoder }
).createZstdDecompress;

/**
 * The body source for `res`: the response itself, or - when it carries a body encoded with
 * codings this adapter decodes - a decoded view of it, with `release` to let go of the
 * decoding on a teardown. A `HEAD` answer, a `204` / `304` and an informational status
 * have no body to decode, and an unknown coding hands the body over as it came. A stacked
 * coding (`gzip, br`, or a repeated `Content-Encoding` Node joined) is decoded in reverse
 * order, as `fetch` decodes it; `identity` is skipped.
 */
export function createResponseBodySource(
  res: http.IncomingMessage,
  method: string,
  status: number,
  contentEncoding: string | string[] | undefined,
): { source: ResponseBodySource; isDecoded: boolean; release: () => void } {
  const raw = { source: res, isDecoded: false, release: () => undefined };
  if (!hasResponseBody(method, status) || contentEncoding === undefined) {
    return raw;
  }

  const codings = (
    Array.isArray(contentEncoding) ? contentEncoding.join(',') : contentEncoding
  )
    .split(',')
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token !== '' && token !== 'identity')
    .map((token) => (token === 'x-gzip' ? 'gzip' : token));

  if (
    codings.length === 0 ||
    !codings.every(
      (coding): coding is ContentCoding =>
        coding === 'gzip' ||
        coding === 'deflate' ||
        coding === 'br' ||
        (coding === 'zstd' && createZstdDecompress !== undefined),
    )
  ) {
    return raw;
  }

  const decoded = new DecodedResponseBody(
    res,
    [...codings].reverse(),
    codings.length > MAX_CONTENT_CODINGS
      ? new Error(
          `Response stacks ${String(codings.length)} content codings; at most ${String(MAX_CONTENT_CODINGS)} are decoded`,
        )
      : undefined,
  );

  return {
    source: decoded,
    isDecoded: true,
    release: () => {
      decoded.destroy();
    },
  };
}

/**
 * A decoded view of a response body.
 *
 * - The decoders are made on the first byte: an empty body is no stream to decode, and a
 *   strict decoder reads one as truncated. `deflate` is meant to be zlib-wrapped, but some
 *   servers send it raw; the first byte tells them apart, as undici tells them apart.
 * - Decoded strictly: a body that ends before its compressed stream does - a gzip body cut
 *   before its trailer, which a CDN can serve whole from a truncated cache entry - is a
 *   stream error, not a success that silently lost the rest. `Z_SYNC_FLUSH` only makes
 *   what is decoded arrive promptly.
 * - `data` / `end` come from the last decoder, and only start flowing once a `data`
 *   listener is added, as a paused `IncomingMessage` waits for its reader.
 * - `aborted` comes from the response. `close` does too when the response closed short;
 *   when all of it arrived, `close` waits for the decoding to finish.
 * - `error` is the response's or a decoder's - a corrupt body fails as a stream error, and
 *   tears the response down so its socket is not held.
 * - Until a reader attaches, `end`, `close`, `error` and `aborted` are held and delivered in
 *   order once it has: a streamed response's factory may still be opening its sink.
 * - `destroy` stops everything: a request cancelled or timed out after a small compressed
 *   body had arrived whole went on inflating it - a few kilobytes into gigabytes - with
 *   nobody reading.
 */
class DecodedResponseBody extends EventEmitter implements ResponseBodySource {
  private decoders: Decoder[] = [];
  private isForwardingData = false;
  private didDecodeEnd = false;
  private didRawEnd = false;
  private isReading = false;
  private isDestroyed = false;
  private didFailTrailingBytes = false;
  /** Raw bytes that arrived before the decoders were attached: the first chunk. */
  private rawBytes = 0;
  private readonly held: Array<{ event: string; args: unknown[] }> = [];

  constructor(
    private readonly res: http.IncomingMessage,
    private readonly decodeOrder: ContentCoding[],
    refusal?: Error,
  ) {
    super();

    this.on('newListener', (event: string) => {
      if (event === 'data' && !this.isReading) {
        this.isReading = true;
        this.startForwardingData();
        // After the reader's other listeners: they are attached in the same turn as its
        // `data` one, and the held events are for them.
        queueMicrotask(() => {
          for (const { event: held, args } of this.held.splice(0)) {
            this.deliver(held, ...args);
          }
        });
      }
    });

    // Refused before anything is built: delivered as the body's error, and the response
    // let go.
    if (refusal !== undefined) {
      this.deliver('error', refusal);
      res.on('close', () => {
        this.deliver('close');
      });

      try {
        res.destroy();
      } catch {
        // Already gone; the error above is what is reported.
      }

      return;
    }

    res.on('error', (error: Error) => {
      this.deliver('error', error);
    });
    res.on('aborted', () => {
      this.deliver('aborted');
    });
    res.on('end', () => {
      this.didRawEnd = true;

      // An empty body: nothing to decode.
      if (this.decoders.length === 0) {
        this.didDecodeEnd = true;
        this.deliver('end');
      }
    });
    res.on('close', () => {
      if (this.didRawEnd || this.didDecodeEnd) {
        const last = this.decoders.at(-1);

        if (this.didDecodeEnd || last === undefined) {
          this.deliver('close');
        } else {
          last.once('close', () => this.deliver('close'));
        }

        return;
      }

      // Closed short: the decoders will get no more, and are let go.
      this.destroyDecoders();
      this.deliver('close');
    });

    // Every raw byte, the first chunk's included: read against what the first decoder
    // consumed, to tell trailing bytes (see `attachDecoders`).
    res.on('data', (chunk: Buffer) => {
      if (this.decoders.length === 0) {
        this.rawBytes += chunk.length;
      }
    });
    res.once('data', (first: Buffer) => {
      this.attachDecoders(first);
    });
  }

  public pause(): this {
    this.decoders.at(-1)?.pause();

    return this;
  }

  public resume(): this {
    this.decoders.at(-1)?.resume();

    return this;
  }

  /** Stop decoding and delivering: the request no longer wants this body. */
  public destroy(): void {
    if (this.isDestroyed) {
      return;
    }

    this.isDestroyed = true;
    this.held.length = 0;
    this.destroyDecoders();

    try {
      this.res.destroy();
    } catch {
      // Already gone.
    }
  }

  private attachDecoders(first: Buffer): void {
    if (this.isDestroyed) {
      return;
    }

    this.decoders = this.decodeOrder.map((coding, index) =>
      createDecoder(
        coding,
        // Sniffed only for the outermost coding, the one whose first byte this is.
        index === 0 ? first[0] : undefined,
      ),
    );

    for (const decoder of this.decoders) {
      decoder.on('error', (error: Error) => {
        // Delivered - or held for a reader not yet attached - and the decoding and the
        // response's socket let go. Not `destroy`, which would drop the held error.
        this.deliver('error', error);
        this.destroyDecoders();

        try {
          this.res.destroy();
        } catch {
          // Already gone; the error above is what is reported.
        }
      });
    }

    for (let index = 1; index < this.decoders.length; index++) {
      this.decoders[index - 1].pipe(this.decoders[index]);
    }

    // Trailing bytes: zlib and brotli end their output when their compressed stream ends
    // and drop whatever input is left, so `br` or `deflate` followed by junk was delivered
    // as a success; it is a stream error, as gunzip makes it one for gzip. Told by count,
    // not by the order of events - decoding runs off the main thread, so the response's
    // own `'end'` routinely comes first even when its last chunk carried the junk: a
    // decoder that ends having consumed (`bytesWritten`) fewer bytes than it was fed
    // stopped short of its input. `SniffingInflate` tells its own.
    const fedBytes = this.decoders.map(() => 0);
    fedBytes[0] = this.rawBytes;
    this.res.on('data', (chunk: Buffer) => {
      fedBytes[0] = (fedBytes[0] ?? 0) + chunk.length;
    });
    for (const [index, decoder] of this.decoders.entries()) {
      if (index + 1 < fedBytes.length) {
        decoder.on('data', (chunk: Buffer) => {
          fedBytes[index + 1] = (fedBytes[index + 1] ?? 0) + chunk.length;
        });
      }

      decoder.once('end', () => {
        const consumed: unknown = (decoder as { bytesWritten?: unknown })
          .bytesWritten;

        if (typeof consumed === 'number' && consumed < (fedBytes[index] ?? 0)) {
          this.failTrailingBytes();
        }
      });
    }

    const last = this.decoders.at(-1) as Decoder;
    last.on('end', () => {
      if (this.didFailTrailingBytes) {
        return;
      }

      this.didDecodeEnd = true;
      this.deliver('end');
    });

    const head = this.decoders[0];
    head.write(first);
    this.res.pipe(head);

    if (this.isForwardingData) {
      this.isForwardingData = false;
      this.startForwardingData();
    }
  }

  /** Bytes after a compressed stream: a stream error, the decoding and response let go. */
  private failTrailingBytes(): void {
    if (this.didFailTrailingBytes) {
      return;
    }

    this.didFailTrailingBytes = true;
    this.deliver(
      'error',
      new Error('Response body has bytes after its compressed stream'),
    );
    this.destroyDecoders();

    try {
      this.res.destroy();
    } catch {
      // Already gone; the error above is what is reported.
    }
  }

  private startForwardingData(): void {
    if (this.isForwardingData) {
      return;
    }

    this.isForwardingData = true;
    this.decoders.at(-1)?.on('data', (chunk: Buffer) => {
      if (!this.isDestroyed) {
        this.emit('data', chunk);
      }
    });
  }

  private destroyDecoders(): void {
    for (const decoder of this.decoders) {
      try {
        this.res.unpipe(decoder);
        decoder.destroy();
      } catch {
        // Nothing left to release.
      }
    }
  }

  /** Emitted now while a reader is attached, held for it until then; nothing once destroyed. */
  private deliver(event: string, ...args: unknown[]): void {
    if (this.isDestroyed) {
      return;
    }

    if (!this.isReading) {
      this.held.push({ event, args });

      return;
    }

    // An `error` with no listener would be an uncaught exception: dropped instead, once
    // the reader has let go.
    if (event === 'error' && this.listenerCount('error') === 0) {
      return;
    }

    this.emit(event, ...args);
  }
}

function createDecoder(
  coding: ContentCoding,
  firstByte: number | undefined,
): Decoder {
  switch (coding) {
    case 'gzip':
      return zlib.createGunzip({ flush: zlib.constants.Z_SYNC_FLUSH });
    case 'deflate':
      // A zlib stream's first byte has a low nibble of 8; anything else is raw deflate.
      // An inner coding's first byte is not known yet: told apart on its own first chunk.
      if (firstByte === undefined) {
        return new SniffingInflate();
      }

      return firstByte % 16 === 8
        ? zlib.createInflate({ flush: zlib.constants.Z_SYNC_FLUSH })
        : zlib.createInflateRaw({ flush: zlib.constants.Z_SYNC_FLUSH });
    case 'br':
      return zlib.createBrotliDecompress({
        flush: zlib.constants.BROTLI_OPERATION_FLUSH,
      });
    case 'zstd':
      return (createZstdDecompress as () => Decoder)();
  }
}

/**
 * A `deflate` decoder that tells zlib-wrapped from raw deflate by the first byte it is
 * given, as undici's inflate stage does - for a `deflate` stacked inside another coding,
 * whose bytes only exist once the outer one is decoded. Backpressure is passed through:
 * the inner inflater is paused while this stream's reader is, so a stacked bomb is no
 * more eager than a plain one.
 */
class SniffingInflate extends Transform {
  private inner: zlib.Inflate | zlib.InflateRaw | undefined;
  /**
   * The inner inflater ended its output before this stream was told the input had: zlib
   * does that when a write leaves bytes after the deflate stream. Trailing bytes, so an
   * error - and never waited on in `_flush`, whose `'end'` had already come and gone.
   */
  private didInnerEndEarly = false;

  public override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    if (this.inner === undefined) {
      const inner =
        (chunk[0] ?? 0) % 16 === 8
          ? zlib.createInflate({ flush: zlib.constants.Z_SYNC_FLUSH })
          : zlib.createInflateRaw({ flush: zlib.constants.Z_SYNC_FLUSH });

      inner.on('data', (decoded: Buffer) => {
        if (!this.push(decoded)) {
          inner.pause();
        }
      });
      inner.on('error', (error: Error) => {
        this.destroy(error);
      });
      inner.once('end', () => {
        if (!this.writableEnded) {
          this.didInnerEndEarly = true;
        }
      });
      this.inner = inner;
    }

    if (this.didInnerEndEarly) {
      callback(trailingBytesError());
      return;
    }

    if (this.inner.write(chunk)) {
      callback();
    } else {
      this.inner.once('drain', () => {
        callback();
      });
    }
  }

  public override _read(size: number): void {
    this.inner?.resume();
    super._read(size);
  }

  public override _flush(callback: TransformCallback): void {
    if (this.inner === undefined) {
      callback();
      return;
    }

    if (this.didInnerEndEarly || this.inner.readableEnded) {
      callback(trailingBytesError());
      return;
    }

    this.inner.once('end', () => {
      callback();
    });
    this.inner.end();
  }

  public override _destroy(
    error: Error | null,
    callback: (error?: Error | null) => void,
  ): void {
    this.inner?.destroy();
    callback(error);
  }
}

function trailingBytesError(): Error {
  return new Error('Response body has bytes after its compressed stream');
}
