import { matchesFilter } from '../utils';

/**
 * Whether a filter with the one `hosts` entry `pattern` matches a request to `hostname`:
 * the host matching a registered interceptor or observer filter applies.
 */
export function matchesHostPattern(hostname: string, pattern: string): boolean {
  return matchesFilter(
    { hosts: [pattern] },
    { requestURL: `http://${hostname}/` },
    'request',
  );
}
