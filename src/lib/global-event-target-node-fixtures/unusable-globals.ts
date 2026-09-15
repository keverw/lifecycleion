/**
 * Node-runtime fixture: a global member that exists but is not callable.
 *
 * `globalThis.dispatchEvent = null` is not something lifecycleion put there, so it must
 * not be clobbered even though it is unusable — the "never overwrites" guarantee is about
 * what is present, not about what happens to be callable.
 */
import { captureConsoleError } from './capture-console-error';

// Only dynamic imports below (the globals must be set up first), so make this a module.
export {};

// `safe-handle-callback` writes an unclaimed report to `console.error`; the harness
// treats any stderr output as a crash, so it is collected and reported instead.
const consoleErrors = captureConsoleError();

const globalRecord = globalThis as unknown as Record<string, unknown>;

globalRecord.dispatchEvent = null;

const { safeHandleCallback, safeHandleCallbackAndWait } =
  await import('../safe-handle-callback');
const { installGlobalEventTarget, isGlobalEventTargetPolyfilled } =
  await import('../global-event-target');

const installResult = installGlobalEventTarget();

let didThrow = false;

try {
  safeHandleCallback('unusableGlobalsCallback', () => {
    throw new Error('Unusable globals boom');
  });
} catch {
  didThrow = true;
}

const waitResult = await safeHandleCallbackAndWait(
  'unusableGlobalsWaitCallback',
  () => {
    throw new Error('Unusable globals wait boom');
  },
);

process.stdout.write(
  JSON.stringify({
    consoleErrors,
    installResult,
    isPolyfilled: isGlobalEventTargetPolyfilled(),
    // The value the app put there must survive untouched.
    isDispatchPreserved: globalRecord.dispatchEvent === null,
    hasAddEventListener: typeof globalRecord.addEventListener === 'function',
    hasRemoveEventListener:
      typeof globalRecord.removeEventListener === 'function',
    didThrow,
    waitResult: {
      success: waitResult.success,
      errorMessage:
        waitResult.error instanceof Error ? waitResult.error.message : null,
    },
  }),
);
