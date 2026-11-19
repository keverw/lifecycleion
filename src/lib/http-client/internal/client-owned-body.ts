import { CLIENT_OWNED_BODY_KEY } from '../consts';
import { readUnknownMember } from '../../internal/read-member';
import type { AdapterRequest } from '../types';

/**
 * Marks `body`, the bytes `request` carries, as `HTTPClient`'s own: a copy it took when
 * the body was handed over, which nothing outside the client holds, handed to a built-in
 * network adapter uncopied (see `isBuiltInNetworkSend`). `NodeAdapter` writes such bytes
 * as they are rather than copying them again for each attempt. Not put on a request with
 * a stream factory, which `NodeAdapter` calls on the request, so it could reach them.
 *
 * Under a `Symbol.for` key, so a `NodeAdapter` from another bundle finds it, and not
 * enumerable, so an adapter that spreads the request into a new object does not carry it
 * on. The mark holds the body itself, so it covers only the bytes it was put there with.
 * Any caller driving `NodeAdapter` directly can put it on a request of its own, and that
 * only means its own bytes are written without a copy, as a change to them then reaches
 * what is sent.
 */
export function markClientOwnedBody(
  request: AdapterRequest,
  body: Uint8Array,
): void {
  Object.defineProperty(request, CLIENT_OWNED_BODY_KEY, {
    value: body,
    enumerable: false,
    configurable: true,
    writable: true,
  });
}

/**
 * Whether `body` is the bytes `request` was marked with (see `markClientOwnedBody`).
 * Read through a guarded accessor: a request an adapter is driven with directly is the
 * caller's, and a getter that throws there means no mark rather than a failed send.
 */
export function isClientOwnedBody(
  request: AdapterRequest,
  body: unknown,
): boolean {
  return (
    body !== null &&
    body !== undefined &&
    readUnknownMember(request, CLIENT_OWNED_BODY_KEY) === body
  );
}
