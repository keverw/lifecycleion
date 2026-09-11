import { describe, expect, test } from 'bun:test';

import {
  findPathInto,
  indexStep,
  literalStep,
  matchRedactPath,
  parseRedactPaths,
  redactMatchedPaths,
} from './redact-paths';
import { REDACTION_FAILED_MARKER } from './default-redact-function';

// This module had no direct tests: it was covered only through `stringify-value` and the
// logger's `applyRedaction`, both of which exercise it with well-behaved payloads. What
// follows is the part those cannot reach from outside - the enumeration guards, the
// pass-through-by-reference rule, and the cycle policy - because a change to any of them
// is a change to what redaction emits.

const SECRET = 'hunter2secret';

const hostileKeys = (): object =>
  new Proxy(
    { a: 1 },
    {
      ownKeys() {
        throw new Error('ownKeys refused');
      },
    },
  );

// The index is asked about a *step*, not a bare key, because a wildcard expands over an
// array's slots and over nothing else. These two spell which kind of step a lookup is
// about; the walk itself builds them from the container it is standing in.
const at = (...keys: string[]) => keys.map(literalStep);
const atIndexes = (...keys: string[]) => keys.map(indexStep);

const paths = (...entries: string[]) => {
  const parsed = parseRedactPaths(entries);

  if (parsed === null) {
    throw new Error('expected a usable path list');
  }

  return parsed;
};

describe('parseRedactPaths', () => {
  test('reads a bare name as a top-level key', () => {
    expect(parseRedactPaths(['password'])).toEqual([
      { parts: ['password'], entry: 'password' },
    ]);
  });

  test('covers both readings of an entry with path syntax', () => {
    // Ambiguous on purpose: `user.password` can name a nested location or one literal key
    // spelled that way, and leaving either unmasked is what redaction exists to prevent.
    expect(parseRedactPaths(['user.password'])).toEqual([
      { parts: ['user.password'], entry: 'user.password' },
      { parts: ['user', 'password'], entry: 'user.password' },
    ]);
  });

  test('refuses a list it cannot use rather than returning an empty one', () => {
    // `null` is the caller's signal to mask everything, not to mask nothing - the
    // distinction every caller of this function fails closed on.
    expect(parseRedactPaths(undefined)).toBeNull();
    expect(parseRedactPaths(null)).toBeNull();
    expect(parseRedactPaths('password')).toBeNull();
    expect(parseRedactPaths(['ok', 42])).toBeNull();
    expect(parseRedactPaths(new Set(['password']))).toBeNull();
  });

  test('returns an empty list for an empty array, which is not the same answer', () => {
    expect(parseRedactPaths([])).toEqual([]);
  });
});

describe('matchRedactPath and findPathInto', () => {
  test('matches only a path of the same length', () => {
    const parsed = paths('user.password');

    expect(matchRedactPath(parsed, at('user', 'password'))).toBe(
      'user.password',
    );
    expect(matchRedactPath(parsed, at('user'))).toBeUndefined();
  });

  test('finds a path pointing strictly inside a value', () => {
    expect(findPathInto(paths('user.password'), at('user'))).toBe(
      'user.password',
    );
  });

  test('never lets a path address the root itself', () => {
    // The prefix test is vacuously true for every entry at the root, which is what once
    // turned `new Error('boom')` into `***REDACTED***` for any non-empty list.
    expect(findPathInto(paths('password'), at())).toBeUndefined();
  });
});

