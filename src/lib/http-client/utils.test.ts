import { afterEach, describe, expect, test } from 'bun:test';
import { CookieJar } from './cookie-jar';
import { HTTPClient } from './http-client';
import { MockAdapter } from './adapters/mock-adapter';
import {
  assertSupportedAdapterRuntimeAndConfig,
  buildURL,
  derivedRedirectFields,
  extractFetchHeaders,
  extractHostname,
  firstJoinedLocation,
  isBrowserEnvironment,
  matchesFilter,
  matchesFilterPhase,
  mergeHeaders,
  mergeObservedHeaders,
  normalizeAdapterResponseHeaders,
  parseContentType,
  resolveAbsoluteURL,
  resolveAbsoluteURLForRuntime,
  scalarHeader,
  reportedRedirectTarget,
  serializeBody,
  stripCrossOriginURLCredentials,
  stripURLCredentials,
  locationText,
} from './utils';
import { materializeRequestHeaders } from './internal/header-utils';
import { matchesHostPattern } from './test-helpers/host-pattern';

const originalXMLHttpRequest = (globalThis as Record<string, unknown>)
  .XMLHttpRequest;
const originalWindow = (globalThis as Record<string, unknown>).window;
const originalDocument = (globalThis as Record<string, unknown>).document;
const originalLocation = (globalThis as Record<string, unknown>).location;
const originalSelf = (globalThis as Record<string, unknown>).self;

afterEach(() => {
  if (originalXMLHttpRequest === undefined) {
    delete (globalThis as Record<string, unknown>).XMLHttpRequest;
  } else {
    (globalThis as Record<string, unknown>).XMLHttpRequest =
      originalXMLHttpRequest;
  }

  if (originalWindow === undefined) {
    delete (globalThis as Record<string, unknown>).window;
  } else {
    (globalThis as Record<string, unknown>).window = originalWindow;
  }

  if (originalDocument === undefined) {
    delete (globalThis as Record<string, unknown>).document;
  } else {
    (globalThis as Record<string, unknown>).document = originalDocument;
  }

  if (originalLocation === undefined) {
    delete (globalThis as Record<string, unknown>).location;
  } else {
    (globalThis as Record<string, unknown>).location = originalLocation;
  }

  if (originalSelf === undefined) {
    delete (globalThis as Record<string, unknown>).self;
  } else {
    (globalThis as Record<string, unknown>).self = originalSelf;
  }
});

describe('buildURL', () => {
  test('joins base and path', () => {
    expect(buildURL('https://example.com', '/users')).toBe(
      'https://example.com/users',
    );
  });

  test('prevents double slash when base ends with / and path starts with /', () => {
    expect(buildURL('https://example.com/', '/users')).toBe(
      'https://example.com/users',
    );
  });

  test('adds leading slash to path when missing', () => {
    expect(buildURL('https://example.com', 'users')).toBe(
      'https://example.com/users',
    );
  });

  test('uses path alone when base is undefined', () => {
    expect(buildURL(undefined, '/users')).toBe('/users');
  });

  test('appends query params', () => {
    expect(buildURL('https://example.com', '/search', { q: 'hello' })).toBe(
      'https://example.com/search?q=hello',
    );
  });

  test('merges query params when path already contains a query string', () => {
    expect(
      buildURL('https://example.com', '/search?existing=1', {
        added: '2',
      }),
    ).toBe('https://example.com/search?existing=1&added=2');
  });

  test('params override existing query keys when path already contains them', () => {
    expect(
      buildURL('https://example.com', '/search?existing=1&keep=yes', {
        existing: '2',
      }),
    ).toBe('https://example.com/search?keep=yes&existing=2');
  });

  test('preserves hash fragments while merging query params', () => {
    expect(
      buildURL('https://example.com', '/search?existing=1#section', {
        added: '2',
      }),
    ).toBe('https://example.com/search?existing=1&added=2#section');
  });

  test('handles nested query params via qs', () => {
    const url = buildURL('https://example.com', '/search', {
      filter: { status: 'active' },
    });
    expect(url).toContain('filter%5Bstatus%5D=active');
  });

  test('omits query string when params is empty', () => {
    expect(buildURL('https://example.com', '/users', {})).toBe(
      'https://example.com/users',
    );
  });

  test('does not join baseURL when path is an absolute http(s) URL', () => {
    expect(buildURL('https://api.example.com', 'https://other.com/api')).toBe(
      'https://other.com/api',
    );
  });

  test('does not join baseURL for protocol-relative path', () => {
    expect(buildURL('https://api.example.com', '//cdn.example.com/x')).toBe(
      '//cdn.example.com/x',
    );
  });

  test('appends params to absolute path without base join', () => {
    expect(
      buildURL('https://api.example.com', 'https://other.com/search', {
        q: 'hi',
      }),
    ).toBe('https://other.com/search?q=hi');
  });

  test('treats uppercase-scheme http(s) URL as absolute (no base join)', () => {
    expect(buildURL('https://api.example.com', 'HTTPS://Other.COM/api')).toBe(
      'https://other.com/api',
    );
  });

  test('non-http(s) schemes are still joined with base (ftp, etc.)', () => {
    expect(buildURL('https://api.example.com', 'ftp://files.test/x')).toBe(
      'https://api.example.com/ftp://files.test/x',
    );
  });
});

describe('buildURL + resolveAbsoluteURL (request pipeline)', () => {
  test('absolute https path is unchanged after resolveAbsoluteURL', () => {
    const base = 'https://api.corp.test';
    const path = 'https://cdn.other.test/assets/x';
    expect(resolveAbsoluteURL(buildURL(base, path), base)).toBe(
      'https://cdn.other.test/assets/x',
    );
  });

  test('protocol-relative path resolves against client baseURL', () => {
    const base = 'https://api.corp.test';
    const path = '//cdn.other.test/y';
    expect(resolveAbsoluteURL(buildURL(base, path), base)).toBe(
      'https://cdn.other.test/y',
    );
  });
});

