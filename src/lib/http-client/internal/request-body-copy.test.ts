import { describe, expect, spyOn, test } from 'bun:test';
import {
  copiedJSONText,
  copyRequestBody,
  holdsSameBytes,
  readRequestBodyContents,
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

test('a JSON body copy is sent as its text and parsed back only once it is released', () => {
  const parse = spyOn(JSON, 'parse');
  try {
    const source = { a: 1, nested: { b: [2, 3] }, when: new Date(0) };
    const copy = copyRequestBody(source) as Record<string, unknown>;

    expect(parse).toHaveBeenCalledTimes(0);
    expect(copiedJSONText(copy)).toBe(JSON.stringify(source));
    expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);

    releaseRequestBody(copy);
    releaseRequestBody(copy);

    expect(parse).toHaveBeenCalledTimes(1);
    expect(copy).toEqual({
      a: 1,
      nested: { b: [2, 3] },
      when: '1970-01-01T00:00:00.000Z',
    });
    // Caller code may change it now, so its text no longer says what it sends.
    expect(copiedJSONText(copy)).toBeUndefined();
  } finally {
    parse.mockRestore();
  }
});

test('a JSON array body copy is an array, filled in place', () => {
  const copy = copyRequestBody([1, { a: 2 }, undefined]) as unknown[];

  expect(Array.isArray(copy)).toBe(true);
  expect(copy).toHaveLength(0);

  releaseRequestBody(copy);

  expect(copy).toEqual([1, { a: 2 }, null]);
});

test('a filled copy holds a __proto__ key as a member, in the order parsed', () => {
  const copy = copyRequestBody(
    JSON.parse('{"z":1,"__proto__":{"polluted":true},"a":2}'),
  ) as Record<string, unknown>;

  releaseRequestBody(copy);

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

  releaseRequestBody(second);

  expect(second).toEqual({ a: 1 });
});

test('a release whose parse throws leaves the copy unfilled with its text, so the next release fills it', () => {
  const copy = copyRequestBody({ a: 1 }) as Record<string, unknown>;
  const parse = spyOn(JSON, 'parse').mockImplementationOnce(() => {
    throw new RangeError('Maximum call stack size exceeded');
  });
  try {
    expect(() => releaseRequestBody(copy)).toThrow(RangeError);
  } finally {
    parse.mockRestore();
  }

  expect(copy).toEqual({});
  expect(copiedJSONText(copy)).toBe('{"a":1}');

  releaseRequestBody(copy);

  expect(copy).toEqual({ a: 1 });
});

test('the contents a filter reads are parsed once into the map it is handed, and fill the copy when it is released with them', () => {
  const parse = spyOn(JSON, 'parse');
  try {
    const parsedByCopy = new Map<unknown, object>();
    const copy = copyRequestBody({ a: 1, nested: { b: 2 } }) as Record<
      string,
      unknown
    >;
    const contents = readRequestBodyContents(copy, parsedByCopy);

    expect(contents).toEqual({ a: 1, nested: { b: 2 } });
    expect(readRequestBodyContents(copy, parsedByCopy)).toBe(contents);
    expect(parsedByCopy.get(copy)).toBe(contents);
    // The copy itself is left as it was, an empty object sent as its text.
    expect(copy).toEqual({});
    expect(copiedJSONText(copy)).toBe('{"a":1,"nested":{"b":2}}');

    releaseRequestBody(copy, contents);

    expect(copy).toEqual({ a: 1, nested: { b: 2 } });
    expect(copy.nested).toBe(contents.nested);
    expect(parse).toHaveBeenCalledTimes(1);
  } finally {
    parse.mockRestore();
  }
});

test('a body that is no copy is read by a filter as it is, and nothing is kept for it', () => {
  const parsedByCopy = new Map<unknown, object>();
  const body = { a: 1 };

  expect(readRequestBodyContents(body, parsedByCopy)).toBe(body);
  expect(parsedByCopy.size).toBe(0);
});

test('a top-level toJSON that answers a value other than an object or array is still a wrapper answering it', () => {
  const copy = copyRequestBody({ toJSON: () => 'text' }) as {
    toJSON: () => unknown;
  };

  expect(copy.toJSON()).toBe('text');
  expect(copiedJSONText(copy)).toBe('"text"');
});

describe('holdsSameBytes', () => {
  test('compares the bytes held, not an own byteLength, and a detached view holds none', () => {
    const left = new Uint8Array([1, 2, 3]);
    const right = new Uint8Array([1, 2, 3]);
    expect(holdsSameBytes(left, right)).toBe(true);
    expect(holdsSameBytes(left, new Uint8Array([1, 2, 4]))).toBe(false);

    const shortened = new Uint8Array([1, 2, 3, 4]);
    Object.defineProperty(shortened, 'byteLength', { value: 3 });
    expect(holdsSameBytes(left, shortened)).toBe(false);

    const detached = new Uint8Array([1, 2, 3]);
    structuredClone(detached.buffer, { transfer: [detached.buffer] });
    expect(holdsSameBytes(left, detached)).toBe(false);
  });

  test('compares by index where there is no Buffer', () => {
    const buffer = globalThis.Buffer;
    Reflect.deleteProperty(globalThis, 'Buffer');
    try {
      expect(
        holdsSameBytes(new Uint8Array([5, 6]), new Uint8Array([5, 6])),
      ).toBe(true);
      expect(
        holdsSameBytes(new Uint8Array([5, 6]), new Uint8Array([5, 7])),
      ).toBe(false);
    } finally {
      globalThis.Buffer = buffer;
    }
  });
});
