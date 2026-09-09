/**
 * Test-only helper: keep a deliberate `console.error` fall-through out of the run output.
 *
 * Several features here report to `console.error` when the caller supplies no handler -
 * `onRedactionError`, `onSinkError`, `onEventHandlerError`, and `safe-handle-callback`'s
 * last rung. Tests that exercise those defaults are doing the right thing, but a suite
 * that prints dozens of real-looking error lines buries the ones that mean something.
 *
 * Captures rather than discards, so a test can assert the fall-through happened instead of
 * merely hiding it - the same trade the Node fixtures make in
 * `global-event-target-node-fixtures/capture-console-error`.
 */

/**
 * Flip to `true` locally to let the captured output reach the terminal as well.
 *
 * Left `false` so the suite stays quiet in CI. Turn it on when a test is failing for a
 * reason the assertions do not explain and the console line would say why.
 */
const DEBUG = false;

let original: typeof console.error | null = null;

/**
 * Replace `console.error` and start collecting.
 *
 * @returns The array captured messages are appended to, live - assert against it, or
 *          ignore it when the point is only to keep the output clean.
 */
export function muteConsoleError(): string[] {
  const captured: string[] = [];

  if (original === null) {
    // eslint-disable-next-line no-console -- capturing the real one to restore it later
    original = console.error;
  }

  const passthrough = original;

  // eslint-disable-next-line no-console -- replacing it is the point of this helper
  console.error = (...args: unknown[]): void => {
    captured.push(
      args
        .map((arg) => (arg instanceof Error ? arg.message : String(arg)))
        .join(' '),
    );

    if (DEBUG) {
      passthrough(...args);
    }
  };

  return captured;
}

/**
 * Replace `console.error` with one that throws, and count the attempts.
 *
 * The condition every last-rung reporter has to survive. It is not contrived: Node raises
 * `EPIPE` writing to a pipe whose reader has gone, a stream destroyed during shutdown
 * throws on write, and a harness that patches `console.error` to fail a build on warnings
 * is an ordinary setup. Reporting a failure must never raise one, so a reporter reached
 * with no handler left has to absorb this rather than replace the failure it was
 * describing with its own.
 *
 * Restored by the same {@link restoreConsoleError} the mute helper uses.
 *
 * @returns A live counter of how many times the rung was reached, so a test can assert
 *          the reporter genuinely tried to write rather than skipping the path entirely.
 */
export function breakConsoleError(): { attempts: number } {
  const calls = { attempts: 0 };

  if (original === null) {
    // eslint-disable-next-line no-console -- capturing the real one to restore it later
    original = console.error;
  }

  // eslint-disable-next-line no-console -- breaking it is the point of this helper
  console.error = (): never => {
    calls.attempts++;

    throw new Error('console.error is broken');
  };

  return calls;
}

/**
 * Remove `console.error` entirely, as a runtime with a stripped console would.
 *
 * A different failure from {@link breakConsoleError}: the call site raises a `TypeError`
 * for calling a non-function rather than propagating a thrown `Error`, and a guard that
 * only anticipated the latter would still let this one through.
 */
export function removeConsoleError(): void {
  if (original === null) {
    // eslint-disable-next-line no-console -- capturing the real one to restore it later
    original = console.error;
  }

  // The cast is what removes it: `no-console` does not fire here because the member is
  // reached through it rather than as `console.error` directly.
  (console as { error?: unknown }).error = undefined;
}

/**
 * Put the real `console.error` back. Safe to call when nothing was muted, broken or
 * removed.
 */
export function restoreConsoleError(): void {
  if (original !== null) {
    // eslint-disable-next-line no-console -- restoring what the helpers above replaced
    console.error = original;
    original = null;
  }
}
