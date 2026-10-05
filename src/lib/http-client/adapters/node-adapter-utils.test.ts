import { describe, expect, test } from 'bun:test';
import { normalizeNodeRequestHeaders } from './node-adapter-utils';
import { materializeRequestHeaders } from '../internal/header-utils';

describe('normalizeNodeRequestHeaders', () => {
  test('lowercases keys and coerces scalars to strings', () => {
    expect(
      normalizeNodeRequestHeaders({
        'Content-Type': 'application/json',
        'X-Count': 3,
      }),
    ).toEqual({
      'content-type': 'application/json',
      'x-count': '3',
    });
  });

  test('preserves array values', () => {
    expect(
      normalizeNodeRequestHeaders({
        Accept: ['application/json', 'text/plain'],
      }),
    ).toEqual({
      accept: ['application/json', 'text/plain'],
    });
  });

  test('skips undefined values and lets last lowercase key win', () => {
    expect(
      normalizeNodeRequestHeaders({
        Authorization: 'Bearer a',
        authorization: 'Bearer b',
        'X-Skip': undefined,
      }),
    ).toEqual({
      authorization: 'Bearer b',
    });
  });
});

describe('__proto__ headers', () => {
  test('stay own keys through normalization and materialization', () => {
    const source = JSON.parse('{"__proto__": ["a", "b"]}') as Record<
      string,
      string[]
    >;
    const normalized = normalizeNodeRequestHeaders(source);
    const materialized = materializeRequestHeaders(normalized);

    expect(Object.getPrototypeOf(normalized)).toBe(Object.prototype);
    expect(
      Object.getOwnPropertyDescriptor(normalized, '__proto__')?.value,
    ).toEqual(['a', 'b']);
    expect(Object.getPrototypeOf(materialized)).toBe(Object.prototype);
    expect(
      Object.getOwnPropertyDescriptor(materialized, '__proto__')?.value,
    ).toBe('a, b');
  });
});
