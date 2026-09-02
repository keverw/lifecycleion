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
    expect(redacted.metadata).toBe('[ob*********ct]');
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

    expect(seen).toEqual([
      ['error', 'Error: boom'],
      ['users', 'a,b'],
      ['metadata', '[object Object]'],
    ]);

    expect(redacted.error).toBe('[MASKED-error]');
    expect(redacted.users).toBe('[MASKED-users]');
    expect(redacted.metadata).toBe('[MASKED-metadata]');
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

  test('a value whose toString throws marks the key instead of leaking it', () => {
    const hostile = {
      toString() {
        throw new Error('no');
      },
    };

    const result = applyRedaction({ password: hostile }, ['password']);

    expect(result['password']).toBe(REDACTION_FAILED_MARKER);
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
