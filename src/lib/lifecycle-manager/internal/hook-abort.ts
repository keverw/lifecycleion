import { guardAbortListeners } from '../../internal/guarded-abort-signal';
import { reportCallbackError } from '../../safe-handle-callback';

/**
 * A fresh controller for one call of a component hook, its signal guarded before the
 * hook sees it so a listener the component adds cannot throw out of the abort.
 */
export function createHookAbortController(
  name: string,
  phase: 'start' | 'stop' | 'force',
): AbortController {
  const hookAbort = new AbortController();
  guardAbortListeners(
    hookAbort.signal,
    `lifecycle-manager ${phase} abort listener for ${name}`,
  );
  return hookAbort;
}

/**
 * Abort the signal an attempt handed to one of the component's hooks - `start()`,
 * `stop()`, `onShutdownForce()` - once the manager no longer needs that still-pending
 * call's work: from inside its deadline's timer, as a shutdown pass begins
 * (`abortPendingStarts`), or when a late graceful completion ends a force phase first.
 *
 * Abort listeners are the component's code, but they are the runtime's to call: an
 * error one throws never reaches `abort()`'s caller, and Node and Bun would report it
 * as an uncaught exception. `guardAbortListeners()` wrapped the listeners the
 * component added through the signal's own methods and `onabort`, so theirs are
 * reported (`lifecycle-manager <phase> abort listener for <name>`) instead. Listeners
 * it cannot see - on a signal derived from this one, or added through
 * `EventTarget.prototype` directly - remain the runtime's. Every caller has finished
 * its bookkeeping before this runs. The `catch` only covers a runtime that let such
 * an error escape: reported, so it cannot unwind the timer and skip what follows.
 */
export function abortHookSignal(
  hookAbort: AbortController,
  reason: Error,
  name: string,
  hookName: 'start' | 'stop' | 'onShutdownForce',
): void {
  try {
    hookAbort.abort(reason);
  } catch (error) {
    reportCallbackError(`${name}.${hookName} abort signal listener`, error);
  }
}
