/**
 * Node-runtime fixture: an environment with a partial/foreign event surface.
 *
 * Only `addEventListener` exists. Filling in the other two from a fresh backing target
 * would send dispatches somewhere the existing listeners are not, so lifecycleion must
 * leave the environment alone and degrade to reporting nothing — without throwing.
 */
import { captureConsoleError } from './capture-console-error';

// Only dynamic imports below (globals must be set up first), so make this a module.
export {};

// `safe-handle-callback` writes an unclaimed report to `console.error`; the harness
// treats any stderr output as a crash, so it is collected and reported instead.
const consoleErrors = captureConsoleError();

const globalRecord = globalThis as unknown as Record<string, unknown>;

const foreignTarget = new EventTarget();

globalRecord.addEventListener =
  foreignTarget.addEventListener.bind(foreignTarget);

const { safeHandleCallback, safeHandleCallbackAndWait } =
  await import('../safe-handle-callback');
const { installGlobalEventTarget, isGlobalEventTargetPolyfilled } =
  await import('../global-event-target');

const installResult = installGlobalEventTarget();

let didThrow = false;

try {
  safeHandleCallback('partialGlobalsCallback', () => {
    throw new Error('Partial globals boom');
  });
} catch {
  didThrow = true;
}

const waitResult = await safeHandleCallbackAndWait(
  'partialGlobalsWaitCallback',
  () => {
    throw new Error('Partial globals wait boom');
  },
);

process.stdout.write(
  JSON.stringify({
    consoleErrors,
    installResult,
    isPolyfilled: isGlobalEventTargetPolyfilled(),
    hasDispatchEvent: typeof globalRecord.dispatchEvent === 'function',
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
