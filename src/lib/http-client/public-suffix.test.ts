import { describe, expect, spyOn, test } from 'bun:test';
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

  test('a list of added suffixes too long to spread as arguments is accepted', () => {
    // Two million: past what Bun's call stack takes as spread arguments.
    const names = Array.from(
      { length: 2_000_000 },
      (_, index) => `n${String(index)}.test`,
    );
    const resolver = new PublicSuffixResolver({ add: names });

    expect(resolver.registrableDomainFor('a.b.n1999999.test')).toBe(
      'b.n1999999.test',
    );
  }, 30_000);

  test('a hostname of many labels is looked up past added suffixes in linear time', () => {
    // Counted rather than timed: the characters of every candidate looked up among the
    // added suffixes, for a host of n labels and one of 4n. Looking up every candidate,
    // each as long as the labels left, that grows with the square of the label count;
    // looking up only candidates no longer than the longest added suffix, it does not
    // grow at all.
    const lookedUpLength = (labelCount: number): number => {
      const resolver = new PublicSuffixResolver({ add: ['example.internal'] });
      const added = (resolver as unknown as { added: Set<string> }).added;
      const isAdded = added.has.bind(added);
      let length = 0;
      spyOn(added, 'has').mockImplementation((name: string) => {
        length += name.length;
        return isAdded(name);
      });
      const labels = 'a.'.repeat(labelCount);

      expect(resolver.registrableDomainFor(`${labels}com`)).toBe('a.com');
      expect(resolver.registrableDomainFor(`${labels}x.example.internal`)).toBe(
        'x.example.internal',
      );

      return length;
    };

    const atN = lookedUpLength(1_000);

    expect(atN).toBeGreaterThan(0);
    expect(lookedUpLength(4_000)).toBeLessThanOrEqual(4 * atN);
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

  test('a removed suffix that is one through a wildcard rule is not widened to the wildcard base', () => {
    const sch = new PublicSuffixResolver({ remove: ['foo.sch.uk'] });
    expect(sch.registrableDomainFor('a.foo.sch.uk')).toBe('foo.sch.uk');
    expect(sch.registrableDomainFor('foo.sch.uk')).toBe('foo.sch.uk');
    expect(sch.registrableDomainFor('sch.uk')).toBe('sch.uk');
    expect(sch.registrableDomainFor('x.other.sch.uk')).toBe('x.other.sch.uk');

    const kawasaki = new PublicSuffixResolver({ remove: ['foo.kawasaki.jp'] });
    expect(kawasaki.registrableDomainFor('a.foo.kawasaki.jp')).toBe(
      'foo.kawasaki.jp',
    );
    expect(kawasaki.registrableDomainFor('city.kawasaki.jp')).toBe(
      'city.kawasaki.jp',
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
