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

    it('should mask every element of an array named by a wildcard', () => {
      // `users[*].password` and `users.*.password` are one rule written two ways: a
      // wildcard stands in for an array index, so it reaches every slot of `users`.
      for (const entry of ['users[*].password', 'users.*.password']) {
        const rendered = render(
          { users: [{ password: SECRET }, { password: `${SECRET}-2` }] },
          [entry],
        );

        expect(rendered).not.toContain(SECRET);
      }
    });

    it('should read a wildcard over a plain object as the key spelled *', () => {
      // There is no set of slots to expand over, so the only other reading available is
      // the literal key - and an object whose keys merely read as numbers is not an array.
      expect(
        render({ users: { '*': { password: SECRET } } }, ['users.*.password']),
      ).not.toContain(SECRET);

      expect(
        render({ users: { '0': { password: SECRET } } }, ['users[*].password']),
      ).toContain(SECRET);
    });

    it('should mask nothing for genuinely unsupported syntax', () => {
      // A trailing dot is still unparseable, and an unparseable entry is not the
      // fail-closed case: it masks nothing and leaves the other fields rendering.
      const rendered = render({ users: [{ password: SECRET }], keep: 'diag' }, [
        'users[0].password.',
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

    it('should fail closed when sensitiveFieldNames is null', () => {
      // `null` and `undefined` are not the same answer. A property nobody set reads
      // `undefined`; `null` is a value somebody assigned, so it is a caller who asked for
      // masking without saying what for - the fail-closed case, and the same answer
      // `redactedKeys: null` already gets from the logger and from `stringifyValue`.
      const rendered = errorToString(
        Object.assign(new Error('x'), {
          additionalInfo: { password: SECRET },
          sensitiveFieldNames: null,
        }),
      );

      expect(rendered.includes(SECRET)).toBe(false);
    });

    it('should fail closed for a nested object whose sensitiveFieldNames is null', () => {
      // The same rule one level down. An error-shaped object carrying `null` has to route
      // through the error table too, or it is walked as ordinary structure and prints the
      // fields the table would have withheld.
      const rendered = errorToString(
        Object.assign(new Error('outer'), {
          additionalInfo: {
            child: {
              additionalInfo: { password: SECRET },
              sensitiveFieldNames: null,
            },
          },
        }),
      );

      expect(rendered.includes(SECRET)).toBe(false);
    });

    it('should still render normally when sensitiveFieldNames is absent', () => {
      // The other half of the rule above: `undefined` genuinely means nothing was asked
      // for, so nothing is masked and the payload renders in full.
      const rendered = errorToString(
        Object.assign(new Error('x'), {
          additionalInfo: { note: 'plainvalue' },
        }),
      );

      expect(rendered).toContain('plainvalue');
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

    it('should mark additionalInfo whose keys cannot be enumerated', () => {
      // Said, not swallowed. Collapsing to an empty key list rendered the error as one
      // that simply carried no `additionalInfo` - a different and far more reassuring
      // claim than "its keys could not be read". Every other walk in the library marks
      // this: `stringifyValue` emits `[unrenderable]`, `redactValue` the redaction
      // marker. Asserted at both levels, since the two reads sit in different functions.
      const hostile = (): object =>
        new Proxy(
          { password: 'hunter2secret' },
          {
            ownKeys() {
              throw new Error('ownKeys refused');
            },
          },
        );

      const nested = errorToString(
        Object.assign(new Error('boom'), {
          additionalInfo: { inner: hostile() },
        }),
      );

      expect(nested).toContain('boom');
      expect(nested).toContain('<unrenderable: keys>');

      const root = errorToString(
        Object.assign(new Error('boom'), { additionalInfo: hostile() }),
      );

      expect(root).toContain('boom');
      expect(root).toContain('<unrenderable: keys>');
    });

    it('should mark a non-plain additionalInfo whose keys cannot be enumerated', () => {
      // The sibling test above traps a *plain* object, which reaches the table's own
      // `Object.keys` guard. A class instance takes the other road entirely: it is not a
      // plain container, so it goes through `asAddressableBag`, whose `for...in` is what
      // the trap refuses. That branch used to answer with an empty bag, and an empty bag
      // renders zero rows - so the table came out with no `AdditionalInfo` line at all,
      // reading as an error that simply carried no extra context rather than one whose
      // context refused to be read. The two roads are asserted separately because they
      // fail in different functions.
      class Session {
        constructor() {
          (this as unknown as Record<string, unknown>).password =
            'hunter2secret';
        }
      }

      const hostile = new Proxy(new Session(), {
        ownKeys() {
          throw new Error('ownKeys refused');
        },
      });

      const error = Object.assign(new Error('boom'), {
        additionalInfo: hostile,
        sensitiveFieldNames: ['password'],
        cause: new Error('root cause'),
      });

      const rendered = errorToString(error);

      expect(rendered).toContain('boom');
      expect(rendered).toContain('AdditionalInfo');
      expect(rendered).toContain('<unrenderable: keys>');
      expect(rendered).not.toContain('hunter2secret');

      // The marker leaves through the early-returning branch, which owns the tail rows
      // itself. Asserted so the fix cannot trade a missing `AdditionalInfo` row for a
      // missing `Cause` and `Stack`.
      expect(rendered).toContain('root cause');
      expect(rendered).toContain('Stack');
    });

    it('should name which half of a value refused to be read', () => {
      // The marker says `keys` when the container would not enumerate and `value` when a
      // single entry would not be read, and the difference is the whole point of
      // splitting them: one sends you to the payload's shape, the other to the code
      // behind that one field. Asserted against each other, so a change that collapsed
      // them back into one spelling fails here rather than quietly halving the
      // information.
      //
      // The cause is deliberately absent from both. A getter is caller code and free to
      // throw a message carrying the value it was hiding, so the marker stays
      // library-authored text; `onFormatError` is where a cause is allowed to go.
      const throwingEntry: Record<string, unknown> = { safe: 'kept' };

      Object.defineProperty(throwingEntry, 'password', {
        get() {
          throw new Error('accessor refused: hunter2secret');
        },
        enumerable: true,
      });

      const rendered = errorToString(
        Object.assign(new Error('boom'), { additionalInfo: throwingEntry }),
      );

      expect(rendered).toContain('<unrenderable: value>');
      expect(rendered).not.toContain('<unrenderable: keys>');

      // The readable sibling still renders, and the accessor's own message - which
      // carries the secret - never reaches the table.
      expect(rendered).toContain('kept');
      expect(rendered).not.toContain('hunter2secret');
      expect(rendered).not.toContain('accessor refused');
    });

    it('should report a render failure with its path, once per render', () => {
      // The markers say *that* a value refused and which half; this is where the cause
      // goes. Both halves are asserted together because the split is the whole design:
      // the path and the thrown error reach the handler, and neither reaches the table.
      const seen: string[] = [];

      const leaf = (): Record<string, unknown> => {
        const bag: Record<string, unknown> = { safe: 'kept' };

        Object.defineProperty(bag, 'token', {
          get() {
            throw new Error('accessor refused: hunter2secret');
          },
          enumerable: true,
        });

        return bag;
      };

      const rendered = errorToString(
        Object.assign(new Error('boom'), {
          additionalInfo: { user: leaf(), list: [leaf()] },
        }),
        80,
        {
          onFormatError: (error, _kind, path) =>
            seen.push(`${path}|${error.message}`),
        },
      );

      // Once, though several values refused: a failure is raised per value, and a report
      // per value would be its own flood on a path whose job is to stay out of the way.
      expect(seen).toHaveLength(1);
      expect(seen[0]).toContain('additionalInfo.user.token');
      expect(seen[0]).toContain('accessor refused');

      // The cause reaches the handler and nothing else. A getter is caller code and may
      // put the value it was hiding in its message, so the table gets the neutral marker.
      expect(rendered).toContain('<unrenderable: value>');
      expect(rendered).not.toContain('hunter2secret');
      expect(rendered).not.toContain('accessor refused');

      // The readable siblings still render.
      expect(rendered).toContain('kept');
      expect(rendered).toContain('boom');
    });

    it('should address a render failure through a cause and an array index', () => {
      // The path is structural, and it keeps going through a nested error's own table:
      // a fresh table is not a fresh path, or a failure deep inside a `cause` would say
      // only that something somewhere refused.
      const paths: string[] = [];

      const hostile = (): Record<string, unknown> => {
        const bag: Record<string, unknown> = {};

        Object.defineProperty(bag, 'token', {
          get() {
            throw new Error('refused');
          },
          enumerable: true,
        });

        return bag;
      };

      errorToString(
        Object.assign(new Error('outer'), {
          cause: Object.assign(new Error('inner'), {
            additionalInfo: { items: [hostile()] },
          }),
        }),
        80,
        { onFormatError: (_error, _kind, path) => paths.push(path) },
      );

      expect(paths[0]).toBe('cause.additionalInfo.items[0].token');
    });

    it('should not let the render reporter raise a failure of its own', () => {
      // This runs while something has already gone wrong, and often while stdout is
      // closing. A throw here would replace the failure being reported with a second one,
      // out of a call whose whole job was to describe the first. Both rungs are covered:
      // a handler that throws falls to the console, and a console that throws falls to
      // nothing at all.
      const exploding = (): void => {
        throw new Error('handler exploded');
      };

      const bag: Record<string, unknown> = {};

      Object.defineProperty(bag, 'token', {
        get() {
          throw new Error('refused');
        },
        enumerable: true,
      });

      const build = (): Error =>
        Object.assign(new Error('boom'), { additionalInfo: bag });

      const consoleError = console.error;

      console.error = () => {
        throw new Error('stdout gone');
      };

      try {
        expect(() =>
          errorToString(build(), 80, { onFormatError: exploding }),
        ).not.toThrow();
      } finally {
        console.error = consoleError;
      }

      // And the render still produced the error it was asked for.
      expect(
        errorToString(build(), 80, { onFormatError: exploding }),
      ).toContain('boom');
    });

    it('should fall back to the console when no render handler was given', () => {
      // The three rungs every failure channel in this library uses: a handler, then the
      // console, then nothing. Silence by default would have left the swallow this channel
      // exists to end as the behaviour almost everyone gets - the reporter fires only when
      // a read actually threw, never for the ordinary degradations like `[circular]` or
      // `[max depth exceeded]`, so it is no more chatty than `onFormatError`.
      const bag: Record<string, unknown> = {};

      for (let index = 0; index < 20; index++) {
        Object.defineProperty(bag, `k${String(index)}`, {
          get() {
            throw new Error('refused');
          },
          enumerable: true,
        });
      }

      const consoleError = console.error;
      const lines: string[] = [];

      console.error = (...args: unknown[]): void => {
        lines.push(args.map((arg) => String(arg)).join(' '));
      };

      try {
        errorToString(
          Object.assign(new Error('boom'), { additionalInfo: bag }),
        );
      } finally {
        console.error = consoleError;
      }

      // Once, though twenty values refused: the once-per-render bound holds on the
      // console rung exactly as it does on a handler.
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('Render failed for');
      expect(lines[0]).toContain('additionalInfo.k0');
    });

    it('should render a non-object additionalInfo rather than dropping it', () => {
      // The gate used to require an object, so a string, a number or a `bigint` produced no
      // `AdditionalInfo` row at all - an error carrying context rendered as one carrying
      // none. That is the same silent collapse the unreadable cases were fixed for,
      // reached from the other direction: nothing failed, the value was simply outside the
      // shape the walk knows and was dropped for it.
      for (const info of ['failed at stage 3', 42, true, 9007199254740993n]) {
        const rendered = errorToString(
          Object.assign(new Error('boom'), { additionalInfo: info }),
        );

        expect(rendered).toContain('AdditionalInfo');
        expect(rendered).toContain(String(info));
      }

      // `null` still counts as absent, matching how `cause` is treated: an explicitly null
      // `additionalInfo` carries nothing to show.
      expect(
        errorToString(
          Object.assign(new Error('boom'), { additionalInfo: null }),
        ),
      ).not.toContain('AdditionalInfo');
    });

    it('should refuse a sensitiveFieldNames list that under-reports its length', () => {
      // Every guard around these lists was built for one that *throws*. A `Proxy` over a
      // real array whose `length` reads `0` does not throw: it passes `Array.isArray`,
      // iterates as empty, and read as "the caller named nothing", so the value was
      // rendered in the clear with no marker and nothing reported.
      const reported: string[] = [];

      const underReporting = new Proxy(['password'], {
        get(target, property, receiver): unknown {
          if (property === 'length') {
            return 0;
          }

          return Reflect.get(target, property, receiver) as unknown;
        },
      });

      const rendered = errorToString(
        Object.assign(new Error('boom'), {
          additionalInfo: { password: 'hunter2secret' },
          sensitiveFieldNames: underReporting,
        }),
        80,
        { onFormatError: (_error, _kind, key) => reported.push(key) },
      );

      expect(rendered).not.toContain('hunter2secret');
      expect(reported).toEqual(['<sensitiveFieldNames>']);
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

    it('should cut one oversized value rather than render it whole', () => {
      // A single huge leaf is the case charging-without-cutting never bounded: the marker
      // landed only on the entry after an oversized one, so this rendered 15 MB against a
      // one-megabyte budget and kept the error's message and stack company with it.
      const error = Object.assign(new Error('boom'), {
        additionalInfo: { blob: 'x'.repeat(10_000_000) },
      });

      const rendered = errorToString(error);

      expect(rendered).toContain('boom');
      expect(rendered).toContain('[max length exceeded]');
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
        onFormatError: () => undefined,
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
      onFormatError: (error, _kind, key) => reports.push([key, error.message]),
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
      onFormatError: (_error, _kind, key) => reports.push(key),
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
        onFormatError: () => undefined,
      }),
    ).toBe(errorToString(mkError(), 120, { redactFunction }));
  });
});

describe('errorToString - a member of the error itself that will not be read', () => {
  it('marks and reports a conventional member whose accessor throws', () => {
    // The identical accessor one level deeper has always rendered `<unrenderable: value>`
    // *and* reported. The error's own members read through the plain guarded helper, which
    // answers `undefined` for a read that threw, and the absence test then dropped the row
    // - so an error whose `message` refused rendered as one that simply had none, with
    // `onFormatError` never called at all.
    const error = new Error('never read');

    Object.defineProperty(error, 'message', {
      get(): never {
        throw new Error('message refused');
      },
      configurable: true,
    });
    Object.defineProperty(error, 'code', {
      get(): never {
        throw new Error('code refused');
      },
      enumerable: true,
      configurable: true,
    });

    const seen: [string, string][] = [];
    const rendered = errorToString(error, 80, {
      onFormatError: (failure, kind, path) => {
        seen.push([kind, path]);
      },
    });

    expect(rendered).toContain('| Message | <unrenderable: value>');
    expect(rendered).toContain('| Code    | <unrenderable: value>');

    // One per operation, by the reporter's own bound, so the first failure is what lands.
    expect(seen.length).toBe(1);
    expect(seen[0][0]).toBe('render');
    expect(seen[0][1]).toBe('message');
  });

  it('marks and reports an unreadable stack, additionalInfo and cause', () => {
    for (const member of ['stack', 'additionalInfo', 'cause']) {
      const error = new Error('boom');

      Object.defineProperty(error, member, {
        get(): never {
          throw new Error(`${member} refused`);
        },
        configurable: true,
      });

      const seen: string[] = [];
      const rendered = errorToString(error, 80, {
        onFormatError: (failure, kind, path) => {
          seen.push(path);
        },
      });

      // The error's own message survives - one unreadable member never costs the rest -
      // and the member that refused says so rather than looking absent.
      expect(rendered).toContain('boom');
      expect(rendered).toContain('<unrenderable: value>');
      expect(seen).toEqual([member]);
    }
  });
});

describe('errorToString - a nested object whose gate members refuse', () => {
  it('fails a nested object closed when its cause accessor throws', () => {
    // The `isErrorShaped` gate read `additionalInfo` and `cause` through a plain guarded
    // read, so an accessor that threw answered "absent" and the object went to the ordinary
    // walk - the one route on which its own `sensitiveFieldNames` could no longer fail it
    // closed, because the gate it depends on had already been decided by the read that
    // threw.
    const nested: Record<string, unknown> = {
      sensitiveFieldNames: null,
      token: 'SUPERSECRET',
    };

    Object.defineProperty(nested, 'cause', {
      get(): never {
        throw new Error('cause refused');
      },
      enumerable: false,
      configurable: true,
    });

    const error = new Error('outer') as Error & { additionalInfo: unknown };

    error.additionalInfo = { nested };

    const rendered = errorToString(error, 120);

    expect(rendered).not.toContain('SUPERSECRET');
  });
});

describe('errorToString - bounds that hold at the entry point', () => {
  it('charges the row framing for top-level additionalInfo entries', () => {
    // Every entry here becomes a table row padded out to the table width, which is none
    // of the strings the walk produces. Charging only the key billed roughly eight
    // characters for a row costing upwards of a hundred and eighty, so this payload
    // rendered 22.5 MB against a 1 MB cap - and the overshoot scaled with the width,
    // reaching 111 MB at a row length of 400, because the uncharged part *is* the width.
    const wide: Record<string, string> = {};

    for (let index = 0; index < 200_000; index++) {
      wide[`k${index}`] = 'v';
    }

    const error = new Error('wide') as Error & { additionalInfo: unknown };

    error.additionalInfo = wide;

    const atEighty = errorToString(error, 80);
    const atFourHundred = errorToString(error, 400);

    // The budget is a megabyte and a leaf is emitted whole, so a modest overshoot is
    // expected; twenty times over is not.
    expect(atEighty.length).toBeLessThan(4_000_000);
    expect(atFourHundred.length).toBeLessThan(4_000_000);

    // The bound must not scale with the row width, which is what said the framing was
    // going uncharged.
    expect(atFourHundred.length).toBeLessThan(atEighty.length * 3);
  });

  it('charges both lines a table row emits, not one', () => {
    // `KeyValueASCIITable` writes a content line *and* a `+---+` rule per row, each padded
    // out to the full table width, so billing a row one width under-counted every render by
    // half: 400,000 one-character `additionalInfo` values rendered 1,883,654 characters at
    // width 80 and 2,090,208 at width 10,000, against a documented one-megabyte cap a
    // caller may be sizing a buffer on.
    const info: Record<string, string> = {};

    for (let index = 0; index < 400_000; index++) {
      info[`k${index}`] = 'x';
    }

    const error = new Error('rows') as Error & { additionalInfo: unknown };

    error.additionalInfo = info;

    // A leaf is emitted whole, so a modest overshoot of the megabyte is expected - this
    // renders 1,090,108 - and twice it is not.
    for (const width of [80, 10_000]) {
      expect(errorToString(error, width).length).toBeLessThan(1_200_000);
    }

    // A stack is written on its own row, one padded line per line of it, so a stack of many
    // short lines was charged for its characters and emitted as full-width rows:
    // `'a\n'.repeat(400_000)` rendered 32,400,890 characters.
    const manyLines = new Error('lines');

    manyLines.stack = 'a\n'.repeat(400_000);

    for (const width of [80, 10_000]) {
      expect(errorToString(manyLines, width).length).toBeLessThan(1_200_000);
    }

    // An ordinary error is nowhere near any of this and must come back whole.
    const ordinary = errorToString(new Error('ordinary'));

    expect(ordinary).toContain('ordinary');
    expect(ordinary).not.toContain('[max length exceeded]');

    // A deep cause chain pays the same framing once per enclosing level, and plateaued at
    // 2,741,124 characters for the same reason.
    let chained: unknown = new Error('deep');

    for (let level = 0; level < 60; level++) {
      chained = new Error(`lvl${String(level)}`, { cause: chained });
    }

    expect(errorToString(chained).length).toBeLessThan(1_200_000);
  });

  it('renders at a row length below the table minimum', () => {
    // `maxRowLength` is a public parameter, and the table constructor throws below its
    // minimum width - a throw the top-level backstop turned into
    // `<error could not be rendered>`, discarding the message, name and stack because
    // the caller asked for a narrow column.
    for (const width of [1, 5, 8, 9]) {
      const rendered = errorToString(new Error('boom'), width);

      expect(rendered).not.toBe('<error could not be rendered>');
      expect(rendered).toContain('b');
    }
  });

  it('clamps a width far above the render cap', () => {
    // The low clamp exists so a narrow width cannot discard the error; this is the same
    // failure from the other end. Row framing is padded out to the table width and is
    // charged against the budget only for `additionalInfo` rows, so the width - not the
    // payload - decided the size of the result: this call returned 120,000,011 characters
    // against a one-megabyte cap, and at `1e9` the table renderer threw and the backstop
    // answered `<error could not be rendered>`, losing the error entirely.
    const rendered = errorToString(new Error('boom'), 10_000_000);

    expect(rendered).not.toBe('<error could not be rendered>');
    expect(rendered).toContain('boom');
    expect(rendered.length).toBeLessThan(1_000_000);

    const enormous = errorToString(new Error('boom'), 1e9);

    expect(enormous).not.toBe('<error could not be rendered>');
    expect(enormous).toContain('boom');
  });

  it('bounds a deep cause chain carrying a large message', () => {
    // Every level re-wraps, re-pads and re-indents the level below it, so one character of
    // the innermost message is emitted once per enclosing level. Charged flat, a 200 KB
    // message twenty-five causes deep rendered 26 MB against the one-megabyte cap.
    let error: unknown = new Error('x'.repeat(200_000));

    for (let level = 0; level < 25; level++) {
      error = new Error(`lvl${String(level)}`, { cause: error });
    }

    const rendered = errorToString(error);

    expect(rendered).not.toBe('<error could not be rendered>');
    expect(rendered).toContain('lvl24');
    expect(rendered.length).toBeLessThan(1_000_000);
  });

  it('renders a long word at a column narrow enough to split it per character', () => {
    // The table narrows by four per cause level and floors at nine, where wrapping splits
    // a word into one entry per grapheme. Spread into `push`, that was one argument per
    // entry and a `RangeError` from the engine's argument limit - which the backstop
    // turned into `<error could not be rendered>`, losing the error entirely.
    let error: unknown = new Error(`m${'y'.repeat(400_000)}`);

    for (let level = 0; level < 20; level++) {
      error = new Error(`lvl${String(level)}`, { cause: error });
    }

    const rendered = errorToString(error);

    expect(rendered).not.toBe('<error could not be rendered>');
    expect(rendered).toContain('lvl19');
  });

  it('treats the root as seen, so a self-referential cause renders once', () => {
    // `serializeError` registers the root before the walk; this did not, so the error
    // rendered in full, then again as its own cause, and only the third visit was caught.
    const error = new Error('selfcause') as Error & { cause?: unknown };

    error.cause = error;
    error.stack = 'stack-without-the-message';

    const rendered = errorToString(error);
    const occurrences = rendered.split('selfcause').length - 1;

    expect(occurrences).toBe(1);
  });

  it('falls back to the default width for a width that names nothing', () => {
    // `0` and `NaN` already landed on the default: both are falsy, so the constructor's
    // `tableWidth && tableWidth < 9` guard never reached its throw and `|| 80` applied.
    // A negative width and `Infinity` did not - the first threw, and the second built a
    // table of infinite width that failed further down - so those two are what changed.
    for (const width of [0, Number.NaN, -10, Number.POSITIVE_INFINITY]) {
      const rendered = errorToString(new Error('boom'), width);

      expect(rendered).not.toBe('<error could not be rendered>');
      expect(rendered).toContain('boom');
    }
  });
  it('renders a container with no addressable keys as one row', () => {
    // `asAddressableBag` forwards `for...in` keys, and a `Map`, a `Set`, a `Date` or a
    // `URL` has none - so the bag came out empty, the row loop wrote nothing, and the
    // error rendered as one carrying no `additionalInfo` at all. The identical value one
    // level deeper always rendered.
    for (const info of [new Map([['a', 1]]), new Set([1]), new Date(0)]) {
      const error = new Error('boom') as Error & { additionalInfo?: unknown };

      error.additionalInfo = info;

      const rendered = errorToString(error);

      expect(rendered).toContain('AdditionalInfo');
      expect(rendered).not.toBe('<error could not be rendered>');
    }
  });

  it('renders an error additionalInfo as its own table, own keys or not', () => {
    // The bag was built from whatever own enumerable keys the error happened to carry, and
    // those keys became the whole of the rendering: a syscall error - `code`, `errno`,
    // `syscall`, `path`, all own and enumerable - came out as flat `AdditionalInfo.<key>`
    // rows with no message, no name and no stack, while the same error with no own key
    // rendered the full nested table. The most common error in the wild was the one whose
    // diagnosis was dropped.
    const inner = new Error('inner failure') as Error & { code?: string };

    inner.code = 'ENOENT';

    const error = new Error('outer') as Error & { additionalInfo?: unknown };

    error.additionalInfo = inner;

    const rendered = errorToString(error);

    expect(rendered).toContain('inner failure');
    expect(rendered).toContain('ENOENT');
    expect(rendered).toContain('Stack');
  });

  it('renders a binary view as one value rather than a row per byte', () => {
    // A `Buffer` on an error is ordinary, and its keys are its bytes: forwarding them
    // spent the whole render budget on `AdditionalInfo.<n>` rows saying nothing, after
    // materializing every index the enumeration touched - seconds of synchronous work on
    // the failure-reporting path.
    const error = new Error('boom') as Error & { additionalInfo?: unknown };

    error.additionalInfo = new Uint8Array(2_000_000);

    const started = Date.now();
    const rendered = errorToString(error);

    expect(Date.now() - started).toBeLessThan(3_000);
    expect(rendered).not.toContain('AdditionalInfo.1000');
  });

  it('renders a wide grapheme that overhangs its column instead of throwing', () => {
    // `splitWord` splits by grapheme, so a column too narrow for a two-column character
    // emits a chunk wider than the column and the padding count goes negative.
    // `' '.repeat(-1)` threw a `RangeError` that the backstop turned into
    // `<error could not be rendered>`, losing message, name and stack - for an error whose
    // only crime was holding one CJK character deep in its `cause` chain.
    let error: Error = new Error('\u4e16');

    for (let level = 0; level < 18; level++) {
      error = new Error(`level${String(level)}`, { cause: error });
    }

    const rendered = errorToString(error);

    expect(rendered).not.toBe('<error could not be rendered>');
    expect(rendered).toContain('level17');
  });
});
