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
