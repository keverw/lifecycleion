import { describe, expect, test } from 'bun:test';
import { HTTPClient } from './http-client';
import { parseRetryAfterMS } from './internal/retry-after';
import type {
  AdapterResponse,
  AttemptEndEvent,
  HTTPAdapter,
  HTTPRetryPolicyOptions,
} from './types';

const NOW = Date.UTC(2026, 10, 8, 12, 0, 0);

describe('parseRetryAfterMS', () => {
  test.each([
    ['120', 120_000],
    ['0', 0],
    [' \t5 ', 5000],
    ['Sun, 08 Nov 2026 12:00:30 GMT', 30_000],
    ['Sunday, 08-Nov-26 12:00:30 GMT', 30_000],
    ['Sun Nov  8 12:00:30 2026', 30_000],
    ['Sun Nov 08 12:00:30 2026', 30_000],
    // Already past: no wait.
    ['Sun, 06 Nov 1994 08:49:37 GMT', 0],
    // A two-digit year more than 50 years ahead is the last century's.
    ['Sunday, 06-Nov-94 08:49:37 GMT', 0],
    // Repeated values that agree, as `fetch` joins a header seen twice.
    ['120, 120', 120_000],
    ['5,5 ,\t5', 5000],
    ['Sun, 08 Nov 2026 12:00:30 GMT, Sun, 08 Nov 2026 12:00:30 GMT', 30_000],
    // A leap second is the second after it.
    ['Sun, 08 Nov 2026 23:59:60 GMT', Date.UTC(2026, 10, 9) - NOW],
  ])('%p asks for %p ms', (value, expected) => {
    expect(parseRetryAfterMS(value, NOW)).toBe(expected);
  });

  test.each([
    undefined,
    '',
    '1.5',
    '-1',
    '+5',
    '120, 60',
    'Sun, 08 Nov 2026 12:00:30 GMT, Sun, 08 Nov 2026 12:00:31 GMT',
    '120,',
    // A second past :59 is only a leap second at 23:59.
    'Sun, 08 Nov 2026 12:00:60 GMT',
    '1e3',
    'soon',
    // Case-sensitive, as RFC 9110 defines it.
    'sun, 08 Nov 2026 12:00:30 GMT',
    'Sun, 08 nov 2026 12:00:30 GMT',
    // No such day or time.
    'Sat, 31 Feb 2026 12:00:00 GMT',
    'Sun, 08 Nov 2026 24:00:00 GMT',
    // Not GMT.
    'Sun, 08 Nov 2026 12:00:30 PST',
    // A date `Date.parse` reads, but no HTTP-date.
    '2026-11-08T12:00:30Z',
  ])('%p is unreadable', (value) => {
    expect(parseRetryAfterMS(value, NOW)).toBeUndefined();
  });

  test('an RFC 850 year is read back a century only when more than 50 years ahead, to the moment', () => {
    const newYear2026 = Date.UTC(2026, 0, 1);

    // 2076-01-01 is exactly 50 years on, so it stays; 2076-12-31 is past it, so 1976.
    expect(
      parseRetryAfterMS('Wednesday, 01-Jan-76 00:00:00 GMT', newYear2026),
    ).toBe(Date.UTC(2076, 0, 1) - newYear2026);
    expect(
      parseRetryAfterMS('Thursday, 31-Dec-76 00:00:00 GMT', newYear2026),
    ).toBe(0);
  });

  test('an RFC 850 year is read in the next century when that is within 50 years', () => {
    const newYear2080 = Date.UTC(2080, 0, 1);

    // 2005 is past, 2105 only 25 years on: RFC 9110 reads it as 2105.
    expect(
      parseRetryAfterMS('Monday, 01-Jan-05 00:00:00 GMT', newYear2080),
    ).toBe(Date.UTC(2105, 0, 1) - newYear2080);
  });

  test('a four-digit year below 100 is that year, not 19xx', () => {
    // Read as 1950 it would be past from a `now` of 1900; as 0050 it is past either way.
    const in1900 = Date.UTC(1900, 0, 1);

    expect(parseRetryAfterMS('Sat, 01 Jan 0050 00:00:00 GMT', in1900)).toBe(0);
    expect(parseRetryAfterMS('Mon, 01 Jan 1900 00:00:30 GMT', in1900)).toBe(
      30_000,
    );
  });
});