describe('wildcard path segments', () => {
  // `users.*.password` and `items[*].token` are one rule written two ways: a wildcard
  // stands in for an array *index*, so it expands over an array's slots and over nothing
  // else. Against a plain object there is no set of slots to expand over, so it is the key
  // literally spelled `*` - which is also what the quoted form `users["*"]` addresses.

  test('parses both spellings to the same segment', () => {
    expect(parseRedactPaths(['users.*.password'])).toEqual([
      { parts: ['users.*.password'], entry: 'users.*.password' },
      { parts: ['users', '*', 'password'], entry: 'users.*.password' },
    ]);

    expect(parseRedactPaths(['items[*].token'])).toEqual([
      { parts: ['items[*].token'], entry: 'items[*].token' },
      { parts: ['items', '*', 'token'], entry: 'items[*].token' },
    ]);
  });

  test('matches every slot of an array and no key of an object', () => {
    const parsed = paths('users[*].password');

    // An array slot: the step says so, and the wildcard expands onto it.
    expect(
      matchRedactPath(parsed, [
        ...at('users'),
        ...atIndexes('0'),
        ...at('password'),
      ]),
    ).toBe('users[*].password');

    // The same keys, reached as an object's - a bag that merely has a key named `0`.
    expect(
      matchRedactPath(parsed, at('users', '0', 'password')),
    ).toBeUndefined();

    // The key literally spelled `*`, which is the object reading of the entry.
    expect(matchRedactPath(parsed, at('users', '*', 'password'))).toBe(
      'users[*].password',
    );
  });

  test('points below an array slot the same way a concrete index does', () => {
    const parsed = paths('items[*].token');

    expect(findPathInto(parsed, [...at('items'), ...atIndexes('3')])).toBe(
      'items[*].token',
    );
    expect(findPathInto(parsed, at('items'))).toBe('items[*].token');
    expect(findPathInto(parsed, at('other'))).toBeUndefined();
  });

  test('prefers the concrete entry over the wildcard that also matched', () => {
    // Both reach `items[0].token`, and the key a `redactFunction` is handed should be the
    // one that names the location exactly rather than the one that generalizes it.
    const parsed = paths('items[0].token', 'items[*].token');

    expect(
      matchRedactPath(parsed, [
        ...at('items'),
        ...atIndexes('0'),
        ...at('token'),
      ]),
    ).toBe('items[0].token');
    expect(
      matchRedactPath(parsed, [
        ...at('items'),
        ...atIndexes('1'),
        ...at('token'),
      ]),
    ).toBe('items[*].token');
  });
});

