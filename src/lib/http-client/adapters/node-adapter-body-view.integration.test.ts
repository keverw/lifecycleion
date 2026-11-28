import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('on Node, a Uint8Array subclass is sent as its bytes, not as its own length', async () => {
  // Node's `Buffer.from` reads a subclass's `length`; Bun's reads the bytes, so this runs
  // on Node.
  const directory = await mkdtemp(join(tmpdir(), 'node-adapter-body-view-'));
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
      join(directory, 'node-adapter.mjs'),
      await build.outputs[0].text(),
    );
    const fixture = join(directory, 'fixture.mjs');
    await writeFile(
      fixture,
      `
        import assert from 'node:assert/strict';
        import http from 'node:http';
        import { NodeAdapter } from './node-adapter.mjs';

        class Lying extends Uint8Array {
          get length() {
            return 200;
          }
        }

        const server = http.createServer((request, response) => {
          const chunks = [];
          request.on('data', (chunk) => chunks.push(chunk));
          request.on('end', () => {
            response.end(Buffer.concat(chunks).toString('latin1'));
          });
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

        const answer = await new NodeAdapter().send({
          requestURL: 'http://127.0.0.1:' + server.address().port + '/',
          method: 'POST',
          headers: {},
          body: new Lying([65, 66, 67]),
        });

        const detached = new Uint8Array([65, 66, 67]);
        structuredClone(detached.buffer, { transfer: [detached.buffer] });
        const emptied = await new NodeAdapter().send({
          requestURL: 'http://127.0.0.1:' + server.address().port + '/',
          method: 'POST',
          headers: {},
          body: detached,
        });
        server.close();

        assert.equal(Buffer.from(answer.body).toString('latin1'), 'ABC');
        assert.equal(emptied.status, 200);
        assert.equal(emptied.body.byteLength, 0);
        process.exit(0);
      `,
    );
    const child = spawnSync('node', [fixture], {
      encoding: 'utf8',
      timeout: 8000,
    });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);