describe('resolveAbsoluteURLForRuntime', () => {
  test('resolves a relative path against document.baseURI in browser runtimes', () => {
    (globalThis as Record<string, unknown>).window = {
      location: { href: 'https://app.test/shell/index.html' },
    };
    (globalThis as Record<string, unknown>).document = {
      baseURI: 'https://cdn.test/base/',
    };

    expect(resolveAbsoluteURLForRuntime('/api/users', undefined, true)).toBe(
      'https://cdn.test/api/users',
    );
  });

  test('resolves a protocol-relative path against window.location in browser runtimes', () => {
    (globalThis as Record<string, unknown>).window = {
      location: { href: 'https://app.test/shell/index.html' },
    };
    (globalThis as Record<string, unknown>).document = {};

    expect(
      resolveAbsoluteURLForRuntime('//cdn.test/assets/app.js', undefined, true),
    ).toBe('https://cdn.test/assets/app.js');
  });

  test('uses self.location when page globals are unavailable', () => {
    delete (globalThis as Record<string, unknown>).window;
    delete (globalThis as Record<string, unknown>).document;
    (globalThis as Record<string, unknown>).self = {
      location: { href: 'https://worker.test/worker.js' },
    };

    expect(resolveAbsoluteURLForRuntime('/api/users', undefined, true)).toBe(
      'https://worker.test/api/users',
    );
  });

  test('resolves a path-relative URL against the page as a document, as fetch does', () => {
    (globalThis as Record<string, unknown>).window = {};
    (globalThis as Record<string, unknown>).document = {
      baseURI: 'https://app.test/dir/page',
    };

    expect(resolveAbsoluteURLForRuntime('api/start', undefined, true)).toBe(
      'https://app.test/dir/api/start',
    );
    // A path the client has already joined to a relative baseURL (`buildURL`) resolves
    // against the page the same way.
    expect(resolveAbsoluteURLForRuntime('api/users', undefined, true)).toBe(
      'https://app.test/dir/api/users',
    );
    // An absolute baseURL keeps its directory rule, ahead of the page.
    expect(
      resolveAbsoluteURLForRuntime('users', 'https://x.test/api', true),
    ).toBe('https://x.test/api/users');
  });

  test('leaves relative paths unresolved on non-browser runtimes', () => {
    (globalThis as Record<string, unknown>).window = {
      location: { href: 'https://app.test/shell/index.html' },
    };
    (globalThis as Record<string, unknown>).document = {
      baseURI: 'https://cdn.test/base/',
    };

    expect(resolveAbsoluteURLForRuntime('/api/users', undefined, false)).toBe(
      '/api/users',
    );
  });
});

describe('resolveAbsoluteURL', () => {
  test('returns normalized href for absolute url', () => {
    expect(resolveAbsoluteURL('https://Example.Com/path')).toBe(
      'https://example.com/path',
    );
  });

  test('resolves path against baseURL', () => {
    expect(resolveAbsoluteURL('/api/x', 'https://host.test')).toBe(
      'https://host.test/api/x',
    );
  });

  test('resolves protocol-relative against baseURL', () => {
    expect(resolveAbsoluteURL('//other.test/p', 'https://host.test/')).toBe(
      'https://other.test/p',
    );
  });

  test('leaves path-only url unchanged when baseURL is missing', () => {
    expect(resolveAbsoluteURL('/only')).toBe('/only');
  });
});

describe('stripCrossOriginURLCredentials', () => {
  test('strips a protocol-relative target when the initial URL is unparseable', () => {
    expect(
      stripCrossOriginURLCredentials(
        '//user:secret@evil.test/collect',
        'not a URL',
      ),
    ).toBe('//evil.test/collect');
  });

  test('does not rewrite a credential-free protocol-relative target', () => {
    expect(
      stripCrossOriginURLCredentials('//cdn.test/a/../asset', 'not a URL'),
    ).toBe('//cdn.test/a/../asset');
  });
});

describe('URL userinfo removal', () => {
  test('a URL the parser refuses has the userinfo of its authority cut as written', () => {
    // A `Location` with a port out of range or a broken IPv6 literal is still recorded
    // in the redirect history and reported, so its credentials must not be.
    // The `@` is kept, so the host after it reads as before and is still refused.
    expect(stripURLCredentials('https://admin:secret@b.test:99999/x')).toBe(
      'https://@b.test:99999/x',
    );
    expect(stripURLCredentials('https://a:b@c@[bad/x?q=1#f')).toBe(
      'https://@[bad/x?q=1#f',
    );
    expect(stripURLCredentials('HTTPS:\\\\u:p@[bad\\x')).toBe(
      'HTTPS:\\\\@[bad\\x',
    );
    // Cut with the `@`, these would read as `https://evil.test/x`.
    for (const location of [
      'https://u:p@/evil.test/x',
      'https://u:p@\\evil.test/x',
    ]) {
      const stripped = stripURLCredentials(location);
      expect(stripped).not.toContain('u:p');
      expect(() => new URL(stripped)).toThrow();
    }
    // A special scheme's authority may follow any number of slashes, none included.
    expect(stripURLCredentials('https:admin:secret@evil.test:99999/')).toBe(
      'https:@evil.test:99999/',
    );
    expect(stripURLCredentials('https:/u:p@b.test:99999/x')).toBe(
      'https:/@b.test:99999/x',
    );
    // An `@` outside the authority, or no authority at all, is left alone.
    expect(stripURLCredentials('https://b.test:99999/x?u=a@b')).toBe(
      'https://b.test:99999/x?u=a@b',
    );
    expect(stripURLCredentials('not a url @x')).toBe('not a url @x');
  });

  test('every userinfo remover keeps an absolute URL absolute and a network-path reference in its network-path form', () => {
    const cases: Array<[string, string]> = [
      [stripURLCredentials('https://u:p@a.test/x?q#h'), 'https://a.test/x?q#h'],
      [stripURLCredentials('https://u@a.test/x'), 'https://a.test/x'],
      // Unparseable initial URL: a network-path target loses its userinfo, an absolute one too.
      [
        stripCrossOriginURLCredentials('//u:p@b.test/x', 'not a URL'),
        '//b.test/x',
      ],
      [
        stripCrossOriginURLCredentials('https://u:p@b.test/x', 'not a URL'),
        'https://b.test/x',
      ],
      // A cross-origin target against a parseable initial URL.
      [
        stripCrossOriginURLCredentials('//u:p@b.test/x', 'https://a.test/'),
        '//b.test/x',
      ],
      [
        stripCrossOriginURLCredentials(
          'https://u:p@b.test/x',
          'https://a.test/',
        ),
        'https://b.test/x',
      ],
      // A same-origin target carrying the request's own userinfo.
      [
        reportedRedirectTarget('//u:p@a.test/next', 'https://u:p@a.test/start'),
        '//a.test/next',
      ],
      [
        reportedRedirectTarget(
          'https://u:p@a.test/next',
          'https://u:p@a.test/start',
        ),
        'https://a.test/next',
      ],
    ];

    for (const [actual, expected] of cases) {
      expect(actual).toBe(expected);
    }
  });
});