describe('redactMatchedPaths - wildcards over arrays', () => {
  test('masks the named field of every element', () => {
    for (const entry of ['users[*].password', 'users.*.password']) {
      const result = redactMatchedPaths(
        {
          users: [
            { name: 'ana', password: SECRET },
            { name: 'bo', password: `${SECRET}-2` },
          ],
        },
        paths(entry),
        undefined,
      ) as { users: { name: string; password: string }[] };

      expect(result.users).toHaveLength(2);
      expect(result.users[0].password).not.toBe(SECRET);
      expect(result.users[1].password).not.toBe(`${SECRET}-2`);
      // Only what was named. The siblings ride through untouched.
      expect(result.users[0].name).toBe('ana');
      expect(result.users[1].name).toBe('bo');
    }
  });

  test('still masks exactly one element for a concrete index', () => {
    const result = redactMatchedPaths(
      { users: [{ password: SECRET }, { password: `${SECRET}-2` }] },
      paths('users[0].password'),
      undefined,
    ) as { users: { password: string }[] };

    expect(result.users[0].password).not.toBe(SECRET);
    expect(result.users[1].password).toBe(`${SECRET}-2`);
  });

  test('masks whole elements when the wildcard is the last segment', () => {
    const result = redactMatchedPaths(
      { tokens: ['topsecret1', 'topsecret2'] },
      paths('tokens[*]'),
      undefined,
    ) as { tokens: unknown[] };

    expect(Array.isArray(result.tokens)).toBe(true);
    expect(result.tokens).toHaveLength(2);
    expect(result.tokens[0]).not.toContain('topsecret');
    expect(result.tokens[1]).not.toContain('topsecret');
  });

  test('expands at every level when wildcards are nested', () => {
    const result = redactMatchedPaths(
      { groups: [{ members: [{ key: SECRET }, { key: SECRET }] }] },
      paths('groups[*].members[*].key'),
      undefined,
    ) as { groups: { members: { key: string }[] }[] };

    expect(result.groups[0].members).toHaveLength(2);
    expect(result.groups[0].members[0].key).not.toBe(SECRET);
    expect(result.groups[0].members[1].key).not.toBe(SECRET);
  });

  test('expands over bare nested arrays, at any depth', () => {
    // `a[*][*][*].p` is an ordinary entry: each `[*]` is its own segment, so consecutive
    // wildcards address consecutive levels of nesting with no object in between.
    for (const entry of ['a[*][*][*].p', 'a.*.*.*.p']) {
      const result = redactMatchedPaths(
        { a: [[[{ p: SECRET }, { p: SECRET }]]] },
        paths(entry),
        undefined,
      ) as { a: { p: string }[][][] };

      expect(result.a[0][0]).toHaveLength(2);
      expect(result.a[0][0][0].p).not.toBe(SECRET);
      expect(result.a[0][0][1].p).not.toBe(SECRET);
    }
  });

  test('skips a level that is not an array, without disturbing its siblings', () => {
    // A ragged payload is the ordinary unreachable-path case one level in: the wildcard
    // resolves to nothing at `5` and `null` and masks nothing there, silently, while the
    // element that does match is still masked.
    const result = redactMatchedPaths(
      { a: [[{ p: SECRET }], 5, null] },
      paths('a[*][*].p'),
      undefined,
    ) as { a: unknown[] };

    expect((result.a[0] as { p: string }[])[0].p).not.toBe(SECRET);
    expect(result.a[1]).toBe(5);
    expect(result.a[2]).toBeNull();
  });

  test('mixes a wildcard with a concrete index in either order', () => {
    const nested = () => ({ a: [[{ p: SECRET }, { p: SECRET }]] });

    const wildcardFirst = redactMatchedPaths(
      nested(),
      paths('a[*][0].p'),
      undefined,
    ) as { a: { p: string }[][] };

    expect(wildcardFirst.a[0][0].p).not.toBe(SECRET);
    expect(wildcardFirst.a[0][1].p).toBe(SECRET);

    const indexFirst = redactMatchedPaths(
      { a: [[{ p: SECRET }], [{ p: SECRET }]] },
      paths('a[0][*].p'),
      undefined,
    ) as { a: { p: string }[][] };

    expect(indexFirst.a[0][0].p).not.toBe(SECRET);
    expect(indexFirst.a[1][0].p).toBe(SECRET);
  });

  test('masks a non-plain element whole, as a concrete index does', () => {
    // A path pointing *inside* an `Error` masks the whole value, because rebuilding it as
    // a plain object would print fields no unredacted line ever showed.
    const result = redactMatchedPaths(
      { items: [new Error(SECRET)] },
      paths('items[*].message'),
      undefined,
    ) as { items: unknown[] };

    expect(result.items[0]).not.toBeInstanceOf(Error);
    expect(String(result.items[0])).not.toContain(SECRET);
  });

  test("leaves an array's named properties to the literal key", () => {
    // `namedArrayKeys` selects exactly the keys `isArrayIndexKey` rejects, so a wildcard
    // never expands onto one: `items.note` is not a slot of `items`.
    const items: unknown[] = [{ token: SECRET }];

    (items as unknown as Record<string, unknown>)['note'] = {
      token: `${SECRET}-note`,
    };

    const result = redactMatchedPaths(
      { items },
      paths('items[*].token'),
      undefined,
    ) as { items: unknown[] & { note: { token: string } } };

    expect((result.items[0] as { token: string }).token).not.toBe(SECRET);
    expect(result.items.note.token).toBe(`${SECRET}-note`);
  });
});

describe('redactMatchedPaths - wildcards over objects', () => {
  test('is the key literally named * and nothing wider', () => {
    const result = redactMatchedPaths(
      {
        users: {
          ana: { password: SECRET },
          '*': { password: `${SECRET}-star` },
        },
      },
      paths('users.*.password'),
      undefined,
    ) as { users: Record<string, { password: string }> };

    expect(result.users['*'].password).not.toBe(`${SECRET}-star`);
    // The whole point of not expanding across an object's keys: naming one field must not
    // quietly mask the bag it sits in.
    expect(result.users['ana'].password).toBe(SECRET);
  });

  test('does not expand over keys that merely look numeric', () => {
    // An object with a key named `0` is not an array, and `isArrayIndexKey` is about a
    // key of an array rather than about the shape of the string.
    const payload = { users: { '0': { password: SECRET } } };

    expect(
      redactMatchedPaths(payload, paths('users[*].password'), undefined),
    ).toBe(payload);
  });

  test('reaches the same key through the quoted form', () => {
    const result = redactMatchedPaths(
      { users: { '*': { password: SECRET } } },
      paths('users["*"].password'),
      undefined,
    ) as { users: Record<string, { password: string }> };

    expect(result.users['*'].password).not.toBe(SECRET);
  });
});

