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
 * - `unsupported` - the methods are missing and there is nothing to back them with:
 *   either no `EventTarget` constructor at all, or one that cannot produce an
 *   instance able to service the three methods (it throws, or hands back
 *   something unusable).
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
  const value = readGlobal(GLOBAL_KEY);

  return value === UNREADABLE ? undefined : asUsableState(value);
}

/**
 * Narrow a value found at {@link GLOBAL_KEY} to state this module can reuse.
 *
 * The value comes from a shared global, so it may be anything: another copy of
 * Lifecycleion, a test stub, or an object built to misbehave. Every field is read
 * through {@link readMember}, since a getter can throw. A value that does not
 * check out is treated as absent, so installation replaces it — this key is
 * Lifecycleion's own namespace.
 */
function asUsableState(value: unknown): GlobalEventTargetState | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }

  return asUsableTarget(readMember(value, 'target')) === null
    ? undefined
    : (value as GlobalEventTargetState);
}

/**
 * Narrow a value read from the `target` field to a usable backing target.
 *
 * Applied on every read rather than once: the field belongs to an object this
 * module does not own, so a getter may return a real `EventTarget` the first time
 * and something else the next.
 */
function asUsableTarget(value: unknown): EventTarget | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }

  // A usable backing target is one that can actually service all three methods.
  for (const name of METHOD_NAMES) {
    if (typeof readMember(value, name) !== 'function') {
      return null;
    }
  }

  return value as EventTarget;
}

/**
 * Read the three methods off a candidate target and bind them, in one pass.
 *
 * The values installed on the global object come from here rather than from a
 * later `target[name]` in the definition loop — that would reopen the
 * validate-once-use-a-later-read gap {@link asUsableTarget} closes, one level in.
 *
 * `null` means this target cannot back an install: a method missing, no longer
 * callable, whose read or `bind` threw, or whose `bind` returned a non-function.
 * The caller falls back to a fresh target rather than failing.
 *
 * @returns The bound methods by name, or `null` if any could not be taken.
 */
function bindTargetMethods(
  target: EventTarget,
): Record<string, (...args: unknown[]) => unknown> | null {
  const bound: Record<string, (...args: unknown[]) => unknown> = {};

  for (const name of METHOD_NAMES) {
    const method = readMember(target, name);

    if (typeof method !== 'function') {
      return null;
    }

    let boundMethod: unknown;

    try {
      boundMethod = (method as (...args: unknown[]) => unknown).bind(target);
    } catch {
      // `bind` is itself a property read on somebody else's function.
      return null;
    }

    // What `bind` handed back is checked, not assumed: `bind` is an ordinary
    // property, so a hostile target can replace it with something that returns a
    // non-function without throwing. Guarding only the throw would leave
    // `globalThis.addEventListener` set to a non-callable and report
    // `'installed'` — worse than not installing, since the methods were absent.
    if (typeof boundMethod !== 'function') {
      return null;
    }

    bound[name] = boundMethod as (...args: unknown[]) => unknown;
  }

  return bound;
}

/** Whether shared state records a completed install by this module. */
function isStateInstalled(state: GlobalEventTargetState | undefined): boolean {
  return state !== undefined && readMember(state, 'isInstalled') === true;
}

/**
 * The backing target from shared state, or `null` when there is none to vouch for.
 *
 * {@link asUsableState} validated this field but returns the original object, so
 * this is a fresh read of somebody else's property and is re-validated.
 */
function readStateTarget(
  state: GlobalEventTargetState | undefined,
): EventTarget | null {
  if (state === undefined) {
    return null;
  }

  return asUsableTarget(readMember(state, 'target'));
}

/** Returned by {@link readGlobal} when the read threw, so it cannot collide with a value. */
const UNREADABLE = Symbol('lifecycleion.unreadable');

/**
 * Read a global without trusting it.
 *
 * A plain property read invokes any getter defined for it, and a getter is free to
 * throw. Every read here runs during module initialization, so an unguarded one would
 * crash the import of `safe-handle-callback` and everything downstream of it.
 *
 * @returns The value, or {@link UNREADABLE} if reading it threw.
 */
function readGlobal(name: string): unknown {
  try {
    return g[name];
  } catch {
    return UNREADABLE;
  }
}

/**
 * Read a property from an object that may be hostile, without trusting it. Same
 * reasoning as {@link readGlobal}, one level in: the shared state object is
 * reachable by anyone, so its accessors are not ours to rely on.
 */
