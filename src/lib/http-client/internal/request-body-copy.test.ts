import { expect, spyOn, test } from 'bun:test';
import {
  copiedJSONText,
  copyRequestBody,
  fillRequestBody,
  releaseRequestBody,
  serializesToNothing,
} from './request-body-copy';
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

test('a JSON body copy is sent as its text and parsed back only once its contents are read', () => {
  const parse = spyOn(JSON, 'parse');
  try {
    const source = { a: 1, nested: { b: [2, 3] }, when: new Date(0) };
    const copy = copyRequestBody(source) as Record<string, unknown>;

    expect(parse).toHaveBeenCalledTimes(0);
    expect(copiedJSONText(copy)).toBe(JSON.stringify(source));
    expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);

    fillRequestBody(copy);
    fillRequestBody(copy);

    expect(parse).toHaveBeenCalledTimes(1);
    expect(copy).toEqual({
      a: 1,
      nested: { b: [2, 3] },
      when: '1970-01-01T00:00:00.000Z',
    });
    // Still sent as its text: filling it changed nothing it serializes to.
    expect(copiedJSONText(copy)).toBe(JSON.stringify(source));
  } finally {
    parse.mockRestore();
  }
});

test('a JSON array body copy is an array, filled in place', () => {
  const copy = copyRequestBody([1, { a: 2 }, undefined]) as unknown[];

  expect(Array.isArray(copy)).toBe(true);
  expect(copy).toHaveLength(0);

  fillRequestBody(copy);

  expect(copy).toEqual([1, { a: 2 }, null]);
});

test('a filled copy holds a __proto__ key as a member, in the order parsed', () => {
  const copy = copyRequestBody(
    JSON.parse('{"z":1,"__proto__":{"polluted":true},"a":2}'),
  ) as Record<string, unknown>;

  fillRequestBody(copy);

  expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
  expect(Object.keys(copy)).toEqual(['z', '__proto__', 'a']);
  expect(Object.getOwnPropertyDescriptor(copy, '__proto__')?.value).toEqual({
    polluted: true,
  });
  expect((copy as { polluted?: unknown }).polluted).toBeUndefined();
});

test('releasing a copy fills it and forgets its text, and a copy of an unfilled copy reads the same data', () => {
  const first = copyRequestBody({ a: 1 }) as Record<string, unknown>;
  const second = copyRequestBody(first) as Record<string, unknown>;

  expect(second).not.toBe(first);
  expect(copiedJSONText(second)).toBe('{"a":1}');

  releaseRequestBody(first);

  expect(first).toEqual({ a: 1 });
  expect(copiedJSONText(first)).toBeUndefined();

  fillRequestBody(second);

  expect(second).toEqual({ a: 1 });
});

test('a top-level toJSON that answers a value other than an object or array is still a wrapper answering it', () => {
  const copy = copyRequestBody({ toJSON: () => 'text' }) as {
    toJSON: () => unknown;
  };

  expect(copy.toJSON()).toBe('text');
  expect(copiedJSONText(copy)).toBe('"text"');
});
