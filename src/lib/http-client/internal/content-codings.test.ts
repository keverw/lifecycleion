import { describe, expect, test } from 'bun:test';
import { contentCodings } from './content-codings';
import { isIdentityContentEncoding } from './response-limit';

describe('contentCodings', () => {
  test('lists each coding trimmed and lowercased, without empty tokens or identity', () => {
    expect(contentCodings(' GZIP ,\tidentity, ,br')).toEqual(['gzip', 'br']);
    expect(contentCodings('IDENTITY,\t ')).toEqual([]);
  });

  test('reads an array as one header seen more than once', () => {
    expect(contentCodings(['identity', 'gzip'])).toEqual(['gzip']);
    expect(isIdentityContentEncoding(['identity', 'gzip'])).toBe(false);
    expect(isIdentityContentEncoding(['identity', ''])).toBe(true);
  });
});
