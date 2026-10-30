import {
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
  setSystemTime,
  spyOn,
} from 'bun:test';
import { CookieJar } from './cookie-jar';
import type { Cookie } from './cookie-jar';

afterEach(() => {
  setSystemTime();
});

/**
 * Lets a stored cookie run out: stores it again with a one-second lifetime and moves the
 * clock past it, as the jar stores no cookie that is already expired. The `afterEach`
 * above puts the clock back.
 */
function expireStored(jar: CookieJar, name: string): void {
  const cookie = jar.getAllCookies().find((stored) => stored.name === name);

  if (cookie === undefined) {
    throw new Error(`expected the cookie ${name} to be stored`);
  }

  const now = Date.now();
  jar.setCookie({ ...cookie, maxAge: 1, createdAt: now });
  setSystemTime(new Date(now + 2000));
}

test.each([
  'my_app.example.com',
  'ab--cd.example.com',
  'foo--bar.example.com',
  'xn--mnchen-3ya.de',
])('preserves cookie scopes and deletion for URL hostname %s', (host) => {
  const jar = new CookieJar();
  const url = `https://${host}/`;
  jar.parseSetCookieHeader('session=host; Path=/', url);
  expect(jar.getCookieHeaderString(url)).toBe('session=host');
  expect(jar.getCookieHeaderString(`https://sub.${host}/`)).toBe('');
  jar.parseSetCookieHeader('session=; Path=/; Max-Age=0', url);
  expect(jar.getCookieHeaderString(url)).toBe('');
  jar.parseSetCookieHeader(`scoped=domain; Domain=${host}; Path=/`, url);
  expect(jar.getCookieHeaderString(`https://sub.${host}/`)).toBe(
    'scoped=domain',
  );
  expect(jar.getCookieHeaderString(`https://other${host}/`)).toBe('');
  jar.parseSetCookieHeader(`scoped=; Domain=${host}; Path=/; Max-Age=0`, url);
  expect(jar.getAllCookies()).toEqual([]);
});

