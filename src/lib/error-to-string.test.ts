import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  muteConsoleError,
  restoreConsoleError,
} from './internal/console-test-utils';
import { errorToString, type RedactFieldFunction } from './error-to-string';
import {
  applyRedaction,
  REDACTION_FAILED_MARKER,
} from './logger/utils/redaction';
import { EOL } from './constants';
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

/** A `redactFunction` as a JavaScript caller may write one, before the type narrows it. */
type RedactFunctionLike = (key: string, value: unknown) => unknown;

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
      // A bare name never goes through the path grammar, so it is masked whatever it is
      // spelled with - the logger masks it through its top-level branch, and so must
      // this.
      const rendered = render({ 'password!': SECRET, keep: 'diagnostic' }, [
        'password!',
      ]);

      expect(rendered).not.toContain(SECRET);
      // The rest of additionalInfo must survive, not be dropped wholesale.
      expect(rendered).toContain('diagnostic');
    });

    it('should mask a hyphenated nested key without quoting', () => {
      // Same grammar as the logger's `redactedKeys`: an unquoted segment is a run of
      // name characters, hyphens included, so ordinary names need no quoting.
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

    it("should honour a thrown plain object's own sensitiveFieldNames once it is wrapped as a cause", () => {
      // The reporting paths no longer render a thrown value directly: `reportCallbackError`
      // and the `Logger` error listener both wrap a non-`Error` as `new Error(..., { cause })`.
      // A thrown object naming its own sensitive fields then arrived one level down, was
      // walked as ordinary structure under the parent's empty list, and printed them.
      const thrown = {
        message: 'boom',
        additionalInfo: { apiKey: SECRET },
        sensitiveFieldNames: ['apiKey'],
      };

      const rendered = errorToString(new Error('wrapper', { cause: thrown }));

      expect(rendered.includes(SECRET)).toBe(false);
      expect(rendered).toContain('AdditionalInfo.apiKey');
    });

    it('should still render a plain object that names nothing it can address', () => {
      // Only an error-shaped object takes the fresh root, because `sensitiveFieldNames`
      // names paths into `additionalInfo`. One without it stays on the ordinary walk, where
      // its keys still render rather than being dropped for a list that matches nothing.
      const rendered = errorToString(
        new Error('wrapper', { cause: { note: 'keep me' } }),
      );

      expect(rendered).toContain('keep me');
    });

    it('should not drop the keys of an object whose additionalInfo the table cannot render', () => {
      // The gate has to require what the table requires, not merely that the key exists.
      // `additionalInfo: 'text'` and `cause: null` passed a looser gate and then rendered
      // as a completely empty table, losing every key the object had.
      for (const shape of [
        {
          additionalInfo: 'not-an-object',
          sensitiveFieldNames: ['a'],
          keep: 'KEEPME',
        },
        { cause: null, sensitiveFieldNames: ['a'], keep: 'KEEPME' },
      ]) {
        expect(errorToString(new Error('w', { cause: shape }))).toContain(
          'KEEPME',
        );
      }
    });

    it('should mask a named field on an additionalInfo that is not a plain object', () => {
      // The shared walk treats a class instance, an `Error` or a `Map` as a single leaf and
      // no path can address the root, so nothing inside one was masked - while the table
      // enumerates its keys regardless and printed them.
      class Config {
        public password = SECRET;
        public other = 'ok';
      }

      const rendered = errorToString(
        Object.assign(new Error('x'), {
          additionalInfo: new Config(),
          sensitiveFieldNames: ['password'],
        }),
      );

      expect(rendered.includes(SECRET)).toBe(false);
      expect(rendered).toContain('AdditionalInfo.other');
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

    it('should mask a container leaf by leaf, keeping its shape', () => {
      // Stringifying the container masked '[object Object]' instead of the secret, and
      // joined an array so the edges of its elements survived.
      const object = errorToString(
        mk({ creds: { pw: SEC, user: 'alice' } }, ['creds']),
      );

      expect(object).not.toContain(SEC);
      expect(object).not.toContain('object Object');
      // The keys still render, so the shape survives for a reader.
      expect(object).toContain('pw');
      expect(object).toContain('user');

      const array = errorToString(mk({ items: [SEC, 'other'] }, ['items']));

      expect(array).not.toContain(SEC);
      expect(array).not.toContain('other');
    });

    it('should terminate on a self-referencing container and still render it', () => {
      // Asserted on the rendered shape, not just the absence of the secret: without the
      // cycle guard the recursion blows the stack and the top-level backstop returns
      // `<error could not be rendered>`, which also contains no secret.
      const cyclic: Record<string, unknown> = { a: SEC };

      cyclic['self'] = cyclic;

      const rendered = errorToString(mk({ p: cyclic }, ['p']), 100);

      expect(rendered).not.toContain(SEC);
      // Without the cycle guard the walk overflows the stack and the cell degrades to a
      // bare `***`, so assert the shape that only a successful walk produces: the
      // back-reference cut with the full marker.
      expect(rendered).toContain('***REDACTED***');
      expect(rendered).toContain('self');
    });

    it('should replace a non-container object outright, not partially mask it', () => {
      // The headline case: a `URL` stringifies with its query at the end, and the default
      // masking preserves a value's ends - so partial-masking a derived string left an
      // API key almost intact. Functions and symbols render derived text too.
      const secret = 'sk-live-51H8x9QcAbCdEf';
      const withToString: Record<string, unknown> = {};

      const fn = (): string => secret;

      fn.toString = (): string => `Bearer ${secret}`;
      withToString['fn'] = fn;

      const derived: [string, unknown][] = [
        ['url', new URL(`https://api.test/v1?api_key=${secret}`)],
        ['date', new Date(0)],
        ['error', new Error(secret)],
        ['map', new Map([['k', secret]])],
        [
          'instance',
          new (class {
            public apiKey = secret;
          })(),
        ],
        ['fn', withToString['fn']],
        ['symbol', Symbol(secret)],
      ];

      for (const [label, value] of derived) {
        const rendered = errorToString(mk({ p: value }, ['p']), 140);

        expect(rendered).not.toContain('AbCdEf');
        expect(rendered).not.toContain('sk-live');
        expect(rendered).toContain('***REDACTED***');
        expect(label).toBeDefined();
      }

      // A plain container is still walked rather than replaced.
      expect(errorToString(mk({ p: { k: secret } }, ['p']), 140)).not.toContain(
        '***REDACTED***',
      );
    });

    it('should honour every redactFunction return shape, like the logger', () => {
      const token = 'sk-live-51H8x9QcAbCdEf';

      // Same contract as `redactedKeys`, verified against it rather than restated.
      const shapes: RedactFunctionLike[] = [
        () => null,
        () => 20,
        () => ({ percent: 50, maskChar: '#' }),
        () => ({ strategy: 'email' as const }),
        () => 'LITERAL',
      ];

      for (const redactFunction of shapes) {
        const fromLogger = String(
          applyRedaction(
            { p: token },
            ['p'],
            redactFunction as unknown as RedactFunction,
          )['p'],
        );
        const rendered = errorToString(mk({ p: token }, ['p']), 140, {
          redactFunction: redactFunction as unknown as RedactFieldFunction,
        });

        expect(rendered).toContain(fromLogger);
        expect(rendered).not.toContain(token);
      }
    });

    it('should not partially mask a number', () => {
      expect(
        errorToString(mk({ p: 4111111111111111 }, ['p']), 90),
      ).not.toContain('1111');
    });

    it('should report a failed mask with the same marker the logger uses', () => {
      const rendered = errorToString(mk({ p: 'secretvalue' }, ['p']), 80, {
        redactFunction: () => {
          throw new Error('boom');
        },
      });

      expect(rendered).toContain(REDACTION_FAILED_MARKER);
    });

    it('should report a throwing value accessor as a failed mask', () => {
      // Read unguarded inside the mask's own try, so a throwing accessor is a failure
      // rather than `undefined` stringified to the word "undefined" and masked.
      const info = {};

      Object.defineProperty(info, 'p', {
        get(): never {
          throw new Error('nope');
        },
        enumerable: true,
      });

      const rendered = errorToString(mk(info, ['p']), 80);

      expect(rendered).toContain(REDACTION_FAILED_MARKER);
      expect(rendered).not.toContain('un*****ed');
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
          // The type now says `string`, so this is only reachable from JavaScript - which
          // is the point: a mutating function must not be able to reach the caller's own
          // error object, and it cannot, because it is handed the rendered text.
          (value as unknown as Record<string, unknown>).injected = 'HELLO';

          return '***';
        },
      });

      expect(JSON.stringify(info)).toBe(JSON.stringify({ creds: { pw: SEC } }));
    });

    it('should defer on undefined, exactly as it does on null', () => {
      // A row has to render something, so using `undefined` literally wrote the word
      // `undefined` where a masked value belonged - and a function that special-cases a
      // few keys returns nothing for every other one.
      const rendered = errorToString(mk({ p: SEC }, ['p']), 80, {
        redactFunction: () => undefined,
      });

      expect(rendered).not.toContain(SEC);
      expect(rendered).not.toContain('undefined');
      expect(rendered).toContain(
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

    it('should stop at the depth cap rather than exhausting the stack', () => {
      // Deeply nested but acyclic, so the `<circular>` guard does not apply and the walk
      // would otherwise keep descending until the stack is gone. The depth cap stops it
      // first and says where, which is strictly better than the backstop it used to hit:
      // the error's own message and stack survive instead of the whole render collapsing
      // to `<error could not be rendered>`.
      let deep: Record<string, unknown> = { end: true };

      for (let i = 0; i < 200_000; i++) {
        deep = { next: deep };
      }

      const error = Object.assign(new Error('boom'), {
        additionalInfo: { deep },
      });

      const rendered = errorToString(error);

      expect(rendered).not.toBe('<error could not be rendered>');
      expect(rendered).toContain('boom');
      expect(rendered).toContain('[max depth exceeded]');
    });

    it('bounds the output of a payload that reuses one subtree', () => {
      // Not circular and not deep: `seen` is released as the walk leaves a container, so
      // each shared child is rendered once per reference and the size doubles per level.
      // This rendered over a hundred megabytes before the length budget, and past twenty
      // levels it exceeded the maximum string length and lost the error entirely.
      let shared: Record<string, unknown> = { leaf: 'x' };

      for (let i = 0; i < 24; i++) {
        shared = { l: shared, r: shared };
      }

      const error = Object.assign(new Error('boom'), {
        additionalInfo: { shared },
      });

      const rendered = errorToString(error);

      expect(rendered).toContain('boom');
      expect(rendered).toContain('[max length exceeded]');
      // Bounded by the budget rather than by the shape of the payload: this rendered
      // over a hundred megabytes before, and grew fourfold with every two levels added.
      expect(rendered.length).toBeLessThan(2_000_000);
    });

    it('should not throw on a BigInt nested in additionalInfo', () => {
      const error = Object.assign(new Error('boom'), {
        additionalInfo: { big: { nested: 10n } },
      });

      expect(errorToString(error)).toContain('boom');
    });
  });

  describe('cause', () => {
    // `reportCallbackError` dispatches a wrapper whose message names the callback and
    // whose `cause` is the value that was actually thrown, so everything a consumer needs
    // reaches it through this row. Nothing below is incidental: each case is one that
    // rendered the cause wrongly or lost the whole table.
    it('renders a nested error cause as its own table', () => {
      const original = Object.assign(new Error('original'), {
        additionalInfo: { requestID: 'r-1' },
      });

      const rendered = errorToString(new Error('wrapper', { cause: original }));

      expect(rendered).toContain('Cause');
      expect(rendered).toContain('original');
      expect(rendered).toContain('r-1');
      expect(rendered).toContain('wrapper');
    });

    it("masks a nested error cause under the cause's own sensitiveFieldNames", () => {
      const original = Object.assign(new Error('original'), {
        additionalInfo: { token: 'tok-abcdefghijklmnop' },
        sensitiveFieldNames: ['token'],
      });

      const rendered = errorToString(new Error('wrapper', { cause: original }));

      expect(rendered).not.toContain('tok-abcdefghijklmnop');
    });

    it('addresses a non-error cause through the cause path', () => {
      const error = Object.assign(new Error('wrapper'), {
        sensitiveFieldNames: ['cause.password'],
      });

      error.cause = { password: 'hunter2secret', tenant: 'acme' };

      const rendered = errorToString(error);

      expect(rendered).not.toContain('hunter2secret');
      // Only what was named: the sibling is still readable.
      expect(rendered).toContain('acme');
    });

    it('masks a whole non-error cause named as one entry', () => {
      const error = Object.assign(new Error('wrapper'), {
        sensitiveFieldNames: ['cause'],
      });

      error.cause = { password: 'hunter2secret', tenant: 'acme' };

      const rendered = errorToString(error);

      expect(rendered).not.toContain('hunter2secret');
      expect(rendered).not.toContain('acme');
    });

    it('drops the cause when sensitiveFieldNames is unusable', () => {
      // The fail-closed rule covers the cause as well. Rendering it while refusing to
      // render `additionalInfo` two rows above would disclose what the refusal protects.
      const error = Object.assign(new Error('wrapper'), {
        additionalInfo: { note: 'n' },
        sensitiveFieldNames: 'password',
      });

      error.cause = { password: 'hunter2secret' };

      const rendered = errorToString(error, 80, {
        onRedactionError: () => undefined,
      });

      expect(rendered).not.toContain('hunter2secret');
      expect(rendered).toContain('sensitiveFieldNames unreadable');
    });

    it('renders a long cause chain instead of collapsing', () => {
      // The table throws below its minimum width, and each nested error narrowed it by
      // four: at eighteen levels the constructor threw and the backstop discarded the
      // whole render, message and stack included.
      let error = new Error('root');

      for (let index = 0; index < 40; index++) {
        error = new Error(`level ${index}`, { cause: error });
      }

      const rendered = errorToString(error);

      expect(rendered).not.toBe('<error could not be rendered>');
      expect(rendered).toContain('level 39');
    });

    it('cuts a cause that points back at itself', () => {
      const error: Error & { cause?: unknown } = new Error('self');

      error.cause = error;

      const rendered = errorToString(error);

      expect(rendered).not.toBe('<error could not be rendered>');
      expect(rendered).toContain('<circular>');
    });
  });

  describe('a path pointing into a nested error', () => {
    // A nested error is not structure either, so it gets the same fail-closed answer as a
    // class instance: named into, it is masked whole. Skipping that rule was the one way
    // a value the caller had named still rendered in the clear - the path matched nothing
    // on the way down, and the nested error then rendered under its own empty list.
    function nestedError(): Error {
      return Object.assign(new Error('inner'), {
        additionalInfo: { apiKey: 'TOPSECRET-VALUE' },
      });
    }

    it('masks a nested error named into through cause', () => {
      const error = Object.assign(new Error('outer'), {
        sensitiveFieldNames: ['cause.additionalInfo.apiKey'],
      });

      error.cause = nestedError();

      expect(errorToString(error)).not.toContain('TOPSECRET-VALUE');
    });

    it('masks a nested error named into through additionalInfo', () => {
      const error = Object.assign(new Error('outer'), {
        additionalInfo: { err: nestedError() },
        sensitiveFieldNames: ['err.additionalInfo.apiKey'],
      });

      expect(errorToString(error)).not.toContain('TOPSECRET-VALUE');
    });

    it('still renders a nested error nothing addresses', () => {
      const error = Object.assign(new Error('outer'), {
        additionalInfo: { err: nestedError() },
      });

      const rendered = errorToString(error);

      expect(rendered).toContain('AdditionalInfo.apiKey');
      expect(rendered).toContain('TOPSECRET-VALUE');
    });

    it("keeps the nested error's own list covering its own contents", () => {
      const inner = Object.assign(new Error('inner'), {
        additionalInfo: { apiKey: 'TOPSECRET-VALUE' },
        sensitiveFieldNames: ['apiKey'],
      });

      const error = Object.assign(new Error('outer'), {
        additionalInfo: { err: inner },
      });

      expect(errorToString(error)).not.toContain('TOPSECRET-VALUE');
    });
  });

  describe('objects inside an array', () => {
    it("renders an array element's object as the caller's shape", () => {
      // An array joins its elements into one cell, so an element that rendered as
      // structure is flattened back to text. That flattening did not know the renderer's
      // own entry-list shape and serialized the wrapper, so the row read
      // `[{"key":"token","value":"x"}]` for a payload of `[{ token: 'x' }]`.
      const rendered = errorToString(
        Object.assign(new Error('boom'), {
          additionalInfo: { items: [{ token: 'abc', name: 'kevin' }] },
        }),
      );

      expect(rendered).toContain('{"token":"abc","name":"kevin"}');
      expect(rendered).not.toContain('"key"');
    });

    it('keeps masking when flattening an array element', () => {
      const rendered = errorToString(
        Object.assign(new Error('boom'), {
          additionalInfo: {
            items: [{ token: 'tok-abcdefghij', tenant: 'acme' }],
          },
          sensitiveFieldNames: ['items[0].token'],
        }),
      );

      expect(rendered).not.toContain('tok-abcdefghij');
      expect(rendered).toContain('"tenant":"acme"');
      expect(rendered).not.toContain('"key"');
    });

    it('still renders an array of plain strings unquoted', () => {
      const rendered = errorToString(
        Object.assign(new Error('boom'), {
          additionalInfo: { tags: ['alpha', 'beta'] },
        }),
      );

      expect(rendered).toContain('alpha, beta');
    });
  });

  describe('output budget', () => {
    it('bounds many large values under one additionalInfo', () => {
      // Charging without checking bounded nothing: fifty megabyte-long values billed the
      // budget deeply negative and every one of them rendered anyway, for 73 MB.
      const big = 'x'.repeat(1_000_000);
      const info: Record<string, string> = {};

      for (let index = 0; index < 50; index++) {
        info[`k${index}`] = big;
      }

      const rendered = errorToString(
        Object.assign(new Error('boom'), { additionalInfo: info }),
      );

      expect(rendered).toContain('boom');
      expect(rendered.length).toBeLessThan(4_000_000);
    });

    it('bounds a very wide nested object', () => {
      const wide: Record<string, string> = {};

      for (let index = 0; index < 200_000; index++) {
        wide[`k${index}`] = 'v';
      }

      const rendered = errorToString(
        Object.assign(new Error('boom'), { additionalInfo: { wide } }),
      );

      expect(rendered).toContain('boom');
      expect(rendered.length).toBeLessThan(4_000_000);
    });

    it('bounds the masking walk, not only the render', () => {
      // `maskValueDeep` runs to completion before the budgeted render sees anything, so
      // bounding only the render left the cost untouched: this took 51 seconds and 9.4 GB.
      let shared: Record<string, unknown> = { leaf: 'x' };

      for (let index = 0; index < 27; index++) {
        shared = { l: shared, r: shared };
      }

      const error = Object.assign(new Error('boom'), {
        additionalInfo: { payload: shared },
        sensitiveFieldNames: ['payload'],
      });

      const startedAt = Date.now();
      const rendered = errorToString(error);

      expect(rendered).toContain('boom');
      expect(Date.now() - startedAt).toBeLessThan(10_000);
    });
  });
});

