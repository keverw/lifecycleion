import { expect, test } from 'bun:test';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { HTTPClient } from './http-client';
import { NodeAdapter } from './adapters/node-adapter';
import type { AdapterRequest, AdapterResponse, HTTPAdapter } from './types';

test.each([307, 308])(
  '%s redirects regenerate body headers after an interceptor changes the body',
  async (status) => {
    for (const body of [undefined, { replacement: true }]) {
      const received: { headers: IncomingHttpHeaders; body: string }[] = [];
      const server = createServer((request, response) => {
        let receivedBody = '';
        request.setEncoding('utf8');
        request.on('data', (chunk: string) => {
          receivedBody += chunk;
        });
        request.on('end', () => {
          received.push({ headers: request.headers, body: receivedBody });
          if (request.url === '/start') {
            response.writeHead(status, { location: '/next' });
          }
          response.end('ok');
        });
      });
      try {
        await new Promise<void>((resolve) =>
          server.listen(0, '127.0.0.1', resolve),
        );
        const address = server.address();
        if (!address || typeof address === 'string') {
          throw new Error('Expected a TCP server address');
        }
        const client = new HTTPClient({
          adapter: new NodeAdapter(),
          followRedirects: true,
          timeout: 500,
        });
        client.addRequestInterceptor((request) => ({ ...request, body }), {
          phases: ['redirect'],
        });
        const response = await client
          .put(`http://127.0.0.1:${address.port}/start`)
          .text('abc')
          .send();

        expect(response.status).toBe(200);
        expect(received).toHaveLength(2);
        expect(received[0].headers['content-length']).toBe('3');
        expect(received[1].body).toBe(body ? JSON.stringify(body) : '');
        expect(received[1].headers['content-type']).toBe(
          body ? 'application/json; charset=utf-8' : undefined,
        );
        expect(Number(received[1].headers['content-length'] ?? 0)).toBe(
          body ? Buffer.byteLength(JSON.stringify(body)) : 0,
        );
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  },
);

test('redirects preserve explicit body headers supplied by the latest retry', async () => {
  const sent: AdapterRequest[] = [];
  const adapter: HTTPAdapter = {
    getType: () => 'mock',
    send: (request) => {
      sent.push(request);
      return Promise.resolve<AdapterResponse>(
        sent.length === 1
          ? { status: 503, headers: {}, body: null }
          : sent.length === 2
            ? { status: 307, headers: { location: '/next' }, body: null }
            : { status: 200, headers: {}, body: null },
      );
    },
  };
  const client = new HTTPClient({ adapter, followRedirects: true });
  client.addRequestInterceptor(
    (request) => ({
      ...request,
      headers: {
        ...request.headers,
        'Content-Length': '3',
        'Content-Type': 'application/custom',
      },
    }),
    { phases: ['retry'] },
  );
  const response = await client
    .put('https://example.com/start')
    .text('abc')
    .retryPolicy({ strategy: 'fixed', maxRetryAttempts: 1, delayMS: 1 })
    .send();

  expect(response.status).toBe(200);
  expect(sent).toHaveLength(3);
  expect(sent[2].headers['content-length']).toBe('3');
  expect(sent[2].headers['content-type']).toBe('application/custom');
});

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
