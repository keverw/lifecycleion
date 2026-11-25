import { describe, expect, test } from 'bun:test';
import { concatChunks } from './concat-chunks';

describe('concatChunks', () => {
  test('a lone chunk spanning a resizable buffer is copied into a fixed-length one', () => {
    const buffer = new ArrayBuffer(3, { maxByteLength: 8 });
    const chunk = new Uint8Array(buffer);
    chunk.set([1, 2, 3]);

    const result = concatChunks([chunk], 3);

    expect(result).not.toBe(chunk);
    expect((result.buffer as { resizable?: boolean }).resizable).toBe(false);
    expect([...result]).toEqual([1, 2, 3]);
  });

  test('a lone chunk spanning a shared buffer is copied into one of its own', () => {
    const chunk = new Uint8Array(new SharedArrayBuffer(3));
    chunk.set([1, 2, 3]);

    const result = concatChunks([chunk], 3);

    expect(result).not.toBe(chunk);
    expect(Object.prototype.toString.call(result.buffer)).toBe(
      '[object ArrayBuffer]',
    );
    expect([...result]).toEqual([1, 2, 3]);
  });

  test('chunks are placed by the bytes they hold, not the byteLength they report', () => {
    class Understated extends Uint8Array {
      public override get byteLength(): number {
        return 0;
      }
    }

    const result = concatChunks(
      [new Understated([1, 2]), new Uint8Array([3])],
      3,
    );

    expect([...result]).toEqual([1, 2, 3]);
  });

  test('a lone plain chunk spanning a plain buffer is copied, so a later write to it does not reach the result', () => {
    const chunk = new Uint8Array([1, 2, 3]);
    const result = concatChunks([chunk], 3);
    chunk.fill(0);

    expect(result.buffer).not.toBe(chunk.buffer);
    expect([...result]).toEqual([1, 2, 3]);
  });

  test('a lone chunk with properties of its own is copied into a view that carries none of them', () => {
    const chunk = new Uint8Array([1, 2, 3]);
    Object.defineProperties(chunk, {
      byteLength: { value: 0 },
      length: { value: 0 },
      extra: { value: 'kept', enumerable: true },
    });

    const result = concatChunks([chunk], 3);

    expect(result).not.toBe(chunk);
    expect(result.buffer).not.toBe(chunk.buffer);
    expect(result.byteLength).toBe(3);
    expect(result.length).toBe(3);
    expect(
      Reflect.ownKeys(result).filter(
        (key) => typeof key !== 'string' || !/^\d+$/.test(key),
      ),
    ).toEqual([]);
  });

  test('a chunk over a buffer with a byteLength of its own is copied by the bytes it holds', () => {
    const chunk = new Uint8Array([1, 2, 3]);
    Object.defineProperty(chunk.buffer, 'byteLength', { value: 0 });

    const result = concatChunks([chunk], 3);

    expect(result.buffer).not.toBe(chunk.buffer);
    expect(Object.hasOwn(result.buffer, 'byteLength')).toBe(false);
    expect([...result]).toEqual([1, 2, 3]);
  });

  test('a chunk is read through its internal slots, not its own properties', () => {
    // A view one byte into its buffer, claiming to start at 0 over a buffer of its own.
    const chunk = new Uint8Array([0, 1, 2, 3]).subarray(1);
    Object.defineProperties(chunk, {
      byteOffset: { value: 0 },
      buffer: { value: new ArrayBuffer(3) },
    });

    const result = concatChunks([chunk], 3);

    expect(result).not.toBe(chunk);
    expect([...result]).toEqual([1, 2, 3]);
  });

  test('an empty chunk over a detached buffer is an empty result', () => {
    const buffer = new ArrayBuffer(0);
    const chunk = new Uint8Array(buffer);
    structuredClone(buffer, { transfer: [buffer] });

    const result = concatChunks([chunk], 0);

    expect(result.byteLength).toBe(0);
    expect(result.buffer.byteLength).toBe(0);
  });

  test.each([
    ['grew', 5],
    ['shrank', 1],
  ])(
    'a chunk over a resizable buffer that %s after it was counted is refused',
    (_label, newLength) => {
      const buffer = new ArrayBuffer(3, { maxByteLength: 8 });
      const chunk = new Uint8Array(buffer);
      chunk.set([1, 2, 3]);
      buffer.resize(newLength);

      const message = 'Response body chunk changed length after it was read';

      expect(() => concatChunks([chunk, new Uint8Array([4])], 4)).toThrow(
        new TypeError(message),
      );
      expect(() => concatChunks([chunk], 3)).toThrow(new TypeError(message));
    },
  );

  test('a chunk whose buffer was detached after it was counted is refused as one that changed length', () => {
    const buffer = new ArrayBuffer(3);
    const chunk = new Uint8Array(buffer);
    structuredClone(buffer, { transfer: [buffer] });

    const refusal = new TypeError(
      'Response body chunk changed length after it was read',
    );

    expect(() => concatChunks([chunk], 3)).toThrow(refusal);
    expect(() => concatChunks([new Uint8Array([1]), chunk], 4)).toThrow(
      refusal,
    );
  });
});
