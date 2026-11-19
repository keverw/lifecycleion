import { describe, expect, test } from 'bun:test';
import { runInNewContext } from 'node:vm';
import {
  fixedUnsharedByteLength,
  hasBufferTagInChain,
  hasOwnToStringTagInChain,
  isResizableBuffer,
  readViewBuffer,
} from './binary-view';

describe('prototype chain reads', () => {
  test('a chain that never ends is read 64 prototypes deep and answers no', () => {
    let steps = 0;
    const endless = (): object =>
      new Proxy(
        {},
        {
          getPrototypeOf: () => {
            if (++steps > 10_000) {
              throw new Error('walked on');
            }
            return endless();
          },
        },
      );

    for (const read of [
      hasBufferTagInChain,
      (value: object) => hasOwnToStringTagInChain(value, 'AbortSignal'),
    ]) {
      steps = 0;
      expect(read(endless())).toBe(false);
      expect(steps).toBe(64);
    }
  });

  test('bytes are still told through a deep chain of subclasses', () => {
    let Buffered: typeof ArrayBuffer = ArrayBuffer;
    for (let depth = 0; depth < 20; depth++) {
      Buffered = class extends Buffered {};
    }

    expect(hasBufferTagInChain(new Buffered(1))).toBe(true);
    expect(hasBufferTagInChain(new ArrayBuffer(1))).toBe(true);
  });
});

describe('buffer reads', () => {
  test('isResizableBuffer tells a resizable or growable buffer, from any realm, from a fixed one', () => {
    const resizable = new ArrayBuffer(4, { maxByteLength: 8 });
    const growable = new (
      SharedArrayBuffer as unknown as new (
        length: number,
        options: { maxByteLength: number },
      ) => SharedArrayBuffer
    )(4, { maxByteLength: 8 });
    const foreign = runInNewContext(
      'new ArrayBuffer(4, { maxByteLength: 8 })',
    ) as ArrayBuffer;

    expect(isResizableBuffer(resizable)).toBe(true);
    expect(isResizableBuffer(growable)).toBe(true);
    expect(isResizableBuffer(foreign)).toBe(true);
    expect(isResizableBuffer(new ArrayBuffer(4))).toBe(false);
    expect(isResizableBuffer(new SharedArrayBuffer(4))).toBe(false);
    expect(isResizableBuffer(new Uint8Array(resizable))).toBe(false);
    expect(isResizableBuffer({ resizable: true })).toBe(false);
  });

  test('fixedUnsharedByteLength measures only a fixed, unshared ArrayBuffer, from any realm', () => {
    const foreign = runInNewContext('new ArrayBuffer(6)') as ArrayBuffer;

    expect(fixedUnsharedByteLength(new ArrayBuffer(4))).toBe(4);
    expect(fixedUnsharedByteLength(foreign)).toBe(6);
    expect(
      fixedUnsharedByteLength(new ArrayBuffer(4, { maxByteLength: 8 })),
    ).toBeNull();
    expect(fixedUnsharedByteLength(new SharedArrayBuffer(4))).toBeNull();
    expect(fixedUnsharedByteLength(new Uint8Array(4))).toBeNull();
    expect(fixedUnsharedByteLength({ byteLength: 4 })).toBeNull();
  });

  test('readViewBuffer reads the buffer of a typed array and of a DataView', () => {
    const buffer = new ArrayBuffer(8);

    expect(readViewBuffer(new Uint16Array(buffer, 2, 1))).toBe(buffer);
    expect(readViewBuffer(new DataView(buffer, 4))).toBe(buffer);
    expect(() => readViewBuffer({} as ArrayBufferView)).toThrow(TypeError);
  });
});
