import { BUILT_IN_NETWORK_SEND_KEY } from '../consts';
import { readUnknownMember } from '../../internal/read-member';
import type { HTTPAdapter } from '../types';

/**
 * Records `adapter` as a built-in network adapter - a `NodeAdapter`, `FetchAdapter` or
 * `XHRAdapter` - whose `send` is `send`, the `send` of its class it was constructed with.
 *
 * On the adapter itself, under {@link BUILT_IN_NETWORK_SEND_KEY}, rather than in a
 * module-local registry: `HTTPClient` and each adapter are separate entry points, each
 * bundled with its own copy of this module, and a registry would be local to one copy -
 * the adapter's copy would write to one the client's copy never reads. Not enumerable,
 * so it is not listed among the adapter's own fields.
 */
export function markBuiltInNetworkAdapter(
  adapter: HTTPAdapter,
  send: unknown,
): void {
  Object.defineProperty(adapter, BUILT_IN_NETWORK_SEND_KEY, {
    value: send,
    enumerable: false,
    configurable: true,
    writable: true,
  });
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
 *
 * The mark is a `Symbol.for` key any object can carry, so a custom adapter can claim it
 * for its own `send` - and be handed the request's bytes uncopied, which reaches only its
 * own author's requests. Read through the receiver, as `send` is, so an object that
 * reaches a built-in adapter's mark and `send` through its prototype - an
 * `Object.create(nodeAdapter)`, a `Proxy` around one - counts as that adapter: what it
 * sends is the built-in's `send`, on the caller's own request. Read through a guarded
 * accessor: a mark whose getter throws is no mark.
 */
export function isBuiltInNetworkSend(adapter: object, send: unknown): boolean {
  return (
    send !== undefined &&
    readUnknownMember(adapter, BUILT_IN_NETWORK_SEND_KEY) === send
  );
}
