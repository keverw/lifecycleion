import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('Node reports a discarded writable error before natural process exit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'node-adapter-late-error-'));
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
        import { EventEmitter } from 'node:events';
        import { createServer } from 'node:http';
        import { NodeAdapter } from './adapter.mjs';

        const server = createServer((_req, res) => {
          res.writeHead(200, { 'connection': 'close' });
          res.end('payload');
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        let startFactory;
        const factoryStarted = new Promise(resolve => { startFactory = resolve; });
        let releaseFactory;
        const factoryGate = new Promise(resolve => { releaseFactory = resolve; });
        const controller = new AbortController();
        const request = new NodeAdapter().send({
          requestURL: 'http://127.0.0.1:' + server.address().port,
          method: 'GET',
          headers: {},
          signal: controller.signal,
          streamResponse: async () => {
            startFactory();
            await factoryGate;
            const writable = Object.assign(new EventEmitter(), {
              write() { return true; },
              end() {},
              destroy() {
                // Emit when no other work keeps Node alive, so the report must
                // itself keep the event loop alive until it is delivered.
                process.once('beforeExit', () => {
                  writable.emit('error', new Error('discarded writable failed'));
                });
              },
            });
            return writable;
          },
        });
        await factoryStarted;
        controller.abort();
        await assert.rejects(request, /Request aborted/);
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        // Close all network handles before releasing the late writable.
        releaseFactory();
      `,
    );
    const child = spawnSync('node', [fixture], {
      encoding: 'utf8',
      timeout: 5000,
    });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(child.stderr).toContain('discarded writable failed');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 10_000);
