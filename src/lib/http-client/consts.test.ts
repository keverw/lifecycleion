import { expect, test } from 'bun:test';
import {
  DEFAULT_TIMEOUT_MS,
  MAX_TIMER_MS,
  resolveRequestTimeoutMS,
} from './consts';

test.each([undefined, null])(
  'nullish HTTP timeout %s selects the configured default',
  (value) => {
    expect(resolveRequestTimeoutMS(value)).toBe(DEFAULT_TIMEOUT_MS);
    expect(resolveRequestTimeoutMS(value, 125)).toBe(125);
    expect(resolveRequestTimeoutMS(value, 0)).toBe(0);
  },
);

test.each([NaN, '100', {}, true])(
  'invalid explicit HTTP timeout %s remains a type error',
  (value) => {
    expect(() => resolveRequestTimeoutMS(value)).toThrow(TypeError);
  },
);

test.each([0, -1, -Infinity, Infinity])(
  'HTTP timeout %s retains its disabled sentinel',
  (value) => {
    expect(resolveRequestTimeoutMS(value, 5000)).toBe(0);
  },
);

test('finite HTTP timeouts retain their value and the runtime ceiling', () => {
  expect(resolveRequestTimeoutMS(12.5)).toBe(12.5);
  expect(resolveRequestTimeoutMS(MAX_TIMER_MS + 1)).toBe(MAX_TIMER_MS);
});
