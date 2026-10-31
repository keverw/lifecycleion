import { describe, expect, test } from 'bun:test';
import { PublicSuffixResolver } from './public-suffix';

describe('PublicSuffixResolver', () => {
  test('isolates private suffix tenants and treats IPs as whole hosts', () => {
    const resolver = new PublicSuffixResolver();
    expect(resolver.isPublicSuffix('github.io')).toBe(true);
    expect(resolver.registrableDomainFor('a.tenant.github.io')).toBe(
      'tenant.github.io',
    );
    expect(resolver.isPublicSuffix('localhost')).toBe(true);
    expect(resolver.isPublicSuffix('10.0.0.5')).toBe(false);
    expect(resolver.registrableDomainFor('10.0.0.5')).toBe('10.0.0.5');
  });

  test('snapshots normalized overrides and matches whole labels', () => {
    const add = ['CORP.INTERNAL'];
    const resolver = new PublicSuffixResolver({ add });
    add.length = 0;
    expect(resolver.isPublicSuffix('corp.internal')).toBe(true);
    expect(resolver.registrableDomainFor('a.tenant.corp.internal')).toBe(
      'tenant.corp.internal',
    );
    expect(resolver.registrableDomainFor('a.notcorp.internal')).toBe(
      'notcorp.internal',
    );
    expect(resolver.registrableDomainFor('host.notcorp.acme')).toBe(
      'notcorp.acme',
    );
  });

  test('a removed ancestor leaves a site behind a private suffix still listed', () => {
    const resolver = new PublicSuffixResolver({ remove: ['COM'] });
    expect(resolver.isPublicSuffix('com')).toBe(false);
    expect(resolver.registrableDomainFor('x.example.com')).toBe('com');
    expect(resolver.registrableDomainFor('tenant.blogspot.com')).toBe(
      'tenant.blogspot.com',
    );
  });

  test('a removed ancestor above a suffix still listed leaves the registrable domain', () => {
    const resolver = new PublicSuffixResolver({
      add: ['corp.internal'],
      remove: ['uk'],
    });
    expect(resolver.registrableDomainFor('a.x.co.uk')).toBe('x.co.uk');
    expect(resolver.registrableDomainFor('co.uk')).toBe('co.uk');
    expect(resolver.registrableDomainFor('uk')).toBe('uk');
    expect(resolver.registrableDomainFor('a.tenant.corp.internal')).toBe(
      'tenant.corp.internal',
    );
  });

  test('the registrable domain widens to a removed suffix directly above it, and no further than a suffix still listed', () => {
    const heroku = new PublicSuffixResolver({ remove: ['herokuapp.com'] });
    expect(heroku.registrableDomainFor('a.mine.herokuapp.com')).toBe(
      'herokuapp.com',
    );

    const com = new PublicSuffixResolver({ remove: ['com'] });
    expect(com.registrableDomainFor('x.example.com')).toBe('com');
    expect(com.registrableDomainFor('a.blogspot.com')).toBe('a.blogspot.com');

    const coUK = new PublicSuffixResolver({ remove: ['co.uk'] });
    expect(coUK.registrableDomainFor('a.x.co.uk')).toBe('co.uk');

    // Exception rules hold: `!city.kawasaki.jp` under `*.kawasaki.jp`.
    const jp = new PublicSuffixResolver({ remove: ['jp'] });
    expect(jp.registrableDomainFor('a.city.kawasaki.jp')).toBe(
      'city.kawasaki.jp',
    );
  });

  test('a removed suffix below a name that is no suffix widens to the registrable domain above it', () => {
    // `amazonaws.com` is no suffix, so with `s3.amazonaws.com` removed its hosts belong
    // to `amazonaws.com`, as `www.amazonaws.com` does - one site, in one bucket.
    const s3 = new PublicSuffixResolver({ remove: ['s3.amazonaws.com'] });
    for (const host of [
      'bucket.s3.amazonaws.com',
      's3.amazonaws.com',
      'www.amazonaws.com',
    ]) {
      expect(s3.registrableDomainFor(host)).toBe('amazonaws.com');
    }

    // A suffix the caller added above the removal stops the widening there.
    const added = new PublicSuffixResolver({
      add: ['amazonaws.com'],
      remove: ['s3.amazonaws.com'],
    });
    expect(added.registrableDomainFor('bucket.s3.amazonaws.com')).toBe(
      's3.amazonaws.com',
    );
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
    expect(resolver.registrableDomainFor('city.kawasaki.jp')).toBe(
      'city.kawasaki.jp',
    );
    expect(resolver.registrableDomainFor('www.city.kawasaki.jp')).toBe(
      'city.kawasaki.jp',
    );
    expect(resolver.registrableDomainFor('www.ck')).toBe('www.ck');
    expect(resolver.registrableDomainFor('a.www.ck')).toBe('www.ck');
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

test("override lists are read by index, not through the array's own entries or iterator", () => {
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

test('a suffix is lowercased in ASCII only, so a Kelvin sign is refused rather than read as k', () => {
  for (const suffix of ['\u212Aorp.internal', 'corp.\u212A']) {
    expect(() => new PublicSuffixResolver({ add: [suffix] })).toThrow(
      TypeError,
    );
    expect(() => new PublicSuffixResolver({ remove: [suffix] })).toThrow(
      TypeError,
    );
  }
  const resolver = new PublicSuffixResolver({ add: ['KORP.internal'] });
  expect(resolver.isPublicSuffix('korp.internal')).toBe(true);
  expect(resolver.isPublicSuffix('\u212Aorp.internal')).toBe(false);
});
