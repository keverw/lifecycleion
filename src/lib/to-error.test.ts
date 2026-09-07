import { describe, test, expect } from 'bun:test';
import { toError, describeError } from './to-error';

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
