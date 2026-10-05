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

it('returns false for a revoked object proxy', () => {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  expect(isFunction(proxy)).toBe(false);
});

it('returns false for a non-callable object inheriting from Function.prototype', () => {
  const fake: unknown = Object.create(Function.prototype);

  expect(isFunction(fake)).toBe(false);
});

it('returns true for every callable shape', () => {
  class Example {}

  expect(isFunction(async () => {})).toBe(true);
  expect(isFunction(function* generator() {})).toBe(true);
  expect(isFunction(Example)).toBe(true);
  expect(isFunction((() => undefined).bind(null))).toBe(true);
  expect(isFunction(new Proxy(() => undefined, {}))).toBe(true);
});

it('never runs proxy traps', () => {
  let trapCalls = 0;
  const proxy = new Proxy(
    {},
    {
      getPrototypeOf() {
        trapCalls++;
        return Function.prototype;
      },
    },
  );

  expect(isFunction(proxy)).toBe(false);
  expect(trapCalls).toBe(0);
});
