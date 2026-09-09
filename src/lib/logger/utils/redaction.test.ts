import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  muteConsoleError,
  restoreConsoleError,
} from '../../internal/console-test-utils';
import {
  applyRedaction,
  defaultRedactFunction,
  REDACTION_FAILED_MARKER,
} from './redaction';
import type { RedactFunction } from '../types';

// These suites deliberately drive the paths that fall through to `console.error` when
// no handler is supplied. Captured rather than printed so a real failure in the run
// output still stands out; flip `DEBUG` in the helper to see them.
beforeEach(() => {
  muteConsoleError();
});

afterEach(() => {
  restoreConsoleError();
});

/** A `redactFunction` as a JavaScript caller may write one, before the type narrows it. */
type RedactFunctionLike = (keyName: string, value: unknown) => unknown;

describe('applyRedaction', () => {
  test('should redact specified keys', () => {
    const params = {
      username: 'john',
      password: 'secret123',
      email: 'john@example.com',
    };

    const redacted = applyRedaction(params, ['password']);

    expect(redacted.username).toBe('john');
    expect(redacted.email).toBe('john@example.com');
    expect(redacted.password).not.toBe('secret123');
    expect(redacted.password).toContain('*'); // Default mask uses asterisks
  });

  test('should redact multiple keys', () => {
    const params = {
      username: 'john',
      password: 'secret123',
      apiKey: 'sk_live_12345',
      email: 'john@example.com',
    };

    const redacted = applyRedaction(params, ['password', 'apiKey']);

    expect(redacted.username).toBe('john');
    expect(redacted.email).toBe('john@example.com');
    expect(redacted.password).not.toBe('secret123');
    expect(redacted.apiKey).not.toBe('sk_live_12345');
  });

  test('should not modify params if no redacted keys', () => {
    const params = {
      username: 'john',
      password: 'secret123',
    };

    const redacted = applyRedaction(params, []);

    expect(redacted).toEqual(params);
  });

  test('should not modify params if redacted keys undefined', () => {
    const params = {
      username: 'john',
      password: 'secret123',
    };

    const redacted = applyRedaction(params);

    expect(redacted).toEqual(params);
  });

  test('should handle custom redaction function', () => {
    const params = {
      username: 'john',
      password: 'secret123',
    };

    const customRedact = (keyName: string, _value: unknown) =>
      `[REDACTED-${keyName}]`;

    const redacted = applyRedaction(params, ['password'], customRedact);

    expect(redacted.password).toBe('[REDACTED-password]');
  });

  test('should not modify original params object', () => {
    const params = {
      username: 'john',
      password: 'secret123',
    };

    const original = { ...params };

    applyRedaction(params, ['password']);

    expect(params).toEqual(original);
  });

  test('should handle non-string values', () => {
    const params = {
      userID: 741,
      isActive: true,
      metadata: { key: 'value' },
    };

    const redacted = applyRedaction(params, ['metadata']);

    expect(redacted.userID).toBe(741);
    expect(redacted.isActive).toBe(true);
    // A plain object keeps its shape and is masked leaf by leaf, rather than being
    // stringified to '[object Object]' and masked as that text.
    // 'value' is below the length floor for partial masking, so it is replaced outright.
    expect(redacted.metadata).toEqual({ key: '***REDACTED***' });
  });

  test('should stringify non-string values before calling custom redaction functions', () => {
    const params = {
      error: new Error('boom'),
      users: ['a', 'b'],
      metadata: { key: 'value' },
    };

    const seen: Array<[string, unknown]> = [];
    const customRedact = (keyName: string, value: unknown) => {
      seen.push([keyName, value]);
      return `[MASKED-${keyName}]`;
    };

    const redacted = applyRedaction(
      params,
      ['error', 'users', 'metadata'],
      customRedact,
    );

    // A plain object and an array are walked, so the function sees each leaf under the
    // entry it was named by. An `Error` is not walked: its string form says more than
    // its enumerable properties would, so it arrives stringified as before.
    expect(seen).toEqual([
      ['error', 'Error: boom'],
      ['users', 'a'],
      ['users', 'b'],
      ['metadata', 'value'],
    ]);

    expect(redacted.error).toBe('[MASKED-error]');
    expect(redacted.users).toEqual(['[MASKED-users]', '[MASKED-users]']);
    expect(redacted.metadata).toEqual({ key: '[MASKED-metadata]' });
  });

  test('should redact nested keys using dot notation', () => {
    const params = {
      user: {
        id: 123,
        name: 'Alice',
        password: 'secret123',
      },
      settings: {
        theme: 'dark',
        apiKey: 'sk_12345',
      },
    };

    const redacted = applyRedaction(params, [
      'user.password',
      'settings.apiKey',
    ]);

    expect(redacted.user).toBeDefined();
    expect((redacted.user as any).id).toBe(123);
    expect((redacted.user as any).name).toBe('Alice');
    expect((redacted.user as any).password).not.toBe('secret123');
    expect((redacted.user as any).password).toContain('*');

    expect((redacted.settings as any).theme).toBe('dark');
    expect((redacted.settings as any).apiKey).not.toBe('sk_12345');
    expect((redacted.settings as any).apiKey).toContain('*');
  });

  test('should handle deeply nested paths', () => {
    const params = {
      level1: {
        level2: {
          level3: {
            secret: 'deep-secret',
            public: 'visible',
          },
        },
      },
    };

    const redacted = applyRedaction(params, ['level1.level2.level3.secret']);

    expect((redacted.level1 as any).level2.level3.public).toBe('visible');
    expect((redacted.level1 as any).level2.level3.secret).not.toBe(
      'deep-secret',
    );
  });

  test('should redact array index paths', () => {
    const params = {
      users: [
        {
          name: 'Alice',
          password: 'secret123',
        },
        {
          name: 'Bob',
          password: 'secret456',
        },
      ],
    };

    const redacted = applyRedaction(params, ['users[0].password']);

    expect((redacted.users as any)[0].name).toBe('Alice');
    expect((redacted.users as any)[0].password).not.toBe('secret123');
    expect((redacted.users as any)[0].password).toBe('********3');
    expect((redacted.users as any)[1].password).toBe('secret456');
  });

  test('should redact deeper mixed object and array paths', () => {
    const params = {
      sessions: [
        {
          tokens: ['public-token', 'secret-token'],
        },
      ],
    };

    const redacted = applyRedaction(params, ['sessions[0].tokens[1]']);

    expect((redacted.sessions as any)[0].tokens[0]).toBe('public-token');
    expect((redacted.sessions as any)[0].tokens[1]).not.toBe('secret-token');
    expect((redacted.sessions as any)[0].tokens[1]).toBe('s**********n');
  });

  test('should redact quoted bracket-key paths', () => {
    const params = {
      users: [
        {
          'password-hash': 'secret123',
        },
      ],
      credentials: {
        'api-key': 'secret-token',
      },
    };

    const redacted = applyRedaction(params, [
      'users[0]["password-hash"]',
      'credentials["api-key"]',
    ]);

    expect((redacted.users as any)[0]['password-hash']).toBe('********3');
    expect((redacted.credentials as any)['api-key']).toBe('s**********n');
  });

  test('should treat dot notation and quoted bracket notation as equivalent for the same key', () => {
    const params = {
      user: {
        password: 'secret123',
      },
    };

    const dotRedacted = applyRedaction(params, ['user.password']);
    const bracketRedacted = applyRedaction(params, ['user["password"]']);

    expect((dotRedacted.user as any).password).toBe('********3');
    expect((bracketRedacted.user as any).password).toBe('********3');
    expect(dotRedacted).toEqual(bracketRedacted);
  });

  test('should handle both top-level and nested redaction', () => {
    const params = {
      password: 'top-secret',
      user: {
        name: 'Bob',
        credentials: {
          apiKey: 'nested-secret',
        },
      },
    };

    const redacted = applyRedaction(params, [
      'password',
      'user.credentials.apiKey',
    ]);

    expect(redacted.password).not.toBe('top-secret');
    expect((redacted.user as any).name).toBe('Bob');
    expect((redacted.user as any).credentials.apiKey).not.toBe('nested-secret');
  });

  test('should not fail on non-existent nested paths', () => {
    const params = {
      user: {
        name: 'Charlie',
      },
    };

    // Try to redact a path that doesn't exist
    const redacted = applyRedaction(params, [
      'user.password',
      'nonexistent.path',
    ]);

    expect((redacted.user as any).name).toBe('Charlie');
    expect(redacted).toBeDefined();
  });

  test('should not fail when intermediate path is not an object', () => {
    const params = {
      user: 'not-an-object',
      data: {
        value: 123,
      },
    };

    // Try to redact a nested path where parent is not an object
    const redacted = applyRedaction(params, ['user.password']);

    expect(redacted.user).toBe('not-an-object');
    expect((redacted.data as any).value).toBe(123);
  });

  test('should not fail on non-existent array index paths', () => {
    const params = {
      users: [{ name: 'Charlie' }],
    };

    const redacted = applyRedaction(params, ['users[1].password']);

    expect((redacted.users as any)[0].name).toBe('Charlie');
    expect(redacted).toBeDefined();
  });

  test('should deep clone nested objects to avoid mutation', () => {
    const params = {
      user: {
        credentials: {
          password: 'secret',
        },
      },
    };

    const original = JSON.parse(JSON.stringify(params));

    applyRedaction(params, ['user.credentials.password']);

    // Original should not be mutated
    expect(params).toEqual(original);
  });

  test('should use custom redaction function for nested keys', () => {
    const params = {
      auth: {
        token: 'secret-token',
      },
    };

    const customRedact = (keyName: string, _value: unknown) =>
      `[HIDDEN-${keyName}]`;

    const redacted = applyRedaction(params, ['auth.token'], customRedact);

    expect((redacted.auth as any).token).toBe('[HIDDEN-auth.token]');
  });
});

