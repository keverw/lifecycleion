import { describe, expect, test } from 'bun:test';
import { concatChunks } from './concat-chunks';

describe('concatChunks', () => {
  test('PR review round 66: a lone chunk spanning a resizable buffer is copied into a fixed-length one', () => {
    const buffer = new ArrayBuffer(3, { maxByteLength: 8 });
    const chunk = new Uint8Array(buffer);
    chunk.set([1, 2, 3]);

    const result = concatChunks([chunk], 3);

    expect(result).not.toBe(chunk);
    expect((result.buffer as { resizable?: boolean }).resizable).toBe(false);
    expect([...result]).toEqual([1, 2, 3]);
  });

  test('PR review round 66: a lone chunk spanning a shared buffer is copied into one of its own', () => {
    const chunk = new Uint8Array(new SharedArrayBuffer(3));
    chunk.set([1, 2, 3]);

    const result = concatChunks([chunk], 3);

    expect(result).not.toBe(chunk);
    expect(Object.prototype.toString.call(result.buffer)).toBe(
      '[object ArrayBuffer]',
    );
    expect([...result]).toEqual([1, 2, 3]);
  });

  test('PR review round 66: chunks are placed by the bytes they hold, not the byteLength they report', () => {
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
});
