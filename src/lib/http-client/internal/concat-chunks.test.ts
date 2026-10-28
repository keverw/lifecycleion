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

  test('a lone plain chunk spanning a plain buffer is the result as it is', () => {
    const chunk = new Uint8Array([1, 2, 3]);

    expect(concatChunks([chunk], 3)).toBe(chunk);
  });

  test('a lone chunk is judged by its internal slots, not its own properties', () => {
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

  test('a lone empty chunk over a detached buffer is the result as it is', () => {
    const buffer = new ArrayBuffer(0);
    const chunk = new Uint8Array(buffer);
    structuredClone(buffer, { transfer: [buffer] });

    expect(concatChunks([chunk], 0)).toBe(chunk);
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

  test('a chunk whose buffer was detached after it was counted fails as a TypeError', () => {
    const buffer = new ArrayBuffer(3);
    const chunk = new Uint8Array(buffer);
    structuredClone(buffer, { transfer: [buffer] });

    expect(() => concatChunks([chunk], 3)).toThrow(TypeError);
    expect(() => concatChunks([new Uint8Array([1]), chunk], 4)).toThrow(
      TypeError,
    );
  });
});