describe('defaultRedactFunction', () => {
  test('should mask string values', () => {
    const result = defaultRedactFunction('password', 'secret123');

    expect(result).not.toBe('secret123');
    expect(result).toContain('*');
  });

  test('should handle non-string values', () => {
    const result = (defaultRedactFunction as RedactFunctionLike)(
      'apiKey',
      12345,
    );

    expect(result).toBe('***REDACTED***');
  });

  test('should handle object values', () => {
    const result = (defaultRedactFunction as RedactFunctionLike)('metadata', {
      key: 'value',
    });

    expect(result).toBe('***REDACTED***');
  });
});

describe('applyRedaction - non-identifier key names', () => {
  // An unquoted path segment is any run of characters that are not `.`, `[` or `]`, so an
  // ordinary hyphenated or spaced name needs no quoting. These used to fail to parse and
  // silently redact nothing.

  test('redacts a hyphenated nested key without quoting', () => {
    const result = applyRedaction({ user: { 'password-hash': 'hunter2' } }, [
      'user.password-hash',
    ]);

    expect(
      (result['user'] as Record<string, unknown>)['password-hash'],
    ).not.toBe('hunter2');
  });

  test('redacts a hyphenated key through an array index', () => {
    const result = applyRedaction({ users: [{ 'api-key': 'hunter2' }] }, [
      'users[0].api-key',
    ]);

    const users = result['users'] as Record<string, unknown>[];

    expect(users[0]['api-key']).not.toBe('hunter2');
  });

  test('redacts spaced and non-ASCII names', () => {
    // A non-ASCII name needs no quoting; a spaced one does, since an unquoted segment
    // stops at whitespace so that brace-wrapped prose is not read as a lookup path.
    const result = applyRedaction(
      { u: { 'my key': 'hunter2', contraseña: 'hunter2' } },
      ["u['my key']", 'u.contraseña'],
    );

    const u = result['u'] as Record<string, unknown>;

    expect(u['my key']).not.toBe('hunter2');
    expect(u['contraseña']).not.toBe('hunter2');
  });

  test('a params bag with a non-plain prototype still comes back a record', () => {
    // The walk treats a non-plain object as a single value, which is right for one nested
    // inside a payload but not for the bag itself. That first showed up as the bare string
    // `'***REDACTED***'` against the declared record type, so every template placeholder
    // rendered as the fallback and a structured sink got a string in place of its params.
    // Now that no path addresses the root, the same cause fails the other way and more
    // quietly: an unnormalized bag is left alone entirely, so `password` is never masked.
    // Normalizing it to a plain object is what this asserts, from both ends.
    class Bag {
      public password = 'hunter2secret';
      public userID = 7;
    }

    const result = applyRedaction(
      new Bag() as unknown as Record<string, unknown>,
      ['password'],
    );

    expect(typeof result).toBe('object');
    expect(result['password']).not.toBe('hunter2secret');
    expect(result['userID']).toBe(7);
  });

  test('a list whose length cannot be read fails closed instead of throwing', () => {
    // The head read used to sit above the guards, so this threw out of `applyRedaction`
    // and the caller needed a backstop of its own purely to catch it - which is how the
    // fail-closed bag came to be written in two places.
    const failures: string[] = [];
    const hostile = new Proxy(['password'], {
      get(target, property, receiver): unknown {
        if (property === 'length') {
          throw new Error('length is not for you');
        }

        return Reflect.get(target, property, receiver) as unknown;
      },
    });

    const result = applyRedaction(
      { password: 'hunter2secret' },
      hostile,
      undefined,
      (_error, key) => failures.push(key),
    );

    expect(result).toEqual({});
    expect(failures).toEqual(['<redactedKeys>']);
  });

  test('the quoted form still works and still disambiguates a dotted key', () => {
    const quoted = applyRedaction({ user: { 'password-hash': 'hunter2' } }, [
      'user["password-hash"]',
    ]);

    expect(
      (quoted['user'] as Record<string, unknown>)['password-hash'],
    ).not.toBe('hunter2');

    // A key that really contains a dot can only be reached by quoting.
    const dotted = applyRedaction({ user: { 'a.b': 'hunter2' } }, [
      'user["a.b"]',
    ]);

    expect((dotted['user'] as Record<string, unknown>)['a.b']).not.toBe(
      'hunter2',
    );
  });

  test('still redacts nothing for genuinely unsupported syntax', () => {
    // Wildcards remain unsupported, as documented.
    expect(
      applyRedaction({ users: [{ password: 'hunter2' }] }, [
        'users[*].password',
      ]),
    ).toEqual({ users: [{ password: 'hunter2' }] });
  });
});

