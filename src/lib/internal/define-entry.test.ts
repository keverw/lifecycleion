import { expect, test } from 'bun:test';
import { defineEntry } from './define-entry';

test('defines a __proto__ key as an own entry without reparenting the record', () => {
  const record: Record<string, unknown> = {};
  defineEntry(record, '__proto__', { polluted: true });
  expect(Object.getPrototypeOf(record)).toBe(Object.prototype);
  expect(Object.getOwnPropertyDescriptor(record, '__proto__')).toEqual({
    value: { polluted: true },
    enumerable: true,
    writable: true,
    configurable: true,
  });
});

test('throws rather than dropping an entry the target refuses', () => {
  const record = Object.freeze({}) as Record<string, unknown>;
  expect(() => defineEntry(record, 'key', 1)).toThrow(TypeError);
});
