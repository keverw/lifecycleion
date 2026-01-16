import { describe, expect, it } from 'bun:test';
import { formatJSON } from './json-helpers';

describe('formatJSON', () => {
  it('should format a simple object without human formatting', () => {
    const obj = { name: 'John', age: 30 };
    const result = formatJSON(obj);
    expect(result).toBe('{"name":"John","age":30}');
  });

  it('should format a simple object with human formatting', () => {
    const obj = { name: 'John', age: 30 };
    const result = formatJSON(obj, true);
    expect(result).toBe('{\n  "name": "John",\n  "age": 30\n}\n');
  });

  it('should format an array without human formatting', () => {
    const arr = [1, 2, 3];
    const result = formatJSON(arr);
    expect(result).toBe('[1,2,3]');
  });

  it('should format an array with human formatting', () => {
    const arr = [1, 2, 3];
    const result = formatJSON(arr, true);
    expect(result).toBe('[\n  1,\n  2,\n  3\n]\n');
  });

  it('should format a string without human formatting', () => {
    const str = 'hello world';
    const result = formatJSON(str);
    expect(result).toBe('"hello world"');
  });

  it('should format a string with human formatting', () => {
    const str = 'hello world';
    const result = formatJSON(str, true);
    expect(result).toBe('"hello world"\n');
  });

  it('should format a number', () => {
    const num = 42;
    expect(formatJSON(num)).toBe('42');
    expect(formatJSON(num, true)).toBe('42\n');
  });

  it('should format null', () => {
    expect(formatJSON(null)).toBe('null');
    expect(formatJSON(null, true)).toBe('null\n');
  });

  it('should format boolean values', () => {
    expect(formatJSON(true)).toBe('true');
    expect(formatJSON(false, true)).toBe('false\n');
  });

  it('should format nested objects with human formatting', () => {
    const obj = {
      user: {
        name: 'John',
        address: {
          city: 'NYC',
        },
      },
    };
    const result = formatJSON(obj, true);
    expect(result).toContain('"user"');
    expect(result).toContain('"name"');
    expect(result).toContain('"address"');
    expect(result).toContain('"city"');
    expect(result).toContain('  '); // Should have indentation
  });
});
