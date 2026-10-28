/**
 * The response size limit as every adapter applies it. See
 * {@link AdapterRequest.maxResponseBytes}.
 */

import {
  asciiLowercase,
  asciiUppercase,
  trimHTTPWhitespace,
} from '../../internal/ascii-text';
import {
  markNonRetryableAdapterError,
  nonRetryableAdapterErrorFrom,
} from './adapter-error';
import { validateMaxResponseBytes } from '../consts';
import type { AdapterRequest, AdapterResponse } from '../types';
import { derivedRedirectFields } from '../utils';
import {
  presentsAsBinary,
  readBinaryByteLength,
} from '../../internal/binary-view';
import { utf8ByteLength } from './utf8-length';

/**
 * The limit an adapter enforces for `request`: `maxResponseBytes`, or `Infinity` when it
 * is absent (`undefined` or `null`).
 *
 * Read once, guarded: an adapter can be driven directly, with a request object that is
 * the caller's own. `HTTPClient` validates the value before it gets here; a caller
 * driving an adapter directly gets the same rule (`validateMaxResponseBytes`) - a
 * positive integer, or `Infinity` - as a non-retryable `TypeError`, rather than an
 * unusable limit (`'1048576'` from an environment variable, `0`, `NaN`) silently read
 * as no limit at all.
 */
export function readMaxResponseBytes(request: AdapterRequest): number {
  // Not `readUnknownMember`, which reads a throw as absent: a getter that throws would
  // turn the limit off. Refused, as an unusable value is.
  let value: unknown;
  try {
    value = (request as { maxResponseBytes?: unknown }).maxResponseBytes;
  } catch (error) {
    throw nonRetryableAdapterErrorFrom(error);
  }

  try {
    validateMaxResponseBytes(value, 'Adapter request maxResponseBytes');
  } catch (error) {
    markNonRetryableAdapterError(error);
    throw error;
  }

  return value ?? Number.POSITIVE_INFINITY;
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
    asciiUppercase(method) !== 'HEAD' &&
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
 * The answer a browser adapter gives for a body past `maxResponseBytes`: a stream error
 * with the real status and headers - the server answered, and what failed is taking
 * delivery - and the redirect fields that status and `Location` carry, resolved against
 * `answeredURL`, so a refused `3xx` still reports where it pointed.
 */
export function tooLargeAnswer(
  answeredURL: string,
  status: number,
  headers: Record<string, string | string[]>,
  maxResponseBytes: number,
): AdapterResponse {
  return {
    status,
    ...derivedRedirectFields(answeredURL, status, headers),
    headers,
    body: null,
    isStreamError: true,
    streamErrorCode: 'response_too_large',
    errorCause: makeResponseTooLargeError(maxResponseBytes, false),
  };
}

/**
 * Whether a `Content-Encoding` value applies no coding: each of its comma-separated
 * tokens, trimmed of HTTP whitespace, is empty or `identity` in any ASCII case. A body
 * sent so is its own decoded bytes, so its `Content-Length`, or the bytes counted as it
 * arrives, are the decoded size.
 */
export function isIdentityContentEncoding(contentEncoding: string): boolean {
  return contentEncoding
    .split(',')
    .every((token) =>
      ['', 'identity'].includes(asciiLowercase(trimHTTPWhitespace(token))),
    );
}

/**
 * The byte count a `Content-Length` value states, or `undefined` when it states none this
 * can trust: absent, empty, or not a plain decimal number once trimmed of HTTP
 * whitespace. Repeated values (`10, 10`, or an array from a header seen twice) count when
 * they agree, as RFC 9110 lets a recipient read them, and are left to the body otherwise -
 * a refusal is only made on a length the response itself is unambiguous about.
 */
export function parseContentLength(
  value: string | string[] | null | undefined,
): number | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  // Trimmed of HTTP whitespace only, as Fetch and Node read it: `trim()` would also take
  // a no-break space, reading `10\u00A0` as the length 10 where they read no length.
  const tokens = (Array.isArray(value) ? value.join(',') : value)
    .split(',')
    .map((token) => trimHTTPWhitespace(token));

  if (!tokens.every((token) => /^\d+$/.test(token))) {
    return undefined;
  }

  // Compared as digits, leading zeros aside, not as numbers: past 2^53 two lengths that
  // differ convert to the same number, and would read as agreeing.
  const lengths = new Set(
    tokens.map((token) => token.replace(/^0+(?=\d)/, '')),
  );

  return lengths.size === 1 ? Number([...lengths][0]) : undefined;
}

/**
 * Whether a body a custom adapter or a MockAdapter route handed over is past `maxResponseBytes`: bytes as their
 * internal slot measures them - a view or buffer of any kind, from any realm, not the
 * size the value reports - and a string as its UTF-8 length, counted only when its
 * UTF-16 length alone cannot tell (never fewer bytes than units, at most three per
 * unit). Under a finite limit, a value that presents as bytes by its prototype chain
 * but that no intrinsic getter can measure (a `Proxy` over bytes) is taken as over it,
 * failing closed as `readBinaryByteLength` asks. Anything else has no size, and is not
 * held to the limit. The limit is a backstop against an oversized answer, not against
 * an adapter disguising its own bytes - a `Proxy` whose prototype trap lies is the
 * adapter's own doing, and a `Proxy` cannot be told apart from what it claims to be.
 */
export function isAnsweredBodyOverLimit(
  body: unknown,
  maxBytes: number,
): boolean {
  if (typeof body === 'object' && body !== null) {
    const byteLength = readBinaryByteLength(body);
    return byteLength === null
      ? Number.isFinite(maxBytes) && presentsAsBinary(body)
      : byteLength > maxBytes;
  }

  if (typeof body !== 'string' || body.length * 3 <= maxBytes) {
    return false;
  }

  return body.length > maxBytes || utf8ByteLength(body) > maxBytes;
}
