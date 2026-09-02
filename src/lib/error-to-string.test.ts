import { describe, expect, it } from 'bun:test';
import { errorToString } from './error-to-string';
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
      // A comma-joined string, a Set, a non-string entry, and a malformed path all mean
      // the caller asked for masking somewhere this cannot locate.
      for (const names of [
        'password,token',
        new Set(['password']),
        [42],
        ['a.'],
      ]) {
        expect(render({ password: SECRET }, names)).not.toContain(SECRET);
      }
    });

    it('should mask a nested error as a whole when the path names it', () => {
      const inner = Object.assign(new Error('inner'), {
        additionalInfo: { password: SECRET },
      });

      expect(render({ cause: inner }, ['cause']).includes(SECRET)).toBe(false);
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
