import { expect, test } from 'bun:test';
import { isPromise } from './is-promise';

test('isPromise function', () => {
  expect(isPromise(null)).toBe(false);
  expect(isPromise(undefined)).toBe(false);
  expect(isPromise(0)).toBe(false);
  expect(isPromise(-42)).toBe(false);
  expect(isPromise(42)).toBe(false);
  expect(isPromise('')).toBe(false);
  expect(isPromise('then')).toBe(false);
  expect(isPromise(false)).toBe(false);
  expect(isPromise(true)).toBe(false);
  expect(isPromise({})).toBe(false);
  expect(isPromise({ then: true })).toBe(false);
  expect(isPromise([])).toBe(false);
  expect(isPromise([true])).toBe(false);
  expect(isPromise(() => {})).toBe(false);

  // This looks similar enough to a promise
  // that promises/A+ says we should treat
  // it as a promise.
  const promise = { then: function (): void {} };
  expect(isPromise(promise)).toBe(true);

  const fn = (): void => {};

  fn.then = (): void => {};
  expect(isPromise(fn)).toBe(true);
});
