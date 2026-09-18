import { expect, test } from 'bun:test';
import { HTTPClient } from './http-client';
import type { AdapterRequest, AdapterResponse, HTTPAdapter } from './types';

test.each([307, 308])(
  '%s redirects preserve structured JSON from the latest attempt',
  async (status) => {
    const sent: AdapterRequest[] = [];
    const adapter: HTTPAdapter = {
      getType: () => 'mock',
      send: (request): Promise<AdapterResponse> => {
        sent.push(request);
        return Promise.resolve<AdapterResponse>(
          sent.length === 1
            ? { status: 503, headers: {}, body: null }
            : sent.length === 2
              ? { status, headers: { location: '/next' }, body: null }
              : { status: 200, headers: {}, body: null },
        );
      },
    };
    const client = new HTTPClient({ adapter, followRedirects: true });
    client.addRequestInterceptor(
      (request) => ({ ...request, body: { value: 2 } }),
      { phases: ['retry'] },
    );
    let redirectBody: unknown;
    client.addRequestInterceptor(
      (request) => {
        redirectBody = request.body;
        return {
          ...request,
          body: { ...(request.body as object), extra: 3 },
        };
      },
      { phases: ['redirect'] },
    );
    let finalRawBody: unknown;
    client.addResponseObserver((_response, request) => {
      finalRawBody = request.rawBody;
    });

    const response = await client
      .put('https://example.com/start')
      .json({ value: 1 })
      .retryPolicy({ strategy: 'fixed', maxRetryAttempts: 1, delayMS: 1 })
      .send();

    expect(response.status).toBe(200);
    expect(sent).toHaveLength(3);
    expect(sent[0].body).toBe(JSON.stringify({ value: 1 }));
    expect(sent[1].body).toBe(JSON.stringify({ value: 2 }));
    expect(redirectBody).toEqual({ value: 2 });
    expect(sent[2].body).toBe(JSON.stringify({ value: 2, extra: 3 }));
    expect(finalRawBody).toEqual({ value: 2, extra: 3 });
  },
);
