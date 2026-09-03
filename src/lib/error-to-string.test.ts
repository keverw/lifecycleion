import { describe, expect, it } from 'bun:test';
import { errorToString } from './error-to-string';
import { applyRedaction } from './logger/utils/redaction';
import { EOL } from './constants';

class MyPrefixErrTestErr extends Error {
  public errPrefix = 'MyPrefixErr';
  public errType = 'TestErr';
  public errCode?: string;
  public additionalInfo: Record<string, unknown> = {};
  public sensitiveFieldNames = ['username'];

  constructor(additionalInfo: { username: string; email: string }) {
    super('Test Err!');

    Error.captureStackTrace(this, MyPrefixErrTestErr);

    if (additionalInfo) {
      this.additionalInfo = additionalInfo;
    }
  }
}

class FooHelpersErrIsEmptyIDInvalidTypeGiven extends Error {
  public errPrefix = 'FooHelpersErr';
  public errType = 'IsEmptyID';
  public errCode = 'InvalidIDTypeGiven';
  public additionalInfo: Record<string, unknown> = {};

  constructor(additionalInfo: { givenType: string; expectedType: string[] }) {
    super('Invalid ID type given');

    Error.captureStackTrace(this, FooHelpersErrIsEmptyIDInvalidTypeGiven);

    if (additionalInfo) {
      this.additionalInfo = additionalInfo;
    }
  }
}

class OriginalErrorTestErr extends Error {
  public errPrefix = 'OriginalErrorTest';
  public errType = 'OriginalErrorTestErr';
  public additionalInfo: Record<string, unknown> = {};

  constructor(originalError: Error) {
    super('Error with original error');

    Error.captureStackTrace(this, OriginalErrorTestErr);

    this.additionalInfo = {
      originalError,
    };
  }
}

function sanitizeStackTrace(error: Error): Error {
  const sanitizedStack = error.stack?.replace(
    /\s+at\s+(?:(?!node_modules).)*(?:\(.*\)|$)/gm,
    (match) => {
      const sanitizedMatch = match
        .replace(/\(?(?:file:\/\/)?.*\/([^/]+\/[^/]+)\)?/, '(<TEST_FILE>/$1)')
        .replace(/:\d+:\d+\)?/, ':<LINE>:<COLUMN>)');

      return `\n    at ${sanitizedMatch}`;
    },
  );

  error.stack = sanitizedStack || error.stack;

  return error;
}

