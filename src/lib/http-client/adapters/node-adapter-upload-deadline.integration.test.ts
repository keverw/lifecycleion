import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Run under Node: Bun's FormData copies a File, so a File whose stream yields fewer bytes
// than its size - an upload that fails at its source after the server answered, with the
// socket still up - cannot be set up there.
test('the post-upload-failure deadline keeps a response that is behind its consumer', async () => {
  const directory = await mkdtemp(
    join(tmpdir(), 'node-adapter-upload-deadline-'),
  );
  try {
    const build = await Bun.build({
      entrypoints: [
        fileURLToPath(new URL('./node-adapter.ts', import.meta.url)),
      ],
      target: 'node',
      format: 'esm',
    });
    expect(build.success).toBe(true);
    await writeFile(
      join(directory, 'adapter.mjs'),
      await build.outputs[0].text(),
    );
    const fixture = join(directory, 'fixture.mjs');
    await writeFile(
      fixture,
      `
        import assert from 'node:assert/strict';
        import net from 'node:net';
        import { PassThrough, Writable } from 'node:stream';
        import { NodeAdapter } from './adapter.mjs';

        const BODY = 64 * 1024;
        const sockets = [];
        const server = net.createServer((socket) => {
          sockets.push(socket);
          socket.once('data', (data) => {
            const isSmall = data.toString('latin1').startsWith('POST /small');
            socket.write(
              isSmall
                ? 'HTTP/1.1 200 OK\\r\\nContent-Length: 5\\r\\nConnection: keep-alive\\r\\n\\r\\nhello'
                : Buffer.concat([
                    Buffer.from('HTTP/1.1 200 OK\\r\\nContent-Length: ' + BODY + '\\r\\nConnection: keep-alive\\r\\n\\r\\n'),
                    Buffer.alloc(BODY, 0x61),
                  ]),
            );
            socket.resume();
          });
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const url = 'http://127.0.0.1:' + server.address().port + '/';

        // A multipart File that yields 10 of its 100 bytes: the upload fails at its source.
        const shortForm = () => {
          const file = new File([new Uint8Array(100)], 'f.bin');
          Object.defineProperty(file, 'stream', {
            value() {
              return new ReadableStream({
                async start(controller) {
                  await new Promise((resolve) => setTimeout(resolve, 300));
                  controller.enqueue(new Uint8Array(10));
                  controller.close();
                },
              });
            },
          });
          const form = new FormData();
          form.append('f', file);
          return form;
        };

        // A sink that holds the first write past the deadline: the response is paused
        // under backpressure, not waiting on the server.
        let received = 0;
        let isFirst = true;
        const slowSink = new Writable({
          highWaterMark: 1,
          write(chunk, _encoding, callback) {
            received += chunk.length;
            if (isFirst) {
              isFirst = false;
              setTimeout(callback, 6500);
            } else {
              callback();
            }
          },
        });
        const paused = new NodeAdapter().send({
          requestURL: url + 'big', method: 'POST', headers: {}, body: shortForm(),
          streamResponse: () => slowSink,
        });

        // A complete response whose async factory is still opening its sink at the deadline.
        let small = '';
        const pending = new NodeAdapter().send({
          requestURL: url + 'small', method: 'POST', headers: {}, body: shortForm(),
          streamResponse: async () => {
            await new Promise((resolve) => setTimeout(resolve, 6500));
            const sink = new PassThrough();
            sink.on('data', (chunk) => { small += chunk.toString(); });
            return sink;
          },
        });

        const hang = setTimeout(() => { console.error('HANG'); process.exit(2); }, 15000);
        const [pausedResponse, pendingResponse] = await Promise.all([paused, pending]);
        clearTimeout(hang);

        assert.equal(pausedResponse.status, 200);
        assert.ok(!pausedResponse.isStreamError, 'paused: no stream error');
        assert.equal(received, BODY, 'paused: the sink got the whole body');
        assert.equal(pendingResponse.status, 200);
        assert.ok(!pendingResponse.isStreamError, 'pending: no stream error');
        assert.equal(small, 'hello');
        for (const socket of sockets) socket.destroy();
        server.close();
      `,
    );
    const child = spawnSync('node', [fixture], {
      encoding: 'utf8',
      timeout: 20_000,
    });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

test('the post-upload-failure deadline keeps a response that is still arriving', async () => {
  const directory = await mkdtemp(
    join(tmpdir(), 'node-adapter-upload-deadline-arriving-'),
  );
  try {
    const build = await Bun.build({
      entrypoints: [
        fileURLToPath(new URL('./node-adapter.ts', import.meta.url)),
      ],
      target: 'node',
      format: 'esm',
    });
    expect(build.success).toBe(true);
    await writeFile(
      join(directory, 'adapter.mjs'),
      await build.outputs[0].text(),
    );
    const fixture = join(directory, 'fixture.mjs');
    await writeFile(
      fixture,
      `
        import assert from 'node:assert/strict';
        import net from 'node:net';
        import { NodeAdapter } from './adapter.mjs';

        // Answers at once, then sends 100 bytes every 100 ms for 8 s: past the
        // deadline's first window, and never quiet for one.
        const CHUNKS = 80;
        const sockets = [];
        const server = net.createServer((socket) => {
          sockets.push(socket);
          socket.once('data', () => {
            socket.write('HTTP/1.1 200 OK\\r\\nContent-Length: ' + CHUNKS * 100 + '\\r\\n\\r\\n');
            let sent = 0;
            const timer = setInterval(() => {
              if (socket.destroyed) {
                clearInterval(timer);
                return;
              }
              socket.write(Buffer.alloc(100, 0x61));
              if (++sent === CHUNKS) clearInterval(timer);
            }, 100);
            socket.resume();
          });
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

        // A multipart File that yields 10 of its 100 bytes: the upload fails at its source.
        const file = new File([new Uint8Array(100)], 'f.bin');
        Object.defineProperty(file, 'stream', {
          value() {
            return new ReadableStream({
              async start(controller) {
                await new Promise((resolve) => setTimeout(resolve, 300));
                controller.enqueue(new Uint8Array(10));
                controller.close();
              },
            });
          },
        });
        const form = new FormData();
        form.append('f', file);

        const hang = setTimeout(() => { console.error('HANG'); process.exit(2); }, 15000);
        const response = await new NodeAdapter().send({
          requestURL: 'http://127.0.0.1:' + server.address().port + '/',
          method: 'POST', headers: {}, body: form,
        });
        clearTimeout(hang);

        assert.equal(response.status, 200);
        assert.ok(!response.isStreamError, 'no stream error');
        assert.equal(response.body.length, CHUNKS * 100);
        for (const socket of sockets) socket.destroy();
        server.close();
      `,
    );
    const child = spawnSync('node', [fixture], {
      encoding: 'utf8',
      timeout: 20_000,
    });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

test.each([
  ['after it fails', 1000],
  ['before it fails', 0],
])(
  'bytes past the limit behind an answered 205 let its connection go as soon as its upload has failed, sent %s',
  async (_when, strayDelayMS) => {
    const directory = await mkdtemp(join(tmpdir(), 'node-adapter-205-failed-'));
    try {
      const build = await Bun.build({
        entrypoints: [
          fileURLToPath(new URL('./node-adapter.ts', import.meta.url)),
        ],
        target: 'node',
        format: 'esm',
      });
      expect(build.success).toBe(true);
      await writeFile(
        join(directory, 'adapter.mjs'),
        await build.outputs[0].text(),
      );
      const fixture = join(directory, 'fixture.mjs');
      await writeFile(
        fixture,
        `
        import assert from 'node:assert/strict';
        import net from 'node:net';
        import { NodeAdapter } from './adapter.mjs';

        // Answers 205 at once, and sends 100 KiB of stray bytes against a 64 KiB limit
        // with it, or a second later, after the upload has failed at its source (300 ms).
        const STRAY = 100 * 1024;
        let strayAt;
        let closedAt;
        const sockets = [];
        const server = net.createServer((socket) => {
          sockets.push(socket);
          socket.on('error', () => {});
          socket.on('close', () => { closedAt = performance.now(); });
          socket.once('data', () => {
            socket.write('HTTP/1.1 205 Reset Content\\r\\nTransfer-Encoding: chunked\\r\\n\\r\\n');
            setTimeout(() => {
              strayAt = performance.now();
              socket.write(STRAY.toString(16) + '\\r\\n' + 'x'.repeat(STRAY) + '\\r\\n');
            }, ${strayDelayMS});
            socket.resume();
          });
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

        // A multipart File that yields 10 of its 100 bytes: the upload fails at its source.
        const file = new File([new Uint8Array(100)], 'f.bin');
        Object.defineProperty(file, 'stream', {
          value() {
            return new ReadableStream({
              async start(controller) {
                await new Promise((resolve) => setTimeout(resolve, 300));
                controller.enqueue(new Uint8Array(10));
                controller.close();
              },
            });
          },
        });
        const form = new FormData();
        form.append('f', file);

        const response = await new NodeAdapter().send({
          requestURL: 'http://127.0.0.1:' + server.address().port + '/',
          method: 'POST', headers: {}, body: form, maxResponseBytes: 64 * 1024,
        });
        assert.equal(response.status, 205);
        assert.ok(await response.requestBodySettled instanceof Error, 'the upload failed');

        const hang = setTimeout(() => { console.error('HANG'); process.exit(2); }, 15000);
        while (closedAt === undefined) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        clearTimeout(hang);

        // Let go as the bytes pass the limit or as the upload fails, whichever is later,
        // not when a window ends five seconds on.
        assert.ok(closedAt - strayAt < 2000, 'closed ' + Math.round(closedAt - strayAt) + ' ms after the stray bytes');
        for (const socket of sockets) socket.destroy();
        server.close();
      `,
      );
      const child = spawnSync('node', [fixture], {
        encoding: 'utf8',
        timeout: 20_000,
      });
      expect(child.error).toBeUndefined();
      expect(child.status, child.stderr).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  30_000,
);

test('a multipart body source that does not match its size fails once, not retried as a network error', async () => {
  const directory = await mkdtemp(
    join(tmpdir(), 'node-adapter-source-mismatch-'),
  );
  try {
    const entry = join(directory, 'entry.ts');
    await writeFile(
      entry,
      `export { HTTPClient } from ${JSON.stringify(fileURLToPath(new URL('../http-client.ts', import.meta.url)))};
       export { NodeAdapter } from ${JSON.stringify(fileURLToPath(new URL('./node-adapter.ts', import.meta.url)))};`,
    );
    const build = await Bun.build({
      entrypoints: [entry],
      target: 'node',
      format: 'esm',
    });
    expect(build.success).toBe(true);
    await writeFile(
      join(directory, 'client.mjs'),
      await build.outputs[0].text(),
    );
    const fixture = join(directory, 'fixture.mjs');
    await writeFile(
      fixture,
      `
        import assert from 'node:assert/strict';
        import { createServer } from 'node:http';
        import { HTTPClient, NodeAdapter } from './client.mjs';

        let hits = 0;
        const server = createServer((req, res) => {
          hits++;
          req.resume();
          req.on('end', () => res.end('ok'));
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const file = new File([new Uint8Array(100)], 'f.bin');
        Object.defineProperty(file, 'stream', {
          value() {
            return new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array(10));
                controller.close();
              },
            });
          },
        });
        const form = new FormData();
        form.append('f', file);
        const client = new HTTPClient({
          adapter: new NodeAdapter(),
          baseURL: 'http://127.0.0.1:' + server.address().port,
          retryPolicy: { strategy: 'fixed', maxRetryAttempts: 3, delayMS: 10 },
        });
        const builder = client.put('/up', { body: form });
        const response = await builder.send();

        // Not retried: at most the one attempt reached the server (the failure can land
        // before Node has flushed the request at all).
        assert.ok(hits <= 1, 'not retried, hits=' + hits);
        assert.equal(builder.attemptCount, 1);
        assert.equal(response.isNetworkError, false);
        assert.equal(builder.error?.code, 'adapter_error');
        server.close();
      `,
    );
    const child = spawnSync('node', [fixture], {
      encoding: 'utf8',
      timeout: 20_000,
    });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
