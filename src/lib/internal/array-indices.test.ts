import { describe, expect, spyOn, test } from 'bun:test';
import { deepClone } from '../deep-clone';
import { LRUCache } from '../lru-cache';
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

describe('an array that opens with a run of holes', () => {
  const walkers: [string, (array: unknown[]) => void][] = [
    [
      'forEachOwnIndex',
      (array) => {
        forEachOwnIndex(array, array.length, () => undefined);
      },
    ],
    ['deepClone', (array) => void deepClone(array)],
    [
      "LRUCache's size estimate",
      (array) => {
        new LRUCache(1, { maxSize: Number.MAX_SAFE_INTEGER }).set('k', array);
      },
    ],
  ];

  /** Calls of `Object.getOwnPropertyNames` on `array` while `run` walks it. */
  function listings(array: unknown[], run: (array: unknown[]) => void): number {
    const list = spyOn(Object, 'getOwnPropertyNames');
    try {
      run(array);
      return list.mock.calls.filter(([target]) => target === array).length;
    } finally {
      list.mockRestore();
    }
  }

  test.each(walkers)(
    'and is full after it is walked by index by %s, its keys never listed',
    (_label, run) => {
      const array: number[] = [];
      array.length = 70_000;
      for (let index = 70_000; index < 270_000; index++) {
        array[index] = index;
      }

      expect(listings(array, run)).toBe(0);
    },
  );

  test.each(walkers)(
    'of any length, or with one between its full stretches, is walked by index by %s',
    (_label, run) => {
      // 300,000 holes, more than a sample's run of grace after the first.
      const prefixed: number[] = [];
      prefixed.length = 300_000;
      for (let index = 300_000; index < 2_300_000; index++) {
        prefixed[index] = index;
      }

      const gapped: number[] = [];
      for (let index = 0; index < 100_000; index++) {
        gapped[index] = index;
      }
      gapped.length = 400_000;
      for (let index = 400_000; index < 2_400_000; index++) {
        gapped[index] = index;
      }

      expect(listings(prefixed, run)).toBe(0);
      expect(listings(gapped, run)).toBe(0);
    },
  );

  test.each(walkers)(
    'and holds little after it is read by its own keys by %s',
    (_label, run) => {
      const array: number[] = [];
      array.length = 270_000;
      for (let index = 70_000; index < 270_000; index += 1000) {
        array[index] = index;
      }

      expect(listings(array, run)).toBe(1);
    },
  );
});

