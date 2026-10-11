import { expect, test } from 'bun:test';
import { HTTPClient } from './http-client';
import { MockAdapter } from './adapters/mock-adapter';
import type { HTTPMethod } from './types';
import { captureErrorReports } from './test-helpers/capture-error-reports';

test.each(['final', 'retry'] as const)(
  'malformed %s response filter cannot stall send or skip later observers',
  async (phase) => {
    const adapter = new MockAdapter();
    let attempts = 0;
    adapter.routes.get('/test', () => ({
      status: ++attempts === 1 && phase === 'retry' ? 503 : 200,
      body: 'ok',
    }));
    const client = new HTTPClient({
      adapter,
      retryPolicy: { strategy: 'fixed', delayMS: 1, maxRetryAttempts: 1 },
    });
    const observed: string[] = [];
    client.addResponseObserver(
      () => {
        throw new Error('must not be called');
      },
      { phases: [phase], statusCodes: {} as number[] },
    );
    client.addResponseObserver(
      (_response, _request, info) => {
        observed.push(info.type);
      },
      { phases: ['retry', 'final'] },
    );
    const { reports, release } = captureErrorReports();
    try {
      const response = await client.get('/test').send();
      expect(response.status).toBe(200);
      expect(attempts).toBe(phase === 'retry' ? 2 : 1);
      expect(observed).toEqual(
        phase === 'retry' ? ['retry', 'final'] : ['final'],
      );
      expect(reports.length).toBeGreaterThan(0);
    } finally {
      release();
    }
  },
  1000,
);

test('malformed error observer filters preserve retries and final adapter error', async () => {
  const adapter = new MockAdapter();
  let attempts = 0;
  adapter.send = () => {
    attempts++;
    return Promise.reject(new Error('network failed'));
  };
  const client = new HTTPClient({
    adapter,
    retryPolicy: { strategy: 'fixed', delayMS: 1, maxRetryAttempts: 1 },
  });
  const observed: string[] = [];
  client.addErrorObserver(
    () => {
      throw new Error('must not be called');
    },
    { phases: ['retry', 'final'], methods: {} as HTTPMethod[] },
  );
  client.addErrorObserver(
    (_error, _request, info) => {
      observed.push(info.type);
    },
    { phases: ['retry', 'final'] },
  );
  const { reports, release } = captureErrorReports();
  try {
    const response = await client.get('/test').send();
    expect(response.isFailed).toBe(true);
    expect(attempts).toBe(2);
    expect(observed).toEqual(['retry', 'final']);
    expect(reports.length).toBeGreaterThan(0);
  } finally {
    release();
  }
}, 1000);
