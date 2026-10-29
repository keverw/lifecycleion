import vm from 'node:vm';
import { describe, expect, spyOn, test } from 'bun:test';
import * as binaryView from './internal/binary-view';
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

  describe('arrays by index', () => {
    test('keeps holes as holes and the length as it was', () => {
      // eslint-disable-next-line no-sparse-arrays
      const original = [1, , 3, undefined];
      original.length = 6;
      const cloned = deepClone(original);

      expect(cloned).toHaveLength(6);
      expect(Object.keys(cloned)).toEqual(['0', '2', '3']);
      expect(1 in cloned).toBe(false);
      expect(3 in cloned).toBe(true);
      expect(cloned[2]).toBe(3);
    });

    test('keeps a hole that an index emptied while the clone was made', () => {
      const original: unknown[] = [];
      Object.defineProperty(original, 0, {
        enumerable: true,
        get: () => {
          Reflect.deleteProperty(original, 2);
          return 'a';
        },
      });
      original[1] = 'b';
      original[2] = 'c';

      const cloned = deepClone(original);

      expect(cloned).toHaveLength(3);
      expect(Object.keys(cloned)).toEqual(['0', '1']);
    });

    test('finds an item past a run of holes', () => {
      const original: unknown[] = [1, 2, 3];
      original[53] = { last: true };

      const cloned = deepClone(original);

      expect(cloned).toHaveLength(54);
      expect(Object.keys(cloned)).toEqual(['0', '1', '2', '53']);
      expect(cloned[53]).toEqual({ last: true });
      expect(cloned[53]).not.toBe(original[53]);
    });

    test("copies a match result's index, input, groups and indices", () => {
      const matched = /(?<x>b)/d.exec('ab') as RegExpExecArray;

      const cloned = deepClone(matched);

      expect([...cloned]).toEqual(['b', 'b']);
      expect(cloned.index).toBe(1);
      expect(cloned.input).toBe('ab');
      expect(cloned.groups).toEqual({ x: 'b' });
      expect(cloned.groups).not.toBe(matched.groups);
      expect(cloned.indices?.[0]).toEqual([1, 2]);
      expect(cloned.indices?.groups).toEqual({ x: [1, 2] });
    });

    test('copies the named entries arrayKeys lists, at any depth, and no others', () => {
      const inner = Object.assign([1], { meta: { id: 1 }, other: 'x' });
      const original = { list: Object.assign([inner], { meta: { id: 2 } }) };

      const cloned = deepClone(original, { arrayKeys: ['meta', 'missing'] });

      expect(cloned.list.meta).toEqual({ id: 2 });
      expect(cloned.list.meta).not.toBe(original.list.meta);
      expect(cloned.list[0]?.meta).toEqual({ id: 1 });
      expect(Object.keys(cloned.list[0] ?? {})).toEqual(['0', 'meta']);
      expect(Object.hasOwn(cloned.list, 'missing')).toBe(false);
      // Without the option, named entries are not copied.
      expect(Object.hasOwn(deepClone(original).list, 'meta')).toBe(false);
    });

    test('arrayKeys keeps circular references, and copies __proto__ as an entry', () => {
      const original = Object.assign([1], {}) as unknown[] & {
        self?: unknown;
      };
      original.self = original;
      Object.defineProperty(original, '__proto__', {
        value: { polluted: true },
        enumerable: true,
      });

      const cloned = deepClone(original, {
        arrayKeys: ['self', '__proto__', 'length', 'self'],
      });

      expect(cloned.self).toBe(cloned);
      expect(Object.getPrototypeOf(cloned)).toBe(Array.prototype);
      expect(Object.hasOwn(cloned, '__proto__')).toBe(true);
      expect(cloned).toHaveLength(1);
    });

    test('refuses options that are not an object', () => {
      for (const options of [null, 'meta', 5]) {
        expect(() =>
          deepClone([], options as unknown as { arrayKeys?: string[] }),
        ).toThrow(new TypeError('deepClone: options must be an object'));
      }
    });

    test('refuses an arrayKeys that is not an array of strings', () => {
      for (const arrayKeys of ['meta', [1], [Symbol('meta')], null]) {
        expect(() =>
          deepClone([], { arrayKeys: arrayKeys as unknown as string[] }),
        ).toThrow(
          new TypeError(
            'deepClone: options.arrayKeys must be an array of strings',
          ),
        );
      }
    });

    test('reads an array by its indices, not through an own iterator', () => {
      const original = [1, 2, 3];
      Object.defineProperty(original, Symbol.iterator, {
        value: function* () {
          yield 'x';
        },
      });

      expect([...deepClone(original).values()]).toEqual([1, 2, 3]);
    });
  });

  describe('errors', () => {
    test('keeps message, stack, cause and prototype', () => {
      const original = new Error('boom', { cause: { code: 1 } });
      const cloned = deepClone(original);

      expect(cloned).not.toBe(original);
      expect(cloned).toBeInstanceOf(Error);
      expect(cloned.message).toBe('boom');
      expect(cloned.stack).toBe(original.stack);
      expect(cloned.cause).toEqual({ code: 1 });
      expect(cloned.cause).not.toBe(original.cause);
      expect(Object.keys(cloned)).toEqual([]);
    });

    test("keeps a subclass's prototype and fields, and an AggregateError's errors", () => {
      class CodedError extends Error {
        public code = 'E_CODE';
        public override name = 'CodedError';
      }

      const coded = deepClone(new CodedError('bad'));
      const aggregate = deepClone(new AggregateError([new Error('a')], 'many'));

      expect(coded).toBeInstanceOf(CodedError);
      expect(coded.code).toBe('E_CODE');
      expect(coded.message).toBe('bad');
      expect(String(coded)).toBe('CodedError: bad');
      expect(aggregate.errors[0]).toBeInstanceOf(Error);
      expect((aggregate.errors[0] as Error).message).toBe('a');
    });

    test('a clone is a real error, a DOMException included, and clones again as one', () => {
      const error = new RangeError('far');
      const aborted = new DOMException('stopped', 'AbortError');

      const twice = deepClone(deepClone(error));
      const clonedAbort = deepClone(aborted);

      expect(Object.prototype.toString.call(twice)).toBe('[object Error]');
      expect(twice).toBeInstanceOf(RangeError);
      expect(twice.message).toBe('far');
      expect(clonedAbort).toBeInstanceOf(DOMException);
      expect(clonedAbort.name).toBe('AbortError');
      expect(clonedAbort.message).toBe('stopped');
      expect(clonedAbort.code).toBe(DOMException.ABORT_ERR);
      expect(String(clonedAbort)).toBe('AbortError: stopped');
    });

    test('copies over a base property the engine will not delete, rather than throwing', () => {
      const original = new Error('boom');
      const deleteProperty = Reflect.deleteProperty;
      // A base whose `stack` cannot be let go, as a hardened realm can leave one.
      const spy = spyOn(Reflect, 'deleteProperty').mockImplementation(
        (target, key) => {
          if (key === 'stack' && target !== original) {
            Object.defineProperty(target, 'stack', {
              value: 'base stack',
              writable: true,
              configurable: false,
            });
            return false;
          }

          return deleteProperty(target, key);
        },
      );

      let cloned: Error | undefined;
      try {
        cloned = deepClone(original);
      } finally {
        spy.mockRestore();
      }

      expect(cloned?.message).toBe('boom');
      expect(cloned?.stack).toBe(original.stack);
    });

    test('keeps a base property the engine will neither delete nor let be written', () => {
      const original = new Error('boom');
      const deleteProperty = Reflect.deleteProperty;
      const spy = spyOn(Reflect, 'deleteProperty').mockImplementation(
        (target, key) => {
          if (key === 'stack' && target !== original) {
            Object.defineProperty(target, 'stack', {
              value: 'base stack',
              writable: false,
              configurable: false,
            });
            return false;
          }

          return deleteProperty(target, key);
        },
      );

      let cloned: Error | undefined;
      try {
        cloned = deepClone(original);
      } finally {
        spy.mockRestore();
      }

      expect(cloned?.message).toBe('boom');
      expect(cloned?.stack).toBe('base stack');
    });

    test("a frozen error's clone is writable, as every clone is", () => {
      const original = Object.freeze(
        Object.assign(new Error('x'), { code: 'E1' }),
      );
      const cloned = deepClone(original);

      (cloned as { code: string }).code = 'E2';

      expect(cloned.code).toBe('E2');
      expect(original.code).toBe('E1');
    });

    test('keeps a circular cause, and clones an Error from another realm', async () => {
      const looped = new Error('loop') as Error & { cause?: unknown };
      looped.cause = looped;
      const { runInNewContext } = await import('node:vm');
      const foreign = runInNewContext('new TypeError("far")') as Error;

      const clonedLoop = deepClone(looped);
      const clonedForeign = deepClone(foreign);

      expect(clonedLoop.cause).toBe(clonedLoop);
      expect(clonedForeign.message).toBe('far');
      expect(clonedForeign.name).toBe('TypeError');
    });
  });

  describe('null-prototype objects', () => {
    test("keep their null prototype, a match result's groups included", () => {
      const dictionary = Object.assign(Object.create(null) as object, {
        a: 1,
      });
      const matched = /(?<a>a)/d.exec('a') as RegExpExecArray;

      const cloned = deepClone({ dictionary, matched });

      expect(Object.getPrototypeOf(cloned.dictionary)).toBeNull();
      expect(cloned.dictionary).toEqual(dictionary);
      expect(Object.getPrototypeOf(cloned.matched.groups)).toBeNull();
      expect('valueOf' in (cloned.matched.groups ?? {})).toBe(false);
      expect(Object.getPrototypeOf(cloned.matched.indices?.groups)).toBeNull();
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

    test('a value reached twice is cloned once, for buffers, views, dates and regexes', () => {
      const raw = new ArrayBuffer(4);
      const bytes = new Uint8Array([1, 2]);
      const view = new DataView(new ArrayBuffer(2));
      const when = new Date(0);
      const pattern = /a/g;
      const cloned = deepClone({
        raw: [raw, raw],
        bytes: [bytes, bytes],
        view: [view, view],
        when: [when, when],
        pattern: [pattern, pattern],
      });

      for (const [first, second] of Object.values(cloned)) {
        expect(first).toBe(second);
      }
      expect(cloned.raw[0]).not.toBe(raw);
      expect(cloned.bytes[0]).not.toBe(bytes);
    });

    test('a Buffer is copied as a Buffer, its memory its own', () => {
      const original = Buffer.from('hello');
      const cloned = deepClone(original);

      expect(Buffer.isBuffer(cloned)).toBe(true);
      expect(cloned.toString()).toBe('hello');
      cloned[0] = 0;
      expect(original.toString()).toBe('hello');
    });

    test('a strict Proxy that throws on unknown keys still clones', () => {
      const strict = new Proxy(
        { a: 1 },
        {
          get(target, key) {
            if (!(key in target)) {
              throw new Error(`unknown key ${String(key)}`);
            }
            return Reflect.get(target, key) as unknown;
          },
        },
      );

      expect(deepClone({ strict })).toEqual({ strict: { a: 1 } });
    });

    test('a detached ArrayBuffer throws rather than cloning to {}', () => {
      const original = new ArrayBuffer(4);
      structuredClone(original, { transfer: [original] });

      expect(() => deepClone(original)).toThrow();
    });
  });

  describe('binary values', () => {
    test('a view copies only the bytes it covers, not the buffer behind it', () => {
      const large = new ArrayBuffer(1024);
      new Uint8Array(large).set([1, 2, 3, 4], 100);
      const cloned = deepClone({
        bytes: new Uint8Array(large, 101, 2),
        view: new DataView(large, 100, 4),
      });

      expect(cloned.bytes.buffer.byteLength).toBe(2);
      expect([...cloned.bytes]).toEqual([2, 3]);
      expect(cloned.view.buffer.byteLength).toBe(4);
      expect(cloned.view.getUint8(3)).toBe(4);
    });

    test("buffers and views from another realm are cloned as this realm's", () => {
      const foreign = vm.runInNewContext(`({
        raw: new Uint8Array([1, 2, 3]).buffer,
        view: new DataView(new Uint8Array([4, 5, 6, 7]).buffer, 1, 2),
        bytes: new Uint16Array([8, 9]),
      })`) as { raw: ArrayBuffer; view: DataView; bytes: Uint16Array };
      const cloned = deepClone(foreign);

      expect(cloned.raw).toBeInstanceOf(ArrayBuffer);
      expect([...new Uint8Array(cloned.raw)]).toEqual([1, 2, 3]);
      expect(cloned.view).toBeInstanceOf(DataView);
      expect(cloned.view.getUint8(0)).toBe(5);
      expect(cloned.view.byteLength).toBe(2);
      expect(cloned.bytes).toBeInstanceOf(Uint16Array);
      expect([...cloned.bytes]).toEqual([8, 9]);
    });

    test('a SharedArrayBuffer, and a view over one, are copied into new shared buffers', () => {
      const shared = new SharedArrayBuffer(2);
      new Uint8Array(shared).set([1, 2]);
      const cloned = deepClone({ shared, bytes: new Uint8Array(shared) });

      expect(cloned.shared).toBeInstanceOf(SharedArrayBuffer);
      expect([...new Uint8Array(cloned.shared)]).toEqual([1, 2]);
      expect(cloned.bytes.buffer).toBeInstanceOf(SharedArrayBuffer);
      expect([...cloned.bytes]).toEqual([1, 2]);
      // Copies: writing to one does not reach the original.
      new Uint8Array(cloned.shared)[0] = 9;
      expect(new Uint8Array(shared)[0]).toBe(1);
    });

    test('subclasses are copied through their own constructor, their fields set up', () => {
      class TaggedBuffer extends ArrayBuffer {}
      class Packet extends Uint8Array {
        readonly #kind = 1;
        public get kind(): number {
          return this.#kind;
        }
      }
      const original = {
        buffer: new TaggedBuffer(2),
        packet: new Packet([1, 2]),
        node: Buffer.from('hi'),
      };
      const cloned = deepClone(original);

      expect(cloned.buffer).toBeInstanceOf(TaggedBuffer);
      expect(cloned.packet).toBeInstanceOf(Packet);
      expect(cloned.packet.kind).toBe(1);
      expect([...cloned.packet]).toEqual([1, 2]);
      expect(Buffer.isBuffer(cloned.node)).toBe(true);
      expect(cloned.node.toString()).toBe('hi');
      expect(cloned.packet).not.toBe(original.packet);
    });

    test('a resizable buffer stays resizable', () => {
      const resizable = new (
        ArrayBuffer as unknown as new (
          length: number,
          options: { maxByteLength: number },
        ) => ArrayBuffer & { resizable: boolean; maxByteLength: number }
      )(4, {
        maxByteLength: 16,
      });
      const cloned = deepClone(resizable);

      expect(cloned.resizable).toBe(true);
      expect(cloned.maxByteLength).toBe(16);
      expect(cloned.byteLength).toBe(4);
    });

    test('a detached buffer throws rather than cloning to {}', () => {
      const detached = new ArrayBuffer(4);
      structuredClone(detached, { transfer: [detached] });

      expect(() => deepClone(detached)).toThrow(TypeError);
    });

    test('a strict Proxy, a null-prototype dictionary and a class instance clone as plain records', () => {
      const strict = new Proxy(
        { a: 1 },
        {
          get(target, key) {
            if (!(key in target)) {
              throw new Error(`unknown key ${String(key)}`);
            }
            return Reflect.get(target, key) as unknown;
          },
        },
      );
      const dictionary = Object.assign(Object.create(null) as object, {
        b: 2,
      });
      class Point {
        public x = 3;
      }

      expect(deepClone({ strict, dictionary, point: new Point() })).toEqual({
        strict: { a: 1 },
        dictionary: { b: 2 },
        point: { x: 3 },
      });
    });

    test("another realm's plain objects are passed over without the throwing slot check", () => {
      const foreign = vm.runInNewContext(
        '({ a: { b: 1 }, raw: new ArrayBuffer(2) })',
      ) as { a: { b: number }; raw: ArrayBuffer };
      const spy = spyOn(binaryView, 'arrayBufferKindOf');

      try {
        const cloned = deepClone(foreign);
        expect(cloned.a).toEqual({ b: 1 });
        expect(cloned.raw).toBeInstanceOf(ArrayBuffer);
        // Asked of the buffer alone, not of the plain objects around it.
        expect(spy).toHaveBeenCalledTimes(1);
      } finally {
        spy.mockRestore();
      }
    });

    test('a strict Proxy from another realm clones without its traps being tripped', () => {
      const strict = vm.runInNewContext(
        "new Proxy({ a: 1 }, { get(t, k) { if (!(k in t)) throw new Error('strict'); return t[k]; } })",
      ) as { a: number };

      expect(deepClone({ strict })).toEqual({ strict: { a: 1 } });
    });

    test('an object that only inherits a buffer prototype clones as a plain object', () => {
      const fake = Object.assign(
        Object.create(SharedArrayBuffer.prototype) as object,
        { x: 1 },
      );

      expect(deepClone({ fake })).toEqual({ fake: { x: 1 } });
    });

    test("a Buffer stays a Buffer where the typed-array globals are another realm's", () => {
      const original = globalThis.Uint8Array;
      (globalThis as Record<string, unknown>).Uint8Array =
        vm.runInNewContext('Uint8Array');

      try {
        const cloned = deepClone(Buffer.from('hi'));
        expect(Buffer.isBuffer(cloned)).toBe(true);
        expect(cloned.toString('hex')).toBe('6869');
      } finally {
        (globalThis as Record<string, unknown>).Uint8Array = original;
      }
    });

    test('a view over a resizable buffer is copied onto a fixed-length one', () => {
      const resizable = new (
        ArrayBuffer as unknown as new (
          length: number,
          options: { maxByteLength: number },
        ) => ArrayBuffer
      )(4, { maxByteLength: 16 });
      const cloned = deepClone(new Uint8Array(resizable));

      expect(
        (cloned.buffer as ArrayBuffer & { resizable: boolean }).resizable,
      ).toBe(false);
      expect(cloned.length).toBe(4);
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
