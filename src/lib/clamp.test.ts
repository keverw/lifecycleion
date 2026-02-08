import { describe, expect, it } from 'bun:test';
import { clamp, finiteClampMin } from './clamp';

describe('clamp', () => {
  it('returns the value when within the range', () => {
    expect(clamp(5, 1, 10)).toBe(5);
  });

  it('returns the min value when the value is below the range', () => {
    expect(clamp(0, 1, 10)).toBe(1);
  });

  it('returns the max value when the value is above the range', () => {
    expect(clamp(11, 1, 10)).toBe(10);
  });

  it('handles negative ranges', () => {
    expect(clamp(-5, -10, -1)).toBe(-5);
    expect(clamp(-11, -10, -1)).toBe(-10);
    expect(clamp(0, -10, -1)).toBe(-1);
  });

  it('handles zero edge cases', () => {
    expect(clamp(0, -10, 10)).toBe(0);
    expect(clamp(-20, 0, 10)).toBe(0);
    expect(clamp(20, -10, 0)).toBe(0);
  });

  it('returns the min value if max is less than min', () => {
    expect(clamp(5, 10, 1)).toBe(10); // This is a bit of an edge case; behavior may depend on your requirements
  });

  // Additional tests for edge cases, like when min and max are equal, can also be beneficial
  it('returns the same value for min and max being equal', () => {
    expect(clamp(5, 5, 5)).toBe(5);
    expect(clamp(10, 5, 5)).toBe(5);
    expect(clamp(0, 5, 5)).toBe(5);
  });
});

describe('clamp with Infinity', () => {
  it('handles value as Infinity', () => {
    expect(clamp(Infinity, 0, 10)).toBe(10);
    expect(clamp(Infinity, 0, Infinity)).toBe(Infinity);
  });

  it('handles value as -Infinity', () => {
    expect(clamp(-Infinity, -10, 10)).toBe(-10);
    expect(clamp(-Infinity, -Infinity, 10)).toBe(-Infinity);
  });

  it('handles min or max as Infinity', () => {
    expect(clamp(5, Infinity, 10)).toBe(Infinity); // Unusual case, showing logical outcome
    expect(clamp(5, -Infinity, 10)).toBe(5);
    expect(clamp(5, 0, Infinity)).toBe(5);
    expect(clamp(5, 0, -Infinity)).toBe(0); // Edge case; logically, max should never be -Infinity
  });
});

describe('finiteClampMin', () => {
  it('returns the value when above minimum', () => {
    expect(finiteClampMin(5000, 1000, 3000)).toBe(5000);
    expect(finiteClampMin(2000, 1000, 3000)).toBe(2000);
  });

  it('enforces the minimum when value is below it', () => {
    expect(finiteClampMin(500, 1000, 3000)).toBe(1000);
    expect(finiteClampMin(0, 1000, 3000)).toBe(1000);
    expect(finiteClampMin(-100, 1000, 3000)).toBe(1000);
  });

  it('returns default when value is Infinity', () => {
    expect(finiteClampMin(Infinity, 1000, 3000)).toBe(3000);
  });

  it('returns default when value is -Infinity', () => {
    expect(finiteClampMin(-Infinity, 1000, 3000)).toBe(3000);
  });

  it('returns default when value is NaN', () => {
    expect(finiteClampMin(NaN, 1000, 3000)).toBe(3000);
  });

  it('handles negative minimums', () => {
    expect(finiteClampMin(-5, -10, -3)).toBe(-5); // -5 > -10, so return -5
    expect(finiteClampMin(-15, -10, -3)).toBe(-10); // -15 < -10, so enforce min of -10
  });

  it('handles zero values correctly', () => {
    expect(finiteClampMin(0, -10, 5)).toBe(0);
    expect(finiteClampMin(0, 10, 5)).toBe(10);
  });

  it('handles when value equals minimum exactly', () => {
    expect(finiteClampMin(1000, 1000, 3000)).toBe(1000);
  });

  it('handles large finite numbers', () => {
    const largeNumber = Number.MAX_SAFE_INTEGER;
    expect(finiteClampMin(largeNumber, 1000, 3000)).toBe(largeNumber);
  });

  it('returns default when value is undefined', () => {
    expect(finiteClampMin(undefined, 1000, 3000)).toBe(3000);
  });

  it('returns default when value is null', () => {
    expect(finiteClampMin(null, 1000, 3000)).toBe(3000);
  });
});
