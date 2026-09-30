import { expect, test } from 'bun:test';
import { HTTPClient } from './http-client';
import type { HTTPAdapter, SubClientConfig } from './types';
import { CookieJar } from './cookie-jar';

test.each(['own', 'inherited', 'non-enumerable'] as const)(
  'sub-client reads all %s overrides once with their original receiver',
  (placement) => {
    const parentAdapter: HTTPAdapter = {
      getType: () => 'node',
      send: () => Promise.resolve({ status: 200, headers: {}, body: null }),
    };
    const adapter = { ...parentAdapter };
    const parent = new HTTPClient({
      adapter: parentAdapter,
      timeout: 1000,
      defaultHeaders: { 'x-parent': 'parent' },
      cookieJar: new CookieJar(),
      followRedirects: true,
      maxRedirects: 8,
    });
    const values = {
      adapter,
      timeout: 0,
      defaultHeaders: { 'x-child': 'child' },
      defaultHeadersStrategy: 'merge',
      cookieJar: null,
      followRedirects: true,
      maxRedirects: 3,
      baseURL: 'https://child.example/',
      retryPolicy: { strategy: 'fixed', delayMS: 5, maxRetryAttempts: 1 },
      retryNonIdempotentMethods: true,
      includeRequestID: true,
      includeAttemptHeader: true,
      userAgent: 'child-agent',
    } satisfies SubClientConfig;
    const owner = {};
    const overrides = (
      placement === 'inherited' ? Object.create(owner) : owner
    ) as SubClientConfig;
    const reads: Record<string, number> = {};
    for (const [key, value] of Object.entries(values)) {
      Object.defineProperty(owner, key, {
        enumerable: placement !== 'non-enumerable',
        get() {
          expect(this).toBe(overrides);
          reads[key] = (reads[key] ?? 0) + 1;
          if (reads[key] > 1) {
            throw new Error('override read twice');
          }
          return value;
        },
      });
    }
    const child = parent.createSubClient(overrides);
    const config = (child as unknown as { _config: Record<string, unknown> })
      ._config;
    expect(config.adapter).toBe(adapter);
    expect(config.timeout).toBe(0);
    expect(config.defaultHeaders).toEqual({
      'x-parent': 'parent',
      'x-child': 'child',
    });
    expect(config.cookieJar).toBeNull();
    expect(config.followRedirects).toBe(true);
    expect(config.maxRedirects).toBe(3);
    for (const key of [
      'baseURL',
      'retryPolicy',
      'retryNonIdempotentMethods',
      'includeRequestID',
      'includeAttemptHeader',
      'userAgent',
    ] as const) {
      expect(config[key]).toEqual(values[key]);
    }
    expect(reads).toEqual(
      Object.fromEntries(Object.keys(values).map((key) => [key, 1])),
    );
  },
);

test.each([null, undefined, 0, 250])(
  'sub-client timeout override %s inherits only when nullish',
  async (timeout) => {
    const adapter: HTTPAdapter = {
      getType: () => 'node',
      send: () => Promise.resolve({ status: 200, headers: {}, body: null }),
    };
    const parent = new HTTPClient({ adapter, timeout: 1000 });
    const child = parent.createSubClient({ timeout });
    const config = (child as unknown as { _config: { timeout: number } })
      ._config;
    expect(config.timeout).toBe(timeout ?? 1000);
    expect((await child.get('https://example.com/').send()).status).toBe(200);
  },
);

test.each(['own', 'inherited', 'non-enumerable'] as const)(
  'undefined %s getters are read once and inherit parent values',
  (placement) => {
    const parent = new HTTPClient({
      timeout: 1000,
      defaultHeaders: { 'x-parent': 'parent' },
      cookieJar: new CookieJar(),
      followRedirects: true,
      maxRedirects: 8,
    });
    const owner = {};
    const overrides = (
      placement === 'inherited' ? Object.create(owner) : owner
    ) as SubClientConfig;
    const reads: Record<string, number> = {};
    for (const key of [
      'adapter',
      'timeout',
      'defaultHeaders',
      'defaultHeadersStrategy',
      'cookieJar',
      'followRedirects',
      'maxRedirects',
      'baseURL',
      'retryPolicy',
      'retryNonIdempotentMethods',
      'includeRequestID',
      'includeAttemptHeader',
      'userAgent',
    ]) {
      Object.defineProperty(owner, key, {
        enumerable: placement !== 'non-enumerable',
        get() {
          reads[key] = (reads[key] ?? 0) + 1;
          if (reads[key] > 1) {
            throw new Error('undefined override read twice');
          }
          return undefined;
        },
      });
    }
    const child = parent.createSubClient(overrides);
    const configOf = (client: unknown) =>
      (client as { _config: unknown })._config;
    expect(configOf(child)).toEqual(configOf(parent));
    expect(Object.values(reads)).toEqual(Array.from({ length: 13 }, () => 1));
  },
);

test('undefined sub-client overrides inherit configured values', () => {
  const parent = new HTTPClient({
    baseURL: 'https://example.com/',
    userAgent: 'parent',
    includeRequestID: true,
    retryNonIdempotentMethods: true,
    retryPolicy: { strategy: 'fixed', delayMS: 10 },
  });
  const child = parent.createSubClient({
    baseURL: undefined,
    userAgent: undefined,
    includeRequestID: undefined,
    retryNonIdempotentMethods: undefined,
    retryPolicy: undefined,
  });
  const configOf = (client: unknown) =>
    (client as { _config: Record<string, unknown> })._config;
  for (const key of [
    'baseURL',
    'userAgent',
    'includeRequestID',
    'retryNonIdempotentMethods',
    'retryPolicy',
  ]) {
    expect(configOf(child)[key]).toEqual(configOf(parent)[key]);
  }
});
