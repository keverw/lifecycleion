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

test('defines an entry while Object.prototype carries a polluted get', () => {
  const record: Record<string, unknown> = {};
  // As JSON-merge pollution of caller data leaves it: a plain enumerable value.
  (Object.prototype as Record<string, unknown>)['get'] = 'x';
  try {
    defineEntry(record, 'key', 1);
  } finally {
    delete (Object.prototype as Record<string, unknown>)['get'];
  }
  expect(Object.getOwnPropertyDescriptor(record, 'key')).toEqual({
    value: 1,
    enumerable: true,
    writable: true,
    configurable: true,
  });
});