describe('mergeHeaders', () => {
  test('merges multiple header sets', () => {
    expect(
      mergeHeaders(
        { 'content-type': 'text/plain' },
        { authorization: 'Bearer x' },
      ),
    ).toEqual({ 'content-type': 'text/plain', authorization: 'Bearer x' });
  });

  test('later sets win on conflict', () => {
    expect(
      mergeHeaders(
        { 'content-type': 'text/plain' },
        { 'content-type': 'application/json' },
      ),
    ).toEqual({ 'content-type': 'application/json' });
  });

  test('lowercases keys from all sets', () => {
    expect(mergeHeaders({ Authorization: 'Bearer x' })).toEqual({
      authorization: 'Bearer x',
    });
  });

  test('response header records keep a __proto__ header as an own key', () => {
    const fetchHeaders = extractFetchHeaders(
      new Headers([
        ['__proto__', 'a'],
        ['x-ok', '1'],
      ]),
    );
    expect(
      Object.getOwnPropertyDescriptor(fetchHeaders, '__proto__')?.value,
    ).toBe('a');

    const normalized = normalizeAdapterResponseHeaders(
      JSON.parse('{"__proto__": ["a", "b"]}') as Record<string, string[]>,
    );
    expect(Object.getPrototypeOf(normalized)).toBe(Object.prototype);
    expect(
      Object.getOwnPropertyDescriptor(normalized, '__proto__')?.value,
    ).toBe('a, b');
  });

  test('keeps a __proto__ header as an own key', () => {
    const source = JSON.parse(
      '{"__proto__": ["a", "b"], "x-ok": "1"}',
    ) as Record<string, string | string[]>;
    const merged = mergeHeaders(source);

    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(merged, '__proto__')?.value).toEqual(
      ['a', 'b'],
    );
    expect(merged['x-ok']).toBe('1');
  });

  test('skips undefined sets', () => {
    expect(mergeHeaders({ 'content-type': 'text/plain' }, undefined)).toEqual({
      'content-type': 'text/plain',
    });
  });

  test('returns empty object with no arguments', () => {
    expect(mergeHeaders()).toEqual({});
  });

  test('preserves multi-value arrays when merged', () => {
    expect(
      mergeHeaders({
        accept: ['application/json', 'text/plain'],
      }),
    ).toEqual({
      accept: ['application/json', 'text/plain'],
    });
  });

  test('collapses single-value arrays to a plain string', () => {
    expect(
      mergeHeaders({
        accept: ['application/json'],
      }),
    ).toEqual({
      accept: 'application/json',
    });
  });

  test('later arrays replace earlier scalar values wholesale', () => {
    expect(
      mergeHeaders(
        { accept: 'application/json' },
        { accept: ['text/plain', 'application/xml'] },
      ),
    ).toEqual({
      accept: ['text/plain', 'application/xml'],
    });
  });
});

describe('mergeObservedHeaders', () => {
  test('lowercases keys and preserves array values', () => {
    expect(
      mergeObservedHeaders(
        { Authorization: 'Bearer x' },
        { Accept: ['application/json', 'text/plain'] },
      ),
    ).toEqual({
      authorization: 'Bearer x',
      accept: ['application/json', 'text/plain'],
    });
  });

  test('later sets win on conflict', () => {
    expect(
      mergeObservedHeaders(
        { Accept: 'application/json' },
        { accept: ['text/plain'] },
      ),
    ).toEqual({
      accept: ['text/plain'],
    });
  });

  test('coerces scalars to strings and skips undefined values', () => {
    expect(
      mergeObservedHeaders({
        'Content-Type': 'application/json',
        'X-Count': 3,
        'X-Skip': undefined,
      }),
    ).toEqual({
      'content-type': 'application/json',
      'x-count': '3',
    });
  });

  test('a __proto__ header stays an own key through materialization', () => {
    const source = JSON.parse('{"__proto__": ["a", "b"]}') as Record<
      string,
      string[]
    >;
    const normalized = mergeObservedHeaders(source);
    const materialized = materializeRequestHeaders(normalized);

    expect(Object.getPrototypeOf(normalized)).toBe(Object.prototype);
    expect(
      Object.getOwnPropertyDescriptor(normalized, '__proto__')?.value,
    ).toEqual(['a', 'b']);
    expect(Object.getPrototypeOf(materialized)).toBe(Object.prototype);
    expect(
      Object.getOwnPropertyDescriptor(materialized, '__proto__')?.value,
    ).toBe('a, b');
  });
});

describe('parseContentType', () => {
  test('returns json for application/json', () => {
    expect(parseContentType('application/json')).toBe('json');
  });

  test('returns json for +json vendor types', () => {
    expect(parseContentType('application/vnd.api+json')).toBe('json');
  });

  test('returns text for text/* types', () => {
    expect(parseContentType('text/plain')).toBe('text');
    expect(parseContentType('text/html')).toBe('text');
  });

  test('returns text for application/x-www-form-urlencoded', () => {
    expect(parseContentType('application/x-www-form-urlencoded')).toBe('text');
  });

  test('returns binary for unrecognized types', () => {
    expect(parseContentType('application/octet-stream')).toBe('binary');
    expect(parseContentType('image/png')).toBe('binary');
  });

  test('returns binary for undefined', () => {
    expect(parseContentType(undefined)).toBe('binary');
  });

  test('is case-insensitive', () => {
    expect(parseContentType('Application/JSON')).toBe('json');
    expect(parseContentType('Text/Plain')).toBe('text');
  });
});

describe('content-type matching', () => {
  test('a media type is trimmed of HTTP whitespace and lowercased in ASCII only', () => {
    expect(parseContentType(' Application/JSON\t; charset=utf-8')).toBe('json');
    // NO-BREAK SPACE is not HTTP whitespace, so the media type is not `application/json`.
    expect(parseContentType('\u00A0application/json')).toBe('binary');
    // KELVIN SIGN: `toLowerCase` folds it into `k`, the Fetch standard does not.
    expect(
      matchesFilter(
        { contentTypeHeaders: ['text/markdown'] },
        { contentTypeHeader: 'text/mar\u212Adown' },
        'response',
      ),
    ).toBe(false);
    expect(
      matchesFilter(
        { contentTypeHeaders: ['text/markdown'] },
        { contentTypeHeader: 'TEXT/MARKDOWN' },
        'response',
      ),
    ).toBe(true);
  });
});

