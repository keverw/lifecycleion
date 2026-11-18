import { describe, expect, test } from 'bun:test';
import { hasBufferTagInChain, hasOwnToStringTagInChain } from './binary-view';

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
