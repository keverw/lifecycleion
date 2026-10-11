import type { Writable } from 'stream';
import { raceDeadline } from '../../../internal/race-deadline';
import { MIN_CLOSE_FLUSH_MS } from './queue-policy';

export interface EndStreamOptions {
  /**
   * Whether the deadline may let the process exit while it waits.
   *
   * `false` for a `close()` the caller awaits: the wait is bounded, and its loss report
   * has to go out before the process does - a FIFO write waiting for a reader holds
   * nothing else open. `true` for a flush nothing waits on at exit: a rotation, or a
   * stream a reconnect has let go of.
   */
  shouldUnref: boolean;
  /**
   * Told how many bytes the stream still held when it did not flush - the wait gave up,
   * `end()` threw, or the flush failed - before `destroy()` fails their write callbacks, so
   * the caller can mark the stream as abandoned first.
   */
  onAbandon?: (bytesLeft: number) => void;
  /**
   * A throw from `end()`. The stream is then abandoned as if its flush had timed out, and
   * {@link onAbandon} follows: one failure, for a caller that reports from both to say once.
   *
   * Not called for a flush that fails. That failure reaches `end()`'s callback and the
   * stream's `'error'` event alike, and the event is where the stream's owner reports it.
   */
  onEndError?: (error: unknown) => void;
}

/**
 * End a stream and wait for it to flush, giving up after `timeoutMS`, then destroy it.
 *
 * The bound is the point. `end(cb)` flushes before it calls back, so on a hung mount or a
 * FIFO with no reader that callback never fires; an unbounded wait hangs a `close()` that
 * documents a timeout, or parks a rotation and the queue behind it for good. Giving up
 * loses what that one stream still buffered; waiting forever loses the sink.
 *
 * Floored at {@link MIN_CLOSE_FLUSH_MS}: a close whose drain spent its budget arrives
 * here with nothing left, and a zero-millisecond timer always beats a `'finish'` that
 * cannot fire synchronously, which would make the final flush unreachable for a stream
 * that would have flushed at once.
 *
 * Destroyed either way, so a flush that is never going to happen does not hold the
 * descriptor for the life of the process. Resolves with the bytes the stream still held
 * when it did not flush, `0` when it did. Never rejects.
 */
export async function endStreamWithin(
  stream: Writable,
  timeoutMS: number,
  options: EndStreamOptions,
): Promise<number> {
  let didFlush: boolean;

  try {
    didFlush = await raceDeadline(
      new Promise<boolean>((resolve) => {
        // Node hands the callback the stream's error when the flush fails. Typed as taking
        // nothing, but a failed final flush is not a flushed stream.
        stream.end((error?: Error | null) => {
          resolve(error === undefined || error === null);
        });
      }),
      Math.max(MIN_CLOSE_FLUSH_MS, timeoutMS),
      () => false,
      { shouldUnref: options.shouldUnref },
    );
  } catch (error) {
    options.onEndError?.(error);
    didFlush = false;
  }

  let bytesLeft = 0;

  if (!didFlush) {
    bytesLeft = stream.writableLength;
    options.onAbandon?.(bytesLeft);
  }

  if (!stream.destroyed) {
    try {
      stream.destroy();
    } catch {
      // Best effort; the stream is going away either way.
    }
  }

  return bytesLeft;
}