describe('assertSupportedAdapterRuntimeAndConfig', () => {
  // This block is the supported adapter/runtime matrix enforced at client
  // construction time.

  describe('redirect config invariants', () => {
    test('rejects maxRedirects when followRedirects is false', () => {
      expect(() =>
        assertSupportedAdapterRuntimeAndConfig(
          { followRedirects: false, maxRedirects: 1 },
          'mock',
          false,
        ),
      ).toThrow(/maxRedirects requires followRedirects: true/i);
    });

    test('rejects maxRedirects without followRedirects: true', () => {
      expect(() =>
        assertSupportedAdapterRuntimeAndConfig(
          { maxRedirects: 3 },
          'mock',
          false,
        ),
      ).toThrow(/maxRedirects requires followRedirects: true/i);
    });

    test('rejects non-positive maxRedirects when followRedirects is true', () => {
      expect(() =>
        assertSupportedAdapterRuntimeAndConfig(
          { followRedirects: true, maxRedirects: 0 },
          'mock',
          false,
        ),
      ).toThrow(
        /maxRedirects must be an integer greater than or equal to 1 when followRedirects is true/i,
      );
    });
  });

  describe('fetch in browser', () => {
    test('allows relative baseURL prefixes', () => {
      expect(() =>
        assertSupportedAdapterRuntimeAndConfig(
          { baseURL: '/api' },
          'fetch',
          true,
        ),
      ).not.toThrow();
    });

    test('rejects cookieJar usage', () => {
      expect(() =>
        assertSupportedAdapterRuntimeAndConfig(
          { cookieJar: new CookieJar() },
          'fetch',
          true,
        ),
      ).toThrow(
        /cookieJar is not supported with FetchAdapter in browser environments/i,
      );
    });

    test('rejects userAgent usage', () => {
      expect(() =>
        assertSupportedAdapterRuntimeAndConfig(
          { userAgent: 'test-agent' },
          'fetch',
          true,
        ),
      ).toThrow(/userAgent is not supported with FetchAdapter/i);
    });

    test('rejects redirect handling', () => {
      expect(() =>
        assertSupportedAdapterRuntimeAndConfig(
          { followRedirects: true },
          'fetch',
          true,
        ),
      ).toThrow(
        /redirect handling is not supported with FetchAdapter in browser environments/i,
      );
    });
  });

  describe('xhr in browser', () => {
    test('allows relative baseURL prefixes', () => {
      (globalThis as Record<string, unknown>).XMLHttpRequest = class {};

      expect(() =>
        assertSupportedAdapterRuntimeAndConfig(
          { baseURL: '/api' },
          'xhr',
          true,
        ),
      ).not.toThrow();
    });

    test('rejects cookieJar usage', () => {
      (globalThis as Record<string, unknown>).XMLHttpRequest = class {};

      expect(() =>
        assertSupportedAdapterRuntimeAndConfig(
          { cookieJar: new CookieJar() },
          'xhr',
          true,
        ),
      ).toThrow(/cookieJar is not supported with XHRAdapter/i);
    });

    test('rejects userAgent usage', () => {
      (globalThis as Record<string, unknown>).XMLHttpRequest = class {};

      expect(() =>
        assertSupportedAdapterRuntimeAndConfig(
          { userAgent: 'test-agent' },
          'xhr',
          true,
        ),
      ).toThrow(/userAgent is not supported with XHRAdapter/i);
    });

    test('rejects redirect handling', () => {
      expect(() =>
        assertSupportedAdapterRuntimeAndConfig(
          { followRedirects: true },
          'xhr',
          true,
        ),
      ).toThrow(/redirect handling is not supported with XHRAdapter/i);
    });
  });

  describe('mock in browser', () => {
    test('allows cookieJar and redirect following', () => {
      expect(() =>
        assertSupportedAdapterRuntimeAndConfig(
          {
            cookieJar: new CookieJar(),
            followRedirects: true,
            maxRedirects: 5,
          },
          'mock',
          true,
        ),
      ).not.toThrow();
    });

    test('rejects relative baseURL prefixes', () => {
      expect(() =>
        assertSupportedAdapterRuntimeAndConfig(
          { baseURL: '/api' },
          'mock',
          true,
        ),
      ).toThrow(/baseURL must be an absolute http\(s\) URL/i);
    });
  });

  describe('node adapter', () => {
    test('rejects browser runtime', () => {
      expect(() =>
        assertSupportedAdapterRuntimeAndConfig({}, 'node', true),
      ).toThrow(/Node adapter is not supported in browser environments/i);
    });

    test('allows server runtime', () => {
      expect(() =>
        assertSupportedAdapterRuntimeAndConfig({}, 'node', false),
      ).not.toThrow();
    });

    test('rejects relative baseURL prefixes', () => {
      expect(() =>
        assertSupportedAdapterRuntimeAndConfig(
          { baseURL: '/api' },
          'node',
          false,
        ),
      ).toThrow(/baseURL must be an absolute http\(s\) URL/i);
    });
  });

  describe('fetch in server runtime', () => {
    test('rejects relative baseURL prefixes', () => {
      expect(() =>
        assertSupportedAdapterRuntimeAndConfig(
          { baseURL: '/api' },
          'fetch',
          false,
        ),
      ).toThrow(/baseURL must be an absolute http\(s\) URL/i);
    });
  });

  describe('xhr in server runtime', () => {
    test('rejects when XMLHttpRequest is unavailable', () => {
      delete (globalThis as Record<string, unknown>).XMLHttpRequest;

      expect(() =>
        assertSupportedAdapterRuntimeAndConfig({}, 'xhr', false),
      ).toThrow(
        /XHRAdapter is not supported when XMLHttpRequest is unavailable/i,
      );
    });

    test('allows a test shim when XMLHttpRequest is present', () => {
      (globalThis as Record<string, unknown>).XMLHttpRequest = class {};

      expect(() =>
        assertSupportedAdapterRuntimeAndConfig({}, 'xhr', false),
      ).not.toThrow();
    });

    test('rejects redirect handling even when XMLHttpRequest is present', () => {
      (globalThis as Record<string, unknown>).XMLHttpRequest = class {};

      expect(() =>
        assertSupportedAdapterRuntimeAndConfig(
          { followRedirects: true },
          'xhr',
          false,
        ),
      ).toThrow(/redirect handling is not supported with XHRAdapter/i);
    });
  });
});