describe('redactMatchedPaths - wildcards that reach nothing', () => {
  // A wildcard adds no failure channel of its own. Where it resolves to nothing it is an
  // unreachable path like any other - it masks nothing, silently - and where a container
  // genuinely refuses to be read, the walk's existing per-entry guards decide, unchanged.

  test('hands the payload back by reference when the parent is not a container', () => {
    const reported: string[] = [];

    for (const users of [undefined, 5, 'text', null]) {
      const payload = { users, keep: 'visible' };

      expect(
        redactMatchedPaths(
          payload,
          paths('users[*].password'),
          undefined,
          (_error, key) => reported.push(key),
        ),
      ).toBe(payload);
    }

    expect(reported).toEqual([]);
  });

  test('masks a non-plain parent whole, exactly as a concrete index does', () => {
    // Not a wildcard rule. A path pointing into a value the renderer prints as one string
    // masks the whole of it, because rebuilding it would print fields no unredacted line
    // ever showed - and `users[0].password` has always done the same here.
    const when = new Date('2020-01-02T03:04:05.000Z');

    for (const entry of ['users[*].password', 'users[0].password']) {
      const result = redactMatchedPaths(
        { users: when, keep: 'visible' },
        paths(entry),
        undefined,
      ) as Record<string, unknown>;

      expect(result['users']).not.toBe(when);
      expect(result['keep']).toBe('visible');
    }
  });

  test('masks nothing for an empty array, and does not report', () => {
    const reported: string[] = [];
    const payload = { users: [] as unknown[] };

    expect(
      redactMatchedPaths(
        payload,
        paths('users[*].password'),
        undefined,
        (_error, key) => reported.push(key),
      ),
    ).toBe(payload);
    expect(reported).toEqual([]);
  });

  test('fails an element closed when its own keys cannot be read', () => {
    const reported: string[] = [];

    const result = redactMatchedPaths(
      { users: [hostileKeys(), { password: SECRET }] },
      paths('users[*].password'),
      undefined,
      (_error, key) => reported.push(key),
    ) as { users: unknown[] };

    expect(result.users[0]).toBe(REDACTION_FAILED_MARKER);
    expect((result.users[1] as { password: string }).password).not.toBe(SECRET);
    expect(reported).toContain('users.0');
  });
});

describe('redactMatchedPaths - enumeration failures', () => {
  test('fails a container closed when its keys cannot be read', () => {
    const reported: string[] = [];
    const result = redactMatchedPaths(
      { inner: hostileKeys(), tok: SECRET },
      paths('tok'),
      undefined,
      (_error, key) => reported.push(key),
    ) as Record<string, unknown>;

    // Marked where it sits, and the sibling redaction was asked for still masks.
    expect(result['inner']).toBe(REDACTION_FAILED_MARKER);
    expect(result['tok']).not.toBe(SECRET);
    expect(reported).toEqual(['inner']);
  });

  test('fails an array closed when its length cannot be read', () => {
    const hostile = new Proxy([1, 2], {
      get(target, key, receiver) {
        if (key === 'length') {
          throw new Error('length refused');
        }

        return Reflect.get(target, key, receiver) as unknown;
      },
    });

    const result = redactMatchedPaths(
      { arr: hostile, tok: SECRET },
      paths('tok'),
      undefined,
    ) as Record<string, unknown>;

    expect(result['arr']).toBe(REDACTION_FAILED_MARKER);
  });

  test('marks one unreadable entry and masks every readable sibling', () => {
    const value: Record<string, unknown> = { tok: SECRET, keep: 'visible' };

    Object.defineProperty(value, 'bad', {
      get() {
        throw new Error('entry refused');
      },
      enumerable: true,
    });

    const result = redactMatchedPaths(value, paths('tok'), undefined) as Record<
      string,
      unknown
    >;

    expect(result['bad']).toBe(REDACTION_FAILED_MARKER);
    expect(result['keep']).toBe('visible');
    expect(result['tok']).not.toBe(SECRET);
  });
});

