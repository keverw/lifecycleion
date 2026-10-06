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

test('ignores descriptor fields added to Object.prototype', () => {
  const record: Record<string, unknown> = {};
  Object.defineProperty(Object.prototype, 'get', {
    configurable: true,
    value: 'x',
  });
  try {
    defineEntry(record, 'key', 1);
  } finally {
    delete (Object.prototype as Record<string, unknown>).get;
  }
  expect(record.key).toBe(1);
});

test('keeps the captured define after Object.defineProperty is replaced', () => {
  const record: Record<string, unknown> = {};
  const original = Object.defineProperty;
  try {
    Object.defineProperty = (() => {
      throw new Error('live defineProperty used');
    }) as typeof Object.defineProperty;
    defineEntry(record, 'key', 1);
  } finally {
    Object.defineProperty = original;
  }
  expect(record.key).toBe(1);
});

test('throws rather than dropping an entry the target refuses', () => {
  const record = Object.freeze({}) as Record<string, unknown>;
  expect(() => defineEntry(record, 'key', 1)).toThrow(TypeError);
});