describe('extractFetchHeaders', () => {
  test('extracts regular headers as strings', () => {
    const headers = new Headers({ 'content-type': 'application/json' });
    expect(extractFetchHeaders(headers)).toMatchObject({
      'content-type': 'application/json',
    });
  });

  test('lowercases header keys', () => {
    const headers = new Headers({ Authorization: 'Bearer x' });
    const result = extractFetchHeaders(headers);
    expect(result['authorization']).toBe('Bearer x');
  });

  test('extracts set-cookie via getSetCookie() as string[]', () => {
    const headers = new Headers();
    headers.append('set-cookie', 'a=1');
    headers.append('set-cookie', 'b=2');
    const result = extractFetchHeaders(headers);
    expect(Array.isArray(result['set-cookie'])).toBe(true);
    expect(result['set-cookie']).toContain('a=1');
    expect(result['set-cookie']).toContain('b=2');
  });

  test('omits set-cookie from regular entries loop', () => {
    const headers = new Headers({ 'set-cookie': 'a=1' });
    // The set-cookie key should only appear via getSetCookie path, not duplicated
    const result = extractFetchHeaders(headers);
    expect(result['set-cookie']).toBeDefined();
    // Should be string[], not a plain string from the entries() loop
    expect(Array.isArray(result['set-cookie'])).toBe(true);
  });

  test('returns empty object for empty headers', () => {
    expect(extractFetchHeaders(new Headers())).toEqual({});
  });

  test.each([
    'a=1, b=2',
    'a=1, b = 2',
    'prefs=a,b=c; Path=/',
    'a=1; Expires=Wed, 21 Oct 2099 07:28:00 GMT, b=2',
    'safe=1; Secure; Path=/restricted, admin=1',
    'safe=1; Extension=value, admin=1; Path=/',
  ])('rejects ambiguous fallback cookie boundaries: %s', (raw) => {
    const headers = {
      entries: function* () {
        yield ['set-cookie', raw];
        yield ['content-type', 'application/json'];
      },
      get: () => raw,
    } as unknown as Headers;
    const extracted = extractFetchHeaders(headers);
    expect(extracted).toEqual({ 'content-type': 'application/json' });
    const jar = new CookieJar();
    jar.processResponseHeaders(extracted, 'https://example.com/');
    expect(jar.getAllCookies()).toEqual([]);
  });

  // Within the 400-day cookie lifetime cap.
  const inAMonth = new Date(
    Math.floor((Date.now() + 30 * 86_400_000) / 1000) * 1000,
  );
  test.each(['a=1', `a=1; Expires=${inAMonth.toUTCString()}`])(
    'preserves an unambiguous fallback cookie: %s',
    (raw) => {
      const headers = {
        entries: function* () {
          yield ['set-cookie', raw];
        },
        get: () => raw,
      } as unknown as Headers;
      const extracted = extractFetchHeaders(headers);
      expect(extracted['set-cookie']).toEqual([raw]);
      const jar = new CookieJar();
      jar.processResponseHeaders(extracted, 'https://example.com/');
      expect(jar.getCookieHeaderString('https://example.com/')).toBe('a=1');
      if (raw.includes('Expires=')) {
        expect(
          jar.getCookieFor('a', 'https://example.com/')?.expires?.getTime(),
        ).toBe(inAMonth.getTime());
      }
    },
  );

  test('preserves exact cookie lines with comma-containing attributes via getSetCookie', () => {
    const raw = 'safe=1; Secure; Path=/restricted, admin=1';
    const headers = new Headers({ 'set-cookie': raw });
    const extracted = extractFetchHeaders(headers);
    expect(extracted['set-cookie']).toEqual([raw]);
    const jar = new CookieJar();
    jar.processResponseHeaders(extracted, 'https://example.com/');
    expect(jar.getAllCookies()).toHaveLength(1);
    expect(jar.getAllCookies()[0].path).toBe('/restricted, admin=1');
    expect(jar.getCookieHeaderString('https://example.com/')).toBe('');
  });
});

describe('normalizeAdapterResponseHeaders', () => {
  test('lowercases keys', () => {
    expect(
      normalizeAdapterResponseHeaders({
        'Content-Type': 'application/json',
        Authorization: 'Bearer x',
      }),
    ).toEqual({
      'content-type': 'application/json',
      authorization: 'Bearer x',
    });
  });

  test('keys that collide after lowercasing are read as a repeated header', () => {
    expect(
      normalizeAdapterResponseHeaders({
        'Content-Type': 'text/plain',
        'CONTENT-TYPE': 'application/json',
        Link: '<a>',
        LINK: '<b>',
      }),
    ).toEqual({ 'content-type': 'text/plain', link: '<a>, <b>' });
  });

  test('merges set-cookie lines from keys that differ only by case', () => {
    expect(
      normalizeAdapterResponseHeaders({
        'Set-Cookie': ['a=1; Path=/'],
        'set-cookie': ['b=2; Path=/'],
      }),
    ).toEqual({ 'set-cookie': ['a=1; Path=/', 'b=2; Path=/'] });
  });

  test('wraps a single Set-Cookie string as a one-element array', () => {
    expect(
      normalizeAdapterResponseHeaders({
        'Set-Cookie': 'a=1; Path=/',
      }),
    ).toEqual({ 'set-cookie': ['a=1; Path=/'] });
  });

  test('leaves lowercase set-cookie arrays unchanged', () => {
    expect(
      normalizeAdapterResponseHeaders({
        'set-cookie': ['a=1', 'b=2'],
      }),
    ).toEqual({ 'set-cookie': ['a=1', 'b=2'] });
  });
});

describe('scalarHeader', () => {
  test('returns a plain string value', () => {
    expect(
      scalarHeader({ 'content-type': 'application/json' }, 'content-type'),
    ).toBe('application/json');
  });

  test('returns first element when value is an array', () => {
    expect(scalarHeader({ 'x-foo': ['a', 'b'] }, 'x-foo')).toBe('a');
  });

  test('returns undefined for a missing key', () => {
    expect(scalarHeader({}, 'content-type')).toBeUndefined();
  });

  test('does not read mixed-case keys (caller must normalize first)', () => {
    expect(
      scalarHeader({ 'Content-Type': 'application/json' }, 'content-type'),
    ).toBeUndefined();
  });
});

describe('derivedRedirectFields', () => {
  test('resolves an absolute location header', () => {
    expect(
      derivedRedirectFields('https://example.com/start', 301, {
        location: 'https://other.test/next',
      }),
    ).toEqual({
      wasRedirectDetected: true,
      detectedRedirectURL: 'https://other.test/next',
    });
  });

  test('resolves a relative location header against the request URL', () => {
    expect(
      derivedRedirectFields('https://example.com/start', 302, {
        location: '/next',
      }).detectedRedirectURL,
    ).toBe('https://example.com/next');
  });

  test('reports no redirect for non-redirect statuses', () => {
    expect(
      derivedRedirectFields('https://example.com/start', 200, {
        location: '/next',
      }),
    ).toEqual({ wasRedirectDetected: false });
  });

  test('reports a redirect with no target when location is missing', () => {
    expect(derivedRedirectFields('https://example.com/start', 301, {})).toEqual(
      { wasRedirectDetected: true },
    );
  });

  test('reports no target when the location cannot be resolved', () => {
    expect(
      derivedRedirectFields('https://example.com/start', 301, {
        location: 'http://[bad',
      }),
    ).toEqual({ wasRedirectDetected: true });
    expect(
      derivedRedirectFields('not a url', 301, {
        location: '%%%bad%%%',
      }),
    ).toEqual({ wasRedirectDetected: true });
  });

  test('resolves an absolute location when the request URL does not parse', () => {
    expect(
      derivedRedirectFields('not a url', 301, {
        location: 'https://ok.test/next',
      }).detectedRedirectURL,
    ).toBe('https://ok.test/next');
  });
});

