import { describe, expect, test } from 'bun:test';
import { redactValue, stringifyValue } from './stringify-value';
import { applyRedaction } from './logger/utils/redaction';

const SECRET = 'hunter2secret';

describe('stringifyValue - rendering', () => {
  test('renders a plain object and array as JSON', () => {
    expect(stringifyValue({ k: 'v' })).toBe('{"k":"v"}');
    expect(stringifyValue(['a', 'b'])).toBe('["a","b"]');
    // Distinguishable from one element containing a comma, which a bare join is not.
    expect(stringifyValue(['a,b'])).toBe('["a,b"]');
  });

  test('keeps a value that has a string form of its own', () => {
    expect(stringifyValue(new Error('boom'))).toBe('Error: boom');
    expect(stringifyValue(new URL('https://example.test/y'))).toBe(
      'https://example.test/y',
    );
  });

  test('names a class instance rather than dumping it', () => {
    class FooBar {
      public secret = SECRET;
    }

    expect(stringifyValue(new FooBar())).toBe('[FooBar]');
    expect(stringifyValue(new FooBar())).not.toContain(SECRET);
  });

  test('uses a class instance own toString when it defines one', () => {
    class Described {
      public toString(): string {
        return 'Described(ok)';
      }
    }

    expect(stringifyValue(new Described())).toBe('Described(ok)');
  });

  test('never throws on a value that resists rendering', () => {
    const cyclic: Record<string, unknown> = { a: 1 };

    cyclic['self'] = cyclic;

    expect(typeof stringifyValue(cyclic)).toBe('string');
    expect(typeof stringifyValue({ n: 10n })).toBe('string');
    expect(typeof stringifyValue(Symbol('s'))).toBe('string');
  });
});

describe('stringifyValue - redaction', () => {
  test('matches applyRedaction for the same paths', () => {
    // The point of consolidating: one masking, reachable two ways.
    const shapes: [unknown, string[]][] = [
      [{ password: SECRET }, ['password']],
      [{ user: { password: SECRET } }, ['user.password']],
      [{ items: [{ token: SECRET }] }, ['items[0].token']],
      [{ creds: { a: SECRET, b: SECRET } }, ['creds']],
      [{ list: [SECRET, SECRET] }, ['list']],
      [{ 'a.b': SECRET }, ['a.b']],
      [{ other: 'safe' }, ['nope']],
    ];

    for (const [value, redactedKeys] of shapes) {
      expect(stringifyValue(value, { redactedKeys })).toBe(
        JSON.stringify(
          applyRedaction(
            structuredClone(value) as Record<string, unknown>,
            redactedKeys,
          ),
        ),
      );
    }
  });

  test('honours the redactFunction contract', () => {
    const value = { e: 'johndoe@example.com' };

    expect(
      stringifyValue(value, {
        redactedKeys: ['e'],
        redactFunction: () => ({ strategy: 'email' }),
      }),
    ).toContain('@');

    expect(
      stringifyValue(value, {
        redactedKeys: ['e'],
        redactFunction: () => 'LITERAL',
      }),
    ).toBe('{"e":"LITERAL"}');

    // null defers to the default masking.
    expect(
      stringifyValue(value, {
        redactedKeys: ['e'],
        redactFunction: () => null,
      }),
    ).toBe(stringifyValue(value, { redactedKeys: ['e'] }));
  });

  test('leaves the caller value untouched', () => {
    const value = { user: { password: SECRET } };

    stringifyValue(value, { redactedKeys: ['user.password'] });

    expect(value.user.password).toBe(SECRET);
  });

  test('fails closed when the redactFunction throws', () => {
    const rendered = stringifyValue(
      { p: SECRET },
      {
        redactedKeys: ['p'],
        redactFunction: () => {
          throw new Error('boom');
        },
      },
    );

    expect(rendered).not.toContain(SECRET);
    expect(rendered).toContain('REDACTION FAILED');
  });

  test('terminates on a cyclic value while still redacting', () => {
    const cyclic: Record<string, unknown> = { password: SECRET };

    cyclic['self'] = cyclic;

    const rendered = stringifyValue(cyclic, { redactedKeys: ['password'] });

    expect(rendered).not.toContain(SECRET);
  });
});

