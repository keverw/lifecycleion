import { describe, expect, test } from 'bun:test';
import { isNumber, isFiniteNumber } from './is-number';

describe('isNumber', () => {
  test('should return true for valid numbers', () => {
    expect(isNumber(0)).toBe(true);
    expect(isNumber(42)).toBe(true);
    expect(isNumber(-42)).toBe(true);
    expect(isNumber(3.14)).toBe(true);
    expect(isNumber(-3.14)).toBe(true);
    expect(isNumber(Number.MAX_VALUE)).toBe(true);
    expect(isNumber(Number.MIN_VALUE)).toBe(true);
    expect(isNumber(Infinity)).toBe(true);
    expect(isNumber(-Infinity)).toBe(true);
  });

  test('should return false for NaN', () => {
    expect(isNumber(NaN)).toBe(false);
  });

  test('should return false for non-numbers', () => {
    expect(isNumber('123')).toBe(false);
    expect(isNumber('0')).toBe(false);
    expect(isNumber(null)).toBe(false);
    expect(isNumber(undefined)).toBe(false);
    expect(isNumber(true)).toBe(false);
    expect(isNumber(false)).toBe(false);
    expect(isNumber({})).toBe(false);
    expect(isNumber([])).toBe(false);
    expect(isNumber(() => {})).toBe(false);
    expect(isNumber(Symbol('test'))).toBe(false);
  });
});

describe('isFiniteNumber', () => {
  test('should return true for finite numbers', () => {
    expect(isFiniteNumber(0)).toBe(true);
    expect(isFiniteNumber(42)).toBe(true);
    expect(isFiniteNumber(-42)).toBe(true);
    expect(isFiniteNumber(3.14)).toBe(true);
    expect(isFiniteNumber(-3.14)).toBe(true);
    expect(isFiniteNumber(Number.MAX_VALUE)).toBe(true);
    expect(isFiniteNumber(Number.MIN_VALUE)).toBe(true);
  });

  test('should return false for NaN and infinite values', () => {
    expect(isFiniteNumber(NaN)).toBe(false);
    expect(isFiniteNumber(Infinity)).toBe(false);
    expect(isFiniteNumber(-Infinity)).toBe(false);
  });

  test('should return false for non-numbers', () => {
    expect(isFiniteNumber('123')).toBe(false);
    expect(isFiniteNumber('0')).toBe(false);
    expect(isFiniteNumber(null)).toBe(false);
    expect(isFiniteNumber(undefined)).toBe(false);
    expect(isFiniteNumber(true)).toBe(false);
    expect(isFiniteNumber(false)).toBe(false);
    expect(isFiniteNumber({})).toBe(false);
    expect(isFiniteNumber([])).toBe(false);
    expect(isFiniteNumber(() => {})).toBe(false);
    expect(isFiniteNumber(Symbol('test'))).toBe(false);
  });
});
