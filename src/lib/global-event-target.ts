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

/** Marker recording that the global methods came from this polyfill. */
const INSTALLED_KEY = Symbol.for('lifecycleion.globalEventTarget.installed');

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
 */
export type GlobalEventTargetInstallResult =
  'native' | 'installed' | 'already-installed' | 'partial' | 'unsupported';

type GlobalRecord = Record<string | symbol, unknown>;

const globalRecord = globalThis as unknown as GlobalRecord;

/**
 * Install `addEventListener`, `removeEventListener`, and `dispatchEvent` on `globalThis`
 * when — and only when — all three are missing.
 *
 * Safe to call any number of times; repeated calls keep the same backing target.
 *
 * @returns What the call did, or why it did nothing. See {@link GlobalEventTargetInstallResult}.
 */
export function installGlobalEventTarget(): GlobalEventTargetInstallResult {
  const presentCount = METHOD_NAMES.filter(
    (name) => typeof globalRecord[name] === 'function',
  ).length;

  if (presentCount === METHOD_NAMES.length) {
    // Never overwrite an existing implementation, ours or the environment's.
    return globalRecord[INSTALLED_KEY] === true
      ? 'already-installed'
      : 'native';
  }

  if (presentCount > 0) {
    // Partial/incompatible surface: filling in the gaps would split listeners and
    // dispatches across two unrelated targets, so leave the environment untouched.
    return 'partial';
  }

  if (typeof globalThis.EventTarget !== 'function') {
    return 'unsupported';
  }

  let target = globalRecord[TARGET_KEY] as EventTarget | undefined;

  if (!(target instanceof globalThis.EventTarget)) {
    target = new globalThis.EventTarget();

    Object.defineProperty(globalRecord, TARGET_KEY, {
      value: target,
      enumerable: false,
      writable: false,
      configurable: true,
    });
  }

  const boundTarget = target;

  for (const name of METHOD_NAMES) {
    Object.defineProperty(globalRecord, name, {
      value: (boundTarget[name] as (...args: unknown[]) => unknown).bind(
        boundTarget,
      ),
      enumerable: false,
      writable: true,
      configurable: true,
    });
  }

  Object.defineProperty(globalRecord, INSTALLED_KEY, {
    value: true,
    enumerable: false,
    writable: false,
    configurable: true,
  });

  return 'installed';
}

/**
 * Get the shared `EventTarget` backing the polyfilled global methods.
 *
 * @returns The backing target, or `null` when the polyfill is not in use (native
 *          environments, or environments where installation was skipped).
 */
export function getGlobalEventTarget(): EventTarget | null {
  const target = globalRecord[TARGET_KEY];

  return typeof globalThis.EventTarget === 'function' &&
    target instanceof globalThis.EventTarget
    ? target
    : null;
}

/**
 * Whether the global event methods currently in place were installed by this polyfill.
 */
export function isGlobalEventTargetPolyfilled(): boolean {
  return globalRecord[INSTALLED_KEY] === true;
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
