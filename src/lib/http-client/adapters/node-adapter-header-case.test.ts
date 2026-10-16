import { expect, test } from 'bun:test';
import * as http from 'node:http';
import { NodeAdapter } from './node-adapter';
import { HTTPClient } from '../http-client';
import type { WritableLike } from '../types';

test('NodeAdapter driven directly sends header names as given', async () => {
  let receivedRawHeaders: string[] = [];
  const server = http.createServer((req, res) => {
    receivedRawHeaders = req.rawHeaders;
    res.end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };

  try {
    const response = await new NodeAdapter().send({
      requestURL: `http://127.0.0.1:${port}/`,
      method: 'GET',
      headers: { 'X-Api-Key': 'k' },
    });

    expect(response.status).toBe(200);
    // A legacy server or signed-header scheme may read the name's case.
    expect(receivedRawHeaders).toContain('X-Api-Key');
    // What is reported as sent stays lowercased, as every effective header is.
    expect(response.effectiveRequestHeaders?.['x-api-key']).toBe('k');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('a signal whose aborted getter throws counts as not aborted when a response streams', async () => {
  let isGetterBroken = false;
  const server = http.createServer((_req, res) => {
    // From here on - the response arriving - the caller's signal cannot be read.
    isGetterBroken = true;
    res.end('streamed');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  // A signal-like object of the caller's whose `aborted` read throws.
  const signal = Object.defineProperty(new EventTarget(), 'aborted', {
    get(): boolean {
      if (isGetterBroken) {
        throw new Error('aborted unreadable');
      }
      return false;
    },
  }) as unknown as AbortSignal;
  const chunks: string[] = [];

  try {
    const response = await new NodeAdapter().send({
      requestURL: `http://127.0.0.1:${port}/`,
      method: 'GET',
      headers: {},
      signal,
      streamResponse: (): WritableLike => ({
        write: (chunk: unknown) => {
          chunks.push(String(chunk));
          return true;
        },
        end: (callback?: () => void) => {
          callback?.();
        },
        on() {
          return this;
        },
        once() {
          return this;
        },
        off() {
          return this;
        },
        destroy: () => {},
      }),
    });

    expect(response.isStreamed).toBe(true);
    expect(chunks.join('')).toBe('streamed');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("a streamResponse factory's return is classified by one read of its cancel", async () => {
  const server = http.createServer((_req, res) => {
    res.end('body');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  let cancelReads = 0;
  // Answers `true` once, then `false`: read again, it would pass for a sink.
  const flipping = {
    get cancel(): boolean {
      return cancelReads++ === 0;
    },
  };

  try {
    const builder = new HTTPClient({ adapter: new NodeAdapter() })
      .get(`http://127.0.0.1:${port}/`)
      .streamResponse(() => flipping as never);
    const response = await builder.send();

    expect(cancelReads).toBe(1);
    expect(response.isCancelled).toBe(true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('a CRL with no complete block is refused at construction', () => {
  for (const crl of ['', '  \n']) {
    expect(() => new NodeAdapter({ crl })).toThrow(
      'NodeAdapter: the `crl` value holds no -----BEGIN X509 CRL----- block',
    );
  }
  // Binary with no block is refused as not PEM.
  expect(() => new NodeAdapter({ crl: Buffer.from('\n') })).toThrow(
    'NodeAdapter crl must be PEM',
  );
});

test('an error for a body cut off mid-stream does not carry the request headers when serialized', async () => {
  // Headers, part of the body, then nothing: the attempt's timer cuts the body off.
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-length': '1000' });
    res.write('part');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };

  try {
    const builder = new HTTPClient({ adapter: new NodeAdapter(), timeout: 50 })
      .get(`http://127.0.0.1:${port}/`)
      .headers({ authorization: 'Bearer secret' });

    await builder.send();

    const cause = builder.error?.cause;
    expect(builder.error?.code).toBe('stream_response_error');
    expect(cause).toBeDefined();
    expect(JSON.stringify(cause)).not.toContain('secret');
    expect(Object.keys(cause as object)).not.toContain(
      'effectiveRequestHeaders',
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
