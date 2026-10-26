import { describe, expect, test } from 'bun:test';
import { PublicSuffixResolver } from './public-suffix';

describe('PublicSuffixResolver', () => {
  test('isolates private suffix tenants and treats IPs as whole hosts', () => {
    const resolver = new PublicSuffixResolver();
    expect(resolver.isPublicSuffix('github.io')).toBe(true);
    expect(resolver.apexFor('a.tenant.github.io')).toBe('tenant.github.io');
    expect(resolver.isPublicSuffix('localhost')).toBe(true);
    expect(resolver.isPublicSuffix('10.0.0.5')).toBe(false);
    expect(resolver.apexFor('10.0.0.5')).toBe('10.0.0.5');
  });

  test('snapshots normalized overrides and matches whole labels', () => {
    const add = ['CORP.INTERNAL'];
    const resolver = new PublicSuffixResolver({ add });
    add.length = 0;
    expect(resolver.isPublicSuffix('corp.internal')).toBe(true);
    expect(resolver.apexFor('a.tenant.corp.internal')).toBe(
      'tenant.corp.internal',
    );
    expect(resolver.apexFor('a.notcorp.internal')).toBe('notcorp.internal');
    expect(resolver.apexFor('host.notcorp.acme')).toBe('notcorp.acme');
  });

  test('removed ancestors share a bucket even beneath a private suffix', () => {
    const resolver = new PublicSuffixResolver({ remove: ['COM'] });
    expect(resolver.isPublicSuffix('com')).toBe(false);
    expect(resolver.apexFor('tenant.blogspot.com')).toBe('com');
  });

  test('rejects normalized contradictory overrides and malformed suffixes', () => {
    expect(
      () => new PublicSuffixResolver({ add: ['COM'], remove: ['com'] }),
    ).toThrow(TypeError);
    for (const suffix of [
      'https://example.com',
      '*.example.com',
      'bad name',
      'a..com',
    ]) {
      expect(() => new PublicSuffixResolver({ add: [suffix] })).toThrow(
        TypeError,
      );
    }
  });
});

test('unrelated overrides preserve PSL exception rules', () => {
  for (const overrides of [
    { add: ['corp.internal'] },
    { remove: ['herokuapp.com'] },
  ]) {
    const resolver = new PublicSuffixResolver(overrides);
    expect(resolver.apexFor('city.kawasaki.jp')).toBe('city.kawasaki.jp');
    expect(resolver.apexFor('www.city.kawasaki.jp')).toBe('city.kawasaki.jp');
    expect(resolver.apexFor('www.ck')).toBe('www.ck');
    expect(resolver.apexFor('a.www.ck')).toBe('www.ck');
  }
});

test('rejects added tenant boundaries beneath removed shared-cookie ancestors', () => {
  expect(
    () =>
      new PublicSuffixResolver({
        add: ['APPS.HEROKUAPP.COM.'],
        remove: ['herokuapp.com'],
      }),
  ).toThrow(TypeError);
  expect(
    () =>
      new PublicSuffixResolver({
        add: ['apps.notherokuapp.com'],
        remove: ['herokuapp.com'],
      }),
  ).not.toThrow();
});

test("PR review round 76: override lists are read by index, not through the array's own entries or iterator", () => {
  const listed = (suffixes: string[], reported: string[]): string[] =>
    Object.defineProperties(suffixes, {
      entries: { value: () => reported.entries() },
      [Symbol.iterator]: { value: () => reported[Symbol.iterator]() },
    });

  const resolver = new PublicSuffixResolver({
    add: listed(['corp.internal'], ['other.internal']),
    remove: listed(['herokuapp.com'], ['github.io']),
  });
  expect(resolver.isPublicSuffix('corp.internal')).toBe(true);
  expect(resolver.isPublicSuffix('other.internal')).toBe(false);
  expect(resolver.isPublicSuffix('herokuapp.com')).toBe(false);
  expect(resolver.isPublicSuffix('github.io')).toBe(true);

  // A hole is refused as any entry that is not a string is.
  const holey = ['corp.internal'];
  holey[2] = 'x.internal';
  expect(() => new PublicSuffixResolver({ add: holey })).toThrow(
    'publicSuffixes.add[1] must be a string (got undefined)',
  );
});
