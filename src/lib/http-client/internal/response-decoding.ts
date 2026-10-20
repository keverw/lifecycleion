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
import * as zlib from 'node:zlib';

/** The encodings NodeAdapter asks for and decodes, as `fetch` asks for them. */
export const ACCEPTED_CONTENT_ENCODINGS = 'gzip, deflate, br';

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

type Decoder =
  zlib.Gunzip | zlib.Inflate | zlib.InflateRaw | zlib.BrotliDecompress;

/**
 * The body source for `res`: the response itself, or - when it carries a body encoded with
 * one of {@link ACCEPTED_CONTENT_ENCODINGS} - a decoded view of it. A `HEAD` answer, a
 * `204` / `304` and an informational status have no body to decode, and a stacked encoding
 * (`gzip, br`) or an unknown one is handed over as it came.
 */
export function createResponseBodySource(
  res: http.IncomingMessage,
  method: string,
  status: number,
  contentEncoding: string | string[] | undefined,
): { source: ResponseBodySource; isDecoded: boolean } {
  const encoding = (
    Array.isArray(contentEncoding)
      ? contentEncoding.join(', ')
      : contentEncoding
  )
    ?.trim()
    .toLowerCase();

  const hasBody =
    method.toUpperCase() !== 'HEAD' &&
    status >= 200 &&
    status !== 204 &&
    status !== 304;

  if (
    !hasBody ||
    (encoding !== 'gzip' &&
      encoding !== 'x-gzip' &&
      encoding !== 'deflate' &&
      encoding !== 'br')
  ) {
    return { source: res, isDecoded: false };
  }

  return {
    source: new DecodedResponseBody(res, encoding),
    isDecoded: true,
  };
}

/**
 * A decoded view of a response body.
 *
 * - `data` / `end` come from the decoder, and only start flowing once a `data` listener is
 *   added, as a paused `IncomingMessage` waits for its reader: a streamed response whose
 *   factory is still opening its sink loses nothing.
 * - `aborted` comes from the response. `close` does too when the response closed short;
 *   when all of it arrived, `close` waits for the decoder to finish, so a body still being
 *   decoded is not read as cut off.
 * - `error` is the response's or the decoder's - a corrupt body fails as a stream error,
 *   and tears the response down so its socket is not held. Forwarded only while someone is
 *   listening: an `error` emitted with no listener would be an uncaught exception.
 * - Until a reader attaches (its `data` listener), `end`, `close`, `error` and `aborted`
 *   are held, and delivered in order once it has - as a paused `IncomingMessage` holds
 *   them. A streamed response's factory may still be opening its sink when an empty
 *   `deflate` body ends or a corrupt one fails; emitted then, they reached no one and the
 *   request hung until its timeout.
 *
 * Decoded with a sync flush, as undici decodes: a body cut short after its last full block
 * keeps what was decoded instead of failing outright.
 */
class DecodedResponseBody extends EventEmitter implements ResponseBodySource {
  private decoder: Decoder | undefined;
  private isForwardingData = false;
  private didDecoderEnd = false;
  private didRawEnd = false;
  private isReading = false;
  private readonly held: Array<{ event: string; args: unknown[] }> = [];

  constructor(
    private readonly res: http.IncomingMessage,
    private readonly encoding: 'gzip' | 'x-gzip' | 'deflate' | 'br',
  ) {
    super();

    res.on('error', (error: Error) => {
      this.deliver('error', error);
    });
    res.on('aborted', () => {
      this.deliver('aborted');
    });
    res.on('end', () => {
      this.didRawEnd = true;

      // An empty `deflate` body never sent the byte that picks its decoder.
      if (this.decoder === undefined) {
        this.didDecoderEnd = true;
        this.deliver('end');
      }
    });
    res.on('close', () => {
      if (this.didRawEnd || this.didDecoderEnd) {
        if (this.didDecoderEnd || this.decoder === undefined) {
          this.deliver('close');
        } else {
          this.decoder.once('close', () => this.deliver('close'));
        }

        return;
      }

      // Closed short: the decoder will get no more, and is let go.
      this.decoder?.destroy();
      this.deliver('close');
    });

    if (encoding === 'deflate') {
      // `deflate` is meant to be zlib-wrapped, but some servers send it raw. Told apart by
      // the first byte, as undici tells them apart: a zlib stream's low nibble is 8.
      res.once('data', (first: Buffer) => {
        this.attachDecoder(
          (first[0] ?? 0) % 16 === 8
            ? zlib.createInflate(zlibFlushOptions())
            : zlib.createInflateRaw(zlibFlushOptions()),
          first,
        );
      });
    } else {
      this.attachDecoder(
        encoding === 'br'
          ? zlib.createBrotliDecompress({
              flush: zlib.constants.BROTLI_OPERATION_FLUSH,
              finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH,
            })
          : zlib.createGunzip(zlibFlushOptions()),
      );
    }

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
  }

  public pause(): this {
    this.decoder?.pause();

    return this;
  }

  public resume(): this {
    this.decoder?.resume();

    return this;
  }

  private attachDecoder(decoder: Decoder, first?: Buffer): void {
    this.decoder = decoder;

    decoder.on('error', (error: Error) => {
      this.deliver('error', error);

      try {
        this.res.destroy();
      } catch {
        // Already gone; the error above is what is reported.
      }
    });
    decoder.on('end', () => {
      this.didDecoderEnd = true;
      this.deliver('end');
    });

    if (first !== undefined) {
      decoder.write(first);
    }

    this.res.pipe(decoder);

    if (this.isForwardingData) {
      this.isForwardingData = false;
      this.startForwardingData();
    }
  }

  private startForwardingData(): void {
    if (this.isForwardingData) {
      return;
    }

    this.isForwardingData = true;
    this.decoder?.on('data', (chunk: Buffer) => {
      this.emit('data', chunk);
    });
  }

  /** Emitted now while a reader is attached, held for it until then. */
  private deliver(event: string, ...args: unknown[]): void {
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

function zlibFlushOptions(): zlib.ZlibOptions {
  return {
    flush: zlib.constants.Z_SYNC_FLUSH,
    finishFlush: zlib.constants.Z_SYNC_FLUSH,
  };
}
