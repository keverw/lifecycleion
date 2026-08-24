/**
 * Node-runtime fixture: a global event method whose getter throws.
 *
 * Reading a global runs its accessor, and an accessor is free to throw. The install runs
 * during module initialization, so an unguarded probe would crash the import rather than
 * degrade — the same failure mode as the sealed global in `non-extensible-globals`.
 */

// Only dynamic imports below (the globals must be set up first), so make this a module.
export {};

let getterCallCount = 0;

Object.defineProperty(globalThis, 'dispatchEvent', {
  get() {
    getterCallCount++;

    throw new Error('hostile getter');
  },
  configurable: true,
});

let didImportThrow = false;
let installResult = 'not-reached';
let isPolyfilled = false;
let didThrow = false;
let didWaitSucceed: boolean | null = null;
let waitMessage: string | null = null;

try {
  const { safeHandleCallback, safeHandleCallbackAndWait } =
    await import('../safe-handle-callback');
  const { installGlobalEventTarget, isGlobalEventTargetPolyfilled } =
    await import('../global-event-target');

  installResult = installGlobalEventTarget();
  isPolyfilled = isGlobalEventTargetPolyfilled();

  try {
    safeHandleCallback('hostileGlobalsCallback', () => {
      throw new Error('Hostile globals boom');
    });
  } catch {
    didThrow = true;
  }

  const waitResult = await safeHandleCallbackAndWait(
    'hostileGlobalsWaitCallback',
    () => {
      throw new Error('Hostile globals wait boom');
    },
  );

  didWaitSucceed = waitResult.success;
  waitMessage =
    waitResult.error instanceof Error ? waitResult.error.message : null;
} catch {
  didImportThrow = true;
}

process.stdout.write(
  JSON.stringify({
    didImportThrow,
    installResult,
    isPolyfilled,
    // Proof the throwing getter really was exercised rather than quietly skipped.
    wasGetterCalled: getterCallCount > 0,
    // The accessor must still be the app's, untouched.
    isAccessorPreserved:
      Object.getOwnPropertyDescriptor(globalThis, 'dispatchEvent')?.get !==
      undefined,
    didThrow,
    waitResult: { success: didWaitSucceed, errorMessage: waitMessage },
  }),
);
