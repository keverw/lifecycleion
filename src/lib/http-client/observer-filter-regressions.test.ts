import { expect, test } from 'bun:test';
import { HTTPClient } from './http-client';
import { MockAdapter } from './adapters/mock-adapter';
import { captureErrorReports } from './test-helpers/capture-error-reports';
import {
  THROWING_FILTER_HOST,
  makeMarkedFiltersThrow,
} from './test-helpers/throwing-filter';

test.each(['final', 'retry'] as const)(
  'a %s response filter that throws cannot stall send or skip later observers',
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
      { phases: [phase], hosts: [THROWING_FILTER_HOST] },
    );
    client.addResponseObserver(
      (_response, _request, info) => {
        observed.push(info.type);
      },
      { phases: ['retry', 'final'] },
    );
    const { reports, release } = captureErrorReports();
    const filterSpy = makeMarkedFiltersThrow();
    try {
      const response = await client.get('/test').send();
      expect(response.status).toBe(200);
      expect(attempts).toBe(phase === 'retry' ? 2 : 1);
      expect(observed).toEqual(
        phase === 'retry' ? ['retry', 'final'] : ['final'],
      );
      expect(reports.length).toBeGreaterThan(0);
    } finally {
      filterSpy.mockRestore();
      release();
    }
  },
  1000,
);

test('an error observer filter that throws preserves retries and the final adapter error', async () => {
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
    // Matching it throws on every phase.
    { phases: ['retry', 'final'], hosts: [THROWING_FILTER_HOST] },
  );
  client.addErrorObserver(
    (_error, _request, info) => {
      observed.push(info.type);
    },
    { phases: ['retry', 'final'] },
  );
  const { reports, release } = captureErrorReports();
  const filterSpy = makeMarkedFiltersThrow();
  try {
    const response = await client.get('/test').send();
    expect(response.isFailed).toBe(true);
    expect(attempts).toBe(2);
    expect(observed).toEqual(['retry', 'final']);
    expect(reports.length).toBeGreaterThan(0);
  } finally {
    filterSpy.mockRestore();
    release();
  }
}, 1000);

test.each([
  ['a rewritten', 'https://api.internal/', 'POST'],
  ['no', undefined, undefined],
] as const)(
  'a response observer that leaves the request %s URL and method does not change which later observers run',
  async (_label, requestURL, method) => {
    const adapter = new MockAdapter();
    adapter.routes.get('/x', () => ({ status: 200, body: { secret: 1 } }));
    const client = new HTTPClient({ adapter });
    const heard: string[] = [];
    client.addResponseObserver((_response, request) => {
      Object.assign(request, { requestURL, method });
    });
    client.addResponseObserver(
      () => {
        heard.push('hosts');
      },
      { hosts: ['api.internal'] },
    );
    client.addResponseObserver(
      () => {
        heard.push('schemes');
      },
      { schemes: ['https'] },
    );
    client.addResponseObserver(
      () => {
        heard.push('methods');
      },
      { methods: ['POST'] },
    );
    client.addResponseObserver(
      () => {
        heard.push('other.test');
      },
      { hosts: ['other.test'], methods: ['GET'] },
    );

    await client.get('http://other.test/x').send();

    expect(heard).toEqual(['other.test']);
  },
);

test.each([
  ['a rewritten', 'https://api.internal/', 'POST'],
  ['no', undefined, undefined],
] as const)(
  'an error observer that leaves the request %s URL and method does not change which later observers run',
  async (_label, requestURL, method) => {
    const client = new HTTPClient({
      adapter: {
        getType: () => 'mock',
        send: () => Promise.reject(new Error('down')),
      },
    });
    const heard: string[] = [];
    client.addErrorObserver((_error, request) => {
      Object.assign(request, { requestURL, method });
    });
    client.addErrorObserver(
      () => {
        heard.push('hosts');
      },
      { hosts: ['api.internal'] },
    );
    client.addErrorObserver(
      () => {
        heard.push('schemes');
      },
      { schemes: ['https'] },
    );
    client.addErrorObserver(
      () => {
        heard.push('other.test');
      },
      { hosts: ['other.test'], schemes: ['http'] },
    );

    await client.get('http://other.test/x').send();

    expect(heard).toEqual(['other.test']);
  },
);
