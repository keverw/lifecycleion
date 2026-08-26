/**
 * Node-runtime fixture: an `EventTarget` constructor that throws on construction.
 *
 * The constructor probe only establishes that `EventTarget` is callable. A shim
 * that exposes the interface without making it constructible passes that probe
 * and then raises `TypeError: Illegal constructor` the moment it is used — the
 * same way browsers guard interfaces not meant to be built directly.
 *
 * The correct outcome is `'unsupported'` with nothing defined, exactly as for a
 * constructor whose instances are useless. Not `'blocked'`: that means the
 * global object refused a definition, and nothing was ever offered to it — the
 * throw happens before the first `Object.defineProperty`. This is the case that
 * used to be swallowed by the shared `try` and misreported as `'blocked'`.
 */

// Only dynamic imports below (the global must be set up first), so make this a module.
export {};

let didConstructorRun = false;

// Callable, so the probe passes — but it can never produce an instance.
function IllegalEventTarget(): never {
  didConstructorRun = true;
  throw new TypeError('Illegal constructor');
}

Object.defineProperty(globalThis, 'EventTarget', {
  value: IllegalEventTarget,
  writable: true,
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

const globalKeys = globalThis as Record<string, unknown>;

process.stdout.write(
  JSON.stringify({
    didImportThrow,
    // Proves the throw came from the construction attempt rather than from the
    // probe deciding the constructor was unusable without calling it.
    didConstructorRun,
    installResult,
    isPolyfilled,
    // Nothing may be left behind — not even a half-installed method or the
    // module's own shared-state key.
    areAnyMethodsDefined: [
      'addEventListener',
      'removeEventListener',
      'dispatchEvent',
    ].some((name) => globalKeys[name] !== undefined),
    isStateKeyDefined:
      globalKeys['__lifecycleion_global_event_target__'] !== undefined,
  }),
);