test.each(['example.com.', '[::1]', '[2001:db8::1]'])(
  'deletes host-only cookies using their canonical identity on %s',
  (host) => {
    for (const expiry of [
      'Max-Age=0',
      'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    ]) {
      const jar = new CookieJar();
      const url = `https://${host}/`;
      jar.parseSetCookieHeader('session=secret; Path=/', url);
      expect(jar.getCookieHeaderString(url)).toBe('session=secret');
      jar.parseSetCookieHeader(`session=; Path=/; ${expiry}`, url);
      expect(jar.getCookieHeaderString(url)).toBe('');
      expect(jar.getAllCookies()).toEqual([]);
    }
  },
);

describe('CookieJar', () => {
  let jar: CookieJar;

  beforeEach(() => {
    jar = new CookieJar();
  });

  test('ignores a Set-Cookie whose Domain is not ASCII (RFC 6265bis)', () => {
    for (const domain of ['münchen.de', '.MÜNCHEN.de', 'm\u00fcnchen.de']) {
      jar.parseSetCookieHeader(
        `session=x; Domain=${domain}; Path=/`,
        'https://www.xn--mnchen-3ya.de/',
      );
    }
    expect(jar.getAllCookies()).toEqual([]);
  });

  test.each(['xn--mnchen-3ya.de', '.XN--MNCHEN-3YA.de'])(
    'canonicalizes IDN Domain=%s',
    (domain) => {
      jar.parseSetCookieHeader(
        `session=x; Domain=${domain}; Path=/`,
        'https://münchen.de/',
      );
      expect(jar.getAllCookies()[0]?.domain).toBe('xn--mnchen-3ya.de');
      for (const host of [
        'münchen.de',
        'xn--mnchen-3ya.de',
        'sub.xn--mnchen-3ya.de',
      ]) {
        expect(jar.getCookieHeaderString(`https://${host}/`)).toBe('session=x');
      }
      expect(jar.getCookieHeaderString('https://other.de/')).toBe('');
    },
  );

  test('canonicalizes programmatic and restored IDN cookies', () => {
    expect(
      jar.setCookie({ name: 'id', value: '1', domain: 'münchen.de' }),
    ).toBe(true);
    expect(jar.getCookieHeaderString('https://xn--mnchen-3ya.de/')).toBe(
      'id=1',
    );
    jar.fromJSON({
      cookies: [
        { name: 'id', value: '2', domain: 'münchen.de', createdAt: Date.now() },
      ],
    });
    expect(jar.getCookieHeaderString('https://xn--mnchen-3ya.de/')).toBe(
      'id=2',
    );
  });

  test.each(['hostname', 'domain'] as const)(
    'canonicalizes an IDN host when clearing by %s',
    (scope) => {
      expect(
        jar.setCookie({ name: 'id', value: '1', domain: 'münchen.de' }),
      ).toBe(true);
      expect(jar.clear('münchen.de', scope)).toBe(1);
      expect(jar.getAllCookies()).toEqual([]);
    },
  );

  test.each(['münchen..de', 'münchen.de/path', 'xn--.de', 'münchen.de..'])(
    'rejects invalid IDN scope %s',
    (domain) => {
      expect(jar.setCookie({ name: 'id', value: '1', domain })).toBe(false);
      jar.parseSetCookieHeader(`id=1; Domain=${domain}`, 'https://münchen.de/');
      expect(jar.getAllCookies()).toEqual([]);
    },
  );

  describe('setCookie validation', () => {
    test('returns true for valid hostname', () => {
      expect(
        jar.setCookie({
          name: 'a',
          value: '1',
          domain: 'example.com',
          path: '/',
          createdAt: Date.now(),
        }),
      ).toBe(true);
    });

    test('returns true for localhost', () => {
      expect(
        jar.setCookie({
          name: 'a',
          value: '1',
          domain: 'localhost',
          path: '/',
          createdAt: Date.now(),
        }),
      ).toBe(true);
    });

    test('returns true for IPv4', () => {
      expect(
        jar.setCookie({
          name: 'a',
          value: '1',
          domain: '127.0.0.1',
          path: '/',
          createdAt: Date.now(),
        }),
      ).toBe(true);
    });

    test('returns true for bracketed IPv6', () => {
      expect(
        jar.setCookie({
          name: 'a',
          value: '1',
          domain: '[::1]',
          path: '/',
          createdAt: Date.now(),
        }),
      ).toBe(true);
    });

    test('returns true for unbracketed IPv6', () => {
      expect(
        jar.setCookie({
          name: 'a',
          value: '1',
          domain: '::1',
          path: '/',
          createdAt: Date.now(),
        }),
      ).toBe(true);
    });

    test('bracketed and unbracketed IPv6 match the same URL host', () => {
      jar.setCookie({
        name: 'sid',
        value: 'x',
        domain: '[::1]',
        path: '/',
        createdAt: Date.now(),
      });
      jar.setCookie({
        name: 'bare',
        value: 'y',
        domain: '::1',
        path: '/',
        createdAt: Date.now(),
      });
      expect(jar.getCookieFor('sid', 'http://[::1]/')?.value).toBe('x');
      expect(jar.getCookieFor('bare', 'http://[::1]/')?.value).toBe('y');
      expect(jar.getCookieFor('bare', 'http://[0:0::1]/')?.value).toBe('y');
    });

    test('returns true for .test TLD', () => {
      expect(
        jar.setCookie({
          name: 'a',
          value: '1',
          domain: 'myapp.test',
          path: '/',
          createdAt: Date.now(),
        }),
      ).toBe(true);
    });

    test('injects createdAt when omitted so maxAge expiry still works', () => {
      const originalNow = Date.now;

      try {
        Date.now = () => 1_000;

        jar.setCookie({
          name: 'sid',
          value: 'abc',
          domain: 'example.com',
          path: '/',
          maxAge: 1,
        });

        expect(jar.getAllCookies()[0]?.createdAt).toBe(1_000);

        Date.now = () => 2_500;

        expect(jar.getCookieFor('sid', 'https://example.com')).toBeUndefined();
      } finally {
        Date.now = originalNow;
      }
    });

    test('treats createdAt: undefined the same as omitted input', () => {
      const originalNow = Date.now;

      try {
        Date.now = () => 2_000;

        jar.setCookie({
          name: 'sid',
          value: 'abc',
          domain: 'example.com',
          path: '/',
          maxAge: 1,
          createdAt: undefined,
        });

        expect(jar.getAllCookies()[0]?.createdAt).toBe(2_000);

        Date.now = () => 3_500;

        expect(jar.getCookieFor('sid', 'https://example.com')).toBeUndefined();
      } finally {
        Date.now = originalNow;
      }
    });

    test('preserves an explicit createdAt value', () => {
      jar.setCookie({
        name: 'sid',
        value: 'abc',
        domain: 'example.com',
        path: '/',
        createdAt: 123,
      });

      expect(jar.getAllCookies()[0]?.createdAt).toBe(123);
    });

    test('returns false and does not store for empty domain', () => {
      const isCookieStored = jar.setCookie({
        name: 'a',
        value: '1',
        domain: '',
        path: '/',
        createdAt: Date.now(),
      });
      expect(isCookieStored).toBe(false);
      expect(jar.getAllCookies()).toHaveLength(0);
    });

    test('returns false and does not store for missing domain', () => {
      const isCookieStored = jar.setCookie({
        name: 'a',
        value: '1',
        path: '/',
        createdAt: Date.now(),
      });
      expect(isCookieStored).toBe(false);
      expect(jar.getAllCookies()).toHaveLength(0);
    });

    test('returns false instead of throwing for a non-string domain', () => {
      expect(
        jar.setCookie({
          name: 'a',
          value: '1',
          domain: 123,
          path: '/',
          createdAt: Date.now(),
        } as unknown as Parameters<CookieJar['setCookie']>[0]),
      ).toBe(false);
      expect(jar.getAllCookies()).toHaveLength(0);
    });

    test('returns false for an expiry that cannot be read', () => {
      // The programmatic path to the same immortal cookie `fromJSON` refuses: an
      // `Invalid Date` stored as `expires` compares `now` against `NaN` forever, and a
      // non-finite `maxAge` or `createdAt` does the same through the other branch.
      const base = { name: 'session', value: 'secret', domain: 'example.com' };

      expect(jar.setCookie({ ...base, expires: new Date('nope') })).toBe(false);
      expect(jar.setCookie({ ...base, maxAge: Number.NaN })).toBe(false);
      expect(jar.setCookie({ ...base, maxAge: Number.POSITIVE_INFINITY })).toBe(
        false,
      );
      expect(
        jar.setCookie({ ...base, maxAge: 60, createdAt: Number.NaN }),
      ).toBe(false);
      expect(
        jar.setCookie({
          ...base,
          expires: 'soon' as unknown as Date,
        }),
      ).toBe(false);

      expect(jar.getAllCookies()).toHaveLength(0);
      expect(
        jar.getCookieFor('session', 'https://example.com'),
      ).toBeUndefined();

      expect(jar.setCookie({ ...base, maxAge: 60 })).toBe(true);
      expect(jar.getCookieFor('session', 'https://example.com')?.value).toBe(
        'secret',
      );
    });

    test('returns false for a name or value the Cookie header cannot carry as one pair', () => {
      // The header is `name=value` pairs joined by `; `, so a value holding `;` was sent
      // as two cookies, and a control character was a header injection. The Set-Cookie
      // parser splits on `;` first and cannot produce these; `setCookie` and a persisted
      // jar could.
      const base = { domain: 'example.com', path: '/' };

      expect(
        jar.setCookie({ ...base, name: 'sid', value: 'x; other=evil' }),
      ).toBe(false);
      expect(
        jar.setCookie({ ...base, name: 'sid', value: 'x\r\nX-Injected: 1' }),
      ).toBe(false);
      // A tab is header-safe, and RFC 6265bis keeps a cookie that carries one.
      expect(jar.setCookie({ ...base, name: 'sid', value: 'tab\there' })).toBe(
        true,
      );
      expect(jar.setCookie({ ...base, name: 'sid', value: 'bell\u0007' })).toBe(
        false,
      );
      // A nameless cookie is fine; a nameless one with nothing in it, or with an `=` that
      // would read back as a name, is not.
      expect(jar.setCookie({ ...base, name: '', value: 'x' })).toBe(true);
      expect(jar.setCookie({ ...base, name: '', value: '' })).toBe(false);
      expect(jar.setCookie({ ...base, name: '', value: 'a=b' })).toBe(false);
      expect(jar.setCookie({ ...base, name: 'a=b', value: 'x' })).toBe(false);
      expect(jar.setCookie({ ...base, name: 'a;b', value: 'x' })).toBe(false);
      // A space at a name's edge is trimmed off the name a server reads back.
      expect(jar.setCookie({ ...base, name: ' ab', value: 'x' })).toBe(false);
      expect(jar.setCookie({ ...base, name: 'ab\t', value: 'x' })).toBe(false);
      expect(jar.setCookie({ ...base, name: 'a\nb', value: 'x' })).toBe(false);
      expect(
        jar.setCookie({
          ...base,
          name: 42 as unknown as string,
          value: 'x',
        }),
      ).toBe(false);

      // Only the tab-carrying `sid` and the nameless `x` above were stored.
      expect(jar.getAllCookies()).toHaveLength(2);

      // What the header can carry: an empty value, and the characters RFC 6265 allows.
      expect(jar.setCookie({ ...base, name: 'empty', value: '' })).toBe(true);
      expect(
        jar.setCookie({ ...base, name: 'sid', value: 'a-b_c.d:e/f=g+h' }),
      ).toBe(true);
    });

    test.each([
      ['getAllCookies()', (j: CookieJar) => j.getAllCookies()],
      [
        'getCookiesFor()',
        (j: CookieJar) => j.getCookiesFor('https://app.example.com/admin'),
      ],
      [
        'getCookieFor()',
        (j: CookieJar) => [
          j.getCookieFor('sid', 'https://app.example.com/admin'),
        ],
      ],
      ['toJSON()', (j: CookieJar) => j.toJSON().cookies],
    ] as const)(
      '%s returns copies, so writing to one changes nothing in the jar',
      (_, read) => {
        const expires = Date.now() + 60_000;
        jar.setCookie({
          name: 'sid',
          value: 'secret',
          domain: 'app.example.com',
          hostOnly: true,
          path: '/admin',
          secure: true,
          expires: new Date(expires),
        });

        for (const cookie of read(jar)) {
          if (cookie === undefined) {
            throw new Error('expected the cookie to be read');
          }

          cookie.value = 'x; other=evil';
          cookie.secure = false;
          cookie.hostOnly = false;
          cookie.domain = 'example.com';
          cookie.path = '/';
          cookie.expires?.setTime(0);
        }

        expect(jar.getCookieHeaderString('http://app.example.com/admin')).toBe(
          '',
        );
        expect(jar.getCookieHeaderString('https://other.example.com/')).toBe(
          '',
        );
        expect(jar.getCookieHeaderString('https://app.example.com/admin')).toBe(
          'sid=secret',
        );
        expect(jar.getAllCookies()).toEqual([
          {
            name: 'sid',
            value: 'secret',
            domain: 'app.example.com',
            hostOnly: true,
            path: '/admin',
            secure: true,
            expires: new Date(expires),
            createdAt: expect.any(Number) as number,
          },
        ]);
      },
    );

    test('setCookie() keeps its own copy of the cookie it is given', () => {
      const given = {
        name: 'sid',
        value: 'secret',
        domain: 'example.com',
        path: '/',
        expires: new Date(Date.now() + 60_000),
      };

      expect(jar.setCookie(given)).toBe(true);

      given.value = 'changed';
      given.expires.setTime(0);

      expect(jar.getCookieHeaderString('https://example.com/')).toBe(
        'sid=secret',
      );
    });

    test('getCookieHeaderString stays one pair per cookie', () => {
      const restored = jar.fromJSON({
        cookies: [
          {
            name: 'sid',
            value: 'x; other=evil',
            domain: 'example.com',
            path: '/',
            createdAt: Date.now(),
          },
          {
            name: 'ok',
            value: '1',
            domain: 'example.com',
            path: '/',
            createdAt: Date.now(),
          },
        ],
      });

      expect(restored).toBe(1);
      expect(jar.getCookieHeaderString('https://example.com/')).toBe('ok=1');
    });

    test('returns false and does not store for garbage domain', () => {
      const isCookieStored = jar.setCookie({
        name: 'a',
        value: '1',
        domain: 'not a domain!!!',
        path: '/',
        createdAt: Date.now(),
      });
      expect(isCookieStored).toBe(false);
      expect(jar.getAllCookies()).toHaveLength(0);
    });
  });

  describe('setCookie / getCookieFor', () => {
    test('stores and retrieves a cookie', () => {
      jar.setCookie({
        name: 'session',
        value: 'abc123',
        domain: 'example.com',
        path: '/',
        createdAt: Date.now(),
      });

      const cookie = jar.getCookieFor('session', 'https://example.com');
      expect(cookie).toBeDefined();
      expect(cookie?.value).toBe('abc123');
    });

    test('updating a cookie replaces it', () => {
      const base = {
        name: 'token',
        domain: 'example.com',
        path: '/',
        createdAt: Date.now(),
      };
      jar.setCookie({ ...base, value: 'first' });
      jar.setCookie({ ...base, value: 'second' });

      expect(jar.getAllCookies()).toHaveLength(1);
      expect(jar.getCookieFor('token', 'https://example.com')?.value).toBe(
        'second',
      );
    });

    test('normalizes domain casing so the same cookie key dedupes (RFC 6265 5.1.3)', () => {
      const base = {
        name: 'token',
        path: '/',
        createdAt: Date.now(),
      };

      jar.setCookie({ ...base, domain: 'Example.Com', value: 'first' });
      jar.setCookie({ ...base, domain: 'example.com', value: 'second' });

      expect(jar.getAllCookies()).toHaveLength(1);
      expect(jar.getCookieFor('token', 'https://example.com')?.value).toBe(
        'second',
      );
      expect(jar.getCookieFor('token', 'https://example.com')?.domain).toBe(
        'example.com',
      );
    });

    test('ignores a leading dot in a programmatically stored domain', () => {
      expect(
        jar.setCookie({
          name: 'session',
          value: 'abc',
          domain: '.Example.Com',
          path: '/',
          createdAt: Date.now(),
        }),
      ).toBe(true);

      expect(jar.getAllCookies()[0]?.domain).toBe('example.com');
      expect(jar.getCookieFor('session', 'https://example.com')?.value).toBe(
        'abc',
      );
      expect(
        jar.getCookieFor('session', 'https://www.example.com')?.value,
      ).toBe('abc');
    });

    test('normalizes leading dots before validating local and IP domains', () => {
      for (const [domain, url, storedDomain] of [
        ['.localhost', 'http://localhost', 'localhost'],
        ['.[::1]', 'http://[::1]', '::1'],
        ['.local', 'http://local', 'local'],
      ] as const) {
        const localJar = new CookieJar();

        expect(
          localJar.setCookie({
            name: 'session',
            value: 'abc',
            domain,
            path: '/',
            createdAt: Date.now(),
          }),
        ).toBe(true);
        expect(localJar.getAllCookies()[0]?.domain).toBe(storedDomain);
        expect(localJar.getCookieFor('session', url)?.value).toBe('abc');
      }
    });

    test('canonicalizes empty and relative programmatic paths to root', () => {
      for (const path of ['', 'api']) {
        const localJar = new CookieJar();

        expect(
          localJar.setCookie({
            name: 'session',
            value: 'abc',
            domain: 'example.com',
            path,
            createdAt: Date.now(),
          }),
        ).toBe(true);
        expect(localJar.getAllCookies()[0]?.path).toBe('/');
        expect(
          localJar.getCookieFor('session', 'https://example.com/anything')
            ?.value,
        ).toBe('abc');
      }
    });
  });

  describe('parseSetCookieHeader', () => {
    test('on an IP address, a cookie naming that address in Domain= is the one it sets without', () => {
      // Host-only, as browsers keep it: otherwise a session cookie set with
      // `Domain=127.0.0.1` would survive the same cookie refreshed or deleted without it,
      // and be sent first, ahead of the new value.
      for (const host of ['127.0.0.1', '10.0.0.5', '[::1]']) {
        const ipJar = new CookieJar();
        const url = `http://${host}/`;
        // Named as the URL writes the host, IPv6 brackets included, as browsers read it.
        const domain = host;

        ipJar.parseSetCookieHeader(`sid=one; Path=/; Domain=${domain}`, url);
        ipJar.parseSetCookieHeader('sid=two; Path=/', url);
        expect(ipJar.getCookieHeaderString(url)).toBe('sid=two');

        ipJar.parseSetCookieHeader(`sid=three; Path=/; Domain=${domain}`, url);
        expect(ipJar.getCookieHeaderString(url)).toBe('sid=three');

        ipJar.parseSetCookieHeader('sid=; Path=/; Max-Age=0', url);
        expect(ipJar.getCookieHeaderString(url)).toBe('');
      }
    });

    test('setCookie takes a __Host- cookie for a domain stored host-only, as a Set-Cookie from it is', () => {
      for (const domain of ['localhost', '127.0.0.1']) {
        const hostJar = new CookieJar();
        const url = `https://${domain}/`;

        expect(
          hostJar.setCookie({
            name: '__Host-sid',
            value: '1',
            domain,
            secure: true,
            path: '/',
          }),
        ).toBe(true);
        expect(hostJar.getCookieHeaderString(url)).toBe('__Host-sid=1');
      }
    });

    test('on an IP address, Domain= names only that address as the URL writes it', () => {
      const ipJar = new CookieJar();
      for (const [header, url] of [
        ['a=1; Domain=127.1', 'http://127.0.0.1/'],
        ['b=2; Domain=0x7f.0.0.1', 'http://127.0.0.1/'],
        ['c=3; Domain=::1', 'http://[::1]/'],
        ['d=4; Domain=0:0:0:0:0:0:0:1', 'http://[::1]/'],
      ]) {
        ipJar.parseSetCookieHeader(header, url);
      }
      expect(ipJar.getAllCookies()).toEqual([]);
    });

    test('a __Host- cookie may name the IP address it came from in Domain=', () => {
      const ipJar = new CookieJar();
      ipJar.parseSetCookieHeader(
        '__Host-s=1; Secure; Path=/; Domain=127.0.0.1',
        'https://127.0.0.1/',
      );
      expect(ipJar.getCookieHeaderString('https://127.0.0.1/')).toBe(
        '__Host-s=1',
      );
    });

    test("a domain cookie on an IP address saved by 0.1.0 is replaced by the address's own", () => {
      const ipJar = new CookieJar();
      const url = 'http://127.0.0.1/';
      ipJar.fromJSON({
        cookies: [
          {
            name: 'sid',
            value: 'old',
            domain: '127.0.0.1',
            path: '/',
            hostOnly: false,
            createdAt: Date.now(),
          },
        ],
      });
      ipJar.parseSetCookieHeader('sid=new; Path=/', url);
      expect(ipJar.getCookieHeaderString(url)).toBe('sid=new');
      ipJar.parseSetCookieHeader('sid=; Path=/; Max-Age=0', url);
      expect(ipJar.getCookieHeaderString(url)).toBe('');
    });

    test('a header that is not one string is refused as a TypeError', () => {
      // Node's `set-cookie` is an array of lines; `processResponseHeaders` reads one.
      expect(() =>
        jar.parseSetCookieHeader(['a=1'] as never, 'https://example.com'),
      ).toThrow(
        'CookieJar parseSetCookieHeader header must be a string (got an array)',
      );
      expect(() =>
        jar.parseSetCookieHeader(undefined as never, 'https://example.com'),
      ).toThrow(
        'CookieJar parseSetCookieHeader header must be a string (got undefined)',
      );
      expect(jar.getAllCookies()).toEqual([]);
    });

    test('a Set-Cookie value carrying CR or LF never reaches the wire', () => {
      // `setCookie` refuses a name or value with a line break; this is the server-fed
      // road onto the same check, which was only pinned from the programmatic side.
      jar.parseSetCookieHeader(
        'sid=evil\r\nInjected: 1',
        'https://example.com',
      );
      jar.parseSetCookieHeader(
        'ok=1; Path=/\r\nSet-Cookie: forged=1',
        'https://example.com',
      );

      for (const cookie of jar.getAllCookies()) {
        expect(cookie.name).not.toMatch(/[\r\n]/);
        expect(cookie.value).not.toMatch(/[\r\n]/);
      }

      expect(jar.getCookieHeaderString('https://example.com/')).not.toMatch(
        /[\r\n]/,
      );
      expect(jar.getCookieFor('forged', 'https://example.com')).toBeUndefined();
    });

    test('parses a basic Set-Cookie header', () => {
      jar.parseSetCookieHeader(
        'session=abc; Path=/; HttpOnly',
        'https://example.com',
      );
      const cookie = jar.getCookieFor('session', 'https://example.com');
      expect(cookie?.value).toBe('abc');
      expect(cookie?.httpOnly).toBe(true);
      expect(cookie?.path).toBe('/');
    });

    test('uses request hostname when domain not specified', () => {
      jar.parseSetCookieHeader('token=xyz; Path=/', 'https://api.example.com');
      const cookie = jar.getCookieFor('token', 'https://api.example.com');
      expect(cookie?.domain).toBe('api.example.com');
    });

    test('parses Max-Age', () => {
      jar.parseSetCookieHeader('tmp=val; Max-Age=3600', 'https://example.com');
      const cookie = jar.getCookieFor('tmp', 'https://example.com');
      expect(cookie?.maxAge).toBe(3600);
    });

    test('deletes cookie when Max-Age=0', () => {
      jar.parseSetCookieHeader('session=abc; Path=/', 'https://example.com');
      expect(jar.getCookieFor('session', 'https://example.com')).toBeDefined();

      jar.parseSetCookieHeader(
        'session=; Max-Age=0; Path=/',
        'https://example.com',
      );
      expect(
        jar.getCookieFor('session', 'https://example.com'),
      ).toBeUndefined();
    });

    test('parses Expires attribute', () => {
      // Within the 400-day lifetime cap, whole seconds as an HTTP-date carries them.
      const expires = new Date(
        Math.floor((Date.now() + 30 * 86_400_000) / 1000) * 1000,
      );
      jar.parseSetCookieHeader(
        `session=abc; Expires=${expires.toUTCString()}`,
        'https://example.com',
      );
      const cookie = jar.getCookieFor('session', 'https://example.com');
      expect(cookie?.expires).toBeInstanceOf(Date);
      expect(cookie?.expires?.getTime()).toBe(expires.getTime());
    });

    test('parses Secure and SameSite=Strict', () => {
      jar.parseSetCookieHeader(
        'auth=token; Secure; SameSite=Strict',
        'https://example.com',
      );
      const cookie = jar.getCookieFor('auth', 'https://example.com');
      expect(cookie?.secure).toBe(true);
      expect(cookie?.sameSite).toBe('Strict');
    });

    test('matches Secure and HttpOnly by attribute name when they have values', () => {
      jar.parseSetCookieHeader(
        'auth=token; Secure=true; HttpOnly=1',
        'https://example.com',
      );

      const cookie = jar.getCookieFor('auth', 'https://example.com');
      expect(cookie?.secure).toBe(true);
      expect(cookie?.httpOnly).toBe(true);
      expect(jar.getCookieFor('auth', 'http://example.com')).toBeUndefined();
    });

    test('parses SameSite=Lax', () => {
      jar.parseSetCookieHeader(
        'auth=token; SameSite=Lax',
        'https://example.com',
      );
      expect(jar.getCookieFor('auth', 'https://example.com')?.sameSite).toBe(
        'Lax',
      );
    });

    test('parses SameSite=None', () => {
      jar.parseSetCookieHeader(
        'auth=token; SameSite=None; Secure',
        'https://example.com',
      );
      expect(jar.getCookieFor('auth', 'https://example.com')?.sameSite).toBe(
        'None',
      );
    });

    test('RFC 6265 §5.1.4 — omits Path uses default-path from request URI (directory scope)', () => {
      jar.parseSetCookieHeader('sid=1', 'https://example.com/admin/settings');
      expect(
        jar.getCookieFor('sid', 'https://example.com/admin/settings')?.path,
      ).toBe('/admin');
      expect(
        jar.getCookieFor('sid', 'https://example.com/admin/other'),
      ).toBeDefined();
      expect(jar.getCookieFor('sid', 'https://example.com/')).toBeUndefined();
      expect(
        jar.getCookieFor('sid', 'https://example.com/other/page'),
      ).toBeUndefined();
    });

    test('RFC 6265 §5.1.4 — single path segment defaults to /', () => {
      jar.parseSetCookieHeader('sid=1', 'https://example.com/admin');
      expect(jar.getCookieFor('sid', 'https://example.com/admin')?.path).toBe(
        '/',
      );
      expect(jar.getCookieFor('sid', 'https://example.com/')).toBeDefined();
    });

    test('RFC 6265 §5.2.4 — a Path without a leading slash is ignored; default-path applies', () => {
      jar.parseSetCookieHeader(
        'sid=1; Path=foo',
        'https://example.com/app/page',
      );

      const stored = jar.getAllCookies();

      expect(stored).toHaveLength(1);
      expect(stored[0]?.path).toBe('/app');
      expect(jar.getCookieFor('sid', 'https://example.com/app/x')?.value).toBe(
        '1',
      );
    });

    test.each(['bad', ''])(
      'a trailing Path=%s replaces an earlier path with the request default',
      (lastPath) => {
        jar.parseSetCookieHeader(
          `sid=1; Path=/admin; Path=${lastPath}`,
          'https://example.com/app/page',
        );

        expect(jar.getCookieFor('sid', 'https://example.com/app/x')?.path).toBe(
          '/app',
        );
        expect(
          jar.getCookieFor('sid', 'https://example.com/admin'),
        ).toBeUndefined();
      },
    );

    test.each(['bad', ''])(
      'a trailing Path=%s deletes only the cookie at the request default path',
      (lastPath) => {
        jar.parseSetCookieHeader(
          'session=root; Path=/',
          'https://example.com/',
        );
        jar.parseSetCookieHeader(
          'session=admin; Path=/admin',
          'https://example.com/',
        );

        jar.parseSetCookieHeader(
          `session=; Path=/admin; Path=${lastPath}; Max-Age=0`,
          'https://example.com/logout',
        );

        expect(
          jar.getCookieFor('session', 'https://example.com/'),
        ).toBeUndefined();
        expect(jar.getAllCookies()).toMatchObject([
          { name: 'session', value: 'admin', path: '/admin' },
        ]);
      },
    );

    test('a valid trailing Path overrides an earlier invalid path', () => {
      jar.parseSetCookieHeader(
        'sid=1; Path=bad; Path=/admin',
        'https://example.com/app/page',
      );

      expect(jar.getCookieFor('sid', 'https://example.com/admin')?.path).toBe(
        '/admin',
      );
      expect(
        jar.getCookieFor('sid', 'https://example.com/app/x'),
      ).toBeUndefined();
    });

    test('RFC 6265 §5.2.2 — a Max-Age that is not digits is ignored', () => {
      // `parseInt` read a prefix: `60abc` was a minute and `1e9` was one second.
      jar.parseSetCookieHeader('a=1; Max-Age=60abc', 'https://example.com');
      jar.parseSetCookieHeader('b=1; Max-Age=1e9', 'https://example.com');
      jar.parseSetCookieHeader('c=1; Max-Age=', 'https://example.com');
      jar.parseSetCookieHeader('d=1; Max-Age=-', 'https://example.com');
      jar.parseSetCookieHeader('e=1; Max-Age=60', 'https://example.com');
      jar.parseSetCookieHeader('f=1; Max-Age=-5', 'https://example.com');

      const byName = new Map(jar.getAllCookies().map((c) => [c.name, c]));

      expect(byName.get('a')?.maxAge).toBeUndefined();
      expect(byName.get('b')?.maxAge).toBeUndefined();
      expect(byName.get('c')?.maxAge).toBeUndefined();
      expect(byName.get('d')?.maxAge).toBeUndefined();
      expect(byName.get('e')?.maxAge).toBe(60);
      // A negative Max-Age still deletes.
      expect(byName.has('f')).toBe(false);
      expect(jar.clearExpiredCookies()).toBe(0);
    });

    test('a Max-Age past what milliseconds can hold is capped, not refused', () => {
      jar.parseSetCookieHeader(
        `long=1; Max-Age=${'9'.repeat(40)}`,
        'https://example.com',
      );

      const stored = jar.getCookieFor('long', 'https://example.com');

      expect(stored).toBeDefined();
      expect(Number.isFinite(stored?.maxAge)).toBe(true);
      expect(jar.clearExpiredCookies()).toBe(0);
    });

    test('an expired Set-Cookie deletes its cookie even with a value setCookie would refuse', () => {
      for (const header of [
        'sid=日本; Max-Age=0',
        'sid=日本; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
      ]) {
        jar.parseSetCookieHeader('sid=1', 'https://example.com');
        jar.parseSetCookieHeader(header, 'https://example.com');

        expect(jar.getCookieFor('sid', 'https://example.com')).toBeUndefined();
      }
    });

    test('a Max-Age too long for a number still deletes when negative and stores when positive', () => {
      const digits = '9'.repeat(400);
      jar.parseSetCookieHeader('sid=1', 'https://example.com');
      jar.parseSetCookieHeader(
        `sid=2; Max-Age=-${digits}`,
        'https://example.com',
      );

      expect(jar.getCookieFor('sid', 'https://example.com')).toBeUndefined();

      jar.parseSetCookieHeader(
        `long=1; Max-Age=${digits}`,
        'https://example.com',
      );

      expect(jar.getCookieFor('long', 'https://example.com')?.value).toBe('1');
    });

    test('RFC 6265 §5.2 — empty Path= is ignored; default-path still applies', () => {
      jar.parseSetCookieHeader(
        'sid=1; Path=',
        'https://example.com/app/dashboard',
      );
      expect(jar.getCookieFor('sid', 'https://example.com/app/x')?.path).toBe(
        '/app',
      );
    });

    test('Max-Age=0 deletion matches RFC default-path when Path omitted', () => {
      jar.parseSetCookieHeader('session=abc', 'https://example.com/admin/page');
      expect(
        jar.getCookieFor('session', 'https://example.com/admin/x'),
      ).toBeDefined();

      jar.parseSetCookieHeader(
        'session=; Max-Age=0',
        'https://example.com/admin/page',
      );
      expect(
        jar.getCookieFor('session', 'https://example.com/admin/x'),
      ).toBeUndefined();
    });

    test('Expires in the past removes cookie immediately (no Max-Age)', () => {
      jar.parseSetCookieHeader('sid=1; Path=/', 'https://example.com');
      expect(jar.getCookieFor('sid', 'https://example.com')).toBeDefined();

      jar.parseSetCookieHeader(
        'sid=gone; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/',
        'https://example.com',
      );
      expect(jar.getCookieFor('sid', 'https://example.com')).toBeUndefined();
      expect(jar.getStoredDomains()).toHaveLength(0);
    });

    test('Expires in the past does not store a new cookie', () => {
      jar.parseSetCookieHeader(
        'tmp=x; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/',
        'https://example.com',
      );
      expect(jar.getAllCookies()).toHaveLength(0);
    });

    test('positive Max-Age overrides a past Expires (RFC 6265)', () => {
      jar.parseSetCookieHeader(
        'keep=1; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=3600; Path=/',
        'https://example.com',
      );
      expect(jar.getCookieFor('keep', 'https://example.com')?.value).toBe('1');
    });
  });

  describe('processResponseHeaders', () => {
    test('processes set-cookie header string', () => {
      jar.processResponseHeaders(
        { 'set-cookie': 'a=1; Path=/' },
        'https://example.com',
      );
      expect(jar.getCookieFor('a', 'https://example.com')?.value).toBe('1');
    });

    test('processes set-cookie header array', () => {
      jar.processResponseHeaders(
        { 'set-cookie': ['a=1; Path=/', 'b=2; Path=/'] },
        'https://example.com',
      );
      expect(jar.getCookieFor('a', 'https://example.com')?.value).toBe('1');
      expect(jar.getCookieFor('b', 'https://example.com')?.value).toBe('2');
    });

    test('finds Set-Cookie when the adapter uses standard HTTP header casing', () => {
      jar.processResponseHeaders(
        { 'Set-Cookie': 'a=1; Path=/' },
        'https://example.com',
      );
      expect(jar.getCookieFor('a', 'https://example.com')?.value).toBe('1');
    });

    test('processes multiple Set-Cookie lines with mixed-case key', () => {
      jar.processResponseHeaders(
        { 'Set-Cookie': ['a=1; Path=/', 'b=2; Path=/'] },
        'https://example.com',
      );
      expect(jar.getCookieFor('a', 'https://example.com')?.value).toBe('1');
      expect(jar.getCookieFor('b', 'https://example.com')?.value).toBe('2');
    });
  });

  describe('getCookiesFor', () => {
    test('returns matching cookies for url', () => {
      jar.setCookie({
        name: 'session',
        value: 'abc',
        domain: 'example.com',
        path: '/',
        createdAt: Date.now(),
      });
      jar.setCookie({
        name: 'other',
        value: 'xyz',
        domain: 'other.com',
        path: '/',
        createdAt: Date.now(),
      });

      const cookies = jar.getCookiesFor('https://example.com/page');
      expect(cookies).toHaveLength(1);
      expect(cookies[0].name).toBe('session');
    });

    test('matches subdomains', () => {
      jar.setCookie({
        name: 'shared',
        value: 'yes',
        domain: 'example.com',
        path: '/',
        createdAt: Date.now(),
      });
      const cookies = jar.getCookiesFor('https://api.example.com/endpoint');
      expect(cookies).toHaveLength(1);
    });

    test('host-only cookies do not match subdomains', () => {
      jar.parseSetCookieHeader(
        'session=abc123; Path=/',
        'https://api.example.com/login',
      );

      expect(
        jar.getCookieHeaderString('https://api.example.com/endpoint'),
      ).toBe('session=abc123');
      expect(
        jar.getCookieHeaderString('https://sub.api.example.com/endpoint'),
      ).toBe('');
    });

    test('omits Secure cookies for http URLs (RFC 6265 secure-only-flag)', () => {
      jar.setCookie({
        name: 'sid',
        value: 'secret',
        domain: 'example.com',
        path: '/',
        secure: true,
        createdAt: Date.now(),
      });

      expect(jar.getCookiesFor('https://example.com/')).toHaveLength(1);
      expect(jar.getCookiesFor('http://example.com/')).toHaveLength(0);
    });

    test('a loopback host over http is secure for cookies, as browsers treat it', () => {
      for (const origin of [
        'http://localhost:3000',
        'http://LOCALHOST.',
        'http://app.localhost',
        'http://127.0.0.1:8080',
        'http://2130706433',
        'http://[::1]:8080',
        'http://[0:0::1]',
      ]) {
        const local = new CookieJar();
        local.parseSetCookieHeader(
          'sid=1; Secure; HttpOnly; Path=/',
          `${origin}/login`,
        );
        local.parseSetCookieHeader(
          '__Host-id=2; Secure; Path=/',
          `${origin}/login`,
        );

        expect(local.getCookieHeaderString(`${origin}/`)).toBe(
          'sid=1; __Host-id=2',
        );
      }

      // Any other host over http is not, one that only names localhost included.
      const remote = new CookieJar();
      for (const url of [
        'http://example.com/',
        'http://localhost.example.com/',
        'http://127.0.0.1.nip.io/',
      ]) {
        remote.parseSetCookieHeader('sid=1; Secure; Path=/', url);
      }
      expect(remote.getAllCookies()).toHaveLength(0);
      remote.setCookie({
        name: 'sid',
        value: '1',
        domain: 'example.com',
        secure: true,
        createdAt: Date.now(),
      });
      expect(remote.getCookieHeaderString('http://example.com/')).toBe('');
      expect(
        remote.getCookieHeaderString('http://localhost.example.com/'),
      ).toBe('');
    });

    test('still sends non-Secure cookies over http', () => {
      jar.setCookie({
        name: 'a',
        value: '1',
        domain: 'example.com',
        path: '/',
        createdAt: Date.now(),
      });
      expect(jar.getCookiesFor('http://example.com/')).toHaveLength(1);
    });

    test('does not match parent domain from subdomain cookie', () => {
      jar.setCookie({
        name: 'sub',
        value: 'val',
        domain: 'api.example.com',
        path: '/',
        createdAt: Date.now(),
      });
      const cookies = jar.getCookiesFor('https://example.com/');
      expect(cookies).toHaveLength(0);
    });

    test('path matching — exact match', () => {
      jar.setCookie({
        name: 'admin',
        value: 'yes',
        domain: 'example.com',
        path: '/admin',
        createdAt: Date.now(),
      });
      expect(jar.getCookiesFor('https://example.com/admin')).toHaveLength(1);
      expect(
        jar.getCookiesFor('https://example.com/admin/settings'),
      ).toHaveLength(1);
      expect(jar.getCookiesFor('https://example.com/')).toHaveLength(0);
      expect(jar.getCookiesFor('https://example.com/adminfoo')).toHaveLength(0);
    });

    test('path matching — cookie-path ending with / (RFC 6265 §5.1.4 cond. 2)', () => {
      jar.setCookie({
        name: 'scoped',
        value: '1',
        domain: 'example.com',
        path: '/api/',
        createdAt: Date.now(),
      });
      expect(jar.getCookiesFor('https://example.com/api/users')).toHaveLength(
        1,
      );
      expect(jar.getCookiesFor('https://example.com/api/')).toHaveLength(1);
      expect(jar.getCookiesFor('https://example.com/api')).toHaveLength(0);
    });

    test('excludes expired cookies', () => {
      const past = new Date(Date.now() - 10_000);
      jar.setCookie({
        name: 'old',
        value: 'stale',
        domain: 'example.com',
        path: '/',
        expires: past,
        createdAt: Date.now(),
      });
      expect(jar.getCookiesFor('https://example.com/')).toHaveLength(0);
    });

    test('excludes maxAge-expired cookies', () => {
      jar.setCookie({
        name: 'short',
        value: 'lived',
        domain: 'example.com',
        path: '/',
        maxAge: 1,
        createdAt: Date.now() - 5000, // created 5s ago, maxAge=1s
      });
      expect(jar.getCookiesFor('https://example.com/')).toHaveLength(0);
    });
  });

  describe('getCookieFor', () => {
    test('returns named cookie matching url domain and path', () => {
      jar.setCookie({
        name: 'session',
        value: 'abc',
        domain: 'example.com',
        path: '/',
        createdAt: Date.now(),
      });
      expect(jar.getCookieFor('session', 'https://example.com')?.value).toBe(
        'abc',
      );
    });

    test('returns undefined when name does not match', () => {
      jar.setCookie({
        name: 'session',
        value: 'abc',
        domain: 'example.com',
        path: '/',
        createdAt: Date.now(),
      });
      expect(jar.getCookieFor('other', 'https://example.com')).toBeUndefined();
    });

    test('returns undefined when domain does not match', () => {
      jar.setCookie({
        name: 'session',
        value: 'abc',
        domain: 'example.com',
        path: '/',
        createdAt: Date.now(),
      });
      expect(jar.getCookieFor('session', 'https://other.com')).toBeUndefined();
    });

    test('finds cookie via subdomain lookup', () => {
      jar.setCookie({
        name: 'shared',
        value: 'yes',
        domain: 'example.com',
        path: '/',
        createdAt: Date.now(),
      });
      expect(jar.getCookieFor('shared', 'https://api.example.com')?.value).toBe(
        'yes',
      );
    });

    test('returns undefined for expired cookie', () => {
      jar.setCookie({
        name: 'old',
        value: 'stale',
        domain: 'example.com',
        path: '/',
        createdAt: Date.now(),
      });
      expireStored(jar, 'old');
      expect(jar.getCookieFor('old', 'https://example.com')).toBeUndefined();
    });
  });

  describe('getStoredDomains', () => {
    test('returns empty array when no cookies', () => {
      expect(jar.getStoredDomains()).toHaveLength(0);
    });

    test('returns domains with counts', () => {
      jar.setCookie({
        name: 'a',
        value: '1',
        domain: 'example.com',
        path: '/',
        createdAt: Date.now(),
      });
      jar.setCookie({
        name: 'b',
        value: '2',
        domain: 'example.com',
        path: '/',
        createdAt: Date.now(),
      });
      jar.setCookie({
        name: 'c',
        value: '3',
        domain: 'other.com',
        path: '/',
        createdAt: Date.now(),
      });

      const domains = jar.getStoredDomains();
      expect(domains).toHaveLength(2);

      const exampleEntry = domains.find((d) => d.domain === 'example.com');
      const otherEntry = domains.find((d) => d.domain === 'other.com');
      expect(exampleEntry?.count).toBe(2);
      expect(otherEntry?.count).toBe(1);
    });

    test('counts include cookies from different paths on same domain', () => {
      jar.setCookie({
        name: 'a',
        value: '1',
        domain: 'example.com',
        path: '/',
        createdAt: Date.now(),
      });
      jar.setCookie({
        name: 'a',
        value: '2',
        domain: 'example.com',
        path: '/admin',
        createdAt: Date.now(),
      });

      const domains = jar.getStoredDomains();
      expect(domains).toHaveLength(1);
      expect(domains[0].count).toBe(2);
    });
  });

  describe('PSL private section (cookie tossing between tenants)', () => {
    // The ICANN half of the list alone reads `github.io` as an ordinary registrable
    // domain, so one tenant could set a cookie every other tenant on the platform would
    // send. Browsers consult the private half for exactly this; so does the jar.
    test.each([
      ['github.io', 'https://evil.github.io', 'https://victim.github.io'],
      [
        'herokuapp.com',
        'https://evil.herokuapp.com',
        'https://victim.herokuapp.com',
      ],
      [
        's3.amazonaws.com',
        'https://evil.s3.amazonaws.com',
        'https://victim.s3.amazonaws.com',
      ],
    ])(
      'refuses Domain=%s and cannot toss a cookie between tenants',
      (suffix, attacker, victim) => {
        jar.parseSetCookieHeader(
          `session=tossed; Domain=${suffix}; Path=/`,
          attacker,
        );

        expect(jar.getAllCookies()).toHaveLength(0);
        expect(jar.getCookieFor('session', victim)).toBeUndefined();
      },
    );

    test('tenants under a private suffix get separate buckets', () => {
      jar.parseSetCookieHeader(
        'session=mine; Path=/',
        'https://evil.github.io',
      );

      expect(jar.getCookieFor('session', 'https://evil.github.io')?.value).toBe(
        'mine',
      );
      expect(
        jar.getCookieFor('session', 'https://victim.github.io'),
      ).toBeUndefined();
    });

    test('a registrable domain under a private suffix still scopes its own subdomains', () => {
      jar.parseSetCookieHeader(
        'session=ok; Domain=mine.github.io; Path=/',
        'https://api.mine.github.io',
      );

      expect(
        jar.getCookieFor('session', 'https://api.mine.github.io')?.value,
      ).toBe('ok');
      // A domain cookie, not a host-only one: another subdomain, and the domain itself.
      expect(
        jar.getCookieFor('session', 'https://www.mine.github.io')?.value,
      ).toBe('ok');
      expect(jar.getCookieFor('session', 'https://mine.github.io')?.value).toBe(
        'ok',
      );
      expect(
        jar.getCookieFor('session', 'https://other.github.io'),
      ).toBeUndefined();
    });
  });

  describe('an IP request host matches its own literal only', () => {
    // RFC 6265 5.1.3 has no subdomain reading for an address, but the suffix test is a DNS
    // rule applied to text: `127.0.0.1` ends with `.0.1`, so `Domain=0.1` passed it. The
    // cookie was never *sent*, because an address buckets as itself and no lookup reaches
    // the `0.1` bucket - but that is a property of the bucketing rather than of the domain
    // check, so it stops protecting anything the next time bucketing changes.
    test.each([['0.1'], ['0.0.1'], ['1']])(
      'refuses Domain=%s from an IPv4 request host',
      (domain) => {
        jar.parseSetCookieHeader(
          `session=x; Domain=${domain}; Path=/`,
          'http://127.0.0.1/',
        );

        expect(jar.getAllCookies()).toHaveLength(0);
      },
    );

    test('refuses an IPv4 cookie domain as a DNS hostname suffix', () => {
      // WHATWG URL parsing currently rejects this hostname before storage. Exercise
      // the matcher too so its DNS rule does not depend on that upstream rejection.
      expect(jar['domainMatches']('evil.10.0.0.5', '10.0.0.5')).toBe(false);
      jar.parseSetCookieHeader(
        'session=x; Domain=10.0.0.5; Path=/',
        'http://evil.10.0.0.5/',
      );

      expect(jar.getAllCookies()).toHaveLength(0);
      expect(jar.getCookiesFor('http://10.0.0.5/')).toHaveLength(0);
    });

    test('accepts Domain= that is the address itself', () => {
      jar.parseSetCookieHeader(
        'session=x; Domain=127.0.0.1; Path=/',
        'http://127.0.0.1/',
      );

      expect(jar.getCookieFor('session', 'http://127.0.0.1/')?.value).toBe('x');
    });

    test('a host-only cookie on an IP is unaffected', () => {
      jar.parseSetCookieHeader('session=x; Path=/', 'http://127.0.0.1/');

      expect(jar.getCookieFor('session', 'http://127.0.0.1/')?.value).toBe('x');
    });

    test('an IPv6 literal keeps matching itself', () => {
      jar.parseSetCookieHeader('session=x; Path=/', 'http://[::1]/');

      expect(jar.getCookieFor('session', 'http://[::1]/')?.value).toBe('x');
    });
  });

  describe('bare hostnames as public suffixes (RFC 6265bis 5.5)', () => {
    test('a sibling host cannot claim Domain=localhost', () => {
      jar.parseSetCookieHeader(
        'session=tossed; Domain=localhost; Path=/',
        'https://evil.localhost/',
      );

      expect(jar.getAllCookies()).toHaveLength(0);
      expect(jar.getCookieFor('session', 'http://localhost/')).toBeUndefined();
    });

    test('the host itself may set Domain=localhost, host-only', () => {
      jar.parseSetCookieHeader(
        'session=mine; Domain=localhost; Path=/',
        'http://localhost/',
      );

      const stored = jar.getCookieFor('session', 'http://localhost/');

      expect(stored?.value).toBe('mine');
      // Kept, but stripped of reach: the attribute cannot widen it past the host that
      // sent it. Asserted on the flag rather than on a request to `sub.localhost`,
      // because that request proves nothing here - hosts under a bare name are bucketed
      // separately (`siteFor('sub.localhost')` is `'sub.localhost'`, not `'localhost'`),
      // so it comes back empty with or without the flag. The flag is what the attribute
      // decides, and `hostOnlyDomainMatches` is what it drives on the send path.
      expect(stored?.hostOnly).toBe(true);
    });

    test('a sibling cannot evict the cookie the host set for itself', () => {
      // The store-side half of the toss, and the one with teeth. `Max-Age=0` deletes by
      // the *cookie's* domain, not the request host, so `evil.localhost` naming
      // `Domain=localhost` would land on exactly the identity `http://localhost/` stored
      // under and delete it: log the victim out, or clear the anti-CSRF token, from a
      // sibling name anyone can take on a shared dev host. The `Domain=` branch refuses
      // it before the cookie is stored, so the deletion never runs.
      jar.parseSetCookieHeader('session=victim; Path=/', 'http://localhost/');

      jar.parseSetCookieHeader(
        'session=x; Domain=localhost; Path=/; Max-Age=0',
        'https://evil.localhost/',
      );

      expect(jar.getCookieFor('session', 'http://localhost/')?.value).toBe(
        'victim',
      );
    });

    test('a host-only cookie on localhost is unaffected', () => {
      jar.parseSetCookieHeader('session=mine; Path=/', 'http://localhost/');

      expect(jar.getCookieFor('session', 'http://localhost/')?.value).toBe(
        'mine',
      );
    });

    test('a subdomain of a bare name still scopes itself', () => {
      jar.parseSetCookieHeader(
        'session=mine; Domain=app.localhost; Path=/',
        'https://api.app.localhost/',
      );

      // `app.localhost` is a registrable name *under* the `localhost` suffix, so it is not
      // itself a public suffix and the cookie stays domain-scoped: this is the ordinary
      // `Domain=example.com` from `api.example.com` case, one suffix down. Making bare
      // names suffixes must not collapse that - a dev setup running several services under
      // one `app.localhost` still shares a session across them.
      const stored = jar.getCookieFor('session', 'https://api.app.localhost/');

      expect(stored?.value).toBe('mine');
      expect(stored?.hostOnly).toBe(false);
      // The spanning is real, not just bucket co-residency: the site's own host receives it.
      expect(jar.getCookieFor('session', 'https://app.localhost/')?.value).toBe(
        'mine',
      );
    });

    test('the same rule keeps a public-suffix cookie the host itself sets', () => {
      // `Domain=github.io` from `https://github.io/` itself is kept host-only, as RFC
      // 6265bis keeps it, rather than refused outright.
      jar.parseSetCookieHeader(
        'session=mine; Domain=github.io; Path=/',
        'https://github.io/',
      );

      const stored = jar.getCookieFor('session', 'https://github.io/');

      expect(stored?.value).toBe('mine');
      expect(stored?.hostOnly).toBe(true);
      // A request to `victim.github.io` would prove nothing - tenants of a public suffix
      // get one bucket each, so it never saw this cookie. The live assertion is the other
      // direction: a tenant still may not claim the suffix, which is the property the
      // §5.5 relaxation must not have loosened.
      const tenant = new CookieJar();

      tenant.parseSetCookieHeader(
        'session=tossed; Domain=github.io; Path=/',
        'https://evil.github.io/',
      );

      expect(tenant.getAllCookies()).toHaveLength(0);
    });

    test('remove opts a bare name back into spanning', () => {
      const scoped = new CookieJar({
        publicSuffixes: { remove: ['localhost'] },
      });

      scoped.parseSetCookieHeader(
        'session=shared; Domain=localhost; Path=/',
        'https://app.localhost/',
      );

      // Removing a suffix changes both admission and bucketing: every host below the
      // removed boundary can see a cookie scoped to it.
      expect(scoped.getCookieFor('session', 'http://localhost/')?.value).toBe(
        'shared',
      );
      expect(
        scoped.getCookieFor('session', 'http://other.localhost/')?.value,
      ).toBe('shared');
    });

    test('the host-only flag survives a persist/restore round trip', () => {
      // `hostOnly` is the *whole* of the §5.5 restriction - `domain` still reads
      // `localhost`, indistinguishable from a spanning cookie. `toJSON` writes the flag
      // and `setCookie` (which `fromJSON` replays through) has to honour it, or a jar
      // persisted and reloaded comes back with the attribute widened again and the toss
      // reopens across a restart.
      jar.parseSetCookieHeader(
        'session=mine; Domain=localhost; Path=/',
        'http://localhost/',
      );

      const restored = new CookieJar();

      expect(restored.fromJSON(JSON.parse(JSON.stringify(jar.toJSON())))).toBe(
        1,
      );
      expect(
        restored.getCookieFor('session', 'http://localhost/')?.hostOnly,
      ).toBe(true);
    });

    test('a tampered persisted public-suffix cookie cannot cross tenant buckets', () => {
      const restored = new CookieJar();

      expect(
        restored.fromJSON({
          cookies: [
            {
              name: 'session',
              value: 'tossed',
              domain: 'github.io',
              path: '/',
              hostOnly: false,
              createdAt: Date.now(),
            },
          ],
        }),
      ).toBe(1);

      expect(
        restored.getCookieFor('session', 'https://victim.github.io/'),
      ).toBeUndefined();
      expect(
        restored.getCookieFor('session', 'https://other.github.io/'),
      ).toBeUndefined();
    });
  });

  describe('publicSuffixes overrides', () => {
    test('add treats an internal suffix as public', () => {
      const scoped = new CookieJar({
        publicSuffixes: { add: ['corp.internal'] },
      });

      scoped.parseSetCookieHeader(
        'session=tossed; Domain=corp.internal; Path=/',
        'https://evil.corp.internal',
      );

      expect(scoped.getAllCookies()).toHaveLength(0);

      scoped.parseSetCookieHeader(
        'session=mine; Path=/',
        'https://evil.corp.internal',
      );

      expect(
        scoped.getCookieFor('session', 'https://victim.corp.internal'),
      ).toBeUndefined();
    });

    test('add accepts a leading dot, as Set-Cookie writes it', () => {
      const scoped = new CookieJar({
        publicSuffixes: { add: ['.corp.internal'] },
      });

      scoped.parseSetCookieHeader(
        'session=tossed; Domain=corp.internal; Path=/',
        'https://evil.corp.internal',
      );

      expect(scoped.getAllCookies()).toHaveLength(0);
    });

    test('add does not match a partial label', () => {
      const scoped = new CookieJar({
        publicSuffixes: { add: ['corp.internal'] },
      });

      scoped.parseSetCookieHeader(
        'session=ok; Domain=notcorp.internal; Path=/',
        'https://host.notcorp.internal',
      );

      expect(
        scoped.getCookieFor('session', 'https://host.notcorp.internal')?.value,
      ).toBe('ok');
    });

    test('remove opts a private suffix back out', () => {
      const scoped = new CookieJar({
        publicSuffixes: { remove: ['herokuapp.com'] },
      });

      scoped.parseSetCookieHeader(
        'session=shared; Domain=herokuapp.com; Path=/',
        'https://mine.herokuapp.com',
      );

      expect(
        scoped.getCookieFor('session', 'https://other.herokuapp.com')?.value,
      ).toBe('shared');
    });

    test('remove can opt a one-label suffix back into spanning', () => {
      const scoped = new CookieJar({
        publicSuffixes: { remove: ['com'] },
      });

      scoped.parseSetCookieHeader(
        'session=shared; Domain=com; Path=/',
        'https://mine.com',
      );

      expect(scoped.getCookieFor('session', 'https://other.com')?.value).toBe(
        'shared',
      );
      expect(
        scoped.getCookieFor('session', 'https://tenant.blogspot.com')?.value,
      ).toBe('shared');
    });

    test('keeps a trailing root dot as part of the host for domain and host-only cookies', () => {
      const domainCookie = new CookieJar();

      // A real domain cookie: `localhost` is a public suffix, so `Domain=localhost` is
      // stored host-only and never reached this path.
      domainCookie.parseSetCookieHeader(
        'session=domain; Domain=example.com.; Path=/',
        'https://www.example.com./',
      );

      expect(domainCookie.getAllCookies()[0]?.hostOnly).toBe(false);
      expect(
        domainCookie.getCookieFor('session', 'https://api.example.com./')
          ?.value,
      ).toBe('domain');
      expect(
        domainCookie.getCookieFor('session', 'https://www.example.com/'),
      ).toBeUndefined();

      const hostOnlyCookie = new CookieJar();

      hostOnlyCookie.parseSetCookieHeader(
        'session=host; Path=/',
        'https://example.com./',
      );

      expect(
        hostOnlyCookie.getCookieFor('session', 'https://example.com./')?.value,
      ).toBe('host');
      expect(
        hostOnlyCookie.getCookieFor('session', 'https://example.com/'),
      ).toBeUndefined();
    });

    test('an override on one jar does not reach another', () => {
      const scoped = new CookieJar({
        publicSuffixes: { remove: ['herokuapp.com'] },
      });

      scoped.parseSetCookieHeader(
        'session=shared; Domain=herokuapp.com; Path=/',
        'https://mine.herokuapp.com',
      );
      jar.parseSetCookieHeader(
        'session=shared; Domain=herokuapp.com; Path=/',
        'https://mine.herokuapp.com',
      );

      expect(scoped.getAllCookies()).toHaveLength(1);
      expect(jar.getAllCookies()).toHaveLength(0);
    });

    test.each([
      [{ add: [''] }, 'empty suffix'],
      [{ add: ['*.example.com'] }, 'wildcard'],
      [{ add: ['a..b'] }, 'empty label'],
      [{ add: ['https://corp.internal'] }, 'scheme'],
      [{ add: ['corp internal'] }, 'whitespace'],
      [{ add: ['corp/internal'] }, 'path separator'],
      [{ add: ['corp!.internal'] }, 'punctuation'],
      [{ add: [42 as unknown as string] }, 'non-string'],
      [{ add: ['corp.internal'], remove: ['corp.internal'] }, 'contradiction'],
    ])('throws on a %o config (%s)', (publicSuffixes) => {
      expect(() => new CookieJar({ publicSuffixes: publicSuffixes })).toThrow(
        TypeError,
      );
    });
  });

  describe('PSL validation (parseSetCookieHeader)', () => {
    test('rejects Domain= that is a public suffix', () => {
      jar.parseSetCookieHeader(
        'session=abc; Domain=co.uk; Path=/',
        'https://evil.co.uk',
      );
      expect(jar.getAllCookies()).toHaveLength(0);
    });

    test('rejects Domain= that is a TLD', () => {
      jar.parseSetCookieHeader(
        'session=abc; Domain=com; Path=/',
        'https://example.com',
      );
      expect(jar.getAllCookies()).toHaveLength(0);
    });

    test('rejects Domain= for a different domain than the request host', () => {
      jar.parseSetCookieHeader(
        'session=abc; Domain=other.com; Path=/',
        'https://example.com',
      );
      expect(jar.getAllCookies()).toHaveLength(0);
    });

    test('accepts Domain= that is the request hostname', () => {
      jar.parseSetCookieHeader(
        'session=abc; Domain=example.com; Path=/',
        'https://example.com',
      );
      expect(jar.getCookieFor('session', 'https://example.com')?.value).toBe(
        'abc',
      );
    });

    test('accepts Domain= with mixed case (case-insensitive domain-match per RFC 6265 5.1.3)', () => {
      jar.parseSetCookieHeader(
        'session=abc; Domain=Example.Com; Path=/',
        'https://example.com',
      );

      const cookie = jar.getCookieFor('session', 'https://example.com');
      expect(cookie?.value).toBe('abc');
      expect(cookie?.domain).toBe('example.com');
    });

    test('accepts Domain= that is an apex of the request hostname', () => {
      jar.parseSetCookieHeader(
        'session=abc; Domain=example.com; Path=/',
        'https://api.example.com',
      );
      expect(
        jar.getCookieFor('session', 'https://api.example.com')?.value,
      ).toBe('abc');
    });

    test('strips leading dot from Domain= attribute', () => {
      jar.parseSetCookieHeader(
        'session=abc; Domain=.example.com; Path=/',
        'https://example.com',
      );
      const cookie = jar.getCookieFor('session', 'https://example.com');
      expect(cookie?.value).toBe('abc');
      expect(cookie?.domain).toBe('example.com');
    });

    test('a last empty Domain= or Domain=. makes the cookie host-only, as browsers store it', () => {
      jar.parseSetCookieHeader(
        'a=1; Domain=example.com; Domain=; Path=/',
        'https://www.example.com',
      );
      jar.parseSetCookieHeader(
        'b=2; Domain=example.com; Domain=.; Path=/',
        'https://www.example.com',
      );

      expect(jar.getCookieFor('a', 'https://api.example.com')).toBeUndefined();
      expect(jar.getCookieFor('a', 'https://www.example.com')?.value).toBe('1');
      expect(jar.getCookieFor('b', 'https://api.example.com')).toBeUndefined();
      expect(jar.getCookieFor('b', 'https://www.example.com')?.value).toBe('2');
    });

    test('empty Domain= or Domain=. is host-only and does not match subdomains', () => {
      jar.parseSetCookieHeader(
        'a=1; Domain=; Path=/',
        'https://api.example.com',
      );
      jar.parseSetCookieHeader(
        'b=2; Domain=.; Path=/',
        'https://api.example.com',
      );

      expect(jar.getCookieFor('a', 'https://api.example.com')?.value).toBe('1');
      expect(jar.getCookieFor('b', 'https://api.example.com')?.value).toBe('2');
      expect(
        jar.getCookieFor('a', 'https://sub.api.example.com'),
      ).toBeUndefined();
      expect(
        jar.getCookieFor('b', 'https://sub.api.example.com'),
      ).toBeUndefined();
    });

    test('allows localhost cookies', () => {
      jar.parseSetCookieHeader('session=abc; Path=/', 'http://localhost:3000');
      expect(jar.getCookieFor('session', 'http://localhost:3000')?.value).toBe(
        'abc',
      );
    });

    test('co.uk subdomain cookies work correctly', () => {
      jar.parseSetCookieHeader(
        'session=abc; Domain=example.co.uk; Path=/',
        'https://api.example.co.uk',
      );
      expect(
        jar.getCookieFor('session', 'https://api.example.co.uk')?.value,
      ).toBe('abc');
      expect(jar.getCookieFor('session', 'https://example.co.uk')?.value).toBe(
        'abc',
      );
      expect(
        jar.getCookieFor('session', 'https://other.co.uk'),
      ).toBeUndefined();
    });
  });

  describe('store-time scheme rules (RFC 6265bis)', () => {
    test('refuses a Secure cookie set over http', () => {
      jar.parseSetCookieHeader('session=evil; Secure', 'http://example.com/');

      expect(jar.getAllCookies()).toHaveLength(0);
    });

    test('accepts a Secure cookie set over https and wss, and sends it to both', () => {
      jar.parseSetCookieHeader('a=1; Secure', 'https://example.com/');
      jar.parseSetCookieHeader('b=2; Secure', 'wss://example.com/');

      expect(jar.getCookieFor('a', 'https://example.com/')?.value).toBe('1');
      expect(jar.getCookieFor('b', 'https://example.com/')?.value).toBe('2');
      expect(jar.getCookiesFor('wss://example.com/')).toHaveLength(2);
      expect(jar.getCookiesFor('ws://example.com/')).toHaveLength(0);
    });

    test('a Secure cookie from http cannot replace the https session', () => {
      jar.parseSetCookieHeader('session=real; Secure', 'https://example.com/');
      jar.parseSetCookieHeader('session=evil; Secure', 'http://example.com/');

      expect(jar.getCookieFor('session', 'https://example.com/')?.value).toBe(
        'real',
      );
    });

    test('a non-Secure cookie from http cannot replace a stored Secure cookie', () => {
      // Cookie forcing: the plain-text hop plants `session` under the same key, and the
      // replacement would then go out over https as the real session.
      jar.parseSetCookieHeader('session=real; Secure', 'https://example.com/');
      jar.parseSetCookieHeader('session=evil', 'http://example.com/');

      expect(jar.getAllCookies()).toHaveLength(1);
      expect(jar.getCookieFor('session', 'https://example.com/')?.value).toBe(
        'real',
      );
      expect(jar.getCookiesFor('http://example.com/')).toHaveLength(0);
    });

    test('a Max-Age=0 from http cannot evict a stored Secure cookie', () => {
      jar.parseSetCookieHeader('session=real; Secure', 'https://example.com/');
      jar.parseSetCookieHeader('session=; Max-Age=0', 'http://example.com/');
      jar.parseSetCookieHeader(
        'session=; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
        'http://example.com/',
      );

      expect(jar.getCookieFor('session', 'https://example.com/')?.value).toBe(
        'real',
      );
    });

    test('a non-Secure cookie from http cannot shadow a Secure domain cookie from a subdomain', () => {
      // The stored cookie's `Domain=example.com` covers `sub.example.com`, so a
      // host-only `session` planted there would be sent beside the real one.
      jar.parseSetCookieHeader(
        'session=real; Secure; Domain=example.com',
        'https://example.com/',
      );
      jar.parseSetCookieHeader('session=evil', 'http://sub.example.com/');

      expect(jar.getAllCookies()).toHaveLength(1);
      expect(
        jar.getCookiesFor('https://sub.example.com/').map((c) => c.value),
      ).toEqual(['real']);
    });

    test('a non-Secure cookie from http cannot shadow a Secure cookie under its path', () => {
      jar.parseSetCookieHeader(
        'session=real; Secure; Path=/',
        'https://example.com/',
      );
      jar.parseSetCookieHeader(
        'session=evil; Path=/admin',
        'http://example.com/admin',
      );

      expect(jar.getAllCookies()).toHaveLength(1);
      expect(
        jar.getCookiesFor('https://example.com/admin').map((c) => c.value),
      ).toEqual(['real']);
    });

    test('a wider Domain= cookie from http cannot shadow a host-only Secure cookie on a subdomain', () => {
      // The other direction of RFC 6265bis's "or vice versa": the stored host-only
      // cookie on `app.example.com` is under the planted `Domain=example.com`, and the
      // send path would deliver both to `https://app.example.com`.
      jar.parseSetCookieHeader(
        'session=real; Secure',
        'https://app.example.com/',
      );
      jar.parseSetCookieHeader(
        'session=evil; Domain=example.com',
        'http://example.com/',
      );

      expect(jar.getAllCookies()).toHaveLength(1);
      expect(
        jar.getCookiesFor('https://app.example.com/').map((c) => c.value),
      ).toEqual(['real']);
    });

    test('the domain check ignores hostOnly in both directions, as the RFC does', () => {
      // A host-only Secure cookie on the apex would not be *sent* to a subdomain, but
      // RFC 6265bis §5.7 refuses on domain-match alone; the stricter reading costs
      // nothing but a same-named plain-text cookie in the same tree.
      jar.parseSetCookieHeader('host=real; Secure', 'https://example.com/');
      jar.parseSetCookieHeader('host=other', 'http://sub.example.com/');

      expect(jar.getAllCookies()).toHaveLength(1);
      expect(jar.getCookiesFor('http://sub.example.com/')).toHaveLength(0);
    });

    test.each([
      {
        direction: 'a wider plant over a Secure cookie behind a listed suffix',
        secureURL: 'https://t.compute-1.amazonaws.com/',
        secureHeader: 'session=real; Secure',
        plantURL: 'http://b.s3.amazonaws.com/',
        plantHeader: 'session=evil; Domain=amazonaws.com',
      },
      {
        direction: 'a plant behind a listed suffix under a wider Secure cookie',
        secureURL: 'https://b.s3.amazonaws.com/',
        secureHeader: 'session=real; Secure; Domain=amazonaws.com',
        plantURL: 'http://t.compute-1.amazonaws.com/',
        plantHeader: 'session=evil',
      },
    ])(
      'the shadow check reaches across sites: $direction',
      ({ secureURL, secureHeader, plantURL, plantHeader }) => {
        // With `s3.amazonaws.com` removed, `amazonaws.com` is a site holding the wider
        // cookie, and `t.compute-1.amazonaws.com` is a site of its own beneath it: the
        // two cookies are filed apart, and the send path delivers both to the tenant.
        const sites = new CookieJar({
          publicSuffixes: { remove: ['s3.amazonaws.com'] },
        });
        sites.parseSetCookieHeader(secureHeader, secureURL);
        sites.parseSetCookieHeader(plantHeader, plantURL);

        expect(sites.getAllCookies().map((c) => c.value)).toEqual(['real']);
      },
    );

    test('a wider-path cookie from http is stored beside a path-scoped Secure cookie, as browsers store it', () => {
      jar.parseSetCookieHeader(
        'scoped=real; Secure; Path=/admin',
        'https://example.com/admin',
      );
      jar.parseSetCookieHeader('scoped=other; Path=/', 'http://example.com/');

      expect(
        jar
          .getCookiesFor('https://example.com/admin')
          .filter((c) => c.name === 'scoped')
          .map((c) => c.value),
      ).toEqual(['real', 'other']);
    });

    test("a non-Secure cookie outside the Secure cookie's domain tree is stored", () => {
      jar.parseSetCookieHeader('session=real; Secure', 'https://example.com/');
      jar.parseSetCookieHeader('session=elsewhere', 'http://example.org/');

      expect(jar.getCookieFor('session', 'http://example.org/')?.value).toBe(
        'elsewhere',
      );
      expect(jar.getCookieFor('session', 'https://example.com/')?.value).toBe(
        'real',
      );
    });

    test('a non-Secure cookie from https may replace a Secure cookie', () => {
      // The rule guards the plain-text hop only; RFC 6265bis leaves a secure origin free
      // to downgrade its own cookie.
      jar.parseSetCookieHeader('session=real; Secure', 'https://example.com/');
      jar.parseSetCookieHeader('session=plain', 'https://example.com/');

      const stored = jar.getCookieFor('session', 'https://example.com/');
      expect(stored?.value).toBe('plain');
      expect(stored?.secure).toBeUndefined();
    });

    test('a non-Secure cookie from http still replaces a non-Secure cookie', () => {
      jar.parseSetCookieHeader('pref=a', 'https://example.com/');
      jar.parseSetCookieHeader('pref=b', 'http://example.com/');

      expect(jar.getCookieFor('pref', 'http://example.com/')?.value).toBe('b');
    });

    test('a Secure cookie restored through fromJSON() is protected the same way', () => {
      // `fromJSON` stores through `setCookie`, so a persisted jar comes back with the same
      // guard a live one has.
      const persisted = new CookieJar();
      persisted.parseSetCookieHeader(
        'session=real; Secure',
        'https://example.com/',
      );

      expect(jar.fromJSON(JSON.parse(JSON.stringify(persisted.toJSON())))).toBe(
        1,
      );

      jar.parseSetCookieHeader('session=evil', 'http://example.com/');
      jar.parseSetCookieHeader('session=; Max-Age=0', 'http://example.com/');

      expect(jar.getAllCookies()).toHaveLength(1);
      expect(jar.getCookieFor('session', 'https://example.com/')?.value).toBe(
        'real',
      );
    });

    test('setCookie() is not scheme-gated', () => {
      // The programmatic path has no request URL to judge; a caller restoring or
      // seeding a jar stores what it says.
      expect(
        jar.setCookie({
          name: 'session',
          value: 'seeded',
          domain: 'example.com',
          path: '/',
          secure: true,
        }),
      ).toBe(true);
      expect(
        jar.setCookie({
          name: 'session',
          value: 'replaced',
          domain: 'example.com',
          path: '/',
        }),
      ).toBe(true);

      expect(jar.getCookieFor('session', 'http://example.com/')?.value).toBe(
        'replaced',
      );
    });
  });

  describe('cookie name prefixes (RFC 6265bis)', () => {
    test('__Secure- requires the Secure attribute', () => {
      jar.parseSetCookieHeader('__Secure-id=1', 'https://example.com/');
      expect(jar.getAllCookies()).toHaveLength(0);

      jar.parseSetCookieHeader('__Secure-id=1; Secure', 'https://example.com/');
      expect(
        jar.getCookieFor('__Secure-id', 'https://example.com/')?.value,
      ).toBe('1');
    });

    test('__Secure- over http is refused even with the Secure attribute', () => {
      jar.parseSetCookieHeader('__Secure-id=1; Secure', 'http://example.com/');
      expect(jar.getAllCookies()).toHaveLength(0);
    });

    test('__Host- requires Secure, no Domain, and Path=/', () => {
      jar.parseSetCookieHeader('__Host-id=1; Path=/', 'https://example.com/');
      jar.parseSetCookieHeader(
        '__Host-id=2; Secure; Path=/; Domain=example.com',
        'https://example.com/',
      );
      jar.parseSetCookieHeader(
        '__Host-id=3; Secure; Path=/app',
        'https://example.com/app',
      );
      expect(jar.getAllCookies()).toHaveLength(0);

      // An omitted Path is refused even where it would default to `/`, as RFC 6265bis
      // and browsers require the attribute.
      jar.parseSetCookieHeader('__Host-id=4; Secure', 'https://example.com/');
      jar.parseSetCookieHeader('__Host-id=4b; Secure', 'https://example.com');
      jar.parseSetCookieHeader(
        '__Host-id=refused; Secure',
        'https://example.com/app/page',
      );
      expect(jar.getAllCookies()).toHaveLength(0);

      jar.parseSetCookieHeader(
        '__Host-id=5; Secure; Path=/',
        'https://example.com/deep/path',
      );
      const stored = jar.getCookieFor('__Host-id', 'https://example.com/');
      expect(stored?.value).toBe('5');
      expect(stored?.hostOnly).toBe(true);
      expect(stored?.path).toBe('/');
      expect(jar.getCookiesFor('https://sub.example.com/')).toHaveLength(0);
    });

    test('__Host- treats an empty Domain= as absent, as the jar does', () => {
      // `Domain=` and `Domain=.` parse to `''` and are stored host-only everywhere else
      // in the jar; the prefix rule agrees rather than refusing what the store would
      // have made host-only anyway.
      jar.parseSetCookieHeader(
        '__Host-id=1; Secure; Path=/; Domain=',
        'https://example.com/',
      );

      const stored = jar.getCookieFor('__Host-id', 'https://example.com/');
      expect(stored?.value).toBe('1');
      expect(stored?.hostOnly).toBe(true);
      expect(jar.getCookiesFor('https://sub.example.com/')).toHaveLength(0);
    });

    test('setCookie() and fromJSON() enforce the prefix attributes too', () => {
      // No request URL is needed to check the attributes a prefix promises, so the
      // programmatic path holds them as well: a persisted jar tampered into a
      // `__Host-` cookie with `hostOnly` cleared would otherwise be restored and sent to
      // every subdomain under a name that tells a server it was set host-only at `/`.
      const base = { value: '1', domain: 'example.com', createdAt: Date.now() };

      expect(jar.setCookie({ ...base, name: '__Secure-id', path: '/' })).toBe(
        false,
      );
      expect(
        jar.setCookie({ ...base, name: '__Host-id', path: '/', secure: true }),
      ).toBe(false);
      expect(
        jar.setCookie({
          ...base,
          name: '__Host-id',
          path: '/app',
          secure: true,
          hostOnly: true,
        }),
      ).toBe(false);
      expect(jar.getAllCookies()).toHaveLength(0);

      expect(
        jar.setCookie({
          ...base,
          name: '__Secure-id',
          path: '/',
          secure: true,
        }),
      ).toBe(true);
      expect(
        jar.setCookie({
          ...base,
          name: '__Host-id',
          path: '/',
          secure: true,
          hostOnly: true,
        }),
      ).toBe(true);

      const tampered = new CookieJar();
      const restoredCount = tampered.fromJSON({
        cookies: [
          { ...base, name: '__Host-session', path: '/', secure: true },
          {
            ...base,
            name: '__Host-ok',
            path: '/',
            secure: true,
            hostOnly: true,
          },
        ],
      });

      expect(restoredCount).toBe(1);
      expect(tampered.getCookiesFor('https://sub.example.com/')).toHaveLength(
        0,
      );
      expect(
        tampered.getCookieFor('__Host-ok', 'https://example.com/')?.value,
      ).toBe('1');
    });

    test('prefixes match case-insensitively', () => {
      jar.parseSetCookieHeader('__host-id=1; Path=/', 'https://example.com/');
      jar.parseSetCookieHeader('__SECURE-id=1', 'https://example.com/');
      expect(jar.getAllCookies()).toHaveLength(0);
    });

    test('a name that merely contains a prefix is unaffected', () => {
      jar.parseSetCookieHeader('x__Host-id=1', 'https://example.com/');
      expect(
        jar.getCookieFor('x__Host-id', 'https://example.com/')?.value,
      ).toBe('1');
    });
  });

  describe('getCookieHeaderString', () => {
    test('returns cookie header string', () => {
      jar.setCookie({
        name: 'a',
        value: '1',
        domain: 'example.com',
        path: '/',
        createdAt: Date.now(),
      });
      jar.setCookie({
        name: 'b',
        value: '2',
        domain: 'example.com',
        path: '/',
        createdAt: Date.now(),
      });
      const header = jar.getCookieHeaderString('https://example.com/');
      expect(header).toContain('a=1');
      expect(header).toContain('b=2');
    });

    test('returns empty string when no matching cookies', () => {
      const header = jar.getCookieHeaderString('https://example.com/');
      expect(header).toBe('');
    });

    test('omits expired cookies (never sends them on the wire)', () => {
      jar.setCookie({
        name: 'stale',
        value: 'no',
        domain: 'example.com',
        path: '/',
        createdAt: Date.now(),
      });
      expireStored(jar, 'stale');
      expect(jar.getCookieHeaderString('https://example.com/')).toBe('');
    });

    test('orders more specific path cookies before less specific ones', () => {
      jar.setCookie({
        name: 'sid',
        value: 'root',
        domain: 'example.com',
        path: '/',
        createdAt: 1,
      });
      jar.setCookie({
        name: 'sid',
        value: 'admin',
        domain: 'example.com',
        path: '/admin',
        createdAt: 2,
      });

      expect(jar.getCookieHeaderString('https://example.com/admin')).toBe(
        'sid=admin; sid=root',
      );
      expect(jar.getCookieFor('sid', 'https://example.com/admin')?.value).toBe(
        'admin',
      );
    });
  });

  describe('bucket pruning', () => {
    test('site bucket removed when last cookie expires and clearExpiredCookies runs', () => {
      jar.setCookie({
        name: 'a',
        value: '1',
        domain: 'example.com',
        path: '/',
        createdAt: Date.now(),
      });
      expireStored(jar, 'a');
      expect(jar.getStoredDomains()).toHaveLength(1);
      jar.clearExpiredCookies();
      expect(jar.getStoredDomains()).toHaveLength(0);
    });

    test('site bucket removed when Max-Age=0 deletes last cookie', () => {
      jar.parseSetCookieHeader('session=abc; Path=/', 'https://example.com');
      expect(jar.getStoredDomains()).toHaveLength(1);
      jar.parseSetCookieHeader(
        'session=; Max-Age=0; Path=/',
        'https://example.com',
      );
      expect(jar.getStoredDomains()).toHaveLength(0);
    });

    test('site bucket remains when other cookies still exist', () => {
      jar.setCookie({
        name: 'a',
        value: '1',
        domain: 'example.com',
        path: '/',
        createdAt: Date.now(),
      });
      expireStored(jar, 'a');
      jar.setCookie({
        name: 'b',
        value: '2',
        domain: 'example.com',
        path: '/',
        createdAt: Date.now(),
      });
      jar.clearExpiredCookies();
      expect(jar.getStoredDomains()).toHaveLength(1);
      expect(jar.getStoredDomains()[0].count).toBe(1);
    });
  });

  describe('clearExpiredCookies', () => {
    test('removes expired cookies and returns the count removed', () => {
      jar.setCookie({
        name: 'fresh',
        value: 'yes',
        domain: 'example.com',
        path: '/',
        createdAt: Date.now(),
      });
      jar.setCookie({
        name: 'stale',
        value: 'no',
        domain: 'example.com',
        path: '/',
        createdAt: Date.now(),
      });
      expireStored(jar, 'stale');

      expect(jar.clearExpiredCookies()).toBe(1);
      expect(jar.getAllCookies()).toHaveLength(1);
      expect(jar.getAllCookies()[0].name).toBe('fresh');
    });

    test('returns 0 when no cookies are expired', () => {
      jar.setCookie({
        name: 'fresh',
        value: 'yes',
        domain: 'example.com',
        path: '/',
        createdAt: Date.now(),
      });
      expect(jar.clearExpiredCookies()).toBe(0);
    });
  });

  describe('clear', () => {
    test('clear() removes all cookies', () => {
      jar.setCookie({
        name: 'a',
        value: '1',
        domain: 'example.com',
        path: '/',
        createdAt: Date.now(),
      });
      jar.setCookie({
        name: 'b',
        value: '2',
        domain: 'other.com',
        path: '/',
        createdAt: Date.now(),
      });
      expect(jar.clear()).toBe(2);
      expect(jar.getAllCookies()).toHaveLength(0);
    });

    test('clear(host, hostname) removes only cookies for that exact hostname', () => {
      jar.setCookie({
        name: 'a',
        value: '1',
        domain: 'example.com',
        path: '/',
        createdAt: Date.now(),
      });
      jar.setCookie({
        name: 'b',
        value: '2',
        domain: 'api.example.com',
        path: '/',
        createdAt: Date.now(),
      });

      jar.clear('example.com', 'hostname');

      expect(jar.getCookieFor('a', 'https://example.com')).toBeUndefined();
      expect(jar.getCookieFor('b', 'https://api.example.com')?.value).toBe('2');
    });

    test('clear(host, hostname) matches stored domain case-insensitively', () => {
      jar.setCookie({
        name: 'a',
        value: '1',
        domain: 'example.com',
        path: '/',
        createdAt: Date.now(),
      });
      jar.clear('Example.COM', 'hostname');
      expect(jar.getCookieFor('a', 'https://example.com')).toBeUndefined();
    });

    test('clear(host, hostname) prunes the site bucket when last cookie removed', () => {
      jar.setCookie({
        name: 'a',
        value: '1',
        domain: 'example.com',
        path: '/',
        createdAt: Date.now(),
      });
      jar.clear('example.com', 'hostname');
      expect(jar.getStoredDomains()).toHaveLength(0);
    });

    test('clear(host, domain) removes all cookies for the site and its subdomains', () => {
      jar.setCookie({
        name: 'a',
        value: '1',
        domain: 'example.com',
        path: '/',
        createdAt: Date.now(),
      });
      jar.setCookie({
        name: 'b',
        value: '2',
        domain: 'api.example.com',
        path: '/',
        createdAt: Date.now(),
      });
      jar.setCookie({
        name: 'c',
        value: '3',
        domain: 'other.com',
        path: '/',
        createdAt: Date.now(),
      });

      expect(jar.clear('example.com', 'domain')).toBe(2);

      expect(jar.getCookieFor('a', 'https://example.com')).toBeUndefined();
      expect(jar.getCookieFor('b', 'https://api.example.com')).toBeUndefined();
      expect(jar.getCookieFor('c', 'https://other.com')?.value).toBe('3');
    });

    test('clear(host, domain) accepts any hostname in the site', () => {
      jar.setCookie({
        name: 'a',
        value: '1',
        domain: 'example.com',
        path: '/',
        createdAt: Date.now(),
      });
      expect(jar.clear('api.example.com', 'domain')).toBe(1);
      expect(jar.getAllCookies()).toHaveLength(0);
    });

    test('clear(host, domain) under a removed suffix clears the host site, not the other sites behind a suffix still listed', () => {
      const scoped = new CookieJar({ publicSuffixes: { remove: ['uk'] } });

      scoped.parseSetCookieHeader('x=host; Path=/', 'https://x.co.uk/');
      scoped.parseSetCookieHeader(
        'x=domain; Domain=x.co.uk; Path=/',
        'https://www.x.co.uk/',
      );
      scoped.parseSetCookieHeader('y=host; Path=/', 'https://y.co.uk/');
      scoped.parseSetCookieHeader(
        'shared=uk; Domain=uk; Path=/',
        'https://plain.uk/',
      );

      expect(scoped.clear('www.x.co.uk', 'domain')).toBe(2);
      expect(scoped.getCookieHeaderString('https://x.co.uk/')).toBe(
        'shared=uk',
      );
      expect(scoped.getCookieHeaderString('https://y.co.uk/')).toBe(
        'y=host; shared=uk',
      );

      // `co.uk` is still a suffix, so clearing it reaches every site beneath it - but
      // not the `Domain=uk` cookie above it.
      expect(scoped.clear('co.uk', 'domain')).toBe(1);
      expect(scoped.getStoredDomains()).toEqual([{ domain: 'uk', count: 1 }]);
    });

    test("a Domain= above the request host's site is refused, as browsers refuse it, under a removal", () => {
      // With `uk` removed, `co.uk` is still a suffix: `x.co.uk` is a site of its own and
      // may not reach `uk`, while `plain.uk`, whose site the removal widened to `uk`, may.
      const uk = new CookieJar({ publicSuffixes: { remove: ['uk'] } });
      uk.parseSetCookieHeader('a=1; Domain=uk; Path=/', 'https://x.co.uk/');
      uk.parseSetCookieHeader('b=2; Domain=uk; Path=/', 'https://plain.uk/');
      expect(uk.getCookieHeaderString('https://x.co.uk/')).toBe('b=2');

      // With `co.uk` removed as well, `x.co.uk` belongs to the `uk` site.
      const both = new CookieJar({
        publicSuffixes: { remove: ['uk', 'co.uk'] },
      });
      both.parseSetCookieHeader('a=1; Domain=uk; Path=/', 'https://x.co.uk/');
      expect(both.getCookieHeaderString('https://y.org.uk/')).toBe('a=1');

      // `!city.kawasaki.jp` keeps `city.kawasaki.jp` a site with `jp` removed.
      const jp = new CookieJar({ publicSuffixes: { remove: ['jp'] } });
      for (const domain of ['kawasaki.jp', 'jp']) {
        jp.parseSetCookieHeader(
          `c=1; Domain=${domain}; Path=/`,
          'https://x.city.kawasaki.jp/',
        );
      }
      expect(jp.getStoredDomains()).toEqual([]);

      // With `com` removed, `app.blogspot.com` may not set `Domain=com`, but is sent the
      // one `x.example.com` sets.
      const com = new CookieJar({ publicSuffixes: { remove: ['com'] } });
      com.parseSetCookieHeader(
        'd=1; Domain=com; Path=/',
        'https://app.blogspot.com/',
      );
      com.parseSetCookieHeader(
        'e=2; Domain=com; Path=/',
        'https://x.example.com/',
      );
      expect(com.getCookieHeaderString('https://app.blogspot.com/')).toBe(
        'e=2',
      );
    });

    test('a removed suffix below a name that is no suffix joins the site above it', () => {
      // `amazonaws.com` is no suffix, so with `s3.amazonaws.com` removed its tenants are
      // part of the `amazonaws.com` site: they may set a cookie for it, and clearing
      // any one host's domain reaches them all.
      const scoped = new CookieJar({
        publicSuffixes: { remove: ['s3.amazonaws.com'] },
      });

      scoped.parseSetCookieHeader(
        'shared=1; Domain=amazonaws.com; Path=/',
        'https://bucket.s3.amazonaws.com/',
      );
      scoped.parseSetCookieHeader('a=1; Path=/', 'https://x.amazonaws.com/');
      scoped.parseSetCookieHeader(
        'b=2; Path=/',
        'https://other.s3.amazonaws.com/',
      );
      scoped.parseSetCookieHeader('c=3; Path=/', 'https://example.com/');

      expect(scoped.getCookieHeaderString('https://www.amazonaws.com/')).toBe(
        'shared=1',
      );
      expect(scoped.clear('bucket.s3.amazonaws.com', 'domain')).toBe(3);
      expect(scoped.getStoredDomains()).toEqual([
        { domain: 'example.com', count: 1 },
      ]);
    });

    test('clear(host, domain) on a removed suffix clears everything under it, as on a listed one', () => {
      const scoped = new CookieJar({ publicSuffixes: { remove: ['uk'] } });

      scoped.parseSetCookieHeader('x=host; Path=/', 'https://x.co.uk/');
      scoped.parseSetCookieHeader('y=host; Path=/', 'https://a.y.org.uk/');
      scoped.parseSetCookieHeader('plain=1; Path=/', 'https://plain.uk/');
      scoped.parseSetCookieHeader(
        'shared=uk; Domain=uk; Path=/',
        'https://plain.uk/',
      );
      scoped.parseSetCookieHeader('other=1; Path=/', 'https://example.com/');

      // `x.co.uk` and `y.org.uk` stay sites of their own, behind `co.uk` and `org.uk`,
      // but naming `uk` itself reaches every host under it, as it does with no removal.
      expect(scoped.clear('uk', 'domain')).toBe(4);
      expect(scoped.getStoredDomains()).toEqual([
        { domain: 'example.com', count: 1 },
      ]);
    });

    test('clear(host, domain) on a removed TLD reaches the sites behind the suffixes still listed beneath it', () => {
      const scoped = new CookieJar({ publicSuffixes: { remove: ['com'] } });

      scoped.parseSetCookieHeader('a=1; Path=/', 'https://x.example.com/');
      scoped.parseSetCookieHeader('b=2; Path=/', 'https://app.blogspot.com/');
      scoped.parseSetCookieHeader(
        'c=3; Path=/',
        'https://bucket.s3.amazonaws.com/',
      );
      scoped.parseSetCookieHeader('d=4; Path=/', 'https://example.org/');

      expect(scoped.clear('com.', 'domain')).toBe(0);
      expect(scoped.clear('com', 'domain')).toBe(3);
      expect(scoped.getStoredDomains()).toEqual([
        { domain: 'example.org', count: 1 },
      ]);
    });

    test('clear(host, domain) on a removed suffix beneath another removed one clears only what is under it', () => {
      const scoped = new CookieJar({
        publicSuffixes: { remove: ['uk', 'co.uk'] },
      });

      scoped.parseSetCookieHeader('x=host; Path=/', 'https://x.co.uk/');
      scoped.parseSetCookieHeader('y=host; Path=/', 'https://y.org.uk/');
      scoped.parseSetCookieHeader(
        'shared=uk; Domain=uk; Path=/',
        'https://x.co.uk/',
      );

      expect(scoped.clear('co.uk', 'domain')).toBe(1);
      expect(
        scoped
          .getStoredDomains()
          .map((entry) => entry.domain)
          .sort(),
      ).toEqual(['uk', 'y.org.uk']);
    });

    test('clear(host, domain) for the site a removal joined leaves a site behind a suffix still listed', () => {
      // With `com` removed, every host directly under `com` belongs to the `com` site, but
      // `blogspot.com` is still a suffix, so `app.blogspot.com` is a site of its own.
      const scoped = new CookieJar({ publicSuffixes: { remove: ['com'] } });

      scoped.parseSetCookieHeader('a=1; Path=/', 'https://x.example.com/');
      scoped.parseSetCookieHeader(
        'b=2; Domain=example.com; Path=/',
        'https://x.example.com/',
      );
      scoped.parseSetCookieHeader(
        'c=3; Domain=com; Path=/',
        'https://x.example.com/',
      );
      scoped.parseSetCookieHeader('d=4; Path=/', 'https://app.blogspot.com/');

      expect(scoped.clear('x.example.com', 'domain')).toBe(3);
      expect(scoped.getStoredDomains()).toEqual([
        { domain: 'app.blogspot.com', count: 1 },
      ]);
    });

    test('clear(host, domain) under a removed suffix leaves a site behind a nested suffix', () => {
      // With `cn` removed, `com.cn` is still a suffix, so `amazonaws.com.cn` is a site
      // of its own - and `s3.cn-north-1.amazonaws.com.cn` a suffix beneath it, whose
      // tenants are sites of their own again.
      const scoped = new CookieJar({ publicSuffixes: { remove: ['cn'] } });

      scoped.parseSetCookieHeader(
        'a=1; Path=/',
        'https://www.amazonaws.com.cn/',
      );
      scoped.parseSetCookieHeader(
        'b=2; Path=/',
        'https://bucket.s3.cn-north-1.amazonaws.com.cn/',
      );
      scoped.parseSetCookieHeader('c=3; Path=/', 'https://other.com.cn/');

      expect(scoped.clear('amazonaws.com.cn', 'domain')).toBe(1);
      expect(
        scoped
          .getStoredDomains()
          .map((entry) => entry.domain)
          .sort(),
      ).toEqual(['bucket.s3.cn-north-1.amazonaws.com.cn', 'other.com.cn']);
    });

    test('clear(host, domain) under a single removed suffix clears every site it joined', () => {
      // With `herokuapp.com` removed, it is the registrable domain of every host under
      // it, so `mine.herokuapp.com` and `other.herokuapp.com` are one site.
      const scoped = new CookieJar({
        publicSuffixes: { remove: ['herokuapp.com'] },
      });

      scoped.parseSetCookieHeader('a=1; Path=/', 'https://mine.herokuapp.com/');
      scoped.parseSetCookieHeader(
        'b=2; Path=/',
        'https://other.herokuapp.com/',
      );
      scoped.parseSetCookieHeader(
        'shared=heroku; Domain=herokuapp.com; Path=/',
        'https://mine.herokuapp.com/',
      );
      scoped.parseSetCookieHeader('c=3; Path=/', 'https://example.com/');

      expect(scoped.clear('mine.herokuapp.com', 'domain')).toBe(3);
      expect(scoped.getStoredDomains()).toEqual([
        { domain: 'example.com', count: 1 },
      ]);
    });

    test('clear(host, domain) with co.uk removed clears every co.uk site', () => {
      const scoped = new CookieJar({ publicSuffixes: { remove: ['co.uk'] } });

      scoped.parseSetCookieHeader('x=1; Path=/', 'https://www.x.co.uk/');
      scoped.parseSetCookieHeader('y=2; Path=/', 'https://y.co.uk/');
      scoped.parseSetCookieHeader(
        'shared=couk; Domain=co.uk; Path=/',
        'https://y.co.uk/',
      );
      scoped.parseSetCookieHeader('z=3; Path=/', 'https://z.org.uk/');

      expect(scoped.clear('x.co.uk', 'domain')).toBe(3);
      expect(scoped.getStoredDomains()).toEqual([
        { domain: 'z.org.uk', count: 1 },
      ]);
    });

    test('clear(host, ...) no-ops when host has no cookies', () => {
      expect(() => jar.clear('example.com', 'hostname')).not.toThrow();
      expect(() => jar.clear('example.com', 'domain')).not.toThrow();
    });
  });

  describe('toJSON / fromJSON', () => {
    test('round-trips cookies through serialization', () => {
      jar.setCookie({
        name: 'session',
        value: 'abc',
        domain: 'example.com',
        path: '/',
        createdAt: Date.now(),
      });

      const data = jar.toJSON();
      const jar2 = new CookieJar();
      jar2.fromJSON(data);

      expect(jar2.getCookieFor('session', 'https://example.com')?.value).toBe(
        'abc',
      );
    });

    test('normalizes a leading-dot domain restored from another jar', () => {
      const restored = jar.fromJSON({
        cookies: [
          {
            name: 'session',
            value: 'abc',
            domain: '.example.com',
            path: '/',
            createdAt: Date.now(),
          },
        ],
      });

      expect(restored).toBe(1);
      expect(jar.getAllCookies()[0]?.domain).toBe('example.com');
      expect(jar.getCookieFor('session', 'https://example.com')?.value).toBe(
        'abc',
      );
      expect(
        jar.getCookieFor('session', 'https://api.example.com')?.value,
      ).toBe('abc');
    });

    test('restores leading-dot local and IPv6 domains in canonical form', () => {
      const restored = jar.fromJSON({
        cookies: [
          {
            name: 'local',
            value: 'one',
            domain: '.localhost',
            path: '/',
            createdAt: Date.now(),
          },
          {
            name: 'ip',
            value: 'two',
            domain: '.[::1]',
            path: '/',
            createdAt: Date.now(),
          },
        ],
      });

      expect(restored).toBe(2);
      expect(jar.getCookieFor('local', 'http://localhost')?.value).toBe('one');
      expect(jar.getCookieFor('ip', 'http://[::1]')?.value).toBe('two');
    });

    test('returns how many cookies were restored, so a short restore is visible', () => {
      // `setCookie` refuses a cookie with a missing or invalid domain and says so by
      // returning `false`; `fromJSON` counts those answers, so a persisted jar that comes
      // back short says so.
      const jar2 = new CookieJar();

      const restored = jar2.fromJSON({
        cookies: [
          {
            name: 'good',
            value: '1',
            domain: 'example.com',
            path: '/',
            createdAt: Date.now(),
          },
          {
            name: 'bad',
            value: '2',
            domain: '',
            path: '/',
            createdAt: Date.now(),
          },
          {
            name: 'also-good',
            value: '3',
            domain: 'example.com',
            path: '/',
            createdAt: Date.now(),
          },
        ],
      });

      expect(restored).toBe(2);
      expect(jar2.getCookieFor('good', 'https://example.com')?.value).toBe('1');
      expect(jar2.getCookieFor('bad', 'https://example.com')).toBeUndefined();
    });

    test('leaves the jar as it was when the payload is unusable', () => {
      // `fromJSON` cleared first and validated as it went, so a bad payload emptied the
      // jar and then threw - a failed restore that also lost what was there.
      jar.setCookie({
        name: 'keep',
        value: 'me',
        domain: 'example.com',
        path: '/',
        createdAt: Date.now(),
      });

      expect(() =>
        jar.fromJSON({} as unknown as Parameters<CookieJar['fromJSON']>[0]),
      ).toThrow(TypeError);
      expect(() =>
        jar.fromJSON({
          cookies: [null],
        } as unknown as Parameters<CookieJar['fromJSON']>[0]),
      ).toThrow(TypeError);

      expect(jar.getCookieFor('keep', 'https://example.com')?.value).toBe('me');
    });

    test("does not write into the caller's cookies", () => {
      // A frozen cookie, or one the caller keeps: `expires` was re-hydrated in place.
      const raw = Object.freeze({
        name: 'frozen',
        value: 'x',
        domain: 'example.com',
        path: '/',
        expires: new Date(Date.now() + 10_000).toISOString(),
        createdAt: Date.now(),
      });

      const restored = jar.fromJSON({
        cookies: [raw],
      } as unknown as Parameters<CookieJar['fromJSON']>[0]);

      expect(restored).toBe(1);
      expect(typeof raw.expires).toBe('string');
      expect(
        jar.getCookieFor('frozen', 'https://example.com')?.expires,
      ).toBeInstanceOf(Date);
    });

    test('returns zero for an empty payload', () => {
      expect(new CookieJar().fromJSON({ cookies: [] })).toBe(0);
    });

    test('refuses a cookie whose expires cannot be read as a date', () => {
      // `new Date('garbage')` is an `Invalid Date`: truthy, with a `getTime()` of `NaN`.
      // `isExpired` compared `now > NaN`, found it never true, and the cookie was sent
      // for the life of the jar and never purged - one corrupt date in a persisted jar
      // made an immortal cookie.
      const base = {
        value: 'x',
        domain: 'example.com',
        path: '/',
        createdAt: Date.now(),
      };

      const restored = jar.fromJSON({
        cookies: [
          { ...base, name: 'garbage', expires: 'not-a-date' },
          { ...base, name: 'invalid-date', expires: new Date('nope') },
          { ...base, name: 'kept', expires: new Date(Date.now() + 10_000) },
        ],
      } as unknown as Parameters<CookieJar['fromJSON']>[0]);

      expect(restored).toBe(1);
      expect(
        jar.getCookieFor('garbage', 'https://example.com'),
      ).toBeUndefined();
      expect(
        jar.getCookieFor('invalid-date', 'https://example.com'),
      ).toBeUndefined();
      expect(jar.getCookieFor('kept', 'https://example.com')?.value).toBe('x');
      expect(jar.clearExpiredCookies()).toBe(0);
    });

    test('refuses a cookie whose maxAge or createdAt is not a finite number', () => {
      // The other half of the expiry model. `isExpired` prefers `maxAge` and computes
      // `createdAt + maxAge * 1000`; one non-numeric field made that `NaN`, `now > NaN`
      // was never true, and the cookie was immortal - a sound `expires` beside it did
      // not help, since `maxAge` is checked first.
      const base = {
        value: 'x',
        domain: 'example.com',
        path: '/',
        createdAt: Date.now(),
      };

      const restored = jar.fromJSON({
        cookies: [
          { ...base, name: 'string-max-age', maxAge: 'not-a-number' },
          { ...base, name: 'nan-max-age', maxAge: Number.NaN },
          {
            ...base,
            name: 'infinite-max-age',
            maxAge: Number.POSITIVE_INFINITY,
          },
          {
            ...base,
            name: 'string-created-at',
            maxAge: 60,
            createdAt: 'yesterday',
          },
          { ...base, name: 'object-created-at', maxAge: 60, createdAt: {} },
          // Refused before it is held to now: `Math.min` would read the string as its
          // number and the infinity as now.
          { ...base, name: 'numeric-string-created-at', createdAt: '5' },
          {
            ...base,
            name: 'infinite-created-at',
            createdAt: Number.POSITIVE_INFINITY,
          },
          {
            ...base,
            name: 'masked-expires',
            maxAge: 'nope',
            expires: new Date(Date.now() + 10_000),
          },
          { ...base, name: 'kept', maxAge: 60 },
        ],
      } as unknown as Parameters<CookieJar['fromJSON']>[0]);

      expect(restored).toBe(1);

      for (const name of [
        'string-max-age',
        'nan-max-age',
        'infinite-max-age',
        'string-created-at',
        'object-created-at',
        'numeric-string-created-at',
        'infinite-created-at',
        'masked-expires',
      ]) {
        expect(jar.getCookieFor(name, 'https://example.com')).toBeUndefined();
      }

      expect(jar.getCookieFor('kept', 'https://example.com')?.value).toBe('x');
      expect(jar.getAllCookies()).toHaveLength(1);
      expect(jar.clearExpiredCookies()).toBe(0);
    });

    test('reads a null maxAge or createdAt as absent', () => {
      const base = { value: 'x', domain: 'example.com', path: '/' };
      const before = Date.now();

      const restored = jar.fromJSON({
        cookies: [
          { ...base, name: 'null-max-age', maxAge: null, createdAt: before },
          { ...base, name: 'null-created-at', maxAge: 60, createdAt: null },
        ],
      } as unknown as Parameters<CookieJar['fromJSON']>[0]);

      expect(restored).toBe(2);

      const nullMaxAge = jar.getCookieFor(
        'null-max-age',
        'https://example.com',
      );
      expect(nullMaxAge).toBeDefined();
      expect('maxAge' in (nullMaxAge ?? {})).toBe(false);

      const nullCreatedAt = jar.getCookieFor(
        'null-created-at',
        'https://example.com',
      );
      expect(nullCreatedAt?.createdAt).toBeGreaterThanOrEqual(before);
      expect(jar.clearExpiredCookies()).toBe(0);
    });

    test('setCookie refuses a null createdAt, which only fromJSON reads as absent', () => {
      const base = { value: 'x', domain: 'example.com', path: '/' };
      jar.setCookie({ ...base, name: 'id', value: 'kept' });

      expect(
        jar.setCookie({ ...base, name: 'id', createdAt: null } as never),
      ).toBe(false);
      expect(jar.getCookieFor('id', 'https://example.com')?.value).toBe('kept');
    });

    test('reads a null or absent expires as no expiry and a number as epoch milliseconds', () => {
      // `JSON.stringify` writes `null` for an `Invalid Date`.
      const base = {
        value: 'x',
        domain: 'example.com',
        path: '/',
        createdAt: Date.now(),
      };
      const future = Date.now() + 60_000;

      const restored = jar.fromJSON({
        cookies: [
          { ...base, name: 'nulled', expires: null },
          { ...base, name: 'absent' },
          { ...base, name: 'epoch', expires: future },
          // 1970 is in the past, so this one is not restored rather than kept immortal.
          { ...base, name: 'zero', expires: 0 },
        ],
      } as unknown as Parameters<CookieJar['fromJSON']>[0]);

      expect(restored).toBe(3);

      const nulled = jar.getCookieFor('nulled', 'https://example.com');
      expect(nulled).toBeDefined();
      expect('expires' in (nulled ?? {})).toBe(false);
      expect(jar.getCookieFor('absent', 'https://example.com')).toBeDefined();
      expect(
        jar.getCookieFor('epoch', 'https://example.com')?.expires?.getTime(),
      ).toBe(future);
      expect(jar.getCookieFor('zero', 'https://example.com')).toBeUndefined();
    });

    test('re-hydrates Date objects from JSON strings', () => {
      const expires = new Date(Date.now() + 10_000);
      jar.setCookie({
        name: 'dated',
        value: 'x',
        domain: 'example.com',
        path: '/',
        expires,
        createdAt: Date.now(),
      });

      const data = jar.toJSON();
      // Simulate JSON round-trip (stringify → parse converts Date to string)
      const parsed = JSON.parse(JSON.stringify(data));
      const jar2 = new CookieJar();
      jar2.fromJSON(parsed);

      const cookie = jar2.getCookieFor('dated', 'https://example.com');
      expect(cookie?.expires).toBeInstanceOf(Date);
    });
  });

  describe('sharing across clients', () => {
    test('two jars are independent by default', () => {
      const jar2 = new CookieJar();
      jar.setCookie({
        name: 'x',
        value: '1',
        domain: 'example.com',
        path: '/',
        createdAt: Date.now(),
      });
      expect(jar2.getCookieFor('x', 'https://example.com')).toBeUndefined();
    });

    test('same jar instance shared reflects changes', () => {
      const shared = new CookieJar();
      shared.setCookie({
        name: 'auth',
        value: 'token',
        domain: 'example.com',
        path: '/',
        createdAt: Date.now(),
      });
      expect(shared.getCookieFor('auth', 'https://example.com')?.value).toBe(
        'token',
      );
    });
  });
});

test('expired secure cookies do not block insecure replacement', () => {
  const jar = new CookieJar();
  jar.parseSetCookieHeader(
    'session=secure; Secure; Max-Age=1; Path=/',
    'https://example.com/',
  );
  const clock = Date.now;
  Date.now = () => clock() + 2000;
  try {
    jar.parseSetCookieHeader('session=http; Path=/', 'http://example.com/');
    expect(jar.getCookieHeaderString('http://example.com/')).toBe(
      'session=http',
    );
  } finally {
    Date.now = clock;
  }
});

test('IPv6 domains use a shared canonical form for programmatic, header and restored cookies', () => {
  const jar = new CookieJar();
  expect(
    jar.setCookie({ name: 'a', value: '1', domain: '0:0:0:0:0:0:0:1' }),
  ).toBe(true);
  jar.parseSetCookieHeader('b=2; Domain=[::1]; Path=/', 'http://[::1]/');
  // An address names itself in `Domain=` only as the URL writes it, as browsers read it.
  jar.parseSetCookieHeader(
    'x=9; Domain=0:0:0:0:0:0:0:1; Path=/',
    'http://[::1]/',
  );
  expect(jar.getCookieHeaderString('http://[::1]/')).toBe('a=1; b=2');
  jar.fromJSON({
    cookies: [
      {
        name: 'c',
        value: '3',
        domain: '[0:0:0:0:0:0:0:1]',
        createdAt: Date.now(),
      },
    ],
  });
  expect(jar.getAllCookies().map((cookie) => cookie.domain)).toEqual(['::1']);
  expect(jar.getCookieHeaderString('http://[::1]/')).toBe('c=3');
});

test('nested private suffix tenants cannot set or delete parent-domain cookies', () => {
  const jar = new CookieJar();
  jar.parseSetCookieHeader(
    'session=trusted; Domain=amazonaws.com; Path=/',
    'https://www.amazonaws.com/',
  );
  for (const header of [
    'session=attacker; Domain=amazonaws.com; Path=/',
    'session=; Domain=amazonaws.com; Path=/; Max-Age=0',
  ]) {
    jar.parseSetCookieHeader(header, 'https://attacker.s3.amazonaws.com/');
    expect(jar.getCookieHeaderString('https://www.amazonaws.com/')).toBe(
      'session=trusted',
    );
  }
  jar.parseSetCookieHeader(
    'tenant=ok; Domain=attacker.s3.amazonaws.com; Path=/',
    'https://attacker.s3.amazonaws.com/',
  );
  expect(
    jar
      .getCookieHeaderString('https://sub.attacker.s3.amazonaws.com/')
      .split('; ')
      .sort(),
  ).toEqual(['session=trusted', 'tenant=ok']);
});

test.each(['gov.uk', 'com'])(
  'public suffix host %s can store host-only cookies',
  (host) => {
    const jar = new CookieJar();
    jar.parseSetCookieHeader('a=1; Path=/', `https://${host}/`);
    jar.parseSetCookieHeader(`b=2; Domain=${host}; Path=/`, `https://${host}/`);
    expect(jar.getCookieHeaderString(`https://${host}/`)).toBe('a=1; b=2');
    expect(jar.getCookieHeaderString(`https://child.${host}/`)).toBe('');
  },
);

test('unrelated suffix overrides do not widen exception-domain cookies', () => {
  const jar = new CookieJar({ publicSuffixes: { add: ['corp.internal'] } });
  jar.parseSetCookieHeader(
    'bad=x; Domain=kawasaki.jp; Path=/',
    'https://city.kawasaki.jp/',
  );
  expect(jar.getAllCookies()).toEqual([]);
  expect(jar.getCookieHeaderString('https://kawasaki.jp/')).toBe('');
  jar.parseSetCookieHeader(
    'good=x; Domain=city.kawasaki.jp; Path=/',
    'https://city.kawasaki.jp/',
  );
  expect(jar.getCookieHeaderString('https://www.city.kawasaki.jp/')).toBe(
    'good=x',
  );
});

test('sends parent-domain cookies below nested private suffixes without widening host-only cookies', () => {
  const jar = new CookieJar();
  jar.parseSetCookieHeader(
    'parent=yes; Domain=amazonaws.com; Path=/',
    'https://www.amazonaws.com/',
  );
  jar.parseSetCookieHeader('host=only; Path=/', 'https://amazonaws.com/');
  expect(jar.getCookieHeaderString('https://bucket.s3.amazonaws.com/')).toBe(
    'parent=yes',
  );
  expect(jar.getCookieHeaderString('https://unrelated.example/')).toBe('');
});

test.each([false, true])(
  'a Secure cookie is protected across nested suffix sites (isWide=%s)',
  (isWide) => {
    const jar = new CookieJar();
    jar.parseSetCookieHeader(
      isWide
        ? 'session=secure; Secure; Domain=amazonaws.com; Path=/'
        : 'session=secure; Secure; Path=/',
      isWide ? 'https://amazonaws.com/' : 'https://x.s3.amazonaws.com/',
    );
    jar.parseSetCookieHeader(
      isWide
        ? 'session=plain; Path=/'
        : 'session=plain; Domain=amazonaws.com; Path=/',
      isWide ? 'http://x.s3.amazonaws.com/' : 'http://amazonaws.com/',
    );
    expect(jar.getCookieHeaderString('https://x.s3.amazonaws.com/')).toBe(
      'session=secure',
    );
  },
);

describe('CookieJar - accepting and expiring cookies', () => {
  test('a cookie a header cannot carry is refused, so the host keeps its other cookies', () => {
    const jar = new CookieJar();
    expect(
      jar.setCookie({ name: 'pref', value: 'café→x', domain: '127.0.0.1' }),
    ).toBe(false);
    jar.setCookie({ name: 'session', value: 'abc', domain: '127.0.0.1' });

    expect(jar.getCookieHeaderString('http://127.0.0.1/')).toBe('session=abc');
  });

  test('a single-label host with an underscore keeps its cookies', () => {
    const jar = new CookieJar();
    jar.parseSetCookieHeader('a=1', 'http://my_service/');

    expect(jar.getCookieHeaderString('http://my_service/')).toBe('a=1');
  });

  test('Expires is read with the RFC 6265 cookie-date algorithm', () => {
    const jar = new CookieJar();
    const inAnHour = new Date(Date.now() + 3_600_000);
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const months = [
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
    ];
    const pad = (n: number) => String(n).padStart(2, '0');
    // asctime form, no zone: read as UTC.
    const asctime = `${days[inAnHour.getUTCDay()]} ${months[inAnHour.getUTCMonth()]} ${pad(inAnHour.getUTCDate())} ${pad(inAnHour.getUTCHours())}:${pad(inAnHour.getUTCMinutes())}:${pad(inAnHour.getUTCSeconds())} ${inAnHour.getUTCFullYear()}`;
    jar.parseSetCookieHeader(`a=1; Expires=${asctime}`, 'http://example.com/');
    const stored = jar.getAllCookies().find((cookie) => cookie.name === 'a');
    expect(stored?.expires?.getTime()).toBe(
      Math.floor(inAnHour.getTime() / 1000) * 1000,
    );

    // Not a cookie-date at all: the attribute is ignored, a session cookie stored.
    jar.parseSetCookieHeader('b=1; Expires=0', 'http://example.com/');
    expect(jar.getCookieHeaderString('http://example.com/')).toContain('b=1');

    // A two-digit year below 70 is 20xx.
    jar.parseSetCookieHeader(
      'c=1; Expires=Wed, 01 Jan 69 00:00:00 GMT',
      'http://example.com/',
    );
    expect(
      jar.getAllCookies().find((cookie) => cookie.name === 'c')?.expires,
    ).toBeDefined();
    expect(jar.getCookieHeaderString('http://example.com/')).toContain('c=1');
  });

  test('a cookie lifetime is capped at 400 days, and an oversized cookie is ignored', () => {
    const jar = new CookieJar();
    jar.parseSetCookieHeader('a=1; Max-Age=2000000000', 'http://example.com/');
    jar.parseSetCookieHeader(
      'b=1; Expires=Fri, 01 Jan 2100 00:00:00 GMT',
      'http://example.com/',
    );
    const cap = 400 * 24 * 60 * 60;
    const a = jar.getAllCookies().find((cookie) => cookie.name === 'a');
    const b = jar.getAllCookies().find((cookie) => cookie.name === 'b');
    expect(a?.maxAge).toBe(cap);
    expect(b?.expires?.getTime()).toBeLessThanOrEqual(Date.now() + cap * 1000);

    jar.parseSetCookieHeader(`big=${'x'.repeat(5000)}`, 'http://example.com/');
    expect(jar.getAllCookies().some((cookie) => cookie.name === 'big')).toBe(
      false,
    );
  });

  test('setCookie() and fromJSON() refuse a name and value past 4096 characters, as a Set-Cookie is refused', () => {
    const jar = new CookieJar();
    const cookie = (value: string) => ({
      name: 'big',
      value,
      domain: 'example.com',
      path: '/',
      createdAt: Date.now(),
    });

    expect(jar.setCookie(cookie('x'.repeat(4093)))).toBe(true);
    expect(jar.setCookie(cookie('x'.repeat(4094)))).toBe(false);
    expect(jar.getCookieHeaderString('http://example.com/')).toBe(
      `big=${'x'.repeat(4093)}`,
    );

    const restored = new CookieJar();
    expect(
      restored.fromJSON({
        cookies: [cookie('x'.repeat(4094)), { ...cookie('1'), name: 'ok' }],
      }),
    ).toBe(1);
    expect(restored.getCookieHeaderString('http://example.com/')).toBe('ok=1');
  });

  test('a domain cookie for a public suffix given to fromJSON() is the cookie a Set-Cookie from that host replaces and deletes', () => {
    // Saved by a jar that did not list `corp.internal`, restored into one that does.
    const jar = new CookieJar({ publicSuffixes: { add: ['corp.internal'] } });
    const restored = jar.fromJSON({
      cookies: [
        {
          name: 'session',
          value: 'old',
          domain: 'corp.internal',
          path: '/',
          hostOnly: false,
          createdAt: Date.now() - 1000,
        },
      ],
    });

    expect(restored).toBe(1);
    expect(jar.getAllCookies()[0]?.hostOnly).toBe(true);

    jar.parseSetCookieHeader(
      'session=new; Domain=corp.internal; Path=/',
      'https://corp.internal/',
    );
    expect(jar.getCookieHeaderString('https://corp.internal/')).toBe(
      'session=new',
    );

    jar.parseSetCookieHeader(
      'session=; Domain=corp.internal; Path=/; Max-Age=0',
      'https://corp.internal/',
    );
    expect(jar.getCookieHeaderString('https://corp.internal/')).toBe('');
    expect(jar.getAllCookies()).toEqual([]);
  });

  test('an already-expired cookie given to setCookie() deletes its stored twin, as an expired Set-Cookie does, and fromJSON() leaves one out of its count', () => {
    const jar = new CookieJar();
    const cookie = (fields: Partial<Cookie>): Cookie => ({
      name: 'a',
      value: '1',
      domain: 'example.com',
      path: '/',
      createdAt: Date.now(),
      ...fields,
    });

    expect(jar.setCookie(cookie({}))).toBe(true);
    expect(jar.setCookie(cookie({ maxAge: 0 }))).toBe(false);
    expect(jar.getAllCookies()).toEqual([]);
    expect(jar.getStoredDomains()).toEqual([]);

    expect(jar.setCookie(cookie({}))).toBe(true);
    expect(
      jar.setCookie(cookie({ expires: new Date(Date.now() - 1000) })),
    ).toBe(false);
    expect(jar.getAllCookies()).toEqual([]);

    // Counted out of what `fromJSON` restored, so a caller comparing the count with
    // `data.cookies.length` sees the loss.
    expect(
      jar.fromJSON({
        cookies: [
          cookie({ name: 'gone', maxAge: 1, createdAt: Date.now() - 5000 }),
          cookie({ name: 'kept' }),
        ],
      }),
    ).toBe(1);
    expect(jar.getAllCookies().map((c) => c.name)).toEqual(['kept']);
  });

  test('a cookie name with a space or tab inside it is kept, as RFC 6265bis keeps it', () => {
    const jar = new CookieJar();
    jar.parseSetCookieHeader('my cookie=1', 'https://example.com/');
    jar.parseSetCookieHeader('tab\tname=2', 'https://example.com/');

    expect(
      jar.setCookie({
        name: 'set by hand',
        value: '3',
        domain: 'example.com',
        hostOnly: true,
        path: '/',
      }),
    ).toBe(true);
    expect(jar.getCookieHeaderString('https://example.com/')).toBe(
      'my cookie=1; tab\tname=2; set by hand=3',
    );
  });

  test('fromJSON() counts the cookies the jar holds once restored, not each entry it stored', () => {
    const jar = new CookieJar();
    const cookie = (
      name: string,
      value: string,
      fields: Partial<Cookie> = {},
    ) => ({
      name,
      value,
      domain: 'example.com',
      path: '/',
      createdAt: Date.now(),
      ...fields,
    });

    // `a` is replaced and then deleted by an expired entry of the same identity; the
    // second `b` replaces the first.
    expect(
      jar.fromJSON({
        cookies: [
          cookie('a', '1'),
          cookie('a', '2', { maxAge: -1 }),
          cookie('b', '1'),
          cookie('b', '2'),
        ],
      }),
    ).toBe(1);
    expect(jar.getAllCookies().map((c) => [c.name, c.value])).toEqual([
      ['b', '2'],
    ]);
  });

  test('a leading full stop that maps to a dot is refused, as only a written leading dot is dropped', () => {
    const jar = new CookieJar();
    const cookie = (domain: string) => ({
      name: 'a',
      value: '1',
      domain,
      path: '/',
    });

    for (const stop of ['\u3002', '\uFF0E', '\uFF61']) {
      expect(jar.setCookie(cookie(`${stop}example.com`))).toBe(false);
    }

    expect(jar.setCookie(cookie('.example.com'))).toBe(true);
    // Between labels and at the end a mapped full stop is a dot, as the URL parser maps it.
    expect(jar.setCookie(cookie('example\u3002com'))).toBe(true);
    expect(jar.getStoredDomains()).toEqual([
      { domain: 'example.com', count: 1 },
    ]);
  });

  test('setCookie() and fromJSON() refuse a path that is not a string, rather than widening it to /', () => {
    const jar = new CookieJar();
    const cookie = (path: unknown) =>
      ({
        name: 'admin',
        value: '1',
        domain: 'example.com',
        path,
        createdAt: Date.now(),
      }) as Cookie;

    for (const path of [42, true, {}, ['/']]) {
      expect(jar.setCookie(cookie(path))).toBe(false);
    }

    expect(jar.getAllCookies()).toEqual([]);

    // `fromJSON` reads a `null` one as absent, the default path.
    expect(
      jar.fromJSON({
        cookies: [cookie(42), { ...cookie(null), name: 'kept' }],
      }),
    ).toBe(1);
    expect(jar.getAllCookies().map((c) => [c.name, c.path])).toEqual([
      ['kept', '/'],
    ]);
  });

  test('setCookie() and fromJSON() refuse a sameSite a Set-Cookie cannot store', () => {
    const jar = new CookieJar();
    const cookie = (sameSite: unknown) =>
      ({
        name: 'a',
        value: '1',
        domain: 'example.com',
        path: '/',
        createdAt: Date.now(),
        sameSite,
      }) as Cookie;

    for (const sameSite of ['bogus', 'lax', '', null, 1]) {
      expect(jar.setCookie(cookie(sameSite))).toBe(false);
    }

    // `fromJSON` reads a `null` one as absent, as it reads a `null` flag.
    expect(
      jar.fromJSON({
        cookies: [
          cookie('bogus'),
          cookie('Lax'),
          { ...cookie(null), name: 'b' },
        ],
      }),
    ).toBe(2);
    expect(
      jar.getAllCookies().map((c) => [c.name, 'sameSite' in c, c.sameSite]),
    ).toEqual([
      ['a', true, 'Lax'],
      ['b', false, undefined],
    ]);
  });

  test('setCookie() stores the cookie fields alone, not the rest of the object it is given', () => {
    const jar = new CookieJar();
    const extra = { big: 'x'.repeat(1000) };

    expect(
      jar.setCookie({
        name: 'a',
        value: '1',
        domain: 'example.com',
        path: '/',
        createdAt: Date.now(),
        httpOnly: true,
        extra,
      } as Cookie),
    ).toBe(true);

    const [stored] = jar.getAllCookies();
    expect(stored).toBeDefined();
    expect(Object.keys(stored ?? {}).sort()).toEqual([
      'createdAt',
      'domain',
      'httpOnly',
      'name',
      'path',
      'value',
    ]);
  });
});

test('a host with a hyphen at a label edge keeps its cookies', () => {
  const jar = new CookieJar();
  jar.parseSetCookieHeader('sid=abc; Path=/', 'http://-edge.example.com/');
  jar.parseSetCookieHeader('a=1', 'http://edge-.internal/');

  expect(jar.getCookieHeaderString('http://-edge.example.com/')).toBe(
    'sid=abc',
  );
  expect(jar.getCookieHeaderString('http://edge-.internal/')).toBe('a=1');
});

test('an edge-hyphen host keeps its Domain cookies and is cleared with its domain', () => {
  const jar = new CookieJar();
  jar.parseSetCookieHeader(
    'edge=1; Domain=example.com',
    'https://-edge.example.com/',
  );
  jar.parseSetCookieHeader('a=1', 'https://-edge.example.com/');

  expect(jar.getCookieHeaderString('https://www.example.com/')).toBe('edge=1');

  jar.clear('example.com', 'domain');
  expect(jar.getAllCookies()).toEqual([]);
});

test('an edge-hyphen host whose stand-in would read as a public suffix still gets its real site', () => {
  const jar = new CookieJar();
  jar.parseSetCookieHeader('t=1; Domain=prgmr.com', 'https://a.-en.prgmr.com/');

  expect(jar.getCookieHeaderString('https://www.prgmr.com/')).toBe('t=1');
});

// RFC 6265bis §5.1.2 canonicalizes a request host without removing a trailing dot (the
// URL parser keeps it), and §5.1.3 domain-matches strings as they are: `example.com.` is
// a different host from `example.com`, as browsers treat it.
describe('a trailing dot is part of the host', () => {
  test('a host-only cookie is not sent to the other form of its host', () => {
    const jar = new CookieJar();

    jar.parseSetCookieHeader('b=2', 'https://www.example.com/');
    jar.parseSetCookieHeader('c=3', 'https://www.example.com./');

    expect(jar.getCookieHeaderString('https://www.example.com/')).toBe('b=2');
    expect(jar.getCookieHeaderString('https://WWW.EXAMPLE.COM./')).toBe('c=3');
  });

  test('a domain cookie is not sent to trailing-dot hosts under it, nor the reverse', () => {
    const jar = new CookieJar();

    jar.parseSetCookieHeader(
      'plain=1; Domain=example.com',
      'https://www.example.com/',
    );
    jar.parseSetCookieHeader(
      'dotted=1; Domain=example.com.',
      'https://www.example.com./',
    );

    expect(jar.getCookieHeaderString('https://a.example.com/')).toBe('plain=1');
    expect(jar.getCookieHeaderString('https://example.com/')).toBe('plain=1');
    expect(jar.getCookieHeaderString('https://a.example.com./')).toBe(
      'dotted=1',
    );
    expect(jar.getCookieHeaderString('https://example.com./')).toBe('dotted=1');
    expect(jar.getStoredDomains()).toEqual([
      { domain: 'example.com', count: 1 },
      { domain: 'example.com.', count: 1 },
    ]);
  });

  test('a Domain attribute must be a suffix of the request host as written', () => {
    const jar = new CookieJar();

    // `www.example.com.` does not end in `.example.com`, and `www.example.com` does not
    // end in `.example.com.`: neither domain-matches, so both cookies are ignored.
    jar.parseSetCookieHeader(
      'a=1; Domain=example.com',
      'https://www.example.com./',
    );
    jar.parseSetCookieHeader(
      'b=1; Domain=example.com.',
      'https://www.example.com/',
    );

    expect(jar.getAllCookies()).toEqual([]);

    // A `Max-Age=0` from the other form deletes nothing.
    jar.parseSetCookieHeader('sid=1', 'https://example.com/');
    jar.parseSetCookieHeader('sid=; Max-Age=0', 'https://example.com./');

    expect(jar.getCookieHeaderString('https://example.com/')).toBe('sid=1');
  });

  test('a trailing-dot public suffix is still refused, and kept host-only for itself', () => {
    const jar = new CookieJar({ publicSuffixes: { add: ['corp.internal'] } });

    for (const [header, url] of [
      ['a=1; Domain=com.', 'https://www.example.com./'],
      ['a=1; Domain=co.uk.', 'https://www.example.co.uk./'],
      ['a=1; Domain=github.io.', 'https://evil.github.io./'],
      ['a=1; Domain=corp.internal.', 'https://evil.corp.internal./'],
      ['a=1; Domain=localhost.', 'http://evil.localhost./'],
    ]) {
      jar.parseSetCookieHeader(header, url);
    }

    expect(jar.getAllCookies()).toEqual([]);

    // Naming the request host itself is accepted host-only (RFC 6265bis §5.7), for that
    // host alone.
    jar.parseSetCookieHeader('own=1; Domain=localhost.', 'http://localhost./');
    jar.parseSetCookieHeader(
      'own=2; Domain=corp.internal.',
      'https://corp.internal./',
    );

    expect(jar.getAllCookies().map((cookie) => cookie.hostOnly)).toEqual([
      true,
      true,
    ]);
    expect(jar.getCookieHeaderString('http://localhost./')).toBe('own=1');
    expect(jar.getCookieHeaderString('http://localhost/')).toBe('');
    expect(jar.getCookieHeaderString('http://a.localhost./')).toBe('');
    expect(jar.getCookieHeaderString('https://corp.internal./')).toBe('own=2');
    expect(jar.getCookieHeaderString('https://corp.internal/')).toBe('');
    expect(jar.getCookieHeaderString('https://a.corp.internal./')).toBe('');
  });

  test('an IPv4 address with a trailing dot is no stored domain', () => {
    const jar = new CookieJar();

    // The URL parser reads `127.0.0.1.` as the address, so its cookies are the address's.
    jar.parseSetCookieHeader('host=1', 'http://127.0.0.1./');
    // An IPv4 address with a trailing dot is refused as a domain before any comparison.
    jar.parseSetCookieHeader('attr=1; Domain=127.0.0.1.', 'http://127.0.0.1/');

    expect(jar.getCookieHeaderString('http://127.0.0.1/')).toBe('host=1');
    expect(
      jar.setCookie({ name: 'set', value: '1', domain: '127.0.0.1.' }),
    ).toBe(false);
    expect(jar.getStoredDomains()).toEqual([{ domain: '127.0.0.1', count: 1 }]);
  });

  test('setCookie, fromJSON and clear keep the two forms apart', () => {
    const jar = new CookieJar();

    expect(
      jar.fromJSON({
        cookies: [
          { name: 'plain', value: '1', domain: 'example.com', createdAt: 1 },
          { name: 'dotted', value: '1', domain: 'example.com.', createdAt: 1 },
          {
            name: 'host',
            value: '1',
            domain: 'www.example.com.',
            hostOnly: true,
            createdAt: 1,
          },
        ],
      }),
    ).toBe(3);
    expect(
      jar.setCookie({ name: 'two', value: '1', domain: 'example.com..' }),
    ).toBe(false);
    expect(
      jar.setCookie({ name: 'local', value: '1', domain: 'localhost.' }),
    ).toBe(true);

    expect(jar.getCookieHeaderString('https://www.example.com/')).toBe(
      'plain=1',
    );
    expect(jar.getCookieHeaderString('https://www.example.com./')).toBe(
      'dotted=1; host=1',
    );
    expect(jar.getCookieHeaderString('http://localhost/')).toBe('');
    expect(jar.getCookieHeaderString('http://localhost./')).toBe('local=1');

    expect(jar.clear('www.example.com', 'hostname')).toBe(0);
    expect(jar.clear('www.example.com.', 'hostname')).toBe(1);
    expect(jar.clear('example.com', 'domain')).toBe(1);
    expect(jar.getCookieHeaderString('https://www.example.com./')).toBe(
      'dotted=1',
    );
    expect(jar.clear('example.com.', 'domain')).toBe(1);
    expect(jar.getStoredDomains()).toEqual([
      { domain: 'localhost.', count: 1 },
    ]);
  });

  test('a Secure cookie is left alone by its own host only', () => {
    const jar = new CookieJar();

    jar.parseSetCookieHeader('sid=secure; Secure', 'https://www.example.com./');
    // The same host over `http:` may not replace it (RFC 6265bis §5.7)...
    jar.parseSetCookieHeader('sid=plant', 'http://www.example.com./');
    // ...while the other form is another host, whose cookie is never sent beside it.
    jar.parseSetCookieHeader('sid=other', 'http://www.example.com/');

    expect(jar.getCookieHeaderString('https://www.example.com./')).toBe(
      'sid=secure',
    );
    expect(jar.getCookieHeaderString('http://www.example.com/')).toBe(
      'sid=other',
    );
  });
});

test('setCookie decides whether the cookie it replaces has expired at the time it stores', () => {
  const jar = new CookieJar();
  let clock = 1_000_000;
  const nowSpy = spyOn(Date, 'now').mockImplementation(() => clock);

  try {
    const url = 'https://example.com/';
    // `a` expires half a second after the replacement below is stored.
    jar.setCookie({
      name: 'a',
      value: '1',
      domain: 'example.com',
      path: '/',
      hostOnly: true,
      expires: new Date(1_000_700),
    });
    clock = 1_000_100;
    jar.setCookie({
      name: 'b',
      value: '1',
      domain: 'example.com',
      path: '/',
      hostOnly: true,
    });

    // A clock that moves a second on every read: a second read inside one `setCookie`
    // found the cookie it replaced already expired, and dropped its creation time.
    clock = 1_000_200;
    nowSpy.mockImplementation(() => {
      const now = clock;
      clock += 1000;
      return now;
    });
    jar.setCookie({
      name: 'a',
      value: '2',
      domain: 'example.com',
      path: '/',
      hostOnly: true,
    });

    // The replacement keeps `a`'s place, ahead of the later `b`.
    expect(jar.getCookieHeaderString(url)).toBe('a=2; b=1');
  } finally {
    nowSpy.mockRestore();
  }
});

test('a cookie past the 400-day cap is sent until the cap and purged there', () => {
  const capMS = 400 * 24 * 3600 * 1000;
  const start = Date.now();
  const jar = new CookieJar();
  const base = {
    value: '1',
    domain: 'example.com',
    path: '/',
    createdAt: start,
  };

  setSystemTime(new Date(start));
  jar.setCookie({ ...base, name: 'long', maxAge: 1e10 });
  // Too large to add to `createdAt` in milliseconds; capped, not unreadable.
  jar.setCookie({ ...base, name: 'huge', maxAge: 1e306 });
  jar.setCookie({
    ...base,
    name: 'dated',
    expires: new Date(start + 10 * 365 * 24 * 3600 * 1000),
  });

  setSystemTime(new Date(start + capMS - 1));
  expect(jar.getCookieHeaderString('https://example.com/')).toBe(
    'long=1; huge=1; dated=1',
  );
  expect(jar.clearExpiredCookies()).toBe(0);

  setSystemTime(new Date(start + capMS));
  expect(jar.getCookieHeaderString('https://example.com/')).toBe('');
  expect(jar.clearExpiredCookies()).toBe(3);
});

test('the 400-day cap reads a Date by its time, not a getTime it carries', () => {
  const jar = new CookieJar();
  const farFuture = new Date(Date.now() + 10 * 365 * 24 * 3600 * 1000);
  Object.defineProperty(farFuture, 'getTime', { value: () => 0 });
  jar.setCookie({
    name: 'a',
    value: '1',
    domain: 'example.com',
    path: '/',
    hostOnly: true,
    expires: farFuture,
  });

  const [stored] = jar.getAllCookies();
  const storedTime = stored?.expires
    ? Date.prototype.getTime.call(stored.expires)
    : Number.NaN;
  expect(storedTime).toBeLessThanOrEqual(Date.now() + 400 * 24 * 3600 * 1000);
});

test("a stored cookie's expiry is the jar's own Date, not the caller's", () => {
  const capMS = 400 * 24 * 3600 * 1000;

  // Through `setCookie`, and through `fromJSON`, which stores through it.
  for (const store of [
    (jar: CookieJar, expires: Date) =>
      jar.setCookie({
        name: 'a',
        value: '1',
        domain: 'example.com',
        path: '/',
        hostOnly: true,
        expires,
      }),
    (jar: CookieJar, expires: Date) =>
      jar.fromJSON({
        cookies: [
          {
            name: 'a',
            value: '1',
            domain: 'example.com',
            path: '/',
            hostOnly: true,
            createdAt: Date.now(),
            expires,
          },
        ],
      }),
  ]) {
    const jar = new CookieJar();
    const expires = new Date(Date.now() + 3600 * 1000);
    const expected = expires.getTime();
    store(jar, expires);

    // Within the cap, so stored as given - and then moved ten years on by the caller.
    expires.setFullYear(expires.getFullYear() + 10);

    const [stored] = jar.getAllCookies();
    expect(stored?.expires).not.toBe(expires);
    expect(stored?.expires?.getTime()).toBe(expected);
    expect(jar.toJSON().cookies[0]?.expires?.getTime()).toBeLessThanOrEqual(
      Date.now() + capMS,
    );
  }
});

test('fromJSON refuses an entry it cannot read and reads a Date by its time', () => {
  const jar = new CookieJar();
  jar.setCookie({ name: 'old', value: '1', domain: 'example.com', path: '/' });
  const cookie = {
    name: 'a',
    value: '1',
    domain: 'example.com',
    path: '/',
    hostOnly: true,
    createdAt: Date.now(),
  };

  // A getter that throws is a refused entry, not an error out of the restore.
  const unreadable = { ...cookie, name: 'bad' };
  Object.defineProperty(unreadable, 'value', {
    enumerable: true,
    get() {
      throw new RangeError('boom');
    },
  });
  expect(jar.fromJSON({ cookies: [cookie, unreadable] })).toBe(1);
  expect(jar.getAllCookies().map((c) => c.name)).toEqual(['a']);

  // An element that cannot be read is a payload that cannot be read: the jar is kept.
  const entries: unknown[] = [{ ...cookie, name: 'b' }];
  Object.defineProperty(entries, 1, {
    get() {
      throw new RangeError('boom');
    },
  });
  expect(() =>
    jar.fromJSON({ cookies: entries } as Parameters<CookieJar['fromJSON']>[0]),
  ).toThrow(TypeError);
  expect(jar.getAllCookies().map((c) => c.name)).toEqual(['a']);

  // A sound `Date` whose own `getTime` answers `NaN` is restored at its real time.
  const expires = new Date(Date.now() + 3600 * 1000);
  Object.defineProperty(expires, 'getTime', { value: () => Number.NaN });
  expect(jar.fromJSON({ cookies: [{ ...cookie, expires }] })).toBe(1);
  expect(jar.getAllCookies()[0]?.expires?.getTime()).toBe(
    Date.prototype.getTime.call(expires),
  );
  expect(jar.getCookieHeaderString('https://example.com/')).toBe('a=1');
});

test('fromJSON refuses a cookies array whose length cannot be read', () => {
  const jar = new CookieJar();
  jar.setCookie({ name: 'old', value: '1', domain: 'example.com', path: '/' });
  const cookies = new Proxy([], {
    get(target, key, receiver) {
      if (key === 'length') {
        throw new RangeError('boom');
      }

      return Reflect.get(target, key, receiver) as unknown;
    },
  });

  expect(() => jar.fromJSON({ cookies })).toThrow(TypeError);
  expect(jar.getAllCookies().map((c) => c.name)).toEqual(['old']);
});
