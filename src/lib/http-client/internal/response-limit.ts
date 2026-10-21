/**
 * The response size limit as every adapter applies it. See
 * {@link AdapterRequest.maxResponseBytes}.
 */

import { readUnknownMember } from '../../internal/read-member';
import type { AdapterRequest } from '../types';

/**
 * The limit an adapter enforces for `request`: `maxResponseBytes` when it is a positive
 * number, `Infinity` otherwise.
 *
 * Read once, guarded: an adapter can be driven directly, with a request object that is
 * the caller's own. `HTTPClient` validates the value before it gets here, so anything
 * that is not a usable limit came from such a caller, and is read as no limit - as an
 * absent one is - rather than failing a request the adapter could otherwise answer.
 */
export function readMaxResponseBytes(request: AdapterRequest): number {
  const value = readUnknownMember(request, 'maxResponseBytes');

  return typeof value === 'number' && value > 0
    ? value
    : Number.POSITIVE_INFINITY;
}

/**
 * Whether a response to `method` with `status` carries a body at all. A `HEAD` answer, a
 * `204` / `205` / `304` and an informational status have none, whatever their
 * `Content-Length` says - a `HEAD` reports the length its `GET` would have - so a size
 * refusal must not be read off them, and there is nothing to decode. `205` with them, as
 * RFC 9110 forbids it content and the Fetch standard lists it a null-body status.
 */
export function hasResponseBody(method: string, status: number): boolean {
  return (
    method.toUpperCase() !== 'HEAD' &&
    status >= 200 &&
    status !== 204 &&
    status !== 205 &&
    status !== 304
  );
}

/**
 * The `errorCause` of a body refused for its size, naming the limit and the way out.
 * `streamResponse` is only offered where the adapter supports it - NodeAdapter - since
 * pointing at an option the client refuses for this adapter would send the caller
 * somewhere there is nothing to find.
 */
export function makeResponseTooLargeError(
  limit: number,
  canStream: boolean,
): Error {
  return new Error(
    `Response body exceeds maxResponseBytes (${String(limit)}); raise maxResponseBytes${canStream ? ' or use streamResponse' : ''}`,
  );
}

/**
 * The byte count a `Content-Length` value states, or `undefined` when it states none this
 * can trust: absent, empty, or not a plain decimal number. Repeated values (`10, 10`, or
 * an array from a header seen twice) count when they agree, as RFC 9110 lets a recipient
 * read them, and are left to the body otherwise - a refusal is only made on a length the
 * response itself is unambiguous about.
 */
export function parseContentLength(
  value: string | string[] | null | undefined,
): number | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  const tokens = (Array.isArray(value) ? value.join(',') : value)
    .split(',')
    .map((token) => token.trim());

  if (tokens.length === 0 || !tokens.every((token) => /^\d+$/.test(token))) {
    return undefined;
  }

  const lengths = new Set(tokens.map((token) => Number(token)));

  return lengths.size === 1 ? [...lengths][0] : undefined;
}
