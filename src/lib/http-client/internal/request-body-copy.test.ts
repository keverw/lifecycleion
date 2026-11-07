import { expect, test } from 'bun:test';
import { copyRequestBody, serializesToNothing } from './request-body-copy';
import { UNSUPPORTED_REQUEST_BODY_MESSAGE } from '../utils';

test('serializesToNothing answers as JSON.stringify does, reading only the top-level toJSON', () => {
  class Silent extends Array<number> {
    public toJSON(): undefined {
      return undefined;
    }
  }
  const bodies: object[] = [
    {},
    [],
    { a: 1, nested: { toJSON: () => undefined } },
    [undefined, () => 1],
    { toJSON: () => undefined },
    { toJSON: () => Symbol('s') },
    { toJSON: () => () => 1 },
    { toJSON: () => null },
    { toJSON: () => '' },
    { toJSON: () => 0 },
    { toJSON: () => ({ toJSON: () => undefined }) },
    { toJSON: 'not a function' },
    Object.assign([1], { toJSON: () => undefined }),
    Silent.from([1]),
  ];
  for (const body of bodies) {
    expect([body, serializesToNothing(body)]).toEqual([
      body,
      JSON.stringify(body) === undefined,
    ]);
  }

  // A body `JSON.stringify` throws on below its top level is not read that far: it sends
  // something, or nothing that can be sent.
  const read: string[] = [];
  const deep = new Proxy(
    { n: BigInt(1) },
    {
      get(target, key, receiver) {
        read.push(String(key));
        return Reflect.get(target, key, receiver) as unknown;
      },
    },
  );
  expect(serializesToNothing(deep)).toBe(false);
  expect(read).toEqual(['toJSON']);

  // A `toJSON` is called once, with the key `''`, and a throw is passed on.
  const calls: unknown[][] = [];
  expect(
    serializesToNothing({
      toJSON(...args: unknown[]) {
        calls.push(args);
        return undefined;
      },
    }),
  ).toBe(true);
  expect(calls).toEqual([['']]);
  const failure = new Error('toJSON failed');
  expect(() =>
    serializesToNothing({
      toJSON() {
        throw failure;
      },
    }),
  ).toThrow(failure);

  // A copy is answered from its own record.
  expect(serializesToNothing(copyRequestBody({ a: 1 }) as object)).toBe(false);
  expect(
    serializesToNothing(copyRequestBody({ toJSON: () => undefined }) as object),
  ).toBe(true);
});

test('a form is told by its own methods, not by inheriting from FormData.prototype', () => {
  class Form extends FormData {}
  const subclassed = new Form();
  subclassed.append('a', '1');

  const copy = copyRequestBody(subclassed);

  expect(Object.getPrototypeOf(copy)).toBe(FormData.prototype);
  expect([...FormData.prototype.entries.call(copy as FormData)]).toEqual([
    ['a', '1'],
  ]);

  for (const fake of [
    Object.create(FormData.prototype),
    new Proxy(new FormData(), {}),
  ]) {
    expect(() => copyRequestBody(fake)).toThrow(
      UNSUPPORTED_REQUEST_BODY_MESSAGE,
    );
  }
});
