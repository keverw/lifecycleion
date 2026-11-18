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
  test('a body that fills its one block exactly is that block, not joined again', () => {
    // A limit of 6 makes the first block 6 bytes.
    const body = new BodyBytes(6);
    const bytes = appendAll(body, [
      counting(2),
      counting(3, 2),
      counting(1, 5),
    ]);

    expect([...bytes]).toEqual([0, 1, 2, 3, 4, 5]);
    expect(Object.getPrototypeOf(bytes)).toBe(Uint8Array.prototype);
    expect(bytes.buffer.byteLength).toBe(6);
    // Not joined again: the same buffer each time.
    expect(body.bytes()).toBe(bytes);
  });

  test('a body shorter than its block is kept in a buffer of its own size', () => {
    const bytes = appendAll(new BodyBytes(1000), [counting(3), counting(1, 3)]);

    expect([...bytes]).toEqual([0, 1, 2, 3]);
    expect(bytes.buffer.byteLength).toBe(4);
  });

  test('a body spanning several blocks, one chunk across them, is kept in order', () => {
    const chunks = [counting(10_000), counting(50_000, 10), counting(1, 7)];
    const total = 60_001;
    const bytes = appendAll(new BodyBytes(1_000_000), chunks);
    const expected = new Uint8Array(total);
    let offset = 0;

    for (const chunk of chunks) {
      expected.set(chunk, offset);
      offset += chunk.length;
    }

    expect(bytes.length).toBe(total);
    expect(bytes.buffer.byteLength).toBe(total);
    expect(Buffer.from(bytes).equals(Buffer.from(expected))).toBe(true);
  });

  test('a block is never larger than what the limit leaves', () => {
    // 20,000 bytes under a 20,000-byte limit: the second block takes the 3,616 left, not
    // the 32 KiB it would be.
    const bytes = appendAll(new BodyBytes(20_000), [counting(20_000)]);

    expect(bytes.length).toBe(20_000);
    expect(bytes[19_999]).toBe(19_999 % 256);
  });

  test('a chunk is copied as it is appended, so a reused buffer keeps each chunk as it was', () => {
    const body = new BodyBytes(100);
    const scratch = new Uint8Array(1);

    for (const byte of [1, 2, 3]) {
      scratch[0] = byte;
      body.append(scratch, 1);
    }

    expect([...body.bytes()]).toEqual([1, 2, 3]);
  });

  test('a view into a larger buffer, a Buffer, or a chunk from another realm is copied by its own bytes', () => {
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