describe('applyRedaction - ambiguous dotted keys', () => {
  // A dotted entry can name either a nested path or one literal key. Both readings are
  // redacted, because leaving either in the clear is the outcome redaction prevents.

  test('redacts a key spelled literally like the path', () => {
    const result = applyRedaction({ 'user.password': 'hunter2' }, [
      'user.password',
    ]);

    expect(result['user.password']).not.toBe('hunter2');
  });

  test('redacts both readings when both exist', () => {
    const result = applyRedaction({ 'a.b': 'hunter2', a: { b: 'hunter2' } }, [
      'a.b',
    ]);

    expect(result['a.b']).not.toBe('hunter2');
    expect((result['a'] as Record<string, unknown>)['b']).not.toBe('hunter2');
  });

  test('still skips a path that names nothing', () => {
    expect(applyRedaction({ other: 'safe' }, ['x.y'])).toEqual({
      other: 'safe',
    });
  });
});

describe('applyRedaction - containers keep their shape', () => {
  // Naming a container used to stringify it: an object became a mask of
  // '[object Object]', and an array was joined so the edges of the first and last
  // elements survived. Each leaf is masked and the container rebuilt instead.

  test('an object is masked leaf by leaf, keeping its keys', () => {
    const result = applyRedaction({ p: { a: 'topsecret', b: 'other' } }, ['p']);
    const p = result['p'] as Record<string, unknown>;

    expect(typeof p).toBe('object');
    expect(p['a']).not.toBe('topsecret');
    expect(p['b']).not.toBe('other');
    expect(JSON.stringify(result)).not.toContain('object Object');
  });

  test('an array is masked element by element, not joined', () => {
    const result = applyRedaction({ p: ['topsecret', 'other'] }, ['p']);
    const p = result['p'] as unknown[];

    expect(Array.isArray(p)).toBe(true);
    expect(p.length).toBe(2);
    // Joining produced 'topsecret,other' and masked it as one string, leaking the edges
    // of both elements into a single value.
    expect(JSON.stringify(p)).not.toContain('topsecret');
    expect(JSON.stringify(p)).not.toContain('other');
  });

  test('masks all the way down', () => {
    const result = applyRedaction({ p: { a: { b: ['topsecret'] } } }, ['p']);

    expect(JSON.stringify(result)).not.toContain('topsecret');
    expect(
      Array.isArray(
        (
          (result['p'] as Record<string, unknown>)['a'] as Record<
            string,
            unknown
          >
        )['b'],
      ),
    ).toBe(true);
  });

  test('a __proto__ key is rebuilt as an own property, not a prototype', () => {
    // Assignment to `__proto__` is a no-op for a string and reparents the result for an
    // object, so a payload carrying that key silently lost the entry or changed shape.
    const payload = JSON.parse(
      '{"__proto__":{"toString":"topsecretvalue"},"k":"othersecretvalue"}',
    ) as Record<string, unknown>;

    const p = applyRedaction({ p: payload }, ['p'])['p'] as Record<
      string,
      unknown
    >;

    expect(Object.getPrototypeOf(p)).toBe(Object.prototype);
    expect(Object.keys(p)).toContain('__proto__');
    expect(JSON.stringify(p)).not.toContain('topsecretvalue');
    expect(JSON.stringify(p)).not.toContain('othersecretvalue');
  });

  test('a self-referencing container terminates and keeps its shape', () => {
    // Asserted on the resulting shape, not just the absence of the secret: without the
    // cycle guard the recursion blows the stack and the fail-closed backstop returns
    // `***REDACTION FAILED***`, which contains no secret either and would pass a bare
    // `not.toContain`.
    const cyclic: Record<string, unknown> = { a: 'topsecretvalue' };

    cyclic['self'] = cyclic;

    const p = applyRedaction({ p: cyclic }, ['p'])['p'] as Record<
      string,
      unknown
    >;

    expect(typeof p).toBe('object');
    expect(p['a']).not.toBe('topsecretvalue');
    expect(p['a']).not.toBe(REDACTION_FAILED_MARKER);
    // The back-reference is cut rather than followed.
    expect(p['self']).toBe('***REDACTED***');
  });

  test('a container referenced twice is masked both times', () => {
    // The cycle guard tracks the current path and releases on the way out, so a shared
    // reference is not mistaken for a cycle.
    const shared = { a: 'topsecretvalue' };
    const p = applyRedaction({ p: { first: shared, second: shared } }, ['p'])[
      'p'
    ] as Record<string, Record<string, unknown>>;

    expect(p['first']?.['a']).not.toBe('topsecretvalue');
    expect(p['second']?.['a']).toEqual(p['first']?.['a']);
    expect(p['second']).not.toBe('***REDACTED***');
  });
});

