import { readUnknownMember } from '../../internal/read-member';

/**
 * Puts `value` on `target` under `key`: how `HTTPClient` and its adapters hand each other
 * what is no field of the public types - a mark on an adapter, a listener or a mark on a
 * request. Under a `Symbol.for` key, so a copy of the code from another bundle finds it,
 * and not enumerable, so it is not listed among the target's own fields, and an adapter
 * that spreads a request into a new object does not carry it on.
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

/**
 * The value on `target` under `key` (see `setHiddenMember`), or `undefined` for none.
 * Read through a guarded accessor: an adapter or request may be the caller's, and a
 * getter that throws there means none rather than a failed send.
 */
export function readHiddenMember(target: object, key: symbol): unknown {
  return readUnknownMember(target, key);
}
