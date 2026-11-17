/**
 * Whether `value` is a status code: an integer from 100 to 999, the range a server can
 * send, as Node's `writeHead` holds one to - or, with `lowest` `0`, also `0`, the status an
 * adapter's answer carries for a request that got no response. Nothing from 1 to 99 is a
 * status.
 */
export function isStatusCode(value: unknown, lowest: 0 | 100): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    ((value >= 100 && value <= 999) || (value === 0 && lowest === 0))
  );
}
