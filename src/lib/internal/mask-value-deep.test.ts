import { describe, expect, test } from 'bun:test';

import { REDACTED_PLACEHOLDER } from './default-redact-function';
import { maskValueDeep } from './mask-value-deep';

// The budget is what keeps a mask from costing more than the render it stands in for, and
// it was enforced on one of the two container branches. What follows covers the stop
// itself, since a walk that does not take it produces its output before anything can.

const maskLeaf = (_key: string, text: string): string =>
  '*'.repeat(text.length);

describe('maskValueDeep budget', () => {
  test('stops a named container at the budget, as it stops an array', () => {
    // The array branch broke on an exhausted budget and the object branch did not, and a
    // *leaf* does not reach the guard at the top of the walk at all - the non-container
    // path returns above it - so every remaining key was rendered and masked in full. A
    // million-key object cost 969 ms and some sixty megabytes of mask text against the
    // fifteen thousand elements the equivalent array stopped at.
    const wide: Record<string, string> = {};

    for (let index = 0; index < 200_000; index++) {
      wide[`k${index}`] = `value-${index}`;
    }

    const masked = maskValueDeep('data', wide, maskLeaf) as Record<
      string,
      unknown
    >;

    const keys = Object.keys(masked);

    expect(keys.length).toBeGreaterThan(0);
    expect(keys.length).toBeLessThan(200_000);

    // One placeholder stands for the tail, exactly as the array branch marks its own.
    expect(masked[keys[keys.length - 1]]).toBe(REDACTED_PLACEHOLDER);
  });

  test('the tail marker survives a budget that runs out on `__proto__`', () => {
    // Written with `defineEntry` like every other entry in the loop: a plain assignment to
    // `__proto__` is a no-op for a string, so the marker would be dropped and the
    // truncation would be invisible rather than merely lossy.
    const wide: Record<string, string> = {};

    for (let index = 0; index < 200_000; index++) {
      wide[`k${index}`] = `value-${index}`;
      wide['__proto__'] = 'a string, not a prototype';
    }

    const masked = maskValueDeep('data', wide, maskLeaf) as Record<
      string,
      unknown
    >;

    expect(Object.getPrototypeOf(masked)).toBe(Object.prototype);
  });

  test('masks a small object in full', () => {
    expect(
      maskValueDeep('data', { a: 'abc', b: { c: 'de' } }, maskLeaf),
    ).toEqual({
      a: '***',
      b: { c: '**' },
    });
  });
});
