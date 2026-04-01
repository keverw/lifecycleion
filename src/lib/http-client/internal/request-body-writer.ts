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
      resolve();
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

    if (!canContinue) {
      isDrainDone = false;
      req.once('drain', onDrain);
      req.once('close', onClose);
      req.once('error', onError);

      if (req.destroyed) {
        onClose();
      }
    }

    maybeResolve();
  });
}
