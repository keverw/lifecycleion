import type { HTTPAdapter } from '../types';

/**
 * The `send` of its class each built-in network adapter - a `NodeAdapter`, `FetchAdapter`
 * or `XHRAdapter` - was constructed with, by the adapter.
 */
const builtInSends = new WeakMap<object, unknown>();

/** Records `adapter` as a built-in network adapter whose `send` is `send`. */
export function markBuiltInNetworkAdapter(
  adapter: HTTPAdapter,
  send: unknown,
): void {
  builtInSends.set(adapter, send);
}

/**
 * Whether `send`, read from `adapter`, is a built-in network adapter's own. One neither
 * changes nor transfers the bytes it is handed, and copies them before `send` returns -
 * `NodeAdapter` writes from a copy of its own (`Buffer.from`), and `fetch` and XHR copy
 * them as the request is built - so the client need not copy a byte body for it. A form
 * is still copied: `NodeAdapter` reads its entries as it writes each part, while the
 * upload runs - which a `307` can answer, and the client move on from, long before it
 * ends. An adapter that is not one is not, and neither is a built-in whose
 * `send` a subclass overrides or the instance replaces: that `send` may be the caller's.
 */
export function isBuiltInNetworkSend(adapter: object, send: unknown): boolean {
  return send !== undefined && builtInSends.get(adapter) === send;
}