function readMember(source: object, key: string): unknown {
  try {
    return (source as Record<string, unknown>)[key];
  } catch {
    return UNREADABLE;
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

function probeMember(name: string): MemberState {
  const value = readGlobal(name);

  if (value === UNREADABLE) {
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
    return isStateInstalled(getState()) ? 'already-installed' : 'native';
  }

  if (members.some((member) => member !== 'absent')) {
    // Partial/incompatible surface: some member exists but the set is unusable as a
    // whole. Filling in the gaps would split listeners and dispatches across two
    // unrelated targets, and clobbering what is there would destroy someone else's
    // work — so leave the environment exactly as it is. A `hostile` member lands here
    // too: it cannot be read, so it certainly cannot be replaced safely.
    return 'partial';
  }

  // Captured rather than read twice: the constructor is a global like any other, so it
  // can be an accessor that throws, and re-reading it could yield something else.
  const eventTargetConstructor = readGlobal('EventTarget');

  if (typeof eventTargetConstructor !== 'function') {
    // Covers UNREADABLE too: a constructor we cannot read is one we cannot use.
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

  // The state key as found, so a rollback can put back what was there.
  //
  // This call cannot be the first to throw: the preflight above already read
  // this exact descriptor through `canDefineProperty`, so an object hostile
  // enough to reject the read has already returned `'blocked'`.
  const priorStateDescriptor = Object.getOwnPropertyDescriptor(g, GLOBAL_KEY);

  /** Undo a partial installation when a later definition is rejected after all. */
  const rollback = (): void => {
    for (const key of defined) {
      // The state key may have held somebody else's object that this call
      // overwrote. Deleting it is not an undo there — a failed install would have
      // destroyed that object as a side effect, the one thing rollback exists to
      // prevent — so the original descriptor goes back instead.
      //
      // Restored in place rather than deleted first: whatever rejected the
      // definition may have sealed the global object, and re-adding a key to a
      // non-extensible object throws, while redefining a configurable one that
      // never left is always allowed.
      if (key === GLOBAL_KEY && priorStateDescriptor !== undefined) {
        try {
          Object.defineProperty(g, GLOBAL_KEY, priorStateDescriptor);
        } catch {
          // Nothing better to do here: the original could not be put back.
        }

        continue;
      }

      try {
        Reflect.deleteProperty(g, key);
      } catch {
        // Nothing better to do here: the property could not be defined *or* removed.
      }
    }
  };

  // Re-read `target` rather than reusing what `asUsableState` saw, and take the
  // three methods off it in the same pass. These are the values the globals are
  // actually bound to, so these are the reads that have to validate; trusting the
  // earlier probe would bind them to something that never passed a check.
  //
  // A target that no longer vouches for itself is treated as absent, so a fresh
  // one is made. Nothing is orphaned: a target that cannot service the three
  // methods never had listeners registered through this module.
  const reusableTarget = readStateTarget(existingState);
  const reusableMethods =
    reusableTarget === null ? null : bindTargetMethods(reusableTarget);

  let state: GlobalEventTargetState;
  let methods: Record<string, (...args: unknown[]) => unknown>;

  try {
    if (existingState === undefined || reusableMethods === null) {
      let target: EventTarget;

      try {
        target = new (eventTargetConstructor as new () => EventTarget)();
      } catch {
        // The constructor read from the global object cannot produce an
        // instance at all (a shim exposing `EventTarget` as non-constructible
        // throws here), so there is nothing to back the methods with. Reported
        // the same way as a constructor whose instances are unusable: nothing
        // was ever offered to the global object, so `'blocked'` would be the
        // wrong story, and nothing has been defined yet to undo.
        return 'unsupported';
      }

      const freshMethods = bindTargetMethods(target);

      if (freshMethods === null) {
        // The constructor read from the global object produced something that
        // cannot service the three methods, so there is nothing to back them
        // with. Nothing has been defined yet, so there is nothing to undo.
        return 'unsupported';
      }

      state = { target, isInstalled: false };
      methods = freshMethods;

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
      methods = reusableMethods;
    }

    for (const name of METHOD_NAMES) {
      Object.defineProperty(g, name, {
        value: methods[name],
        enumerable: false,
        writable: true,
        configurable: true,
      });

      defined.push(name);
    }

    // Flipped last, so the state only claims an install once all three are in
    // place, and inside the guarded block because a shared state object may be
    // frozen or have a throwing setter, which must not escape module init.
    //
    // Skipped when the flag already reads `true`: a non-writable property throws
    // on assignment in strict mode even for a same-value write. Otherwise a
    // frozen state left by a copy that already installed would roll back the
    // three methods just defined and report `blocked`, leaving the global with no
    // event methods. A frozen state still reading `false` keeps failing, as it
    // must: nothing can record that install.
    if (readMember(state, 'isInstalled') !== true) {
      state.isInstalled = true;
    }
  } catch {
    // The preflight passed but a definition or the state write was still rejected
    // (an exotic global object, a Proxy trap, a host restriction, frozen shared
    // state). Leave nothing behind and report no install.
    rollback();

    return 'blocked';
  }

  return 'installed';
}

/**
 * Get the shared `EventTarget` backing the polyfilled global methods.
 *
 * @returns The backing target, or `null` when the polyfill is not in use (native
 *          environments, or environments where installation was skipped).
 */
export function getGlobalEventTarget(): EventTarget | null {
  return readStateTarget(getState());
}

/**
 * Whether the global event methods currently in place were installed by this polyfill.
 *
 * Reflects what was installed, not what is callable right now: an application that
 * replaces the global methods afterwards does not reset this.
 */
export function isGlobalEventTargetPolyfilled(): boolean {
  return isStateInstalled(getState());
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
