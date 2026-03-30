import { afterEach, describe, expect, test } from 'bun:test';
import {
  buildURL,
  extractFetchHeaders,
  extractHostname,
  isBrowserEnvironment,
  scalarHeader,
  matchesFilter,
  matchesHostPattern,
  mergeHeaders,
  normalizeAdapterResponseHeaders,
  normalizeHeaders,
  parseContentType,
  resolveAbsoluteURL,
  serializeBody,
} from './utils';

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
    ).toBe('https://example.com/search?existing=2&keep=yes');
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

describe('normalizeHeaders', () => {
  test('lowercases all keys', () => {
    expect(normalizeHeaders({ 'Content-Type': 'application/json' })).toEqual({
      'content-type': 'application/json',
    });
  });

  test('preserves values unchanged', () => {
    expect(normalizeHeaders({ Authorization: 'Bearer TOKEN' })).toEqual({
      authorization: 'Bearer TOKEN',
    });
  });

  test('handles empty object', () => {
    expect(normalizeHeaders({})).toEqual({});
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

  test('skips undefined sets', () => {
    expect(mergeHeaders({ 'content-type': 'text/plain' }, undefined)).toEqual({
      'content-type': 'text/plain',
    });
  });

  test('returns empty object with no arguments', () => {
    expect(mergeHeaders()).toEqual({});
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

  test('falls back to headers.get("set-cookie") when getSetCookie is unavailable', () => {
    const headers = {
      entries: function* () {
        yield ['content-type', 'application/json'] as [string, string];
        yield ['set-cookie', 'a=1, b=2'] as [string, string];
      },
      get(name: string) {
        return name === 'set-cookie' ? 'a=1, b=2' : null;
      },
    } as unknown as Headers;

    expect(extractFetchHeaders(headers)).toEqual({
      'content-type': 'application/json',
      'set-cookie': ['a=1, b=2'],
    });
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

  test('last scalar wins when keys collide after lowercasing', () => {
    expect(
      normalizeAdapterResponseHeaders({
        'Content-Type': 'text/plain',
        'CONTENT-TYPE': 'application/json',
      }),
    ).toEqual({ 'content-type': 'application/json' });
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

  test('does not match different exact hostname', () => {
    expect(matchesHostPattern('other.com', 'example.com')).toBe(false);
  });

  test('wildcard matches subdomain', () => {
    expect(matchesHostPattern('api.example.com', '*.example.com')).toBe(true);
  });

  test('wildcard does not match the root domain itself', () => {
    expect(matchesHostPattern('example.com', '*.example.com')).toBe(false);
  });

  test('wildcard does not match a different domain', () => {
    expect(matchesHostPattern('api.other.com', '*.example.com')).toBe(false);
  });

  test('wildcard matches deeply nested subdomain', () => {
    expect(matchesHostPattern('a.b.example.com', '*.example.com')).toBe(true);
  });
});

describe('matchesFilter', () => {
  test('returns true when no filter fields are set', () => {
    expect(
      matchesFilter({}, { status: 200, method: 'GET' }, 'initial', 'request'),
    ).toBe(true);
  });

  test('statusCodes — matches included status', () => {
    expect(
      matchesFilter(
        { statusCodes: [401, 403] },
        { status: 401 },
        'initial',
        'request',
      ),
    ).toBe(true);
  });

  test('statusCodes — rejects excluded status', () => {
    expect(
      matchesFilter(
        { statusCodes: [401] },
        { status: 200 },
        'initial',
        'request',
      ),
    ).toBe(false);
  });

  test('statusCodes — skipped when context.status is absent', () => {
    expect(
      matchesFilter({ statusCodes: [401] }, {}, 'initial', 'request'),
    ).toBe(true);
  });

  test('methods — matches included method', () => {
    expect(
      matchesFilter(
        { methods: ['POST', 'PUT'] },
        { method: 'POST' },
        'initial',
        'request',
      ),
    ).toBe(true);
  });

  test('methods — rejects excluded method', () => {
    expect(
      matchesFilter(
        { methods: ['POST'] },
        { method: 'GET' },
        'initial',
        'request',
      ),
    ).toBe(false);
  });

  test('methods — skipped when context.method is absent', () => {
    expect(matchesFilter({ methods: ['POST'] }, {}, 'initial', 'request')).toBe(
      true,
    );
  });

  test('contentTypes — matches included parsed content type', () => {
    expect(
      matchesFilter(
        { contentTypes: ['json'] },
        { contentType: 'json' },
        'final',
        'response',
      ),
    ).toBe(true);
  });

  test('contentTypes — rejects non-matching parsed content type', () => {
    expect(
      matchesFilter(
        { contentTypes: ['text'] },
        { contentType: 'json' },
        'final',
        'response',
      ),
    ).toBe(false);
  });

  test('contentTypeHeaders — matches exact MIME type ignoring params', () => {
    expect(
      matchesFilter(
        { contentTypeHeaders: ['application/json'] },
        { contentTypeHeader: 'application/json; charset=utf-8' },
        'final',
        'response',
      ),
    ).toBe(true);
  });

  test('contentTypeHeaders — matches wildcard subtype pattern', () => {
    expect(
      matchesFilter(
        { contentTypeHeaders: ['image/*'] },
        { contentTypeHeader: 'image/png' },
        'final',
        'response',
      ),
    ).toBe(true);
  });

  test('contentTypeHeaders — rejects non-matching MIME type', () => {
    expect(
      matchesFilter(
        { contentTypeHeaders: ['video/mp4'] },
        { contentTypeHeader: 'image/png' },
        'final',
        'response',
      ),
    ).toBe(false);
  });

  test('hosts — matches exact hostname', () => {
    expect(
      matchesFilter(
        { hosts: ['api.example.com'] },
        { requestURL: 'https://api.example.com/path' },
        'initial',
        'request',
      ),
    ).toBe(true);
  });

  test('hosts — rejects non-matching hostname', () => {
    expect(
      matchesFilter(
        { hosts: ['api.example.com'] },
        { requestURL: 'https://other.com/path' },
        'initial',
        'request',
      ),
    ).toBe(false);
  });

  test('hosts — skipped when context.requestURL is absent', () => {
    expect(
      matchesFilter({ hosts: ['api.example.com'] }, {}, 'initial', 'request'),
    ).toBe(true);
  });

  test('hosts — wildcard matches subdomain', () => {
    expect(
      matchesFilter(
        { hosts: ['*.example.com'] },
        { requestURL: 'https://api.example.com/path' },
        'initial',
        'request',
      ),
    ).toBe(true);
  });

  test('bodyContainsKeys — matches when key present at top level', () => {
    expect(
      matchesFilter(
        { bodyContainsKeys: ['error'] },
        { body: { error: 'bad', code: 42 } },
        'final',
        'response',
      ),
    ).toBe(true);
  });

  test('bodyContainsKeys — rejects when key absent', () => {
    expect(
      matchesFilter(
        { bodyContainsKeys: ['error'] },
        { body: { ok: true } },
        'final',
        'response',
      ),
    ).toBe(false);
  });

  test('bodyContainsKeys — returns false when body is absent', () => {
    expect(
      matchesFilter({ bodyContainsKeys: ['error'] }, {}, 'final', 'response'),
    ).toBe(false);
  });

  test('bodyContainsKeys — returns false when body is a root array', () => {
    expect(
      matchesFilter(
        { bodyContainsKeys: ['error'] },
        { body: ['a', 'b'] },
        'final',
        'response',
      ),
    ).toBe(false);
  });

  test('bodyContainsKeys — returns false when body is a string', () => {
    expect(
      matchesFilter(
        { bodyContainsKeys: ['error'] },
        { body: 'hello' },
        'final',
        'response',
      ),
    ).toBe(false);
  });

  test('bodyContainsKeys — matches key whose value is an array', () => {
    expect(
      matchesFilter(
        { bodyContainsKeys: ['results'] },
        { body: { results: [1, 2, 3] } },
        'final',
        'response',
      ),
    ).toBe(true);
  });

  test('bodyContainsKeys — traverses dot paths into nested objects', () => {
    expect(
      matchesFilter(
        { bodyContainsKeys: ['data.foo'] },
        { body: { data: { foo: 1 } } },
        'final',
        'response',
      ),
    ).toBe(true);
  });

  test('bodyContainsKeys — matches dot path key whose value is an array', () => {
    expect(
      matchesFilter(
        { bodyContainsKeys: ['data.results'] },
        { body: { data: { results: [] } } },
        'final',
        'response',
      ),
    ).toBe(true);
  });

  test('bodyContainsKeys — returns false when dot path segment is missing', () => {
    expect(
      matchesFilter(
        { bodyContainsKeys: ['data.bar'] },
        { body: { data: { foo: 1 } } },
        'final',
        'response',
      ),
    ).toBe(false);
  });

  test('bodyContainsKeys — returns false when an intermediate dot path segment is an array', () => {
    expect(
      matchesFilter(
        { bodyContainsKeys: ['data.0.name'] },
        { body: { data: [{ name: 'x' }] } },
        'final',
        'response',
      ),
    ).toBe(false);
  });

  test('bodyContainsKeys — skipped entirely for kind error', () => {
    expect(
      matchesFilter(
        { bodyContainsKeys: ['error'] },
        { body: { error: 'bad' } },
        'final',
        'error',
      ),
    ).toBe(true);
  });

  test('all fields must match — fails when one does not', () => {
    expect(
      matchesFilter(
        { statusCodes: [200], methods: ['POST'] },
        { status: 200, method: 'GET' },
        'initial',
        'request',
      ),
    ).toBe(false);
  });

  test('all fields must match — passes when all match', () => {
    expect(
      matchesFilter(
        { statusCodes: [200], methods: ['GET'] },
        { status: 200, method: 'GET' },
        'initial',
        'request',
      ),
    ).toBe(true);
  });

  test('phases — omitted phases do not gate matching', () => {
    expect(matchesFilter({}, {}, 'initial', 'request')).toBe(true);
    expect(matchesFilter({}, {}, 'retry', 'request')).toBe(true);
    expect(matchesFilter({}, {}, 'redirect', 'response')).toBe(true);
  });

  test('phases — empty phases do not gate matching', () => {
    expect(matchesFilter({ phases: [] }, {}, 'initial', 'request')).toBe(true);
    expect(matchesFilter({ phases: [] }, {}, 'retry', 'request')).toBe(true);
    expect(matchesFilter({ phases: [] }, {}, 'final', 'error')).toBe(true);
  });

  test('phases — list is OR: match if current event type is included', () => {
    expect(
      matchesFilter(
        { phases: ['retry', 'redirect'] },
        {},
        'initial',
        'request',
      ),
    ).toBe(false);

    expect(
      matchesFilter({ phases: ['retry', 'redirect'] }, {}, 'retry', 'request'),
    ).toBe(true);

    expect(
      matchesFilter(
        { phases: ['retry', 'redirect'] },
        {},
        'redirect',
        'request',
      ),
    ).toBe(true);
  });

  test('phases — combined with other filters', () => {
    expect(
      matchesFilter(
        { phases: ['initial'], methods: ['POST'] },
        { method: 'POST' },
        'initial',
        'request',
      ),
    ).toBe(true);

    expect(
      matchesFilter(
        { phases: ['initial'], methods: ['POST'] },
        { method: 'GET' },
        'initial',
        'request',
      ),
    ).toBe(false);

    expect(
      matchesFilter(
        { phases: ['initial'], methods: ['POST'] },
        { method: 'POST' },
        'retry',
        'request',
      ),
    ).toBe(false);
  });
});
