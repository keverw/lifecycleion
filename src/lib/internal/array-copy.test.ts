import { describe, expect, test } from 'bun:test';
import {
  copyArrayValue,
  MAX_COPIED_ARRAY_LENGTH,
  readArrayLength,
} from './array-copy';
import { SPARSE_RUN } from './array-indices';

/** An array whose `length` reads as `length`, as a `Proxy`'s trap may answer. */
function withLength(length: unknown): unknown[] {
  return new Proxy(['a'], {
    get: (target, key, receiver) =>
      key === 'length' ? length : Reflect.get(target, key, receiver),
  });
}

describe('readArrayLength', () => {
  test.each([Infinity, 1.5, -1, Number.NaN, 2 ** 32, '1'])(
    'refuses a length of %p as a TypeError naming the label',
    (length) => {
      expect(() => readArrayLength(withLength(length), 'The list')).toThrow(
        new TypeError('The list has no array length'),
      );
    },
  );

  test("answers an array's own length", () => {
    expect(readArrayLength(['a', 'b'], 'The list')).toBe(2);
    expect(readArrayLength(withLength(1), 'The list')).toBe(1);
  });
});

describe('copyArrayValue', () => {
  test('a long sparse list is copied without its holes allocated', () => {
    const list: unknown[] = [];
    list.length = 2 ** 24;
    list[5] = 'x';
    const before = process.memoryUsage().rss;
    const copies = Array.from({ length: 4 }, () => copyArrayValue(list));
    const grown = process.memoryUsage().rss - before;

    for (const copy of copies) {
      expect(copy).toHaveLength(2 ** 24);
      expect(Object.keys(copy)).toEqual(['5']);
      expect(copy[5]).toBe('x');
      expect(Object.hasOwn(copy, 2 ** 24)).toBe(false);
    }
    // Each would be 128 MiB allocated whole.
    expect(grown).toBeLessThan(64 * 1024 * 1024);
  });

  test('a long dense list is copied whole, in order', () => {
    const list = Array.from({ length: SPARSE_RUN * 2 }, (_, index) => index);
    const copy = copyArrayValue(list);

    expect(copy).toEqual(list);
    expect(Object.hasOwn(copy, SPARSE_RUN * 2)).toBe(false);
  });

  test('refuses a length an array cannot have', () => {
    expect(() => copyArrayValue(withLength(Infinity))).toThrow(
      new TypeError('A list has no array length'),
    );
  });

  test('refuses a sparse length over the cap rather than walking it', () => {
    const list: unknown[] = [];
    list.length = 2 ** 32 - 1;

    expect(() => copyArrayValue(list)).toThrow(
      new TypeError(
        `A list has a length over ${String(MAX_COPIED_ARRAY_LENGTH)} (got ${String(2 ** 32 - 1)})`,
      ),
    );
  });

  test("copies its own entries whatever a Proxy's has trap answers", () => {
    const copy = copyArrayValue(new Proxy(['a', 'b'], { has: () => false }));

    expect(Object.hasOwn(copy, 0)).toBe(true);
    expect(copy).toEqual(['a', 'b']);
  });

  test("reads a sparse list's tail by its own keys, not index by index", () => {
    const list: unknown[] = ['a'];
    list.length = 2 ** 22;
    list[2 ** 22 - 1] = 'z';
    let ownChecks = 0;
    const counted = new Proxy(list, {
      getOwnPropertyDescriptor: (target, key) => {
        ownChecks++;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });

    const copy = copyArrayValue(counted);

    expect(copy).toHaveLength(2 ** 22);
    expect(copy[0]).toBe('a');
    expect(copy[2 ** 22 - 1]).toBe('z');
    expect(Object.keys(copy)).toEqual(['0', String(2 ** 22 - 1)]);
    expect(ownChecks).toBeLessThan(SPARSE_RUN * 2);
  });

  test('keeps a hole its prototype fills as a hole', () => {
    const list: unknown[] = ['a'];
    list.length = 2;
    Object.setPrototypeOf(
      list,
      Object.assign(Object.create(Array.prototype), { 1: 'inherited' }),
    );

    const copy = copyArrayValue(list);
    expect(copy).toHaveLength(2);
    expect(Object.hasOwn(copy, 1)).toBe(false);
    expect(Reflect.getPrototypeOf(copy)).toBe(Array.prototype);
  });

  test('copies by index, keeping holes, and leaves a non-array as it is', () => {
    // eslint-disable-next-line no-sparse-arrays
    const copy = copyArrayValue([, 'b']);
    expect(copy).toHaveLength(2);
    expect(0 in copy).toBe(false);
    expect(copy[1]).toBe('b');
    expect(copyArrayValue('a')).toBe('a');
  });
});
