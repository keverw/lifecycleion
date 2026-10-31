import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('a global that only shares the name Bun is not Bun', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'not-bun-'));
  try {
    const build = await Bun.build({
      entrypoints: [
        fileURLToPath(
          new URL('../../internal/is-bun-runtime.ts', import.meta.url),
        ),
      ],
      target: 'node',
      format: 'esm',
    });
    expect(build.success).toBe(true);
    await writeFile(
      join(directory, 'is-bun-runtime.mjs'),
      await build.outputs[0].text(),
    );
    const fixture = join(directory, 'fixture.mjs');
    await writeFile(
      fixture,
      `
        globalThis.Bun = {};
        const { isBunRuntime } = await import('./is-bun-runtime.mjs');
        process.exit(isBunRuntime === false ? 0 : 1);
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

test('the client loads where process has no versions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'no-process-versions-'));
  try {
    const build = await Bun.build({
      entrypoints: [
        fileURLToPath(new URL('../http-client.ts', import.meta.url)),
      ],
      target: 'node',
      format: 'esm',
    });
    expect(build.success).toBe(true);
    await writeFile(
      join(directory, 'http-client.mjs'),
      await build.outputs[0].text(),
    );
    const fixture = join(directory, 'fixture.mjs');
    await writeFile(
      fixture,
      `
        const real = process;
        globalThis.process = { env: {} };
        const { HTTPClient } = await import('./http-client.mjs');
        globalThis.process = real;
        real.exit(typeof HTTPClient === 'function' ? 0 : 1);
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

test('on Node, a file part keeps its name, and a form copy keeps a File subclass whole', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'file-part-name-'));
  try {
    const build = await Bun.build({
      entrypoints: [
        fileURLToPath(new URL('../http-client.ts', import.meta.url)),
        fileURLToPath(new URL('../adapters/node-adapter.ts', import.meta.url)),
      ],
      target: 'node',
      format: 'esm',
    });
    expect(build.success).toBe(true);
    for (const output of build.outputs) {
      await writeFile(
        join(directory, output.path.split('/').pop() as string),
        await output.text(),
      );
    }
    const fixture = join(directory, 'fixture.mjs');
    await writeFile(
      fixture,
      `
        import assert from 'node:assert/strict';
        import http from 'node:http';
        import { HTTPClient } from './http-client.js';
        import { NodeAdapter } from './node-adapter.js';

        let nameReads = 0;

        class Lazy extends File {
          get name() {
            nameReads++;
            return super.name;
          }
          exists() {
            return true;
          }
          get size() {
            return 8;
          }
          stream() {
            return new Blob(['OVERRIDE']).stream();
          }
        }

        const server = http.createServer((request, response) => {
          const chunks = [];
          request.on('data', (chunk) => chunks.push(chunk));
          request.on('end', () => {
            response.setHeader('content-type', 'text/plain');
            response.end(Buffer.concat(chunks).toString('latin1'));
          });
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

        const form = new FormData();
        form.append('upload', new Lazy(['x'], 'a/b.txt'));

        const client = new HTTPClient({
          adapter: new NodeAdapter(),
          baseURL: 'http://127.0.0.1:' + server.address().port,
        });
        const answer = await client.post('/').formData(form).send();
        server.close();

        assert.equal(answer.status, 200);
        assert.ok(answer.body.includes('filename="a/b.txt"'), answer.body);
        assert.ok(answer.body.includes('OVERRIDE'), answer.body);
        // The sizing pass and the write, and none for the copies.
        assert.equal(nameReads, 2);
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
