import { describe, expect, test } from 'bun:test';
import { deepClone } from './deep-clone';

describe('deepClone', () => {
  describe('primitives and null/undefined', () => {
    test('should return primitives as-is', () => {
      expect(deepClone(42)).toBe(42);
      expect(deepClone('hello')).toBe('hello');
      expect(deepClone(true)).toBe(true);
      expect(deepClone(false)).toBe(false);
      expect(deepClone(null)).toBe(null);
      expect(deepClone(undefined)).toBe(undefined);
    });
  });

  describe('arrays', () => {
    test('should deep clone simple arrays', () => {
      const original = [1, 2, 3];
      const cloned = deepClone(original);

      expect(cloned).toEqual(original);
      expect(cloned).not.toBe(original);
    });

    test('should deep clone nested arrays', () => {
      const original = [1, [2, [3, 4]], 5];
      const cloned = deepClone(original);

      expect(cloned).toEqual(original);
      expect(cloned).not.toBe(original);
      expect(cloned[1]).not.toBe(original[1]);
      expect((cloned[1] as number[])[1]).not.toBe((original[1] as number[])[1]);
    });

    test('should handle arrays with mixed types', () => {
      const original = [1, 'two', { three: 3 }, [4, 5], null, undefined];
      const cloned = deepClone(original);

      expect(cloned).toEqual(original);
      expect(cloned).not.toBe(original);
      expect(cloned[2]).not.toBe(original[2]);
      expect(cloned[3]).not.toBe(original[3]);
    });
  });

  describe('objects', () => {
    test('should deep clone simple objects', () => {
      const original = { a: 1, b: 2, c: 3 };
      const cloned = deepClone(original);

      expect(cloned).toEqual(original);
      expect(cloned).not.toBe(original);
    });

    test('should deep clone nested objects', () => {
      const original = {
        a: 1,
        b: {
          c: 2,
          d: {
            e: 3,
          },
        },
      };
      const cloned = deepClone(original);

      expect(cloned).toEqual(original);
      expect(cloned).not.toBe(original);
      expect(cloned.b).not.toBe(original.b);
      expect(cloned.b.d).not.toBe(original.b.d);
    });

    test('should handle objects with array values', () => {
      const original = {
        numbers: [1, 2, 3],
        nested: {
          moreNumbers: [4, 5, 6],
        },
      };
      const cloned = deepClone(original);

      expect(cloned).toEqual(original);
      expect(cloned).not.toBe(original);
      expect(cloned.numbers).not.toBe(original.numbers);
      expect(cloned.nested.moreNumbers).not.toBe(original.nested.moreNumbers);
    });
  });

  describe('Date objects', () => {
    test('should clone Date objects', () => {
      const original = new Date('2024-01-01T00:00:00Z');
      const cloned = deepClone(original);

      expect(cloned).toEqual(original);
      expect(cloned).not.toBe(original);
      expect(cloned.getTime()).toBe(original.getTime());
    });

    test('should clone Date objects in nested structures', () => {
      const original = {
        timestamp: new Date('2024-01-01T00:00:00Z'),
        nested: {
          anotherDate: new Date('2025-01-01T00:00:00Z'),
        },
      };
      const cloned = deepClone(original);

      expect(cloned.timestamp).toEqual(original.timestamp);
      expect(cloned.timestamp).not.toBe(original.timestamp);
      expect(cloned.nested.anotherDate).not.toBe(original.nested.anotherDate);
    });
  });

  describe('RegExp objects', () => {
    test('should clone RegExp objects', () => {
      const original = /test/gi;
      const cloned = deepClone(original);

      expect(cloned).toEqual(original);
      expect(cloned).not.toBe(original);
      expect(cloned.source).toBe(original.source);
      expect(cloned.flags).toBe(original.flags);
    });

    test('should preserve lastIndex on RegExp', () => {
      const original = /test/g;
      original.lastIndex = 5;
      const cloned = deepClone(original);

      expect(cloned.lastIndex).toBe(5);
    });

    test('should clone RegExp in nested structures', () => {
      const original = {
        pattern: /test/i,
        nested: {
          anotherPattern: /[a-z]+/g,
        },
      };
      const cloned = deepClone(original);

      expect(cloned.pattern).toEqual(original.pattern);
      expect(cloned.pattern).not.toBe(original.pattern);
      expect(cloned.nested.anotherPattern).not.toBe(
        original.nested.anotherPattern,
      );
    });
  });

  describe('Map objects', () => {
    test('should clone Map objects', () => {
      const original = new Map([
        ['key1', 'value1'],
        ['key2', 'value2'],
      ]);
      const cloned = deepClone(original);

      expect(cloned).toEqual(original);
      expect(cloned).not.toBe(original);
      expect(cloned.get('key1')).toBe('value1');
    });

    test('should deep clone Map values', () => {
      const original = new Map([
        ['key1', { nested: 'value1' }],
        ['key2', { nested: 'value2' }],
      ]);
      const cloned = deepClone(original);

      expect(cloned).toEqual(original);
      expect(cloned).not.toBe(original);
      expect(cloned.get('key1')).toEqual(original.get('key1'));
      expect(cloned.get('key1')).not.toBe(original.get('key1'));
    });

    test('should deep clone Map keys', () => {
      const key1 = { id: 1 };
      const key2 = { id: 2 };
      const original = new Map([
        [key1, 'value1'],
        [key2, 'value2'],
      ]);
      const cloned = deepClone(original);

      // Keys should be cloned
      const clonedKeys = Array.from(cloned.keys());
      expect(clonedKeys[0]).not.toBe(key1);
      expect(clonedKeys[1]).not.toBe(key2);
      expect(clonedKeys[0]).toEqual(key1);
      expect(clonedKeys[1]).toEqual(key2);
    });
  });

  describe('Set objects', () => {
    test('should clone Set objects', () => {
      const original = new Set([1, 2, 3]);
      const cloned = deepClone(original);

      expect(cloned).toEqual(original);
      expect(cloned).not.toBe(original);
      expect(cloned.has(1)).toBe(true);
      expect(cloned.has(2)).toBe(true);
      expect(cloned.has(3)).toBe(true);
    });

    test('should deep clone Set values', () => {
      const original = new Set([{ a: 1 }, { b: 2 }]);
      const cloned = deepClone(original);

      expect(cloned).not.toBe(original);
      const clonedValues = Array.from(cloned);
      const originalValues = Array.from(original);

      expect(clonedValues[0]).toEqual(originalValues[0]);
      expect(clonedValues[0]).not.toBe(originalValues[0]);
    });
  });

  describe('typed arrays', () => {
    test('should clone Int8Array', () => {
      const original = new Int8Array([1, 2, 3]);
      const cloned = deepClone(original);

      expect(cloned).toEqual(original);
      expect(cloned).not.toBe(original);
      expect(cloned[0]).toBe(1);
    });

    test('should clone Uint8Array', () => {
      const original = new Uint8Array([1, 2, 3]);
      const cloned = deepClone(original);

      expect(cloned).toEqual(original);
      expect(cloned).not.toBe(original);
    });

    test('should clone Float32Array', () => {
      const original = new Float32Array([1.5, 2.5, 3.5]);
      const cloned = deepClone(original);

      expect(cloned).toEqual(original);
      expect(cloned).not.toBe(original);
    });
  });

  describe('circular references', () => {
    test('should handle circular object references', () => {
      interface CircularObj {
        a: number;
        self?: CircularObj;
      }

      const original: CircularObj = { a: 1 };
      original.self = original;

      const cloned = deepClone(original);

      expect(cloned.a).toBe(1);
      expect(cloned.self).toBe(cloned);
      expect(cloned).not.toBe(original);
    });

    test('should handle circular array references', () => {
      type CircularArray = (number | CircularArray)[];
      const original: CircularArray = [1, 2, 3];
      original.push(original);

      const cloned = deepClone(original);

      expect(cloned[0]).toBe(1);
      expect(cloned[3]).toBe(cloned);
      expect(cloned).not.toBe(original);
    });

    test('should handle complex circular references', () => {
      interface ComplexCircular {
        a: number;
        b: {
          c: number;
          parent?: ComplexCircular;
        };
      }

      const original: ComplexCircular = {
        a: 1,
        b: { c: 2 },
      };
      original.b.parent = original;

      const cloned = deepClone(original);

      expect(cloned.a).toBe(1);
      expect(cloned.b.c).toBe(2);
      expect(cloned.b.parent).toBe(cloned);
      expect(cloned).not.toBe(original);
      expect(cloned.b).not.toBe(original.b);
    });
  });

  describe('complex nested structures', () => {
    test('should handle deeply nested mixed structures', () => {
      const original = {
        string: 'hello',
        number: 42,
        boolean: true,
        null: null,
        undefined: undefined,
        date: new Date('2024-01-01'),
        regex: /test/gi,
        array: [1, 2, { nested: 'value' }],
        map: new Map([['key', { value: 'data' }]]),
        set: new Set([1, 2, 3]),
        nested: {
          level2: {
            level3: {
              deep: 'value',
              array: [1, 2, 3],
            },
          },
        },
      };

      const cloned = deepClone(original);

      // Check top level
      expect(cloned).toEqual(original);
      expect(cloned).not.toBe(original);

      // Check various types
      expect(cloned.date).not.toBe(original.date);
      expect(cloned.regex).not.toBe(original.regex);
      expect(cloned.array).not.toBe(original.array);
      expect(cloned.array[2]).not.toBe(original.array[2]);
      expect(cloned.map).not.toBe(original.map);
      expect(cloned.set).not.toBe(original.set);

      // Check deep nesting
      expect(cloned.nested).not.toBe(original.nested);
      expect(cloned.nested.level2).not.toBe(original.nested.level2);
      expect(cloned.nested.level2.level3).not.toBe(
        original.nested.level2.level3,
      );
      expect(cloned.nested.level2.level3.array).not.toBe(
        original.nested.level2.level3.array,
      );
    });
  });

  describe('edge cases', () => {
    test('should handle empty objects and arrays', () => {
      expect(deepClone({})).toEqual({});
      expect(deepClone([])).toEqual([]);
      expect(deepClone(new Map())).toEqual(new Map());
      expect(deepClone(new Set())).toEqual(new Set());
    });

    test('should handle objects with symbol keys', () => {
      const sym = Symbol('test');
      const original = { [sym]: 'value', regular: 'key' };
      const cloned = deepClone(original);

      // Symbol keys are not enumerable by for...in
      // so they won't be cloned by our implementation
      expect(cloned.regular).toBe('key');
      expect(cloned[sym]).toBeUndefined();
    });
  });
});
