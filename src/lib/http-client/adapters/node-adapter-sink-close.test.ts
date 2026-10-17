import { expect, test } from 'bun:test';
import * as http from 'node:http';
import * as net from 'node:net';
import { Writable } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { EventEmitter } from 'node:events';
import type { WritableLike } from '../types';
import { NodeAdapter } from './node-adapter';
import { HTTPClient } from '../http-client';

test('a streamed download whose sink is destroyed during backpressure fails rather than hangs', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    const chunk = Buffer.alloc(64 * 1024, 1);
    let sent = 0;
    const pump = (): void => {
      while (sent < 200) {
        sent++;
        if (!res.write(chunk)) {
          res.once('drain', pump);
          return;
        }
      }
      res.end();
    };
    pump();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  // A downstream that never finishes a write, then goes away without an error.
  const sink = new Writable({
    highWaterMark: 16 * 1024,
    write() {
      // Never calls back.
    },
  });

  try {
    const pending = new NodeAdapter().send({
      requestURL: `http://127.0.0.1:${port}/`,
      method: 'GET',
      headers: {},
      streamResponse: () => sink,
    });
    setTimeout(() => sink.destroy(), 100);

    const response = await Promise.race([
      pending,
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 3000)),
    ]);

    expect(response).not.toBe('hung');
    if (response !== 'hung') {
      expect(response.status).toBe(200);
      expect(response.isStreamError).toBe(true);
      expect(response.streamErrorCode).toBe('stream_write_error');
    }
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('a streamed download whose sink is destroyed after the response ended fails rather than hangs', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(Buffer.alloc(256 * 1024, 1));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  // Writes queue behind one that never completes; the response ends meanwhile.
  const sink = new Writable({
    highWaterMark: 1024 * 1024,
    write() {
      // Never calls back.
    },
  });

  try {
    const pending = new NodeAdapter().send({
      requestURL: `http://127.0.0.1:${port}/`,
      method: 'GET',
      headers: {},
      streamResponse: () => sink,
    });
    setTimeout(() => sink.destroy(), 200);

    const response = await Promise.race([
      pending,
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 3000)),
    ]);

    expect(response).not.toBe('hung');
    if (response !== 'hung') {
      expect(response.isStreamError).toBe(true);
      expect(response.streamErrorCode).toBe('stream_write_error');
    }
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('an upload the adapter tears down after a stream factory refusal is not reported to the host', async () => {
  const server = http.createServer((req, res) => {
    // Answers at once and keeps reading slowly.
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.write('hello');
    req.on('data', () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const reports: unknown[] = [];
  const onError = (event: Event): void => {
    reports.push((event as ErrorEvent).error);
    event.preventDefault();
  };
  globalThis.addEventListener('error', onError);

  try {
    for (const factory of [
      () => null,
      () => {
        throw new Error('factory refused');
      },
    ]) {
      const outcome = await new NodeAdapter()
        .send({
          requestURL: `http://127.0.0.1:${port}/`,
          method: 'POST',
          headers: {},
          body: new Uint8Array(32 * 1024 * 1024),
          streamResponse: factory,
        })
        .then(
          () => 'resolved',
          () => 'rejected',
        );

      expect(outcome).toBe('rejected');
    }

    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(reports).toEqual([]);
  } finally {
    globalThis.removeEventListener('error', onError);
    server.closeAllConnections();
    server.close();
  }
});

test('a hand-written sink that emits close before its end callback still succeeds', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('hello');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  // No `writableFinished`: it says it is finished by emitting 'close', as the docs ask.
  const chunks: Uint8Array[] = [];
  const emitter = new EventEmitter();
  const sink = Object.assign(emitter, {
    write(chunk: Uint8Array | string, cb?: (err?: Error | null) => void) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      cb?.();
      return true;
    },
    end(cb?: (err?: Error | null) => void) {
      emitter.emit('close');
      setTimeout(() => cb?.(), 0);
    },
    destroy() {},
  }) as unknown as WritableLike;

  try {
    const response = await new NodeAdapter().send({
      requestURL: `http://127.0.0.1:${port}/`,
      method: 'GET',
      headers: {},
      streamResponse: () => sink,
    });

    expect(response.isStreamError).toBeFalsy();
    expect(Buffer.concat(chunks).toString()).toBe('hello');
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('a socket reset during an async stream factory keeps a response that already arrived in full', async () => {
  // Answers a complete 200 at once and closes without reading the large upload, so the
  // upload side resets while the factory is still opening its sink.
  const server = net.createServer((socket) => {
    let received = '';
    let hasAnswered = false;
    socket.on('data', (data) => {
      if (hasAnswered) {
        return;
      }
      received += data.toString('latin1');
      if (received.includes('\r\n\r\n')) {
        hasAnswered = true;
        socket.pause();
        socket.write(
          'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok',
          () => {
            setTimeout(() => socket.destroy(), 20);
          },
        );
      }
    });
    socket.on('error', () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const chunks: Buffer[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk);
      callback();
    },
  });

  try {
    const response = await new NodeAdapter().send({
      requestURL: `http://127.0.0.1:${port}/`,
      method: 'POST',
      headers: {},
      body: new Uint8Array(32 * 1024 * 1024),
      streamResponse: async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        return sink;
      },
    });

    expect(response.status).toBe(200);
    expect(response.isStreamError).toBeFalsy();
    expect(Buffer.concat(chunks).toString()).toBe('ok');
  } finally {
    server.close();
  }
});

test('an empty crl array is refused, at construction and when read for a request', async () => {
  expect(() => new NodeAdapter({ crl: [] })).toThrow(/no -----BEGIN X509 CRL/);

  const config: { crl?: string[] } = {};
  const adapter = new NodeAdapter(config);
  config.crl = [];
  const rejection = await adapter
    .send({ requestURL: 'https://127.0.0.1:1/', method: 'GET', headers: {} })
    .then(
      () => undefined,
      (error: unknown) => error,
    );

  expect((rejection as Error | undefined)?.message).toMatch(
    /no -----BEGIN X509 CRL/,
  );
});

test('a stream factory that throws its own AbortError fails as stream_setup_error, not a cancel', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('hello');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const builder = new HTTPClient({ adapter: new NodeAdapter() })
      .get(`http://127.0.0.1:${port}/`)
      .streamResponse(() => {
        const error = new Error('sink open aborted by its own controller');
        error.name = 'AbortError';
        throw error;
      });
    const response = await builder.send();

    expect(response.isCancelled).toBe(false);
    expect(builder.error?.code).toBe('stream_setup_error');
    expect(builder.error?.cause?.message).toBe(
      'sink open aborted by its own controller',
    );
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
