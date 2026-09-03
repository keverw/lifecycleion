import { describe, expect, test } from 'bun:test';
import {
  applyRedaction,
  defaultRedactFunction,
  REDACTION_FAILED_MARKER,
} from './redaction';

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
    expect((redacted.users as any)[0].password).toBe('se*****23');
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
    expect((redacted.sessions as any)[0].tokens[1]).toBe('se*******ken');
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

    expect((redacted.users as any)[0]['password-hash']).toBe('se*****23');
    expect((redacted.credentials as any)['api-key']).toBe('se*******ken');
  });

  test('should treat dot notation and quoted bracket notation as equivalent for the same key', () => {
    const params = {
      user: {
        password: 'secret123',
      },
    };

    const dotRedacted = applyRedaction(params, ['user.password']);
    const bracketRedacted = applyRedaction(params, ['user["password"]']);

    expect((dotRedacted.user as any).password).toBe('se*****23');
    expect((bracketRedacted.user as any).password).toBe('se*****23');
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
    const result = defaultRedactFunction('apiKey', 12345);

    expect(result).toBe('***REDACTED***');
  });

  test('should handle object values', () => {
    const result = defaultRedactFunction('metadata', { key: 'value' });

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
    const result = applyRedaction(
      { u: { 'my key': 'hunter2', contraseña: 'hunter2' } },
      ['u.my key', 'u.contraseña'],
    );

    const u = result['u'] as Record<string, unknown>;

    expect(u['my key']).not.toBe('hunter2');
    expect(u['contraseña']).not.toBe('hunter2');
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

  test('returning nothing is used literally and does not defer', () => {
    // Treating a missing return as a deferral would turn a value an existing caller was
    // dropping into a partial mask, disclosing more than before.
    const result = applyRedaction(
      { p: 'hunter2secret' },
      ['p'],
      () => undefined,
    );

    expect(result['p']).toBeUndefined();
    expect(result['p']).not.toBe(
      applyRedaction({ p: 'hunter2secret' }, ['p'])['p'],
    );
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
    // `deepClone` handles cycles, so this does not reach the fail-closed path — pinned
    // so the case below is not mistaken for covering it.
    const cyclic: Record<string, unknown> = { password: 'hunter2' };

    cyclic['self'] = cyclic;

    const result = applyRedaction(cyclic, ['password']);

    expect(result['password']).not.toBe('hunter2');
    expect(result['password']).not.toBe(REDACTION_FAILED_MARKER);
  });

  test('an uncopyable params object yields markers only, never the originals', () => {
    // A throwing getter is something `deepClone` genuinely cannot copy, unlike a cycle.
    const uncopyable = {
      password: 'hunter2',
      get boom(): never {
        throw new Error('cannot read');
      },
    };

    const result = applyRedaction(uncopyable, ['password']);

    expect(result['password']).toBe(REDACTION_FAILED_MARKER);
    expect(Object.values(result)).not.toContain('hunter2');
  });

  test('a revoked Proxy as params yields markers only', () => {
    const revocable = Proxy.revocable({ password: 'hunter2' }, {});

    revocable.revoke();

    const result = applyRedaction(revocable.proxy, ['password']);

    expect(result['password']).toBe(REDACTION_FAILED_MARKER);
  });
});
