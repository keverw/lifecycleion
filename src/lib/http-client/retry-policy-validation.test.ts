import { expect, test } from 'bun:test';
import { HTTPClient } from './http-client';
import { MockAdapter } from './adapters/mock-adapter';
import { snapshotRetryPolicyOptions } from './internal/retry-policy-options';
import type { RetryPolicyOptions } from '../retry-utils';

test('sub-clients reuse only immutable validated retry snapshots', () => {
  const callerPolicy = {
    strategy: 'fixed' as const,
    delayMS: 5,
    maxRetryAttempts: 1,
  };
  const parent = new HTTPClient({ retryPolicy: callerPolicy });
  const child = parent.createSubClient();
  const policyOf = (client: unknown) =>
    (client as { _config: { retryPolicy: RetryPolicyOptions } })._config
      .retryPolicy;
  const validated = policyOf(parent);
  expect(policyOf(child)).toBe(validated);
  expect(validated).not.toBe(callerPolicy);
  expect(Object.isFrozen(validated)).toBe(true);
  callerPolicy.delayMS = NaN;
  expect(policyOf(child)).toEqual({
    strategy: 'fixed',
    delayMS: 5,
    maxRetryAttempts: 1,
  });
  expect(() => Reflect.set(validated, 'delayMS', NaN)).not.toThrow();
  expect(Reflect.set(validated, 'delayMS', NaN)).toBe(false);
  expect(() => parent.createSubClient({ retryPolicy: callerPolicy })).toThrow(
    TypeError,
  );
  expect(() =>
    snapshotRetryPolicyOptions(
      Object.freeze({ strategy: 'fixed', delayMS: NaN }),
    ),
  ).toThrow(TypeError);
  expect(snapshotRetryPolicyOptions(validated)).toBe(validated);
});

test('inherited null retry policy disables parent retries', () => {
  const parent = new HTTPClient({
    retryPolicy: { strategy: 'fixed', delayMS: 5 },
  });
  const child = parent.createSubClient(Object.create({ retryPolicy: null }));
  expect(
    (child as unknown as { _config: { retryPolicy: unknown } })._config
      .retryPolicy,
  ).toBeUndefined();
});

test('invalid client retry policy fails before requests or interceptors', () => {
  const adapter = new MockAdapter();
  expect(
    () =>
      new HTTPClient({
        adapter,
        retryPolicy: { strategy: 'fixed', delayMS: NaN },
      }),
  ).toThrow(TypeError);
});

test('invalid builder retry policy fails at the setter', () => {
  const adapter = new MockAdapter();
  const client = new HTTPClient({ adapter });
  let intercepted = 0;
  client.addRequestInterceptor((request) => {
    intercepted++;
    return request;
  });
  const builder = client.get('/test');
  expect(() =>
    builder.retryPolicy({ strategy: 'fixed', delayMS: NaN }),
  ).toThrow(TypeError);
  expect(intercepted).toBe(0);
  expect(() =>
    client.get('/test', {
      retryPolicy: { strategy: 'fixed', delayMS: NaN },
    }),
  ).toThrow(TypeError);
  expect(intercepted).toBe(0);
});

test('client policy is snapshotted and each request gets a fresh retry budget', async () => {
  const adapter = new MockAdapter();
  let attempts = 0;
  adapter.routes.get('/retry', () => {
    attempts++;
    return { status: 503 };
  });
  const policy = {
    strategy: 'fixed' as const,
    maxRetryAttempts: 1,
    delayMS: 0,
  };
  const client = new HTTPClient({ adapter, retryPolicy: policy });
  policy.maxRetryAttempts = 9;
  policy.delayMS = NaN;

  await client.get('/retry').send();
  expect(attempts).toBe(2);
  await client.get('/retry').send();
  expect(attempts).toBe(4);
});

test('builder policy snapshot overrides client; null disables retries', async () => {
  const adapter = new MockAdapter();
  let attempts = 0;
  adapter.routes.get('/retry', () => {
    attempts++;
    return { status: 503 };
  });
  const client = new HTTPClient({
    adapter,
    retryPolicy: { strategy: 'fixed', maxRetryAttempts: 3, delayMS: 0 },
  });
  const policy = {
    strategy: 'fixed' as const,
    maxRetryAttempts: 1,
    delayMS: 0,
  };
  const builder = client.get('/retry').retryPolicy(policy);
  policy.maxRetryAttempts = 9;
  policy.delayMS = NaN;
  await builder.send();
  expect(attempts).toBe(2);

  await client.get('/retry').retryPolicy(null).send();
  expect(attempts).toBe(3);
});

test('client config retry policy getter is read once', async () => {
  const adapter = new MockAdapter();
  let reads = 0;
  const config = {
    adapter,
    get retryPolicy() {
      reads++;
      return reads === 1
        ? ({ strategy: 'fixed', maxRetryAttempts: 0, delayMS: 0 } as const)
        : ({ strategy: 'fixed', delayMS: NaN } as const);
    },
  };
  const client = new HTTPClient(config);
  adapter.routes.get('/ok', () => ({ status: 200 }));
  expect((await client.get('/ok').send()).status).toBe(200);
  expect(reads).toBe(1);
});

test.each(['override', 'disable'] as const)(
  'builder options captures the first retry policy value to %s inherited retries',
  async (mode) => {
    const adapter = new MockAdapter();
    let attempts = 0;
    adapter.routes.get('/retry', () => {
      attempts++;
      return { status: 503 };
    });
    const client = new HTTPClient({
      adapter,
      retryPolicy: { strategy: 'fixed', maxRetryAttempts: 3, delayMS: 0 },
    });
    let reads = 0;
    const request = client.get('/retry', {
      get retryPolicy() {
        reads++;
        if (reads > 1) {
          return undefined;
        }
        return mode === 'disable'
          ? null
          : ({ strategy: 'fixed', maxRetryAttempts: 1, delayMS: 0 } as const);
      },
    });

    await request.send();

    expect(attempts).toBe(mode === 'disable' ? 1 : 2);
    expect(request.attemptCount).toBe(attempts);
    expect(reads).toBe(1);
  },
);

test.each(['client', 'builder'] as const)(
  '%s snapshots normalized exponential getter options once',
  async (boundary) => {
    const adapter = new MockAdapter();
    adapter.routes.get('/retry', () => ({ status: 503 }));
    let strategyReads = 0;
    let factorReads = 0;
    const policy = {
      get strategy(): 'exponential' {
        strategyReads++;
        return 'exponential';
      },
      get factor() {
        return ++factorReads === 1 ? 2 : NaN;
      },
      maxRetryAttempts: 1,
      minTimeoutMS: 1,
      maxTimeoutMS: 1,
      dispersion: 0,
    };
    const client = new HTTPClient({
      adapter,
      ...(boundary === 'client' ? { retryPolicy: policy } : {}),
    });
    const request = client.get('/retry');
    if (boundary === 'builder') {
      request.retryPolicy(policy);
    }
    expect(strategyReads).toBe(1);
    expect(factorReads).toBe(1);
    await request.send();
    expect(request.attemptCount).toBe(2);
    expect(strategyReads).toBe(1);
    expect(factorReads).toBe(1);
  },
);
