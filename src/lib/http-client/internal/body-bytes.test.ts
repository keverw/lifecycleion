import { describe, expect, test } from 'bun:test';
import { runInNewContext } from 'node:vm';
import { BodyBytes } from './body-bytes';

/** `length` bytes counting up from `start`, wrapping at 256. */
function counting(length: number, start = 0): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => (start + index) % 256);
}

/** Appends each chunk as `readBodyWithin` does, measured by its own length. */
function appendAll(body: BodyBytes, chunks: Uint8Array[]): Uint8Array {
  for (const chunk of chunks) {
    body.append(chunk, chunk.length);
  }

  return body.bytes();
}

describe('BodyBytes', () => {
  test('a body of one small chunk is copied once, into a block its own size', () => {
    const chunk = counting(2048);
    const body = new BodyBytes(64 * 1024 * 1024);
    body.append(chunk, chunk.length);
    const bytes = body.bytes();

    expect(bytes).not.toBe(chunk);
    expect(Buffer.from(bytes).equals(Buffer.from(chunk))).toBe(true);
    expect(Object.getPrototypeOf(bytes)).toBe(Uint8Array.prototype);
    // The block itself, not a 16 KiB block joined again into one of 2,048 bytes.
    expect(bytes.buffer.byteLength).toBe(2048);
    expect(body.bytes()).toBe(bytes);
  });

  test('clear() lets go of every byte kept', () => {
    const body = new BodyBytes(100_000);
    body.append(counting(10), 10);
    body.append(counting(20_000), 20_000);
    body.clear();
    body.append(counting(3, 7), 3);

    expect([...body.bytes()]).toEqual([7, 8, 9]);
  });

  test('a body shorter than its block is kept in a buffer of its own size', () => {
    const bytes = appendAll(new BodyBytes(1000), [counting(3), counting(1, 3)]);

    expect([...bytes]).toEqual([0, 1, 2, 3]);
    expect(bytes.buffer.byteLength).toBe(4);
  });

  test('small chunks across blocks and large ones between them are kept in order', () => {
    // The second small chunk crosses the first 16 KiB block's end; the large one sits
    // between small ones copied into the same block.
    const chunks = [
      counting(10_000),
      counting(10_000, 16),
      counting(3, 1),
      counting(50_000, 10),
      counting(2, 9),
      counting(1, 7),
    ];
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const bytes = appendAll(new BodyBytes(1_000_000), chunks);

    expect(bytes.length).toBe(total);
    expect(bytes.buffer.byteLength).toBe(total);
    expect(Buffer.from(bytes).equals(Buffer.concat(chunks))).toBe(true);
  });

  test('a block is never larger than what the limit leaves', () => {
    // Under a 20,000-byte limit the second block takes the 3,616 bytes left, not 16 KiB.
    const bytes = appendAll(new BodyBytes(20_000), [
      counting(10_000),
      counting(10_000, 16),
    ]);

    expect(bytes.length).toBe(20_000);
    expect(bytes[19_999]).toBe((9_999 + 16) % 256);
  });

  test('a chunk under 4 KiB is copied as it is appended', () => {
    const body = new BodyBytes(100);
    const scratch = new Uint8Array(1);

    for (const byte of [1, 2, 3]) {
      scratch[0] = byte;
      body.append(scratch, 1);
    }

    expect([...body.bytes()]).toEqual([1, 2, 3]);
  });

  test('a lone chunk of 4 KiB or more spanning a plain buffer is the body as it is, not copied', () => {
    for (const length of [4096, 16_000, 20_000]) {
      const chunk = counting(length);
      const body = new BodyBytes(100_000);
      body.append(chunk, chunk.length);

      expect(body.bytes()).toBe(chunk);
    }
  });

  test('a chunk of 4 KiB or more is kept as it is, copied only by the join', () => {
    const kept = counting(15_000);
    const body = new BodyBytes(100_000);
    body.append(counting(10), 10);
    body.append(kept, kept.length);
    // Seen by the join: the chunk was kept, not copied as it was appended.
    kept[0] = 200;

    expect(body.bytes()[10]).toBe(200);
  });

  test('a large chunk over a SharedArrayBuffer is copied as it is appended, so a later write does not reach the join', () => {
    const shared = new Uint8Array(new SharedArrayBuffer(8 * 1024));
    shared.set(counting(8 * 1024));
    const body = new BodyBytes(100_000);
    body.append(shared, shared.length);
    // As another thread could write it after it was counted.
    shared[0] = 200;
    const bytes = body.bytes();

    expect(bytes[0]).toBe(0);
    expect(bytes.length).toBe(8 * 1024);
  });

  test('a large chunk that is copied goes into one block of its own size, not many small ones', () => {
    // A 4 MiB view over a 64 MiB buffer, too little of it to keep, after a few bytes.
    const read = new Uint8Array(64 * 1024 * 1024);
    read.set(counting(4 * 1024 * 1024));
    const piece = read.subarray(0, 4 * 1024 * 1024);
    const body = new BodyBytes(100 * 1024 * 1024);
    body.append(counting(100), 100);
    body.append(piece, piece.length);
    const bytes = body.bytes();
    const { parts } = body as unknown as { parts: Uint8Array[] };

    expect(parts.map((part) => part.length)).toEqual([100, 4 * 1024 * 1024]);
    expect(bytes.length).toBe(100 + 4 * 1024 * 1024);
    expect(bytes[100 + 300]).toBe(300 % 256);
  });

  test('a chunk past maxBytes throws a RangeError rather than looping for a block', () => {
    const body = new BodyBytes(4);
    body.append(counting(4), 4);

    expect(() => body.append(counting(1), 1)).toThrow(RangeError);
    expect([...body.bytes()]).toEqual([0, 1, 2, 3]);
  });

  test('a large view over less than half its buffer is copied, so the rest of it is not held', () => {
    // A piece of a socket's read buffer, as Node's HTTP parser hands a body over.
    const read = counting(64 * 1024);
    const piece = read.subarray(0, 16 * 1024);
    const body = new BodyBytes(100_000);
    body.append(piece, piece.length);
    read[0] = 200;
    const bytes = body.bytes();

    expect(bytes[0]).toBe(0);
    expect(bytes.length).toBe(16 * 1024);
    expect(bytes.buffer.byteLength).toBe(16 * 1024);
  });

  test('a view into a larger buffer, a Buffer, or a chunk from another realm is joined by its own bytes', () => {
    const backing = counting(40_000);
    const view = backing.subarray(5, 20_005);
    const foreign = runInNewContext('new Uint8Array([7, 8, 9])') as Uint8Array;
    const bytes = appendAll(new BodyBytes(100_000), [
      view,
      Buffer.from([4, 5]),
      foreign,
    ]);

    expect(bytes.length).toBe(20_005);
    expect(bytes[0]).toBe(5);
    expect(bytes[19_999]).toBe((19_999 + 5) % 256);
    expect([...bytes.subarray(20_000)]).toEqual([4, 5, 7, 8, 9]);
  });

  test('nothing appended is an empty body', () => {
    expect(new BodyBytes(100).bytes().length).toBe(0);
  });
});
