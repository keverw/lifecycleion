import { describe, expect, test } from 'bun:test';
import { getOrCompute } from './bounded-cache';

describe('getOrCompute', () => {
  test('computes a key once, and answers it from the cache after', () => {
    const cache = new Map<string, number>();
    let calls = 0;
    const compute = (key: string): number => {
      calls++;
      return key.length;
    };

    expect(getOrCompute(cache, 'abc', 4, compute)).toBe(3);
    expect(getOrCompute(cache, 'abc', 4, compute)).toBe(3);
    expect(calls).toBe(1);
  });

  test('a value of undefined is kept as one, not computed again', () => {
    const cache = new Map<string, undefined>();
    let calls = 0;

    getOrCompute(cache, 'a', 4, () => {
      calls++;
      return undefined;
    });
    getOrCompute(cache, 'a', 4, () => {
      calls++;
      return undefined;
    });

    expect(calls).toBe(1);
  });

  test('evicts the least recently used key once full, a hit counting as a use', () => {
    const cache = new Map<string, string>();
    const compute = (key: string): string => key.toUpperCase();

    getOrCompute(cache, 'a', 2, compute);
    getOrCompute(cache, 'b', 2, compute);
    getOrCompute(cache, 'a', 2, compute);
    getOrCompute(cache, 'c', 2, compute);

    expect([...cache.keys()]).toEqual(['a', 'c']);
  });

  test('a value shouldKeep refuses is answered, not kept, and evicts nothing', () => {
    const cache = new Map<string, string>();
    const compute = (key: string): string => key.toUpperCase();
    const shouldKeep = (key: string): boolean => key.length < 3;

    getOrCompute(cache, 'a', 1, compute, shouldKeep);

    expect(getOrCompute(cache, 'long', 1, compute, shouldKeep)).toBe('LONG');
    expect([...cache.keys()]).toEqual(['a']);
  });
});
