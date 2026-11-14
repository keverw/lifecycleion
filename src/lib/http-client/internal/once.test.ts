import { expect, test } from 'bun:test';
import { once } from './once';

test('the value is computed on the first ask and answered after', () => {
  let runs = 0;
  const read = once(() => {
    runs++;
    return { n: runs };
  });

  expect(runs).toBe(0);

  const first = read();

  expect(read()).toBe(first);
  expect(runs).toBe(1);
});

test('an error is thrown again on each ask, never computed again', () => {
  let runs = 0;
  const failure = new Error('failed');
  const read = once((): number => {
    runs++;
    throw failure;
  });

  expect(read).toThrow(failure);
  expect(read).toThrow(failure);
  expect(runs).toBe(1);
});

test('an ask made while the value is computed throws a named error, not kept as the outcome', () => {
  let inner: unknown;
  const read: () => string = once(() => {
    try {
      read();
    } catch (error) {
      inner = error;
    }
    return 'value';
  });

  expect(read()).toBe('value');
  expect(inner).toBeInstanceOf(Error);
  expect((inner as Error).message).toBe(
    'HTTPClient value read again while it was being computed',
  );
  expect(read()).toBe('value');
});

test('a named re-entry error that escapes compute is its outcome, thrown again', () => {
  const read: () => string = once(() => read());

  expect(read).toThrow(
    'HTTPClient value read again while it was being computed',
  );
  expect(read).toThrow(
    'HTTPClient value read again while it was being computed',
  );
});
