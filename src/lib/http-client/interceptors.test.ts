import { describe, test, expect } from 'bun:test';
import { RequestInterceptorManager, isInterceptorCancel } from './interceptors';
import type {
  InterceptedRequest,
  RequestPhase,
  RequestInterceptorContext,
} from './types';

function makeRequest(
  overrides: Partial<InterceptedRequest> = {},
): InterceptedRequest {
  return {
    requestURL: 'https://example.com/api',
    method: 'GET',
    headers: {},
    ...overrides,
  };
}

function makeContext(
  overrides: Partial<RequestInterceptorContext> = {},
): RequestInterceptorContext {
  return {
    initialURL: 'https://example.com/api',
    redirectHistory: [],
    requestID: 'test-request-id',
    attemptNumber: 1,
    ...overrides,
  };
}

describe('RequestInterceptorManager', () => {
  test('a snapshot chain rejects rather than throwing synchronously', async () => {
    const mgr = new RequestInterceptorManager();
    const failure = new Error('interceptor failed');
    mgr.add(() => {
      throw failure;
    });
    const chain = mgr.snapshot();

    let returned: Promise<unknown> | undefined;

    expect(() => {
      returned = chain(makeRequest(), { type: 'initial' }, makeContext());
    }).not.toThrow();
    expect(
      await returned?.then(
        () => 'resolved',
        (error: unknown) => error,
      ),
    ).toBe(failure);
  });

  test('changes during an awaited callback apply to the next snapshot', async () => {
    const mgr = new RequestInterceptorManager();
    const calls: number[] = [];
    const remove = mgr.add(async (request) => {
      calls.push(1);
      await Promise.resolve();
      remove();
      mgr.add((next) => {
        calls.push(3);
        return next;
      });
      return request;
    });
    mgr.add((request) => {
      calls.push(2);
      return request;
    });
    await mgr.snapshot()(makeRequest(), { type: 'initial' }, makeContext());
    expect(calls).toEqual([1, 2]);
    calls.length = 0;
    await mgr.snapshot()(makeRequest(), { type: 'initial' }, makeContext());
    expect(calls).toEqual([2, 3]);
  });

  test('runs interceptors in order', async () => {
    const mgr = new RequestInterceptorManager();
    const order: number[] = [];

    mgr.add((req) => {
      order.push(1);
      return req;
    });
    mgr.add((req) => {
      order.push(2);
      return req;
    });
    mgr.add((req) => {
      order.push(3);
      return req;
    });

    await mgr.snapshot()(makeRequest(), { type: 'initial' }, makeContext());
    expect(order).toEqual([1, 2, 3]);
  });

  test('each interceptor receives the modified request from the prior one', async () => {
    const mgr = new RequestInterceptorManager();

    mgr.add((req) => ({ ...req, headers: { ...req.headers, 'x-step': '1' } }));
    mgr.add((req) => ({ ...req, headers: { ...req.headers, 'x-step': '2' } }));

    const result = await mgr.snapshot()(
      makeRequest(),
      { type: 'initial' },
      makeContext(),
    );
    expect('cancel' in result).toBe(false);

    if (!('cancel' in result)) {
      expect(result.headers['x-step']).toBe('2');
    }
  });

  test('supports async interceptors', async () => {
    const mgr = new RequestInterceptorManager();
    mgr.add(async (req) => {
      await Promise.resolve();
      return { ...req, headers: { ...req.headers, 'x-async': 'yes' } };
    });

    const result = await mgr.snapshot()(
      makeRequest(),
      { type: 'initial' },
      makeContext(),
    );
    expect('cancel' in result).toBe(false);

    if (!('cancel' in result)) {
      expect(result.headers['x-async']).toBe('yes');
    }
  });

  test('remove() unregisters the interceptor', async () => {
    const mgr = new RequestInterceptorManager();
    const calls: number[] = [];
    const remove = mgr.add((req) => {
      calls.push(1);
      return req;
    });

    await mgr.snapshot()(makeRequest(), { type: 'initial' }, makeContext());
    expect(calls).toHaveLength(1);

    remove();
    await mgr.snapshot()(makeRequest(), { type: 'initial' }, makeContext());
    expect(calls).toHaveLength(1);
  });

  test('filter by method — only fires for matching methods', async () => {
    const mgr = new RequestInterceptorManager();
    const calls: string[] = [];

    mgr.add(
      (req) => {
        calls.push(req.method);
        return req;
      },
      { methods: ['POST', 'PUT'] },
    );

    await mgr.snapshot()(
      makeRequest({ method: 'GET' }),
      { type: 'initial' },
      makeContext(),
    );
    expect(calls).toHaveLength(0);

    await mgr.snapshot()(
      makeRequest({ method: 'POST' }),
      { type: 'initial' },
      makeContext(),
    );
    expect(calls).toHaveLength(1);
  });

  test('filter by hosts — matches exact hostname', async () => {
    const mgr = new RequestInterceptorManager();
    const calls: string[] = [];

    mgr.add(
      (req) => {
        calls.push(req.requestURL);
        return req;
      },
      { hosts: ['api.example.com'] },
    );

    await mgr.snapshot()(
      makeRequest({ requestURL: 'https://other.com/api' }),
      {
        type: 'initial',
      },
      makeContext(),
    );
    expect(calls).toHaveLength(0);

    await mgr.snapshot()(
      makeRequest({ requestURL: 'https://api.example.com/users' }),
      {
        type: 'initial',
      },
      makeContext(),
    );
    expect(calls).toHaveLength(1);
  });

  test('filter by hosts — wildcard matching', async () => {
    const mgr = new RequestInterceptorManager();
    const calls: string[] = [];

    mgr.add(
      (req) => {
        calls.push(req.requestURL);
        return req;
      },
      { hosts: ['*.example.com'] },
    );

    await mgr.snapshot()(
      makeRequest({ requestURL: 'https://example.com/api' }),
      {
        type: 'initial',
      },
      makeContext(),
    );
    expect(calls).toHaveLength(0);

    await mgr.snapshot()(
      makeRequest({ requestURL: 'https://api.example.com/users' }),
      {
        type: 'initial',
      },
      makeContext(),
    );
    expect(calls).toHaveLength(1);
  });

  test('default phase filter — only runs on initial phase', async () => {
    const mgr = new RequestInterceptorManager();
    const phases: string[] = [];

    mgr.add((req, phase) => {
      phases.push(phase.type);
      return req;
    });

    await mgr.snapshot()(makeRequest(), { type: 'initial' }, makeContext());
    await mgr.snapshot()(
      makeRequest(),
      {
        type: 'retry',
        attempt: 2,
        maxAttempts: 3,
      },
      makeContext(),
    );
    await mgr.snapshot()(
      makeRequest(),
      {
        type: 'redirect',
        hop: 1,
        from: 'a',
        to: 'b',
        statusCode: 301,
      },
      makeContext(),
    );

    expect(phases).toEqual(['initial']);
  });

  test('explicit phases filter — runs on matching phases', async () => {
    const mgr = new RequestInterceptorManager();
    const phases: string[] = [];

    mgr.add(
      (req, phase) => {
        phases.push(phase.type);
        return req;
      },
      { phases: ['initial', 'retry'] },
    );

    await mgr.snapshot()(makeRequest(), { type: 'initial' }, makeContext());
    await mgr.snapshot()(
      makeRequest(),
      {
        type: 'retry',
        attempt: 2,
        maxAttempts: 3,
      },
      makeContext(),
    );
    await mgr.snapshot()(
      makeRequest(),
      {
        type: 'redirect',
        hop: 1,
        from: 'a',
        to: 'b',
        statusCode: 301,
      },
      makeContext(),
    );

    expect(phases).toEqual(['initial', 'retry']);
  });

  test('an empty phases filter is refused, not read as every phase', () => {
    const mgr = new RequestInterceptorManager();

    // Omitting `phases` gives `['initial']`, so reading `[]` as every phase would turn
    // an interceptor whose phase list came out empty loose on retry and redirect hops.
    expect(() => mgr.add((request) => request, { phases: [] })).toThrow(
      "HTTPClient request interceptor filter phases is empty; omit it for the default phases ('initial'), or list each of 'initial', 'retry', 'redirect' to match every phase",
    );
  });

  test('interceptor can cancel by returning { cancel: true }', async () => {
    const mgr = new RequestInterceptorManager();

    mgr.add(() => ({ cancel: true as const, reason: 'token expired' }));

    const result = await mgr.snapshot()(
      makeRequest(),
      { type: 'initial' },
      makeContext(),
    );
    expect('cancel' in result).toBe(true);

    if ('cancel' in result) {
      expect(result.cancel).toBe(true);
      expect(result.reason).toBe('token expired');
    }
  });

  test('cancel short-circuits — later interceptors do not run', async () => {
    const mgr = new RequestInterceptorManager();
    const calls: number[] = [];

    mgr.add(() => {
      calls.push(1);
      return { cancel: true as const };
    });
    mgr.add((req) => {
      calls.push(2);
      return req;
    });

    await mgr.snapshot()(makeRequest(), { type: 'initial' }, makeContext());
    expect(calls).toEqual([1]);
  });

  test.each([1, 2])(
    'a cancel that lands while interceptor %d of 2 runs ends the chain with a cancel of its own',
    async (cancellingInterceptor) => {
      const mgr = new RequestInterceptorManager();
      const calls: number[] = [];
      let isCancelled = false;
      for (const interceptor of [1, 2]) {
        mgr.add((req) => {
          calls.push(interceptor);
          if (interceptor === cancellingInterceptor) {
            isCancelled = true;
          }
          return { ...req, requestURL: 'https://other.example.com/' };
        });
      }

      const result = await mgr.snapshot()(
        makeRequest(),
        { type: 'initial' },
        makeContext(),
        { isCancelled: () => isCancelled },
      );

      // Not the interceptor's request: the cancel says what happened, and carries no
      // reason of its own, as the caller reads that from whatever cancelled.
      expect(isInterceptorCancel(result)).toBe(true);
      expect(result).toEqual({ cancel: true });
      expect(calls).toEqual(cancellingInterceptor === 1 ? [1] : [1, 2]);
    },
  );

  test.each(['return undefined', 'throw'] as const)(
    'a cancel made while an interceptor runs is answered before its result is read (%s)',
    async (ending) => {
      const mgr = new RequestInterceptorManager();
      let isCancelled = false;
      const failure = new Error('refresh failed');
      mgr.add(() => {
        isCancelled = true;
        if (ending === 'throw') {
          throw failure;
        }
        return undefined as unknown as InterceptedRequest;
      });
      const chain = mgr.snapshot();

      const result = await chain(
        makeRequest(),
        { type: 'initial' },
        makeContext(),
        { isCancelled: () => isCancelled },
      );

      expect(isInterceptorCancel(result)).toBe(true);

      // Without the cancel, each is the failure it is.
      let failed: unknown;
      try {
        await chain(makeRequest(), { type: 'initial' }, makeContext(), {
          isCancelled: () => false,
        });
      } catch (error) {
        failed = error;
      }
      if (ending === 'throw') {
        expect(failed).toBe(failure);
      } else {
        expect(failed).toBeInstanceOf(TypeError);
      }
    },
  );

  test('a chain that starts cancelled runs no interceptor and answers a cancel', async () => {
    const mgr = new RequestInterceptorManager();
    let calls = 0;
    mgr.add((req) => {
      calls++;
      return req;
    });

    const result = await mgr.snapshot()(
      makeRequest(),
      { type: 'initial' },
      makeContext(),
      { isCancelled: () => true },
    );

    expect(isInterceptorCancel(result)).toBe(true);
    expect(calls).toBe(0);
  });

  test('phase context is passed to the interceptor', async () => {
    const mgr = new RequestInterceptorManager();
    const received: RequestPhase[] = [];

    mgr.add(
      (req, phase) => {
        received.push(phase);
        return req;
      },
      { phases: ['retry'] },
    );

    const retryPhase: RequestPhase = {
      type: 'retry',
      attempt: 2,
      maxAttempts: 4,
    };
    await mgr.snapshot()(makeRequest(), retryPhase, makeContext());

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(retryPhase);
  });

  test('context with initialURL and redirectHistory is passed to the interceptor', async () => {
    const mgr = new RequestInterceptorManager();
    const receivedContexts: RequestInterceptorContext[] = [];

    mgr.add(
      (req, _phase, context) => {
        receivedContexts.push(context);
        return req;
      },
      { phases: ['redirect'] },
    );

    const ctx = makeContext({
      initialURL: 'https://example.com/original',
      redirectHistory: ['https://example.com/hop-1'],
      requestID: 'req-123',
      attemptNumber: 2,
    });

    await mgr.snapshot()(
      makeRequest({ requestURL: 'https://example.com/hop-1' }),
      {
        type: 'redirect',
        hop: 1,
        from: 'https://example.com/original',
        to: 'https://example.com/hop-1',
        statusCode: 301,
      },
      ctx,
    );

    expect(receivedContexts).toHaveLength(1);
    expect(receivedContexts[0].initialURL).toBe('https://example.com/original');
    expect(receivedContexts[0].redirectHistory).toEqual([
      'https://example.com/hop-1',
    ]);
    expect(receivedContexts[0].requestID).toBe('req-123');
    expect(receivedContexts[0].attemptNumber).toBe(2);
  });
});

