import { expect, test } from 'bun:test';
import { HTTPClient } from './http-client';
import type { AdapterResponse, HTTPAdapter } from './types';

test.each([
  ['headers', 'changing'],
  ['headers', 'throwing'],
  ['effectiveRequestHeaders', 'changing'],
  ['effectiveRequestHeaders', 'throwing'],
] as const)(
  'adapter response %s is read once with a %s getter',
  async (field, behavior) => {
    let reads = 0;
    let settlementReads = 0;
    let settlementCalls = 0;
    const raw: AdapterResponse = {
      status: 200,
      headers: { 'X-Response': 'original' },
      body: null,
      effectiveRequestHeaders: { 'X-Wire': 'original' },
      get requestBodySettled() {
        settlementReads++;
        return {
          then(resolve: (value: undefined) => void) {
            settlementCalls++;
            resolve(undefined);
          },
        } as Promise<Error | undefined>;
      },
    };
    const original = raw[field];
    Object.defineProperty(raw, field, {
      enumerable: true,
      get() {
        reads++;
        if (reads === 1) {
          return original;
        }
        if (behavior === 'throwing') {
          throw new Error('response field read twice');
        }
        return field === 'headers'
          ? { 'X-Response': 'changed' }
          : { 'X-Wire': 'changed' };
      },
    });
    const adapter: HTTPAdapter = {
      getType: () => 'node',
      send: () => Promise.resolve(raw),
    };
    const client = new HTTPClient({ adapter });
    const observedWireHeaders: (string | string[] | undefined)[] = [];
    client.addResponseObserver((_response, request) => {
      observedWireHeaders.push(request.headers['x-wire']);
    });

    const response = await client
      .put('https://example.com/upload')
      .text('body')
      .send();

    expect(response.status).toBe(200);
    expect(response.headers['x-response']).toBe('original');
    expect(observedWireHeaders).toEqual(['original']);
    expect(reads).toBe(1);
    expect(settlementReads).toBe(1);
    expect(await response.requestBodySettled).toBeUndefined();
    expect(settlementCalls).toBe(1);
  },
);

test('adapter response retains inherited header fields', async () => {
  const raw = Object.assign(
    Object.create({
      headers: { 'X-Response': 'inherited' },
      effectiveRequestHeaders: { 'X-Wire': 'inherited' },
    }) as AdapterResponse,
    { status: 200, body: null },
  );
  const adapter: HTTPAdapter = {
    getType: () => 'node',
    send: () => Promise.resolve(raw),
  };
  const client = new HTTPClient({ adapter });
  const observedWireHeaders: (string | string[] | undefined)[] = [];
  client.addResponseObserver((_response, request) => {
    observedWireHeaders.push(request.headers['x-wire']);
  });

  const response = await client.get('https://example.com/').send();

  expect(response.status).toBe(200);
  expect(response.headers['x-response']).toBe('inherited');
  expect(observedWireHeaders).toEqual(['inherited']);
});

test.each(['missing headers', 'throwing headers', 'throwing body'] as const)(
  'malformed adapter response retains and observes upload failure: %s',
  async (mode) => {
    const uploadError = new Error('upload failed');
    let uploadReads = 0;
    const adapter: HTTPAdapter = {
      getType: () => 'node',
      send: () => {
        const upload = Promise.reject(uploadError);
        const raw = {
          status: 200,
          get requestBodySettled() {
            uploadReads++;
            return upload;
          },
          get headers() {
            if (mode === 'throwing headers') {
              throw new Error('headers failed');
            }
            return mode === 'missing headers' ? undefined : {};
          },
          get body() {
            if (mode === 'throwing body') {
              throw new Error('body failed');
            }
            return null;
          },
        } as unknown as AdapterResponse;
        return Promise.resolve(raw);
      },
    };
    const response = await new HTTPClient({ adapter })
      .put('https://example.com/')
      .text('x')
      .send();
    expect(response.status).toBe(0);
    expect((await response.requestBodySettled)?.cause).toBe(uploadError);
    expect(uploadReads).toBe(1);
  },
);
