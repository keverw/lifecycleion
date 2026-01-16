import { describe, expect, it, mock } from 'bun:test';
import { isFunction } from './is-function';

describe('isFunction', () => {
  it('should return true for a regular function', () => {
    function testFunc(): void {}
    expect(isFunction(testFunc)).toBe(true);
  });

  it('should return true for an arrow function', () => {
    const testFunc = (): void => {};
    expect(isFunction(testFunc)).toBe(true);
  });

  it('should return true for a function created with Function constructor', () => {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const testFunc = new Function();
    expect(isFunction(testFunc)).toBe(true);
  });

  it('should return true for a function created with mock()', () => {
    const testFunc = mock();
    expect(isFunction(testFunc)).toBe(true);
  });

  it('should return false for a number', () => {
    expect(isFunction(42)).toBe(false);
  });

  it('should return false for a string', () => {
    expect(isFunction('hello')).toBe(false);
  });

  it('should return false for an object', () => {
    expect(isFunction({})).toBe(false);
  });

  it('should return false for an array', () => {
    expect(isFunction([])).toBe(false);
  });

  it('should return false for null', () => {
    expect(isFunction(null)).toBe(false);
  });

  it('should return false for undefined', () => {
    expect(isFunction(undefined)).toBe(false);
  });
});
