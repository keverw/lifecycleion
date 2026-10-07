import { captureErrorReports } from './test-helpers/capture-error-reports';
import { describe, test, expect } from 'bun:test';
import { ResponseObserverManager, ErrorObserverManager } from './observers';
import type { AttemptRequest, HTTPResponse, HTTPClientError } from './types';

function makeRequest(overrides: Partial<AttemptRequest> = {}): AttemptRequest {
  return {
    requestURL: 'https://example.com/api',
    method: 'GET',
    headers: {},
    timeout: 30_000,
    ...overrides,
  };
}

function makeResponse(overrides: Partial<HTTPResponse> = {}): HTTPResponse {
  const response: HTTPResponse = {
    status: 200,
    headers: {},
    body: { ok: true },
    contentType: 'json',
    isJSON: true,
    isText: false,
    isCancelled: false,
    isTimeout: false,
    isNetworkError: false,
    isFailed: false,
    isParseError: false,
    initialURL: 'https://example.com/api',
    requestURL: 'https://example.com/api',
    wasRedirectDetected: false,
    wasRedirectFollowed: false,
    redirectHistory: [],
    requestID: 'req-1',
    adapterType: 'fetch',
    isStreamed: false,
    isStreamError: false,
    ...overrides,
  };

  response.isFailed =
    overrides.isFailed ??
    (response.isCancelled ||
      response.isTimeout ||
      response.isNetworkError ||
      response.isStreamError);

  return response;
}

function makeError(overrides: Partial<HTTPClientError> = {}): HTTPClientError {
  return {
    code: 'network_error',
    message: 'Failed to connect',
    initialURL: 'https://example.com/api',
    requestURL: 'https://example.com/api',
    wasRedirectDetected: false,
    wasRedirectFollowed: false,
    redirectHistory: [],
    requestID: 'req-1',
    isTimeout: false,
    isRetriesExhausted: false,
    ...overrides,
  };
}

test.each(['response', 'error'] as const)(
  '%s observer changes during an awaited callback apply to the next snapshot',
  async (kind) => {
    const responseManager = new ResponseObserverManager();
    const errorManager = new ErrorObserverManager();
    const mgr = kind === 'response' ? responseManager : errorManager;
    const dispatch = () =>
      kind === 'response'
        ? responseManager.snapshot()(makeResponse(), makeRequest(), {
            type: 'final',
          })
        : errorManager.snapshot()(makeError(), makeRequest(), {
            type: 'final',
          });
    const calls: number[] = [];
    const remove = mgr.add(async () => {
      calls.push(1);
      await Promise.resolve();
      remove();
      mgr.add(() => {
        calls.push(3);
      });
    });
    mgr.add(() => {
      calls.push(2);
    });
    await dispatch();
    expect(calls).toEqual([1, 2]);
    calls.length = 0;
    await dispatch();
    expect(calls).toEqual([2, 3]);
  },
);