describe('isBrowserEnvironment', () => {
  const originalWindow = (globalThis as any).window;
  const originalDocument = (globalThis as any).document;
  const originalSelf = (globalThis as any).self;
  const originalWorkerGlobalScope = (globalThis as any).WorkerGlobalScope;

  afterEach(() => {
    if (originalWindow === undefined) {
      delete (globalThis as any).window;
    } else {
      (globalThis as any).window = originalWindow;
    }

    if (originalDocument === undefined) {
      delete (globalThis as any).document;
    } else {
      (globalThis as any).document = originalDocument;
    }

    if (originalSelf === undefined) {
      delete (globalThis as any).self;
    } else {
      (globalThis as any).self = originalSelf;
    }

    if (originalWorkerGlobalScope === undefined) {
      delete (globalThis as any).WorkerGlobalScope;
    } else {
      (globalThis as any).WorkerGlobalScope = originalWorkerGlobalScope;
    }
  });

  test('returns true when window and document are defined', () => {
    (globalThis as any).window = {};
    (globalThis as any).document = {};

    expect(isBrowserEnvironment()).toBe(true);
  });

  test('returns false when window is missing', () => {
    delete (globalThis as any).window;
    (globalThis as any).document = {};

    expect(isBrowserEnvironment()).toBe(false);
  });

  test('returns false when document is missing and worker globals are absent', () => {
    (globalThis as any).window = {};
    delete (globalThis as any).document;
    delete (globalThis as any).self;
    delete (globalThis as any).WorkerGlobalScope;

    expect(isBrowserEnvironment()).toBe(false);
  });

  test('returns true in worker-like runtimes without window or document', () => {
    class FakeWorkerGlobalScope {}

    delete (globalThis as any).window;
    delete (globalThis as any).document;
    (globalThis as any).WorkerGlobalScope = FakeWorkerGlobalScope;
    (globalThis as any).self = Object.create(FakeWorkerGlobalScope.prototype);

    expect(isBrowserEnvironment()).toBe(true);
  });
});

describe('serializeBody', () => {
  test('returns null body and null contentType for null', () => {
    expect(serializeBody(null)).toEqual({ body: null, contentType: null });
  });

  test('returns null body and null contentType for undefined', () => {
    expect(serializeBody(undefined)).toEqual({ body: null, contentType: null });
  });

  test('serializes string as text/plain', () => {
    expect(serializeBody('hello')).toEqual({
      body: 'hello',
      contentType: 'text/plain; charset=utf-8',
    });
  });

  test('serializes Uint8Array as application/octet-stream', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(serializeBody(bytes)).toEqual({
      body: bytes,
      contentType: 'application/octet-stream',
    });
  });

  test('serializes plain objects as JSON', () => {
    const result = serializeBody({ a: 1 });
    expect(result.contentType).toBe('application/json; charset=utf-8');
    expect(result.body).toBe(JSON.stringify({ a: 1 }));
  });

  test('serializes arrays as JSON', () => {
    const result = serializeBody([1, 2, 3]);
    expect(result.contentType).toBe('application/json; charset=utf-8');
    expect(result.body).toBe('[1,2,3]');
  });

  test('FormData passed as body returns null contentType', () => {
    const fd = new FormData();
    fd.append('key', 'value');
    expect(serializeBody(fd)).toEqual({
      body: fd,
      contentType: null,
    });
  });

  test('throws for unsupported object-like body types', () => {
    expect(() => serializeBody(new URLSearchParams({ a: '1' }))).toThrow(
      /Unsupported request body type/i,
    );
  });
});

describe('extractHostname', () => {
  test('extracts hostname from a valid URL', () => {
    expect(extractHostname('https://api.example.com/path')).toBe(
      'api.example.com',
    );
  });

  test('returns empty string for an invalid URL', () => {
    expect(extractHostname('not-a-url')).toBe('');
  });

  test('returns empty string for an empty string', () => {
    expect(extractHostname('')).toBe('');
  });
});

describe('matchesHostPattern', () => {
  test('matches exact hostname', () => {
    expect(matchesHostPattern('example.com', 'example.com')).toBe(true);
  });

  test('exact match is case-insensitive', () => {
    expect(matchesHostPattern('Example.COM', 'example.com')).toBe(true);
  });

  test('does not match different exact hostname', () => {
    expect(matchesHostPattern('other.com', 'example.com')).toBe(false);
  });

  describe('* (single-label wildcard)', () => {
    test('matches one subdomain label', () => {
      expect(matchesHostPattern('api.example.com', '*.example.com')).toBe(true);
    });

    test('does not match the apex domain', () => {
      expect(matchesHostPattern('example.com', '*.example.com')).toBe(false);
    });

    test('does not match a different domain', () => {
      expect(matchesHostPattern('api.other.com', '*.example.com')).toBe(false);
    });

    test('does not match deeper nesting (use ** for that)', () => {
      expect(matchesHostPattern('a.b.example.com', '*.example.com')).toBe(
        false,
      );
    });
  });

  describe('** (multi-label wildcard)', () => {
    test('matches one subdomain label', () => {
      expect(matchesHostPattern('api.example.com', '**.example.com')).toBe(
        true,
      );
    });

    test('matches deeply nested subdomains', () => {
      expect(matchesHostPattern('a.b.example.com', '**.example.com')).toBe(
        true,
      );
    });

    test('does not match the apex domain', () => {
      expect(matchesHostPattern('example.com', '**.example.com')).toBe(false);
    });
  });

  describe('* (global wildcard)', () => {
    test('matches any hostname including apex', () => {
      expect(matchesHostPattern('example.com', '*')).toBe(true);
    });

    test('matches subdomains', () => {
      expect(matchesHostPattern('api.example.com', '*')).toBe(true);
    });
  });

  describe('PSL tail guard', () => {
    test('rejects *.com style patterns', () => {
      expect(matchesHostPattern('anything.com', '*.com')).toBe(false);
    });

    test('rejects **.co.uk style patterns', () => {
      expect(matchesHostPattern('anything.co.uk', '**.co.uk')).toBe(false);
    });
  });

  describe('pseudo-TLD wildcard guard', () => {
    test('rejects *.localhost patterns', () => {
      expect(matchesHostPattern('api.localhost', '*.localhost')).toBe(false);
    });

    test('rejects *.local patterns', () => {
      expect(matchesHostPattern('myapp.local', '*.local')).toBe(false);
    });

    test('rejects *.test patterns', () => {
      expect(matchesHostPattern('myapp.test', '*.test')).toBe(false);
    });

    test('rejects *.internal patterns', () => {
      expect(matchesHostPattern('api.internal', '*.internal')).toBe(false);
    });

    test('rejects **.localhost patterns', () => {
      expect(matchesHostPattern('a.b.localhost', '**.localhost')).toBe(false);
    });
  });

  test('a wildcard matches a host with a hyphen at a label edge, as the URL parser reads it', async () => {
    // DNS refuses the edge hyphen, the URL parser does not, and a request goes there.
    expect(matchesHostPattern('-edge.example.com', '*.example.com')).toBe(true);
    expect(matchesHostPattern('a.edge-.example.com', '**.example.com')).toBe(
      true,
    );
    // An IDN label whose Unicode form starts with a hyphen, as the parser encodes it.
    expect(matchesHostPattern('-ñ.example.com', '*.example.com')).toBe(true);
    expect(matchesHostPattern('-edge.example.com.', '*.example.com')).toBe(
      true,
    );
    // Still label by label: not another site's, nor more than one label for `*`.
    expect(matchesHostPattern('-edge.example.org', '*.example.com')).toBe(
      false,
    );
    expect(matchesHostPattern('a.-edge.example.com', '*.example.com')).toBe(
      false,
    );
    expect(matchesHostPattern('-edge.example.com', 'example.com')).toBe(false);

    const adapter = new MockAdapter();
    adapter.routes.get('/x', () => ({ status: 200 }));
    const client = new HTTPClient({ adapter });
    const seen: string[] = [];
    client.addRequestInterceptor(
      (request) => {
        seen.push(request.requestURL);
        return request;
      },
      { hosts: ['*.example.com'] },
    );

    await client.get('https://-edge.example.com/x').send();

    expect(seen).toEqual(['https://-edge.example.com/x']);
  });
});

