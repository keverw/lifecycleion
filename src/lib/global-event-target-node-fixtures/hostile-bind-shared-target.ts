/**
 * Node-runtime fixture: shared state whose methods have a hijacked `bind`.
 *
 * `bind` is an ordinary property on a function, so a target reachable through a
 * shared global can replace it with something that returns a non-function
 * without ever throwing. Every cheaper check passes: the three members read as
 * functions, so the target validates, and the bind itself completes normally.
 *
 * Only inspecting what `bind` returned catches it. Skipping that check installs
 * a non-callable on `globalThis` and reports `'installed'` — strictly worse than
 * doing nothing, because these methods started out absent, and every
 * `reportError` dispatch would then throw `TypeError`. The install should treat
 * the target as unusable and fall back to a fresh one.
 */

// Only dynamic imports below (the global must be set up first), so make this a module.
export {};

const GLOBAL_KEY = '__lifecycleion_global_event_target__';

const realTarget = new EventTarget();

// A target whose members are genuine functions — but whose `bind` lies.
const poisonedTarget: Record<string, unknown> = {};

for (const name of [
  'addEventListener',
  'removeEventListener',
  'dispatchEvent',
] as const) {
  const method = (realTarget[name] as (...args: unknown[]) => unknown).bind(
    realTarget,
  );

  Object.defineProperty(method, 'bind', {
    value: () => 42,
    configurable: true,
  });

  poisonedTarget[name] = method;
}

Object.defineProperty(globalThis, GLOBAL_KEY, {
  value: { target: poisonedTarget, isInstalled: false },
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

// The install is only worth anything if the methods actually work: register a
// listener through the installed global and dispatch to it.
let didReceiveEvent = false;
let didCallThrow = false;

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
  didCallThrow = true;
}

process.stdout.write(
  JSON.stringify({
    didImportThrow,
    installResult,
    isPolyfilled,
    didReceiveEvent,
    didCallThrow,
    // The poisoned `bind` returned 42, so this is what a missing check installs.
    isAddEventListenerCallable:
      typeof (globalThis as { addEventListener?: unknown }).addEventListener ===
      'function',
  }),
);
