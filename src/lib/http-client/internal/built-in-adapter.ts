import { BUILT_IN_NETWORK_SEND_KEY } from '../consts';
import { readUnknownMember } from '../../internal/read-member';
import { setHiddenMember } from './hidden-member';
import type { HTTPAdapter } from '../types';

/**
 * Records `adapter` as a built-in network adapter - a `NodeAdapter`, `FetchAdapter` or
 * `XHRAdapter` - whose `send` is `send`, the `send` of its class it was constructed with.
 *
 * On the adapter itself, under {@link BUILT_IN_NETWORK_SEND_KEY}, rather than in a
 * module-local registry: `HTTPClient` and each adapter are separate entry points, each
 * bundled with its own copy of this module, and a registry would be local to one copy -
 * the adapter's copy would write to one the client's copy never reads (see
 * `setHiddenMember`).
 */
export function markBuiltInNetworkAdapter(
  adapter: HTTPAdapter,
  send: unknown,
): void {
  setHiddenMember(adapter, BUILT_IN_NETWORK_SEND_KEY, send);
}

/**
 * Whether `send`, read from `adapter`, is a built-in network adapter's own. One neither
 * changes nor transfers the bytes it is handed - `fetch` and XHR copy them as the request
 * is built, and `NodeAdapter` writes them as they are when the client marks them as its
 * own (see `markClientOwnedBody`), from a copy of its own otherwise - so the client need
 * not copy a byte body for it. A form
 * is still copied: `NodeAdapter` reads its entries as it writes each part, while the
 * upload runs - which a `307` can answer, and the client move on from, long before it
 * ends. An adapter that is not one is not, and neither is a built-in whose
 * `send` a subclass overrides or the instance replaces: that `send` may be the caller's.
 *
 * The mark is a `Symbol.for` key any object can carry, so a custom adapter can claim it
 * for its own `send` - and be handed the request's bytes uncopied, which reaches only its
 * own author's requests. One that changes or transfers them changes what the next attempt
 * and a `307`/`308` replay send, and what the attempt's observers are handed, whose copy
 * is taken from those bytes when the first of them runs (see `deferredBodyCopy`) - or,
 * for bytes it transferred, fails, which is reported once, and the observers are handed
 * the request with a `body` of `null`. One whose type is `'node'` has those bytes marked
 * as the client's own too (see `markClientOwnedBody`), so if it hands the same request on
 * to a `NodeAdapter`, a change made while they are written reaches the attempt being
 * sent. Read through the receiver, as `send` is, so an object that reaches a built-in
 * adapter's mark and `send` through its prototype - an `Object.create(nodeAdapter)`, a
 * `Proxy` around one - counts as that adapter: what it sends is the built-in's `send`, on
 * the caller's own request. Read through a guarded accessor: a mark whose getter throws
 * is no mark.
 */
export function isBuiltInNetworkSend(adapter: object, send: unknown): boolean {
  return (
    send !== undefined &&
    readUnknownMember(adapter, BUILT_IN_NETWORK_SEND_KEY) === send
  );
}
