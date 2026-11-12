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

test('a parent client observer that rewrites the request or the response does not change which sub-client response observers run', async () => {
  const adapter = new MockAdapter();
  adapter.routes.get('/x', () => ({ status: 200, body: { secret: 1 } }));
  const root = new HTTPClient({ adapter });
  const sub = root.createSubClient();
  const heard: string[] = [];
  root.addResponseObserver((response, request) => {
    Object.assign(request, {
      requestURL: 'https://secret.internal/x',
      method: 'POST',
    });
    Object.assign(response, { status: 500, headers: undefined });
  });
  sub.addResponseObserver(
    () => {
      heard.push('secret.internal');
    },
    { hosts: ['secret.internal'] },
  );
  sub.addResponseObserver(
    () => {
      heard.push('methods POST');
    },
    { methods: ['POST'] },
  );
  sub.addResponseObserver(
    () => {
      heard.push('statusCodes 500');
    },
    { statusCodes: [500] },
  );
  sub.addResponseObserver(
    () => {
      heard.push('public.example.com');
    },
    { hosts: ['public.example.com'], methods: ['GET'], statusCodes: [200] },
  );
  sub.addResponseObserver(() => {
    heard.push('unfiltered');
  });
  const { reports, release } = captureErrorReports();
  try {
    await sub.get('https://public.example.com/x').send();
  } finally {
    release();
  }

  expect(heard).toEqual(['public.example.com', 'unfiltered']);
  expect(reports).toEqual([]);
});

test('a parent client observer that rewrites the request does not change which sub-client error observers run', async () => {
  const root = new HTTPClient({
    adapter: {
      getType: () => 'mock',
      send: () => Promise.reject(new Error('down')),
    },
  });
  const sub = root.createSubClient();
  const heard: string[] = [];
  root.addErrorObserver((_error, request) => {
    Object.assign(request, {
      requestURL: 'https://secret.internal/x',
      method: 'POST',
    });
  });
  sub.addErrorObserver(
    () => {
      heard.push('secret.internal');
    },
    { hosts: ['secret.internal'] },
  );
  sub.addErrorObserver(
    () => {
      heard.push('public.example.com');
    },
    { hosts: ['public.example.com'], schemes: ['https'] },
  );

  await sub.get('https://public.example.com/x').send();

  expect(heard).toEqual(['public.example.com']);
});

test.each(['answered', 'thrown'] as const)(
  'a retry-phase observer that rewrites the request in place does not change the %s attempt the cancelled request reports',
  async (outcome) => {
    const client = new HTTPClient({
      adapter: {
        getType: () => 'mock',
        send: () =>
          outcome === 'answered'
            ? Promise.resolve({ status: 503, headers: {}, body: null })
            : Promise.reject(new Error('down')),
      },
      retryPolicy: { strategy: 'fixed', delayMS: 5000, maxRetryAttempts: 1 },
    });
    const redact = (request: { requestURL: string; method: string }) => {
      request.requestURL = 'https://redacted.invalid/';
      request.method = 'PATCH';
    };
    client.addResponseObserver(
      (_response, request) => {
        redact(request);
      },
      { phases: ['retry'] },
    );
    client.addErrorObserver(
      (_error, request) => {
        redact(request);
      },
      { phases: ['retry'] },
    );
    const finalHeard: { requestURL: string; method: string }[] = [];
    client.addErrorObserver(
      (_error, request) => {
        finalHeard.push({
          requestURL: request.requestURL,
          method: request.method,
        });
      },
      { hosts: ['api.example.com'], methods: ['GET'] },
    );
    const builder = client.get('https://api.example.com/x');
    // Cancelled during the wait before the retry, after the retry-phase observers ran.
    client.addResponseObserver(
      () => {
        setTimeout(() => builder.cancel(), 20);
      },
      { phases: ['retry'] },
    );
    client.addErrorObserver(
      () => {
        setTimeout(() => builder.cancel(), 20);
      },
      { phases: ['retry'] },
    );

    const response = await builder.send();

    expect(response.isCancelled).toBe(true);
    expect(response.requestURL).toBe('https://api.example.com/x');
    expect(builder.error?.requestURL).toBe('https://api.example.com/x');
    expect(finalHeard).toEqual([
      { requestURL: 'https://api.example.com/x', method: 'GET' },
    ]);
  },
);
