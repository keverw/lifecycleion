import { queueMicrotaskSafely } from '../../../internal/promise-reactions';

/**
 * The promise a queueing sink's `close()` hands to every caller, running `run` once on a
 * later microtask.
 *
 * The sink stores this before `run` starts, so a close-time callback that calls `close()`
 * again joins the same promise instead of starting a second close. A synchronous throw
 * from `run` rejects the promise rather than escaping the microtask.
 */
export function deferClose(run: () => Promise<void>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    queueMicrotaskSafely(() => {
      void run().then(resolve, reject);
    }, reject);
  });
}