describe('errorToString - what a redactFunction may return', () => {
  // `errorToString`'s `redactFunction` and the logger's are documented as one contract, so
  // the rules that decide between a masking request and everything else have to hold here
  // identically. Separate call sites over shared code is exactly where a rule drifts.
  const SECRET = 'hunter2secret';
  const DEFAULT_MASKED = 'h***********t';

  const render = (returned: unknown): string => {
    const error = new Error('boom') as Error & {
      additionalInfo: Record<string, unknown>;
      sensitiveFieldNames: string[];
    };

    error.additionalInfo = { password: SECRET };
    error.sensitiveFieldNames = ['password'];

    return errorToString(error, 200, {
      redactFunction: (() => returned) as unknown as RedactFieldFunction,
    });
  };

  it('honours an object naming only masking settings', () => {
    const rendered = render({ maskChar: '#', percent: 100 });

    expect(rendered).not.toContain(SECRET);
    expect(rendered).toContain('#'.repeat(SECRET.length));
  });

  it('falls back to the default for an object it cannot use', () => {
    // An object is always a masking request here too, never a replacement value - so an
    // unusable one is masked by default rather than rendered into the table.
    for (const returned of [{}, { note: 'withheld' }, { percent: 1, n: 'x' }]) {
      const rendered = render(returned);

      expect(rendered).not.toContain(SECRET);
      expect(rendered).not.toContain('withheld');
      expect(rendered).toContain(DEFAULT_MASKED);
    }
  });

  it('matches the logger for the same return value', () => {
    // The masked text itself, not just the classification, has to agree.
    for (const returned of [
      { percent: 100 },
      { strategy: 'email' as const },
      { note: 'withheld' },
      {},
      null,
      70,
      '[hidden]',
    ]) {
      const viaLogger = applyRedaction(
        { password: SECRET },
        ['password'],
        () =>
          typeof returned === 'object' && returned !== null
            ? { ...returned }
            : returned,
      )['password'];

      expect(render(returned)).toContain(String(viaLogger));
    }
  });
});