describe('isInterceptorCancel', () => {
  test('a request carrying cancel: false is passed on, not treated as a cancel', async () => {
    const mgr = new RequestInterceptorManager();
    mgr.add((request) => ({ ...request, cancel: false }) as InterceptedRequest);
    const result = await mgr.snapshot()(
      makeRequest(),
      { type: 'initial' },
      makeContext(),
    );

    expect(isInterceptorCancel(result)).toBe(false);
  });

  test('cancels returned by the chain are recognized', async () => {
    const mgr = new RequestInterceptorManager();
    mgr.add(() => ({ cancel: true as const, reason: 'nope' }));
    const result = await mgr.snapshot()(
      makeRequest(),
      { type: 'initial' },
      makeContext(),
    );

    expect(isInterceptorCancel(result)).toBe(true);
    expect(result).toEqual({ cancel: true, reason: 'nope' });

    const nullMgr = new RequestInterceptorManager();
    nullMgr.add(() => null);
    const nullResult = await nullMgr.snapshot()(
      makeRequest(),
      { type: 'initial' },
      makeContext(),
    );

    expect(isInterceptorCancel(nullResult)).toBe(true);
    expect(nullResult).toEqual({ cancel: true });
  });
});

describe('interceptor results passed down the chain', () => {
  test('PR review round 42: a host-filtered interceptor and its filter read the same URL', async () => {
    // A `requestURL` getter that answers the trusted host to its first read and another
    // host after: read apart, the filter matched `trusted.test` and the interceptor it
    // guards attached its token to a request for `evil.test`.
    const mgr = new RequestInterceptorManager();
    let reads = 0;
    mgr.add((request) => ({
      method: request.method,
      headers: request.headers,
      body: request.body,
      get requestURL() {
        return reads++ === 0 ? 'https://trusted.test/x' : 'https://evil.test/x';
      },
    }));

    const seenByTokenInterceptor: string[] = [];
    mgr.add(
      (request) => {
        seenByTokenInterceptor.push(request.requestURL);
        return {
          ...request,
          headers: { ...request.headers, authorization: 'Bearer token' },
        };
      },
      { hosts: ['trusted.test'] },
    );

    const result = await mgr.snapshot()(
      makeRequest(),
      { type: 'initial' },
      makeContext(),
    );

    expect(isInterceptorCancel(result)).toBe(false);
    const request = result as InterceptedRequest;
    expect(reads).toBe(1);
    expect(seenByTokenInterceptor).toEqual(['https://trusted.test/x']);
    expect(request.requestURL).toBe('https://trusted.test/x');
    expect(request.headers).toEqual({ authorization: 'Bearer token' });
  });
});

