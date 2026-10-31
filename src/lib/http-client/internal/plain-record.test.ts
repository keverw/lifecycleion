import { describe, expect, test } from 'bun:test';
import { runInNewContext } from 'node:vm';
import { isPlainRecord, isRealmRootPrototype } from './plain-record';

describe('isRealmRootPrototype', () => {
  test("is this realm's and another realm's Object.prototype", () => {
    const foreign = runInNewContext('Object.prototype') as object;

    expect(isRealmRootPrototype(Object.prototype)).toBe(true);
    expect(isRealmRootPrototype(foreign)).toBe(true);
    expect(isPlainRecord(runInNewContext('({ a: 1 })'))).toBe(true);
  });

  test("is another realm's Object.prototype whose methods are accessors, as SES makes them", () => {
    const hardened = runInNewContext(`
      for (const name of ['toString', 'valueOf']) {
        const method = Object.prototype[name];
        Object.defineProperty(Object.prototype, name, {
          get: () => method,
          set: () => undefined,
        });
      }
      Object.prototype;
    `) as object;

    expect(isRealmRootPrototype(hardened)).toBe(true);
  });

  test('is not a null-prototype dictionary with entries named as its methods', () => {
    const dictionary = Object.assign(Object.create(null) as object, {
      hasOwnProperty: 1,
      isPrototypeOf: 1,
      statusCodes: [500],
    });

    expect(isRealmRootPrototype(dictionary)).toBe(false);
    expect(isPlainRecord(Object.create(dictionary))).toBe(false);
  });
});
