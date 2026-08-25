/**
 * Node-runtime fixture: an `EventTarget` constructor whose instances are useless.
 *
 * The constructor probe only establishes that `EventTarget` is callable, not
 * that what it produces can service the three methods. A stub left by a test
 * harness or a shim, or a deliberately empty class, passes that probe and then
 * yields instances with nothing on them.
 *
 * There is no target to back an install here and no shared state to fall back
 * on, so the correct outcome is `'unsupported'` with nothing defined — not
 * `'installed'` with three non-callables on `globalThis`, and not `'blocked'`,
 * which means the global object refused a definition. Nothing was ever offered
 * to it.
 */

// Only dynamic imports below (the global must be set up first), so make this a module.
export {};

// Instances have none of the three methods.
class UselessEventTarget {}

Object.defineProperty(globalThis, 'EventTarget', {
  value: UselessEventTarget,
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