describe('errorToString - reporting why redaction failed', () => {
  const SECRET = 'hunter2secret';

  const mkError = (): Error => {
    const error = new Error('boom') as Error & {
      additionalInfo: Record<string, unknown>;
      sensitiveFieldNames: unknown;
    };

    error.additionalInfo = { password: SECRET };
    error.sensitiveFieldNames = ['password'];
    error.stack = 'Error: boom';

    return error;
  };

  it('reports a throwing redactFunction with its cause and key', () => {
    const reports: [string, string][] = [];

    const rendered = errorToString(mkError(), 120, {
      redactFunction: (() => {
        throw new Error('redactor exploded');
      }) as unknown as RedactFieldFunction,
      onRedactionError: (error, key) => reports.push([key, error.message]),
    });

    expect(reports).toEqual([['password', 'redactor exploded']]);
    expect(rendered).toContain('REDACTION FAILED');
    expect(rendered).not.toContain(SECRET);
  });

  it('reports an unusable sensitiveFieldNames', () => {
    // This branch drops `additionalInfo` wholesale - the right call, and one nobody could
    // diagnose from the output alone.
    const error = mkError() as Error & { sensitiveFieldNames: unknown };

    error.sensitiveFieldNames = 'password';

    const reports: string[] = [];
    const rendered = errorToString(error, 120, {
      onRedactionError: (_error, key) => reports.push(key),
    });

    expect(reports).toEqual(['<sensitiveFieldNames>']);
    expect(rendered).toContain('sensitiveFieldNames unreadable');
    expect(rendered).not.toContain(SECRET);
  });

  it('renders identically with and without a handler', () => {
    const redactFunction = (() => {
      throw new Error('redactor exploded');
    }) as unknown as RedactFieldFunction;

    expect(
      errorToString(mkError(), 120, {
        redactFunction,
        onRedactionError: () => undefined,
      }),
    ).toBe(errorToString(mkError(), 120, { redactFunction }));
  });
});
