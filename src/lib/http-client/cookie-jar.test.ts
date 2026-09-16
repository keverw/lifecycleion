import { describe, test, expect, beforeEach } from 'bun:test';
import { CookieJar } from './cookie-jar';

describe('CookieJar', () => {
  let jar: CookieJar;

  beforeEach(() => {
    jar = new CookieJar();
  });

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
      expect(jar.getCookieFor('sid', 'http://[::1]/')).toBeDefined();
      expect(jar.getCookieFor('sid', 'http://[::1]/')?.value).toBe('x');
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
      expect(jar.setCookie({ ...base, name: 'sid', value: 'tab\there' })).toBe(
        false,
      );
      expect(jar.setCookie({ ...base, name: '', value: 'x' })).toBe(false);
      expect(jar.setCookie({ ...base, name: 'a=b', value: 'x' })).toBe(false);
      expect(jar.setCookie({ ...base, name: 'a;b', value: 'x' })).toBe(false);
      expect(jar.setCookie({ ...base, name: 'a b', value: 'x' })).toBe(false);
      expect(jar.setCookie({ ...base, name: 'a\nb', value: 'x' })).toBe(false);
      expect(
        jar.setCookie({
          ...base,
          name: 42 as unknown as string,
          value: 'x',
        }),
      ).toBe(false);

      expect(jar.getAllCookies()).toHaveLength(0);

      // What the header can carry: an empty value, and the characters RFC 6265 allows.
      expect(jar.setCookie({ ...base, name: 'empty', value: '' })).toBe(true);
      expect(
        jar.setCookie({ ...base, name: 'sid', value: 'a-b_c.d:e/f=g+h' }),
      ).toBe(true);
    });

    test('a stored cookie mutated into an unwritable value is withheld from the header', () => {
      // `getAllCookies()` hands out the stored objects. A value written onto one never
      // went through `setCookie`, and the header used to interpolate it as-is: two
      // pairs, or a CR LF. Withheld on the way out, as an expiry mutated to unreadable
      // already is.
      const base = { domain: 'example.com', path: '/' };

      expect(jar.setCookie({ ...base, name: 'ok', value: '1' })).toBe(true);
      expect(jar.setCookie({ ...base, name: 'sid', value: 'x' })).toBe(true);
      expect(jar.setCookie({ ...base, name: 'crlf', value: 'y' })).toBe(true);

      for (const cookie of jar.getAllCookies()) {
        if (cookie.name === 'sid') {
          cookie.value = 'x; other=evil';
        }

        if (cookie.name === 'crlf') {
          cookie.value = {
            toString: () => 'y\r\nX-Injected: 1',
          } as unknown as string;
        }
      }

      expect(jar.getCookieHeaderString('https://example.com/')).toBe('ok=1');
      expect(jar.getCookieFor('sid', 'https://example.com/')).toBeUndefined();
    });

    test('a stored cookie mutated to clear Secure is still withheld on http', () => {
      // `secure` used to be read live off the stored object at send time, so clearing it
      // after the cookie was stored for https sent a session cookie in the clear.
      jar.setCookie({
        name: 'sid',
        value: 'secret',
        domain: 'app.example.com',
        path: '/',
        secure: true,
      });

      for (const cookie of jar.getAllCookies()) {
        cookie.secure = false;
      }

      expect(jar.getCookieHeaderString('http://app.example.com/')).toBe('');
      expect(
        jar.getCookieFor('sid', 'http://app.example.com/'),
      ).toBeUndefined();

      // Still sent where it was stored to be sent.
      expect(jar.getCookieHeaderString('https://app.example.com/')).toBe(
        'sid=secret',
      );
    });

    test('a stored cookie mutated to widen its scope is withheld from the wider scope', () => {
      // Same live read, for the fields that decide *where* a cookie goes. Cookies are
      // bucketed by apex, so the reachable widening is within one registrable domain:
      // host-only for app.example.com, on /admin, mutated into a /-wide cookie for
      // every example.com host.
      jar.setCookie({
        name: 'sid',
        value: 'secret',
        domain: 'app.example.com',
        hostOnly: true,
        path: '/admin',
      });

      for (const cookie of jar.getAllCookies()) {
        cookie.hostOnly = false;
        cookie.domain = 'example.com';
        cookie.path = '/';
      }

      expect(jar.getCookieHeaderString('https://other.example.com/')).toBe('');
      expect(jar.getCookieHeaderString('https://app.example.com/public')).toBe(
        '',
      );
      expect(
        jar.getCookieFor('sid', 'https://other.example.com/'),
      ).toBeUndefined();

      // The scope it was stored with is untouched.
      expect(jar.getCookieHeaderString('https://app.example.com/admin')).toBe(
        'sid=secret',
      );
    });

    test('a name or value getter cannot answer the check and the header differently', () => {
      // The check read `value`, then the header read it again. A getter answering a safe
      // string first and `x; other=evil` next passed the check and put a second pair on
      // the wire. Each field is read once now and the header is built from that read, so
      // the second answer is never asked for: what was vetted is what goes out, and the
      // header stays one pair per cookie.
      const base = { domain: 'example.com', path: '/' };

      expect(jar.setCookie({ ...base, name: 'ok', value: '1' })).toBe(true);
      expect(jar.setCookie({ ...base, name: 'sid', value: 'x' })).toBe(true);
      expect(jar.setCookie({ ...base, name: 'alt', value: 'y' })).toBe(true);

      for (const cookie of jar.getAllCookies()) {
        if (cookie.name === 'sid') {
          let reads = 0;

          Object.defineProperty(cookie, 'value', {
            get: () => (reads++ === 0 ? 'ok' : 'x; other=evil'),
          });
        }

        if (cookie.name === 'alt') {
          let reads = 0;

          Object.defineProperty(cookie, 'name', {
            get: () => (reads++ === 0 ? 'alt' : 'alt=1; other'),
          });
        }
      }

      const header = jar.getCookieHeaderString('https://example.com/');

      expect(header).not.toContain('other');
      expect(header.split('; ').sort()).toEqual(['alt=y', 'ok=1', 'sid=ok']);
    });

    test('a getter that throws withholds the cookie rather than throwing out', () => {
      // A stored field can be an accessor, and reading one can throw. Fails closed, the
      // way the expiry check does, instead of taking down every other cookie's header.
      const base = { domain: 'example.com', path: '/' };

      expect(jar.setCookie({ ...base, name: 'ok', value: '1' })).toBe(true);
      expect(jar.setCookie({ ...base, name: 'boom', value: 'x' })).toBe(true);

      for (const cookie of jar.getAllCookies()) {
        if (cookie.name === 'boom') {
          Object.defineProperty(cookie, 'value', {
            get: () => {
              throw new Error('nope');
            },
          });
        }
      }

      expect(jar.getCookieHeaderString('https://example.com/')).toBe('ok=1');
      expect(jar.getCookieFor('boom', 'https://example.com/')).toBeUndefined();
      expect(jar.getCookiesFor('https://example.com/')).toHaveLength(1);
    });

    test('getCookiesFor returns copies, so writing to one does not change the jar', () => {
      jar.setCookie({
        name: 'sid',
        value: 'secret',
        domain: 'example.com',
        path: '/',
      });

      const [cookie] = jar.getCookiesFor('https://example.com/');
      cookie.value = 'tampered';

      expect(jar.getCookieHeaderString('https://example.com/')).toBe(
        'sid=secret',
      );
      expect(jar.getAllCookies()[0].value).toBe('secret');
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
      // Use a fixed RFC date string to avoid timing sensitivity
      jar.parseSetCookieHeader(
        'session=abc; Expires=Thu, 01 Jan 2099 00:00:00 GMT',
        'https://example.com',
      );
      const cookie = jar.getCookieFor('session', 'https://example.com');
      expect(cookie?.expires).toBeInstanceOf(Date);
      expect(cookie?.expires?.getFullYear()).toBe(2099);
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
        'auth=token; SameSite=None',
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
        expires: new Date(Date.now() - 10_000),
        createdAt: Date.now(),
      });
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
      // separately (`apexFor('sub.localhost')` is `'sub.localhost'`, not `'localhost'`),
      // so it came back empty before this change too. The flag is what actually changed,
      // and `hostOnlyDomainMatches` is what it drives on the send path.
      expect(stored?.hostOnly).toBe(true);
    });

    test('a sibling cannot evict the cookie the host set for itself', () => {
      // The store-side half of the toss, and the one with teeth. `Max-Age=0` runs through
      // `deleteCookieByIdentity`, which keys on the *cookie's* domain, not the request
      // host - so before this change `evil.localhost` naming `Domain=localhost` landed on
      // exactly the identity `http://localhost/` had stored under and deleted it. Cheaper
      // than planting a cookie and just as damaging: log the victim out, or clear the
      // anti-CSRF token, from a sibling name anyone can take on a shared dev host. The
      // refusal now happens in the `Domain=` branch, above the expiry-driven deletions,
      // so the eviction never gets to run.
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
      // The spanning is real, not just bucket co-residency: the apex itself receives it.
      expect(jar.getCookieFor('session', 'https://app.localhost/')?.value).toBe(
        'mine',
      );
    });

    test('the same rule keeps a public-suffix cookie the host itself sets', () => {
      // `github.io` used to be refused outright even from `https://github.io/`. RFC
      // 6265bis keeps it host-only rather than dropping it.
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

    test('canonicalizes a trailing root dot for domain and host-only cookies', () => {
      const domainCookie = new CookieJar();

      domainCookie.parseSetCookieHeader(
        'session=domain; Domain=localhost; Path=/',
        'http://localhost./',
      );

      expect(
        domainCookie.getCookieFor('session', 'http://localhost/')?.value,
      ).toBe('domain');

      const hostOnlyCookie = new CookieJar();

      hostOnlyCookie.parseSetCookieHeader(
        'session=host; Path=/',
        'https://example.com./',
      );

      expect(
        hostOnlyCookie.getCookieFor('session', 'https://example.com/')?.value,
      ).toBe('host');
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
      [{ add: ['-corp.internal'] }, 'leading hyphen'],
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

    test('a wider-path cookie from http cannot shadow a path-scoped Secure cookie', () => {
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
      ).toEqual(['real']);
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

    test('the shadow check reads the stored scope, not a mutated live cookie', () => {
      jar.parseSetCookieHeader('session=real; Secure', 'https://example.com/');

      const [live] = jar.getAllCookies();

      if (live === undefined) {
        throw new Error('expected the Secure cookie to be stored');
      }

      delete live.secure;

      jar.parseSetCookieHeader('session=evil', 'http://example.com/');

      expect(jar.getAllCookies()).toHaveLength(1);
      expect(jar.getAllCookies()[0]?.value).toBe('real');
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
      // `fromJSON` stores through `setCookie`, and the shadow check reads the scope
      // `setCookie` recorded - so a persisted jar comes back with the same guard a live
      // one has, not as a set of plain objects an http hop can overwrite.
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

      jar.parseSetCookieHeader('__Host-id=4; Secure', 'https://example.com/');
      expect(jar.getCookieFor('__Host-id', 'https://example.com/')?.value).toBe(
        '4',
      );
      jar.parseSetCookieHeader('__Host-id=4b; Secure', 'https://example.com');
      expect(jar.getCookieFor('__Host-id', 'https://example.com/')?.value).toBe(
        '4b',
      );

      jar.parseSetCookieHeader(
        '__Host-id=refused; Secure',
        'https://example.com/app/page',
      );
      expect(
        jar.getCookieFor('__Host-id', 'https://example.com/app/page')?.value,
      ).toBe('4b');

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
      // `__Host-` cookie with `hostOnly` cleared used to be restored and sent to every
      // subdomain under a name that tells a server it was set host-only at `/`.
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
        expires: new Date(Date.now() - 60_000),
        createdAt: Date.now(),
      });
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
    test('apex bucket removed when last cookie expires and clearExpiredCookies runs', () => {
      jar.setCookie({
        name: 'a',
        value: '1',
        domain: 'example.com',
        path: '/',
        expires: new Date(Date.now() - 1000),
        createdAt: Date.now(),
      });
      expect(jar.getStoredDomains()).toHaveLength(1);
      jar.clearExpiredCookies();
      expect(jar.getStoredDomains()).toHaveLength(0);
    });

    test('apex bucket removed when Max-Age=0 deletes last cookie', () => {
      jar.parseSetCookieHeader('session=abc; Path=/', 'https://example.com');
      expect(jar.getStoredDomains()).toHaveLength(1);
      jar.parseSetCookieHeader(
        'session=; Max-Age=0; Path=/',
        'https://example.com',
      );
      expect(jar.getStoredDomains()).toHaveLength(0);
    });

    test('apex bucket remains when other cookies still exist', () => {
      jar.setCookie({
        name: 'a',
        value: '1',
        domain: 'example.com',
        path: '/',
        expires: new Date(Date.now() - 1000),
        createdAt: Date.now(),
      });
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
        expires: new Date(Date.now() - 1000),
        createdAt: Date.now(),
      });

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
    test('clear(host, hostname) matches the stored scope, not a mutated domain', () => {
      // The send path already anchors where a cookie goes on the scope it was filed
      // under, so a `domain` written through `getAllCookies()` cannot widen it. The clear
      // compared the live field: after the same mutation, `clear('app.example.com',
      // 'hostname')` missed the cookie while `getCookieHeaderString()` went on sending it
      // for app.example.com - a cookie you had cleared, still on the wire.
      jar.setCookie({
        name: 'sid',
        value: 'secret',
        domain: 'app.example.com',
        hostOnly: true,
        path: '/',
      });

      for (const cookie of jar.getAllCookies()) {
        cookie.hostOnly = false;
        cookie.domain = 'example.com';
      }

      expect(jar.getStoredDomains()).toEqual([
        { domain: 'app.example.com', count: 1 },
      ]);
      expect(jar.clear('example.com', 'hostname')).toBe(0);
      expect(jar.getCookieHeaderString('https://app.example.com/')).toBe(
        'sid=secret',
      );

      expect(jar.clear('app.example.com', 'hostname')).toBe(1);
      expect(jar.getCookieHeaderString('https://app.example.com/')).toBe('');
      expect(jar.getAllCookies()).toHaveLength(0);
    });

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

    test('clear(host, hostname) prunes apex bucket when last cookie removed', () => {
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

    test('clear(host, domain) removes all cookies for the apex and its subdomains', () => {
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

    test('clear(host, domain) accepts any hostname in the apex', () => {
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
      // returning `false`; `fromJSON` used to throw that answer away and return `void`, so
      // a persisted jar could come back short with nothing to say it had.
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
        'masked-expires',
      ]) {
        expect(jar.getCookieFor(name, 'https://example.com')).toBeUndefined();
      }

      expect(jar.getCookieFor('kept', 'https://example.com')?.value).toBe('x');
      expect(jar.getAllCookies()).toHaveLength(1);
      expect(jar.clearExpiredCookies()).toBe(0);
    });

    test('a stored cookie whose expiry turns unreadable is expired, not immortal', () => {
      // `setCookie` refuses an unreadable expiry, so the only way to a stored one is
      // through a reference the jar handed out. Belt and braces for the check itself:
      // `now > NaN` is never true, and the safe side to land on is expired - left out
      // of `getCookiesFor` and counted by `clearExpiredCookies`.
      const base = { value: 'x', domain: 'example.com', path: '/' };

      expect(jar.setCookie({ ...base, name: 'by-max-age', maxAge: 60 })).toBe(
        true,
      );
      expect(
        jar.setCookie({
          ...base,
          name: 'by-expires',
          expires: new Date(Date.now() + 10_000),
        }),
      ).toBe(true);
      expect(jar.setCookie({ ...base, name: 'sound', maxAge: 60 })).toBe(true);

      for (const cookie of jar.getAllCookies()) {
        if (cookie.name === 'by-max-age') {
          cookie.maxAge = Number.NaN;
        }

        if (cookie.name === 'by-expires') {
          cookie.expires = new Date('nope');
        }
      }

      const sent = jar.getCookiesFor('https://example.com').map((c) => c.name);

      expect(sent).toEqual(['sound']);
      expect(jar.clearExpiredCookies()).toBe(2);
      expect(jar.getAllCookies().map((c) => c.name)).toEqual(['sound']);
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

    test('reads a null or absent expires as no expiry and a number as epoch milliseconds', () => {
      // `JSON.stringify` writes `null` for an `Invalid Date`, and `0` was skipped by the
      // old truthiness check and left in the jar as a number typed as a `Date`.
      const base = {
        value: 'x',
        domain: 'example.com',
        path: '/',
        createdAt: Date.now(),
      };

      const restored = jar.fromJSON({
        cookies: [
          { ...base, name: 'nulled', expires: null },
          { ...base, name: 'absent' },
          { ...base, name: 'epoch', expires: 0 },
        ],
      } as unknown as Parameters<CookieJar['fromJSON']>[0]);

      expect(restored).toBe(3);

      const nulled = jar.getCookieFor('nulled', 'https://example.com');
      expect(nulled).toBeDefined();
      expect('expires' in (nulled ?? {})).toBe(false);
      expect(jar.getCookieFor('absent', 'https://example.com')).toBeDefined();
      // 1970 is in the past, so the cookie is expired rather than immortal.
      expect(jar.getCookieFor('epoch', 'https://example.com')).toBeUndefined();
      expect(jar.clearExpiredCookies()).toBe(1);
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
