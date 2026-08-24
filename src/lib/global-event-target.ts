/**
 * Global event target polyfill.
 *
 * Some Lifecycleion libraries (`safe-handle-callback`, `logger`) report errors using
 * Lifecycleion's `'reportError'` convention: an `ErrorEvent` dispatched through
 * `globalThis.dispatchEvent()` and observed with `globalThis.addEventListener('reportError', ...)`.
 *
 * Browsers, Bun, and Deno expose the `EventTarget` methods on the global object, so the
 * convention works there out of the box. Node.js does not: as of Node 25 the `ErrorEvent`
 * constructor is a global, but `globalThis` is still not an `EventTarget`, so
 * `globalThis.addEventListener` / `removeEventListener` / `dispatchEvent` are all `undefined`.
 *
 * This module fills that gap by backing the three missing methods with a single shared
 * `EventTarget` instance. It is deliberately conservative:
 *
 * - It only installs when all three methods are absent, so native or user-installed
 *   implementations are never overwritten.
 * - A partial/foreign implementation (some methods present, others missing) is left alone
 *   rather than mixing methods from unrelated targets.
 * - Installation is idempotent, and the backing target is shared across repeated
 *   initialization and across multiple copies of Lifecycleion.
 * - Installed properties are non-enumerable and bound to the backing target.
 */

// Stored in globalThis so state survives module re-evaluation and works across
// module boundaries, the same way `dev-mode` and `process-signal-manager` do it.
const GLOBAL_KEY = '__lifecycleion_global_event_target__';

const METHOD_NAMES = [
  'addEventListener',
  'removeEventListener',
  'dispatchEvent',
] as const;

/**
 * Shared state: the backing target, plus whether the global methods in place are ours.
 */
interface GlobalEventTargetState {
  target: EventTarget;
  isInstalled: boolean;
}

/**
 * Outcome of {@link installGlobalEventTarget}.
 *
 * - `native` - the environment already provides all three methods (browser, Bun, Deno).
 * - `installed` - this call installed the polyfill.
 * - `already-installed` - a previous call (or another copy of Lifecycleion) installed it.
 * - `partial` - the environment provides some but not all of the methods; nothing was
 *   installed, because mixing a foreign implementation with a polyfilled one would
 *   dispatch to a different target than listeners registered through it.
 * - `unsupported` - the methods are missing and there is no `EventTarget` constructor
 *   to back them with.
 * - `blocked` - the global object refused the definition (it is non-extensible, or one of
 *   the properties already exists and is non-configurable). Nothing was installed.
 */
export type GlobalEventTargetInstallResult =
  | 'native'
  | 'installed'
  | 'already-installed'
  | 'partial'
  | 'unsupported'
  | 'blocked';

// Cast once at module level — avoids repeating the assertion in every function.
const g = globalThis as typeof globalThis & Record<string, unknown>;

function getState(): GlobalEventTargetState | undefined {
  try {
    return g[GLOBAL_KEY] as GlobalEventTargetState | undefined;
  } catch {
    // Reading a global can run an accessor, and an accessor can throw. See probeMember.
    return undefined;
  }
}

/**
 * What a global event method currently holds.
 *
 * - `usable` - a callable value.
 * - `occupied` - present, but something we cannot use (`null`, an object, ...).
 * - `absent` - `undefined`, which is indistinguishable from never having been set.
 * - `hostile` - reading it threw, so the property is an accessor belonging to somebody
 *   else. It cannot be probed, and must not be touched.
 */
type MemberState = 'usable' | 'occupied' | 'absent' | 'hostile';

/**
 * Read one global event method without trusting it.
 *
 * A plain property read invokes any getter defined for it, and a getter is free to
 * throw. This runs during module initialization, so an unguarded read would crash the
 * import of `safe-handle-callback` and everything downstream of it.
 */
function probeMember(name: string): MemberState {
  let value: unknown;

  try {
    value = g[name];
  } catch {
    return 'hostile';
  }

  if (typeof value === 'function') {
    return 'usable';
  }

  return value === undefined ? 'absent' : 'occupied';
}

/**
 * Whether a property can be defined on the global object without throwing.
 *
 * `Object.defineProperty` throws on a non-extensible target when the property does not
 * already exist, and on any target when an existing property is non-configurable and
 * cannot be redefined. Both are possible after `Object.freeze(globalThis)` or
 * `Object.preventExtensions(globalThis)`, and this function runs during module
 * initialization — a throw here would break the import of every dependent module.
 */
