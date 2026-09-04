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

/** Put the real `console.error` back. Safe to call when nothing was muted. */
export function restoreConsoleError(): void {
  if (original !== null) {
    // eslint-disable-next-line no-console -- restoring what `muteConsoleError` replaced
    console.error = original;
    original = null;
  }
}