describe('an array whose few entries sit where a walk samples it', () => {
  /**
   * An array of `length` whose entries are planted where a walk sampling at even spacing
   * at each run of {@link SPARSE_RUN} holes would sample it, so that each such sample
   * would read the rest as mostly full.
   */
  function plantedAtSamples(length: number): number[] {
    const array: number[] = [];
    array.length = length;
    let holes = 0;
    let entries = 0;

    for (let index = 0; index < length; index++) {
      if (Object.hasOwn(array, index)) {
        entries++;
        continue;
      }

      if (++holes > SPARSE_RUN && holes > entries) {
        const start = index + 1;
        const span = length - start;
        if (span < 64) {
          break;
        }
        for (let sample = 0; sample < 33; sample++) {
          array[start + Math.floor((span * sample) / 64)] = 1;
        }
        holes = 0;
        entries = 0;
      }
    }

    return array;
  }

  test.each<[string, (array: unknown[]) => void]>([
    [
      'forEachOwnIndex',
      (array) => {
        forEachOwnIndex(array, array.length, () => undefined);
      },
    ],
    ['deepClone', (array) => void deepClone(array)],
  ])('is listed by %s within two runs of holes', (_label, run) => {
    const array = plantedAtSamples(1 << 22);
    let reads = 0;
    const counted = new Proxy(array, {
      has: (target, key) => {
        reads++;
        return Reflect.has(target, key);
      },
      getOwnPropertyDescriptor: (target, key) => {
        reads++;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });

    run(counted);

    // Its samples fall at random, so the planted entries do not pass them: two runs of
    // holes at most, each index read at most twice, and the planted entries listed.
    expect(reads).toBeLessThan(5 * SPARSE_RUN);
  });
});

describe('a walk that samples the rest of an array', () => {
  test.each<[string, (array: unknown[]) => void]>([
    ['deepClone', (array) => void deepClone(array)],
    [
      "LRUCache's size estimate",
      (array) => {
        new LRUCache(1, { maxSize: Number.MAX_SAFE_INTEGER }).set('k', array);
      },
    ],
  ])(
    'samples it so that %s lists a Proxy whose has hides what its descriptors claim',
    (_label, run) => {
      let has = 0;
      let listed = 0;
      const target: unknown[] = [];
      target.length = 300_000;
      const isIndex = (key: string | symbol) =>
        typeof key === 'string' && /^\d+$/.test(key);
      const disagreeing = new Proxy(target, {
        has: (array, key) => {
          if (isIndex(key)) {
            has++;
            return false;
          }
          return Reflect.has(array, key);
        },
        getOwnPropertyDescriptor: (array, key) =>
          isIndex(key)
            ? { value: 1, writable: true, enumerable: true, configurable: true }
            : Reflect.getOwnPropertyDescriptor(array, key),
        ownKeys: (array) => {
          listed++;
          return Reflect.ownKeys(array);
        },
      });

      run(disagreeing);

      expect(has).toBeLessThan(SPARSE_RUN + 1000);
      expect(listed).toBeGreaterThan(0);
    },
  );

  test.each<[string, (array: unknown[]) => void]>([
    [
      'forEachOwnIndex',
      (array) => {
        forEachOwnIndex(array, array.length, () => undefined);
      },
    ],
    ['deepClone', (array) => void deepClone(array)],
    [
      "LRUCache's size estimate",
      (array) => {
        new LRUCache(1, { maxSize: Number.MAX_SAFE_INTEGER }).set('k', array);
      },
    ],
  ])(
    'lists by %s an array whose Proxy prototype answers in for the indices sampled, not those walked',
    (_label, run) => {
      let has = 0;
      let last = -1;
      // Answers `in` for any index but the next one a walk in order reads - so for the
      // samples - and lists no index of its own, so it passes as a prototype that fills
      // none.
      const prototype = new Proxy(Object.create(Array.prototype) as object, {
        has: (target, key) => {
          if (typeof key === 'string' && /^\d+$/.test(key)) {
            has++;
            const index = Number(key);
            if (index === last + 1) {
              last = index;
              return false;
            }
            return true;
          }
          return Reflect.has(target, key);
        },
      });
      const array: unknown[] = [];
      array.length = 2_000_000;
      Object.setPrototypeOf(array, prototype);

      run(array);

      expect(has).toBeLessThan(SPARSE_RUN + 1000);
    },
  );

  test.each<[string, (array: unknown[]) => unknown]>([
    [
      'forEachOwnIndex',
      (array) => {
        const visited: number[] = [];
        forEachOwnIndex(array, array.length, (index) => visited.push(index));
        return visited;
      },
    ],
    [
      'deepClone',
      (array) => {
        const copy = deepClone(array);
        return [copy.length, Object.keys(copy), Object.values(copy)];
      },
    ],
    [
      "LRUCache's size estimate",
      (array) => {
        const cache = new LRUCache(1, { maxSize: Number.MAX_SAFE_INTEGER });
        cache.set('k', array);
        return cache.byteSize;
      },
    ],
  ])(
    'reads the same entries by %s whichever way the samples send it',
    (_label, read) => {
      // 70,000 holes, then a stretch with every other index held and its last held, so a
      // sample at the end finds it full and one at the start finds it empty.
      const array: number[] = [];
      array.length = 170_000;
      for (let index = 70_000; index < 170_000; index += 2) {
        array[index] = index;
      }
      array[169_999] = 169_999;

      /** What `read` returns, and how often it listed `array`, with samples at `at`. */
      function readWithSamplesAt(at: number): [unknown, number] {
        const random = spyOn(Math, 'random').mockImplementation(() => at);
        const list = spyOn(Object, 'getOwnPropertyNames');
        try {
          const result = read(array);
          return [
            result,
            list.mock.calls.filter(([of]) => of === array).length,
          ];
        } finally {
          list.mockRestore();
          random.mockRestore();
        }
      }

      const [byIndex, listedByIndex] = readWithSamplesAt(1 - Number.EPSILON);
      const [byKeys, listedByKeys] = readWithSamplesAt(0);

      expect(listedByIndex).toBe(0);
      expect(listedByKeys).toBe(1);
      expect(byIndex).toEqual(byKeys);
    },
  );
});
