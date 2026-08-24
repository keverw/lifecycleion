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
 *   initialization and across multiple copies of Lifecycleion via a `Symbol.for()` key.
 * - Installed properties are non-enumerable and bound to the backing target.
 */

/** Shared backing target, keyed so multiple package copies reuse one instance. */
const TARGET_KEY = Symbol.for('lifecycleion.globalEventTarget.target');

/**
 * The exact function identities this polyfill installed.
 *
 * A boolean marker would outlive the methods it describes: an application that replaces
 * the globals after installation would still be reported as polyfilled, and the backing
 * target nothing dispatches to would still be handed out. Comparing identities makes the
 * answer reflect what is actually installed right now.
 */
const METHODS_KEY = Symbol.for('lifecycleion.globalEventTarget.methods');

const METHOD_NAMES = [
  'addEventListener',
  'removeEventListener',
  'dispatchEvent',
] as const;

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

type GlobalRecord = Record<string | symbol, unknown>;

type InstalledMethods = Record<string, unknown>;

const globalRecord = globalThis as unknown as GlobalRecord;

/**
 * Whether every global event method is still the exact function this polyfill installed.
 *
 * False once the environment never needed the polyfill, and false again the moment an
 * application swaps any of the methods out from under it.
 */
function areInstalledMethodsActive(): boolean {
  const installed = globalRecord[METHODS_KEY] as InstalledMethods | undefined;

  if (installed === undefined) {
    return false;
  }

  return METHOD_NAMES.every((name) => globalRecord[name] === installed[name]);
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
function canDefineProperty(key: string | symbol): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(globalRecord, key);

  if (descriptor === undefined) {
    return Object.isExtensible(globalRecord);
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
  // A member is usable when it is callable, and occupied when it holds anything other
  // than `undefined` — including values we cannot use, such as `null` or an object.
  // Occupied-but-unusable is somebody else's doing and must not be overwritten; a plain
  // `undefined` is treated as absent, since assigning `undefined` is the ordinary way to
  // clear a global and is indistinguishable from never having set it.
  const usableCount = METHOD_NAMES.filter(
    (name) => typeof globalRecord[name] === 'function',
  ).length;

  const occupiedCount = METHOD_NAMES.filter(
    (name) => globalRecord[name] !== undefined,
  ).length;

  if (usableCount === METHOD_NAMES.length) {
    // Never overwrite an existing implementation, ours or the environment's. Whose it is
    // is decided by identity, not by a marker that a later replacement would leave stale.
    return areInstalledMethodsActive() ? 'already-installed' : 'native';
  }

  if (occupiedCount > 0) {
    // Partial/incompatible surface: some member exists but the set is unusable as a
    // whole. Filling in the gaps would split listeners and dispatches across two
    // unrelated targets, and clobbering what is there would destroy someone else's
    // work — so leave the environment exactly as it is.
    return 'partial';
  }

  if (typeof globalThis.EventTarget !== 'function') {
    return 'unsupported';
  }

  // Preflight every property before touching anything, so a frozen or sealed global
  // object leaves with nothing half-installed — and, more importantly, without throwing
  // out of the module initialization that calls this.
  const isDefinable = [...METHOD_NAMES, TARGET_KEY, METHODS_KEY].every((key) =>
    canDefineProperty(key),
  );

  if (!isDefinable) {
    return 'blocked';
  }

  let target = globalRecord[TARGET_KEY] as EventTarget | undefined;
  const hasExistingTarget = target instanceof globalThis.EventTarget;
  const defined: (string | symbol)[] = [];

  /** Undo a partial installation when a later definition is rejected after all. */
  const rollback = (): void => {
    for (const key of defined) {
      try {
        Reflect.deleteProperty(globalRecord, key);
      } catch {
        // Nothing better to do here: the property could not be defined *or* removed.
      }
    }
  };

  try {
    if (!hasExistingTarget) {
      target = new globalThis.EventTarget();

      Object.defineProperty(globalRecord, TARGET_KEY, {
        value: target,
        enumerable: false,
        writable: false,
        configurable: true,
      });

      defined.push(TARGET_KEY);
    }

    const boundTarget = target as EventTarget;
    const installed: InstalledMethods = {};

    for (const name of METHOD_NAMES) {
      const method = (
        boundTarget[name] as (...args: unknown[]) => unknown
      ).bind(boundTarget);

      Object.defineProperty(globalRecord, name, {
        value: method,
        enumerable: false,
        writable: true,
        configurable: true,
      });

      installed[name] = method;
      defined.push(name);
    }

    // Recorded last, so the identities are only published once all three are in place.
    Object.defineProperty(globalRecord, METHODS_KEY, {
      value: installed,
      enumerable: false,
      writable: false,
      configurable: true,
    });
  } catch {
    // The preflight passed but a definition was still rejected (an exotic global object,
    // a Proxy trap, a host restriction). Leave nothing behind and report no install.
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
  // Only meaningful while the methods we installed are the ones in use: once they are
  // replaced, the backing target no longer receives anything and handing it out would
  // point callers at a dead end.
  if (!areInstalledMethodsActive()) {
    return null;
  }

  const target = globalRecord[TARGET_KEY];

  return typeof globalThis.EventTarget === 'function' &&
    target instanceof globalThis.EventTarget
    ? target
    : null;
}

/**
 * Whether the global event methods currently in place are the ones this polyfill
 * installed. Becomes `false` again if an application later replaces them.
 */
export function isGlobalEventTargetPolyfilled(): boolean {
  return areInstalledMethodsActive();
}

/**
 * Whether `globalThis` exposes everything Lifecycleion's `'reportError'` convention needs:
 * the three `EventTarget` methods plus the `ErrorEvent` constructor.
 */
export function isGlobalEventTargetAvailable(): boolean {
  return (
    METHOD_NAMES.every((name) => typeof globalRecord[name] === 'function') &&
    typeof globalRecord.ErrorEvent === 'function'
  );
}
