import { afterEach, describe, expect, test } from 'bun:test';
import { compareResponseURL, isRespelledURL } from './response-url';

const originalLocation = Object.getOwnPropertyDescriptor(
  globalThis,
  'location',
);

function setPage(href: string | undefined): void {
  if (href === undefined) {
    delete (globalThis as Record<string, unknown>).location;
    return;
  }

  Object.defineProperty(globalThis, 'location', {
    value: { href, origin: new URL(href).origin },
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  if (originalLocation) {
    Object.defineProperty(globalThis, 'location', originalLocation);
  } else {
    delete (globalThis as Record<string, unknown>).location;
  }
});

// [label, dispatched URL, response URL, kind off a page, kind in a page]
type Kind = 'same' | 'redirected';

const SPELLINGS: Array<[string, string, string, Kind, Kind]> = [
  [
    'the same URL',
    'https://h.test/a?q=1',
    'https://h.test/a?q=1',
    'same',
    'same',
  ],
  ['a fragment', 'https://h.test/a#f', 'https://h.test/a', 'same', 'same'],
  [
    'a default port',
    'https://h.test:443/a',
    'https://h.test/a',
    'same',
    'same',
  ],
  [
    'escape hex case',
    'https://h.test/a%2fb',
    'https://h.test/a%2Fb',
    'same',
    'redirected',
  ],
  [
    'an escaped unreserved character',
    'https://h.test/a%7Eb',
    'https://h.test/a~b',
    'same',
    'redirected',
  ],
  [
    'an escaped letter',
    'https://h.test/%61dmin',
    'https://h.test/admin',
    'same',
    'redirected',
  ],
  [
    'an escaped pipe in the path',
    'https://h.test/a|b',
    'https://h.test/a%7Cb',
    'same',
    'redirected',
  ],
  [
    'escaped brackets in the query',
    'https://h.test/i?f[x]=1',
    'https://h.test/i?f%5Bx%5D=1',
    'same',
    'redirected',
  ],
  [
    'escaped braces, caret and backtick in the query',
    'https://h.test/i?a={^`}',
    'https://h.test/i?a=%7B%5E%60%7D',
    'same',
    'redirected',
  ],
  [
    'an escaped slash against a slash',
    'https://h.test/a%2Fb',
    'https://h.test/a/b',
    'redirected',
    'redirected',
  ],
  [
    'an escaped sub-delimiter, which the RFC keeps apart',
    'https://h.test/i?a=!',
    'https://h.test/i?a=%21',
    'redirected',
    'redirected',
  ],
  [
    'an empty query added',
    'https://h.test/a',
    'https://h.test/a?',
    'redirected',
    'redirected',
  ],
  [
    'an empty query dropped',
    'https://h.test/a?',
    'https://h.test/a',
    'redirected',
    'redirected',
  ],
  [
    'another path',
    'https://h.test/a',
    'https://h.test/b',
    'redirected',
    'redirected',
  ],
  [
    'a response URL that does not parse',
    'https://h.test/a',
    'not a url',
    'redirected',
    'redirected',
  ],
];

describe('compareResponseURL', () => {
  test.each(SPELLINGS)(
    'off a browser page: %s',
    (_label, dispatched, response, offPage) => {
      setPage(undefined);
      expect(compareResponseURL(response, dispatched).kind).toBe(offPage);
    },
  );

  test.each(SPELLINGS)(
    'in a browser page, where the browser reports its own spelling: %s',
    (_label, dispatched, response, _offPage, inPage) => {
      setPage('https://app.test/');
      expect(compareResponseURL(response, dispatched).kind).toBe(inPage);
    },
  );

  test("an https: page's upgrade of an http: request is no redirect", () => {
    setPage('https://app.test/');
    expect(compareResponseURL('https://h.test/a', 'http://h.test/a#f')).toEqual(
      {
        kind: 'upgraded',
        upgradedURL: 'https://h.test/a#f',
      },
    );
  });

  test('an upgrade off an https: page, or of a loopback host, is a redirect', () => {
    setPage('http://app.test/');
    expect(compareResponseURL('https://h.test/a', 'http://h.test/a').kind).toBe(
      'redirected',
    );
    setPage('https://app.test/');
    expect(
      compareResponseURL('https://localhost/a', 'http://localhost/a').kind,
    ).toBe('redirected');
  });
});

describe('isRespelledURL', () => {
  test.each([
    ['an escaped pipe', 'https://h.test/a%7Cb', 'https://h.test/a|b', true],
    ['lowercase hex', 'https://h.test/a%c3%a9', 'https://h.test/a%C3%A9', true],
    ['an escaped slash', 'https://h.test/a%2Fb', 'https://h.test/a/b', true],
    [
      'the fragment and userinfo aside',
      'https://h.test/a%7Cb',
      'https://u:p@h.test/a|b#f',
      true,
    ],
    ['the same spelling', 'https://h.test/a|b', 'https://h.test/a|b', false],
    [
      'the same once parsed',
      'https://h.test/a/../a|b',
      'https://h.test/a|b',
      false,
    ],
    ['another path', 'https://h.test/landing', 'https://h.test/a|b', false],
    ['another host', 'https://g.test/a%7Cb', 'https://h.test/a|b', false],
    ['an empty query', 'https://h.test/a%7Cb?', 'https://h.test/a|b', false],
    ['an unparsable URL', 'http://[', 'https://h.test/a|b', false],
    ['a relative URL', '/a%7Cb', 'https://h.test/a|b', true],
  ])('%s: %p against %p is %p', (_label, reported, request, isExpected) => {
    setPage(undefined);
    expect(isRespelledURL(reported, request)).toBe(isExpected);
  });

  test('is false in a browser page, which reports its own spelling', () => {
    setPage('https://h.test/');
    expect(isRespelledURL('https://h.test/a%7Cb', 'https://h.test/a|b')).toBe(
      false,
    );
  });
});
