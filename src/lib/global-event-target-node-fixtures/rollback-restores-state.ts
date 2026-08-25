/**
 * Node-runtime fixture: a rejected install must not destroy another copy's state.
 *
 * Rollback exists so a failed install leaves the environment exactly as found.
 * That is easy for the three methods — deleting them is the undo — but the
 * shared-state key can already hold somebody else's object, and there deleting
 * is not an undo at all. A failed install would have destroyed it as a side
 * effect. The key has to be put back as found.
 *
 * Reaching that path needs a definition to be rejected *after* the preflight
 * cleared it, which looks impossible until you notice the one piece of
 * caller-controlled code that runs in between: the `EventTarget` constructor,
 * read from the global like anything else. This one seals the global object on
 * its way out. So:
 *
 *   - preflight passes, because the global is still extensible
 *   - the existing state has an unusable target, so it is replaced rather than
 *     reused — which is what puts the key on the rollback list in the first place
 *   - redefining the already-present, configurable state key still succeeds on a
 *     non-extensible object
 *   - defining `addEventListener`, a brand new key, is rejected
 *
 * The install should report `'blocked'` with the original state object back in
 * place, untouched and identical — not merely a state key that exists, and not
 * an absent one.
 */

// Only dynamic imports below (the global must be set up first), so make this a module.
export {};

const GLOBAL_KEY = '__lifecycleion_global_event_target__';

// Unusable on purpose: `target` is not an object, so validation rejects it and
// the install replaces the state instead of reusing it.
const foreignState = { target: 'not-an-event-target', isInstalled: false };

Object.defineProperty(globalThis, GLOBAL_KEY, {
  value: foreignState,
  enumerable: false,
  writable: false,
  configurable: true,
});

const RealEventTarget = globalThis.EventTarget;

class SealingEventTarget {
  constructor() {
    // Runs after the preflight, before any method is defined.
    Object.preventExtensions(globalThis);
  }

  public addEventListener(): void {}
  public removeEventListener(): void {}
  public dispatchEvent(): boolean {
    return true;
  }
}

Object.defineProperty(globalThis, 'EventTarget', {
  value: SealingEventTarget,
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

const globalKeys = globalThis as unknown as Record<string, unknown>;
const stateAfter = globalKeys[GLOBAL_KEY];

process.stdout.write(
  JSON.stringify({
    didImportThrow,
    installResult,
    isPolyfilled,
    // The whole point: the original object, not a replacement and not nothing.
    isStatePresent: stateAfter !== undefined,
    isSameStateObject: stateAfter === foreignState,
    isStateContentUnchanged:
      (stateAfter as { target?: unknown } | undefined)?.target ===
      'not-an-event-target',
    // And nothing half-installed was left behind.
    areAnyMethodsDefined: [
      'addEventListener',
      'removeEventListener',
      'dispatchEvent',
    ].some((name) => globalKeys[name] !== undefined),
    // Sanity: the fixture really did seal the global, so the rejection was real.
    isGlobalSealed: !Object.isExtensible(globalThis),
    didConstructorRun: globalThis.EventTarget !== RealEventTarget,
  }),
);
