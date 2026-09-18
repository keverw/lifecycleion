import { describe, expect, mock, test } from 'bun:test';

import * as redactPaths from '../../internal/redact-paths';
import { applyRedaction, REDACTION_FAILED_MARKER } from './redaction';

/**
 * The one catch in `applyRedaction` that no input can reach: every read inside
 * `normalizeAlongRedactPaths` is guarded, so the fault is injected at its only seam. The
 * prefix tree is built by `redactPathPrefixes`, which nothing else in the pass calls.
 */
describe('applyRedaction - a throw out of nested-path normalization', () => {
  test('fails closed on every named key rather than walking a part-normalized bag', () => {
    const original = { ...redactPaths };

    void mock.module('../../internal/redact-paths', () => ({
      ...original,
      redactPathPrefixes: () => {
        throw new Error('prefix tree refused');
      },
    }));

    try {
      const reported: { key: string; message: string }[] = [];

      const result = applyRedaction(
        {
          user: { password: 'hunter2secret' },
          token: 'abc123secret',
          other: 'safe',
        },
        ['user.password', 'token'],
        undefined,
        (error, _kind, key) => {
          reported.push({ key, message: error.message });
        },
      );

      // Budget exhaustion inside that function withholds and lets the walk continue. A
      // throw must not: the bag may hold an alias under one key and not yet under its
      // sibling, and walking that shape is what the marker on every key prevents. The
      // answer is the same one an unusable list gets - the named keys marked, and
      // nothing else carried, since nothing else was inspected.
      expect(result).toEqual({
        'user.password': REDACTION_FAILED_MARKER,
        token: REDACTION_FAILED_MARKER,
      });
      expect(JSON.stringify(result)).not.toContain('secret');
      expect(reported).toEqual([
        { key: '<params>', message: 'prefix tree refused' },
      ]);
    } finally {
      void mock.module('../../internal/redact-paths', () => ({ ...original }));
    }
  });
});
