import { describe, expect, test } from 'bun:test';
import { runInNewContext } from 'node:vm';
import {
  forEachOwnIndex,
  indicesFrom,
  indexFreePrototype,
  SPARSE_RUN,
} from './array-indices';

describe('indexFreePrototype', () => {
  test("is the prototype of this realm's arrays, an Array subclass's and another realm's", () => {
    class List extends Array<unknown> {}
    const foreign = runInNewContext('[1, 2]') as object;

    expect(indexFreePrototype([1, 2])).toBe(Array.prototype);
    expect(indexFreePrototype(new List())).toBe(List.prototype);
    expect(indexFreePrototype(foreign)).toBe(Reflect.getPrototypeOf(foreign));
    expect(
      indexFreePrototype(Object.setPrototypeOf([], null) as object),
    ).toBeNull();
  });

  test("reads the array's prototype once", () => {
    let reads = 0;
    const array = new Proxy([1], {
      getPrototypeOf: () => {
        reads++;
        return Array.prototype;
      },
    });

    expect(indexFreePrototype(array)).toBe(Array.prototype);
    expect(reads).toBe(1);
  });

  test('is undefined once a prototype on the chain has an index of its own', () => {
    const withIndex = Object.defineProperty(Object.create(Array.prototype), 0, {
      value: 'inherited',
    }) as object;
    const deeper = Object.create(Object.create(withIndex) as object) as object;

    expect(
      indexFreePrototype(Object.setPrototypeOf([], withIndex)),
    ).toBeUndefined();
    expect(
      indexFreePrototype(Object.setPrototypeOf([], deeper)),
    ).toBeUndefined();
  });

  test('is not misled by a key that only reads like an index', () => {
    const prototype = Object.create(Array.prototype) as Record<string, unknown>;
    prototype['01'] = 'a';
    prototype['1.5'] = 'b';
    prototype[String(2 ** 32 - 1)] = 'c';
    prototype[Symbol.for('0') as unknown as string] = 'd';

    expect(indexFreePrototype(Object.setPrototypeOf([], prototype))).toBe(
      prototype,
    );
  });

  test('is undefined for a chain that cannot be read or does not end', () => {
    const unreadable = new Proxy(Object.create(Array.prototype) as object, {
      ownKeys: () => {
        throw new Error('keys');
      },
    });
    const endless: object = new Proxy(
      {},
      { getPrototypeOf: (): object => endless },
    );

    expect(
      indexFreePrototype(Object.setPrototypeOf([], unreadable)),
    ).toBeUndefined();
    expect(
      indexFreePrototype(Object.setPrototypeOf([], endless)),
    ).toBeUndefined();
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
  test("tells a dense array's entries by `in`, not one `Object.hasOwn` per index", () => {
    let ownChecks = 0;
    const source = new Proxy(
      Array.from({ length: 1000 }, (_, index) => index),
      {
        getOwnPropertyDescriptor: (target, key) => {
          ownChecks++;
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      },
    );
    const visited: number[] = [];

    forEachOwnIndex(source, 1000, (index) => visited.push(index));

    expect(visited).toHaveLength(1000);
    expect(ownChecks).toBe(0);
  });

  test('lists the rest by its own keys once holes outnumber entries, not one `Object.hasOwn` per hole', () => {
    const length = SPARSE_RUN * 4;
    const list: unknown[] = [];
    list.length = length;
    for (let index = 0; index < length; index += 60) {
      list[index] = index;
    }
    let ownChecks = 0;
    const source = new Proxy(list, {
      getOwnPropertyDescriptor: (target, key) => {
        ownChecks++;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    const visited: number[] = [];

    forEachOwnIndex(source, length, (index) => visited.push(index));

    expect(visited).toEqual(Object.keys(list).map(Number));
    // A hole each up to SPARSE_RUN, then one per listed entry.
    expect(ownChecks).toBeLessThan(SPARSE_RUN * 1.1);
  });

  test("visits a hole a Proxy's has trap answers for", () => {
    const list: unknown[] = ['a'];
    list.length = 3;
    const visited: number[] = [];

    forEachOwnIndex(new Proxy(list, { has: () => true }), 3, (index) =>
      visited.push(index),
    );

    expect(visited).toEqual([0, 1, 2]);
  });

  test("visits an own entry a Proxy's has trap hides, and not a hole beside it", () => {
    const list: unknown[] = ['a'];
    list.length = 3;
    list[2] = 'c';
    const visited: number[] = [];

    forEachOwnIndex(new Proxy(list, { has: () => false }), 3, (index) =>
      visited.push(index),
    );

    expect(visited).toEqual([0, 2]);
  });

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
