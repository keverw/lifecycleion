import { describe, expect, test } from 'bun:test';
import { forEachOwnIndex, indicesFrom, SPARSE_RUN } from './array-indices';

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