describe('redactMatchedPaths - what it does not rewrite', () => {
  test('hands back the original when nothing matched anywhere', () => {
    // Identity, not equality: copies are built only along the branches leading to a mask,
    // so a list matching none of a payload must not rewrite any of it.
    const payload = { a: { b: 1 } };

    expect(redactMatchedPaths(payload, paths('zzz'), undefined)).toBe(payload);
  });

  test('keeps an untouched subtree by reference', () => {
    const nested = { deep: { x: 1 } };
    const payload = { nested, tok: SECRET };

    const result = redactMatchedPaths(
      payload,
      paths('tok'),
      undefined,
    ) as Record<string, unknown>;

    expect(result).not.toBe(payload);
    expect(result['nested']).toBe(nested);
  });

  test('keeps a Date and an Error intact beside a masked value', () => {
    // Rebuilding unconditionally flattened both: `Object.keys` is empty for a `Date` and
    // skips an `Error`'s non-enumerable `message` and `stack`.
    const when = new Date('2020-01-02T03:04:05.000Z');
    const failure = new Error('keep me');

    const result = redactMatchedPaths(
      { when, failure, tok: SECRET },
      paths('tok'),
      undefined,
    ) as Record<string, unknown>;

    expect(result['when']).toBe(when);
    expect(result['failure']).toBe(failure);
  });

  test('does not rewrite a payload that merely contains a cycle', () => {
    const cyclic: Record<string, unknown> = { name: 'root' };

    cyclic['self'] = cyclic;

    expect(redactMatchedPaths(cyclic, paths('zzz'), undefined)).toBe(cyclic);
  });

  test('never mutates the value it was given', () => {
    const payload = { user: { password: SECRET } };

    redactMatchedPaths(payload, paths('user.password'), undefined);

    expect(payload.user.password).toBe(SECRET);
  });
});

describe('redactMatchedPaths - shape of a masked container', () => {
  test('masks each leaf of a named array and keeps it an array', () => {
    const result = redactMatchedPaths(
      { tokens: ['topsecret1', 'topsecret2'] },
      paths('tokens'),
      undefined,
    ) as Record<string, unknown>;

    const tokens = result['tokens'] as unknown[];

    expect(Array.isArray(tokens)).toBe(true);
    expect(tokens).toHaveLength(2);
    expect(tokens[0]).not.toContain('topsecret');
  });

  test('stores a __proto__ entry instead of reparenting the rebuilt object', () => {
    const payload: Record<string, unknown> = { tok: SECRET };

    Object.defineProperty(payload, '__proto__', {
      value: 'not a prototype',
      enumerable: true,
      writable: true,
      configurable: true,
    });

    const result = redactMatchedPaths(
      payload,
      paths('tok'),
      undefined,
    ) as Record<string, unknown>;

    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(Object.keys(result)).toContain('__proto__');
  });

  test('rebuilds an array subclass as a plain array rather than calling its constructor', () => {
    // `map` would go through `ArraySpeciesCreate` and call this constructor with a length.
    class StrictTuple extends Array {
      constructor(...items: unknown[]) {
        if (items.length === 1 && typeof items[0] === 'number') {
          throw new TypeError('refuses a length argument');
        }

        super(...(items as never[]));
      }
    }

    const tuple = new StrictTuple('topsecret1', 'topsecret2');

    const result = redactMatchedPaths(
      { tokens: tuple },
      paths('tokens'),
      undefined,
    ) as Record<string, unknown>;

    expect(Array.isArray(result['tokens'])).toBe(true);
    expect(result['tokens']).toHaveLength(2);
  });

  test('one large sibling does not spend the budget the next one needs', () => {
    // The candidate scan and the walk read the same containers. Charged to one counter,
    // *measuring* the first array was subtracted from the budget for walking the second:
    // `a` came back intact and `b` collapsed to a single failure marker, though nothing
    // about `b` was any larger.
    const payload = {
      password: SECRET,
      a: new Array(600_000).fill(1),
      b: new Array(600_000).fill(1),
    };

    const result = redactMatchedPaths(
      payload,
      paths('password'),
      undefined,
    ) as Record<string, unknown>;

    expect(result['password']).not.toBe(SECRET);
    expect(result['a']).toHaveLength(600_000);
    expect(result['b']).toHaveLength(600_000);
    expect(result['b']).not.toContain(REDACTION_FAILED_MARKER);
  });

  test('refuses a redaction list claiming a length it would cost the memory to read', () => {
    // The self-contradiction check only catches a list lying *downward* about `length` -
    // an own index key past the end - so a claim in the tens of millions passed every
    // test and was then materialized, element by element, before anything could refuse
    // it. Answered without allocating for it, and fail-closed as every refusal here is.
    const start = Date.now();

    expect(parseRedactPaths(new Array(50_000_000))).toBeNull();
    expect(Date.now() - start).toBeLessThan(1_000);

    // Nothing a real configuration would hit.
    expect(parseRedactPaths(['password', 'token'])).toHaveLength(2);
  });
});

