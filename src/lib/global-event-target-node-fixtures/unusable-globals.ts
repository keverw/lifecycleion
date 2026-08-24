/**
 * Node-runtime fixture: a global member that exists but is not callable.
 *
 * `globalThis.dispatchEvent = null` is not something lifecycleion put there, so it must
 * not be clobbered even though it is unusable — the "never overwrites" guarantee is about
 * what is present, not about what happens to be callable.
 */

// Only dynamic imports below (the globals must be set up first), so make this a module.
export {};

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
