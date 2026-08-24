/**
 * Node-runtime fixture: `globalThis.EventTarget` itself is a throwing accessor.
 *
 * The constructor is a global like any other, so it needs the same guarded read as the
 * event methods — otherwise the import dies before any of them is even reached.
 */

// Only dynamic imports below (the globals must be set up first), so make this a module.
export {};

let getterCallCount = 0;

Object.defineProperty(globalThis, 'EventTarget', {
  get() {
    getterCallCount++;

    throw new Error('EventTarget getter boom');
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
    safeHandleCallback('hostileEventTargetCallback', () => {
      throw new Error('Hostile EventTarget boom');
    });
  } catch {
    didThrow = true;
  }

  const waitResult = await safeHandleCallbackAndWait(
    'hostileEventTargetWaitCallback',
    () => {
      throw new Error('Hostile EventTarget wait boom');
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
    wasGetterCalled: getterCallCount > 0,
    didThrow,
    waitResult: { success: didWaitSucceed, errorMessage: waitMessage },
  }),
);