describe('the copy the next interceptor sees', () => {
  test('PR review round 42: header names reach the next interceptor lowercase, values as strings', async () => {
    const mgr = new RequestInterceptorManager();
    mgr.add((request) => ({
      ...request,
      method: 'post' as InterceptedRequest['method'],
      headers: {
        ...request.headers,
        Authorization: 'Bearer token',
        'X-Trace': ['abc'],
        'X-Removed': undefined,
      },
      extra: 'dropped',
    }));

    let seen: InterceptedRequest | undefined;
    mgr.add((request) => {
      seen = request;
      return request;
    });

    await mgr.snapshot()(makeRequest(), { type: 'initial' }, makeContext());

    expect(seen).toEqual({
      requestURL: 'https://example.com/api',
      method: 'POST',
      headers: { authorization: 'Bearer token', 'x-trace': 'abc' },
      body: undefined,
    });
  });
});

test('PR review round 58: prepareRequest runs once, after the filter and before the function of the first interceptor the phase calls, and only then', async () => {
  const mgr = new RequestInterceptorManager();
  const seen: unknown[] = [];
  mgr.add(
    (request) => {
      seen.push(['initial-only', request.body]);
      return request;
    },
    { phases: ['initial'] },
  );
  // Filters read the request as handed over (PR review round 59): this one is not
  // matched by the prepared body, and is not called.
  mgr.add(
    (request) => {
      seen.push(['prepared-filter', request.body]);
      return request;
    },
    { phases: ['retry'], bodyContainsKeys: ['copied'] },
  );
  mgr.add(
    (request) => {
      seen.push(['filtered', request.body]);
      return request;
    },
    { phases: ['retry'], bodyContainsKeys: ['original'] },
  );
  mgr.add(
    (request) => {
      seen.push(['retry', request.body]);
      return request;
    },
    { phases: ['retry'] },
  );
  let prepared = 0;
  const prepareRequest = (request: InterceptedRequest): InterceptedRequest => {
    prepared++;
    return { ...request, body: { copied: true } };
  };

  const result = await mgr.snapshot()(
    makeRequest({ body: { original: true } }),
    { type: 'retry', attempt: 2, maxAttempts: 2 },
    makeContext(),
    { prepareRequest },
  );

  expect(prepared).toBe(1);
  // The filter read the original body; the functions the prepared one.
  expect(seen).toEqual([
    ['filtered', { copied: true }],
    ['retry', { copied: true }],
  ]);
  expect(isInterceptorCancel(result)).toBe(false);

  // A phase no interceptor is registered for never prepares.
  await mgr.snapshot()(
    makeRequest({ body: { original: true } }),
    { type: 'redirect', hop: 1, from: 'a', to: 'b', statusCode: 301 },
    makeContext(),
    { prepareRequest },
  );
  expect(prepared).toBe(1);

  // Nor does one whose interceptors' filters all decline the request.
  const filteredOut = new RequestInterceptorManager();
  filteredOut.add((request) => request, {
    phases: ['retry'],
    bodyContainsKeys: ['copied'],
  });
  await filteredOut.snapshot()(
    makeRequest({ body: { original: true } }),
    { type: 'retry', attempt: 2, maxAttempts: 2 },
    makeContext(),
    { prepareRequest },
  );
  expect(prepared).toBe(1);
});
