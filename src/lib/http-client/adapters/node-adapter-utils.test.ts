import { describe, expect, test } from 'bun:test';
import {
  materializeNodeRequestHeaders,
  normalizeNodeRequestHeaders,
} from './node-adapter-utils';

describe('normalizeNodeRequestHeaders', () => {
  test('lowercases keys and coerces scalars to strings', () => {
    expect(
      normalizeNodeRequestHeaders({
        'Content-Type': 'application/json',
        'X-Count': 3,
      }),
    ).toEqual({
      'content-type': 'application/json',
      'x-count': '3',
    });
  });

  test('preserves array values', () => {
    expect(
      normalizeNodeRequestHeaders({
        Accept: ['application/json', 'text/plain'],
      }),
    ).toEqual({
      accept: ['application/json', 'text/plain'],
    });
  });

  test('skips undefined values and lets last lowercase key win', () => {
    expect(
      normalizeNodeRequestHeaders({
        Authorization: 'Bearer a',
        authorization: 'Bearer b',
        'X-Skip': undefined,
      }),
    ).toEqual({
      authorization: 'Bearer b',
    });
  });
});

describe('materializeNodeRequestHeaders', () => {
  test('joins repeated Cookie headers with RFC cookie delimiters', () => {
    expect(
      materializeNodeRequestHeaders({
        cookie: ['session=abc123', 'theme=dark'],
      }),
    ).toEqual({
      cookie: 'session=abc123; theme=dark',
    });
  });

  test('joins non-cookie arrays with comma delimiters', () => {
    expect(
      materializeNodeRequestHeaders({
        accept: ['application/json', 'text/plain'],
      }),
    ).toEqual({
      accept: 'application/json, text/plain',
    });
  });
});
