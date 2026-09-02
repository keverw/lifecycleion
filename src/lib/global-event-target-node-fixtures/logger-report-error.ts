/**
 * Node-runtime fixture: the logger's global `'error'` listener.
 *
 * Without the global event methods this returned `'not_available'` on Node and callback
 * failures were never logged.
 */
import { Logger } from '../logger';
import { ArraySink } from '../logger/sinks/array';
import { safeHandleCallback } from '../safe-handle-callback';

import { captureConsoleError } from './capture-console-error';

// `safe-handle-callback` writes an unclaimed report to `console.error`; the harness
// treats any stderr output as a crash, so it is collected and reported instead.
const consoleErrors = captureConsoleError();

const arraySink = new ArraySink();

const logger = new Logger({
  sinks: [arraySink],
  callProcessExit: false,
});

const isAvailable = logger.isReportErrorAvailable();
const registerResult = logger.registerReportErrorListener();

safeHandleCallback('loggerReportedCallback', () => {
  throw new Error('Logger boom');
});

const unregisterResult = logger.unregisterReportErrorListener();

process.stdout.write(
  JSON.stringify({
    consoleErrors,
    isAvailable,
    registerResult,
    unregisterResult,
    logs: arraySink.logs.map((entry) => ({
      type: entry.type,
      message: entry.message,
    })),
  }),
);
