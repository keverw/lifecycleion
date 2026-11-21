import type { AdapterResponse } from '../types';

/**
 * Whether `value` is a status code: an integer from 100 to 999, the range a server can
 * send, as Node's `writeHead` holds one to. Nothing from 0 to 99 is a status.
 */
export function isStatusCode(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 100 &&
    value <= 999
  );
}

/**
 * Whether `value` is a status an adapter's answer may carry: a status code (see
 * `isStatusCode`), or `0`, the status of a request that got no response.
 */
export function isAdapterStatus(value: unknown): value is number {
  return value === 0 || isStatusCode(value);
}

/**
 * Whether a status a runtime reports for a server's response is none a server may send: a
 * number that is no status code (see `isStatusCode`) - Node's parser reads any three
 * digits, so `099` arrives as `99`, and a runtime's `fetch` or an XHR outside a browser may
 * hand on what it read. A value that is not a number is the runtime's own malformed answer,
 * not the server's, and is left to the client to refuse. Each built-in adapter keeps its
 * own exception: an opaque `fetch` response's `0`, and an XHR's `0` for no response yet.
 */
export function isMalformedServerStatus(status: unknown): status is number {
  return typeof status === 'number' && !isStatusCode(status);
}

/** The cause a built-in adapter answers a malformed server status with. */
export function invalidServerStatusError(status: unknown): Error {
  return new Error(
    `Server answered with an invalid status code (got ${String(status)})`,
  );
}

/**
 * A built-in adapter's answer to a malformed server status (see `isMalformedServerStatus`):
 * a malformed response, answered as one the runtime could not read at all is - a transport
 * error, its headers and body unread - rather than handed on for the client to refuse as
 * the adapter's own invalid answer. A custom adapter's status is its own to answer, and the
 * client refuses one outside the range as that adapter's mistake.
 */
export function malformedStatusAnswer(status: number): AdapterResponse {
  return {
    status: 0,
    isTransportError: true,
    headers: {},
    body: null,
    errorCause: invalidServerStatusError(status),
  };
}
