import { describe, expect, test } from 'bun:test';

import { REDACTED_PLACEHOLDER } from './default-redact-function';
import { maskValueDeep } from './mask-value-deep';
import { createRenderBudget, type RenderBudget } from './render-budget';

// The budget is what keeps a mask from costing more than the render it stands in for, and
// it was enforced on one of the two container branches. What follows covers the stop
// itself, since a walk that does not take it produces its output before anything can.

const maskLeaf = (_key: string, text: string): string =>
  '*'.repeat(text.length);

describe('maskValueDeep budget', () => {
  test('replaces a matched leaf opaquely when rendering it truncates', () => {
    const budget = createRenderBudget(10);
    const masked = maskValueDeep(
      'password',
      'A'.repeat(100),
      (_key, text) => `${text.slice(0, 5)}*****`,
      undefined,
      undefined,
      undefined,
      budget,
    );

    expect(masked).toBe(REDACTED_PLACEHOLDER);
    expect(budget.truncations).toBe(1);
  });

  test('a leaf reached with the budget spent is not rendered at all', () => {
    // The non-container path returns *above* the guard at the top of the walk, so a leaf
    // whose budget was already gone still ran its own `toString` and charged a budget
    // already negative. `stringifyTemplateValue` caps one value at `MAX_RENDER_LENGTH`, so
    // a hostile `toString` on a named, fully-masked leaf bought a megabyte of work and
    // output past the bound every other surface honours - the same escape
    // `normalizeMaskChar` closed for a long `maskChar`.
    let didRender = false;

    // A class instance, not a plain object: only a non-container reaches the leaf path this
    // is about, and `{ toString }` would be walked as structure instead.
    class Hostile {
      public toString(): string {
        didRender = true;

        return 'x'.repeat(1_000_000);
      }
    }

    const hostile = new Hostile();

    const spent: RenderBudget = createRenderBudget();

    spent.remaining = 0;

    const masked = maskValueDeep(
      'secret',
      hostile,
      maskLeaf,
      undefined,
      undefined,
      undefined,
      spent,
    );

    // The answer the container branch and the array tail already give for a spent budget.
    expect(masked).toBe(REDACTED_PLACEHOLDER);
    expect(didRender).toBe(false);
  });

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

describe('maskValueDeep named array properties', () => {
  test('carries an array’s named own properties through the mask', () => {
    // The array branch rebuilds by index, so a named property was dropped from the result
    // - and a rebuilt array is what the caller receives, so `note` was simply gone from a
    // payload that redacting one element was meant to leave otherwise intact.
    const items = ['s1', 's2'] as unknown[] & { note?: string };
    items.note = 'request-42';

    const masked = maskValueDeep('items', items, maskLeaf) as unknown[] & {
      note?: string;
    };

    expect(masked).toHaveLength(2);
    expect(masked[0]).toBe('**');
    expect(masked.note).toBe('**********');
  });

  test('masks a named property that holds a container', () => {
    const items = ['s1'] as unknown[] & { meta?: unknown };
    items.meta = { token: 'abcd' };

    const masked = maskValueDeep('items', items, maskLeaf) as unknown[] & {
      meta?: Record<string, unknown>;
    };

    expect(masked.meta).toEqual({ token: '****' });
  });

  test('does not mark truncation when the last element exactly spends the budget', () => {
    const budget = createRenderBudget(6);
    const masked = maskValueDeep(
      'items',
      ['a', 'b', 'c'],
      maskLeaf,
      undefined,
      undefined,
      undefined,
      budget,
    );

    expect(masked).toEqual(['*', '*', '*']);
    expect(budget.remaining).toBe(0);
    expect(budget.truncations).toBe(0);
  });

  test('marks named properties omitted after the last element spends the budget', () => {
    const items = ['a', 'b', 'c'] as unknown[] & { note?: string };
    items.note = 'request-42';
    const budget = createRenderBudget(6);

    const masked = maskValueDeep(
      'items',
      items,
      maskLeaf,
      undefined,
      undefined,
      undefined,
      budget,
    ) as unknown[] & { note?: string };

    expect(masked).toEqual(['*', '*', '*', REDACTED_PLACEHOLDER]);
    expect(masked.note).toBeUndefined();
    expect(budget.truncations).toBe(1);
  });

  test('marks a named-property tail separately from a truncated child', () => {
    const items = [{ nested: 'x'.repeat(400) }] as unknown[] & {
      foo?: string;
    };
    items.foo = 'secret';
    const budget = createRenderBudget(60);

    const masked = maskValueDeep(
      'items',
      items,
      maskLeaf,
      undefined,
      undefined,
      undefined,
      budget,
    ) as unknown[] & { foo?: string };

    expect(masked).toEqual([
      { nested: REDACTED_PLACEHOLDER },
      REDACTED_PLACEHOLDER,
    ]);
    expect(masked.foo).toBeUndefined();
    expect(budget.truncations).toBe(2);
  });

  test('marks the unknown array tail at the entry-budget boundary', () => {
    let enumerations = 0;
    const target = ['', '', ''] as unknown[] & { note?: string };
    target.note = 'request-42';
    const items = new Proxy(target, {
      ownKeys: (target) => {
        enumerations++;

        return Reflect.ownKeys(target);
      },
    });
    const budget = createRenderBudget(items.length);

    const masked = maskValueDeep(
      'items',
      items,
      maskLeaf,
      undefined,
      undefined,
      undefined,
      budget,
    );

    expect(enumerations).toBe(0);
    expect(masked).toEqual([
      '',
      '',
      REDACTED_PLACEHOLDER,
      REDACTED_PLACEHOLDER,
    ]);
    expect(budget.truncations).toBe(2);
  });

  test('marks the truncation rather than dropping named keys silently', () => {
    // Every other stopping point in both walks leaves a marker. A key that was never
    // enumerated cannot be named, so this one goes in as a trailing element.
    const items = [] as unknown as unknown[] & Record<string, unknown>;

    for (let index = 0; index < 200_000; index++) {
      items.push(`element-${index}`);
    }

    items.note = 'request-42';

    const masked = maskValueDeep('items', items, maskLeaf) as unknown[] &
      Record<string, unknown>;

    expect(masked.length).toBeLessThan(200_000);
    expect(masked[masked.length - 1]).toBe(REDACTED_PLACEHOLDER);
    expect(Object.keys(masked)).not.toContain('note');
  });
});

describe('maskValueDeep - a replacement cut mid-character', () => {
  test('never leaves half a surrogate pair in a truncated mask', () => {
    // `chargeReplacementExcess` cut a longer-than-the-leaf replacement with a raw `slice`,
    // so a `redactFunction` returning emoji had its mask cut mid-pair and the malformed
    // string went on to `redactedParams` and every structured sink behind it.
    const budget = createRenderBudget(16);
    const masked = maskValueDeep(
      'p',
      'x',
      () => `a${'😀'.repeat(50)}`,
      new WeakSet(),
      undefined,
      0,
      budget,
    );

    // A lone surrogate, which is what a cut between the halves of a pair leaves behind.
    // `isWellFormed` would say it, but it is ES2024 and this project targets ES2022.
    expect(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
        String(masked),
      ),
    ).toBe(false);
  });
});
