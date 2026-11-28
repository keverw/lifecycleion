/**
 * The `code` getter off `DOMException.prototype`, read once. A branded accessor: it
 * throws for any receiver that is not a real `DOMException`, borrowed prototype
 * included, which is the check `instanceof` cannot make. `undefined` where the runtime
 * has no `DOMException`, or one whose `code` is not an accessor.
 */
const domExceptionCodeGetter = (():
  ((this: unknown) => unknown) | undefined => {
  try {
    const ctor: unknown = (globalThis as { DOMException?: unknown })
      .DOMException;

    if (typeof ctor !== 'function') {
      return undefined;
    }

    const prototype: unknown = (ctor as { prototype?: unknown }).prototype;

    if (typeof prototype !== 'object' || prototype === null) {
      return undefined;
    }

    // Read off a plain record rather than as a method, which is what it is: an accessor
    // to be invoked with a receiver of this module's choosing.
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'code') as
      { get?: unknown } | undefined;
    const getter = descriptor?.get;

    return typeof getter === 'function'
      ? (getter as (this: unknown) => unknown)
      : undefined;
  } catch {
    // A host can expose globals through accessors or proxies. Optional runtime probing
    // must never make importing the error utilities fail.
    return undefined;
  }
})();

/**
 * Whether `value` is a real `DOMException`, told by its internal state through the branded
 * `code` getter: `Object.create(DOMException.prototype)` is not one. Never throws, and reads
 * nothing of `value` itself, so a Proxy's traps are not run.
 */
export function isDOMExceptionInstance(value: unknown): boolean {
  if (domExceptionCodeGetter === undefined || typeof value !== 'object') {
    return false;
  }

  try {
    Reflect.apply(domExceptionCodeGetter, value, []);

    return true;
  } catch {
    return false;
  }
}
