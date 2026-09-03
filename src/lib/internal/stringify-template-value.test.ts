import { describe, expect, test } from 'bun:test';
import { stringifyTemplateValue } from './stringify-template-value';

describe('stringifyTemplateValue', () => {
  test('should return strings unchanged', () => {
    expect(stringifyTemplateValue('secret123')).toBe('secret123');
  });

  test('should stringify Error values', () => {
    expect(stringifyTemplateValue(new Error('boom'))).toBe('Error: boom');
  });

  test('should stringify arrays', () => {
    expect(stringifyTemplateValue(['a', 'b'])).toBe('["a","b"]');
  });

  test('should stringify plain objects as JSON', () => {
    expect(stringifyTemplateValue({ key: 'value' })).toBe('{"key":"value"}');
  });
});
