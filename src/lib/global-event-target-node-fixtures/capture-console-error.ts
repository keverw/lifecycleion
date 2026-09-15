/**
 * Node-runtime fixture helper: capture `console.error` instead of letting it reach stderr.
 *
 * `safe-handle-callback` falls through to `console.error` when no listener claims the
 * dispatched `'error'` event — including every fixture that deliberately leaves the global
 * event methods unusable. The Node test harness treats a non-empty stderr as proof that a
 * fixture crashed, so that fall-through has to be collected rather than printed, and the
 * fixtures report it in their JSON so the rung is asserted rather than merely silenced.
 */

const captured: string[] = [];

/**
 * Replace `console.error` for the lifetime of the fixture.
 *
 * @returns The array that captured messages are appended to, live.
 */
export function captureConsoleError(): string[] {
  // eslint-disable-next-line no-console -- replacing it is the point of this helper
  console.error = (...args: unknown[]): void => {
    captured.push(
      args
        .map((arg) => (arg instanceof Error ? arg.message : String(arg)))
        .join(' '),
    );
  };

  return captured;
}