describe('the parsed-path index', () => {
  // Both lookups were a linear scan of the whole list run once per visited node, so a pass
  // cost `paths x nodes` - bounded on each factor and on neither product. A prefix tree
  // answers in the length of the path, and has to answer exactly what the scan did.

  test('answers with the first matching entry, in list order', () => {
    const parsed = paths('a.b', 'a.b', 'a');

    expect(matchRedactPath(parsed, at('a', 'b'))).toBe('a.b');
    // A bare name is taken literally as well as parsed, so `a.b` also names one top-level
    // key spelled that way - and it was pushed first.
    expect(matchRedactPath(parsed, at('a.b'))).toBe('a.b');
    expect(matchRedactPath(parsed, at('a'))).toBe('a');
  });

  test('separates an exact match from one that points below', () => {
    const parsed = paths('user.token');

    expect(matchRedactPath(parsed, at('user'))).toBeUndefined();
    expect(matchRedactPath(parsed, at('user', 'token'))).toBe('user.token');
    expect(findPathInto(parsed, at('user'))).toBe('user.token');
    expect(findPathInto(parsed, at('user', 'token'))).toBeUndefined();
    expect(findPathInto(parsed, at('other'))).toBeUndefined();
    // Nothing addresses the root itself.
    expect(findPathInto(parsed, at())).toBeUndefined();
  });

  test('handles paths that are prefixes of one another', () => {
    const parsed = paths('a.b.c', 'a.b');

    expect(matchRedactPath(parsed, at('a', 'b'))).toBe('a.b');
    expect(matchRedactPath(parsed, at('a', 'b', 'c'))).toBe('a.b.c');
    expect(findPathInto(parsed, at('a', 'b'))).toBe('a.b.c');
  });

  test('is not confused by a segment named like a prototype key', () => {
    const parsed = paths('__proto__.token');

    expect(matchRedactPath(parsed, at('__proto__', 'token'))).toBe(
      '__proto__.token',
    );
    expect(matchRedactPath(parsed, at('toString'))).toBeUndefined();
    expect(findPathInto(parsed, at('toString'))).toBeUndefined();
  });

  test('answers a long list without scanning it per node', () => {
    const entries: string[] = [];

    for (let index = 0; index < 20_000; index++) {
      entries.push(`k${index}.nested.leaf`);
    }

    const parsed = parseRedactPaths(entries);

    if (parsed === null) {
      throw new Error('expected a usable path list');
    }
    const started = Date.now();

    for (let index = 0; index < 20_000; index++) {
      expect(matchRedactPath(parsed, at(`k${index}`, 'nested', 'leaf'))).toBe(
        `k${index}.nested.leaf`,
      );
    }

    // The scan this replaces took minutes at this size; the bound is deliberately loose so
    // it fails only on a return to it.
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe('redactMatchedPaths - the entry budget', () => {
  test('stops a wide object at the cap rather than rebuilding all of it', () => {
    // The object branch marked every remaining key and walked the whole list, so the cap
    // bounded neither the time nor the size of the copy - which is what it is for. The
    // array branch has always stopped.
    const wide: Record<string, unknown> = {};

    for (let index = 0; index < 1_200_000; index++) {
      wide[`k${index}`] = index;
    }

    const redacted = redactMatchedPaths(
      { wide },
      paths('wide.k0'),
      undefined,
    ) as { wide: Record<string, unknown> };

    const keys = Object.keys(redacted.wide);

    expect(keys.length).toBeLessThan(1_200_000);
    expect(redacted.wide[keys[keys.length - 1]]).toBe(REDACTION_FAILED_MARKER);
  });
});
