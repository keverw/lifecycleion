import type { AdapterProgressEvent } from '../types';
import type { RequestBodyWritable } from './request-body-writable';
import { completeProgressEvent } from './progress';

/**
 * 16 KB chunks: meaningful upload progress granularity (a 1 MB body fires ~64
 * events) without excessive syscall overhead from tiny writes.
 */
export const REQUEST_BODY_CHUNK_SIZE = 16 * 1024;

/**
 * Writes a pre-serialized request body buffer (string or Uint8Array body, not
 * FormData) into a RequestBodyWritable in fixed-size chunks.
 *
 * Each chunk awaits its write callback before the next chunk is sent. This
 * serves two purposes:
 *   1. Progress accuracy — each event reflects bytes actually handed off to the
 *      OS socket buffer, not just bytes queued in the JS write buffer.
 *   2. Backpressure — we don't race ahead of the socket; if the OS buffer is
 *      full the await naturally yields until there's room.
 *
 * This is intentionally separate from multipart handling. Multipart uploads
 * need boundaries/part headers and may stream Blob chunks directly; this
 * helper is only for bodies that are already serialized into one Buffer.
 */
export async function writeRequestBodyChunked(
  data: Buffer,
  req: RequestBodyWritable,
  onProgress?: (e: AdapterProgressEvent) => void,
): Promise<void> {
  const totalSize = data.length;

  if (totalSize === 0) {
    // Empty explicit bodies still need a terminal completion event so progress
    // consumers do not wait forever for a 100% upload signal.
    onProgress?.(completeProgressEvent(0));
    return;
  }

  let uploadedBytes = 0;

  while (uploadedBytes < totalSize && !req.destroyed) {
    // Slice the next fixed-size window from the already-serialized payload.
    const chunk = data.subarray(
      uploadedBytes,
      uploadedBytes + REQUEST_BODY_CHUNK_SIZE,
    );

    // Wait for the write callback before moving on so large uploads do not outrun
    // socket backpressure. See `writeChunkWithBackpressure`.
    await writeChunkWithBackpressure(req, chunk, () => {
      // Only count bytes after the writable confirms the chunk was accepted.
      uploadedBytes += chunk.length;
      onProgress?.({
        loaded: uploadedBytes,
        total: totalSize,
        progress: uploadedBytes / totalSize,
      });
    });
  }

  // The loop's other exit. `onClose` rejects a chunk that was waiting for its callback, but
  // a stream destroyed between chunks - with no chunk waiting, so no `'close'` listener
  // attached - leaves the loop through `!req.destroyed`, and resolving there would let
  // `node-adapter` follow with `req.end()`, finalizing a body short of the `Content-Length`
  // it already declared; on a runtime that does not emit `'error'` on `req.destroy()`
  // nothing else would report it. A truncated write is a failed write, whichever exit
  // reached it.
  if (uploadedBytes < totalSize) {
    throw new Error('Request stream closed before the body was fully written');
  }
}

/**
 * Writes one chunk into `req` and resolves once the writable has accepted it - its write
 * callback has run - calling `onAccepted` just before. Rejects when the stream errors, or
 * closes with the chunk not yet accepted, and with what `onAccepted` throws. Shared by
 * `writeRequestBodyChunked` and `serializeMultipartFormData`, which count a chunk's bytes
 * in `onAccepted`.
 *
 * The callback alone is the backpressure, not `'drain'`. It runs once the chunk has been
 * handed to the socket, so a writer that awaits each chunk before the next - both callers
 * do - never has more than one chunk in flight, however slowly the receiver reads; a
 * receiver that stops reading never calls it, which is what the adapter's upload-stall
 * watchdog reads as no progress. Waiting for `'drain'` as well would buy nothing over that
 * and would break an upload the server acks early and goes on reading: Node and Bun stop
 * emitting `'drain'` on a request whose response has ended while the request has not, so
 * a chunk that asked for one - every multipart `File` chunk does, being larger than the
 * request's high-water mark - would wait for good, and the watchdog would cut the body
 * short.
 */
