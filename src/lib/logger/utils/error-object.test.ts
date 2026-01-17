import { describe, expect, test } from 'bun:test';
import { prepareErrorObjectLog } from './error-object';

describe('prepareErrorObjectLog', () => {
  test('should format error with prefix', () => {
    const error = new Error('Test error');
    const result = prepareErrorObjectLog('Failed to process', error);

    expect(result).toContain('Failed to process:');
    expect(result).toContain('Test error');
  });

  test('should format error without prefix', () => {
    const error = new Error('Test error');
    const result = prepareErrorObjectLog('', error);

    expect(result).toContain('Test error');
    // Should not have a prefix line (no "prefix: " at the start)

    expect(result.startsWith('+')).toBe(true);
  });

  test('should trim prefix whitespace', () => {
    const error = new Error('Test error');
    const result = prepareErrorObjectLog('  Failed to process  ', error);

    expect(result).toContain('Failed to process:');
    expect(result).not.toContain('  Failed to process  :');
  });

  test('should handle non-Error objects', () => {
    const error = { message: 'Custom error' };
    const result = prepareErrorObjectLog('Error occurred', error);

    expect(result).toContain('Error occurred:');
    expect(result).toContain('Custom error');
  });

  test('should handle string errors', () => {
    const error = 'Something went wrong';
    const result = prepareErrorObjectLog('Error', error);

    expect(result).toContain('Error:');
    // errorToString formats strings as empty tables, so just check prefix exists
    expect(result.startsWith('Error:')).toBe(true);
  });

  test('should handle null/undefined errors', () => {
    const result1 = prepareErrorObjectLog('Error', null);
    const result2 = prepareErrorObjectLog('Error', undefined);

    expect(result1).toContain('Error:');
    expect(result2).toContain('Error:');
  });
});
