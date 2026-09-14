import { describe, test, expect } from 'bun:test';
import { toError, describeError, isErrorValue } from './to-error';

/** An `Error` whose `message` accessor throws, as a subclass or a `Proxy` can produce. */
function unreadableError(): Error {
  const error = new Error('placeholder');

  Object.defineProperty(error, 'message', {
    get() {
      throw new Error('message getter blew up');
    },
  });

  return error;
}

describe('toError', () => {
  test('returns an Error unchanged', () => {
    const original = new Error('boom');

    expect(toError(original)).toBe(original);
  });

  test('describes a non-error and keeps it on cause', () => {
    expect(toError('nope').message).toBe('Non-error value thrown: nope');
    expect(toError(null).message).toBe('Non-error value thrown: null');
    expect(toError({ code: 'E42' }).cause).toEqual({ code: 'E42' });
  });

  test('survives a value whose toString throws', () => {
    const hostile = {
      toString() {
        throw new Error('no');
      },
    };

    expect(toError(hostile).message).toBe(
      'Non-error value thrown: unknown value',
    );
    expect(toError(hostile).cause).toBe(hostile);
  });

  test('survives a value with no prototype chain to walk', () => {
    const bare: unknown = Object.create(null);

    // Asserted on the returned value rather than with `.not.toThrow()`: Bun's matcher
    // treats a *returned* Error as a thrown one, and returning an Error is the whole job.
    expect(toError(bare).message).toBe('Non-error value thrown: unknown value');
    expect(toError(bare).cause).toBe(bare);
  });
});

describe('describeError', () => {
  test('reads the message of a normal error', () => {
    expect(describeError(new Error('boom'))).toBe('boom');
  });

  test('describes a non-error value', () => {
    expect(describeError('nope')).toBe('Non-error value thrown: nope');
    expect(describeError(null)).toBe('Non-error value thrown: null');
  });

  test('does not throw when the message accessor throws', () => {
    expect(describeError(unreadableError())).toBe(
      '<error message could not be read>',
    );
  });

  test('does not throw when the message is a non-string that resists rendering', () => {
    const error = new Error('placeholder');

    Object.defineProperty(error, 'message', {
      value: {
        toString() {
          throw new Error('no');
        },
      },
    });

    expect(describeError(error)).toBe('<error message could not be read>');
  });

  test('renders a non-string message that can be coerced', () => {
    const error = new Error('placeholder');

    Object.defineProperty(error, 'message', { value: 42 });

    expect(describeError(error)).toBe('42');
  });

  test('never throws for any of the values a callback can throw', () => {
    const values: unknown[] = [
      undefined,
      null,
      0,
      '',
      Symbol('s'),
      10n,
      Object.create(null),
      unreadableError(),
      new Proxy(
        {},
        {
          get() {
            throw new Error('trap');
          },
        },
      ),
    ];

    for (const value of values) {
      expect(typeof describeError(value)).toBe('string');
    }
  });
});

describe('toError cross-realm errors', () => {
  test('should return an error built in another realm unchanged', async () => {
    // `instanceof` compares against this realm's `Error.prototype`, so an error from a
    // `vm` context, an iframe, or a jsdom window failed it and was wrapped as though it
    // had never been an error - a different identity, message and prototype for callers
    // that had only ever thrown errors.
    const vm = await import('node:vm');
    const foreign = vm.runInNewContext('new Error("boom")') as Error;

    expect(foreign instanceof Error).toBe(false);
    expect(toError(foreign)).toBe(foreign);
    expect(toError(foreign).message).toBe('boom');
  });

  test('should still wrap a plain object that is not an error', () => {
    const wrapped = toError({ message: 'boom' });

    expect(wrapped.message).toContain('Non-error value thrown');
  });
});