describe('redactValue', () => {
  test('returns the masked structure, not text', () => {
    const masked = redactValue(
      { user: { password: SECRET } },
      { redactedKeys: ['user.password'] },
    ) as { user: { password: string } };

    expect(typeof masked).toBe('object');
    expect(masked.user.password).not.toBe(SECRET);
  });

  test('keeps container shape', () => {
    const masked = redactValue(
      { list: [SECRET, SECRET], obj: { a: SECRET } },
      { redactedKeys: ['list', 'obj'] },
    ) as { list: unknown[]; obj: Record<string, unknown> };

    expect(Array.isArray(masked.list)).toBe(true);
    expect(masked.list.length).toBe(2);
    expect(typeof masked.obj).toBe('object');
    expect(JSON.stringify(masked)).not.toContain(SECRET);
  });

  test('never modifies the value passed in', () => {
    const value = { user: { password: SECRET } };

    redactValue(value, { redactedKeys: ['user.password'] });

    expect(value.user.password).toBe(SECRET);
  });

  test('returns the value untouched with no redactedKeys', () => {
    const value = { a: 1 };

    expect(redactValue(value)).toBe(value);
  });

  test('composes with stringifyValue', () => {
    const options = { redactedKeys: ['user.password'] };
    const value = { user: { password: SECRET } };

    // Rendering an already-masked structure must equal masking while rendering.
    expect(stringifyValue(redactValue(value, options))).toBe(
      stringifyValue(value, options),
    );
  });

  test('honours the same redactFunction contract as stringifyValue', () => {
    const value = { e: 'johndoe@example.com' };

    const shapes: ((key: string, item: unknown) => unknown)[] = [
      () => null,
      () => 40,
      () => ({ strategy: 'email' as const }),
      () => 'LITERAL',
    ];

    for (const redactFunction of shapes) {
      const options = { redactedKeys: ['e'], redactFunction };

      expect(JSON.stringify(redactValue(value, options))).toBe(
        stringifyValue(value, options),
      );
    }
  });

  test('fails closed rather than returning the original', () => {
    const masked = redactValue(
      { p: SECRET },
      {
        redactedKeys: ['p'],
        redactFunction: () => {
          throw new Error('boom');
        },
      },
    );

    expect(JSON.stringify(masked)).not.toContain(SECRET);
    expect(JSON.stringify(masked)).toContain('REDACTION FAILED');
  });
});

describe('stringifyValue / redactValue - fail-closed branches', () => {
  // These are the "never return the original" guarantees. They are the branches that
  // matter most and the ones least likely to be hit by ordinary use, so each is driven
  // deliberately rather than left to chance.

  test('an unusable redactedKeys list masks everything', () => {
    // Not an array, and an array holding a non-string: in both the caller asked for
    // masking and this cannot tell what for.
    for (const redactedKeys of [
      'password' as unknown as string[],
      [42] as unknown as string[],
      [null] as unknown as string[],
    ]) {
      const value = { password: SECRET };

      expect(stringifyValue(value, { redactedKeys })).toBe(
        '***REDACTION FAILED***',
      );
      expect(redactValue(value, { redactedKeys })).toBe(
        '***REDACTION FAILED***',
      );
    }
  });

  test('an empty redactedKeys list leaves the value alone', () => {
    const value = { a: 1 };

    expect(redactValue(value, { redactedKeys: [] })).toBe(value);
    expect(stringifyValue(value, { redactedKeys: [] })).toBe('{"a":1}');
  });

  test('an entry naming nothing masks nothing', () => {
    // An empty-string entry is a valid path that simply matches no key, so the walk
    // still runs and the contents come through unchanged.
    const value = { a: 1 };

    expect(redactValue(value, { redactedKeys: [''] })).toEqual(value);
    expect(stringifyValue(value, { redactedKeys: [''] })).toBe('{"a":1}');
  });

  test('a redactedKeys array that cannot be iterated fails closed', () => {
    const hostile = new Proxy([] as string[], {
      get(target, property) {
        if (property === 'length') {
          throw new Error('no');
        }

        return Reflect.get(target, property) as unknown;
      },
    });

    expect(redactValue({ p: SECRET }, { redactedKeys: hostile })).toBe(
      '***REDACTION FAILED***',
    );
    expect(stringifyValue({ p: SECRET }, { redactedKeys: hostile })).toBe(
      '***REDACTION FAILED***',
    );
  });

  test('a sibling whose read throws does not leak the rest', () => {
    // The walk reads keys to find the paths. If that read fails, returning the value
    // hands back every sibling in the clear - including the ones named for redaction,
    // which the walk never reached.
    const value: Record<string, unknown> = { password: SECRET };

    Object.defineProperty(value, 'boom', {
      get(): never {
        throw new Error('nope');
      },
      enumerable: true,
    });

    expect(redactValue(value, { redactedKeys: ['password'] })).toBe(
      '***REDACTION FAILED***',
    );
    expect(stringifyValue(value, { redactedKeys: ['password'] })).not.toContain(
      SECRET,
    );
  });

  test('a cycle is cut rather than handed back unmasked', () => {
    const cyclic: Record<string, unknown> = { password: SECRET };

    cyclic['self'] = cyclic;

    const masked = redactValue(cyclic, {
      redactedKeys: ['password'],
    }) as Record<string, unknown>;

    expect(masked['password']).not.toBe(SECRET);
    expect(masked['self']).toBe('***REDACTION FAILED***');
  });
});