describe('errorToString', () => {
  it('should stringify MyPrefixErrTestErr correctly', () => {
    const error = sanitizeStackTrace(
      new MyPrefixErrTestErr({
        username: 'johndoe',
        email: 'johndoe@example.com',
      }),
    );

    expect(EOL + errorToString(error)).toMatchSnapshot();
  });

  it('should stringify FooHelpersErrIsEmptyIDInvalidIDTypeGiven correctly', () => {
    const error = sanitizeStackTrace(
      new FooHelpersErrIsEmptyIDInvalidTypeGiven({
        givenType: 'string',
        expectedType: ['number', 'bigint'],
      }),
    );

    expect(EOL + errorToString(error)).toMatchSnapshot();
  });

  it('should handle nested errors correctly', () => {
    const originalError = sanitizeStackTrace(new Error('Original error'));
    const error = sanitizeStackTrace(new OriginalErrorTestErr(originalError));

    expect(EOL + errorToString(error)).toMatchSnapshot();
  });

  it('should handle a null', () => {
    expect(EOL + errorToString(null)).toMatchSnapshot();
  });

  it('should handle a normal object', () => {
    expect(
      EOL +
        errorToString({
          message: 'normal object mimicking an error object',
        }),
    ).toMatchSnapshot();
  });
  describe('sensitiveFieldNames masking', () => {
    // Same path syntax as the logger's `redactedKeys`: a bare name is a top-level key of
    // `additionalInfo`, and reaching a nested value takes a path.
    const SECRET = 'hunter2secret';

    const render = (info: unknown, names: unknown): string => {
      const error = Object.assign(new Error('auth failed'), {
        additionalInfo: info,
        sensitiveFieldNames: names,
      });

      return errorToString(error);
    };

    it('should mask a top-level key named by a bare name', () => {
      expect(render({ password: SECRET }, ['password'])).not.toContain(SECRET);
    });

    it('should NOT mask a nested key from a bare name', () => {
      // Matches `redactedKeys`: a bare name addresses the top level only.
      expect(render({ user: { password: SECRET } }, ['password'])).toContain(
        SECRET,
      );
    });

    it('should mask a nested key named by a path', () => {
      expect(
        render({ user: { password: SECRET } }, ['user.password']),
      ).not.toContain(SECRET);
    });

    it('should mask through an array index', () => {
      expect(
        render({ items: [{ token: SECRET }] }, ['items[0].token']),
      ).not.toContain(SECRET);
    });

    it('should mask a deep path', () => {
      expect(render({ a: { b: { c: SECRET } } }, ['a.b.c'])).not.toContain(
        SECRET,
      );
    });

    it('should leave non-sensitive values alone', () => {
      expect(render({ user: { name: 'alice' } }, ['password'])).toContain(
        'alice',
      );
    });

    it('should fail closed when the list is not usable', () => {
      // Asserted on the positive marker, not just the absence of the secret: the
      // top-level backstop also returns a string with no secret in it, so
      // `not.toContain` alone passes even when the guard under test is removed.
      for (const names of ['password,token', new Set(['password']), [42]]) {
        const rendered = render({ password: SECRET }, names);

        expect(rendered).toContain('*** (sensitiveFieldNames unreadable)');
        expect(rendered).not.toContain(SECRET);
      }
    });

    it('should fail closed when sensitiveFieldNames cannot be read', () => {
      // A throwing accessor reads back as `undefined` through an ordinary guarded read,
      // which is indistinguishable from absent - and absent means "mask nothing".
      const error = new Error('auth failed');

      Object.defineProperty(error, 'additionalInfo', {
        value: { password: SECRET },
        enumerable: true,
      });
      Object.defineProperty(error, 'sensitiveFieldNames', {
        get() {
          throw new Error('boom');
        },
      });

      const rendered = errorToString(error);

      expect(rendered).toContain('*** (sensitiveFieldNames unreadable)');
      expect(rendered).not.toContain(SECRET);
    });

    it('should mask a bare name that is not a valid path segment', () => {
      // `getPathParts` only accepts `\w+` unquoted, so `password-hash` does not parse -
      // but the logger masks it fine through its top-level branch, and so must this.
      const rendered = render({ 'password-hash': SECRET, keep: 'diagnostic' }, [
        'password-hash',
      ]);

      expect(rendered).not.toContain(SECRET);
      // The rest of additionalInfo must survive, not be dropped wholesale.
      expect(rendered).toContain('diagnostic');
    });

    it('should mask a hyphenated nested key without quoting', () => {
      // Same grammar as the logger's `redactedKeys`: an unquoted segment is any run of
      // characters that are not `.`, `[` or `]`, so ordinary names need no quoting.
      expect(
        render({ user: { 'password-hash': SECRET } }, ['user.password-hash']),
      ).not.toContain(SECRET);

      expect(
        render({ users: [{ 'api-key': SECRET }] }, ['users[0].api-key']),
      ).not.toContain(SECRET);

      // The quoted form remains equivalent.
      expect(
        render({ user: { 'password-hash': SECRET } }, [
          'user["password-hash"]',
        ]),
      ).not.toContain(SECRET);
    });

    it('should mask nothing for genuinely unsupported syntax', () => {
      // Wildcards are not supported, and an unparseable entry is not the fail-closed
      // case: it masks nothing and leaves the other fields rendering.
      const rendered = render({ users: [{ password: SECRET }], keep: 'diag' }, [
        'users[*].password',
      ]);

      expect(rendered).toContain(SECRET);
      expect(rendered).toContain('diag');
      expect(rendered).not.toContain('sensitiveFieldNames unreadable');
    });

    it('should mask a key spelled literally like a path', () => {
      // Matches the logger: a dotted entry is ambiguous, so both readings are covered.
      expect(
        render({ 'user.password': SECRET }, ['user.password']),
      ).not.toContain(SECRET);

      expect(
        render({ 'user.password': SECRET, user: { password: SECRET } }, [
          'user.password',
        ]),
      ).not.toContain(SECRET);
    });

    it('should mask a nested error as a whole when the path names it', () => {
      const inner = Object.assign(new Error('inner'), {
        additionalInfo: { password: SECRET },
      });

      expect(render({ cause: inner }, ['cause']).includes(SECRET)).toBe(false);
    });
  });

  describe('sensitiveFieldNames redactFunction option', () => {
    const SEC = 'hunter2secret';

    const mk = (info: unknown, names: string[]): Error =>
      Object.assign(new Error('x'), {
        additionalInfo: info,
        sensitiveFieldNames: names,
      });

    it('should default to the same masking the logger applies', () => {
      const rendered = errorToString(mk({ p: SEC }, ['p']));

      expect(rendered).not.toContain(SEC);
      // Byte-for-byte what `applyRedaction` produces for the same value.
      expect(rendered).toContain(
        String(applyRedaction({ p: SEC }, ['p'])['p']),
      );
    });

    it('should defer to the default when the function returns null', () => {
      const rendered = errorToString(
        mk({ p: SEC, other: SEC }, ['p', 'other']),
        80,
        {
          redactFunction: (key) => (key === 'other' ? 'CUSTOM' : null),
        },
      );

      expect(rendered).toContain('CUSTOM');
      expect(rendered).toContain(
        String(applyRedaction({ p: SEC }, ['p'])['p']),
      );
      expect(rendered).not.toContain(SEC);
    });

    it('should use a custom redactFunction at every depth', () => {
      const shapes: [unknown, string[]][] = [
        [{ u: { p: SEC } }, ['u.p']],
        [{ items: [SEC] }, ['items[0]']],
        [{ items: [{ tok: SEC }] }, ['items[0].tok']],
        [{ a: { b: { c: SEC } } }, ['a.b.c']],
      ];

      for (const [info, names] of shapes) {
        const rendered = errorToString(mk(info, names), 80, {
          redactFunction: () => 'XXMASKEDXX',
        });

        expect(rendered).toContain('XXMASKEDXX');
        expect(rendered).not.toContain(SEC);
      }
    });

    it('should receive the key and value', () => {
      const seen: [string, unknown][] = [];

      errorToString(mk({ p: SEC }, ['p']), 80, {
        redactFunction: (key, value) => {
          seen.push([key, value]);

          return '***';
        },
      });

      expect(seen).toEqual([['p', SEC]]);
    });

    it('should fall back to *** when the redactFunction throws', () => {
      const rendered = errorToString(mk({ p: SEC }, ['p']), 80, {
        redactFunction: () => {
          throw new Error('boom');
        },
      });

      expect(rendered).toContain('***');
      expect(rendered).not.toContain(SEC);
    });

    it('should hand the function the same key and value the logger does', () => {
      // The point of the shared shape: one function must see identical arguments from
      // both, or "the same function serves both" is not true. Captured directly rather
      // than parsed out of the rendered table.
      const shapes: [Record<string, unknown>, string[]][] = [
        [{ p: SEC }, ['p']],
        [{ p: 1234567890 }, ['p']],
        [{ p: true }, ['p']],
        [{ user: { password: SEC } }, ['user.password']],
        [{ items: [SEC] }, ['items[0]']],
      ];

      for (const [info, names] of shapes) {
        const fromLogger: string[] = [];
        const fromRender: string[] = [];

        const record =
          (into: string[]) =>
          (key: string, value: unknown): string => {
            into.push(`${key}|${typeof value}|${String(value)}`);

            return '***';
          };

        applyRedaction(structuredClone(info), names, record(fromLogger));
        errorToString(mk(info, names), 200, {
          redactFunction: record(fromRender),
        });

        expect(fromRender).toEqual(fromLogger);
        expect(fromLogger.length).toBe(1);
      }
    });

    it('should not hand the function a live reference to the error', () => {
      // The value is stringified first, as the logger does, so a mutating function
      // cannot reach into the caller's own error object.
      const info: Record<string, unknown> = { creds: { pw: SEC } };

      errorToString(mk(info, ['creds']), 100, {
        redactFunction: (_key, value) => {
          (value as Record<string, unknown>).injected = 'HELLO';

          return '***';
        },
      });

      expect(JSON.stringify(info)).toBe(JSON.stringify({ creds: { pw: SEC } }));
    });

    it('should use undefined literally rather than deferring', () => {
      // Only `null` defers. Treating a missing return as a deferral would turn a value
      // an existing caller was dropping into a partial mask.
      const rendered = errorToString(mk({ p: SEC }, ['p']), 80, {
        redactFunction: () => undefined,
      });

      expect(rendered).not.toContain(SEC);
      expect(rendered).not.toContain(
        String(applyRedaction({ p: SEC }, ['p'])['p']),
      );
    });
  });

  describe('hostile input', () => {
    // `errorToString` runs on reporting paths — `reportCallbackError` calls it to render
    // whatever a callback threw — so it must describe a value it cannot read rather than
    // raising a second failure on top of the first.

    it('should not throw when the message accessor throws', () => {
      const error = Object.assign(new Error('placeholder'), { code: 'E42' });

      Object.defineProperty(error, 'message', {
        get() {
          throw new Error('message getter blew up');
        },
      });

      const rendered = errorToString(error);

      // Asserted on the surviving rows, not just `typeof`: the top-level backstop also
      // returns a string, so a `typeof` check passes even with every read guard removed.
      expect(rendered).not.toBe('<error could not be rendered>');
      expect(rendered).toContain('E42');
    });

    it('should not throw when the stack accessor throws', () => {
      const error = new Error('boom');

      Object.defineProperty(error, 'stack', {
        get() {
          throw new Error('stack getter blew up');
        },
      });

      expect(errorToString(error)).toContain('boom');
    });

    it('should not throw on a cyclic additionalInfo and marks the cycle', () => {
      const cyclic: Record<string, unknown> = { name: 'loop' };

      cyclic['self'] = cyclic;

      const error = Object.assign(new Error('boom'), {
        additionalInfo: { payload: cyclic },
      });

      const rendered = errorToString(error);

      expect(rendered).toContain('boom');
      expect(rendered).toContain('circular');
    });

    it('should not throw when a property read traps', () => {
      const trap = new Proxy(new Error('boom'), {
        get() {
          throw new Error('trap');
        },
      });

      // Every member read is refused, so the table is empty - but it is a table, not the
      // top-level backstop, which is what proves the per-read guards did the work.
      expect(errorToString(trap)).not.toBe('<error could not be rendered>');
    });

    it('should degrade one unreadable leaf without losing the rest', () => {
      // `Array.isArray` throws on a revoked Proxy, and it runs outside the per-value
      // guards, so an unguarded call collapsed the whole render to the backstop.
      const revocable = Proxy.revocable({}, {});

      revocable.revoke();

      const rendered = errorToString(
        Object.assign(new Error('revoked'), {
          additionalInfo: { bad: revocable.proxy, good: 'kept' },
        }),
      );

      expect(rendered).not.toBe('<error could not be rendered>');
      expect(rendered).toContain('revoked');
      expect(rendered).toContain('kept');
    });

    it('should mark a true cycle but render a merely repeated reference twice', () => {
      // `<circular>` tracks the current path, not every object ever seen. An object
      // referenced twice side by side is not circular and must render in full both
      // times; only an object contained within itself is cut.
      const shared = { label: 'shared' };

      const repeated = errorToString(
        Object.assign(new Error('boom'), {
          additionalInfo: { first: shared, second: shared },
        }),
      );

      expect(repeated).not.toContain('<circular>');
      expect(repeated.match(/shared/g)?.length).toBe(2);

      const cyclic: Record<string, unknown> = { name: 'loop' };

      cyclic['self'] = cyclic;

      expect(
        errorToString(
          Object.assign(new Error('boom'), { additionalInfo: { p: cyclic } }),
        ),
      ).toContain('<circular>');
    });

    it('should fall back to the backstop when the render exhausts the stack', () => {
      // The outermost guarantee. Deeply nested but acyclic, so the `<circular>` guard
      // does not apply and the recursive walk keeps descending until the stack is gone.
      // A `RangeError` from that must not escape a caller whose only job was reporting a
      // failure, so the whole render is wrapped.
      let deep: Record<string, unknown> = { end: true };

      for (let i = 0; i < 200_000; i++) {
        deep = { next: deep };
      }

      const error = Object.assign(new Error('boom'), {
        additionalInfo: { deep },
      });

      expect(errorToString(error)).toBe('<error could not be rendered>');
    });

    it('should not throw on a BigInt nested in additionalInfo', () => {
      const error = Object.assign(new Error('boom'), {
        additionalInfo: { big: { nested: 10n } },
      });

      expect(errorToString(error)).toContain('boom');
    });
  });
});
