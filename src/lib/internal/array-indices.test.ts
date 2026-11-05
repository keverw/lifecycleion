import { describe, expect, test } from 'bun:test';
import { runInNewContext } from 'node:vm';
import {
  forEachOwnIndex,
  indicesFrom,
  inheritsNoIndices,
  SPARSE_RUN,
} from './array-indices';

describe('inheritsNoIndices', () => {
  test("holds for this realm's arrays, an Array subclass's and another realm's", () => {
    class List extends Array<unknown> {}

    expect(inheritsNoIndices([1, 2])).toBe(true);
    expect(inheritsNoIndices(new List())).toBe(true);
    expect(inheritsNoIndices(runInNewContext('[1, 2]') as object)).toBe(true);
    expect(inheritsNoIndices(Object.setPrototypeOf([], null) as object)).toBe(
      true,
    );
  });

  test('does not hold once a prototype on the chain has an index of its own', () => {
    const withIndex = Object.defineProperty(Object.create(Array.prototype), 0, {
      value: 'inherited',
    }) as object;
    const deeper = Object.create(Object.create(withIndex) as object) as object;

    expect(inheritsNoIndices(Object.setPrototypeOf([], withIndex))).toBe(false);
    expect(inheritsNoIndices(Object.setPrototypeOf([], deeper))).toBe(false);
  });

  test('is not misled by a key that only reads like an index', () => {
    const prototype = Object.create(Array.prototype) as Record<string, unknown>;
    prototype['01'] = 'a';
    prototype['1.5'] = 'b';
    prototype[String(2 ** 32 - 1)] = 'c';
    prototype[Symbol.for('0') as unknown as string] = 'd';

    expect(inheritsNoIndices(Object.setPrototypeOf([], prototype))).toBe(true);
  });

  test('does not hold for a chain that cannot be read or does not end', () => {
    const unreadable = new Proxy(Object.create(Array.prototype) as object, {
      ownKeys: () => {
        throw new Error('keys');
      },
    });
    const endless: object = new Proxy(
      {},
      { getPrototypeOf: (): object => endless },
    );

    expect(inheritsNoIndices(Object.setPrototypeOf([], unreadable))).toBe(
      false,
    );
    expect(inheritsNoIndices(Object.setPrototypeOf([], endless))).toBe(false);
  });
});

describe('indicesFrom', () => {
  test('lists own indices from start to length, in order, and nothing else', () => {
    const source: unknown[] = [];
    source[9] = 'j';
    source[2] = 'c';
    source[5] = 'f';
    Object.defineProperty(source, 7, { value: 'hidden', enumerable: false });
    (source as unknown as Record<string, unknown>)['01'] = 'x';

    expect(indicesFrom(source, 3, 9)).toEqual([5, 7]);
  });
});

describe('forEachOwnIndex', () => {
  test('visits own indices in order, past enough holes too, and not a hole a prototype fills', () => {
    const source: unknown[] = ['a', 'b'];
    source.length = SPARSE_RUN * 4;
    source[SPARSE_RUN * 3] = 'c';
    source[SPARSE_RUN * 4 - 1] = 'd';
    Object.setPrototypeOf(
      source,
      Object.assign(Object.create(Array.prototype) as object, { 2: 'x' }),
    );
    const visited: number[] = [];

    forEachOwnIndex(source, source.length, (index) => visited.push(index));

    expect(visited).toEqual([0, 1, SPARSE_RUN * 3, SPARSE_RUN * 4 - 1]);
  });

  test('checks a tail index again: one an earlier visit removed is passed over', () => {
    const source: unknown[] = ['a'];
    source.length = SPARSE_RUN * 4;
    source[SPARSE_RUN * 3] = 'c';
    source[SPARSE_RUN * 4 - 1] = 'd';
    const visited: number[] = [];

    forEachOwnIndex(source, source.length, (index) => {
      visited.push(index);
      if (index === SPARSE_RUN * 3) {
        Reflect.deleteProperty(source, SPARSE_RUN * 4 - 1);
      }
    });

    expect(visited).toEqual([0, SPARSE_RUN * 3]);
  });
});