export function writeChunkWithBackpressure(
  req: RequestBodyWritable,
  chunk: string | Buffer | Uint8Array,
  onAccepted?: () => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let hasWriteReturned = false;
    let isWriteCallbackDone = false;
    let isSettled = false;

    const cleanup = (): void => {
      req.off('close', onClose);
      req.off('error', onError);
    };

    const maybeResolve = (): void => {
      if (isSettled || !isWriteCallbackDone) {
        return;
      }

      isSettled = true;
      cleanup();

      // Rejected with what it threw: settled and with its listeners off, an uncaught throw
      // would leave the promise pending for good - and, from the write callback, escape as
      // an uncaught exception.
      try {
        onAccepted?.();
      } catch (error) {
        // As thrown: the caller's own value, not one this writer made.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        reject(error);
        return;
      }

      resolve();
    };

    const onClose = (): void => {
      if (isSettled) {
        return;
      }

      isSettled = true;
      cleanup();

      // Rejects, and that is the whole point of this branch. A stream that closes while a
      // chunk is still waiting for its callback has *not* accepted the chunk, so resolving
      // would report an upload that never happened: the loop above would exit on
      // `!req.destroyed`, `node-adapter` would follow with `req.end()`, and a truncated
      // body would be finalized as though it had been sent in full - on a writable that
      // applies backpressure and then closes, nought bytes accepted, promise resolved, no
      // error anywhere.
      //
      // Usually a real `ClientRequest` also emits `'error'` and the adapter turns that into
      // a transport failure - but not always, and this file's own neighbour says so:
      // "some runtimes (e.g. Bun) do not emit 'error' on req.destroy()". In exactly that
      // case this listener is the only one that runs, so it has to be the one that tells
      // the truth. A truncated write is a failed write.
      reject(
        new Error('Request stream closed before the body was fully written'),
      );
    };

    const onError = (error: Error): void => {
      if (isSettled) {
        return;
      }

      isSettled = true;
      cleanup();
      reject(error);
    };

    req.write(chunk, (error: Error | null | undefined): void => {
      if (error) {
        // Guarded on the way in as well as marked on the way out. This callback can fire
        // *after* `onClose` or `onError` already settled - a chunk whose socket dies
        // delivers `'close'` first and the pending `ECONNRESET` second - and running on
        // regardless would mean a second `cleanup()` and a second `reject` on a promise
        // that was already rejected.
        if (isSettled) {
          return;
        }

        // Settled, as `onClose` and `onError` mark themselves. Left unmarked, a later
        // `'close'` or `'error'` would run its whole body again - `cleanup()` a second time
        // and a second `reject` on a promise already rejected - and the registration below
        // could not tell that there was nothing left to wait for.
        isSettled = true;
        cleanup();
        reject(error);
        return;
      }

      isWriteCallbackDone = true;
      if (hasWriteReturned) {
        maybeResolve();
      }
    });
    hasWriteReturned = true;

    // Armed for every chunk still waiting on its callback. A socket that dies while a chunk
    // sits in the buffer never calls it: with nothing listening, nothing would reject and
    // nothing resolve, so the writer's promise would stay pending for good. That is the
    // promise `requestBodySettled` hands the caller - an early-ack `200` whose connection
    // then dropped would leave an `await` on it hanging forever - and the adapter's own
    // upload-stall watchdog could not help: it destroys the request, which is precisely the
    // event these listeners are here for.
    //
    // `!isSettled` throughout. The write callback can run synchronously with an error - a
    // `ClientRequest` already destroyed answers that way - settling the write and running
    // `cleanup()` before any listener exists. Listeners attached afterwards would have
    // nothing to take them off again: the `req.destroyed` guard calls `onClose`, which
    // returns on `isSettled`, so they would stay on `req` for the life of the request -
    // once per chunk, which is the `MaxListenersExceededWarning` path.
    if (!isSettled) {
      req.once('close', onClose);
      req.once('error', onError);

      if (req.destroyed) {
        onClose();
      }
    }

    maybeResolve();
  });
}