describe('applyRedaction - redactFunction return shapes', () => {
  const TOKEN = 'sk-live-51H8x9QcAbCdEf';
  const EMAIL = 'johndoe@example.com';

  test('a number defers to the default at that percent', () => {
    const loose = applyRedaction({ p: TOKEN }, ['p'], () => 20)['p'] as string;
    const tight = applyRedaction({ p: TOKEN }, ['p'], () => 95)['p'] as string;

    expect(loose).not.toBe(TOKEN);
    expect(tight).not.toBe(TOKEN);
    // A higher percent hides more, so fewer original characters survive.
    const surviving = (masked: string): number =>
      [...masked].filter((character) => character !== '*').length;

    expect(surviving(tight)).toBeLessThan(surviving(loose));
  });

  test('a config selects the email strategy, keeping the @ and dots', () => {
    const masked = applyRedaction({ p: EMAIL }, ['p'], () => ({
      strategy: 'email',
    }))['p'] as string;

    expect(masked).not.toBe(EMAIL);
    expect(masked).not.toContain('johndoe');
    // The structure survives so an address stays recognizable as one.
    expect(masked).toContain('@');
    expect(masked).toContain('.');
  });

  test('a config selects the domain strategy', () => {
    const masked = applyRedaction({ p: 'api.example.com' }, ['p'], () => ({
      strategy: 'domain',
    }))['p'] as string;

    expect(masked).not.toBe('api.example.com');
    expect(masked).toContain('.');
  });

  test('a config can set the mask character and percent', () => {
    const masked = applyRedaction({ p: TOKEN }, ['p'], () => ({
      maskChar: '#',
      percent: 50,
    }))['p'] as string;

    expect(masked).toContain('#');
    expect(masked).not.toContain('*');
    expect(masked).not.toBe(TOKEN);
  });

  test('a config opts a non-string back into partial masking', () => {
    // A number is replaced outright by default; asking for a percent is deliberate.
    expect(applyRedaction({ p: 4111111111111111 }, ['p'])['p']).toBe(
      '***REDACTED***',
    );
    expect(
      applyRedaction({ p: 4111111111111111 }, ['p'], () => ({ percent: 60 }))[
        'p'
      ],
    ).not.toBe('***REDACTED***');
  });

  test('a percent above 100 masks the value rather than lengthening it', () => {
    // `datamask` masks a *proportion*: it emits `length * percent / 100` characters
    // without stopping at the length of the value. An unclamped percent therefore grew
    // the output instead of hiding more of it - at 10000 a 22-character token came back
    // as 2200 characters, written to every sink. `Number(process.env.MASK_PERCENT)` and
    // a percent read as a multiplier both arrive here.
    const full = '*'.repeat(TOKEN.length);

    expect(
      applyRedaction({ p: TOKEN }, ['p'], () => ({ percent: 10000 }))['p'],
    ).toBe(full);
    // The numeric shorthand is the same request spelled another way.
    expect(applyRedaction({ p: TOKEN }, ['p'], () => 10000)['p']).toBe(full);

    // The per-part percents used to bypass validation entirely, so the ceiling - and the
    // finiteness check with it - applied to `percent` alone.
    const address = applyRedaction({ p: EMAIL }, ['p'], () => ({
      strategy: 'email',
      userPercent: 10000,
      domainPercent: 10000,
    }))['p'] as string;

    expect(address.length).toBe(EMAIL.length);
    expect(address).toBe(
      applyRedaction({ p: EMAIL }, ['p'], () => ({
        strategy: 'email',
        userPercent: 100,
        domainPercent: 100,
      }))['p'] as string,
    );
  });

  test('a masking that hides nothing falls through to the placeholder', () => {
    // Percent 0 would hand back the original, which is the one unacceptable answer.
    expect(applyRedaction({ p: TOKEN }, ['p'], () => 0)['p']).toBe(
      '***REDACTED***',
    );
  });

  test('a number is not partially masked by default', () => {
    // Proportional masking kept a card number's BIN prefix and last four.
    expect(applyRedaction({ p: 4111111111111111 }, ['p'])['p']).toBe(
      '***REDACTED***',
    );
    expect(applyRedaction({ p: 123456789 }, ['p'])['p']).toBe('***REDACTED***');
  });
});

