import { describe, expect, it, test } from 'bun:test';
import {
  areArraysEqual,
  isArray,
  isEveryArrayItemAnString,
  prependStringToArrayItems,
  pushWithoutDuplicates,
  removeEmptyStringsFromArray,
} from './arrays';

test('removeEmptyStringsFromArray', () => {
  const array = ['a', '', 'b', '   ', 'c'];
  const result = removeEmptyStringsFromArray(array);

  expect(result).toEqual(['a', 'b', 'c']);
});

test('prependStringToArrayItems', () => {
  const array = ['a', 'b', 'c'];
  const result = prependStringToArrayItems(array, 'letter.');

  expect(result).toEqual(['letter.a', 'letter.b', 'letter.c']);
});

describe('isEveryArrayItemAnString', () => {
  it('should return false if the type is not an array', () => {
    expect(isEveryArrayItemAnString(1)).toBe(false);
  });

  it('should return true if the array is empty', () => {
    expect(isEveryArrayItemAnString([])).toBe(true);
  });

  it('should return true if every item in the array is a string', () => {
    const array = ['a', 'b', 'c'];
    expect(isEveryArrayItemAnString(array)).toBe(true);
  });

  it('should return false if any item in the array is not a string', () => {
    const array = ['a', 'b', 'c', 1];
    expect(isEveryArrayItemAnString(array)).toBe(false);
  });
});

describe('Array Equality Tests', () => {
  it('should return true for two identical arrays', () => {
    expect(areArraysEqual([1, 2, 3], [1, 2, 3])).toBeTruthy();
  });

  it('should return false for arrays of different lengths', () => {
    expect(areArraysEqual([1, 2, 3], [1, 2])).toBeFalsy();
  });

  it('should return false for arrays with different contents', () => {
    expect(areArraysEqual([1, 2, 3], [4, 5, 6])).toBeFalsy();
  });

  it('should return true for two empty arrays', () => {
    expect(areArraysEqual([], [])).toBeTruthy();
  });
});

describe('pushWithoutDuplicates', () => {
  test('pushWithoutDuplicates should add value to array if it does not already exist', () => {
    const array = ['a', 'b', 'c'];
    const value = 'd';

    pushWithoutDuplicates(array, value);
    expect(array).toEqual(['a', 'b', 'c', 'd']);
  });

  test('pushWithoutDuplicates should not add value to array if it already exists', () => {
    const array = ['a', 'b', 'c'];
    const value = 'b';

    pushWithoutDuplicates(array, value);
    expect(array).toEqual(['a', 'b', 'c']);
  });

  test('pushWithoutDuplicates should handle arrays with different types of values', () => {
    const array = ['a', 1, true];
    // eslint-disable-next-line @typescript-eslint/naming-convention
    const value = false;

    pushWithoutDuplicates(array, value);
    expect(array).toEqual(['a', 1, true, false]);
  });

  test('pushWithoutDuplicates should handle empty arrays', () => {
    const array: unknown[] = [];
    const value = 'a';

    pushWithoutDuplicates(array, value);
    expect(array).toEqual(['a']);
  });
});

describe('isArray', () => {
  test('should return true for arrays', () => {
    expect(isArray([])).toBe(true);
    expect(isArray([1, 2, 3])).toBe(true);
    expect(isArray(['a', 'b', 'c'])).toBe(true);
  });

  test('should return false for non-arrays', () => {
    expect(isArray('string')).toBe(false);
    expect(isArray(123)).toBe(false);
    expect(isArray(null)).toBe(false);
    expect(isArray(undefined)).toBe(false);
    expect(isArray({})).toBe(false);
    expect(isArray({ length: 0 })).toBe(false);
  });
});