describe('ResponseObserverManager', () => {
  test('snapshot does not consult the registration array iterator', async () => {
    const mgr = new ResponseObserverManager();
    let calls = 0;
    mgr.add(() => {
      calls++;
    });
    // See the same test in interceptors.test.ts.
    void Object.defineProperty(
      (mgr as unknown as { observers: unknown[] }).observers,
      Symbol.iterator,
      {
        value() {
          throw new Error('iterator used');
        },
      },
    );

    await mgr.snapshot()(makeResponse(), makeRequest(), { type: 'final' });

    expect(calls).toBe(1);
  });

  test('a throwing filter-context getter is reported without rejecting the chain', async () => {
    const mgr = new ResponseObserverManager();
    const failure = new Error('status read failed');
    mgr.add(() => {});
    const response = makeResponse();
    Object.defineProperty(response, 'status', {
      get() {
        throw failure;
      },
    });
    const { reports, release } = captureErrorReports();
    try {
      expect(
        await mgr.snapshot()(response, makeRequest(), { type: 'final' }),
      ).toBeUndefined();
      expect(reports.length).toBeGreaterThan(0);
    } finally {
      release();
    }
  });

  test('calls observers in order', async () => {
    const mgr = new ResponseObserverManager();
    const order: number[] = [];

    mgr.add(() => {
      order.push(1);
    });
    mgr.add(() => {
      order.push(2);
    });

    await mgr.snapshot()(makeResponse(), makeRequest(), { type: 'final' });
    expect(order).toEqual([1, 2]);
  });

  test('supports async observers', async () => {
    const mgr = new ResponseObserverManager();
    const calls: string[] = [];

    mgr.add(async () => {
      await Promise.resolve();
      calls.push('done');
    });

    await mgr.snapshot()(makeResponse(), makeRequest(), { type: 'final' });
    expect(calls).toEqual(['done']);
  });

  test('remove() unregisters the observer', async () => {
    const mgr = new ResponseObserverManager();
    const calls: number[] = [];
    const remove = mgr.add(() => {
      calls.push(1);
    });

    await mgr.snapshot()(makeResponse(), makeRequest(), { type: 'final' });
    expect(calls).toHaveLength(1);

    remove();
    await mgr.snapshot()(makeResponse(), makeRequest(), { type: 'final' });
    expect(calls).toHaveLength(1);
  });

  test('filter by statusCodes', async () => {
    const mgr = new ResponseObserverManager();
    const statuses: number[] = [];

    mgr.add(
      (res) => {
        statuses.push(res.status);
      },
      { statusCodes: [401] },
    );

    await mgr.snapshot()(makeResponse({ status: 200 }), makeRequest(), {
      type: 'final',
    });

    expect(statuses).toHaveLength(0);

    await mgr.snapshot()(makeResponse({ status: 401 }), makeRequest(), {
      type: 'final',
    });

    expect(statuses).toHaveLength(1);
  });

  test('filter by method', async () => {
    const mgr = new ResponseObserverManager();
    const calls: string[] = [];

    mgr.add(
      (_, req) => {
        calls.push(req.method);
      },
      { methods: ['POST'] },
    );

    await mgr.snapshot()(makeResponse(), makeRequest({ method: 'GET' }), {
      type: 'final',
    });

    expect(calls).toHaveLength(0);

    await mgr.snapshot()(makeResponse(), makeRequest({ method: 'POST' }), {
      type: 'final',
    });

    expect(calls).toHaveLength(1);
  });

  test('filter by contentTypes', async () => {
    const mgr = new ResponseObserverManager();
    const seen: string[] = [];

    mgr.add(
      (res) => {
        seen.push(res.contentType);
      },
      { contentTypes: ['json'] },
    );

    await mgr.snapshot()(
      makeResponse({
        contentType: 'text',
        isJSON: false,
        isText: true,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
        body: 'hello',
      }),
      makeRequest(),
      { type: 'final' },
    );

    await mgr.snapshot()(
      makeResponse({
        contentType: 'json',
        isJSON: true,
        isText: false,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      }),
      makeRequest(),
      { type: 'final' },
    );

    expect(seen).toEqual(['json']);
  });

  test('filter by contentTypeHeaders supports wildcard patterns', async () => {
    const mgr = new ResponseObserverManager();
    const statuses: number[] = [];

    mgr.add(
      (res) => {
        statuses.push(res.status);
      },
      { contentTypeHeaders: ['image/*'] },
    );

    await mgr.snapshot()(
      makeResponse({
        status: 200,
        contentType: 'binary',
        isJSON: false,
        headers: { 'content-type': 'video/mp4' },
      }),
      makeRequest(),
      { type: 'final' },
    );

    await mgr.snapshot()(
      makeResponse({
        status: 201,
        contentType: 'binary',
        isJSON: false,
        headers: { 'content-type': 'image/png' },
      }),
      makeRequest(),
      { type: 'final' },
    );

    expect(statuses).toEqual([201]);
  });

  test('default phase filter — only runs on final phase', async () => {
    const mgr = new ResponseObserverManager();
    const phases: string[] = [];

    mgr.add((_, _req, phase) => {
      phases.push(phase.type);
    });

    await mgr.snapshot()(makeResponse(), makeRequest(), {
      type: 'redirect',
      hop: 1,
      from: 'a',
      to: 'b',
      statusCode: 301,
    });
    await mgr.snapshot()(makeResponse(), makeRequest(), {
      type: 'retry',
      attempt: 2,
      maxAttempts: 3,
    });
    await mgr.snapshot()(makeResponse(), makeRequest(), { type: 'final' });

    expect(phases).toEqual(['final']);
  });

  test('explicit phases filter — runs on matching phases', async () => {
    const mgr = new ResponseObserverManager();
    const phases: string[] = [];

    mgr.add(
      (_, _req, phase) => {
        phases.push(phase.type);
      },
      { phases: ['final', 'redirect'] },
    );

    await mgr.snapshot()(makeResponse(), makeRequest(), {
      type: 'retry',
      attempt: 1,
      maxAttempts: 3,
    });
    await mgr.snapshot()(makeResponse(), makeRequest(), {
      type: 'redirect',
      hop: 1,
      from: 'a',
      to: 'b',
      statusCode: 301,
    });
    await mgr.snapshot()(makeResponse(), makeRequest(), { type: 'final' });

    expect(phases).toEqual(['redirect', 'final']);
  });

  test('empty phases filter — does not restrict matching', async () => {
    const mgr = new ResponseObserverManager();
    const phases: string[] = [];

    mgr.add(
      (_, _req, phase) => {
        phases.push(phase.type);
      },
      { phases: [] },
    );

    await mgr.snapshot()(makeResponse(), makeRequest(), {
      type: 'retry',
      attempt: 1,
      maxAttempts: 3,
    });
    await mgr.snapshot()(makeResponse(), makeRequest(), {
      type: 'redirect',
      hop: 1,
      from: 'a',
      to: 'b',
      statusCode: 301,
    });
    await mgr.snapshot()(makeResponse(), makeRequest(), { type: 'final' });

    expect(phases).toEqual(['retry', 'redirect', 'final']);
  });
});

