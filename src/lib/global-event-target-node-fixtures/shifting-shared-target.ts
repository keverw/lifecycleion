/**
 * Node-runtime fixture: shared state whose `target` does not hold still.
 *
 * The state object lives on a global, so `target` is a field anything can own,
 * and reading it runs somebody else's getter. Validating it once and then
 * binding the three global methods to a *later* read is the gap this covers:
 * the bind is the read that matters, so it is the read that has to check out.
 *
 * This getter passes the validation probe and then throws on every read after
 * it. Binding from an unguarded re-read would let that throw escape into the
 * install's catch, rolling back the three methods it had already defined and
 * reporting `'blocked'` — leaving Node with no event methods at all, purely
 * because a second read of an already-validated field went bad. The install
 * should instead treat the target as absent and proceed with a fresh one.
 */

// Only dynamic imports below (the global must be set up first), so make this a module.
export {};

const GLOBAL_KEY = '__lifecycleion_global_event_target__';

const realTarget = new EventTarget();

let readCount = 0;

const sharedState = {
  get target(): EventTarget {
    readCount++;

    // The first read is the validation probe, so the state passes inspection and
    // is accepted for reuse. Every read after it — including the one the globals
    // would be bound from — fails.
    if (readCount === 1) {
      return realTarget;
    }

    throw new Error('target getter went bad after validation');
  },
  isInstalled: false,
};

Object.defineProperty(globalThis, GLOBAL_KEY, {
  value: sharedState,
  enumerable: false,
  writable: false,
  configurable: true,
});

let didImportThrow = false;
let installResult = 'not-reached';
let isPolyfilled = false;
let hasBackingTarget = false;

try {
  const {
    installGlobalEventTarget,
    isGlobalEventTargetPolyfilled,
    getGlobalEventTarget,
  } = await import('../global-event-target');

  installResult = installGlobalEventTarget();
  isPolyfilled = isGlobalEventTargetPolyfilled();
  hasBackingTarget = getGlobalEventTarget() !== null;
} catch {
  didImportThrow = true;
}

// End-to-end proof that the methods are wired to one working target: a listener
// registered through the installed global receives a dispatch made through it.
let didReceiveEvent = false;

try {
  const globalWithEvents = globalThis as {
    addEventListener?: (type: string, listener: () => void) => void;
    dispatchEvent?: (event: Event) => boolean;
  };

  globalWithEvents.addEventListener?.('fixture-ping', () => {
    didReceiveEvent = true;
  });

  globalWithEvents.dispatchEvent?.(new Event('fixture-ping'));
} catch {
  didReceiveEvent = false;
}

process.stdout.write(
  JSON.stringify({
    didImportThrow,
    installResult,
    isPolyfilled,
    hasBackingTarget,
    didReceiveEvent,
    areMethodsInstalled:
      typeof (globalThis as { addEventListener?: unknown }).addEventListener ===
        'function' &&
      typeof (globalThis as { removeEventListener?: unknown })
        .removeEventListener === 'function' &&
      typeof (globalThis as { dispatchEvent?: unknown }).dispatchEvent ===
        'function',
  }),
);
