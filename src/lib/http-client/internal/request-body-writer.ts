import type { AdapterProgressEvent } from '../types';
import type { RequestBodyWritable } from './request-body-writable';

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
    onProgress?.({ loaded: 0, total: 0, progress: 1 });
    return;
  }

  let uploadedBytes = 0;

  while (uploadedBytes < totalSize && !req.destroyed) {
    // Slice the next fixed-size window from the already-serialized payload.
    const chunk = data.subarray(
      uploadedBytes,
      uploadedBytes + REQUEST_BODY_CHUNK_SIZE,
    );

    // Wait for both the write callback and any required drain signal before
    // moving on so large uploads do not outrun socket backpressure.
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

  // The loop's other exit. `onClose` rejects a chunk that was waiting for its callback or
  // its drain, but a stream destroyed between chunks - with nothing under backpressure, so
  // no `'close'` listener was ever attached - leaves the loop through `!req.destroyed` and
  // used to resolve. `node-adapter` then follows with `req.end()`, finalizing a body short
  // of the `Content-Length` it already declared, and on a runtime that does not emit
  // `'error'` on `req.destroy()` nothing else reports it. A truncated write is a failed
  // write, whichever exit reached it.
  if (uploadedBytes < totalSize) {
    throw new Error('Request stream closed before the body was fully written');
  }
}

function writeChunkWithBackpressure(
  req: RequestBodyWritable,
  chunk: Buffer,
  onAccepted?: () => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let hasWriteReturned = false;
    let isWriteCallbackDone = false;
    let isDrainDone = true;
    let isSettled = false;

    const cleanup = (): void => {
      req.off('drain', onDrain);
      req.off('close', onClose);
      req.off('error', onError);
    };

    const maybeResolve = (): void => {
      if (isSettled || !isWriteCallbackDone || !isDrainDone) {
        return;
      }

      isSettled = true;
      cleanup();
      onAccepted?.();
      resolve();
    };

    const onDrain = (): void => {
      isDrainDone = true;
      maybeResolve();
    };

    const onClose = (): void => {
      if (isSettled) {
        return;
      }

      isSettled = true;
      cleanup();

      // Rejects, and that is the whole point of this branch. A stream that closes while a
      // chunk is still waiting for its callback or its drain has *not* accepted the chunk,
      // so resolving reported an upload that never happened: the loop above exits on
      // `!req.destroyed`, `node-adapter` follows with `req.end()`, and a truncated body is
      // finalized as though it had been sent in full. Measured on a writable that applies
      // backpressure and then closes: nought bytes accepted, promise resolved, no error
      // anywhere.
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

    const canContinue = req.write(
      chunk,
      (error: Error | null | undefined): void => {
        if (error) {
          // Guarded on the way in as well as marked on the way out, the same pair
          // `serializeMultipartFormData`'s write callback keeps. This callback can fire
          // *after* `onClose` or `onError` already settled - a chunk under backpressure
          // whose socket dies delivers `'close'` first and the pending `ECONNRESET`
          // second - and running on regardless meant a second `cleanup()` and a second
          // `reject` on a promise that was already rejected.
          if (isSettled) {
            return;
          }

          // Settled, as `onClose` and `onError` mark themselves. Left unmarked, a later
          // `'close'` or `'error'` ran its whole body again - `cleanup()` a second time and
          // a second `reject` on a promise already rejected - and the registration below
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
      },
    );
    hasWriteReturned = true;

    // Armed whether or not the write was backpressured. A chunk the buffer took without
    // asking for a drain still has a callback that only Node will call, and a socket that dies
    // while it sits there never calls it: with the listeners attached only under backpressure,
    // nothing rejected and nothing resolved, so the writer's promise stayed pending for good.
    // That is the promise `requestBodySettled` hands the caller - an early-ack `200` whose
    // connection then dropped left an `await` on it hanging forever - and the adapter's own
    // upload-stall watchdog could not help: it destroys the request, which is precisely the
    // event nothing was listening for.
    //
    // `'drain'` stays conditional: only a backpressured write has one coming.
    //
    // `!isSettled` throughout. The write callback can run synchronously with an error - a
    // `ClientRequest` already destroyed answers that way - settling the write and running
    // `cleanup()` before any listener exists. Attaching listeners afterwards armed nothing that
    // could take them off again: the `req.destroyed` guard calls `onClose`, which returns on
    // `isSettled`, so they stayed on `req` for the life of the request - once per chunk, which
    // is the `MaxListenersExceededWarning` path.
    if (!isSettled) {
      if (!canContinue) {
        isDrainDone = false;
        req.once('drain', onDrain);
      }

      req.once('close', onClose);
      req.once('error', onError);

      if (req.destroyed) {
        onClose();
      }
    }

    maybeResolve();
  });
}