describe('applyRedaction - redactFunction deferral', () => {
  test('null defers to the default masking', () => {
    const result = applyRedaction(
      { p: 'hunter2secret', other: 'hunter2secret' },
      ['p', 'other'],
      (key) => (key === 'other' ? 'CUSTOM' : null),
    );

    expect(result['other']).toBe('CUSTOM');
    expect(result['p']).toBe(
      applyRedaction({ p: 'hunter2secret' }, ['p'])['p'],
    );
    expect(result['p']).not.toBe('hunter2secret');
  });

  test('returning nothing defers, exactly as null does', () => {
    // A function that special-cases a few keys and falls off the end for the rest has
    // not said what to put there. Using `undefined` literally was tried first, to drop
    // the value - but only the logger can drop a field: `errorToString` writes a table
    // row and `stringifyValue` a JSON leaf, and both rendered the literal text
    // `undefined` there. Masking by default is the one answer that means the same thing
    // on all three and never prints a value that was named for redaction.
    const result = applyRedaction(
      { p: 'hunter2secret' },
      ['p'],
      () => undefined,
    );

    expect(result['p']).toBe(
      applyRedaction({ p: 'hunter2secret' }, ['p'])['p'],
    );
    expect(result['p']).not.toBe('hunter2secret');
  });

  test('a literal null is rendered by returning the string', () => {
    // Distinguishes the sentinel from the rendered word: returning `null` defers,
    // returning `'null'` does not.
    expect(applyRedaction({ p: 'xyzzy12345' }, ['p'], () => 'null')['p']).toBe(
      'null',
    );
    expect(applyRedaction({ p: 'xyzzy12345' }, ['p'], () => null)['p']).toBe(
      applyRedaction({ p: 'xyzzy12345' }, ['p'])['p'],
    );
  });
});

