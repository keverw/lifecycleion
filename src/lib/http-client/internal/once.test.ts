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
