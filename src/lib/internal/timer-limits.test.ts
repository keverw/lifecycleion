import { expect, test } from 'bun:test';
import {
  MAX_TIMER_MS,
  assertDurationMS,
  clampTimerDelayMS,
  isTimeoutValidationError,
  resolveTimeoutMS,
  optionalValidatedTimerDelayMS,
  toTimerDelayMS,
} from './timer-limits';

// Invalid explicit values must fail before any caller starts a wait. Optional
// nullish values select defaults; required durations remain strict.
test.each([NaN, '100', {}, true])(
  'invalid timeout %s is a type error',
  (value) => {
    const input = value as number;
    expect(() => resolveTimeoutMS(input, 5000)).toThrow(TypeError);
    expect(() => toTimerDelayMS(input)).toThrow(TypeError);
  },
);

test.each([-Infinity, -1])('negative timeout %s is a range error', (value) => {
  expect(() => resolveTimeoutMS(value, 5000)).toThrow(RangeError);
  expect(() => toTimerDelayMS(value)).toThrow(RangeError);
});

test.each([undefined, null])(
  'nullish optional duration %s selects the default; required duration stays strict',
  (value) => {
    expect(resolveTimeoutMS(value, 5000)).toBe(5000);
    expect(resolveTimeoutMS(value, 0)).toBe(0);
    expect(resolveTimeoutMS(value, Infinity)).toBe(MAX_TIMER_MS);
    expect(() => resolveTimeoutMS(value, NaN)).toThrow(TypeError);
    expect(() => resolveTimeoutMS(value, -1)).toThrow(RangeError);
    expect(() =>
      toTimerDelayMS(value as unknown as number, 'Startup timeout'),
    ).toThrow('Startup timeout must be a number other than NaN');
    expect(() => assertDurationMS(value)).toThrow(TypeError);
  },
);

test('only timeout validator errors carry its internal identity', () => {
  const failures: Error[] = [];
  for (const invoke of [
    () => assertDurationMS(NaN, 'Custom duration'),
    () => resolveTimeoutMS(-1, 5000, 'Custom duration'),
    () => toTimerDelayMS(undefined as unknown as number, 'Custom duration'),
  ]) {
    try {
      invoke();
    } catch (error) {
      expect(isTimeoutValidationError(error)).toBe(true);
      failures.push(error as Error);
    }
  }
  expect(failures).toHaveLength(3);
  expect(failures[0]).toBeInstanceOf(TypeError);
  expect(failures[1]).toBeInstanceOf(RangeError);
  expect(failures[2]?.message).toBe(
    'Custom duration must be a number other than NaN',
  );
  expect(() => toTimerDelayMS(-1, 'Signal timeout')).toThrow(
    'Signal timeout must be non-negative',
  );
  expect(isTimeoutValidationError(new TypeError('unrelated'))).toBe(false);
  expect(isTimeoutValidationError(new RangeError('unrelated'))).toBe(false);
  expect(isTimeoutValidationError(undefined)).toBe(false);
});

test.each([Infinity, MAX_TIMER_MS + 1])(
  'oversized timeout %s shares the ceiling',
  (value) => {
    expect(resolveTimeoutMS(value, 5000)).toBe(MAX_TIMER_MS);
    expect(toTimerDelayMS(value)).toBe(MAX_TIMER_MS);
  },
);

test('zero disables handler deadlines but preserves immediate queue deadlines', () => {
  expect(resolveTimeoutMS(0, 5000)).toBe(0);
  expect(Object.is(resolveTimeoutMS(-0, 5000), 0)).toBe(true);
  expect(Object.is(toTimerDelayMS(-0), 0)).toBe(true);
  expect(optionalValidatedTimerDelayMS(0)).toBeUndefined();
});

test('finite durations retain their value under both policies', () => {
  expect(resolveTimeoutMS(12.5, 5000)).toBe(12.5);
  expect(toTimerDelayMS(12.5)).toBe(12.5);
  expect(optionalValidatedTimerDelayMS(12.5)).toBe(12.5);
});

test('clamping bounds oversized delays, normalizes non-positive ones and passes NaN through', () => {
  expect(clampTimerDelayMS(MAX_TIMER_MS + 1)).toBe(MAX_TIMER_MS);
  expect(Object.is(clampTimerDelayMS(-0), 0)).toBe(true);
  expect(clampTimerDelayMS(-5)).toBe(0);
  expect(clampTimerDelayMS(NaN)).toBeNaN();
});