describe('matchesFilter', () => {
  test('returns true when no filter fields are set', () => {
    expect(matchesFilter({}, { status: 200, method: 'GET' }, 'request')).toBe(
      true,
    );
  });

  test('statusCodes — matches included status', () => {
    expect(
      matchesFilter({ statusCodes: [401, 403] }, { status: 401 }, 'request'),
    ).toBe(true);
  });

  test('statusCodes — rejects excluded status', () => {
    expect(
      matchesFilter({ statusCodes: [401] }, { status: 200 }, 'request'),
    ).toBe(false);
  });

  test('statusCodes — skipped when context.status is absent', () => {
    expect(matchesFilter({ statusCodes: [401] }, {}, 'request')).toBe(true);
  });

  test('methods — matches included method', () => {
    expect(
      matchesFilter(
        { methods: ['POST', 'PUT'] },
        { method: 'POST' },
        'request',
      ),
    ).toBe(true);
  });

  test('methods — rejects excluded method', () => {
    expect(
      matchesFilter({ methods: ['POST'] }, { method: 'GET' }, 'request'),
    ).toBe(false);
  });

  test('methods — skipped without a method', () => {
    expect(matchesFilter({ methods: ['POST'] }, {}, 'response')).toBe(true);
  });

  test('contentTypes — matches included parsed content type', () => {
    expect(
      matchesFilter(
        { contentTypes: ['json'] },
        { contentType: 'json' },
        'response',
      ),
    ).toBe(true);
  });

  test('contentTypes — rejects non-matching parsed content type', () => {
    expect(
      matchesFilter(
        { contentTypes: ['text'] },
        { contentType: 'json' },
        'response',
      ),
    ).toBe(false);
  });

  test('contentTypeHeaders — matches exact MIME type ignoring params', () => {
    expect(
      matchesFilter(
        { contentTypeHeaders: ['application/json'] },
        { contentTypeHeader: 'application/json; charset=utf-8' },
        'response',
      ),
    ).toBe(true);
  });

  test('contentTypeHeaders — matches wildcard subtype pattern', () => {
    expect(
      matchesFilter(
        { contentTypeHeaders: ['image/*'] },
        { contentTypeHeader: 'image/png' },
        'response',
      ),
    ).toBe(true);
  });

  test('contentTypeHeaders — rejects non-matching MIME type', () => {
    expect(
      matchesFilter(
        { contentTypeHeaders: ['video/mp4'] },
        { contentTypeHeader: 'image/png' },
        'response',
      ),
    ).toBe(false);
  });

  test('hosts — matches exact hostname', () => {
    expect(
      matchesFilter(
        { hosts: ['api.example.com'] },
        { requestURL: 'https://api.example.com/path' },
        'request',
      ),
    ).toBe(true);
  });

  test('hosts — rejects non-matching hostname', () => {
    expect(
      matchesFilter(
        { hosts: ['api.example.com'] },
        { requestURL: 'https://other.com/path' },
        'request',
      ),
    ).toBe(false);
  });

  test('hosts — skipped without a URL', () => {
    expect(matchesFilter({ hosts: ['api.example.com'] }, {}, 'response')).toBe(
      true,
    );
  });

  test('hosts — wildcard matches subdomain', () => {
    expect(
      matchesFilter(
        { hosts: ['*.example.com'] },
        { requestURL: 'https://api.example.com/path' },
        'request',
      ),
    ).toBe(true);
  });

  test('schemes — matches https', () => {
    expect(
      matchesFilter(
        { schemes: ['https'] },
        { requestURL: 'https://api.example.com/path' },
        'request',
      ),
    ).toBe(true);
  });

  test('schemes — rejects wrong scheme', () => {
    expect(
      matchesFilter(
        { schemes: ['https'] },
        { requestURL: 'http://api.example.com/path' },
        'request',
      ),
    ).toBe(false);
  });

  test('schemes — matches http', () => {
    expect(
      matchesFilter(
        { schemes: ['http'] },
        { requestURL: 'http://api.example.com/path' },
        'request',
      ),
    ).toBe(true);
  });

  test('schemes — skipped without a URL', () => {
    expect(matchesFilter({ schemes: ['https'] }, {}, 'response')).toBe(true);
  });

  test('schemes — non-absolute requestURL is a non-match (no throw)', () => {
    expect(
      matchesFilter(
        { schemes: ['https'] },
        { requestURL: '/api/users' },
        'request',
      ),
    ).toBe(false);
  });

  test('schemes — AND with hosts both matching', () => {
    expect(
      matchesFilter(
        { schemes: ['https'], hosts: ['*.example.com'] },
        { requestURL: 'https://api.example.com/path' },
        'request',
      ),
    ).toBe(true);
  });

  test('schemes — AND with hosts, scheme mismatch fails', () => {
    expect(
      matchesFilter(
        { schemes: ['https'], hosts: ['*.example.com'] },
        { requestURL: 'http://api.example.com/path' },
        'request',
      ),
    ).toBe(false);
  });

  test('bodyContainsKeys — matches when key present at top level', () => {
    expect(
      matchesFilter(
        { bodyContainsKeys: ['error'] },
        { body: { error: 'bad', code: 42 } },
        'response',
      ),
    ).toBe(true);
  });

  test('bodyContainsKeys — rejects when key absent', () => {
    expect(
      matchesFilter(
        { bodyContainsKeys: ['error'] },
        { body: { ok: true } },
        'response',
      ),
    ).toBe(false);
  });

  test('bodyContainsKeys — returns false when body is absent', () => {
    expect(matchesFilter({ bodyContainsKeys: ['error'] }, {}, 'response')).toBe(
      false,
    );
  });

  test('bodyContainsKeys — returns false when body is a root array', () => {
    expect(
      matchesFilter(
        { bodyContainsKeys: ['error'] },
        { body: ['a', 'b'] },
        'response',
      ),
    ).toBe(false);
  });

  test('bodyContainsKeys — returns false when body is a string', () => {
    expect(
      matchesFilter(
        { bodyContainsKeys: ['error'] },
        { body: 'hello' },
        'response',
      ),
    ).toBe(false);
  });

  test('bodyContainsKeys — matches key whose value is an array', () => {
    expect(
      matchesFilter(
        { bodyContainsKeys: ['results'] },
        { body: { results: [1, 2, 3] } },
        'response',
      ),
    ).toBe(true);
  });

  test('bodyContainsKeys — traverses dot paths into nested objects', () => {
    expect(
      matchesFilter(
        { bodyContainsKeys: ['data.foo'] },
        { body: { data: { foo: 1 } } },
        'response',
      ),
    ).toBe(true);
  });

  test('bodyContainsKeys — matches dot path key whose value is an array', () => {
    expect(
      matchesFilter(
        { bodyContainsKeys: ['data.results'] },
        { body: { data: { results: [] } } },
        'response',
      ),
    ).toBe(true);
  });

  test('bodyContainsKeys — returns false when dot path segment is missing', () => {
    expect(
      matchesFilter(
        { bodyContainsKeys: ['data.bar'] },
        { body: { data: { foo: 1 } } },
        'response',
      ),
    ).toBe(false);
  });

  test('bodyContainsKeys — returns false when an intermediate dot path segment is an array', () => {
    expect(
      matchesFilter(
        { bodyContainsKeys: ['data.0.name'] },
        { body: { data: [{ name: 'x' }] } },
        'response',
      ),
    ).toBe(false);
  });

  test('bodyContainsKeys — skipped entirely for kind error', () => {
    expect(
      matchesFilter(
        { bodyContainsKeys: ['error'] },
        { body: { error: 'bad' } },
        'error',
      ),
    ).toBe(true);
  });

  test('all fields must match — fails when one does not', () => {
    expect(
      matchesFilter(
        { statusCodes: [200], methods: ['POST'] },
        { status: 200, method: 'GET' },
        'request',
      ),
    ).toBe(false);
  });

  test('all fields must match — passes when all match', () => {
    expect(
      matchesFilter(
        { statusCodes: [200], methods: ['GET'] },
        { status: 200, method: 'GET' },
        'request',
      ),
    ).toBe(true);
  });
});

