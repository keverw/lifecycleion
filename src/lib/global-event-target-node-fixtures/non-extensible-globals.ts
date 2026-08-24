/**
 * Node-runtime fixture: a non-extensible global object.
 *
 * `Object.defineProperty` throws on a sealed global, and the install runs during module
 * initialization — so a throw here would break the import of `safe-handle-callback` and
 * everything that depends on it. Importing must stay safe, and nothing may be left
 * half-installed.
 */

// Only dynamic imports below (the global must be sealed first), so make this a module.
export {};

const globalRecord = globalThis as unknown as Record<string, unknown>;

Object.preventExtensions(globalThis);

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

  try {
    safeHandleCallback('sealedGlobalsCallback', () => {
      throw new Error('Sealed globals boom');
    });
  } catch {
    didThrow = true;
  }

  const waitResult = await safeHandleCallbackAndWait(
    'sealedGlobalsWaitCallback',
    () => {
      throw new Error('Sealed globals wait boom');
    },
  );

  didWaitSucceed = waitResult.success;
  waitMessage =
    waitResult.error instanceof Error ? waitResult.error.message : null;

  isPolyfilled = isGlobalEventTargetPolyfilled();
} catch {
  didImportThrow = true;
}

process.stdout.write(
  JSON.stringify({
    didImportThrow,
    installResult,
    isPolyfilled,
    // Nothing may be left behind on the global object, including the backing target.
    hasAddEventListener: typeof globalRecord.addEventListener === 'function',
    hasRemoveEventListener:
      typeof globalRecord.removeEventListener === 'function',
    hasDispatchEvent: typeof globalRecord.dispatchEvent === 'function',
    ownSymbols: Object.getOwnPropertySymbols(globalThis)
      .map((symbol) => symbol.toString())
      .filter((description) => description.includes('lifecycleion')),
    didThrow,
    waitResult: { success: didWaitSucceed, errorMessage: waitMessage },
  }),
);
