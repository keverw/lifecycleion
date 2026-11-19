import { CLIENT_OWNED_BODY_KEY } from '../consts';
import { readHiddenMember, setHiddenMember } from './hidden-member';
import type { AdapterRequest } from '../types';

/**
 * Marks `body`, the bytes `request` carries, as `HTTPClient`'s own: a copy it took when
 * the body was handed over, which nothing outside the client holds, handed to a built-in
 * network adapter uncopied (see `isBuiltInNetworkSend`). `NodeAdapter` writes such bytes
 * as they are rather than copying them again for each attempt. The client calls a stream
 * factory with `this` undefined, so the factory never reaches them either.
 *
 * A hidden member of the request (see `setHiddenMember`). The mark holds the body itself,
 * so it covers only the bytes it was put there with. Any caller driving `NodeAdapter`
 * directly can put it on a request of its own, and that only means its own bytes are
 * written without a copy, as a change to them then reaches what is sent.
 */
export function markClientOwnedBody(
  request: AdapterRequest,
  body: Uint8Array,
): void {
  setHiddenMember(request, CLIENT_OWNED_BODY_KEY, body);
}

/**
 * Whether `body` is the bytes `request` was marked with (see `markClientOwnedBody`); a
 * mark that cannot be read is none (see `readHiddenMember`).
 */
export function isClientOwnedBody(
  request: AdapterRequest,
  body: unknown,
): boolean {
  return (
    body !== null &&
    body !== undefined &&
    readHiddenMember(request, CLIENT_OWNED_BODY_KEY) === body
  );
}
