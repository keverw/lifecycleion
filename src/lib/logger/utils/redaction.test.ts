import { describe, expect, test } from 'bun:test';
import { applyRedaction, defaultRedactFunction } from './redaction';

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
    expect(redacted.metadata).not.toEqual({ key: 'value' });
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
