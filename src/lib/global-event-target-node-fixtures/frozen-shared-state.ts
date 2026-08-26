/**
 * Node-runtime fixture: shared state that cannot be written back to.
 *
 * The state object lives on a global, so another copy of Lifecycleion — or a test
 * harness, or anything else — may have frozen it. Installation flips
 * `isInstalled` last, and on a frozen object that assignment throws in strict
 * mode. Since installation runs during module initialization, an unguarded write
 * would crash the import after having already defined the three methods.
 */

// Only dynamic imports below (the global must be set up first), so make this a module.
export {};

const GLOBAL_KEY = '__lifecycleion_global_event_target__';

// Valid shape and a real backing target, so it passes validation and is reused —
// the write is the only thing that fails.
const sharedState = Object.freeze({
  target: new EventTarget(),
  isInstalled: false,
});

Object.defineProperty(globalThis, GLOBAL_KEY, {
  value: sharedState,
  enumerable: false,
  writable: false,
  configurable: true,
});

let didImportThrow = false;
let installResult = 'not-reached';
let isPolyfilled = false;

try {
  const { installGlobalEventTarget, isGlobalEventTargetPolyfilled } =
    await import('../global-event-target');

  installResult = installGlobalEventTarget();
  isPolyfilled = isGlobalEventTargetPolyfilled();
} catch {
  didImportThrow = true;
}

process.stdout.write(
  JSON.stringify({
    didImportThrow,
    installResult,
    isPolyfilled,
    // The frozen state must be left exactly as it was found.
    isStateUnchanged:
      (globalThis as unknown as Record<string, { isInstalled: boolean }>)[
        GLOBAL_KEY
      ].isInstalled === false,
    // Rollback must remove every method it defined, leaving Node as it was.
    areMethodsRolledBack:
      typeof (globalThis as { addEventListener?: unknown }).addEventListener ===
        'undefined' &&
      typeof (globalThis as { removeEventListener?: unknown })
        .removeEventListener === 'undefined' &&
      typeof (globalThis as { dispatchEvent?: unknown }).dispatchEvent ===
        'undefined',
  }),
);
