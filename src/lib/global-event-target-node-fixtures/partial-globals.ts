/**
 * Node-runtime fixture: an environment with a partial/foreign event surface.
 *
 * Only `addEventListener` exists. Filling in the other two from a fresh backing target
 * would send dispatches somewhere the existing listeners are not, so lifecycleion must
 * leave the environment alone and degrade to reporting nothing — without throwing.
 */

// Only dynamic imports below (globals must be set up first), so make this a module.
export {};

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
