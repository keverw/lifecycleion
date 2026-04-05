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
  });

  describe('parseSetCookieHeader', () => {
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
