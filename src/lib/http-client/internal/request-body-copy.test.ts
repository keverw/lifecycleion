import { describe, expect, spyOn, test } from 'bun:test';
import {
  copiedJSONText,
  copyRequestBody,
  holdsSameBytes,
  isUnreadJSONBodyCopy,
  readJSONBodyData,
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

test('a JSON body copy is a frozen empty shape sent as its text, and its data is parsed once, frozen, when first read', () => {
  const parse = spyOn(JSON, 'parse');
  try {
    const source = { a: 1, nested: { b: [2, 3] }, when: new Date(0) };
    const copy = copyRequestBody(source) as Record<string, unknown>;

    expect(parse).toHaveBeenCalledTimes(0);
    expect(copiedJSONText(copy)).toBe(JSON.stringify(source));
    expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
    expect(copy).toEqual({});
    expect(Object.isFrozen(copy)).toBe(true);

    const data = readJSONBodyData(copy) as Record<string, unknown> & {
      nested: { b: number[] };
    };

    expect(readJSONBodyData(copy)).toBe(data);
    expect(parse).toHaveBeenCalledTimes(1);
    expect(data).toEqual({
      a: 1,
      nested: { b: [2, 3] },
      when: '1970-01-01T00:00:00.000Z',
    });
    expect(Object.isFrozen(data)).toBe(true);
    expect(Object.isFrozen(data.nested)).toBe(true);
    expect(Object.isFrozen(data.nested.b)).toBe(true);
    // The data stands for the same text, and is its own copy.
    expect(copiedJSONText(data)).toBe(JSON.stringify(source));
    expect(copyRequestBody(data)).toBe(data);
    expect(copyRequestBody(copy)).toBe(copy);
  } finally {
    parse.mockRestore();
  }
});

test('a JSON array body copy is a frozen empty array, read as its frozen data', () => {
  const copy = copyRequestBody([1, { a: 2 }, undefined]) as unknown[];

  expect(Array.isArray(copy)).toBe(true);
  expect(copy).toHaveLength(0);
  expect(Object.isFrozen(copy)).toBe(true);
  expect(readJSONBodyData(copy)).toEqual([1, { a: 2 }, null]);
});

test('data read from a copy holds a __proto__ key as a member, in the order parsed', () => {
  const copy = copyRequestBody(
    JSON.parse('{"z":1,"__proto__":{"polluted":true},"a":2}'),
  );
  const data = readJSONBodyData(copy) as Record<string, unknown>;

  expect(Object.getPrototypeOf(data)).toBe(Object.prototype);
  expect(Object.keys(data)).toEqual(['z', '__proto__', 'a']);
  expect(Object.getOwnPropertyDescriptor(data, '__proto__')?.value).toEqual({
    polluted: true,
  });
  expect((data as { polluted?: unknown }).polluted).toBeUndefined();
});

test('a read whose parse throws leaves the copy unread with its text, so the next read parses it', () => {
  const copy = copyRequestBody({ a: 1 });
  const parse = spyOn(JSON, 'parse').mockImplementationOnce(() => {
    throw new RangeError('Maximum call stack size exceeded');
  });
  try {
    expect(() => readJSONBodyData(copy)).toThrow(RangeError);
  } finally {
    parse.mockRestore();
  }

  expect(copiedJSONText(copy)).toBe('{"a":1}');
  expect(readJSONBodyData(copy)).toEqual({ a: 1 });
});

test('data nested deeper than a recursive walk could go is frozen whole', () => {
  let text = '0';
  for (let depth = 0; depth < 5000; depth++) {
    text = `[${text}]`;
  }
  const copy = copyRequestBody(JSON.parse(text) as unknown[]);
  let level = readJSONBodyData(copy);
  let frozen = 0;
  while (Array.isArray(level)) {
    if (Object.isFrozen(level)) {
      frozen++;
    }
    level = level[0] as unknown;
  }

  expect(frozen).toBe(5000);
});

test('a body that is no copy is read as it is', () => {
  const body = { a: 1 };

  expect(readJSONBodyData(body)).toBe(body);
  expect(isUnreadJSONBodyCopy(body)).toBe(false);
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

  test.each([
    [
      "a polyfill's, whose equals takes only a Buffer",
      function (this: Buffer, other: Uint8Array): boolean {
        if (!Buffer.isBuffer(other)) {
          throw new TypeError('Argument must be a Buffer');
        }
        return Buffer.compare(this, other) === 0;
      },
    ],
    [
      'one whose equals refuses everything',
      (): boolean => {
        throw new TypeError('refused');
      },
    ],
  ])('compares the bytes with a Buffer like %s', (_label, equals) => {
    const equalsSpy = spyOn(Buffer.prototype, 'equals').mockImplementation(
      equals,
    );
    try {
      expect(
        holdsSameBytes(new Uint8Array([5, 6]), new Uint8Array([5, 6])),
      ).toBe(true);
      expect(
        holdsSameBytes(new Uint8Array([5, 6]), new Uint8Array([5, 7])),
      ).toBe(false);
    } finally {
      equalsSpy.mockRestore();
    }
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