describe('matchesFilterPhase', () => {
  test('omitted phases do not gate matching', () => {
    expect(matchesFilterPhase(undefined, 'initial')).toBe(true);
    expect(matchesFilterPhase(undefined, 'retry')).toBe(true);
    expect(matchesFilterPhase(undefined, 'redirect')).toBe(true);
  });

  test('list is OR: match if current event type is included', () => {
    expect(matchesFilterPhase(['retry', 'redirect'], 'initial')).toBe(false);
    expect(matchesFilterPhase(['retry', 'redirect'], 'retry')).toBe(true);
    expect(matchesFilterPhase(['retry', 'redirect'], 'redirect')).toBe(true);
  });
});

test.each([NaN, Infinity, -Infinity])(
  'rejects non-finite maxRedirects %s',
  (maxRedirects) => {
    expect(() =>
      assertSupportedAdapterRuntimeAndConfig(
        { followRedirects: true, maxRedirects },
        'node',
        false,
      ),
    ).toThrow();
  },
);

test('serializeBody refuses a body whose prototype answers differently once it has passed the check', () => {
  let looks = 0;
  // A plain object to `assertSupportedRequestBody`'s two looks, then not one.
  const body = new Proxy(
    {},
    {
      getPrototypeOf: () =>
        ++looks <= 2 ? Object.prototype : Object.create(Object.prototype),
    },
  );

  expect(() => serializeBody(body)).toThrow(
    'Unsupported request body type. Supported types: string, Uint8Array, FormData, plain object, array, null, and undefined.',
  );
  expect(looks).toBe(4);
});

describe('firstJoinedLocation', () => {
  test('splits at a `, ` followed by a path or scheme, and nowhere else', () => {
    expect(firstJoinedLocation('/a, /b')).toBe('/a');
    expect(firstJoinedLocation('https://x.test/a, https://y.test/b')).toBe(
      'https://x.test/a',
    );
    expect(firstJoinedLocation('/files/Smith, John.pdf')).toBe(
      '/files/Smith, John.pdf',
    );
    expect(firstJoinedLocation('/r?to=a,/b')).toBe('/r?to=a,/b');
  });

  test('cuts a single value with an unencoded `, /` in it, which reads as two joined', () => {
    expect(firstJoinedLocation('/login?next=/a, /b')).toBe('/login?next=/a');
    expect(firstJoinedLocation('/r?to=x, https://y.example/')).toBe('/r?to=x');
    expect(firstJoinedLocation('/login?next=/a,%20/b')).toBe(
      '/login?next=/a,%20/b',
    );
  });

  test('keeps a value whole where what follows `, ` is no path or scheme, joined or not', () => {
    // Repeats of a bare relative reference read the same as one value with a raw space
    // (`/files/Smith, John.pdf`), which is kept whole.
    expect(firstJoinedLocation('next, other')).toBe('next, other');
  });
});

describe('locationText', () => {
  test('reads a header value a character per byte as the UTF-8 it was sent as', () => {
    // `/café?q=é` as a runtime hands raw UTF-8 header bytes over.
    expect(locationText('/caf\u00c3\u00a9?q=\u00c3\u00a9')).toBe('/café?q=é');
  });

  test('keeps ASCII, text already decoded, and bytes that are not UTF-8 as they came', () => {
    expect(locationText('/plain?q=%C3%A9')).toBe('/plain?q=%C3%A9');
    expect(locationText('/日本')).toBe('/日本');
    // A lone latin1 byte is no UTF-8 sequence.
    expect(locationText('/caf\u00e9')).toBe('/caf\u00e9');
  });
});
