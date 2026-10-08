/**
 * Write one entry into a record built from caller-controlled keys - a container being
 * rebuilt, or a header, cookie or form-field map.
 *
 * Defined rather than assigned, and that is the whole reason this is a function: a plain
 * assignment to `__proto__` is a no-op for a string value and *reparents the object* for
 * an object one, so a payload carrying that key silently lost the entry or changed the
 * shape of the result. Every walk that rebuilds a record needs the same incantation;
 * written out at each site, it is one more chance to write `copy[key] = value` instead.
 *
 * Writable and configurable so the rebuilt record behaves like the plain object or array
 * a caller expects to receive, rather than a frozen approximation of one.
 *
 * Kept in a module of its own, with no imports, so the HTTP client can share it without
 * pulling the redaction walkers into its bundle.
 */
export function defineEntry<V>(
  target: Record<string, V>,
  // A symbol key is accepted too: copying an object's own keys meets both kinds.
  key: PropertyKey,
  value: V,
): void {
  // `Object.defineProperty` rather than `Reflect.defineProperty`: a target that refuses
  // the entry - frozen, or holding a non-configurable key - throws instead of dropping it.
  // A descriptor without a prototype, so nothing added to `Object.prototype` - a `get`
  // left by polluted caller data, say - is read as part of it and turns every write into
  // a throw.
  Object.defineProperty(target, key, {
    // eslint-disable-next-line @typescript-eslint/naming-convention
    __proto__: null,
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  } as PropertyDescriptor);
}
