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
import { RESPONSE_DECODE_ERROR_KEY } from '../consts';
import { reportCallbackError } from '../../safe-handle-callback';
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
  /**
   * The error held for a reader not yet attached - a decoding failure found before the
   * stream factory had its sink - so a setup that ends on the raw response's close can
   * report it rather than a generic one.
   */
  heldError?(): Error | undefined;
  /**
   * Told of a decoding failure the moment it is found, whether or not a reader has
   * attached - for a setup waiting on its stream factory, which no raw-response event
   * reports once the raw body has already ended. Returns the unsubscribe.
   */
  onFailure?(listener: (error: Error) => void): () => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the emitter signature
  on(event: string, listener: (...args: any[]) => void): unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the emitter signature
  off(event: string, listener: (...args: any[]) => void): unknown;
  pause(): unknown;
  resume(): unknown;
}

type ContentCoding = 'gzip' | 'deflate' | 'br' | 'zstd';

type Decoder = NodeJS.ReadWriteStream & {
  /** Set once the stream has emitted `'close'` (or been destroyed), as every zlib and `Transform` stream reports. */
  readonly closed?: boolean;
  readonly destroyed?: boolean;
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
  private didFailDecoding = false;
  private didLastDecoderClose = false;
  /** Raw bytes that arrived before the decoders were attached: the first chunk. */
  private rawBytes = 0;
  private readonly held: Array<{ event: string; args: unknown[] }> = [];
  /** One record per `onFailure` call: active until unsubscribed, told at most once. */
  private readonly failureSubscriptions = new Set<FailureSubscription>();

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
      this.deliver('error', markDecodeError(refusal));
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

        // Or the last decoder has already emitted `'close'` - destroyed by a decoding
        // failure after the raw body ended - which a listener added now would never see.
        // Told by our own listener's flag, not by `closed` or `destroyed`: `destroy(error)`
        // sets both at once and emits the error and `'close'` a tick later, so either read
        // delivered `close` before the tagged decoding error, as a plain closed stream.
        if (
          this.didDecodeEnd ||
          last === undefined ||
          this.didLastDecoderClose
        ) {
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

  public onFailure(listener: (error: Error) => void): () => void {
    const subscription: FailureSubscription = { listener, told: false };
    this.failureSubscriptions.add(subscription);

    // A decoding failure already held - the coding chain refused in the constructor,
    // before any subscriber - is told too, a microtask on, so a setup waiting on it need
    // not hang on the raw response's `close` to hear of it. A decoding failure only, as
    // the live path tells; and not if one reached this subscription meanwhile.
    const held = this.findHeldError(isDecodeFailure);
    if (held !== undefined) {
      queueMicrotask(() => {
        if (
          !this.isDestroyed &&
          this.failureSubscriptions.has(subscription) &&
          !subscription.told
        ) {
          this.notifyFailure(subscription, held);
        }
      });
    }

    return () => {
      this.failureSubscriptions.delete(subscription);
    };
  }

  public heldError(): Error | undefined {
    // A decoding failure first, wherever it is held - the cause the replay tells and a
    // stream setup reports - then any other held error.
    return (
      this.findHeldError(isDecodeFailure) ?? this.findHeldError(() => true)
    );
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
        this.deliver('error', markDecodeError(error));
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
    // stopped short of its input. `SniffingInflate` tells its own. Not for gzip: gunzip
    // already fails on bytes after its stream unless they start with a zero byte, which it
    // reads as padding (some servers pad) - a count would refuse what Node and browsers
    // read.
    //
    // A cut-off zstd frame, followed the same way: Node's and Bun's zstd decoders end
    // cleanly on one, handing over what they decoded, where gunzip, brotli and inflate
    // fail. The frame boundaries are walked over the bytes each zstd stage is fed.
    const fedBytes = this.decoders.map(() => 0);
    fedBytes[0] = this.rawBytes;
    const zstdFrames = this.decodeOrder.map((coding) =>
      coding === 'zstd' ? new ZstdFrameWalker() : undefined,
    );
    zstdFrames[0]?.feed(first);
    this.res.on('data', (chunk: Buffer) => {
      fedBytes[0] = (fedBytes[0] ?? 0) + chunk.length;
      zstdFrames[0]?.feed(chunk);
    });
    for (const [index, decoder] of this.decoders.entries()) {
      if (index + 1 < fedBytes.length) {
        decoder.on('data', (chunk: Buffer) => {
          fedBytes[index + 1] = (fedBytes[index + 1] ?? 0) + chunk.length;
          zstdFrames[index + 1]?.feed(chunk);
        });
      }

      if (this.decodeOrder[index] === 'gzip') {
        continue;
      }

      decoder.once('end', () => {
        const consumed: unknown = (decoder as { bytesWritten?: unknown })
          .bytesWritten;

        if (typeof consumed === 'number' && consumed < (fedBytes[index] ?? 0)) {
          // A second zstd frame is no junk: valid zstd (RFC 8878 allows several), which
          // Node's decoder leaves unread when it arrives in the same write as the first.
          this.failDecoding(
            (zstdFrames[index]?.frameCount ?? 0) > 1
              ? new Error(
                  "Response body holds more than one zstd frame, and this runtime's zstd decoder reads only the first",
                )
              : trailingBytesError(),
          );
        } else if (zstdFrames[index]?.isAtFrameEnd === false) {
          this.failDecoding(
            new Error('Response body ends before its compressed stream does'),
          );
        }
      });
    }

    const last = this.decoders.at(-1) as Decoder;
    // Tracked here rather than read off `closed`, which not every runtime's decoder sets:
    // the raw response's `'close'` that comes after it would otherwise wait for a
    // `'close'` already emitted.
    last.once('close', () => {
      this.didLastDecoderClose = true;
    });
    last.on('end', () => {
      if (this.didFailDecoding) {
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

  /**
   * A body its decoder ended on without failing - bytes after its compressed stream, a
   * zstd frame cut short: a stream error, the decoding and response let go.
   */
  private failDecoding(error: Error): void {
    if (this.didFailDecoding) {
      return;
    }

    this.didFailDecoding = true;
    this.deliver('error', markDecodeError(error));
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

  /** The first error held for a reader not yet attached that `matches`, if any. */
  private findHeldError(matches: (error: Error) => boolean): Error | undefined {
    for (const { event, args } of this.held) {
      const error: unknown = args[0];
      if (event === 'error' && error instanceof Error && matches(error)) {
        return error;
      }
    }

    return undefined;
  }

  /**
   * One failure listener, guarded: it runs inside a decoder's `'error'` emit, where a
   * throw would unwind through zlib as an uncaught exception.
   */
  private notifyFailure(subscription: FailureSubscription, error: Error): void {
    subscription.told = true;

    try {
      subscription.listener(error);
    } catch (error_) {
      // Reported, not swallowed: a listener that failed partway may have left its own
      // work undone, and nothing else would say so. The failure itself still reaches the
      // body's reader as its `'error'`, held or emitted as usual.
      reportCallbackError('response body failure listener', error_);
    }
  }

  /** Emitted now while a reader is attached, held for it until then; nothing once destroyed. */
  private deliver(event: string, ...args: unknown[]): void {
    if (this.isDestroyed) {
      return;
    }

    // Decoding failures only, as `onFailure` promises: a raw response error the body
    // forwards reaches a stream setup through the response's own `'error'` already.
    const failure: unknown = args[0];
    if (
      event === 'error' &&
      failure instanceof Error &&
      isDecodeFailure(failure)
    ) {
      // Once per subscription, as the replay is: a second decoder's error queued in the
      // same tick (a stacked `gzip, br`) does not tell a listener again. Re-checked per
      // listener, as an earlier one may unsubscribe another or tear the body down.
      for (const subscription of [...this.failureSubscriptions]) {
        if (this.isDestroyed) {
          break;
        }

        if (this.failureSubscriptions.has(subscription) && !subscription.told) {
          this.notifyFailure(subscription, failure);
        }
      }

      // A listener may have torn the body down (a stream setup that failed releases it):
      // nothing is held once destroyed, or `heldError()` answered a stale error.
      if (this.isDestroyed) {
        return;
      }
    }

    // Held behind what is already held, too: the held events are flushed a microtask
    // after the reader attaches, and a `close` arriving first (a `nextTick` after the
    // refused response's `destroy()`) settled the reader before the tagged error that
    // came before it - a coding chain refused as too long then read as a transport cut.
    if (!this.isReading || this.held.length > 0) {
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
  /** Bytes handed to the inner inflater, read against what it consumed. */
  private fedBytes = 0;

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
      this.inner = inner;
    }

    // Input after the deflate stream has ended: trailing bytes.
    if (this.inner.readableEnded) {
      callback(trailingBytesError());
      return;
    }

    this.fedBytes += chunk.length;

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

    // Trailing bytes, told by count as the other decoders are: the inner inflater ends
    // when its deflate stream does and drops the rest, and whether that happened before or
    // after this flush is down to when it got to the last chunk.
    if (this.inner.readableEnded) {
      callback(this.hasLeftover() ? trailingBytesError() : undefined);
      return;
    }

    const inner = this.inner;
    inner.once('end', () => {
      callback(this.hasLeftover() ? trailingBytesError() : undefined);
    });
    inner.end();
  }

  public override _destroy(
    error: Error | null,
    callback: (error?: Error | null) => void,
  ): void {
    this.inner?.destroy();
    callback(error);
  }

  /** Whether the inner inflater stopped short of what it was given. */
  private hasLeftover(): boolean {
    return (this.inner?.bytesWritten ?? 0) < this.fedBytes;
  }
}

/**
 * Follows zstd frame boundaries (RFC 8878 §3.1) over the bytes fed to a zstd decoder,
 * without decoding them: the frame header's own length, then each block's header and
 * size up to the last block, then the optional checksum. Skippable frames are stepped
 * over. A malformed header is left to the decoder, which fails on it.
 */
class ZstdFrameWalker {
  /** Frames read whole: Zstandard frames and skippable ones alike, both valid (RFC 8878). */
  public frameCount = 0;
  private skipBytes = 0;
  private readonly fieldBytes: number[] = [];
  private fieldLength = 4;
  private isAwaitingMagic = true;
  private hasFrame = false;
  private hasChecksum = false;
  private isMalformed = false;
  /** What the next field, once `fieldLength` bytes of it are in, is read as. */
  private onField: (field: number[]) => void;

  constructor() {
    this.onField = (field) => {
      this.readMagic(field);
    };
  }

  /** Whether the bytes so far end on a frame boundary, after at least one frame. */
  public get isAtFrameEnd(): boolean {
    return (
      this.isMalformed ||
      (this.hasFrame &&
        this.isAwaitingMagic &&
        this.skipBytes === 0 &&
        this.fieldBytes.length === 0)
    );
  }

  public feed(chunk: Uint8Array): void {
    let offset = 0;

    while (offset < chunk.length && !this.isMalformed) {
      if (this.skipBytes > 0) {
        const skipped = Math.min(this.skipBytes, chunk.length - offset);
        this.skipBytes -= skipped;
        offset += skipped;
        continue;
      }

      this.fieldBytes.push(chunk[offset]);
      offset++;

      if (this.fieldBytes.length === this.fieldLength) {
        this.onField(this.fieldBytes.splice(0));
      }
    }
  }

  private expect(length: number, onField: (field: number[]) => void): void {
    this.fieldLength = length;
    this.onField = onField;
  }

  private expectMagic(): void {
    this.isAwaitingMagic = true;
    this.expect(4, (field) => {
      this.readMagic(field);
    });
  }

  private readMagic(field: number[]): void {
    const magic = readLittleEndian(field);
    this.isAwaitingMagic = false;

    if (magic === 0xfd2fb528) {
      this.expect(1, ([descriptor = 0]) => {
        this.readFrameHeader(descriptor);
      });
    } else if (magic >>> 4 === 0x184d2a5) {
      this.expect(4, (size) => {
        this.skipBytes = readLittleEndian(size);
        this.hasFrame = true;
        this.frameCount++;
        this.expectMagic();
      });
    } else {
      this.isMalformed = true;
    }
  }

  private readFrameHeader(descriptor: number): void {
    const isSingleSegment = (descriptor & 0x20) !== 0;
    const contentSizeLength = [isSingleSegment ? 1 : 0, 2, 4, 8][
      descriptor >> 6
    ];
    const dictionaryIDLength = [0, 1, 2, 4][descriptor & 0x03];
    this.hasChecksum = (descriptor & 0x04) !== 0;
    this.skipBytes =
      (isSingleSegment ? 0 : 1) + dictionaryIDLength + contentSizeLength;
    this.expect(3, (field) => {
      this.readBlockHeader(field);
    });
  }

  private readBlockHeader(field: number[]): void {
    const header = readLittleEndian(field);
    const blockType = (header >> 1) & 0x03;

    if (blockType === 3) {
      this.isMalformed = true;
      return;
    }

    // An RLE block carries one byte, repeated; the others carry their size.
    this.skipBytes = blockType === 1 ? 1 : header >>> 3;

    if ((header & 0x01) !== 0) {
      this.hasFrame = true;
      this.frameCount++;
      this.skipBytes += this.hasChecksum ? 4 : 0;
      this.expectMagic();
    } else {
      this.expect(3, (next) => {
        this.readBlockHeader(next);
      });
    }
  }
}

function readLittleEndian(bytes: number[]): number {
  let value = 0;

  for (const [index, byte] of bytes.entries()) {
    value += byte * 2 ** (8 * index);
  }

  return value;
}

/** One `onFailure` subscription. */
interface FailureSubscription {
  readonly listener: (error: Error) => void;
  told: boolean;
}

/** Whether `error` is a decoding failure this module tagged (see `markDecodeError`). */
function isDecodeFailure(error: Error): boolean {
  return (
    (error as unknown as Record<PropertyKey, unknown>)[
      RESPONSE_DECODE_ERROR_KEY
    ] === true
  );
}

function trailingBytesError(): Error {
  return new Error('Response body has bytes after its compressed stream');
}

/**
 * `error` tagged as the body's decoding failure, not a transport one. The decoder's own
 * error object, tagged in place: it is this module's, never a caller's.
 */
function markDecodeError(error: Error): Error {
  try {
    Object.defineProperty(error, RESPONSE_DECODE_ERROR_KEY, { value: true });
  } catch {
    // Not extensible: reported untagged, as a stream error the redirect rule keeps.
  }

  return error;
}
