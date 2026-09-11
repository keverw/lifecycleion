import { describe, expect, it } from 'bun:test';

import {
  defineEntry,
  describeContainer,
  isArrayIndexKey,
  namedArrayKeys,
} from './container-entries';

describe('describeContainer', () => {
  it('reports an array by length', () => {
    expect(describeContainer(['a', 'b', 'c'])).toEqual({
      kind: 'array',
      length: 3,
    });
  });

  it('reports an empty array rather than treating it as an object', () => {
    // The two branches emit different shapes, so an empty array must not fall through to
    // the object branch and answer `{ keys: [] }`.
    expect(describeContainer([])).toEqual({ kind: 'array', length: 0 });
  });

  it('reports an object by its own enumerable string keys', () => {
    expect(describeContainer({ a: 1, b: 2 })).toEqual({
      kind: 'object',
      keys: ['a', 'b'],
    });
  });

  it('omits non-enumerable, symbol, and inherited keys', () => {
    // The set every walk already read, stated once. Widening it here would mask or print
    // members the renderers cannot reach.
    const value: Record<string, unknown> = Object.create({ inherited: 1 });

    value['own'] = 1;
    Object.defineProperty(value, 'hidden', { value: 2, enumerable: false });
    Object.defineProperty(value, Symbol('s'), { value: 3, enumerable: true });

    expect(describeContainer(value)).toEqual({ kind: 'object', keys: ['own'] });
  });

  it('reports unreadable when ownKeys throws', () => {
    // The case that motivated this module: swallowed into an empty key list, it rendered
    // a container that could not be read as one that was genuinely empty.
    const hostile = new Proxy(
      { a: 1 },
      {
        ownKeys() {
          throw new Error('ownKeys refused');
        },
      },
    );

    const shape = describeContainer(hostile);

    expect(shape.kind).toBe('unreadable');
    expect((shape as { error: unknown }).error).toBeInstanceOf(Error);
  });

  it('reports unreadable when a length read throws', () => {
    // Through a `Proxy` rather than an `Array` subclass: an array's `length` is an own
    // property, so a getter on a subclass prototype is shadowed and never runs. A `get`
    // trap is what actually makes the read refuse, and `Array.isArray` still answers
    // `true` through a proxy over an array, so this reaches the array branch first.
    const hostile = new Proxy([1, 2], {
      get(target, key, receiver) {
        if (key === 'length') {
          throw new Error('length refused');
        }

        return Reflect.get(target, key, receiver) as unknown;
      },
    });

    expect(describeContainer(hostile).kind).toBe('unreadable');
  });

  it('reports unreadable for a revoked Proxy', () => {
    // `Array.isArray` itself throws here, before either branch is chosen, which is why it
    // sits inside the guard rather than above it.
    const { proxy, revoke } = Proxy.revocable({ a: 1 }, {});

    revoke();

    expect(describeContainer(proxy).kind).toBe('unreadable');
  });

  it('carries the thrown value through, for callers that report it', () => {
    const thrown = new Error('the reason');
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw thrown;
        },
      },
    );

    const shape = describeContainer(hostile);

    expect((shape as { error: unknown }).error).toBe(thrown);
  });

  it('never throws, whatever the container does', () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          // A hostile container is under no obligation to throw an `Error`, which is
          // exactly what this asserts survives.
          // eslint-disable-next-line @typescript-eslint/only-throw-error -- see above
          throw 'a string, not an Error';
        },
        getOwnPropertyDescriptor() {
          throw new Error('descriptor refused');
        },
      },
    );

    expect(() => describeContainer(hostile)).not.toThrow();
    expect(describeContainer(hostile).kind).toBe('unreadable');
  });
});

describe('defineEntry', () => {
  it('stores an ordinary entry as an own enumerable property', () => {
    const target: Record<string, unknown> = {};

    defineEntry(target, 'a', 1);

    expect(target).toEqual({ a: 1 });
    expect(Object.keys(target)).toEqual(['a']);
  });

  it('stores __proto__ as a real entry instead of reparenting the object', () => {
    // The reason this is a function rather than an assignment. `target.__proto__ = {}`
    // reparents rather than storing, so a payload carrying that key lost the entry and
    // changed the shape of the rebuilt container.
    const target: Record<string, unknown> = {};

    defineEntry(target, '__proto__', { injected: true });

    expect(Object.keys(target)).toEqual(['__proto__']);
    expect(Object.getPrototypeOf(target)).toBe(Object.prototype);
    expect(target['__proto__']).toEqual({ injected: true });
  });

  it('stores a string __proto__, which a plain assignment silently drops', () => {
    const target: Record<string, unknown> = {};

    defineEntry(target, '__proto__', 'a string');

    expect(target['__proto__']).toBe('a string');
  });

  it('leaves the entry writable and configurable', () => {
    // The rebuilt container has to behave like the plain object a caller expects, not a
    // frozen approximation of one.
    const target: Record<string, unknown> = {};

    defineEntry(target, 'a', 1);
    defineEntry(target, 'a', 2);

    expect(target['a']).toBe(2);
  });
});

describe('isArrayIndexKey', () => {
  it('accepts the keys that address a slot', () => {
    expect(isArrayIndexKey('0')).toBe(true);
    expect(isArrayIndexKey('7')).toBe(true);
    expect(isArrayIndexKey(String(2 ** 32 - 2))).toBe(true);
  });

  it('refuses the keys that only look numeric', () => {
    // An index is a key whose `ToString(ToUint32(key))` is the key itself, which stops one
    // short of `length`'s maximum - so these are named properties, and a `parseInt`
    // round-trip called all of them indexes.
    expect(isArrayIndexKey('-1')).toBe(false);
    expect(isArrayIndexKey(String(2 ** 32 - 1))).toBe(false);
    expect(isArrayIndexKey('4294967296')).toBe(false);
    expect(isArrayIndexKey('01')).toBe(false);
    expect(isArrayIndexKey('1.0')).toBe(false);
    expect(isArrayIndexKey(' 1')).toBe(false);
    expect(isArrayIndexKey('')).toBe(false);
    expect(isArrayIndexKey('note')).toBe(false);
  });
});

describe('namedArrayKeys', () => {
  it('reports the named own keys an index walk cannot see', () => {
    const items = ['a', 'b'] as unknown[] & Record<string, unknown>;
    items.note = 'x';
    items['-1'] = 'y';

    expect(namedArrayKeys(items).sort()).toEqual(['-1', 'note']);
  });

  it('reports nothing for an ordinary array', () => {
    expect(namedArrayKeys(['a', 'b'])).toEqual([]);
  });
});
