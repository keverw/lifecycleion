import { expect, test } from 'bun:test';
import * as http from 'node:http';
import { Writable } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { NodeAdapter } from './node-adapter';

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
