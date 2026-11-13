/**
 * Whether `value` is a status code: an integer from `lowest` to 999. `0` is the lowest an
 * adapter's answer may carry, a request that got no response; `100` the lowest a server
 * can send, as Node's `writeHead` holds one to.
 */
export function isStatusCode(value: unknown, lowest: 0 | 100): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= lowest &&
    value <= 999
  );
}