describe('isErrorValue', () => {
  test('should recognize an ordinary error', () => {
    expect(isErrorValue(new Error('boom'))).toBe(true);
    expect(isErrorValue(new TypeError('boom'))).toBe(true);
  });

  test('should recognize an error built in another realm', async () => {
    // The reason this is exported rather than kept private: a caller that needs the
    // question answered - `Logger`'s global `'error'` listener deciding whether to pass a
    // payload through or wrap it - has to reach the same answer `toError` does, and a
    // bare `instanceof` does not.
    const vm = await import('node:vm');
    const foreign = vm.runInNewContext('new Error("boom")') as Error;

    expect(foreign instanceof Error).toBe(false);
    expect(isErrorValue(foreign)).toBe(true);
  });

  test('should reject values that are not errors', () => {
    for (const value of [
      null,
      undefined,
      'boom',
      42,
      { message: 'boom' },
      [],
      () => undefined,
    ]) {
      expect(isErrorValue(value)).toBe(false);
    }
  });

  test('should not be fooled by a claimed brand where the runtime can tell', () => {
    // `Object.prototype.toString` consults `Symbol.toStringTag`, so a plain object can
    // wear `'[object Error]'`. `Error.isError` reads the internal slot instead and is
    // preferred wherever it exists; on a runtime without it the brand check is what
    // remains, and the impostor is returned as-is, which the doc comment owns.
    const impostor = { [Symbol.toStringTag]: 'Error', name: 'AbortError' };
    const hasIsError =
      typeof (Error as { isError?: unknown }).isError === 'function';

    expect(Object.prototype.toString.call(impostor)).toBe('[object Error]');
    expect(isErrorValue(impostor)).toBe(!hasIsError);

    if (hasIsError) {
      const wrapped = toError(impostor);

      expect(wrapped).not.toBe(impostor);
      expect(wrapped.message).toContain('Non-error value thrown');
      expect(wrapped.cause).toBe(impostor);
    }
  });

  test('should not be fooled by a borrowed prototype where the runtime can tell', () => {
    // `Object.create(Error.prototype)` passes `instanceof` and the string brand while
    // having no `[[ErrorData]]` slot. With `Error.isError` consulted first it is refused;
    // without it, it is the documented bargain.
    const impostor = Object.create(Error.prototype) as object;
    const hasIsError =
      typeof (Error as { isError?: unknown }).isError === 'function';

    expect(impostor instanceof Error).toBe(true);
    expect(isErrorValue(impostor)).toBe(!hasIsError);
  });

  test('should recognize a DOMException, which is what an AbortError is', () => {
    // Bun's `Error.isError` answers `false` for one; Node's answers `true`. Either way
    // the abort reason a signal hands out has to read as an error, or a cancellation
    // is classified as a failure.
    const controller = new AbortController();
    controller.abort();

    expect(isErrorValue(new DOMException('x', 'AbortError'))).toBe(true);
    expect(isErrorValue(controller.signal.reason)).toBe(true);
    expect(toError(controller.signal.reason)).toBe(controller.signal.reason);
  });

  test('should recognize what deserializeError builds and refuse what serializeError emits', async () => {
    const { serializeError, deserializeError } =
      await import('./serialize-error/lib/serialize-error');
    const serialized = serializeError(new Error('boom'));

    expect(isErrorValue(serialized)).toBe(false);
    expect(isErrorValue(deserializeError(serialized))).toBe(true);
  });

  test('should not throw on a value whose prototype cannot be walked', () => {
    // `instanceof` walks a prototype chain and `Object.prototype.toString` reads the
    // brand; a revoked `Proxy` refuses both. This is called from reporting paths that
    // must not raise an error of their own, so the guard is part of the contract.
    const revocable = Proxy.revocable({}, {});

    revocable.revoke();

    expect(() => isErrorValue(revocable.proxy)).not.toThrow();
    expect(isErrorValue(revocable.proxy)).toBe(false);
  });

  test('should agree with what toError does with the same value', () => {
    const vmSafe = [new Error('boom'), 'boom', null, { message: 'boom' }];

    for (const value of vmSafe) {
      // `toError` returns an error unchanged exactly when this says it is one.
      expect(toError(value) === value).toBe(isErrorValue(value));
    }
  });
});
