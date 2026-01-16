import { isString } from './strings';

export function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

export function removeEmptyStringsFromArray(array: string[]): string[] {
  const newArray: string[] = [];

  for (let item of array) {
    item = item.trim();

    if (item.length > 0) {
      newArray.push(item);
    }
  }

  return newArray;
}

/**
 * Will take an array and return a new array with a value prepended to each item
 *
 * @param array
 * @param value
 * @returns
 */

export function prependStringToArrayItems(
  array: string[],
  value: string,
): string[] {
  const newArray: string[] = [];

  for (const item of array) {
    newArray.push(value + item);
  }

  return newArray;
}

export function isEveryArrayItemAnString(value: unknown): boolean {
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!isString(item)) {
        return false;
      }
    }

    return true;
  } else {
    return false;
  }
}

export function areArraysEqual<T>(arr1: T[], arr2: T[]): boolean {
  // Check if the arrays are the same length
  if (arr1.length !== arr2.length) {
    return false;
  }

  // Check each element in the arrays
  for (const [i, element] of arr1.entries()) {
    if (element !== arr2[i]) {
      return false;
    }
  }

  // If all elements are equal
  return true;
}

export function pushWithoutDuplicates(array: unknown[], value: unknown): void {
  if (!array.includes(value)) {
    array.push(value);
  }
}
