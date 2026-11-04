import { describe, expect, test } from 'bun:test';
import { copyArrayValue, readArrayLength } from './array-copy';

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
  test('refuses a length an array cannot have', () => {
    expect(() => copyArrayValue(withLength(Infinity))).toThrow(
      new TypeError('A list has no array length'),
    );
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
