/**
 * Node-runtime fixture: the reporting rungs below the `'error'` dispatch.
 *
 * `dispatchEvent` is occupied by a non-callable before lifecycleion is imported, so the
 * polyfill declines to install (`'partial'`) and the dispatch rung is unavailable. That
 * leaves the two fall-backs to prove, in order:
 *
 * 1. `globalThis.reportError(error)` when the runtime provides it. Node does not, so the
 *    fixture supplies one — this is the rung that matters on Bun and in browsers.
 * 2. `console.error(error)` when it does not.
 */

import { captureConsoleError } from './capture-console-error';
import { reportedMessage } from './reported-message';

// Only dynamic imports below (the globals must be set up first), so make this a module.
export {};

const consoleErrors = captureConsoleError();

const globalRecord = globalThis as unknown as Record<string, unknown>;

// Occupied but unusable: the polyfill must leave it alone, so nothing can be dispatched.
globalRecord.dispatchEvent = null;

const reportedToHost: string[] = [];

globalRecord.reportError = (error: unknown): void => {
  reportedToHost.push(reportedMessage(error));
};

const { safeHandleCallback } = await import('../safe-handle-callback');
const { installGlobalEventTarget } = await import('../global-event-target');

const installResult = installGlobalEventTarget();

safeHandleCallback('reportErrorRungCallback', () => {
  throw new Error('Reported to the host');
});

const consoleErrorsAfterReportError = consoleErrors.length;

// Rung 2 gone as well: the only path left is the console.
globalRecord.reportError = undefined;

safeHandleCallback('consoleRungCallback', () => {
  throw new Error('Reported to the console');
});

process.stdout.write(
  JSON.stringify({
    installResult,
    reportedToHost,
    consoleErrorsAfterReportError,
    consoleErrors,
  }),
);