describe('ErrorObserverManager', () => {
  test('snapshot does not consult the registration array iterator', async () => {
    const mgr = new ErrorObserverManager();
    let calls = 0;
    mgr.add(() => {
      calls++;
    });
    // See the same test in interceptors.test.ts.
    void Object.defineProperty(
      (mgr as unknown as { observers: unknown[] }).observers,
      Symbol.iterator,
      {
        value() {
          throw new Error('iterator used');
        },
      },
    );

    await mgr.snapshot()(makeError(), makeRequest(), { type: 'final' });

    expect(calls).toBe(1);
  });

  test('a throwing filter-context getter is reported without rejecting the chain', async () => {
    const mgr = new ErrorObserverManager();
    const failure = new Error('method read failed');
    mgr.add(() => {});
    const request = makeRequest();
    Object.defineProperty(request, 'method', {
      get() {
        throw failure;
      },
    });
    const { reports, release } = captureErrorReports();
    try {
      expect(
        await mgr.snapshot()(makeError(), request, { type: 'final' }),
      ).toBeUndefined();
      expect(reports.length).toBeGreaterThan(0);
    } finally {
      release();
    }
  });

  test('calls observers in order', async () => {
    const mgr = new ErrorObserverManager();
    const order: number[] = [];

    mgr.add(() => {
      order.push(1);
    });
    mgr.add(() => {
      order.push(2);
    });

    await mgr.snapshot()(makeError(), makeRequest(), { type: 'final' });
    expect(order).toEqual([1, 2]);
  });

  test('supports async observers', async () => {
    const mgr = new ErrorObserverManager();
    const calls: string[] = [];

    mgr.add(async () => {
      await Promise.resolve();
      calls.push('done');
    });

    await mgr.snapshot()(makeError(), makeRequest(), { type: 'final' });
    expect(calls).toEqual(['done']);
  });

  test('remove() unregisters the observer', async () => {
    const mgr = new ErrorObserverManager();
    const calls: number[] = [];
    const remove = mgr.add(() => {
      calls.push(1);
    });

    await mgr.snapshot()(makeError(), makeRequest(), { type: 'final' });
    expect(calls).toHaveLength(1);

    remove();
    await mgr.snapshot()(makeError(), makeRequest(), { type: 'final' });
    expect(calls).toHaveLength(1);
  });

  test('filter by method', async () => {
    const mgr = new ErrorObserverManager();
    const calls: string[] = [];

    mgr.add(
      (_, req) => {
        calls.push(req.method);
      },
      { methods: ['POST'] },
    );

    await mgr.snapshot()(makeError(), makeRequest({ method: 'GET' }), {
      type: 'final',
    });
    expect(calls).toHaveLength(0);

    await mgr.snapshot()(makeError(), makeRequest({ method: 'POST' }), {
      type: 'final',
    });
    expect(calls).toHaveLength(1);
  });

  test('default phase filter — only runs on final phase', async () => {
    const mgr = new ErrorObserverManager();
    const phases: string[] = [];

    mgr.add((_, _req, phase) => {
      phases.push(phase.type);
    });

    await mgr.snapshot()(makeError(), makeRequest(), {
      type: 'retry',
      attempt: 1,
      maxAttempts: 3,
    });
    await mgr.snapshot()(makeError(), makeRequest(), {
      type: 'retry',
      attempt: 2,
      maxAttempts: 3,
    });
    await mgr.snapshot()(makeError(), makeRequest(), { type: 'final' });

    expect(phases).toEqual(['final']);
  });

  test('explicit phases filter — runs on matching phases', async () => {
    const mgr = new ErrorObserverManager();
    const phases: string[] = [];

    mgr.add(
      (_, _req, phase) => {
        phases.push(phase.type);
      },
      { phases: ['final', 'retry'] },
    );

    await mgr.snapshot()(makeError(), makeRequest(), { type: 'final' });
    await mgr.snapshot()(makeError(), makeRequest(), {
      type: 'retry',
      attempt: 2,
      maxAttempts: 3,
    });
    await mgr.snapshot()(makeError(), makeRequest(), { type: 'final' });

    expect(phases).toEqual(['final', 'retry', 'final']);
  });

  test('empty phases filter — does not restrict matching', async () => {
    const mgr = new ErrorObserverManager();
    const phases: string[] = [];

    mgr.add(
      (_, _req, phase) => {
        phases.push(phase.type);
      },
      { phases: [] },
    );

    await mgr.snapshot()(makeError(), makeRequest(), { type: 'final' });
    await mgr.snapshot()(makeError(), makeRequest(), {
      type: 'retry',
      attempt: 2,
      maxAttempts: 3,
    });
    await mgr.snapshot()(makeError(), makeRequest(), { type: 'final' });

    expect(phases).toEqual(['final', 'retry', 'final']);
  });
});

test.each(['final', 'retry'] as const)(
  'malformed response observer filter cannot block %s delivery',
  async (phase) => {
    const manager = new ResponseObserverManager();
    let calls = 0;
    manager.add(
      () => {
        throw new Error('must not run');
      },
      {
        phases: ['final', 'retry'],
        statusCodes: {} as number[],
      },
    );
    manager.add(
      () => {
        calls++;
      },
      { phases: ['final', 'retry'] },
    );
    const { reports, release } = captureErrorReports();
    try {
      await manager.snapshot()(
        makeResponse(),
        makeRequest(),
        phase === 'final'
          ? { type: 'final' }
          : { type: 'retry', attempt: 1, maxAttempts: 2 },
      );
      expect(calls).toBe(1);
      expect(reports.length).toBeGreaterThan(0);
    } finally {
      release();
    }
  },
);
