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
 * decoding on a teardown. `contentEncoding` is `undefined` for a body not to decode - an
 * answer with none (see `hasResponseBody`), or one asked for as sent - and an unknown
 * coding hands the body over as it came. A stacked coding (`gzip, br`, or a repeated
 * `Content-Encoding` Node joined) is decoded in reverse order, as `fetch` decodes it;
 * `identity` is skipped.
 */
export function createResponseBodySource(
  res: http.IncomingMessage,
  contentEncoding: string | string[] | undefined,
): { source: ResponseBodySource; isDecoded: boolean; release: () => void } {
  const raw = { source: res, isDecoded: false, release: () => undefined };
  if (contentEncoding === undefined) {
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
 *   listener is added (or `resume()` drains it), as a paused `IncomingMessage` waits for
 *   its reader. The raw response is read ahead into the decoders from its first byte -
 *   it is what builds them - but only as far as their buffers hold, then backpressure
 *   stops it.
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
  private isPaused = false;
  /**
   * An empty body's `'end'` held while paused, as a raw `IncomingMessage` holds it, and
   * everything after it, in order. A `'close'` with no `'end'` before it - a body cut
   * short - is not held: a raw response emits that one paused or not.
   */
  private readonly heldWhilePaused: Array<{ event: string; args: unknown[] }> =
    [];
  /** Raw bytes that arrived before the decoders were attached: the first chunk. */
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
      if (event === 'data') {
        this.beginReading();
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

    // The first chunk builds the decoders, which count every raw byte from it on, to
    // tell trailing bytes (see `attachDecoders`).
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
    // Remembered too, for a pause asked before the first byte, when no decoder exists
    // yet: applied once they are attached, as a raw `IncomingMessage` would honour it.
    this.isPaused = true;
    this.decoders.at(-1)?.pause();

    return this;
  }

  public resume(): this {
    this.isPaused = false;
    // A resume with no reader drains the body, as it drains a raw `IncomingMessage`:
    // the data goes to no one and `end` is heard. Held for a reader, it was dropped and
    // `end` held for good.
    this.beginReading();
    this.decoders.at(-1)?.resume();

    // Released a tick on, as a raw `IncomingMessage` emits its `'end'` after `resume()`
    // returns: a reader that resumes and then attaches its `'end'` listener still hears it.
    if (this.heldWhilePaused.length > 0) {
      queueMicrotask(() => {
        for (const { event, args } of this.heldWhilePaused.splice(0)) {
          this.deliver(event, ...args);
        }
      });
    }

    return this;
  }

  /** Stop decoding and delivering: the request no longer wants this body. */
  public destroy(): void {
    if (this.isDestroyed) {
      return;
    }

    this.isDestroyed = true;
    this.held.length = 0;
    this.heldWhilePaused.length = 0;
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
        // Sniffed only for the outermost coding, the one whose first bytes these are.
        index === 0 ? first : undefined,
      ),
    );

    for (const decoder of this.decoders) {
      // Delivered - or held for a reader not yet attached - and the decoding and the
      // response's socket let go, once: stacked decoders (`gzip, br`) can each fail.
      // Not `destroy`, which would drop the held error.
      decoder.on('error', (error: Error) => {
        this.failDecoding(error);
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
    // fail. Read off the frame walker each zstd stage already follows its input with
    // (see `FramedZstdDecompress`).
    const fedBytes = this.decoders.map(() => 0);
    fedBytes[0] = first.length;
    this.res.on('data', (chunk: Buffer) => {
      fedBytes[0] = (fedBytes[0] ?? 0) + chunk.length;
    });
    for (const [index, decoder] of this.decoders.entries()) {
      if (index + 1 < fedBytes.length) {
        decoder.on('data', (chunk: Buffer) => {
          fedBytes[index + 1] = (fedBytes[index + 1] ?? 0) + chunk.length;
        });
      }

      if (this.decodeOrder[index] === 'gzip') {
        continue;
      }

      decoder.once('end', () => {
        const consumed: unknown = (decoder as { bytesWritten?: unknown })
          .bytesWritten;

        const frames =
          decoder instanceof FramedZstdDecompress ? decoder.frames : undefined;
        if (typeof consumed === 'number' && consumed < (fedBytes[index] ?? 0)) {
          // Left unread after every data frame was read, skippable frames (RFC 8878
          // metadata) carry no content: the body is whole. Only then - a data frame left
          // unread would be a body silently cut short; anything else left is trailing
          // bytes.
          if (
            frames !== undefined &&
            frames.dataFrameCount >= 1 &&
            frames.isAtFrameEnd &&
            consumed >= frames.lastDataFrameEnd
          ) {
            return;
          }

          this.failDecoding(trailingBytesError());
        } else if (frames?.isMalformed === true) {
          // A decoder that ended cleanly on framing the walker could not follow (a legacy
          // frame, header bits it misreads) may have ended on a frame cut short, which
          // these decoders end cleanly on: the body cannot be vouched for whole.
          this.failDecoding(
            new Error(
              'Response body holds zstd framing this client cannot follow, so it cannot tell whether the body is whole',
            ),
          );
        } else if (frames?.isAtFrameEnd === false) {
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

    if (this.isPaused) {
      this.decoders.at(-1)?.pause();
    }
  }

  /**
   * A decoding failure - a decoder's own error, or a body it ended on without failing
   * (bytes after its compressed stream, a zstd frame cut short): a stream error, told
   * once, the decoding and response let go.
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

  /**
   * Start delivering: forward the decoded data, and the events held for a reader. Once -
   * on a `data` listener, or a `resume()`, whichever is first.
   */
  private beginReading(): void {
    if (this.isReading) {
      return;
    }

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

  /**
   * The first held error that `matches`, if any: held for a reader not yet attached, or
   * behind a paused `'end'` - in that order, the order they arrived in.
   */
  private findHeldError(matches: (error: Error) => boolean): Error | undefined {
    for (const queue of [this.held, this.heldWhilePaused]) {
      for (const { event, args } of queue) {
        const error: unknown = args[0];
        if (event === 'error' && error instanceof Error && matches(error)) {
          return error;
        }
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

    // While paused, an `'end'` waits for `resume()`, and so does whatever follows it, so
    // an `'error'` cannot overtake the `'end'` of a body that completed. Read after the
    // reader's hold, so the paused hold only ever has what came after everything there -
    // and is re-read as each released event is delivered, so a body paused again before
    // the release holds them again.
    if ((this.isPaused && event === 'end') || this.heldWhilePaused.length > 0) {
      this.heldWhilePaused.push({ event, args });

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
  firstChunk: Buffer | undefined,
): Decoder {
  switch (coding) {
    case 'gzip':
      return zlib.createGunzip({ flush: zlib.constants.Z_SYNC_FLUSH });
    case 'deflate':
      // An inner coding's first bytes are not known yet, nor two of an outer one whose
      // first chunk holds one: told apart once the decoder has two.
      if (firstChunk === undefined || firstChunk.length < 2) {
        return new SniffingInflate();
      }

      return isZlibHeader(firstChunk)
        ? zlib.createInflate({ flush: zlib.constants.Z_SYNC_FLUSH })
        : zlib.createInflateRaw({ flush: zlib.constants.Z_SYNC_FLUSH });
    case 'br':
      return zlib.createBrotliDecompress({
        flush: zlib.constants.BROTLI_OPERATION_FLUSH,
      });
    case 'zstd':
      return new FramedZstdDecompress();
  }
}

/**
 * Whether a `deflate` body starts with a zlib header (RFC 1950) rather than raw deflate:
 * compression method 8 in the low nibble of the first byte, a window size of at most 7 in
 * its high nibble, and - where the second byte is in this chunk - a header check that
 * makes the first two bytes a multiple of 31, as browsers read it. The nibble alone took raw deflate opening on a stored block with set
 * padding bits (`0x08`, `0x18`) for zlib, and failed a valid body on its header check.
 */
function isZlibHeader(bytes: Buffer): boolean {
  const first = bytes[0];
  // Method 8 in the low nibble, and a window (CINFO, the high nibble) of at most 7: a
  // stored raw block whose padding bits make its first byte `0x88` is no zlib header.
  if (first === undefined || first % 16 !== 8 || first >> 4 > 7) {
    return false;
  }

  const second = bytes[1];
  return second === undefined || ((first << 8) | second) % 31 === 0;
}

/**
 * A decoder that hands its input to an inner one and passes the inner one's output on: for
 * a decoder that must look at its input before or while the inner one reads it. The
 * inner decoder's backpressure is passed through - it is paused while this stream's
 * reader is, so a stacked bomb is no more eager than a plain one - its error destroys this
 * stream, and this stream ends once the inner one has.
 */
abstract class InnerDecoderTransform<
  Inner extends Decoder = Decoder,
> extends Transform {
  protected inner: Inner | undefined;
  private didInnerEnd = false;

  /** Whether the inner decoder has ended - for a body read whole, or one it stopped short of. */
  protected get hasInnerEnded(): boolean {
    return this.didInnerEnd;
  }

  public override _read(size: number): void {
    this.inner?.resume();
    super._read(size);
  }

  public override _destroy(
    error: Error | null,
    callback: (error?: Error | null) => void,
  ): void {
    this.inner?.destroy();
    callback(error);
  }

  /** Make `inner` the decoder this stream feeds and reads from. */
  protected attachInner(inner: Inner): Inner {
    inner.once('end', () => {
      this.didInnerEnd = true;
    });
    inner.on('data', (decoded: Buffer) => {
      if (!this.push(decoded)) {
        inner.pause();
      }
    });
    inner.on('error', (error: Error) => {
      this.destroy(error);
    });
    this.inner = inner;

    return inner;
  }

  /**
   * Hand `pieces` to the inner decoder, each as its own write, then call back. Walked by
   * index in a loop that waits only on a `drain`, since a chunk of many tiny zstd frames
   * is many pieces: no `shift` moving the rest along.
   */
  protected writeInner(pieces: Buffer[], callback: TransformCallback): void {
    const inner = this.inner as Inner;
    let index = 0;
    const writeRest = (): void => {
      while (index < pieces.length) {
        const piece = pieces[index];
        index++;

        if (!inner.write(piece)) {
          inner.once('drain', writeRest);
          return;
        }
      }

      callback();
    };

    writeRest();
  }

  /** End the inner decoder, if there is one, and call back once it has ended. */
  protected endInner(callback: () => void): void {
    if (this.inner === undefined || this.didInnerEnd) {
      callback();
      return;
    }

    this.inner.once('end', callback);
    this.inner.end();
  }
}

/**
 * A `deflate` decoder that tells zlib-wrapped from raw deflate by the first two bytes it
 * is given, as undici's inflate stage does - for a `deflate` stacked inside another coding,
 * whose bytes only exist once the outer one is decoded.
 */
class SniffingInflate extends InnerDecoderTransform<
  zlib.Inflate | zlib.InflateRaw
> {
  /** Bytes handed to the inner inflater, read against what it consumed. */
  private fedBytes = 0;
  /** A lone first byte, held until a second tells zlib from raw deflate (`isZlibHeader`). */
  private pendingHead: Buffer | undefined;

  public override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    if (this.inner === undefined) {
      const head =
        this.pendingHead === undefined
          ? chunk
          : Buffer.concat([this.pendingHead, chunk]);

      if (head.length < 2) {
        this.pendingHead = head;
        callback();
        return;
      }

      this.pendingHead = undefined;
      this.startInner(head);
      chunk = head;
    }

    // Input after the deflate stream has ended: trailing bytes.
    if (this.hasInnerEnded) {
      callback(trailingBytesError());
      return;
    }

    this.fedBytes += chunk.length;
    this.writeInner([chunk], callback);
  }

  public override _flush(callback: TransformCallback): void {
    // A body of one byte: read by that byte alone - no deflate stream is one byte long, so
    // either inflater refuses it.
    if (this.inner === undefined && this.pendingHead !== undefined) {
      const head = this.pendingHead;
      this.pendingHead = undefined;
      const inner = this.startInner(head);
      this.fedBytes += head.length;
      inner.write(head);
    }

    // Trailing bytes, told by count as the other decoders are: the inner inflater ends
    // when its deflate stream does and drops the rest, and whether that happened before or
    // after this flush is down to when it got to the last chunk.
    this.endInner(() => {
      callback(this.hasLeftover() ? trailingBytesError() : undefined);
    });
  }

  /** The inner inflater, zlib or raw by the first bytes it will be given. */
  private startInner(head: Buffer): zlib.Inflate | zlib.InflateRaw {
    return this.attachInner(
      isZlibHeader(head)
        ? zlib.createInflate({ flush: zlib.constants.Z_SYNC_FLUSH })
        : zlib.createInflateRaw({ flush: zlib.constants.Z_SYNC_FLUSH }),
    );
  }

  /**
   * Whether the inner inflater stopped short of what it was given. Only told where it
   * reports a count, as `attachDecoders` reads one: a runtime whose inflater has no
   * `bytesWritten` would otherwise fail every body as trailing bytes.
   */
  private hasLeftover(): boolean {
    const consumed: unknown = this.inner?.bytesWritten;

    return typeof consumed === 'number' && consumed < this.fedBytes;
  }
}

/**
 * A zstd decoder handed one frame per write. Node's decoder reads only the first frame of
 * a write that holds several and leaves the rest unread, where it reads each frame of its
 * own write - so a body of several frames (valid zstd, RFC 8878) decoded or failed by how
 * the network split it. Split at the frame boundaries `ZstdFrameWalker` follows, it
 * decodes whole however it arrives, on Node and Bun alike.
 */
class FramedZstdDecompress extends InnerDecoderTransform {
  /** The frame walker that follows every byte this stage is fed. */
  public readonly frames = new ZstdFrameWalker();

  constructor() {
    super();
    this.attachInner((createZstdDecompress as () => Decoder)());
  }

  /** What the inner decoder consumed, read against what it was fed (see `attachDecoders`). */
  public get bytesWritten(): unknown {
    return (this.inner as { bytesWritten?: unknown } | undefined)?.bytesWritten;
  }

  public override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    const pieces: Buffer[] = [];
    let start = 0;
    for (const end of this.frames.feed(chunk)) {
      pieces.push(chunk.subarray(start, end));
      start = end;
    }
    if (start < chunk.length) {
      pieces.push(chunk.subarray(start));
    }

    this.writeInner(pieces, callback);
  }

  public override _flush(callback: TransformCallback): void {
    this.endInner(() => {
      callback();
    });
  }
}

/**
 * Follows zstd frame boundaries (RFC 8878 §3.1) over the bytes fed to a zstd decoder,
 * without decoding them: the frame header's own length, then each block's header and
 * size up to the last block, then the optional checksum. Skippable frames are stepped
 * over. A malformed header is left to the decoder, which fails on it.
 */
class ZstdFrameWalker {
  /** Zstandard frames read whole - data frames, not skippable ones (RFC 8878). */
  public dataFrameCount = 0;
  /**
   * The byte, counted over everything fed, just past the last data frame read whole: a
   * decoder that consumed at least this much has decoded every data frame.
   */
  public lastDataFrameEnd = 0;
  /** Whether the walker met framing it cannot follow (see `readMagic`). */
  public isMalformed = false;
  private skipBytes = 0;
  private readonly fieldBytes: number[] = [];
  private fieldLength = 4;
  private isAwaitingMagic = true;
  private hasFrame = false;
  private hasChecksum = false;
  /** Set when a frame's last field is read: it ends once the bytes it still skips are. */
  private isFrameEnding = false;
  /** Whether the frame ending is a data frame, not a skippable one. */
  private isDataFrameEnding = false;
  /** Bytes fed before the chunk being read. */
  private bytesFed = 0;
  /** What the next field, once `fieldLength` bytes of it are in, is read as. */
  private onField: (field: number[]) => void;

  constructor() {
    this.onField = (field) => {
      this.readMagic(field);
    };
  }

  /**
   * Whether the bytes so far end on a frame boundary, after at least one frame - never
   * for framing the walker could not follow, which it cannot vouch for.
   */
  public get isAtFrameEnd(): boolean {
    return (
      !this.isMalformed &&
      this.hasFrame &&
      this.isAwaitingMagic &&
      this.skipBytes === 0 &&
      this.fieldBytes.length === 0
    );
  }

  /**
   * Follow `chunk`, answering the offsets within it at which a frame ended - just past
   * its last byte - so a caller can hand each frame over on its own.
   */
  public feed(chunk: Uint8Array): number[] {
    const frameEnds: number[] = [];
    let offset = 0;
    const noteFrameEnd = (): void => {
      if (this.isFrameEnding && this.skipBytes === 0) {
        this.isFrameEnding = false;
        frameEnds.push(offset);
        if (this.isDataFrameEnding) {
          this.lastDataFrameEnd = this.bytesFed + offset;
        }
      }
    };

    while (offset < chunk.length && !this.isMalformed) {
      if (this.skipBytes > 0) {
        const skipped = Math.min(this.skipBytes, chunk.length - offset);
        this.skipBytes -= skipped;
        offset += skipped;
        noteFrameEnd();
        continue;
      }

      this.fieldBytes.push(chunk[offset]);
      offset++;

      if (this.fieldBytes.length === this.fieldLength) {
        this.onField(this.fieldBytes.splice(0));
        noteFrameEnd();
      }
    }

    this.bytesFed += chunk.length;
    return frameEnds;
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
        this.isFrameEnding = true;
        this.isDataFrameEnding = false;
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
      this.dataFrameCount++;
      this.skipBytes += this.hasChecksum ? 4 : 0;
      this.isFrameEnding = true;
      this.isDataFrameEnding = true;
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
