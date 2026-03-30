import { describe, expect, test } from 'bun:test';
import {
  assertNoBrowserRestrictedHeaders,
  isBrowserRestrictedHeader,
  isJSONContentType,
  isTextContentType,
} from './header-utils';

describe('isBrowserRestrictedHeader', () => {
  test('detects exact-match browser restricted headers', () => {
    expect(isBrowserRestrictedHeader('Content-Length', '123')).toBe(true);
    expect(isBrowserRestrictedHeader('Set-Cookie', 'a=1')).toBe(true);
  });

  test('detects browser restricted header prefixes', () => {
    expect(isBrowserRestrictedHeader('Sec-Fetch-Site', 'same-origin')).toBe(
      true,
    );
    expect(isBrowserRestrictedHeader('Proxy-Authorization', 'Basic abc')).toBe(
      true,
    );
  });

  test('exact-match check is case-insensitive for the key', () => {
    expect(isBrowserRestrictedHeader('CONTENT-LENGTH', '123')).toBe(true);
    expect(isBrowserRestrictedHeader('content-length', '123')).toBe(true);
    expect(isBrowserRestrictedHeader('Content-Length', '123')).toBe(true);
  });

  test('prefix check is case-insensitive for the key', () => {
    expect(isBrowserRestrictedHeader('SEC-Fetch-Site', 'same-origin')).toBe(
      true,
    );
    expect(isBrowserRestrictedHeader('PROXY-Authorization', 'Basic abc')).toBe(
      true,
    );
  });

  test('returns false for non-restricted headers', () => {
    expect(isBrowserRestrictedHeader('Authorization', 'Bearer token')).toBe(
      false,
    );
    expect(isBrowserRestrictedHeader('Content-Type', 'application/json')).toBe(
      false,
    );
  });

  test('detects forbidden method-override header values', () => {
    expect(isBrowserRestrictedHeader('X-HTTP-Method-Override', 'TRACE')).toBe(
      true,
    );
    expect(isBrowserRestrictedHeader('X-HTTP-Method-Override', 'CONNECT')).toBe(
      true,
    );
    expect(isBrowserRestrictedHeader('X-Method-Override', 'TRACK')).toBe(true);
  });

  test('detects forbidden method in a comma-separated method-override value', () => {
    expect(
      isBrowserRestrictedHeader('X-HTTP-Method-Override', 'GET, TRACE'),
    ).toBe(true);
  });

  test('allows safe method-override header values', () => {
    expect(isBrowserRestrictedHeader('X-HTTP-Method', 'PATCH')).toBe(false);
    expect(isBrowserRestrictedHeader('X-HTTP-Method-Override', 'PUT')).toBe(
      false,
    );
  });

  test('method-override check is case-insensitive for the value', () => {
    expect(isBrowserRestrictedHeader('X-HTTP-Method-Override', 'trace')).toBe(
      true,
    );
    expect(isBrowserRestrictedHeader('X-HTTP-Method-Override', 'Trace')).toBe(
      true,
    );
  });

  test('method-override header without a value is not restricted', () => {
    expect(isBrowserRestrictedHeader('X-HTTP-Method-Override', undefined)).toBe(
      false,
    );
  });
});

describe('assertNoBrowserRestrictedHeaders', () => {
  test('throws with a helpful message for a restricted header', () => {
    expect(() =>
      assertNoBrowserRestrictedHeaders(
        { 'sec-fetch-site': 'same-origin' },
        'FetchAdapter',
      ),
    ).toThrow(/browser-restricted header "sec-fetch-site"/);
  });

  test('includes the adapter name in the error message', () => {
    expect(() =>
      assertNoBrowserRestrictedHeaders({ 'content-length': '0' }, 'XhrAdapter'),
    ).toThrow(/\[XhrAdapter\]/);
  });

  test('does not throw when no restricted headers are present', () => {
    expect(() =>
      assertNoBrowserRestrictedHeaders(
        { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
        'FetchAdapter',
      ),
    ).not.toThrow();
  });

  test('does not throw for an empty headers object', () => {
    expect(() =>
      assertNoBrowserRestrictedHeaders({}, 'FetchAdapter'),
    ).not.toThrow();
  });
});

describe('isJSONContentType', () => {
  test('returns true for application/json', () => {
    expect(isJSONContentType('application/json')).toBe(true);
  });

  test('returns true for application/json with charset', () => {
    expect(isJSONContentType('application/json; charset=utf-8')).toBe(true);
  });

  test('returns true for +json vendor types', () => {
    expect(isJSONContentType('application/vnd.api+json')).toBe(true);
  });

  test('returns false for non-JSON types', () => {
    expect(isJSONContentType('text/plain')).toBe(false);
    expect(isJSONContentType('application/xml')).toBe(false);
  });

  test('returns false for undefined', () => {
    expect(isJSONContentType(undefined)).toBe(false);
  });

  test('is case-insensitive', () => {
    expect(isJSONContentType('Application/JSON')).toBe(true);
  });
});

describe('isTextContentType', () => {
  test('returns true for text/plain', () => {
    expect(isTextContentType('text/plain')).toBe(true);
  });

  test('returns true for text/html', () => {
    expect(isTextContentType('text/html')).toBe(true);
  });

  test('returns true for text/csv', () => {
    expect(isTextContentType('text/csv')).toBe(true);
  });

  test('returns false for application/json', () => {
    expect(isTextContentType('application/json')).toBe(false);
  });

  test('returns false for undefined', () => {
    expect(isTextContentType(undefined)).toBe(false);
  });

  test('is case-insensitive', () => {
    expect(isTextContentType('Text/Plain')).toBe(true);
  });
});
