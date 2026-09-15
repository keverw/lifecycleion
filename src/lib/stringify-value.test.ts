import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  test,
} from 'bun:test';
import {
  muteConsoleError,
  restoreConsoleError,
} from './internal/console-test-utils';
import {
  redactValue,
  stringifyValue,
  type StringifyValueOptions,
  type TruncationInfo,
} from './stringify-value';
import { cutAt, TRUNCATED_LENGTH } from './internal/render-budget';
import { applyRedaction } from './logger/utils/redaction';
import * as redactPaths from './internal/redact-paths';
import { REDACTION_FAILED_MARKER } from './internal/default-redact-function';
import type { RedactFunction } from './logger/types';

// These suites deliberately drive the paths that fall through to `console.error` when
// no handler is supplied. Captured rather than printed so a real failure in the run
// output still stands out; flip `DEBUG` in the helper to see them.
beforeEach(() => {
  muteConsoleError();
});

afterEach(() => {
  restoreConsoleError();
});

const SECRET = 'hunter2secret';

/** A `redactFunction` as a JavaScript caller may write one, before the type narrows it. */
type StringifyRedactFunctionLike = (key: string, item: unknown) => unknown;

describe('stringifyValue - rendering', () => {
  test('renders a plain object and array as JSON', () => {
    expect(stringifyValue({ k: 'v' })).toBe('{"k":"v"}');
    expect(stringifyValue(['a', 'b'])).toBe('["a","b"]');
    // Distinguishable from one element containing a comma, which a bare join is not.
    expect(stringifyValue(['a,b'])).toBe('["a,b"]');
  });

  test('names undefined rather than spelling it, so a string is distinct', () => {
    // `undefined` has no JSON form, so it is named the way `[circular]`, `[Function: f]`
    // and `[Map]` are. Spelling it quoted to `"undefined"` inside a container, which is
    // exactly what a string holding that text renders as - a distinction redaction keeps
    // (a genuine string is masked in part, a derived value replaced whole) and the
    // renderer was throwing away.
    expect(stringifyValue({ a: undefined })).toBe('{"a":"[undefined]"}');
    expect(stringifyValue({ a: 'undefined' })).toBe('{"a":"undefined"}');
    expect(stringifyValue([undefined, 'undefined'])).toBe(
      '["[undefined]","undefined"]',
    );
    // `null` has a JSON form and needs no such treatment.
    expect(stringifyValue({ a: null })).toBe('{"a":null}');
    expect(stringifyValue({ a: 'null' })).toBe('{"a":"null"}');
  });

  test('hands a redactFunction the same spelling the renderer uses', () => {
    // `maskValueDeep` stringifies each leaf through the renderer before the function sees
    // it, so the two cannot disagree about what an `undefined` leaf is called.
    const seen: string[] = [];

    redactValue(
      { a: undefined },
      {
        redactedKeys: ['a'],
        redactFunction: (_key, value) => {
          seen.push(value);

          return null;
        },
      },
    );

    expect(seen).toEqual(['[undefined]']);
  });

  test('keeps a value that has a string form of its own', () => {
    expect(stringifyValue(new Error('boom'))).toBe('Error: boom');
    expect(stringifyValue(new URL('https://example.test/y'))).toBe(
      'https://example.test/y',
    );
  });

  test('a path never addresses the root value itself', () => {
    // A bare name addresses a top-level key, and an `Error` has none to address, so
    // naming one has to reach nothing rather than blank the payload. Any non-empty
    // `redactedKeys` used to turn a non-plain root into `***REDACTED***`.
    expect(
      stringifyValue(new Error('boom'), { redactedKeys: ['password'] }),
    ).toBe('Error: boom');
    expect(
      stringifyValue(new URL('https://example.test/y'), {
        redactedKeys: ['password'],
      }),
    ).toBe('https://example.test/y');

    // Nested, the same path still masks the value whole - that is where it addresses
    // something the value is inside of.
    expect(
      stringifyValue(
        { inner: new Error('boom') },
        { redactedKeys: ['inner.password'] },
      ),
    ).toBe('{"inner":"***REDACTED***"}');
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

    const shapes: StringifyRedactFunctionLike[] = [
      () => null,
      () => 40,
      () => ({ strategy: 'email' as const }),
      () => 'LITERAL',
    ];

    for (const redactFunction of shapes) {
      const options = {
        redactedKeys: ['e'],
        redactFunction,
      } as unknown as StringifyValueOptions;

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

  test('a non-array reporting no length masks everything', () => {
    // The emptiness test is the one exit that hands the value back in the clear, so it is
    // asked of an array and of nothing else. A non-array answering `0` otherwise took
    // that exit and never reached the fail-closed branch, so the caller who asked for
    // masking got the value rendered whole and no `onFormatError` to say so.
    const value = { password: SECRET };
    const redactedKeys = { length: 0 } as unknown as string[];
    const reported: string[] = [];

    expect(
      redactValue(value, {
        redactedKeys,
        onFormatError: (_error, _kind, key) => {
          reported.push(key);
        },
      }),
    ).toBe('***REDACTION FAILED***');
    expect(reported).toEqual(['<redactedKeys>']);
    expect(
      stringifyValue(value, { redactedKeys, onFormatError: () => {} }),
    ).toBe('***REDACTION FAILED***');
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
    // Each value is read inside its own guard, so the one that throws is marked where it
    // sits and every sibling - the one named for redaction included - is still masked
    // rather than handed back in the clear or discarded with the container.
    const value: Record<string, unknown> = { password: SECRET };

    Object.defineProperty(value, 'boom', {
      get(): never {
        throw new Error('nope');
      },
      enumerable: true,
    });

    expect(redactValue(value, { redactedKeys: ['password'] })).toEqual({
      password: 'h***********t',
      boom: '***REDACTION FAILED***',
    });
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

describe('redactValue - values it was not asked to touch', () => {
  // The walk used to rebuild every object it passed through, reading `Object.entries`.
  // That is empty for a `Date` and a `Map`, and skips the non-enumerable `message` and
  // `stack` of an `Error`, so naming one key flattened every unrelated value beside it
  // to `{}` - in the returned structure and in anything rendered from it.
  test('passes a non-plain sibling through by reference', () => {
    const when = new Date('2020-01-01T00:00:00Z');
    const failure = new Error('boom');
    const tags = new Set(['a']);
    const pattern = /abc/g;
    const href = new URL('https://example.test/x');

    const value = { password: SECRET, when, failure, tags, pattern, href };

    const masked = redactValue(value, {
      redactedKeys: ['password'],
    }) as Record<string, unknown>;

    expect(masked['password']).not.toBe(SECRET);

    // Identity, not just shape: nothing was masked inside these, so nothing was rebuilt.
    expect(masked['when']).toBe(when);
    expect(masked['failure']).toBe(failure);
    expect(masked['tags']).toBe(tags);
    expect(masked['pattern']).toBe(pattern);
    expect(masked['href']).toBe(href);

    // And the members a rebuild would have dropped are still readable.
    expect((masked['when'] as Date).toISOString()).toBe(
      '2020-01-01T00:00:00.000Z',
    );
    expect((masked['failure'] as Error).message).toBe('boom');
  });

  test('preserves a non-plain value nested below the masked branch', () => {
    const when = new Date('2020-01-01T00:00:00Z');
    const value = { user: { password: SECRET, lastSeen: when } };

    const masked = redactValue(value, { redactedKeys: ['user.password'] }) as {
      user: Record<string, unknown>;
    };

    // `user` is rebuilt, because a mask landed inside it - but only the masked leaf is
    // replaced, and its sibling is carried across untouched.
    expect(masked.user['password']).not.toBe(SECRET);
    expect(masked.user['lastSeen']).toBe(when);
  });

  test('returns an equal value, branches untouched, when no path matches', () => {
    const inner = { b: 1 };
    const value = { a: inner };

    const masked = redactValue(value, { redactedKeys: ['nothing.here'] }) as {
      a: unknown;
    };

    expect(masked).toEqual(value);

    // Not `toBe(value)`, and this is the one identity the pass gives up. The value is
    // read once into a copy before the walk runs, because a `Proxy` that answers `{}` to
    // the walk and a secret to whoever reads the result afterwards is otherwise handed
    // back by reference with the secret still in it. A branch no path names is still the
    // caller's own object.
    expect(masked).not.toBe(value);
    expect(masked.a).toBe(inner);
  });

  test('does not mutate the value it was given', () => {
    const inner = { password: SECRET, keep: 'visible' };
    const value = { user: inner };

    redactValue(value, { redactedKeys: ['user.password'] });

    expect(value.user).toBe(inner);
    expect(inner.password).toBe(SECRET);
  });

  test('renders a preserved value with its own string form', () => {
    // The rendering half follows the structure, so the fix has to show up here too:
    // a `Date` beside a secret used to render as `{}`.
    expect(
      stringifyValue(
        { password: SECRET, href: new URL('https://example.test/x') },
        { redactedKeys: ['password'] },
      ),
    ).toContain('https://example.test/x');
  });

  test('still masks a non-plain value that is named outright', () => {
    // Preserving what was not named must not weaken what was. An `Error` is a leaf, so
    // naming it replaces it rather than exposing its enumerable properties.
    const masked = redactValue(
      { failure: new Error('boom') },
      { redactedKeys: ['failure'] },
    ) as Record<string, unknown>;

    expect(masked['failure']).toBe('***REDACTED***');
  });
});

describe('redactValue and stringifyValue compose', () => {
  test('stringifyValue(v, o) matches stringifyValue(redactValue(v, o))', () => {
    // The documented relationship between the two halves, checked across the value types
    // the walk treats differently: a plain container it rebuilds, and a non-plain one it
    // either passes through untouched or replaces outright. Masking through one call and
    // masking then rendering must not diverge, or a caller who wants the structure back
    // gets different text than one who wants it rendered.
    const when = new Date('2020-01-01T00:00:00Z');

    const cases: [unknown, string[]][] = [
      [{ p: SECRET, v: when }, ['p']],
      [{ p: SECRET, v: new Error('boom') }, ['p']],
      [{ p: SECRET, v: new URL('https://ex.test/a') }, ['p']],
      [{ p: SECRET, v: new Map([['k', 'v']]) }, ['p']],
      [{ p: SECRET, v: new Set(['a']) }, ['p']],
      [{ v: new Map([['k', 'v']]) }, ['v']],
      [{ v: when }, ['v']],
      [{ u: { p: SECRET, d: when } }, ['u.p']],
      [{ v: when }, ['no.match']],
    ];

    for (const [value, redactedKeys] of cases) {
      expect(stringifyValue(value, { redactedKeys })).toBe(
        stringifyValue(redactValue(value, { redactedKeys })),
      );
    }
  });

  test('redactValue agrees with the logger applyRedaction', () => {
    // One implementation behind both, so an entry masks the same way and preserves the
    // same references whichever entry point a caller reaches for.
    const params = {
      p: SECRET,
      d: new Date('2020-01-01T00:00:00Z'),
      e: new Error('boom'),
    };

    expect(redactValue(params, { redactedKeys: ['p'] })).toEqual(
      applyRedaction(params, ['p']),
    );
  });
});

describe('stringifyValue - a value renders the same at every depth', () => {
  // Nested values used to go through `JSON.stringify`, which applies its own rules rather
  // than these. They disagreed in ways that lost information or leaked it, and the
  // disagreement was invisible: the same value printed two different ways depending only
  // on whether it happened to sit inside an object.
  const nest = (value: unknown): string => stringifyValue({ v: value });

  test('renders a leaf identically alone and inside a container', () => {
    class Session {
      constructor(
        public apiKey = 'topsecret',
        public id = 1,
      ) {}
    }

    const values: unknown[] = [
      new Date('2020-01-01T00:00:00Z'),
      new Error('boom'),
      new URL('https://ex.test/a'),
      new Map([['k', 'v']]),
      new Set(['a']),
      new Session(),
      function named(): void {},
      undefined,
      10n,
    ];

    for (const value of values) {
      expect(nest(value)).toBe(
        `{"v":${JSON.stringify(stringifyValue(value))}}`,
      );
    }

    // And inside an array, which is the same walk.
    expect(stringifyValue([new Error('boom')])).toBe('["Error: boom"]');
  });

  test('does not dump a class instance fields when nested', () => {
    // The rule one level up is to name a class instance rather than print fields the
    // caller never asked to expose. `JSON.stringify` ignored that and dumped them, so a
    // secret hidden at top level was printed in full one level down - and no redaction
    // path could reach it, since nothing was named.
    class Session {
      public apiKey = 'topsecret';
    }

    expect(stringifyValue(new Session())).toBe('[Session]');
    expect(nest(new Session())).toBe('{"v":"[Session]"}');
    expect(nest(new Session())).not.toContain('topsecret');
    expect(stringifyValue({ a: { b: new Session() } })).not.toContain(
      'topsecret',
    );
  });

  test('renders a Date as ISO at every depth', () => {
    // Sortable, parseable, and timezone-explicit, which the locale form is not.
    const when = new Date('2020-01-01T00:00:00Z');

    expect(stringifyValue(when)).toBe('2020-01-01T00:00:00.000Z');
    expect(nest(when)).toBe('{"v":"2020-01-01T00:00:00.000Z"}');
  });

  test('an invalid Date keeps its own string form', () => {
    expect(stringifyValue(new Date('nonsense'))).toBe('Invalid Date');
  });

  test('one awkward leaf no longer collapses the whole render', () => {
    // A `BigInt` made `JSON.stringify` throw, and the entire object degraded to
    // `[object]` - every other field lost over one value.
    expect(stringifyValue({ id: 10n, name: 'kept' })).toBe(
      '{"id":"10","name":"kept"}',
    );
  });

  test('cuts a cycle where it closes rather than losing the object', () => {
    const cyclic: Record<string, unknown> = { a: 1 };

    cyclic['self'] = cyclic;

    expect(stringifyValue(cyclic)).toBe('{"a":1,"self":"[circular]"}');
  });

  test('keeps a value referenced twice side by side', () => {
    // Not a cycle: releasing each object as its branch finishes is what tells the two
    // apart, the same rule errorToString follows.
    const shared = { n: 1 };

    expect(stringifyValue({ a: shared, b: shared })).toBe(
      '{"a":{"n":1},"b":{"n":1}}',
    );
  });

  test('still renders a plain container as ordinary JSON', () => {
    expect(stringifyValue({ k: 'v', n: 1, b: true, z: null })).toBe(
      '{"k":"v","n":1,"b":true,"z":null}',
    );
    expect(stringifyValue(['a', 'b'])).toBe('["a","b"]');
    expect(stringifyValue({ 'quoted"key': 'a"b' })).toBe(
      '{"quoted\\"key":"a\\"b"}',
    );
  });
});

describe('redactValue - deeply mixed containers', () => {
  test('addresses and rebuilds arrays and objects interleaved to any depth', () => {
    // The general case the path grammar exists for: objects inside arrays inside objects,
    // and an array directly inside another array, which has no key of its own to name.
    const value = {
      users: [
        {
          name: 'a',
          creds: { token: 'topsecret1', nested: [{ deep: 'topsecret2' }] },
        },
        { name: 'b', tags: ['x', ['y', { z: 'topsecret3' }]] },
      ],
      meta: { when: new Date('2020-01-01T00:00:00Z'), err: new Error('boom') },
    };

    const masked = redactValue(value, {
      redactedKeys: [
        'users[0].creds.token',
        'users[0].creds.nested[0].deep',
        'users[1].tags[1][1].z',
      ],
    }) as typeof value;

    const rendered = stringifyValue(masked);

    expect(rendered).not.toContain('topsecret');
    // Every unnamed neighbour survives, at every level.
    expect(rendered).toContain('"name":"a"');
    expect(rendered).toContain('"x"');
    expect(rendered).toContain('"y"');

    // Shape is preserved rather than coerced: an array is still an array, nested ones
    // included.
    expect(Array.isArray(masked.users)).toBe(true);
    expect(Array.isArray(masked.users[1]?.tags?.[1])).toBe(true);

    // Only the branches leading to a mask are rebuilt. `meta` held nothing named, so it
    // is the caller's own object, and the `Date` and `Error` inside it are untouched.
    expect(masked.meta).toBe(value.meta);
    expect(masked.meta.when).toBeInstanceOf(Date);
    expect(masked.meta.err).toBeInstanceOf(Error);
    expect(masked.users[1]).not.toBe(value.users[1]);
  });
});

describe('stringifyValue - one bad value never costs the rest', () => {
  test('degrades a throwing array element, not the array around it', () => {
    // The object branch guarded its reads from the start; the array branch did not, so a
    // single throwing element unwound to the top-level catch and the entire payload
    // collapsed to `[object]` - every unrelated field lost over one value.
    const list: unknown[] = [1, 2];

    Object.defineProperty(list, '1', {
      get() {
        throw new Error('boom');
      },
      enumerable: true,
      configurable: true,
    });

    expect(stringifyValue({ user: 'alice', list, note: 'kept' })).toBe(
      '{"user":"alice","list":[1,"[unrenderable: value]"],"note":"kept"}',
    );
  });

  test('degrades a throwing object entry, not the object around it', () => {
    expect(
      stringifyValue({
        user: 'alice',
        o: {
          get x(): never {
            throw new Error('boom');
          },
        },
        note: 'kept',
      }),
    ).toContain('"note":"kept"');
  });
});

describe('stringifyValue - opting out and bounding output', () => {
  test('does not call a toJSON, at any depth', () => {
    // `JSON.stringify` honours `toJSON`; this renderer deliberately does not. It was
    // honoured for a plain object and silently ignored for a class instance, which is an
    // arbitrary split, and it is the one place caller code ran on the logging path - a
    // method free to throw, to be slow, or to return something different each call.
    // Everything is walked by this library instead, so what prints is what the value
    // actually holds. Use `redactedKeys` to hide a field rather than a `toJSON`.
    const value = { id: 1, toJSON: (): string => 'CUSTOM' };

    expect(stringifyValue(value)).toBe(
      '{"id":1,"toJSON":"[Function: toJSON]"}',
    );
    expect(stringifyValue({ inner: value })).toBe(
      '{"inner":{"id":1,"toJSON":"[Function: toJSON]"}}',
    );
  });

  test('a toJSON object redacts like any other plain object', () => {
    // The payoff for not honouring it: no special case, and a path reaches the field.
    expect(
      stringifyValue(
        {
          cfg: { env: 'prod', apiKey: SECRET, toJSON: (): string => 'CUSTOM' },
        },
        { redactedKeys: ['cfg.apiKey'] },
      ),
    ).toBe(
      '{"cfg":{"env":"prod","apiKey":"h***********t","toJSON":"[Function: toJSON]"}}',
    );
  });

  test('a throwing toJSON is never called, so it cannot fail', () => {
    expect(
      stringifyValue({
        kept: 'v',
        toJSON: (): never => {
          throw new Error('boom');
        },
      }),
    ).toContain('"kept":"v"');
  });

  test('a toJSON returning the container itself does not recurse', () => {
    const value: Record<string, unknown> = { a: 1 };

    value['toJSON'] = (): unknown => value;

    expect(typeof stringifyValue(value)).toBe('string');
  });

  test('a throwing toJSON falls back to the ordinary walk', () => {
    expect(
      stringifyValue({
        toJSON: (): never => {
          throw new Error('boom');
        },
        kept: 'v',
      }),
    ).toContain('"kept":"v"');
  });

  test('names a function rather than printing its body', () => {
    // `String(fn)` is the whole source: unbounded, and carrying whatever the author wrote
    // inside it into a log line.
    function secretHelper(): string {
      return 'AKIA-LEAK';
    }

    expect(stringifyValue(secretHelper)).toBe('[Function: secretHelper]');
    expect(stringifyValue({ fn: secretHelper })).toBe(
      '{"fn":"[Function: secretHelper]"}',
    );
    expect(stringifyValue({ fn: secretHelper })).not.toContain('AKIA-LEAK');
    expect(stringifyValue(function (): void {})).toBe('[Function]');
  });
});

describe('stringifyValue - depth', () => {
  test('marks where a too-deep render stopped', () => {
    // Catching the per-entry throw meant a `RangeError` from deep recursion was swallowed
    // silently: tens of kilobytes of output that simply stopped, with nothing saying so.
    let deep: Record<string, unknown> = { v: 1 };

    for (let index = 0; index < 5000; index++) {
      deep = { d: deep };
    }

    const rendered = stringifyValue(deep);

    expect(rendered).toContain('[max depth exceeded]');
    expect(rendered.length).toBeLessThan(2000);
    expect(() => JSON.parse(rendered) as unknown).not.toThrow();
  });
});

describe('redactValue - a subtree no path addresses', () => {
  // Nothing below such a subtree can match, so the walk's whole answer for it is the
  // subtree that went in - which it used to reach by rebuilding every object and array
  // inside it and discarding the rebuild once nothing had matched. It is skipped now, but
  // only after ruling out the two things that make handing back the original wrong.

  test('comes back as the very same object', () => {
    const payload = { rows: [{ id: 1 }, { id: 2 }] };
    const result = redactValue(
      { password: SECRET, payload },
      { redactedKeys: ['password'] },
    ) as Record<string, unknown>;

    expect(result['payload']).toBe(payload);
    expect(result['password']).not.toBe(SECRET);
  });

  test('is still walked when it points back at an ancestor', () => {
    // The one case the skip must not take: the ancestor is being rebuilt, so passing the
    // original through would carry the unmasked version into the result beside the mask.
    const bag: Record<string, unknown> = { password: SECRET, payload: {} };

    (bag['payload'] as Record<string, unknown>)['self'] = bag;

    const result = redactValue(bag, {
      redactedKeys: ['password'],
    }) as Record<string, unknown>;
    const payload = result['payload'] as Record<string, unknown>;

    expect(payload['self']).toBe('***REDACTION FAILED***');
    expect(result['password']).not.toBe(SECRET);
  });

  test('is still walked when one of its values cannot be read', () => {
    const other: Record<string, unknown> = {};

    Object.defineProperty(other, 'boom', {
      enumerable: true,
      get() {
        throw new Error('nope');
      },
    });

    const result = redactValue(
      { password: SECRET, other },
      { redactedKeys: ['password'], onFormatError: () => {} },
    ) as Record<string, unknown>;

    // The unreadable entry is marked where it sits; the container around it keeps its
    // shape rather than being failed closed as a whole.
    expect(result['other']).toEqual({ boom: '***REDACTION FAILED***' });
    expect(result['password']).not.toBe(SECRET);
  });

  test('a path reaching into it still masks what it names', () => {
    const result = redactValue(
      { payload: { rows: [{ token: 'abcdefghijkl' }] } },
      { redactedKeys: ['payload.rows[0].token'] },
    ) as Record<string, unknown>;

    expect(JSON.stringify(result)).not.toContain('abcdefghijkl');
  });
});

describe('redactValue - redaction changes only what it masks', () => {
  // The rule the rest of this follows: redacted output must differ from unredacted output
  // only where a value was masked. Redaction decides what to hide, never how the value
  // around it is printed.
  //
  // It is not a style preference. The walk used to descend into anything object-shaped,
  // so masking one field rebuilt an `Error` or a class instance as a plain object - and
  // the renderer, which prints those through their own string form, then printed their
  // fields instead. Asking to hide `password` on a `Session` printed the `internalToken`
  // sitting beside it, which no unredacted log line had ever shown. Redaction disclosed.
  //
  // So redaction now walks exactly what the renderer walks: a plain object or an array.
  // Everything else is one value in both, and masking it replaces one string with another.

  class Session {
    public id = 5;

    public password = SECRET;

    public internalToken = 'NEVER-MEANT-TO-PRINT';

    public toString(): string {
      return 'Session';
    }
  }

  test('masking never reveals a field that was not printed before', () => {
    const rendered = stringifyValue(
      { s: new Session() },
      { redactedKeys: ['s.password'] },
    );

    expect(rendered).not.toContain('NEVER-MEANT-TO-PRINT');
    expect(rendered).not.toContain(SECRET);

    const failure = Object.assign(new Error('boom'), {
      password: SECRET,
      databaseURL: 'postgres://user:pw@host/db',
    });

    expect(
      stringifyValue({ e: failure }, { redactedKeys: ['e.password'] }),
    ).not.toContain('postgres');
  });

  test('a value keeps its printed shape whether or not it is redacted', () => {
    // A string before, a string after; an object before, an object after.
    const shapes: [() => unknown, string][] = [
      [() => ({ id: 5, password: SECRET }), 'v.password'],
      [() => [{ password: SECRET }], 'v[0].password'],
      [() => new Session(), 'v.password'],
      [
        () => Object.assign(new Error('boom'), { password: SECRET }),
        'v.password',
      ],
      [() => new Map([['password', SECRET]]), 'v.password'],
      [() => new Date('2020-01-01T00:00:00Z'), 'v.password'],
    ];

    for (const [make, entry] of shapes) {
      const plain = stringifyValue({ v: make() });
      const redacted = stringifyValue({ v: make() }, { redactedKeys: [entry] });

      // Both render an object at `v`, or both render a string at `v`.
      expect(
        redacted.startsWith('{"v":{') || redacted.startsWith('{"v":['),
      ).toBe(plain.startsWith('{"v":{') || plain.startsWith('{"v":['));
      expect(redacted).not.toContain(SECRET);
    }
  });

  test('a path into a value the renderer prints whole masks that value', () => {
    // There is no way to mask part of `Error: boom`, and leaving it alone would print the
    // very thing the path named, so the value goes.
    for (const [value, entry] of [
      [{ err: new Error('SUPERSECRET') }, 'err.message'],
      [{ u: new URL('https://user:PASSWORD@ex.test/') }, 'u.password'],
      [{ c: new Map([['apiKey', SECRET]]) }, 'c.apiKey'],
      [{ s: new Session() }, 's.password'],
    ] as [Record<string, unknown>, string][]) {
      const rendered = stringifyValue(value, { redactedKeys: [entry] });

      expect(rendered).toContain('***REDACTED***');
      expect(rendered).not.toContain('SUPERSECRET');
      expect(rendered).not.toContain('PASSWORD');
      expect(rendered).not.toContain(SECRET);
    }
  });

  test('such a value is untouched when nothing points inside it', () => {
    expect(
      stringifyValue(
        { err: new Error('boom'), other: SECRET },
        { redactedKeys: ['other'] },
      ),
    ).toBe(`{"err":"Error: boom","other":"h***********t"}`);
  });

  test('a plain container is still masked surgically', () => {
    // Its own entries are the whole of what prints, so a path reaches exactly one of them
    // and a path naming one it lacks reaches nothing.
    expect(
      stringifyValue(
        { u: { name: 'alice', password: SECRET }, a: [1, 2] },
        { redactedKeys: ['u.password', 'u.stale', 'a.stale'] },
      ),
    ).toBe('{"u":{"name":"alice","password":"h***********t"},"a":[1,2]}');
  });
});

describe('stringifyValue - the redaction invariant', () => {
  test('redacted output differs from unredacted output only at the masked values', () => {
    // Asserted mechanically rather than eyeballed, over one payload holding every kind of
    // value the two walks treat differently: plain objects and arrays, which are entered;
    // a `Date`, an `Error` and a class instance, which are printed whole; and an object
    // defining `toJSON`, which is resolved to its result first.
    //
    // This is the property the whole design serves. Breaking it is how redaction came to
    // disclose fields - masking rebuilt a value the renderer would have printed whole, and
    // the renderer then printed its fields instead.
    class Session {
      public id = 5;

      public token = SECRET;

      public toString(): string {
        return 'Session';
      }
    }

    const payload = (): Record<string, unknown> => ({
      user: { name: 'alice', token: SECRET },
      list: [{ token: SECRET }, 'plain'],
      when: new Date('2020-01-01T00:00:00Z'),
      err: new Error('boom'),
      cfg: {
        env: 'prod',
        token: SECRET,
        toJSON: (): unknown => ({ env: 'prod', token: SECRET }),
      },
      sess: new Session(),
    });

    const before = stringifyValue(payload());
    const after = stringifyValue(payload(), {
      redactedKeys: ['user.token', 'list[0].token', 'cfg.token'],
    });

    expect(after).not.toContain(SECRET);

    // Every masked spot replaced by the same token in both renders: what is left must
    // match exactly, so nothing appeared, vanished, or changed shape.
    const mask = /h\*+t/g;

    expect(before.split(SECRET).join('<M>')).toBe(
      after.split(mask).join('<M>'),
    );

    // And the values nobody named print identically, character for character.
    for (const fragment of [
      '"when":"2020-01-01T00:00:00.000Z"',
      '"err":"Error: boom"',
      '"sess":"Session"',
      '"name":"alice"',
      '"plain"',
    ]) {
      expect(before).toContain(fragment);
      expect(after).toContain(fragment);
    }
  });
});

describe('redactValue - a Map or any unsupported type', () => {
  test('is replaced by a string, not rebuilt into anything', () => {
    // Nothing is constructed for it. A `Map`, a `Set`, a `Date`, an `Error`, a class
    // instance - each is one value to both walks, so masking swaps it for a plain string
    // and that string is what gets rendered. Which is exactly why the printed shape does
    // not move: a string stood there before, and a string stands there after.
    const masked = redactValue(
      { m: new Map([['k', SECRET]]), s: new Set([SECRET]) },
      { redactedKeys: ['m', 's'] },
    ) as Record<string, unknown>;

    expect(masked['m']).toBe('***REDACTED***');
    expect(masked['s']).toBe('***REDACTED***');
    expect(typeof masked['m']).toBe('string');

    expect(
      stringifyValue({ m: new Map([['k', SECRET]]) }, { redactedKeys: ['m'] }),
    ).toBe('{"m":"***REDACTED***"}');
  });

  test('is passed through untouched when nothing names it', () => {
    const conf = new Map([['k', SECRET]]);
    const masked = redactValue(
      { conf, other: SECRET },
      { redactedKeys: ['other'] },
    ) as Record<string, unknown>;

    // The same Map, by reference - not a copy, not a rebuild.
    expect(masked['conf']).toBe(conf);
    expect(stringifyValue({ conf }, { redactedKeys: ['other'] })).toBe(
      '{"conf":"[Map]"}',
    );
  });
});

describe('redactValue - a hostile array cannot cost the payload', () => {
  // The array branch used to reach `entries` off the array itself and rebuild through
  // `map`, both of which are caller code: an own `entries` property, and a subclass
  // constructor reached through `ArraySpeciesCreate`. Either could throw from inside the
  // walk, where there was no guard, so one bad array anywhere turned an entire payload
  // into the failure marker - while the renderer walked the same array without trouble.
  // That divergence between the two walks is the thing this design exists to remove.
  const withArray = (a: unknown): Record<string, unknown> => ({
    a,
    password: SECRET,
    user: 'alice',
  });

  test('keeps every sibling when the array itself misbehaves', () => {
    const shadowed: unknown[] = [1, 2];

    (shadowed as unknown as Record<string, unknown>)['entries'] =
      'not a method';

    const throwing: unknown[] = [1, 2];

    (throwing as unknown as Record<string, unknown>)['entries'] = (): never => {
      throw new Error('nope');
    };

    // A generator yielding different pairs rebuilt the array from the lie, silently
    // dropping every element it did not mention.
    const hijacked: unknown[] = [1, 2];

    (hijacked as unknown as Record<string, unknown>)['entries'] =
      function* (): Generator<[number, unknown]> {
        yield [0, 'HIJACK'];
      };

    class Tuple extends Array {
      constructor(...items: unknown[]) {
        super();

        if (items.length !== 2) {
          throw new TypeError('Tuple needs exactly 2');
        }

        this.push(...items);
      }
    }

    for (const array of [
      shadowed,
      throwing,
      hijacked,
      new Tuple('lat', 'lng') as unknown as unknown[],
    ]) {
      const rendered = stringifyValue(withArray(array), {
        redactedKeys: ['password'],
      });

      expect(rendered).not.toContain(SECRET);
      expect(rendered).toContain('"user":"alice"');
      // The array survives with both elements, exactly as the renderer prints it.
      expect(rendered).toContain('"a":[');
      expect(rendered).not.toBe('***REDACTION FAILED***');
    }
  });

  test('emits the element it walked, reading each one once', () => {
    // The element was read to walk it and read *again* to copy it on the unchanged path,
    // so what reached the output was never the value the walk had looked at. An accessor
    // need not answer the same way twice: the walk concluded "nothing matched" from the
    // first answer and then copied the second, which could hold what the first did not.
    let reads = 0;

    const array: unknown[] = [null, SECRET];

    Object.defineProperty(array, '0', {
      get(): string {
        reads++;

        return reads === 1 ? 'harmless' : SECRET;
      },
      enumerable: true,
      configurable: true,
    });

    // The second element is named, so the array is rebuilt and the first takes the
    // unchanged path into the copy - the only path where the two reads could differ.
    const redacted = redactValue(
      { a: array },
      { redactedKeys: ['a[1]'] },
    ) as Record<string, unknown[]>;

    expect(reads).toBe(1);
    expect(redacted['a']?.[0]).toBe('harmless');
    expect(redacted['a']?.[1]).not.toBe(SECRET);
  });

  test('degrades one unreadable element rather than the whole array', () => {
    const array: unknown[] = [1, 2];

    Object.defineProperty(array, '1', {
      get(): never {
        throw new Error('nope');
      },
      enumerable: true,
      configurable: true,
    });

    const rendered = stringifyValue(withArray(array), {
      redactedKeys: ['password'],
    });

    expect(rendered).toContain('"user":"alice"');
    expect(rendered).toContain('***REDACTION FAILED***');
    expect(rendered).not.toContain(SECRET);
  });
});

describe('redactValue - a cycle nobody named is left alone', () => {
  test('does not rewrite a cyclic payload when nothing matched', () => {
    // A back-edge yields the failure marker so that an unmasked original never ends up
    // inside a copy being rebuilt around it. With no mask anywhere there is no such copy,
    // and rewriting the value would break the rule that only masked things change.
    const cyclic: Record<string, unknown> = { a: 1 };

    cyclic['self'] = cyclic;

    expect(stringifyValue({ c: cyclic }, { redactedKeys: ['zzz'] })).toBe(
      stringifyValue({ c: cyclic }),
    );

    // An unreadable read is deliberately *not* given this treatment - see the test below.
  });

  test('leaves the cycle alone even when a mask lands beside it', () => {
    // The sibling mask does not reach into `c`, and neither does any path, so `c` is
    // handed back by reference and its loop is simply rendered as `[circular]`. The
    // failure marker is for a back-edge *up* into an ancestor being rebuilt, where
    // passing the original through would carry unmasked values into the copy. A loop
    // closing entirely inside a subtree nothing rebuilt is not that case.
    const cyclic: Record<string, unknown> = { a: 1 };

    cyclic['self'] = cyclic;

    const rendered = stringifyValue(
      { c: cyclic, password: SECRET },
      { redactedKeys: ['password'] },
    );

    expect(rendered).toContain('[circular]');
    expect(rendered).not.toContain('***REDACTION FAILED***');
    expect(rendered).not.toContain(SECRET);
    expect(rendered).toContain('"password":"h***********t"');
  });

  test('a back-edge into an ancestor being rebuilt still fails closed', () => {
    // The case the marker exists for: `inner` points back up at `root`, which *is* being
    // rebuilt because `root.password` matched. Handing the original through here would
    // put the unmasked `root` inside the copy.
    const root: Record<string, unknown> = { password: SECRET };

    root['inner'] = { up: root };

    const rendered = stringifyValue(root, { redactedKeys: ['password'] });

    expect(rendered).toContain('***REDACTION FAILED***');
    expect(rendered).not.toContain(SECRET);
  });

  test('an unreadable read is never mistaken for nothing to mask', () => {
    // The key distinction: a cycle is a place the walk already knows, so "nothing matched"
    // is real. A read that failed hides what was behind it, so the same conclusion would
    // hand back the original with a redacted key still in the clear.
    const value: Record<string, unknown> = { password: SECRET };

    Object.defineProperty(value, 'boom', {
      get(): never {
        throw new Error('nope');
      },
      enumerable: true,
    });

    expect(redactValue(value, { redactedKeys: ['password'] })).toEqual({
      password: 'h***********t',
      boom: '***REDACTION FAILED***',
    });
  });
});

describe('a container that answers differently the second time', () => {
  // The walk reads each member once and hands a subtree that matched nothing back by
  // reference; the render, the sink, and the caller then read it again. A `Proxy` whose
  // `get` trap answers `{}` first and a secret afterwards is therefore masked on the read
  // nobody sees and printed on the read everybody does - and `isUnstableEntry` cannot
  // catch it, because the same trap that lies about the value reports an ordinary data
  // property from `getOwnPropertyDescriptor`. The logger never had this leak: its params
  // are normalized into forwarding copies along every named path before the walk runs, so
  // the two reads are of one snapshot. These entry points now run that same normalization.

  const LEAKED = 'LEAKED_SECRET';

  /** Answers `{}` under `key` once, then a bag holding a secret. */
  const lying = (key: string, leaf: string): Record<string, unknown> => {
    let reads = 0;

    return new Proxy(
      { [key]: {} },
      {
        get(target, property, receiver): unknown {
          if (property === key) {
            reads++;

            return reads === 1 ? {} : { [leaf]: LEAKED };
          }

          return Reflect.get(target, property, receiver);
        },
      },
    );
  };

  test('cannot swap a secret in below a named path', () => {
    const redactedKeys = ['a.g.up.password'];

    const rendered = stringifyValue(
      { a: { g: lying('up', 'password') } },
      { redactedKeys },
    );

    // What the pass vetted is what comes out: the empty object the first read answered,
    // with the secret the later reads offer nowhere in it.
    expect(rendered).not.toContain(LEAKED);
    expect(rendered).toBe('{"a":{"g":{"up":{}}}}');

    const masked = redactValue(
      { a: { g: lying('up', 'password') } },
      { redactedKeys },
    );

    expect(JSON.stringify(masked)).not.toContain(LEAKED);
    expect(masked).toEqual({ a: { g: { up: {} } } });
  });

  test('cannot swap a secret in at the root either', () => {
    const redactedKeys = ['up.password'];

    expect(
      stringifyValue(lying('up', 'password'), { redactedKeys }),
    ).not.toContain(LEAKED);
    expect(stringifyValue(lying('up', 'password'), { redactedKeys })).toBe(
      '{"up":{}}',
    );
    expect(
      JSON.stringify(redactValue(lying('up', 'password'), { redactedKeys })),
    ).not.toContain(LEAKED);
  });

  test('cannot swap a secret in under a wildcard', () => {
    // A wildcard descends through every element exactly as an index does, so the elements
    // are normalized exactly as `items[0].up.token` normalizes one.
    const value = { items: [lying('up', 'token'), lying('up', 'token')] };
    const redactedKeys = ['items[*].up.token'];

    const rendered = stringifyValue(value, { redactedKeys });

    expect(rendered).not.toContain(LEAKED);
    expect(rendered).toBe('{"items":[{"up":{}},{"up":{}}]}');
    expect(JSON.stringify(redactValue(value, { redactedKeys }))).not.toContain(
      LEAKED,
    );
  });

  test('still masks the secret the snapshot does hold', () => {
    // The other direction, so the fix is not just "a hostile value renders empty": what
    // the first read answers is what gets masked, trap or no trap.
    const honest = new Proxy({ up: { password: 'hunter2secret' } }, {});

    expect(
      stringifyValue({ g: honest }, { redactedKeys: ['g.up.password'] }),
    ).toBe('{"g":{"up":{"password":"h***********t"}}}');
  });
});

describe('redactValue - what masking reaches', () => {
  test('does not mask state the renderer cannot see either', () => {
    // Masking covers own enumerable string-keyed properties, which is exactly what gets
    // printed. Anything hidden from `Object.entries` is neither masked nor printed, so no
    // log line leaks - and off a named branch the returned object still holds it, which
    // makes `redactValue` safe to render rather than a sanitizer for an arbitrary
    // consumer.
    //
    // Deliberately not fixed with a reachability check: testing whether a name exists
    // rather than whether it prints is what caused a stale entry to blank a whole value
    // earlier in this work.
    const hidden = 'SUPERSECRET';

    const withNonEnumerable = (): Record<string, unknown> => {
      const o: Record<string, unknown> = { visible: 1 };

      Object.defineProperty(o, 'password', {
        value: hidden,
        enumerable: false,
      });

      return o;
    };

    // Never printed, with or without redaction.
    expect(stringifyValue({ o: withNonEnumerable() })).toBe(
      '{"o":{"visible":1}}',
    );
    expect(
      stringifyValue(
        { o: withNonEnumerable() },
        { redactedKeys: ['o.password'] },
      ),
    ).toBe('{"o":{"visible":1}}');

    // Nor masked in the returned structure: `o` is on a named branch, so it comes back as
    // the copy this pass read - exactly the keys `for...in` yielded - and a property no
    // enumeration can see is simply not carried over. Dropping it is a side effect of
    // snapshotting the branch, not a sanitizing pass: the same property one level to the
    // side, under no path at all, still comes back on the caller's own object.
    const masked = redactValue(
      { o: withNonEnumerable(), aside: withNonEnumerable() },
      { redactedKeys: ['o.password'] },
    ) as { o: Record<string, unknown>; aside: Record<string, unknown> };

    expect(masked.o['password']).toBeUndefined();
    expect(masked.aside['password']).toBe(hidden);

    // Naming the container masks every leaf it can see and keeps the shape - so the
    // hidden property is not covered by that either. Only a value the renderer prints
    // whole is replaced outright.
    expect(
      redactValue({ o: withNonEnumerable() }, { redactedKeys: ['o'] }),
    ).toEqual({ o: { visible: '***REDACTED***' } });
  });
});

describe('redactValue array subclasses', () => {
  test('masks an array subclass whose constructor rejects a length argument', () => {
    // Masking used `Array.prototype.map`, which goes through `ArraySpeciesCreate` and
    // calls the value's own constructor with a length. A tuple subclass that rejects
    // that threw from inside the walk and the whole container came back as the failure
    // marker instead of the masked array shape.
    class Tuple extends Array {
      constructor(...items: unknown[]) {
        if (items.length === 1 && typeof items[0] === 'number') {
          throw new TypeError('Tuple cannot be constructed from a length');
        }

        super(...(items as never[]));
      }
    }

    const tuple = new Tuple();

    tuple.push('topsecretvalue', 'other');

    const result = redactValue({ tuple }, { redactedKeys: ['tuple'] }) as {
      tuple: unknown;
    };

    expect(Array.isArray(result.tuple)).toBe(true);
    expect((result.tuple as unknown[]).length).toBe(2);
    expect((result.tuple as unknown[])[0]).not.toBe('topsecretvalue');
  });
});

describe('redactValue - what a redactFunction may return', () => {
  // The function is handed one already-stringified leaf and hands back the text that
  // stands in for it, so a string is the ordinary answer. Every non-string return is a
  // control signal - "you do the masking" - rather than a replacement value, and an object
  // is the signal that carries settings.
  //
  // Which means an object is *never* a literal. Reading one as a replacement put a
  // rendered `{"note":"x"}` in the output where a masked value belonged, and guessing
  // which kind of object it was is what leaked: an unrecognized shape taken for a config
  // discarded the caller's value and emitted a proportional mask of the original instead.
  // An object that is not a usable request falls back to the default masking.
  //
  // Typed `unknown` and cast at the boundary throughout: the published type now rules
  // most of these out, and the point of the tests is what a JavaScript caller - who has
  // no type to stop them - still gets.
  const ask = (returned: unknown): unknown =>
    (
      redactValue({ password: SECRET }, {
        redactedKeys: ['password'],
        redactFunction: () => returned,
      } as unknown as StringifyValueOptions) as Record<string, unknown>
    )['password'];

  const DEFAULT_MASKED = 'h***********t';

  test('a string is the replacement, used as-is', () => {
    expect(ask('[hidden]')).toBe('[hidden]');
  });

  test('null and a number are the deferral signals', () => {
    expect(ask(null)).toBe(DEFAULT_MASKED);
    expect(ask(50)).not.toBe(SECRET);
    expect(ask(50)).not.toBe(DEFAULT_MASKED);
  });

  test('an object naming only settings is a masking request', () => {
    expect(ask({ percent: 100 })).toBe('*'.repeat(SECRET.length));
    expect(ask({ maskChar: '#', percent: 100 })).toBe(
      '#'.repeat(SECRET.length),
    );
    expect(ask({ strategy: 'string', percent: 100 })).toBe(
      '*'.repeat(SECRET.length),
    );
  });

  test('a null-prototype object naming settings is a request too', () => {
    // Recognized by its keys, so how it was constructed does not change the answer.
    expect(ask(Object.assign(Object.create(null), { percent: 100 }))).toBe(
      '*'.repeat(SECRET.length),
    );
  });

  test('a setting defined non-enumerably still counts as one', () => {
    // Keys are read with `Reflect.ownKeys`, and the masker reads the value by name.
    expect(ask(Object.defineProperty({}, 'percent', { value: 100 }))).toBe(
      '*'.repeat(SECRET.length),
    );
  });

  test('an object that is not a usable request gets the default masking', () => {
    // Not the object itself, and not a mask derived from a shape nobody asked for: the
    // same answer as if no `redactFunction` had been supplied at all.
    for (const returned of [
      {}, // every setting is optional, so an empty config asks for the defaults
      { note: 'withheld' }, // nothing recognized
      { percent: 10, note: 'x' }, // half recognized, which is not enough to act on
      { [Symbol('note')]: 'x' }, // a key `Object.keys` cannot see is still a key
      Object.defineProperty({}, 'note', { value: 'x' }),
      ['a', 'b'],
      new (class Replacement {
        public note = 'x';
      })(),
    ]) {
      expect(ask(returned)).toBe(DEFAULT_MASKED);
      expect(ask(returned)).toBe(ask(null));
    }
  });

  test('an unusable request never emits the object it could not read', () => {
    // The regression this guards, from both sides: the caller's object must not appear in
    // the output, and neither must a partial mask of the value it was standing in for.
    const rendered = stringifyValue({ password: SECRET }, {
      redactedKeys: ['password'],
      redactFunction: () => ({ note: 'withheld' }),
    } as unknown as StringifyValueOptions);

    expect(rendered).toBe(`{"password":"${DEFAULT_MASKED}"}`);
    expect(rendered).not.toContain('withheld');
    expect(rendered).not.toContain(SECRET);
  });

  test('a primitive that is not a signal is used literally', () => {
    // Only an object is read as a request, so a primitive is the caller's own
    // replacement - `undefined` excepted, which defers exactly as `null` does rather
    // than leaving the word `undefined` where a masked value belonged.
    expect(ask(false)).toBe(false);
    expect(ask(undefined)).toBe(ask(null));
    expect(ask(undefined)).not.toBe(undefined);
  });

  test('an unusable request defers on a derived value too, not just a string', () => {
    // The half a string cannot test. Routing an unusable object through the masker rather
    // than through the deferral skips the derived-value rule, and for anything that was
    // not genuinely a string that is a disclosure: proportional masking keeps the ends,
    // which is where a `URL` keeps its query and a card number its BIN prefix and last
    // four. Both are what the default replaces outright, so these must too.
    const derived = (returned: unknown, value: unknown): unknown =>
      (
        redactValue({ v: value }, {
          redactedKeys: ['v'],
          redactFunction: () => returned,
        } as unknown as StringifyValueOptions) as Record<string, unknown>
      )['v'];

    const url = new URL('https://api.x.test/v1?api_key=sk_live_abcdef123456');

    for (const returned of [{}, { note: 'x' }, { percent: 10, note: 'x' }]) {
      expect(derived(returned, url)).toBe('***REDACTED***');
      expect(derived(returned, url)).toBe(derived(null, url));
      expect(derived(returned, 4111111111111111)).toBe('***REDACTED***');
    }

    // A request that names a setting is the deliberate opt-in, and still masks in part.
    expect(derived({ percent: 60 }, 4111111111111111)).not.toBe(
      '***REDACTED***',
    );
  });

  test('all three entry points read a return value the same way', () => {
    // One implementation, three callers. A return classified one way in one and another
    // way in another is exactly the drift the shared code exists to prevent.
    for (const [returned, expected] of [
      [{ percent: 100 }, '*'.repeat(SECRET.length)],
      [{ note: 'x' }, DEFAULT_MASKED],
      [{}, DEFAULT_MASKED],
      [null, DEFAULT_MASKED],
      ['[hidden]', '[hidden]'],
    ] as [unknown, string][]) {
      const options = {
        redactedKeys: ['password'],
        redactFunction: () => returned,
      } as unknown as StringifyValueOptions;

      expect(
        (redactValue({ password: SECRET }, options) as Record<string, unknown>)[
          'password'
        ],
      ).toBe(expected);
      expect(stringifyValue({ password: SECRET }, options)).toBe(
        `{"password":"${expected}"}`,
      );
      expect(
        applyRedaction(
          { password: SECRET },
          ['password'],
          (() => returned) as unknown as RedactFunction,
        )['password'],
      ).toBe(expected);
    }
  });
});

describe('redactValue and stringifyValue stay one implementation', () => {
  test('rendering a redacted value equals redacting while rendering', () => {
    // The documented equivalence, swept over every shape the two walks treat differently
    // rather than spot-checked. `stringifyValue(v, o)` is defined as
    // `stringifyTemplateValue(redactValue(v, o))`, so any divergence means one of them
    // grew a rule the other does not have - which is how a value came to be masked one
    // way in a log line and another in a rendered error.
    const cases: [string, () => unknown, string[]][] = [
      [
        'nested plain object',
        () => ({ user: { password: SECRET, n: 1 } }),
        ['user.password'],
      ],
      ['named array', () => ({ t: [SECRET, 'anothersecret'] }), ['t']],
      ['named container', () => ({ u: { a: SECRET, b: [1, 2] } }), ['u']],
      ['Date beside a secret', () => ({ d: new Date(0), p: SECRET }), ['p']],
      [
        'Error beside a secret',
        () => ({ e: new Error('boom'), p: SECRET }),
        ['p'],
      ],
      [
        'Map beside a secret',
        () => ({ m: new Map([['a', 1]]), p: SECRET }),
        ['p'],
      ],
      ['named URL', () => ({ u: new URL('https://x.test/?k=SECRET') }), ['u']],
      ['named number', () => ({ n: 1234567890 }), ['n']],
      ['named bigint', () => ({ b: 123456789012345n }), ['b']],
      ['named function', () => ({ f: function secretFn() {} }), ['f']],
      ['nothing matched', () => ({ a: 1, b: { c: 2 } }), ['zzz']],
      [
        'indexed path',
        () => ({ items: [{ token: SECRET }] }),
        ['items[0].token'],
      ],
      ['unusable list', () => ({ p: SECRET }), [1 as never]],
      ['root is an array', () => [{ token: SECRET }], ['[0].token']],
    ];

    for (const [label, build, redactedKeys] of cases) {
      const direct = stringifyValue(build(), { redactedKeys });
      const twoStep = stringifyValue(redactValue(build(), { redactedKeys }));

      expect(`${label}: ${direct}`).toBe(`${label}: ${twoStep}`);
    }
  });

  test('an unreadable element degrades alone in both walks', () => {
    // One throwing element, run through each walk over the *same hostile original* -
    // which is the only way the two can be compared at all. The renderer degrades that
    // element and keeps its siblings; masking a named container used to have no
    // per-entry guard, so the same array collapsed whole to the marker.
    const hostileArray = (): unknown[] => {
      const array: unknown[] = [SECRET];

      Object.defineProperty(array, '1', {
        get() {
          throw new Error('unreadable element');
        },
        enumerable: true,
        configurable: true,
      });
      array.length = 2;

      return array;
    };

    // The rendering walk, over the hostile value itself: the bad element alone degrades.
    const rendered = stringifyValue({ t: hostileArray() });

    expect(rendered).toContain('[unrenderable: value]');
    expect(rendered).toContain(SECRET);

    // The redaction walk, over an equally hostile value: same place, same shape.
    const masked = redactValue(
      { t: hostileArray() },
      { redactedKeys: ['t'] },
    ) as Record<string, unknown>;

    expect(Array.isArray(masked['t'])).toBe(true);
    expect((masked['t'] as unknown[]).length).toBe(2);
    expect((masked['t'] as unknown[])[0]).not.toBe(SECRET);
    expect((masked['t'] as unknown[])[1]).toBe('***REDACTION FAILED***');
    expect(JSON.stringify(masked)).not.toContain(SECRET);
  });

  test('an unreadable entry is marked where it sits in both walks', () => {
    // Each value is read inside its own guard, so a getter that throws costs only its
    // own entry. Both walks mark that entry where it sits and keep every sibling - the
    // agreement asserted here over the hostile original in each case, not over a copy
    // one of them already sanitized.
    const hostile = (): Record<string, unknown> => {
      const value: Record<string, unknown> = { good: SECRET };

      Object.defineProperty(value, 'bad', {
        get() {
          throw new Error('unreadable entry');
        },
        enumerable: true,
      });

      return value;
    };

    const rendered = stringifyValue({ u: hostile(), keep: 'visible' });

    expect(rendered).toContain('[unrenderable: value]');
    expect(rendered).toContain('visible');
    // The readable sibling survives, exactly as it does in the array case above. Nothing
    // asked for masking on this call, so `SECRET` here is an ordinary value and printing
    // it is the point: the object branch used to read its entries with a single
    // `Object.entries`, so one throwing getter collapsed the whole object to
    // `[unrenderable]` and took `good` down with it. That looked like the secret being
    // withheld and was nothing of the kind - it was every sibling being lost. The masking
    // guarantee is asserted below, where redaction is actually requested.
    expect(rendered).toContain(SECRET);

    const masked = redactValue(
      { u: hostile(), keep: 'visible' },
      { redactedKeys: ['u'] },
    ) as Record<string, unknown>;

    // A named container is masked leaf by leaf, so the readable entry is masked and only
    // the one whose read threw carries the failure marker.
    expect(masked['u']).toEqual({
      good: 'h***********t',
      bad: '***REDACTION FAILED***',
    });
    expect(masked['keep']).toBe('visible');
    expect(stringifyValue(masked)).not.toContain(SECRET);
  });
});

describe('redactValue - reporting why redaction failed', () => {
  // Failing closed is only half the job. The marker says *that* redaction failed and is
  // deliberately distinct from an ordinary mask, but the thrown error used to be
  // discarded outright - so a `redactFunction` that threw for one key out of forty left a
  // marker in one slot and nothing at all to trace it with.
  //
  // Reported through a dedicated callback rather than the global `'error'` channel every
  // other failure in this library uses, because that channel loops here: a listening
  // logger logs the report, logging renders a message, rendering redacts, and redaction
  // throws again. Each pass is a fresh turn, so no re-entrancy guard closes it.
  const boom = (): never => {
    throw new Error('redactor exploded');
  };

  const collect = (
    value: unknown,
    redactedKeys: string[],
    redactFunction?: unknown,
  ): { reports: [string, string][]; result: unknown } => {
    const reports: [string, string][] = [];
    const result = redactValue(value, {
      redactedKeys,
      redactFunction,
      onFormatError: (error: Error, _kind: string, key: string) =>
        reports.push([key, error.message]),
    } as unknown as StringifyValueOptions);

    return { reports, result };
  };

  test('a throwing redactFunction is reported with its cause and key', () => {
    const { reports, result } = collect(
      { user: { password: SECRET } },
      ['user.password'],
      boom,
    );

    expect(reports).toEqual([['user.password', 'redactor exploded']]);
    // The key is the entry as written, not the leaf, so it matches what was configured.
    expect(JSON.stringify(result)).toContain('***REDACTION FAILED***');
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  test('an unusable redactedKeys list is reported too', () => {
    const { reports } = collect({ password: SECRET }, 'password' as never);

    expect(reports.length).toBe(1);
    expect(reports[0]?.[0]).toBe('<redactedKeys>');
  });

  test('fires at most once, however many leaves fail', () => {
    // The bound is the point, not a nicety: a failure is raised per leaf, so an
    // unconditional throw would otherwise report once for every value inside a named
    // container - thousands of lines for one broken function.
    const { reports, result } = collect(
      { creds: { a: SECRET, b: SECRET, c: SECRET, d: [SECRET, SECRET] } },
      ['creds'],
      boom,
    );

    expect(reports.length).toBe(1);
    // Every leaf still marked, so the output shows the full extent.
    expect(JSON.stringify(result).match(/REDACTION FAILED/g)?.length).toBe(5);
  });

  test('nothing is reported when redaction succeeds', () => {
    const { reports, result } = collect({ password: SECRET }, ['password']);

    expect(reports).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  test('a handler that throws costs the report, not the redaction', () => {
    // A handler for failures must not be able to turn one into two.
    expect(() =>
      redactValue(
        { password: SECRET },
        {
          redactedKeys: ['password'],
          redactFunction: boom,
          onFormatError: () => {
            throw new Error('handler exploded');
          },
        },
      ),
    ).not.toThrow();

    const masked = redactValue(
      { password: SECRET },
      {
        redactedKeys: ['password'],
        redactFunction: boom,
        onFormatError: () => {
          throw new Error('handler exploded');
        },
      },
    );

    expect(JSON.stringify(masked)).toContain('***REDACTION FAILED***');
    expect(JSON.stringify(masked)).not.toContain(SECRET);
  });

  test('the marker is unchanged by any of this', () => {
    // The diagnostic is additive. Output with a handler must equal output without one.
    const withHandler = collect(
      { password: SECRET },
      ['password'],
      boom,
    ).result;
    const withoutHandler = redactValue(
      { password: SECRET },
      {
        redactedKeys: ['password'],
        redactFunction: boom,
      },
    );

    expect(JSON.stringify(withHandler)).toBe(JSON.stringify(withoutHandler));
  });
});

describe('redactValue - a config that names no setting', () => {
  // The shape the deferral rule was built for, and the one it originally missed. A config
  // assembled conditionally does not come out `{}` in practice - it comes out
  // `{ percent: cond ? 10 : undefined }`, which has a key. Classifying on key *presence*
  // sent it through the masker and so past the derived-value rule, which is exactly the
  // leak `{}` was routed away from: the same `URL` back with its query intact.
  const derived = (returned: unknown, value: unknown): unknown =>
    (
      redactValue({ v: value }, {
        redactedKeys: ['v'],
        redactFunction: () => returned,
      } as unknown as StringifyValueOptions) as Record<string, unknown>
    )['v'];

  const url = new URL('https://api.x.test/v1?api_key=sk_live_abcdef123456');

  test('a key set to undefined is not a setting', () => {
    for (const returned of [
      { percent: undefined },
      { maskChar: undefined },
      { strategy: undefined },
      { percent: undefined, maskChar: undefined },
    ]) {
      // Identical to `{}` and to `null`, on a derived value and on a string alike.
      expect(derived(returned, url)).toBe('***REDACTED***');
      expect(derived(returned, url)).toBe(derived({}, url));
      expect(derived(returned, 4111111111111111)).toBe('***REDACTED***');
      expect(derived(returned, SECRET)).toBe(derived(null, SECRET));
    }
  });

  test('one real setting beside an undefined one still counts', () => {
    // Only "no settings at all" defers; a config that names something is honoured.
    expect(derived({ percent: 100, maskChar: undefined }, SECRET)).toBe(
      '*'.repeat(SECRET.length),
    );
  });

  test('a non-finite number defers rather than being emitted', () => {
    // `Number(process.env.MASK_PERCENT)` reaches here. A bare `NaN` used to be used
    // literally and serialize to `null`, while `{ percent: NaN }` already fell back to the
    // default - two spellings of the same thing disagreeing.
    for (const returned of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(derived(returned, SECRET)).toBe(derived(null, SECRET));
      expect(derived(returned, url)).toBe('***REDACTED***');
    }

    expect(derived({ percent: Number.NaN }, SECRET)).toBe(
      derived(null, SECRET),
    );
  });
});

describe('a shared subtree costs one walk, not one per route', () => {
  /** `levels` nestings of `{ l: child, r: child }`: `levels + 1` objects, `2^levels` routes. */
  function sharedGraph(levels: number): unknown {
    let node: unknown = { leaf: 'x' };

    for (let index = 0; index < levels; index++) {
      node = { l: node, r: node };
    }

    return node;
  }

  test('redaction does not walk every route through it', () => {
    // 31 objects, 2^30 routes. Walked per route this took roughly 44 seconds; walked per
    // node it is immediate. A generous ceiling, so the test fails on the shape of the
    // regression rather than on a slow machine.
    const start = performance.now();

    const redacted = redactValue(
      { data: sharedGraph(30), password: SECRET },
      { redactedKeys: ['password'] },
    ) as Record<string, unknown>;

    expect(performance.now() - start).toBeLessThan(2000);
    expect(redacted['password']).not.toBe(SECRET);
  });

  test('a shared subtree holding a getter is snapshotted once, not per route', () => {
    // A getter stops the subtree being handed back by reference - it has to, or the second
    // read leaks (see the accessor tests below) - and that made every node on the way up
    // rebuild. Rebuilt per *route*, 30 levels of sharing is 2^30 copies and never
    // finishes; the memo records the copy as well as the untouched answer, so it is one
    // copy per node and the sharing survives into the output.
    const leaf = {
      get counted(): string {
        return 'x';
      },
    };

    let node: unknown = leaf;

    for (let index = 0; index < 30; index++) {
      node = { l: node, r: node };
    }

    const start = performance.now();

    const redacted = redactValue(
      { data: node, password: SECRET },
      { redactedKeys: ['password'] },
    ) as { data: { l: unknown; r: unknown } };

    expect(performance.now() - start).toBeLessThan(2000);
    expect(redacted.data.l).toBe(redacted.data.r);
  });

  test('the scan reads each node once, however many references reach it', () => {
    let reads = 0;
    const leaf = {
      get counted(): number {
        reads++;

        return 1;
      },
    };

    let node: unknown = leaf;

    for (let index = 0; index < 12; index++) {
      node = { l: node, r: node };
    }

    // No path points below `data`, so the whole subtree is scanned and then handed back
    // untouched. One read per node, not one per route.
    redactValue(
      { data: node, password: SECRET },
      { redactedKeys: ['password'] },
    );

    expect(reads).toBe(1);
  });

  test('a cycle below the scan root does not recurse until the stack gives out', () => {
    let reads = 0;
    const inner = {
      get counted(): number {
        reads++;

        return 1;
      },
    };

    const a: Record<string, unknown> = { inner };
    a['b'] = { a };

    // The loop closes inside `data`, not back into an ancestor, so the scan must
    // recognize it rather than recursing to a `RangeError`. Unrecognized it ran this
    // getter 12,511 times.
    redactValue({ data: a, password: SECRET }, { redactedKeys: ['password'] });

    expect(reads).toBe(1);
  });

  test('rendering a shared subtree is bounded rather than exponential', () => {
    // 23 objects, 2^22 routes: rendered per route this was 96 MB of JSON.
    const rendered = stringifyValue(sharedGraph(22));

    expect(rendered.length).toBeLessThan(2_000_000);
    expect(rendered).toContain('[max length exceeded]');
  });

  test('one oversized leaf is cut at the cap rather than emitted whole', () => {
    // The case the cap used to miss entirely. The marker only ever landed on the entry
    // *after* an oversized one, so a single huge value - the only key, or the last one -
    // rendered in full and said nothing: 10 MB out of a 1 MB budget.
    const rendered = stringifyValue({ blob: 'x'.repeat(10_000_000) });

    expect(rendered.length).toBeLessThan(1_100_000);
    expect(rendered).toContain('[max length exceeded]');
  });

  test('a leaf that renders through its own toString is bounded too', () => {
    // Not a raw string, so it reached the budget only as something already produced: a
    // `toString` returning ten megabytes was charged for and emitted whole.
    class Huge {
      public toString(): string {
        return 'h'.repeat(10_000_000);
      }
    }

    const rendered = stringifyValue({ v: new Huge() });

    expect(rendered.length).toBeLessThan(1_100_000);
    expect(rendered).toContain('[max length exceeded]');
  });

  test('escaping cannot expand a cut leaf past the budget', () => {
    // Cutting the raw value and quoting afterwards charges the cut length and emits the
    // escaped one. A million NUL characters escape to six bytes each, so a value cut to a
    // megabyte went out as six.
    const nul = String.fromCharCode(0).repeat(1_000_000);

    const rendered = stringifyValue({ v: nul });

    expect(rendered.length).toBeLessThan(1_100_000);
    expect(rendered).toContain('[max length exceeded]');
    expect(() => JSON.parse(rendered) as unknown).not.toThrow();
  });

  test('a truncated object is still JSON', () => {
    // The truncation marker is the value of the key it cut, not an entry of its own.
    // Pushed bare among `"key":value` parts it produced `{"a":"...","[max length
    // exceeded]"}`, which `JSON.parse` refuses - though rendering a plain object as JSON
    // is this function's whole contract. An array never had the problem: a bare element
    // is legal there.
    const huge = 'y'.repeat(600_000);

    const object = stringifyValue({ a: huge, b: huge, c: 'tail' });
    const array = stringifyValue([huge, huge, 'tail']);

    expect(() => JSON.parse(object) as unknown).not.toThrow();
    expect(() => JSON.parse(array) as unknown).not.toThrow();
    // The key that was cut is named, so the reader learns where the render stopped.
    expect(object).toContain('"c":"[max length exceeded]"');
  });

  test('an ordinary value is nowhere near the length cap', () => {
    const rendered = stringifyValue({
      user: 'alice',
      roles: ['admin', 'ops'],
      meta: { attempts: 3, at: new Date(0) },
    });

    expect(rendered).not.toContain('[max length exceeded]');
    expect(rendered).toContain('"user":"alice"');
    expect(rendered).toContain('"attempts":3');
  });

  describe('onFormatError', () => {
    test('should report why a value could not be rendered, without leaking it', () => {
      // The marker in the output says a value refused; this is where the cause goes. The
      // two are asserted together because the split is the design: a getter is caller
      // code and may throw a message carrying the value it was hiding, so the rendered
      // string gets the neutral marker and the handler gets the error.
      const seen: string[] = [];
      const hostile = (): Record<string, unknown> => {
        const bag: Record<string, unknown> = { safe: 'kept' };

        Object.defineProperty(bag, 'token', {
          get() {
            throw new Error('accessor refused: hunter2secret');
          },
          enumerable: true,
        });

        return bag;
      };

      const rendered = stringifyValue(
        { user: hostile() },
        {
          onFormatError: (error, _kind, path) =>
            seen.push(`${path}|${error.message}`),
        },
      );

      expect(seen).toHaveLength(1);
      expect(seen[0]).toContain('<value>.user.token');
      expect(seen[0]).toContain('accessor refused');

      expect(rendered).toContain('[unrenderable: value]');
      expect(rendered).toContain('kept');
      expect(rendered).not.toContain('hunter2secret');
    });

    test('tells a redaction failure apart from a render failure by kind', () => {
      // The whole reason these are one callback rather than two: both come from the same
      // walk over the same value and address it with the same structural path, so the only
      // thing that ever differed was which stage threw. A caller who cares about that - a
      // broken `redactFunction` is a masking bug, an unreadable value is not - reads
      // `kind`; a caller who does not gets one handler instead of two.
      //
      // Two calls rather than one value that fails both ways: a redaction failure fails
      // closed over the whole container, so nothing is left for the render to trip on.
      const seen: [string, string][] = [];
      const record = (_error: Error, kind: string, path: string): void => {
        seen.push([kind, path]);
      };

      stringifyValue(
        { password: 'hunter2' },
        {
          redactedKeys: ['password'],
          redactFunction: () => {
            throw new Error('redactor refused');
          },
          onFormatError: record,
        },
      );

      const bag: Record<string, unknown> = { safe: 'kept' };

      Object.defineProperty(bag, 'token', {
        get() {
          throw new Error('accessor refused');
        },
        enumerable: true,
      });

      stringifyValue(bag, { onFormatError: record });

      expect(seen).toEqual([
        ['redaction', 'password'],
        ['render', '<value>.token'],
      ]);
    });

    test('fires once per kind for the whole call, and roots both walks the same way', () => {
      // `stringifyValue` renders what `redactValue` returns, so the two halves are one
      // operation - but each built its own `'render'` reporter, so the call had two
      // once-per-kind budgets and a value that refused to render in both halves reported
      // twice against a contract that promises once. The paths disagreed too: the redaction
      // walk handed back the caller's own entry, bare, while the render walk rooted its
      // path at `<value>` - and only the rooted form is one `curlyBrackets` can re-root, so
      // a template author was told `a` where the same failure elsewhere said `user.a`.
      const seen: [string, string][] = [];
      // Not a plain object: a plain one is walked, and its `toString` is just a member.
      // A class instance is a leaf, which is what a render can trip over.
      const unrenderable = (): unknown =>
        new (class Hostile {
          public toString(): string {
            throw new Error('toString refused');
          }
        })();

      stringifyValue(
        { a: unrenderable(), b: unrenderable() },
        {
          redactedKeys: ['a'],
          onFormatError: (_error, kind, path) => seen.push([kind, path]),
        },
      );

      expect(seen).toEqual([['render', '<value>.a']]);
    });

    test('should fall back to the console without a handler, and never throw', () => {
      // With no handler, this uses the standard host path and eventually its guarded
      // console terminal. A broken `console.error` costs the report and not the render.
      const consoleError = console.error;
      const lines: string[] = [];

      console.error = (...args: unknown[]): void => {
        lines.push(args.map((arg) => String(arg)).join(' '));
      };

      try {
        const hostile = (): Record<string, unknown> => {
          const bag: Record<string, unknown> = { safe: 'kept' };

          Object.defineProperty(bag, 'token', {
            get() {
              throw new Error('accessor refused');
            },
            enumerable: true,
          });

          return bag;
        };

        expect(() => stringifyValue({ user: hostile() })).not.toThrow();
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain('<value>.user.token');

        // And a console that itself throws must not turn one failure into two.
        console.error = (): void => {
          throw new Error('stdout gone');
        };

        expect(() => stringifyValue({ user: hostile() })).not.toThrow();
      } finally {
        console.error = consoleError;
      }
    });
  });
});

describe('a key is a variable-length leaf too', () => {
  test('an enormous key cannot blow past the length cap', () => {
    // `charge` bills a string and hands it back *whole*, which bounds how many keys a
    // render emits and says nothing about the length of one. The commit that cut "every
    // variable-length leaf" applied that to values and left keys on the billing-only
    // path: a five-megabyte key returned 5,000,028 characters against a 1,000,000 cap.
    const rendered = stringifyValue({ ['k'.repeat(5_000_000)]: 1 });

    expect(rendered.length).toBeLessThan(1_100_000);
    // Still JSON, because the cut happens inside the quotes rather than to them.
    expect(() => JSON.parse(rendered) as unknown).not.toThrow();
  });

  test('escaping cannot expand a cut key past the budget', () => {
    // The same bug the value side was fixed for, on the key side: `capKey` cuts the raw
    // key and the quoting happens after, so a million NUL characters - six characters each
    // once quoted - were cut to the cap and emitted at six times it. The identical string
    // as a value had been charged what it emits since `quoteWithinBudget` went in.
    const nul = String.fromCharCode(0).repeat(1_000_000);

    const rendered = stringifyValue({ [nul]: 1 });

    expect(rendered.length).toBeLessThan(1_100_000);
    expect(() => JSON.parse(rendered) as unknown).not.toThrow();
  });

  test('the output does not scale with how large the key was', () => {
    const small = stringifyValue({ ['k'.repeat(5_000_000)]: 1 }).length;
    const large = stringifyValue({ ['k'.repeat(20_000_000)]: 1 }).length;

    expect(large).toBe(small);
  });

  test('an ordinary key is never touched, whatever the budget is doing', () => {
    // A key does not only carry text, it names *where* the render stopped. Cutting it
    // against a budget that is already spent replaced that name with the marker too.
    const huge = 'y'.repeat(600_000);
    const rendered = stringifyValue({ a: huge, b: huge, c: 'tail' });

    expect(rendered).toContain('"c":"[max length exceeded]"');
  });
});

describe('an unparseable redactedKeys entry is reported', () => {
  it('names the entry as written, on the redaction channel, and masks nothing else', () => {
    const seen: string[] = [];

    const result = redactValue(
      { users: [{ password: 'hunter2' }], keep: 'diag' },
      {
        redactedKeys: ['users[0].password.'],
        onFormatError: (_error, kind, key) => seen.push(`${kind}:${key}`),
      },
    );

    expect(result).toEqual({ users: [{ password: 'hunter2' }], keep: 'diag' });
    expect(seen).toEqual(['redaction:users[0].password.']);
  });

  it('stays silent for a valid path that misses', () => {
    const seen: string[] = [];

    stringifyValue(
      { name: 'alice' },
      {
        redactedKeys: ['user.password'],
        onFormatError: (_error, kind, key) => seen.push(`${kind}:${key}`),
      },
    );

    expect(seen).toEqual([]);
  });
});

describe('maxRenderLength and onTruncate', () => {
  const big = 'x'.repeat(2_000_000);

  it('reports each reason through the one channel', () => {
    const cyclic: Record<string, unknown> = { a: 1 };

    cyclic.self = cyclic;

    let deep: Record<string, unknown> = {};

    const deepRoot = deep;

    for (let level = 0; level < 200; level++) {
      deep = deep.n = {};
    }

    const reasons = [big, deepRoot, cyclic].map((value) => {
      const cuts: TruncationInfo[] = [];

      stringifyValue(value, { onTruncate: (info) => cuts.push(info) });

      return cuts[0]?.reason;
    });

    expect(reasons).toEqual(['length', 'depth', 'circular']);
  });

  it('only counts characters for a length cut', () => {
    // A cycle and a depth cap drop a subtree that was never rendered, so nothing measured
    // it - `undefined` rather than a zero that reads as "nothing was lost".
    const cyclic: Record<string, unknown> = {};

    cyclic.self = cyclic;

    const lengthCuts: TruncationInfo[] = [];
    const cycleCuts: TruncationInfo[] = [];

    stringifyValue(big, { onTruncate: (info) => lengthCuts.push(info) });
    stringifyValue(cyclic, { onTruncate: (info) => cycleCuts.push(info) });

    expect(lengthCuts[0]?.dropped).toBe(1_000_000);
    expect(cycleCuts[0]?.dropped).toBeUndefined();
  });

  it('shares one allowance between masking and the render', () => {
    // Without the shared budget a `redactFunction` answering oversized replacements got a
    // fresh cap of its own, so `maxRenderLength` bounded only half the operation.
    const params: Record<string, string> = {};

    for (let index = 0; index < 20; index++) {
      params[`k${String(index)}`] = 'secret';
    }

    const cuts: TruncationInfo[] = [];

    stringifyValue(params, {
      redactedKeys: Object.keys(params),
      redactFunction: () => 'R'.repeat(500_000),
      onTruncate: (info) => cuts.push(info),
    });

    expect(cuts).toHaveLength(1);
    expect(cuts[0]?.reason).toBe('length');
  });

  it('bounds redactValue too, which renders every leaf it masks', () => {
    const params: Record<string, string> = {};

    for (let index = 0; index < 20; index++) {
      params[`k${String(index)}`] = 'secret';
    }

    const cuts: TruncationInfo[] = [];

    redactValue(params, {
      redactedKeys: Object.keys(params),
      redactFunction: () => 'R'.repeat(500_000),
      maxRenderLength: 100_000,
      onTruncate: (info) => cuts.push(info),
    });

    expect(cuts).toHaveLength(1);
  });

  it('sends an onTruncate handler that throws to the console, and keeps the render', () => {
    // The one callback in the logger whose breakage was swallowed outright. It stands on
    // the same rung as `onFormatError` now: the render is unaffected, and the console
    // says the handler is broken so its silence is not mistaken for a complete render.
    const consoleErrors = muteConsoleError();

    try {
      const rendered = stringifyValue(big, {
        maxRenderLength: 1_000,
        onTruncate: () => {
          throw new Error('truncation handler exploded');
        },
      });

      expect(rendered.endsWith(TRUNCATED_LENGTH)).toBe(true);
      expect(
        consoleErrors.some((line) =>
          line.includes('truncation handler exploded'),
        ),
      ).toBe(true);
    } finally {
      restoreConsoleError();
    }
  });

  it('holds the cap when escaping density is front-loaded', () => {
    // The ratio cut estimates the prefix from the average expansion, and a value whose
    // escaping sits at the front defeats the estimate: each pass shrinks towards the dense
    // part, so each lands closer and none land. Four passes over two hundred thousand NULs
    // ahead of plain text returned 1.2 million characters under a one-million cap - a
    // bound the documentation promises for untrusted values, off by a fifth.
    const limit = 1_000_000;
    const rendered = stringifyValue(
      { v: '\0'.repeat(200_000) + 'a'.repeat(900_000) },
      { maxRenderLength: limit },
    );

    // The documented marker overhead, and no more.
    expect(rendered.length).toBeLessThanOrEqual(
      limit + TRUNCATED_LENGTH.length,
    );
    expect(rendered).toContain(TRUNCATED_LENGTH);
    // Not vacuous: the value really was cut to the cap rather than to nothing.
    expect(rendered.length).toBeGreaterThan(limit - 1_000);
  });

  it('cuts an oversized redactFunction replacement to maxRenderLength in the structure', () => {
    // Charging the excess degraded the siblings after an oversized replacement, but the
    // replacement itself was handed back whole: `redactValue` returned a half-megabyte
    // leaf under a ten-thousand-character cap while `onTruncate` reported the bound had
    // held. The text render was bounded on its second pass; the structure a caller keeps
    // had no second pass.
    const cuts: TruncationInfo[] = [];

    const result = redactValue(
      { a: 'secret' },
      {
        redactedKeys: ['a'],
        redactFunction: () => 'R'.repeat(500_000),
        maxRenderLength: 10_000,
        onTruncate: (info) => cuts.push(info),
      },
    ) as { a: string };

    expect(result.a.length).toBeLessThanOrEqual(
      10_000 + TRUNCATED_LENGTH.length,
    );
    expect(result.a.endsWith(TRUNCATED_LENGTH)).toBe(true);
    expect(result.a.startsWith('RRRR')).toBe(true);
    expect(cuts).toHaveLength(1);
    expect(cuts[0]?.reason).toBe('length');
    expect(cuts[0]?.dropped).toBeGreaterThan(400_000);
  });

  it('lets a replacement past the fixed constant through under Infinity', () => {
    // The pre-cut in `resolveRedaction` was at the fixed constant whatever the caller
    // asked for, so `maxRenderLength: Infinity` - the documented "unlimited" - still cut
    // a replacement at a million characters, and a cap raised above the constant was
    // lowered back to it.
    const cuts: TruncationInfo[] = [];

    const result = redactValue(
      { a: 'secret' },
      {
        redactedKeys: ['a'],
        redactFunction: () => 'R'.repeat(1_500_000),
        maxRenderLength: Number.POSITIVE_INFINITY,
        onTruncate: (info) => cuts.push(info),
      },
    ) as { a: string };

    expect(result.a.length).toBe(1_500_000);
    expect(cuts).toHaveLength(0);

    const raised = redactValue(
      { a: 'secret' },
      {
        redactedKeys: ['a'],
        redactFunction: () => 'R'.repeat(1_500_000),
        maxRenderLength: 2_000_000,
      },
    ) as { a: string };

    expect(raised.a.length).toBe(1_500_000);
  });

  it("leaves a replacement that fits the caller's cap whole", () => {
    // The cut is against what the caller allowed, not the fixed constant, and a
    // replacement under it is what the caller asked to appear.
    const cuts: TruncationInfo[] = [];

    const result = redactValue(
      { a: 'secret' },
      {
        redactedKeys: ['a'],
        redactFunction: () => 'R'.repeat(5_000),
        maxRenderLength: 10_000,
        onTruncate: (info) => cuts.push(info),
      },
    ) as { a: string };

    expect(result.a).toBe('R'.repeat(5_000));
    expect(cuts).toHaveLength(0);
  });

  it('bounds the sum of replacements across redactedParams siblings', () => {
    // Each leaf's replacement is cut against what the siblings before it left, so the
    // structure as a whole stays inside the cap rather than each leaf separately.
    const params: Record<string, string> = {};

    for (let index = 0; index < 20; index++) {
      params[`k${String(index)}`] = 'secret';
    }

    const result = redactValue(params, {
      redactedKeys: Object.keys(params),
      redactFunction: () => 'R'.repeat(50_000),
      maxRenderLength: 100_000,
    }) as Record<string, string>;

    const total = Object.values(result).reduce(
      (sum, leaf) => sum + leaf.length,
      0,
    );

    // The input leaves and the structure's own delimiters are charged too, so the total
    // sits a little over the cap, never at twenty times it.
    expect(total).toBeLessThan(110_000);
    expect(total).toBeGreaterThan(90_000);
  });

  it('overshoots a tiny cap by a bounded number of markers, never by the payload', () => {
    // The cap bounds content and the markers sit on top of it uncharged, so the output
    // can exceed `maxRenderLength` - but only by a fixed few markers, whatever the size
    // or shape of the value. A thousand keys, twenty levels, or a thousand elements past
    // a spent budget must not each leave a marker.
    const wide: Record<string, string> = {};

    for (let index = 0; index < 1_000; index++) {
      wide[`k${String(index)}`] = 'v'.repeat(50);
    }

    const deep: Record<string, unknown> = {};
    let cursor = deep;

    for (let index = 0; index < 20; index++) {
      const next: Record<string, unknown> = { s: 'x'.repeat(50) };

      cursor['n'] = next;
      cursor = next;
    }

    const list = new Array<string>(1_000).fill('abcdef');

    for (const cap of [1, 10, 100]) {
      // Three markers and a little structure is the most any of these shapes leaves.
      const bound = cap + 3 * TRUNCATED_LENGTH.length + 16;

      expect(
        stringifyValue(wide, { maxRenderLength: cap }).length,
      ).toBeLessThanOrEqual(bound);
      expect(
        stringifyValue(deep, { maxRenderLength: cap }).length,
      ).toBeLessThanOrEqual(bound);
      expect(
        stringifyValue(list, { maxRenderLength: cap }).length,
      ).toBeLessThanOrEqual(bound);
      expect(
        stringifyValue('z'.repeat(500), { maxRenderLength: cap }).length,
      ).toBeLessThanOrEqual(cap + TRUNCATED_LENGTH.length);
    }
  });

  it('honours Infinity and falls back on anything else unusable', () => {
    expect(
      stringifyValue(big, { maxRenderLength: Number.POSITIVE_INFINITY }).length,
    ).toBe(2_000_000);

    for (const bad of [-1, 0, Number.NaN, '5000', undefined]) {
      expect(
        stringifyValue(big, { maxRenderLength: bad as number | undefined })
          .length,
      ).toBeLessThan(1_100_000);
    }
  });

  it("holds keys to the caller's allowance, not to the fixed cap", () => {
    // Keys were cut against `MAX_RENDER_LENGTH` whatever the caller asked for, and the
    // cut was never reported: `maxRenderLength: Infinity` still came back at 1,000,004
    // characters with `onTruncate` silent, so the documented "unlimited" was false for
    // the one leaf nothing else bounds.
    const cuts: TruncationInfo[] = [];
    const wide = { ['k'.repeat(5_000_000)]: 1 };

    expect(
      stringifyValue(wide, { maxRenderLength: Number.POSITIVE_INFINITY })
        .length,
    ).toBeGreaterThan(5_000_000);

    const bounded = stringifyValue(wide, {
      onTruncate: (info) => cuts.push(info),
    });

    expect(bounded.length).toBeLessThan(1_100_000);
    expect(cuts).toHaveLength(1);
    expect(cuts[0]?.dropped).toBeGreaterThan(3_000_000);
  });

  it('does not reopen the allowance for every oversized key', () => {
    // Each key was measured against a cap none of its siblings had spent, so two 900 KB
    // keys emitted 1,800,011 characters against a 1,000,000 cap - and any number of them
    // scaled from there.
    const many: Record<string, number> = {};

    for (const letter of ['a', 'b', 'c']) {
      many[letter.repeat(900_000)] = 1;
    }

    expect(stringifyValue(many).length).toBeLessThan(1_100_000);
  });

  it('does not shrink the cap when a value is redacted', () => {
    // Masking and the render shared one budget, so a masked leaf was charged twice - once
    // as it was replaced and once as it was emitted - and redacting one key took the
    // effective cap from 1,000,000 characters to 400,028.
    const value = { a: 'x'.repeat(600_000), b: 'y'.repeat(600_000) };

    expect(stringifyValue(value, { redactedKeys: ['a'] }).length).toBe(
      stringifyValue(value).length,
    );
  });

  it('reports a named container that gave up on its tail', () => {
    // The object branch of the masking walk was the one stopping point that broke out
    // with a placeholder and counted nothing, so a mask cut short answered `truncations:
    // 0` while the equivalent array reported the cut.
    const many: Record<string, string> = {};

    for (let index = 0; index < 50; index++) {
      many[`k${String(index)}`] = 'secret';
    }

    const cuts: TruncationInfo[] = [];

    redactValue(many, {
      redactedKeys: Object.keys(many),
      maxRenderLength: 40,
      onTruncate: (info) => cuts.push(info),
    });

    expect(cuts).toHaveLength(1);
    expect(cuts[0]?.reason).toBe('length');
  });

  it('does not route truncation through onFormatError', () => {
    const failures: unknown[] = [];

    stringifyValue(big, { onFormatError: (error) => failures.push(error) });

    expect(failures).toHaveLength(0);
  });
});

/**
 * The pin `applyRedaction` has in `redaction.fail-closed.test.ts`, on the two entry points
 * that share the pass since it moved into `internal/`. The one catch no input can reach:
 * every read inside `normalizeAlongRedactPaths` is guarded, so the fault is injected at
 * its only seam, the prefix tree `redactPathPrefixes` builds.
 */
describe('stringifyValue / redactValue - a throw out of nested-path normalization', () => {
  test('fails closed on the whole value rather than walking a part-normalized bag', () => {
    const original = { ...redactPaths };

    void mock.module('./internal/redact-paths', () => ({
      ...original,
      redactPathPrefixes: () => {
        throw new Error('prefix tree refused');
      },
    }));

    try {
      const value = {
        user: { password: 'hunter2secret' },
        token: 'abc123secret',
        other: 'safe',
      };
      const redactedKeys = ['user.password', 'token'];
      const reported: string[] = [];
      const onFormatError = (error: Error, kind: string, key: string): void => {
        reported.push(`${kind}:${key}:${error.message}`);
      };

      const masked = redactValue(value, { redactedKeys, onFormatError });

      // A throw must not let the walk continue: the bag may hold an alias under one key
      // and not yet under its sibling. The whole value is withheld, nothing inspected.
      expect(masked).toBe(REDACTION_FAILED_MARKER);
      expect(JSON.stringify(masked)).not.toContain('secret');

      const rendered = stringifyValue(value, { redactedKeys, onFormatError });

      expect(rendered).toBe(REDACTION_FAILED_MARKER);
      expect(rendered).not.toContain('secret');

      expect(reported).toEqual([
        'redaction:<value>:prefix tree refused',
        'redaction:<value>:prefix tree refused',
      ]);
    } finally {
      void mock.module('./internal/redact-paths', () => ({ ...original }));
    }
  });
});

/**
 * A container whose named member throws on the first read and answers a secret after.
 *
 * The pre-walk normalization reads each container along a named path once into a copy.
 * A read that threw used to be *skipped*, leaving the caller's accessor in the copy for
 * the walk and the renderer to call again - and an accessor that throws once and answers
 * afterwards is exactly the second-read disagreement the pass exists to settle. It is
 * withheld with the marker now, as a container the pass could not copy already was.
 */
const throwsOnceThenAnswers = (
  key: string,
  answer: Record<string, unknown>,
): Record<string, unknown> => {
  let reads = 0;

  return {
    get [key](): Record<string, unknown> {
      reads++;

      if (reads === 1) {
        throw new Error('first read refused');
      }

      return answer;
    },
  };
};

describe('stringifyValue / redactValue - a named member that throws once and answers afterwards', () => {
  test('is withheld with the marker on both entry points', () => {
    const value = (): Record<string, unknown> => ({
      user: throwsOnceThenAnswers('profile', { password: 'hunter2secret' }),
      other: 'safe',
    });
    const redactedKeys = ['user.profile.password'];

    const rendered = stringifyValue(value(), { redactedKeys });

    expect(rendered).not.toContain('secret');
    expect(rendered).toContain(REDACTION_FAILED_MARKER);
    expect(rendered).toContain('safe');

    const masked = redactValue(value(), { redactedKeys }) as Record<
      string,
      Record<string, unknown>
    >;

    expect(JSON.stringify(masked)).not.toContain('secret');
    expect(masked.user?.profile).toBe(REDACTION_FAILED_MARKER);
  });
});

describe('cutAt - a cut inside a character steps back to a boundary', () => {
  test('leaves plain text and a clean cut alone', () => {
    expect(cutAt('abcdef', 3)).toBe('abc');
    expect(cutAt('abcdef', 0)).toBe('');
    expect(cutAt('abcdef', 6)).toBe('abcdef');
    expect(cutAt('abcdef', 99)).toBe('abcdef');
  });

  test('does not leave a combining mark on the far side of the cut', () => {
    // `e` + U+0301: cut between them and the `e` renders unaccented.
    expect(cutAt('ae\u0301b', 2)).toBe('a');
    expect(cutAt('ae\u0301b', 3)).toBe('ae\u0301');
  });

  test('does not split a surrogate pair, a joiner sequence, or a variation selector', () => {
    expect(cutAt('x😀y', 2)).toBe('x');
    // Family: 👨 ZWJ 👩. A cut after the joiner, or between it and the next face, steps
    // back to before the whole sequence.
    expect(cutAt('x\u{1F468}\u200D\u{1F469}', 4)).toBe('x');
    expect(cutAt('x\u{1F468}\u200D\u{1F469}', 5)).toBe('x');
    expect(cutAt('x\u{1F468}\u200D\u{1F469}', 6)).toBe(
      'x\u{1F468}\u200D\u{1F469}',
    );
    // ❤ + U+FE0F, and a thumbs-up with a skin tone.
    expect(cutAt('\u2764\uFE0F', 1)).toBe('');
    expect(cutAt('\u{1F44D}\u{1F3FD}', 2)).toBe('');
  });

  test('does not split a flag', () => {
    // 🇺🇸🇫🇷 is four regional indicators; a cut after three is inside the second flag.
    const flags = '\u{1F1FA}\u{1F1F8}\u{1F1EB}\u{1F1F7}';

    expect(cutAt(flags, 6)).toBe('\u{1F1FA}\u{1F1F8}');
    expect(cutAt(flags, 4)).toBe('\u{1F1FA}\u{1F1F8}');
    expect(cutAt(flags, 2)).toBe('');
  });

  test('a render cut inside a character is still well-formed', () => {
    const rendered = stringifyValue('e\u0301'.repeat(200), {
      maxRenderLength: 7,
    });

    expect(rendered).toContain('[max length exceeded]');
    // Never a bare `e` at the end of the kept text: every kept `e` has its mark.
    expect(rendered.split('[max length exceeded]')[0]).toMatch(/^(e\u0301)*$/);
  });
});

describe('redactValue - an array whose length is not an integer', () => {
  test('is refused rather than walked past both caps', () => {
    // `length > MAX_REDACTION_ENTRIES` was the only guard, and `NaN > 1_000_000` is
    // `false`: a `NaN` length walked straight past it, then seeded the named-key counter
    // with `NaN` so `definedNamed >= MAX_REDACTION_ENTRIES` was false forever too. One lie
    // about `length` disabled both caps at once - and the index loop copied nothing, so
    // the array silently lost every element while the line still looked successful.
    const lyingLength = (target: unknown[]): unknown[] =>
      new Proxy(target, {
        get(t, property, receiver): unknown {
          if (property === 'length') {
            return NaN;
          }

          return Reflect.get(t, property, receiver) as unknown;
        },
      });

    const reports: Array<{ kind: string; path: string }> = [];

    const rendered = stringifyValue(
      { items: lyingLength(['hunter2secret', 'other']) },
      {
        redactedKeys: ['items[0]'],
        onFormatError: (_error, kind, path) => {
          reports.push({ kind, path });
        },
      },
    );

    expect(rendered).not.toContain('hunter2secret');
    expect(rendered).toBe('{"items":"***REDACTION FAILED***"}');
    expect(reports).toEqual([{ kind: 'redaction', path: 'items' }]);
  });
});

describe('redactValue - an array whose length under-reports its contents', () => {
  // A `Proxy` answering a *smaller* `length` than it holds is not the same lie as `NaN`:
  // it stays a safe integer, so it passes the bounds check above and the index loop simply
  // copies fewer slots. The copy is still a real array, and the `Object.keys` pass that
  // follows installs the own index keys the loop skipped - `defineProperty('0', ...)`
  // updates `length` on the way - so the wildcard walk sees every slot after all. These
  // cover that self-correction, which is easy to lose while simplifying the copy: without
  // it, `items[*].token` would expand over nothing while the documented concrete path
  // `items[0].token` still masked.
  const understating = (target: unknown[], length: number): unknown[] =>
    new Proxy(target, {
      get(t, property, receiver): unknown {
        if (property === 'length') {
          return length;
        }

        return Reflect.get(t, property, receiver) as unknown;
      },
      getOwnPropertyDescriptor(t, property): PropertyDescriptor | undefined {
        if (property === 'length') {
          return {
            value: length,
            writable: true,
            enumerable: false,
            configurable: false,
          };
        }

        return Reflect.getOwnPropertyDescriptor(t, property);
      },
    });

  test('a wildcard still masks every slot of a length-0 array holding two', () => {
    const rendered = stringifyValue(
      {
        items: understating(
          [{ token: 'hunter2secret' }, { token: 'othersecret' }],
          0,
        ),
      },
      { redactedKeys: ['items[*].token'] },
    );

    expect(rendered).not.toContain('hunter2secret');
    expect(rendered).not.toContain('othersecret');
  });

  test('a concrete index masks the slot the length denies', () => {
    const rendered = stringifyValue(
      { items: understating([{ token: 'hunter2secret' }], 0) },
      { redactedKeys: ['items[0].token'] },
    );

    expect(rendered).not.toContain('hunter2secret');
  });

  test('a named property beside the denied slots is still carried and masked', () => {
    const withNamed = Object.assign([{ token: 'hunter2secret' }], {
      meta: { token: 'metasecret' },
    });

    const rendered = stringifyValue(
      { items: understating(withNamed, 0) },
      { redactedKeys: ['items[*].token', 'items.meta.token'] },
    );

    expect(rendered).not.toContain('hunter2secret');
    expect(rendered).not.toContain('metasecret');
  });

  test('a back-edge parked at [0] does not leave a sibling in the clear', () => {
    const slots: unknown[] = [];
    const parent: Record<string, unknown> = {
      password: 'hunter2secret',
      items: null,
    };

    slots.push(parent);
    parent['items'] = understating(slots, 0);

    const rendered = stringifyValue(parent, { redactedKeys: ['password'] });

    expect(rendered).not.toContain('hunter2secret');
  });

  test('a negative length is refused outright, as a NaN one is', () => {
    const rendered = stringifyValue(
      { items: understating([{ token: 'hunter2secret' }], -1) },
      { redactedKeys: ['items[*].token'] },
    );

    expect(rendered).not.toContain('hunter2secret');
    expect(rendered).toBe('{"items":"***REDACTION FAILED***"}');
  });

  test('a slot hidden from ownKeys as well is dropped, never rendered', () => {
    // Both traps deny the slot, so nothing can see the value - the element is simply gone
    // from the copy. Data loss rather than a leak, which is the right side to fail on.
    const hidden = new Proxy([{ token: 'hunter2secret' }] as unknown[], {
      get(t, property, receiver): unknown {
        if (property === 'length') {
          return 0;
        }

        return Reflect.get(t, property, receiver) as unknown;
      },
      ownKeys(): ArrayLike<string | symbol> {
        return ['length'];
      },
    });

    const rendered = stringifyValue(
      { items: hidden },
      { redactedKeys: ['items[*].token'] },
    );

    expect(rendered).not.toContain('hunter2secret');
    expect(rendered).toBe('{"items":[]}');
  });
});

/** An options object whose every member read throws. */
const hostileOptions = <T extends object>(): T =>
  new Proxy({} as T, {
    get(): never {
      throw new Error('option read refused');
    },
  });

describe('stringifyValue / redactValue - an options object that refuses to be read', () => {
  test('falls back to the defaults rather than throwing', () => {
    // Every option here is refused, `redactedKeys` included, so the fail-closed marker is
    // the whole answer: the defaults cover the rest, and nothing throws out of either
    // entry point.
    expect(
      stringifyValue({ a: 1 }, hostileOptions<StringifyValueOptions>()),
    ).toBe('***REDACTION FAILED***');
    expect(redactValue({ a: 1 }, hostileOptions<StringifyValueOptions>())).toBe(
      '***REDACTION FAILED***',
    );
  });

  test('an unreadable redactedKeys fails closed rather than rendering in the clear', () => {
    // The distinction the snapshot has to keep: absent `redactedKeys` means "nothing was
    // asked for" and hands the value back, so a getter that throws must not be read as
    // absent. It is the same answer an unusable list already gets.
    const reports: Array<{ kind: string; path: string }> = [];

    const rendered = stringifyValue(
      { password: 'hunter2secret' },
      {
        onFormatError: (_error, kind, path) => {
          reports.push({ kind, path });
        },
        get redactedKeys(): string[] {
          throw new Error('option read refused');
        },
      },
    );

    expect(rendered).not.toContain('hunter2secret');
    expect(rendered).toBe('***REDACTION FAILED***');
    expect(reports).toEqual([{ kind: 'redaction', path: '<redactedKeys>' }]);
  });

  test('an absent redactedKeys still renders in the clear', () => {
    expect(stringifyValue({ password: 'hunter2secret' }, {})).toBe(
      '{"password":"hunter2secret"}',
    );
  });
});
