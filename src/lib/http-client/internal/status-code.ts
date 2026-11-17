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
 * The cause a built-in adapter answers a server's status below 100 with: a malformed
 * response, answered as one the runtime could not read at all is - a transport error.
 */
export function invalidServerStatusError(status: unknown): Error {
  return new Error(
    `Server answered with an invalid status code (got ${String(status)})`,
  );
}