function canDefineProperty(key: string): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(g, key);

  if (descriptor === undefined) {
    return Object.isExtensible(g);
  }

  return descriptor.configurable === true;
}

/**
 * Install `addEventListener`, `removeEventListener`, and `dispatchEvent` on `globalThis`
 * when — and only when — all three are missing.
 *
 * Safe to call any number of times; repeated calls keep the same backing target.
 *
 * @returns What the call did, or why it did nothing. See {@link GlobalEventTargetInstallResult}.
 */
export function installGlobalEventTarget(): GlobalEventTargetInstallResult {
  // Occupied-but-unusable is somebody else's doing and must not be overwritten; a plain
  // `undefined` is treated as absent, since assigning `undefined` is the ordinary way to
  // clear a global and is indistinguishable from never having set it.
  const members = METHOD_NAMES.map((name) => probeMember(name));

  if (members.every((member) => member === 'usable')) {
    // Never overwrite an existing implementation, ours or the environment's.
    return getState()?.isInstalled === true ? 'already-installed' : 'native';
  }

  if (members.some((member) => member !== 'absent')) {
    // Partial/incompatible surface: some member exists but the set is unusable as a
    // whole. Filling in the gaps would split listeners and dispatches across two
    // unrelated targets, and clobbering what is there would destroy someone else's
    // work — so leave the environment exactly as it is. A `hostile` member lands here
    // too: it cannot be read, so it certainly cannot be replaced safely.
    return 'partial';
  }

  if (typeof globalThis.EventTarget !== 'function') {
    return 'unsupported';
  }

  // Preflight every property before touching anything, so a frozen or sealed global
  // object leaves with nothing half-installed — and, more importantly, without throwing
  // out of the module initialization that calls this.
  const isDefinable = [...METHOD_NAMES, GLOBAL_KEY].every((key) =>
    canDefineProperty(key),
  );

  if (!isDefinable) {
    return 'blocked';
  }

  const existingState = getState();
  const defined: string[] = [];

  /** Undo a partial installation when a later definition is rejected after all. */
  const rollback = (): void => {
    for (const key of defined) {
      try {
        Reflect.deleteProperty(g, key);
      } catch {
        // Nothing better to do here: the property could not be defined *or* removed.
      }
    }
  };

  let state: GlobalEventTargetState;

  try {
    if (existingState === undefined) {
      state = { target: new globalThis.EventTarget(), isInstalled: false };

      Object.defineProperty(g, GLOBAL_KEY, {
        value: state,
        enumerable: false,
        writable: false,
        configurable: true,
      });

      defined.push(GLOBAL_KEY);
    } else {
      // Another copy of Lifecycleion already made the target; reuse it so listeners
      // registered through it keep working.
      state = existingState;
    }

    const { target } = state;

    for (const name of METHOD_NAMES) {
      Object.defineProperty(g, name, {
        value: (target[name] as (...args: unknown[]) => unknown).bind(target),
        enumerable: false,
        writable: true,
        configurable: true,
      });

      defined.push(name);
    }
  } catch {
    // The preflight passed but a definition was still rejected (an exotic global object,
    // a Proxy trap, a host restriction). Leave nothing behind and report no install.
    rollback();

    return 'blocked';
  }

  // Flipped last, so the state only claims an install once all three are in place.
  state.isInstalled = true;

  return 'installed';
}

/**
 * Get the shared `EventTarget` backing the polyfilled global methods.
 *
 * @returns The backing target, or `null` when the polyfill is not in use (native
 *          environments, or environments where installation was skipped).
 */
export function getGlobalEventTarget(): EventTarget | null {
  return getState()?.target ?? null;
}

/**
 * Whether the global event methods currently in place were installed by this polyfill.
 *
 * Reflects what was installed, not what is callable right now: an application that
 * replaces the global methods afterwards does not reset this.
 */
export function isGlobalEventTargetPolyfilled(): boolean {
  return getState()?.isInstalled === true;
}

/**
 * Whether `globalThis` exposes everything Lifecycleion's `'reportError'` convention needs:
 * the three `EventTarget` methods plus the `ErrorEvent` constructor.
 */
export function isGlobalEventTargetAvailable(): boolean {
  return (
    METHOD_NAMES.every((name) => probeMember(name) === 'usable') &&
    probeMember('ErrorEvent') === 'usable'
  );
}