describe('applyRedaction - fail closed', () => {
  test('an unusable redactedKeys list marks every key', () => {
    // Not an array, or holding a non-string: the caller asked for masking and this
    // cannot tell what for, so nothing comes back rather than everything.
    for (const redactedKeys of [
      'password' as unknown as string[],
      [42] as unknown as string[],
    ]) {
      const result = applyRedaction(
        { password: 'hunter2secret' },
        redactedKeys,
      );

      expect(JSON.stringify(result)).not.toContain('hunter2secret');
    }
  });

  test('a non-array reporting no length fails closed rather than passing params through', () => {
    // The zero-length exit returns `params` itself, so what the list *is* has to be
    // settled before how long it says it is. A non-array answering `0` otherwise read as
    // "nothing was asked for" and handed back the very values the caller named - in the
    // clear, and with no report to say redaction had been skipped.
    const reported: string[] = [];

    const result = applyRedaction(
      { password: 'hunter2secret' },
      { length: 0 } as unknown as string[],
      undefined,
      (_error, key) => {
        reported.push(key);
      },
    );

    expect(JSON.stringify(result)).not.toContain('hunter2secret');
    expect(reported).toEqual(['<redactedKeys>']);
  });

  test('a params object that cannot be walked marks only the key that threw', () => {
    // A sibling whose read throws stops the walk, so the bag is re-read one key at a
    // time: the throwing sibling is marked where it is, and the named key is still
    // masked rather than the whole log line losing its params over an unrelated getter.
    const params: Record<string, unknown> = { password: 'hunter2secret' };

    Object.defineProperty(params, 'boom', {
      get(): never {
        throw new Error('nope');
      },
      enumerable: true,
    });

    const result = applyRedaction(params, ['password']);

    expect(result['boom']).toBe(REDACTION_FAILED_MARKER);
    expect(result['password']).not.toBe('hunter2secret');
    expect(result['password']).not.toBe(REDACTION_FAILED_MARKER);
    expect(JSON.stringify(result)).not.toContain('hunter2secret');
  });

  test('a literal dotted key still fails closed when redaction throws', () => {
    // The catch writes through `setNestedValue`, which re-parses the key as a path and
    // finds none - so without the literal-slot write the clone's original survives.
    const result = applyRedaction(
      { 'user.password': 'hunter2' },
      ['user.password'],
      () => {
        throw new Error('redactor blew up');
      },
    );

    expect(result['user.password']).toBe(REDACTION_FAILED_MARKER);
  });

  test('a literal dotted key fails closed with the default redactFunction', () => {
    // No user code involved: a value whose `toString` throws fails inside
    // `stringifyTemplateValue` on the success path and lands in the same catch.
    const result = applyRedaction(
      {
        'user.password': {
          toString(): string {
            throw new Error('no');
          },
          secret: 'hunter2',
        },
      },
      ['user.password'],
    );

    expect(JSON.stringify(result)).not.toContain('hunter2');
  });

  // Redaction runs user code (`redactFunction`) over caller-supplied values on a path
  // that must not throw. When any of it fails, the one unacceptable outcome is leaving
  // the original value in place, so a failure marks the key instead.

  test('a throwing redactFunction marks the key instead of leaking it', () => {
    const result = applyRedaction(
      { password: 'hunter2', user: 'kev' },
      ['password'],
      () => {
        throw new Error('redactor blew up');
      },
    );

    expect(result['password']).toBe(REDACTION_FAILED_MARKER);
    expect(result['password']).not.toBe('hunter2');
    expect(result['user']).toBe('kev');
  });

  test('a value whose toString throws does not leak', () => {
    const hostile = {
      secret: 'hunter2',
      toString() {
        throw new Error('no');
      },
    };

    const result = applyRedaction({ password: hostile }, ['password']);

    // The hostile value is a plain object, so it is walked rather than stringified and
    // its `toString` is never called - each of its own properties is masked instead.
    // The guarantee that matters holds either way: the original is not left in place.
    expect(JSON.stringify(result)).not.toContain('hunter2');
  });

  test('a throwing redactFunction on a nested path marks that path', () => {
    const result = applyRedaction(
      { user: { password: 'hunter2', name: 'kev' } },
      ['user.password'],
      () => {
        throw new Error('redactor blew up');
      },
    );

    const user = result['user'] as Record<string, unknown>;

    expect(user['password']).toBe(REDACTION_FAILED_MARKER);
    expect(user['name']).toBe('kev');
  });

  test('a cyclic params object is still redacted normally', () => {
    // The walk handles cycles, so this does not reach the fail-closed path — pinned so
    // the case below is not mistaken for covering it.
    const cyclic: Record<string, unknown> = { password: 'hunter2' };

    cyclic['self'] = cyclic;

    const result = applyRedaction(cyclic, ['password']);

    expect(result['password']).not.toBe('hunter2');
    expect(result['password']).not.toBe(REDACTION_FAILED_MARKER);
  });

  test('an unreadable param never leaves the originals in place', () => {
    // A throwing getter defeats reading the bag in one go, unlike a cycle. The named key
    // is still masked; only the unreadable one is marked.
    const uncopyable = {
      password: 'hunter2',
      get boom(): never {
        throw new Error('cannot read');
      },
    };

    const result = applyRedaction(uncopyable, ['password']);

    expect(result['boom']).toBe(REDACTION_FAILED_MARKER);
    expect(Object.values(result)).not.toContain('hunter2');
  });

  test('an unreadable param that is itself redacted keeps the marker', () => {
    // The re-read leaves the marker in place of the value it could not read, and the walk
    // would then mask *that* - turning `***REDACTION FAILED***` into something that looks
    // like an ordinary successful mask, which is the one thing the distinct marker exists
    // to rule out.
    const params: Record<string, unknown> = { keep: 'diagnostic' };

    Object.defineProperty(params, 'password', {
      get(): never {
        throw new Error('nope');
      },
      enumerable: true,
    });

    const result = applyRedaction(params, ['password']);

    expect(result['password']).toBe(REDACTION_FAILED_MARKER);
    expect(result['keep']).toBe('diagnostic');
  });

  test('a param read once is not read again after it throws', () => {
    // A getter that throws is marked, not retried. The bag used to be copied twice - an
    // unguarded pass, then a guarded one only if that threw - so a getter that failed once
    // and then answered had its second answer stored, and every value was read a second
    // time whenever any one of them failed. One guarded pass reads each param exactly
    // once, and a read that threw stays a failure rather than being asked again.
    let reads = 0;
    const params: Record<string, unknown> = { password: 'hunter2' };

    Object.defineProperty(params, 'flaky', {
      get(): string {
        reads++;

        if (reads === 1) {
          throw new Error('first read only');
        }

        return 'second-read-value';
      },
      enumerable: true,
      configurable: true,
    });

    const result = applyRedaction(params, ['password']);

    expect(reads).toBe(1);
    expect(result['flaky']).toBe(REDACTION_FAILED_MARKER);
    expect(result['password']).not.toBe('hunter2');
  });

  test('a readable param is read exactly once', () => {
    let reads = 0;
    const params: Record<string, unknown> = { password: 'hunter2' };

    Object.defineProperty(params, 'counted', {
      get(): string {
        reads++;

        return 'value';
      },
      enumerable: true,
      configurable: true,
    });

    applyRedaction(params, ['password']);

    expect(reads).toBe(1);
  });

  test('a revoked Proxy as params yields markers only', () => {
    const revocable = Proxy.revocable({ password: 'hunter2' }, {});

    revocable.revoke();

    const result = applyRedaction(revocable.proxy, ['password']);

    expect(result['password']).toBe(REDACTION_FAILED_MARKER);
  });
});

