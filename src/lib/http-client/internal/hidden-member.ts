/**
 * Puts `value` on `target` under `key`: how `HTTPClient` and its adapters hand each other
 * what is no field of the public types - a mark on an adapter, a listener or a mark on a
 * request. Under a `Symbol.for` key, so a copy of the code from another bundle finds it,
 * and not enumerable, so it is not listed among the target's own fields, and an adapter
 * that spreads a request into a new object does not carry it on. Read back through
 * `readUnknownMember`: an adapter or request may be the caller's, and a getter that throws
 * there means none rather than a failed send.
 */
export function setHiddenMember(
  target: object,
  key: symbol,
  value: unknown,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: false,
    configurable: true,
    writable: true,
  });
}
