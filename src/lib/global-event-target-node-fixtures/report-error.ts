/**
 * Node-runtime fixture: exercises Lifecycleion's `'reportError'` convention end to end.
 *
 * Bundled by `global-event-target.node.test.ts` and executed by the real `node` binary,
 * where `globalThis` is not an EventTarget. Results are written to stdout as JSON.
 */

import {
  safeHandleCallback,
  safeHandleCallbackAndWait,
} from '../safe-handle-callback';
import {
  getGlobalEventTarget,
  installGlobalEventTarget,
  isGlobalEventTargetPolyfilled,
} from '../global-event-target';

const uncaught: string[] = [];
const unhandled: string[] = [];

process.on('uncaughtException', (error: Error) => {
  uncaught.push(error.message);
});

process.on('unhandledRejection', (reason: unknown) => {
  unhandled.push(reason instanceof Error ? reason.message : String(reason));
});

const globalRecord = globalThis as unknown as Record<string, unknown>;

// Snapshot before the app registers anything: importing lifecycleion should be enough
// for plain `globalThis.addEventListener(...)` to work.
const globalsAfterImport = {
  hasAddEventListener: typeof globalRecord.addEventListener === 'function',
  hasRemoveEventListener:
    typeof globalRecord.removeEventListener === 'function',
  hasDispatchEvent: typeof globalRecord.dispatchEvent === 'function',
  hasErrorEvent: typeof globalRecord.ErrorEvent === 'function',
  isPolyfilled: isGlobalEventTargetPolyfilled(),
  areEnumerable: Object.keys(globalThis).filter((key) =>
    ['addEventListener', 'removeEventListener', 'dispatchEvent'].includes(key),
  ),
};

interface ReportedError {
  isErrorEvent: boolean;
  type: string;
  message: string;
  originalStack: boolean;
}

const reported: ReportedError[] = [];

const listener = (event: Event): void => {
  const errorEvent = event as ErrorEvent;

  reported.push({
    isErrorEvent: errorEvent instanceof ErrorEvent,
    type: errorEvent.type,
    message: errorEvent.error instanceof Error ? errorEvent.error.message : '',
    originalStack:
      errorEvent.error instanceof Error &&
      typeof errorEvent.error.stack === 'string',
  });
};

globalThis.addEventListener('reportError', listener);

// 1. Synchronous throw through the fire-and-forget helper.
safeHandleCallback('syncCallbackWithError', () => {
  throw new Error('Sync boom');
});

// 2. Rejected async callback through the fire-and-forget helper.
safeHandleCallback('asyncCallbackWithError', () =>
  Promise.reject(new Error('Async boom')),
);

// 3. A callback that is not a function at all.
safeHandleCallback('nonFunctionCallback', 123);

// Give the async rejection a turn of the microtask/macrotask queue to land.
await new Promise((resolve) => setTimeout(resolve, 25));

// 4. The awaiting variant still returns its structured failure *and* reports it.
const waitResult = await safeHandleCallbackAndWait(
  'waitCallbackWithError',
  () => {
    throw new Error('Wait boom');
  },
);

// 5. Repeat installation: harmless, and the backing target must be identical.
const targetBefore = getGlobalEventTarget();
const dispatchBefore = globalRecord.dispatchEvent;
const repeatResults = [
  installGlobalEventTarget(),
  installGlobalEventTarget(),
  installGlobalEventTarget(),
];
const targetAfter = getGlobalEventTarget();

// The listener registered long before those re-installs must still be attached.
const reportedCountBeforeFinalDispatch = reported.length;

globalThis.dispatchEvent(
  new ErrorEvent('reportError', { error: new Error('After reinstall') }),
);

globalThis.removeEventListener('reportError', listener);

// After removal nothing further should be recorded.
globalThis.dispatchEvent(
  new ErrorEvent('reportError', { error: new Error('After removal') }),
);

process.stdout.write(
  JSON.stringify({
    nodeVersion: process.versions.node,
    globalsAfterImport,
    reported,
    waitResult: {
      success: waitResult.success,
      errorMessage:
        waitResult.error instanceof Error ? waitResult.error.message : null,
    },
    repeat: {
      results: repeatResults,
      isSameTarget: targetBefore !== null && targetBefore === targetAfter,
      isSameDispatch: dispatchBefore === globalRecord.dispatchEvent,
      countBeforeFinalDispatch: reportedCountBeforeFinalDispatch,
    },
    uncaught,
    unhandled,
  }),
);