describe('applyRedaction - params it was not asked to redact', () => {
  test('keeps a non-plain param intact beside a redacted one', () => {
    // Redaction rebuilt every object it walked, which read `Object.entries` - empty for
    // a `Date` and a `Set`, and blind to the non-enumerable `message` and `stack` of an
    // `Error`. Naming one key therefore flattened every other param to `{}`, both in the
    // rendered message and in the `redactedParams` a structured sink reads.
    const when = new Date('2020-01-01T00:00:00Z');
    const failure = new Error('boom');
    const tags = new Set(['a']);

    const redacted = applyRedaction(
      { password: 'hunter2secret', when, failure, tags },
      ['password'],
    );

    expect(redacted['password']).not.toBe('hunter2secret');
    expect(redacted['when']).toBe(when);
    expect(redacted['failure']).toBe(failure);
    expect(redacted['tags']).toBe(tags);
    expect((redacted['failure'] as Error).message).toBe('boom');
  });

  test('hands back a copy of the bag, sharing everything under it', () => {
    // The bag itself is always copied, so what the template renderer can resolve is
    // exactly what the walk saw - a non-enumerable key, or one a `Proxy` hides from
    // `ownKeys`, is invisible to both rather than unmasked in the walk and still
    // printable by lookup. Nothing beneath it is copied, so an untouched value is still
    // the caller's own.
    const params = { a: 1, nested: { b: 2 } };
    const result = applyRedaction(params, ['missing']);

    expect(result).not.toBe(params);
    expect(result).toEqual(params);
    expect(result['nested']).toBe(params.nested);
  });

  test('copies a key the bag inherits, which the renderer would resolve', () => {
    // `{{plan}}` resolves by lookup, which walks the prototype chain, so a bag built
    // with `Object.create` used to render a value the walk never saw and never masked.
    const params: Record<string, unknown> = Object.create({ plan: 'pro' });

    params['user'] = 'bob';

    expect(applyRedaction(params, ['missing'])).toEqual({
      plan: 'pro',
      user: 'bob',
    });
  });

  test('drops a key the renderer could resolve but the walk cannot see', () => {
    const params: Record<string, unknown> = {};

    Object.defineProperty(params, 'password', {
      value: 'hunter2secret',
      enumerable: false,
    });

    const result = applyRedaction(params, ['password']);

    expect('password' in result).toBe(false);
    expect(JSON.stringify(result)).not.toContain('hunter2secret');
  });
});