/**
 * A client whose adapter answers `first` and then `200`, and how many requests it made.
 */
function clientAnswering(
  first: { status: number; retryAfter?: string | string[] },
  retryPolicy: HTTPRetryPolicyOptions,
): {
  client: HTTPClient;
  calls: () => number;
} {
  let callCount = 0;
  const adapter: HTTPAdapter = {
    getType: () => 'mock',
    send: (): Promise<AdapterResponse> => {
      callCount++;

      if (callCount === 1) {
        const headers: Record<string, string | string[]> = {};
        if (first.retryAfter !== undefined) {
          headers['retry-after'] = first.retryAfter;
        }

        return Promise.resolve({
          status: first.status,
          headers,
          body: null,
        });
      }

      return Promise.resolve({ status: 200, headers: {}, body: null });
    },
  };

  return {
    client: new HTTPClient({
      adapter,
      baseURL: 'https://api.test',
      retryPolicy,
    }),
    calls: () => callCount,
  };
}

/**
 * The delay the first attempt's end schedules for `first`, and the request cancelled
 * right after, so no test waits it out.
 */
async function scheduledDelay(
  first: { status: number; retryAfter?: string | string[] },
  retryPolicy: HTTPRetryPolicyOptions,
): Promise<AttemptEndEvent> {
  const { client } = clientAnswering(first, retryPolicy);
  const builder = client.get('/x');
  let firstEnd: AttemptEndEvent | undefined;

  await builder
    .onAttemptEnd((event) => {
      firstEnd ??= event;
      builder.cancel();
    })
    .send();

  if (firstEnd === undefined) {
    throw new Error('no attempt ended');
  }

  return firstEnd;
}

