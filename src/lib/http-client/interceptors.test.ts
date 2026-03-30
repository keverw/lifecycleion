import { describe, test, expect } from 'bun:test';
import { RequestInterceptorManager } from './interceptors';
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
    ...overrides,
  };
}

describe('RequestInterceptorManager', () => {
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

    await mgr.run(makeRequest(), { type: 'initial' }, makeContext());
    expect(order).toEqual([1, 2, 3]);
  });

  test('each interceptor receives the modified request from the prior one', async () => {
    const mgr = new RequestInterceptorManager();

    mgr.add((req) => ({ ...req, headers: { ...req.headers, 'x-step': '1' } }));
    mgr.add((req) => ({ ...req, headers: { ...req.headers, 'x-step': '2' } }));

    const result = await mgr.run(
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

    const result = await mgr.run(
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

    await mgr.run(makeRequest(), { type: 'initial' }, makeContext());
    expect(calls).toHaveLength(1);

    remove();
    await mgr.run(makeRequest(), { type: 'initial' }, makeContext());
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

    await mgr.run(
      makeRequest({ method: 'GET' }),
      { type: 'initial' },
      makeContext(),
    );
    expect(calls).toHaveLength(0);

    await mgr.run(
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

    await mgr.run(
      makeRequest({ requestURL: 'https://other.com/api' }),
      {
        type: 'initial',
      },
      makeContext(),
    );
    expect(calls).toHaveLength(0);

    await mgr.run(
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

    await mgr.run(
      makeRequest({ requestURL: 'https://example.com/api' }),
      {
        type: 'initial',
      },
      makeContext(),
    );
    expect(calls).toHaveLength(0);

    await mgr.run(
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

    await mgr.run(makeRequest(), { type: 'initial' }, makeContext());
    await mgr.run(
      makeRequest(),
      {
        type: 'retry',
        attempt: 2,
        maxAttempts: 3,
      },
      makeContext(),
    );
    await mgr.run(
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

    await mgr.run(makeRequest(), { type: 'initial' }, makeContext());
    await mgr.run(
      makeRequest(),
      {
        type: 'retry',
        attempt: 2,
        maxAttempts: 3,
      },
      makeContext(),
    );
    await mgr.run(
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

  test('empty phases filter — does not restrict matching', async () => {
    const mgr = new RequestInterceptorManager();
    const phases: string[] = [];

    mgr.add(
      (req, phase) => {
        phases.push(phase.type);
        return req;
      },
      { phases: [] },
    );

    await mgr.run(makeRequest(), { type: 'initial' }, makeContext());
    await mgr.run(
      makeRequest(),
      {
        type: 'retry',
        attempt: 2,
        maxAttempts: 3,
      },
      makeContext(),
    );
    await mgr.run(
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

    expect(phases).toEqual(['initial', 'retry', 'redirect']);
  });

  test('interceptor can cancel by returning { cancel: true }', async () => {
    const mgr = new RequestInterceptorManager();

    mgr.add(() => ({ cancel: true as const, reason: 'token expired' }));

    const result = await mgr.run(
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

    await mgr.run(makeRequest(), { type: 'initial' }, makeContext());
    expect(calls).toEqual([1]);
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
    await mgr.run(makeRequest(), retryPhase, makeContext());

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
    });

    await mgr.run(
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
  });
});