describe('applyRedaction - what a redactFunction may return', () => {
  const SECRET = 'hunter2secret';
  const DEFAULT_MASKED = 'h***********t';

  // Cast at the boundary: the published type now rules most of these out, and the point
  // is what a JavaScript caller - who has no type to stop them - still gets.
  const ask = (returned: unknown): unknown =>
    applyRedaction(
      { password: SECRET },
      ['password'],
      (() => returned) as unknown as RedactFunction,
    )['password'];

  test('an object naming only settings is a masking request', () => {
    expect(ask({ percent: 100 })).toBe('*'.repeat(SECRET.length));
    expect(ask({ maskChar: '#', percent: 100 })).toBe(
      '#'.repeat(SECRET.length),
    );
  });

  test('an object that is not a usable request gets the default masking', () => {
    // An object is always read as a masking request, never as a replacement value.
    // Emitting one put a rendered `{"note":"x"}` in the log line where a masked value
    // belonged; reading an unrecognized shape *as* a config was worse still, discarding
    // the caller's value and emitting a proportional mask of the original in its place.
    for (const returned of [
      {},
      { note: 'withheld' },
      { percent: 10, note: 'x' },
      ['a', 'b'],
    ]) {
      expect(ask(returned)).toBe(DEFAULT_MASKED);
      expect(ask(returned)).toBe(ask(null));
    }
  });

  test('an unusable request defers in full, non-string handling included', () => {
    // Asserted on a derived value, which is the only place the two paths can differ:
    // routed through the masker instead of the deferral, an unusable request would
    // partially mask a produced string and hand back a `URL` with its query intact.
    const url = new URL('https://api.x.test/v1?api_key=sk_live_abcdef123456');
    const via = (returned: unknown): unknown =>
      applyRedaction(
        { endpoint: url },
        ['endpoint'],
        (() => returned) as unknown as RedactFunction,
      )['endpoint'];

    for (const returned of [{}, { note: 'x' }, { percent: 10, note: 'x' }]) {
      expect(via(returned)).toBe('***REDACTED***');
      expect(via(returned)).toBe(via(null));
    }
  });

  test('nothing the caller returned leaks through an unusable request', () => {
    const replacement = ask({ note: 'withheld' });

    expect(JSON.stringify(replacement)).not.toContain('withheld');
    expect(JSON.stringify(replacement)).not.toContain(SECRET.slice(0, 3));
  });
});

describe('applyRedaction - reporting why redaction failed', () => {
  const SECRET = 'hunter2secret';
  const boom = (): never => {
    throw new Error('redactor exploded');
  };

  test('a throwing redactFunction reaches onRedactionError', () => {
    const reports: [string, string][] = [];

    const result = applyRedaction(
      { password: SECRET },
      ['password'],
      boom,
      (error, key) => reports.push([key, error.message]),
    );

    expect(reports).toEqual([['password', 'redactor exploded']]);
    expect(result['password']).toBe(REDACTION_FAILED_MARKER);
  });

  test('a non-array redactedKeys is reported rather than dropped in silence', () => {
    // This branch returns `{}` - every param gone. Without a report that is indisputably
    // correct and completely inexplicable from the outside.
    const reports: string[] = [];

    expect(
      applyRedaction(
        { password: SECRET },
        'password' as unknown as string[],
        undefined,
        (_error, key) => reports.push(key),
      ),
    ).toEqual({});
    expect(reports).toEqual(['<redactedKeys>']);
  });

  test('the redacted params are identical with and without a handler', () => {
    // The diagnostic is additive; it must not change what is logged.
    const withHandler = applyRedaction(
      { password: SECRET },
      ['password'],
      boom,
      () => undefined,
    );
    const withoutHandler = applyRedaction(
      { password: SECRET },
      ['password'],
      boom,
    );

    expect(withHandler).toEqual(withoutHandler);
  });
});