describe('HTTPClient and Retry-After', () => {
  const fixed = {
    strategy: 'fixed',
    maxRetryAttempts: 2,
    delayMS: 10,
  } as const;

  test.each([429, 503])(
    'a %p waits as long as its Retry-After asks, within the cap',
    async (status) => {
      const event = await scheduledDelay({ status, retryAfter: '5' }, fixed);

      expect(event.willRetry).toBe(true);
      expect(event.nextRetryDelayMS).toBe(5000);
      expect(event.retrySuppressedReason).toBeUndefined();
    },
  );

  test("a Retry-After shorter than the policy's delay keeps the policy's", async () => {
    const event = await scheduledDelay(
      { status: 503, retryAfter: '1' },
      { strategy: 'fixed', maxRetryAttempts: 2, delayMS: 4000 },
    );

    expect(event.nextRetryDelayMS).toBe(4000);
  });

  test.each([
    ['a 500', { status: 500, retryAfter: '5' }],
    ['an unreadable value', { status: 503, retryAfter: '5 seconds' }],
    ['no header', { status: 503 }],
  ])("%s keeps the policy's delay", async (_label, first) => {
    const event = await scheduledDelay(first, fixed);

    expect(event.willRetry).toBe(true);
    expect(event.nextRetryDelayMS).toBe(10);
  });

  test.each([
    [['5', '5'], 5000],
    [['5', '86400'], 5000],
  ])(
    'a Retry-After an adapter hands over as %p is read by its first value, as Node reads a repeated one: %p ms',
    async (retryAfter, expected) => {
      const event = await scheduledDelay({ status: 503, retryAfter }, fixed);

      expect(event.willRetry).toBe(true);
      expect(event.nextRetryDelayMS).toBe(expected);
    },
  );

  test('a Retry-After past the cap is not retried, and the answer is returned', async () => {
    const { client, calls } = clientAnswering(
      { status: 429, retryAfter: '31' },
      fixed,
    );
    const events: AttemptEndEvent[] = [];
    const response = await client
      .get('/x')
      .onAttemptEnd((event) => events.push(event))
      .send();

    expect(calls()).toBe(1);
    expect(response.status).toBe(429);
    expect(events).toHaveLength(1);
    expect(events[0].willRetry).toBe(false);
    expect(events[0].nextRetryDelayMS).toBeUndefined();
    expect(events[0].retrySuppressedReason).toBe('retry_after_too_long');
  });

  test("the exponential strategy's cap is its maxTimeoutMS", async () => {
    const policy = {
      strategy: 'exponential',
      maxRetryAttempts: 2,
      minTimeoutMS: 10,
      maxTimeoutMS: 2000,
    } as const;

    expect(
      (await scheduledDelay({ status: 503, retryAfter: '2' }, policy))
        .nextRetryDelayMS,
    ).toBe(2000);
    expect(
      (await scheduledDelay({ status: 503, retryAfter: '3' }, policy))
        .retrySuppressedReason,
    ).toBe('retry_after_too_long');
  });

  test('maxRetryAfterMS sets the cap on either strategy', async () => {
    expect(
      (
        await scheduledDelay(
          { status: 429, retryAfter: '60' },
          { ...fixed, maxRetryAfterMS: 120_000 },
        )
      ).nextRetryDelayMS,
    ).toBe(60_000);
    expect(
      (
        await scheduledDelay(
          { status: 429, retryAfter: '60' },
          {
            strategy: 'exponential',
            maxRetryAttempts: 2,
            minTimeoutMS: 10,
            maxTimeoutMS: 20,
            maxRetryAfterMS: 60_000,
          },
        )
      ).nextRetryDelayMS,
    ).toBe(60_000);
    // `0` waits for no Retry-After but `0`.
    expect(
      (
        await scheduledDelay(
          { status: 429, retryAfter: '1' },
          { ...fixed, maxRetryAfterMS: 0 },
        )
      ).retrySuppressedReason,
    ).toBe('retry_after_too_long');
    expect(
      (
        await scheduledDelay(
          { status: 429, retryAfter: '0' },
          { ...fixed, maxRetryAfterMS: 0 },
        )
      ).nextRetryDelayMS,
    ).toBe(10);
  });

  test('a policy with no retries left reports no Retry-After reason', async () => {
    let callCount = 0;
    const adapter: HTTPAdapter = {
      getType: () => 'mock',
      send: () => {
        callCount++;
        return Promise.resolve({
          status: 503,
          headers: { 'retry-after': callCount === 1 ? '0' : '60' },
          body: null,
        });
      },
    };
    const events: AttemptEndEvent[] = [];
    await new HTTPClient({
      adapter,
      baseURL: 'https://api.test',
      retryPolicy: { strategy: 'fixed', maxRetryAttempts: 1, delayMS: 1 },
    })
      .get('/x')
      .onAttemptEnd((event) => events.push(event))
      .send();

    expect(events.map((event) => event.willRetry)).toEqual([true, false]);
    expect(events[1].retrySuppressedReason).toBeUndefined();
  });

  test('the retry goes out once the Retry-After wait has passed', async () => {
    const { client, calls } = clientAnswering(
      { status: 503, retryAfter: '1' },
      { strategy: 'fixed', maxRetryAttempts: 2, delayMS: 1 },
    );
    const startedAt = performance.now();
    const response = await client.get('/x').send();

    expect(response.status).toBe(200);
    expect(calls()).toBe(2);
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(990);
  });

  test.each([-1, Number.NaN, '30' as unknown as number])(
    'a maxRetryAfterMS of %p is refused',
    (maxRetryAfterMS) => {
      expect(
        () =>
          new HTTPClient({
            retryPolicy: { ...fixed, maxRetryAfterMS },
          }),
      ).toThrow(/maxRetryAfterMS/);
    },
  );
});
